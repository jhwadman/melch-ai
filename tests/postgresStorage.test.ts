/**
 * tests/postgresStorage.test.ts — the direct-Postgres adapter against a REAL
 * Postgres with pgvector (ADR 0021): migrations, sessions under concurrent
 * appends, memory on the shared store, owner-scoped A2A tasks, erase, and
 * the engine's session interface on the rows (ADR 0058). A conversation run
 * through runSyndicateTurn persists and resumes from the rows, and stores
 * the rows ADK 2.2 stored for the same conversation (recorded).
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres server where the
 * connecting role may create databases, e.g.
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/postgres npm test
 * Each run creates its own database, applies db/migrations/ and
 * db/telemetry.sql, and drops it. Without the variable every test skips.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { ServerCallContext } from '@a2a-js/sdk/server';

import { postgresStorage } from '../lib/storage/postgres/index.ts';
import type { PostgresStorage } from '../lib/storage/postgres/index.ts';
import { persistedDelta } from '../lib/storage/postgres/sessionService.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';
import type { Embedder, MemoryExtractor } from '../lib/memory/providers.ts';
import { namespacedMemoryService } from '../lib/memory/namespace.ts';
import type { MemoryService } from '../lib/runtime/memoryService.ts';
import { z } from 'zod';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import { adkReferences, canonical } from './helpers/adkReference.ts';

// The conversation the runSyndicateTurn case is held to, as ADK 2.2 stored it
// against a real Postgres (tests/fixtures/adk-reference/postgresstorage).
const reference = adkReferences('postgresStorage');

setLogLevel('error');
process.env.OTEL_CONSOLE_SPANS = 'false';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const skip = ADMIN_URL ? false : 'set TEST_DATABASE_URL to run the Postgres integration suite';
const DB = `melchizedek_it_${process.pid}_${Date.now()}`;

let admin: pg.Client;
let storage: PostgresStorage;
let pool: pg.Pool;

function urlFor(db: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${db}`;
  return u.toString();
}

// Every numbered migration, in order, then the ledger: the same set
// `melchizedek-db apply --telemetry` installs, read from the directory so a
// new migration is covered without editing this file.
const MIGRATIONS = readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
function migrations(): string[] {
  return [...MIGRATIONS.map((f) => `db/migrations/${f}`), 'db/telemetry.sql'];
}

// A 768-d embedding: identical for the same statement (a record's header is
// ignored, as a real embedding would mostly ignore it), near-orthogonal otherwise.
function vec(textIn: string): number[] {
  const v = new Array(768).fill(0);
  let h = 2166136261;
  for (const ch of textIn.replace(/^\[[^\]]*\]\s*/, '').toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  v[h % 768] = 1;
  v[(h >>> 10) % 768] += 0.5;
  return v;
}
const fakeEmbedder: Embedder = { provider: 'fake', model: 'fake', dimensions: 768, embed: async (t) => t.map(vec) };
function fakeExtractor(lines: string): MemoryExtractor {
  return { model: 'fake', extract: async () => lines };
}

let closing = false;

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  pool = new pg.Pool({ connectionString: urlFor(DB), max: 8 });
  // Teardown drops the database WITH (FORCE), which terminates any connection
  // still open, such as one a background memory extraction holds. The pool
  // then reports that as an error; outside teardown it is still fatal.
  pool.on('error', (err) => {
    if (!closing) throw err;
  });
  for (const f of [...migrations(), ...migrations()]) await pool.query(readFileSync(f, 'utf-8'));
  storage = postgresStorage({ pool, memory: { extractor: fakeExtractor(''), embedder: fakeEmbedder } });
});

after(async () => {
  if (skip) return;
  closing = true;
  await storage?.close(); // its turn-lock pool; the main pool is ended below
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

test('migrations apply twice and record one version each', { skip }, async () => {
  const r = await pool.query('SELECT version, name FROM melchizedek_schema_version ORDER BY version');
  assert.deepEqual(
    r.rows.map((x) => `${x.version} ${x.name}`),
    MIGRATIONS.map((f) => `${Number(f.slice(0, 4))} ${f.replace(/\.sql$/, '')}`),
  );
});

test('sessions: events are appended one row each, state deltas merge, temp: keys never persist', { skip }, async () => {
  const s = storage.sessionService;
  const session = await s.create({ appName: 'ns', userId: 'u', state: { a: 1 } });
  await s.append(
    session,
    { id: 'e1', author: 'user', invocationId: 'i', timestamp: 1, content: { role: 'user', parts: [{ text: 'hi' }] }, actions: { stateDelta: { b: 2, 'temp:x': 9 } } } as any,
  );
  await s.append(session, { id: 'p', author: 'agent', partial: true, actions: {} } as any);
  const back = await s.get({ appName: 'ns', userId: 'u', sessionId: session.id });
  assert.deepEqual(back!.state, { a: 1, b: 2 });
  assert.equal(back!.events.length, 1, 'partial events are not stored');
  assert.equal((back!.events[0].content!.parts![0] as any).text, 'hi');
  assert.deepEqual(persistedDelta({ 'temp:a': 1, k: 2 }), { k: 2 });
});

test('sessions: two writers on one conversation both land, in order, with no lost event', { skip }, async () => {
  const s = storage.sessionService;
  const created = await s.create({ appName: 'ns', userId: 'race' });
  // Two "processes", each holding its own copy of the session.
  const a = await s.get({ appName: 'ns', userId: 'race', sessionId: created.id });
  const b = await s.get({ appName: 'ns', userId: 'race', sessionId: created.id });
  const ev = (n: number) => ({ id: `e${n}`, author: 'agent', invocationId: 'i', timestamp: n, content: { role: 'model', parts: [{ text: `t${n}` }] }, actions: { stateDelta: { [`k${n}`]: n } } }) as any;
  await Promise.all([
    ...[1, 3, 5, 7, 9].map((n) => s.append(a!, ev(n))),
    ...[2, 4, 6, 8, 10].map((n) => s.append(b!, ev(n))),
  ]);
  const back = await s.get({ appName: 'ns', userId: 'race', sessionId: created.id });
  assert.equal(back!.events.length, 10, 'every event from both writers is stored');
  assert.equal(Object.keys(back!.state).length, 10, 'every state key from both writers survives');
  const seqs = await pool.query('SELECT seq FROM adk_session_events WHERE session_id = $1 ORDER BY seq', [`ns:race:${created.id}`]);
  assert.deepEqual(seqs.rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // A late "create" for the same id must not wipe what is there.
  await s.create({ appName: 'ns', userId: 'race', sessionId: created.id });
  const again = await s.get({ appName: 'ns', userId: 'race', sessionId: created.id }, { numRecentEvents: 3 });
  assert.equal(again!.events.length, 10 - 7, 'numRecentEvents returns the newest three');
  const lastThree = await pool.query(
    'SELECT event FROM adk_session_events WHERE session_id = $1 ORDER BY seq DESC LIMIT 3',
    [`ns:race:${created.id}`],
  );
  assert.deepEqual(again!.events.map((e) => e.id), lastThree.rows.map((r) => r.event.id).reverse(), 'oldest first');
});

test('sessions: list pages with the real total, delete cascades to events', { skip }, async () => {
  const s = storage.sessionService;
  for (let i = 0; i < 5; i++) await s.create({ appName: 'lister', userId: 'u', sessionId: `s${i}` });
  const page = await s.list({ appName: 'lister', userId: 'u', limit: 2, page: 2, order: 'asc' });
  assert.equal(page.totalItems, 5);
  assert.equal(page.totalPages, 3);
  assert.equal(page.sessions.length, 2);
  assert.ok(page.sessions.every((x) => x.id.startsWith('s')));

  const one = await s.get({ appName: 'lister', userId: 'u', sessionId: 's0' });
  await s.append(one!, { id: 'z', author: 'user', invocationId: 'i', timestamp: 1, actions: {} } as any);
  await s.delete({ appName: 'lister', userId: 'u', sessionId: 's0' });
  const left = await pool.query("SELECT count(*)::int AS n FROM adk_session_events WHERE session_id = 'lister:u:s0'");
  assert.equal(left.rows[0].n, 0);
});

registerTool(
  'pg_runtime_lookup',
  defineTool({ name: 'pg_runtime_lookup', description: 'Look a preference up.', schema: z.object({ key: z.string() }), execute: async ({ key }) => `green ${key}` }),
  { override: true },
);

const PG_DESK = { syndicate_name: 'Desk', orchestrator: { name: 'Desk', model: 'scripted/pg', instruction: 'Answer briefly.', tools: ['pg_runtime_lookup'] }, subagents: [] } as unknown as SyndicateYamlConfig;

/**
 * Three turns through runSyndicateTurn on the Postgres store: the answers,
 * the rows as stored (ids and times aside) and the history each request
 * carried.
 */
async function pgConversation() {
  const userId = `rt-${randomUUID()}`;
  const desk = new ScriptedModel('scripted/pg', (req, n) => {
    if (n === 1) return toolCall('pg_runtime_lookup', { key: 'tea' }, 'call-tea');
    if (n === 2) return answer(`Noted: ${lastToolResult(req)?.result}.`);
    return answer(`You said: ${requestTexts(req).filter((t) => t.startsWith('Noted')).join(' / ')}`);
  });
  const texts: string[] = [];
  for (const message of ['I like tea.', 'What do I like?', 'And again?']) {
    const r = await runSyndicateTurn({
      config: PG_DESK,
      parts: [{ text: message }],
      appName: 'rt.ns',
      userId,
      sessionId: 'conv',
      sessionService: storage.sessionService,
      compile: { resolveModel: shimResolver({ pg: desk }), log: () => {} },
      trace: false,
    });
    assert.equal(r.status, 'completed', r.error?.message);
    texts.push(r.text);
  }
  const rows = await pool.query('SELECT event FROM adk_session_events WHERE session_id = $1 ORDER BY seq', [`rt.ns:${userId}:conv`]);
  const events = rows.rows.map((r) => ({ ...r.event, id: '<id>', timestamp: 0, invocationId: '<inv>' }));
  return { texts, events, history: desk.requests.map((r) => r.messages) };
}

test('a conversation through runSyndicateTurn persists to Postgres and the next turn resumes it from the rows', { skip }, async () => {
  // In the reference's canonical form (adkReference.ts): JSON, its rows' ids and times fixed.
  const run = canonical(await pgConversation());
  assert.deepEqual(run.texts, ['Noted: green tea.', 'You said: Noted: green tea.', 'You said: Noted: green tea.']);
  assert.equal(run.events.length, 8, 'per turn: the message and the answer, and the first turn\'s call and result');
  const recorded = await reference<Awaited<ReturnType<typeof pgConversation>>>('pg-conversation-all-adk');
  assert.deepEqual(run.texts, recorded.texts);
  assert.deepEqual(run.events, recorded.events, 'the rows match what ADK 2.2 stored');
  assert.deepEqual(run.history, recorded.history, 'every request carried the history ADK 2.2 sent');
});

test('sessions: the engine’s interface keeps one meaning on Postgres', { skip }, async () => {
  const s = storage.sessionService;
  const key = { appName: 'meaning.ns', userId: 'u1', sessionId: 'c1' };
  const ev = (id: string, timestamp: number, text = id) =>
    createTurnEvent({ id, timestamp, invocationId: 'i', author: 'user', content: { role: 'user', parts: [{ text }] } });

  const created = await s.create({ ...key, state: { kept: 1, 'temp:x': 2 } });
  assert.deepEqual(created.state, { kept: 1 });
  for (const [id, ts] of [['e1', 10], ['e2', 20], ['e3', 30]] as const) await s.append(created, ev(id, ts));
  assert.equal((await s.append(created, { ...ev('p', 40), partial: true })).partial, true);

  // A second create keeps the conversation.
  assert.deepEqual((await s.create({ ...key, state: { other: true } })).events.map((e) => e.id), ['e1', 'e2', 'e3']);
  assert.deepEqual((await s.create({ ...key })).events.map((e) => e.id), ['e1', 'e2', 'e3']);

  // Reads: strictly after, then the newest N; a count below one asks for nothing.
  const ids = async (options: object) => (await s.get(key, options))!.events.map((e) => e.id);
  assert.deepEqual(await ids({ afterTimestamp: 20 }), ['e3']);
  assert.deepEqual(await ids({ afterTimestamp: 5, numRecentEvents: 2 }), ['e2', 'e3']);
  assert.deepEqual(await ids({ numRecentEvents: -1 }), ['e1', 'e2', 'e3']);
  assert.equal((await s.get(key))!.lastUpdateTime, 30);

  // The same id replaces its row in place.
  await s.append(created, ev('e2', 35, 'edited'));
  const rows = await pool.query("SELECT seq, event->>'id' AS id, ts FROM adk_session_events WHERE session_id = 'meaning.ns:u1:c1' ORDER BY seq");
  assert.deepEqual(rows.rows.map((r) => [r.seq, r.id, r.ts]), [[1, 'e1', 10], [2, 'e2', 35], [3, 'e3', 30]]);
  const back = (await s.get(key))!;
  assert.equal((back.events[1]!.content!.parts![0] as { text: string }).text, 'edited');
  assert.deepEqual(back.events.map((e) => e.id), created.events.map((e) => e.id), 'the store and the caller’s session agree');

  // A list without a user id lists every user's sessions of the app, in the order created.
  await s.create({ appName: 'meaning.ns', userId: 'u:2', sessionId: 'c2' });
  await s.create({ appName: 'meaning.other', userId: 'u1', sessionId: 'c9' });
  const all = await s.list({ appName: 'meaning.ns' });
  assert.deepEqual(all.sessions.map((x) => [x.userId, x.id]), [['u1', 'c1'], ['u:2', 'c2']]);
  assert.deepEqual({ page: all.page, limit: all.limit, totalItems: all.totalItems, totalPages: all.totalPages }, { page: 1, limit: 2, totalItems: 2, totalPages: 1 });
  assert.deepEqual((await s.list({ appName: 'meaning.ns', userId: 'u:2' })).sessions.map((x) => x.id), ['c2']);
  const newest = await s.list({ appName: 'meaning.ns', order: 'desc', limit: 1, page: 1 });
  assert.deepEqual(newest.sessions.map((x) => x.id), ['c2'], 'c2 was created after c1’s last event (35)');
  assert.equal(newest.totalPages, 2);
  assert.deepEqual((await s.list({ appName: 'nobody' })).totalPages, 1);

  await s.delete(key);
  assert.equal(await s.get(key), undefined);
});

test('memory: facts are stored, deduplicated, recalled and superseded on the Postgres store', { skip }, async () => {
  const mk = (lines: string) =>
    postgresStorage({ pool, memory: { extractor: fakeExtractor(lines), embedder: fakeEmbedder } }).memoryService!;
  const session = (id: string) =>
    ({ id, appName: 'mem.ns', userId: 'u1', events: [{ author: 'user', content: { role: 'user', parts: [{ text: 'stuff' }] } }] }) as any;

  await mk('[PREFERENCE | date: 2026-10-01 | source: user | keys: tea] The user prefers green tea.').ingest(session('m1'));
  // The same fact again is a duplicate, not a second row.
  await mk('[PREFERENCE | date: 2026-10-01 | source: user | keys: tea] The user prefers green tea.').ingest(session('m2'));
  let rows = await pool.query("SELECT fact, status FROM adk_memory_facts WHERE user_key = 'mem.ns/u1'");
  assert.equal(rows.rowCount, 1);

  // A correction retires what it supersedes.
  await mk(
    '[CORRECTION | date: 2026-10-02 | source: user | keys: tea | supersedes: The user prefers green tea.] The user now prefers black tea.',
  ).ingest(session('m3'));
  rows = await pool.query("SELECT fact, status FROM adk_memory_facts WHERE user_key = 'mem.ns/u1' ORDER BY created_at");
  assert.deepEqual(rows.rows.map((r) => r.status), ['superseded', 'active']);

  const found = await mk('').search({ appName: 'mem.ns', userId: 'u1', query: 'The user now prefers black tea.' });
  assert.ok(found.memories.length >= 1);
  assert.match(JSON.stringify(found.memories[0]), /black tea/);
});

test("memory through the engine's MemoryService: ingest and search on the Postgres store, pinned and per user", { skip }, async () => {
  const service = (lines: string) =>
    postgresStorage({ pool, memory: { extractor: fakeExtractor(lines), embedder: fakeEmbedder } }).memoryService!;
  // A DELEGATE subagent's own app name, pinned to the root namespace as the runtime pins it.
  const engine = (lines: string) => namespacedMemoryService<MemoryService>(service(lines), 'eng.ns');
  const session = (id: string) => ({
    id,
    appName: 'Scout',
    userId: 'u1',
    state: {},
    lastUpdateTime: 1,
    events: [{ id: 'e1', invocationId: 'i1', author: 'user', timestamp: 1, actions: {}, content: { role: 'user', parts: [{ text: 'stuff' }] } }],
  });
  const fact = '[PREFERENCE | date: 2026-10-01 | source: user | keys: coffee] The user takes coffee black.';

  await engine(fact).ingest(session('n1'), { extractionRules: 'Keep drinks.' });
  const stored = await pool.query("SELECT fact FROM adk_memory_facts WHERE user_key = 'eng.ns/u1'");
  assert.deepEqual(stored.rows.map((r) => r.fact), [fact]);
  assert.equal((await pool.query("SELECT 1 FROM adk_memory_facts WHERE user_key LIKE 'Scout/%'")).rowCount, 0, 'nothing under the subagent name');
  const marker = await pool.query("SELECT events_ingested FROM melchizedek_memory_ingest WHERE user_key = 'eng.ns/u1' AND session_id = 'n1'");
  assert.equal(marker.rows[0].events_ingested, 1, 'the marker committed with the fact');

  // The same turns again: the stored marker says done, so nothing is extracted or stored.
  await engine('[FACT | date: 2026-10-02 | source: user | keys: x] Something else entirely.').ingest(session('n1'));
  assert.equal((await pool.query("SELECT 1 FROM adk_memory_facts WHERE user_key = 'eng.ns/u1'")).rowCount, 1);

  const found = await engine('').search({ appName: 'Scout', userId: 'u1', query: 'The user takes coffee black.' });
  assert.ok(found.memories.length >= 1);
  assert.match(JSON.stringify(found.memories[0]), /coffee black/);
  const other = await engine('').search({ appName: 'Scout', userId: 'u2', query: 'The user takes coffee black.' });
  assert.deepEqual(other.memories, [], "another user's silo is empty");

  // The unpinned service, asked under the root namespace, reads the same silo the same way.
  const unpinned = await service('').search({ appName: 'eng.ns', userId: 'u1', query: 'The user takes coffee black.' });
  assert.deepEqual(unpinned, found);

  assert.equal(await engine('').deleteUserMemory!('eng.ns/u1'), 1);
  assert.deepEqual((await engine('').search({ appName: 'Scout', userId: 'u1', query: 'The user takes coffee black.' })).memories, []);
});

test('tasks: durable, owner-scoped, listed newest first with working page tokens', { skip }, async () => {
  const store = storage.taskStore('desk');
  const as = (user: string) => new ServerCallContext({ user: { isAuthenticated: true, userName: user } } as any);
  const task = (id: string, ts: string, contextId = 'c1') =>
    ({ id, contextId, status: { state: 3, timestamp: ts }, artifacts: [{ artifactId: 'a' }], history: [] }) as any;

  await store.save(task('t1', '2026-10-01T10:00:00Z'), as('alice'));
  await store.save(task('t2', '2026-10-01T11:00:00Z'), as('alice'));
  await store.save(task('t3', '2026-10-01T12:00:00Z', 'c2'), as('alice'));
  await store.save(task('t9', '2026-10-01T13:00:00Z'), as('bob'));

  assert.ok(await store.load('t1', as('alice')));
  assert.equal(await store.load('t1', as('bob')), undefined, "bob cannot read alice's task");
  assert.equal(await storage.taskStore('other-agent').load('t1', as('alice')), undefined, 'tasks are per agent');

  const p1 = await store.list({ pageSize: 2 } as any, as('alice'));
  assert.deepEqual(p1.tasks.map((t: any) => t.id), ['t3', 't2']);
  assert.equal(p1.totalSize, 3);
  assert.deepEqual((p1.tasks[0] as any).artifacts, [], 'artifacts omitted unless asked');
  const p2 = await store.list({ pageSize: 2, pageToken: p1.nextPageToken } as any, as('alice'));
  assert.deepEqual(p2.tasks.map((t: any) => t.id), ['t1']);
  assert.equal(p2.nextPageToken, '');
  const byContext = await store.list({ contextId: 'c2' } as any, as('alice'));
  assert.deepEqual(byContext.tasks.map((t: any) => t.id), ['t3']);
  const after = await store.list({ statusTimestampAfter: '2026-10-01T10:30:00Z' } as any, as('alice'));
  assert.deepEqual(after.tasks.map((t: any) => t.id), ['t3', 't2']);

  // A second save updates in place (a task's status changes over its life).
  await store.save({ ...task('t1', '2026-10-01T14:00:00Z'), status: { state: 4, timestamp: '2026-10-01T14:00:00Z' } }, as('alice'));
  assert.equal(((await store.load('t1', as('alice'))) as any).status.state, 4);
});

test('erase: one namespace, everywhere, and nested — exactly the scope, sub-agent rows included', { skip }, async () => {
  const seed = async () => {
    await pool.query('TRUNCATE adk_sessions, adk_session_events, adk_memory_facts, adk_turns, adk_telemetry, adk_payloads, adk_a2a_tasks, melchizedek_memory_ingest, melchizedek_tasks, melchizedek_task_owners, melchizedek_tool_credentials');
    await pool.query(`
      INSERT INTO adk_memory_facts (user_key, fact) VALUES
        ('ns1/u1','a'),('ns1/u1','b'),('ns1/u2','c'),('ns2/u1','d'),('ns1/u1/end','e'),('melchizedek-a2a/u1','f'),('ns1/u1_x','g');
      INSERT INTO adk_sessions (id, app_name, user_id) VALUES
        ('ns1:u1:c1','ns1','u1'),('Scout:u1:c1','Scout','u1'),('ns1:u1:c2','ns1','u1'),
        ('ns2:u1:c9','ns2','u1'),('ns1:u2:c1','ns1','u2'),('ns1:u1/end:c3','ns1','u1/end');
      INSERT INTO adk_session_events (session_id, seq, event) VALUES ('ns1:u1:c1', 1, '{}'), ('Scout:u1:c1', 1, '{}');
      INSERT INTO adk_turns (ts, trace_id, span_id, syndicate, user_id, session_id) VALUES
        (now(),'t1','s1','x','u1','c1'),(now(),'t2','s2','x','u1','c2'),(now(),'t9','s9','y','u1','c9'),(now(),'t3','s3','x','u2','c1');
      INSERT INTO adk_telemetry (trace_id, span_id, span_name, span) VALUES ('t1','a','llm.request','{}'),('t9','c','llm.request','{}');
      INSERT INTO adk_payloads (ts, trace_id, span_id, reason) VALUES (now(),'t1','a','error');
      INSERT INTO adk_a2a_tasks (owner, agent_id, id, context_id, task) VALUES ('u1','desk','k1','c1','{}'),('u1','desk','k9','c9','{}');
      INSERT INTO melchizedek_memory_ingest (user_key, session_id, events_ingested) VALUES ('ns1/u1','c1',2),('ns2/u1','c9',1),('ns1/u2','c1',1),('ns1/u1/end','c3',1);
      INSERT INTO melchizedek_task_owners (owner) VALUES ('u1'),('u2');
      INSERT INTO melchizedek_tasks (owner, id, seq, kind, status, record) VALUES ('u1','t1',1,'todo','open','{}'),('u2','t1',1,'todo','open','{}');
      INSERT INTO melchizedek_tool_credentials (app_name, user_id, provider, access_token_enc, key_id) VALUES
        ('ns1','u1','github','mzc1.k.a.b.c','k'),('ns2','u1','github','mzc1.k.a.b.c','k'),
        ('ns1','u1/end','github','mzc1.k.a.b.c','k'),('ns1','u2','github','mzc1.k.a.b.c','k'),('ns1','u1_x','github','mzc1.k.a.b.c','k');
    `);
  };
  const ids = async (sql: string) => (await pool.query(sql)).rows.map((r) => Object.values(r)[0]).sort();

  await seed();
  const a = await storage.erase('u1', { namespace: 'ns1' });
  assert.deepEqual(
    { ...a },
    { memory_facts: 2, sessions: 3, turns: 2, spans: 1, payloads: 1, verdicts: 0, labels: 0, tasks: 1, memory_markers: 1, task_tools: 0, credentials: 1 },
  );
  assert.deepEqual(await ids('SELECT user_key||\':\'||fact AS k FROM adk_memory_facts'), [
    'melchizedek-a2a/u1:f', 'ns1/u1/end:e', 'ns1/u1_x:g', 'ns1/u2:c', 'ns2/u1:d',
  ]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM adk_session_events')).rows[0].n, 0, 'events cascade');

  await seed();
  const b = await storage.erase('u1');
  assert.equal(b.memory_facts, 4);
  assert.equal(b.tasks, 2);
  assert.equal(b.memory_markers, 2, 'every namespace');
  assert.equal(b.task_tools, 1, 'the scope\'s own list, not u2\'s');
  assert.equal(b.credentials, 2, 'every app\'s tokens of u1, not u1_x\'s');
  assert.deepEqual(await ids('SELECT owner FROM melchizedek_task_owners'), ['u2']);
  assert.deepEqual(await ids('SELECT id FROM adk_sessions'), ['ns1:u1/end:c3', 'ns1:u2:c1']);

  await seed();
  const c = await storage.erase('u1', { namespace: 'ns1', includeNested: true });
  assert.equal(c.memory_facts, 3);
  assert.equal(c.memory_markers, 2, 'ns1/u1 and the nested ns1/u1/end');
  assert.equal(c.credentials, 2, 'ns1 for u1 and the nested u1/end');
  assert.deepEqual(await ids("SELECT app_name||':'||user_id AS k FROM melchizedek_tool_credentials"), ['ns1:u1_x', 'ns1:u2', 'ns2:u1']);
  assert.deepEqual(await ids('SELECT id FROM adk_sessions'), ['ns1:u2:c1', 'ns2:u1:c9']);

  await assert.rejects(storage.erase('  '), /scope key is required/);
});

test('erase: a namespace erase reaches conversations whose sessions expired', { skip }, async () => {
  await pool.query('TRUNCATE adk_sessions, adk_session_events, adk_turns, adk_telemetry, adk_payloads, adk_a2a_tasks');
  // c1 is live in ns1, c9 is live in ns2, and c5's session rows expired and
  // were pruned (0001): only the ledger and the task store still hold it.
  await pool.query(`
    INSERT INTO adk_sessions (id, app_name, user_id) VALUES
      ('ns1:u1:c1','ns1','u1'),('ns2:u1:c9','ns2','u1'),('Scout:u1:c9','Scout','u1');
    INSERT INTO adk_turns (ts, trace_id, span_id, syndicate, user_id, session_id) VALUES
      (now() - interval '14 days','t5','s5','x','u1','c5'),(now(),'t1','s1','x','u1','c1'),
      (now(),'t9','s9','y','u1','c9'),(now(),'t0','s0','x','u1',NULL),(now(),'t3','s3','x','u2','c5');
    INSERT INTO adk_telemetry (trace_id, span_id, span_name, span) VALUES ('t5','a','llm.request','{}'),('t9','c','llm.request','{}');
    INSERT INTO adk_payloads (ts, trace_id, span_id, reason) VALUES (now(),'t5','a','error');
    INSERT INTO adk_a2a_tasks (owner, agent_id, id, context_id, task) VALUES
      ('u1','desk','k5','c5','{}'),('u1','desk','k1','c1','{}'),('u1','desk','k9','c9','{}');
  `);
  const ids = async (sql: string) => (await pool.query(sql)).rows.map((r) => Object.values(r)[0]).sort();

  const counts = await storage.erase('u1', { namespace: 'ns1' });
  assert.equal(counts.turns, 3, 'the live c1, the expired c5, and the turn with no conversation');
  assert.equal(counts.spans, 1);
  assert.equal(counts.payloads, 1);
  assert.equal(counts.tasks, 2, 'c1 and the expired c5');
  assert.deepEqual(await ids('SELECT trace_id FROM adk_turns'), ['t3', 't9'], 'ns2 keeps its live c9; u2 is untouched');
  assert.deepEqual(await ids('SELECT trace_id FROM adk_telemetry'), ['t9']);
  assert.deepEqual(await ids('SELECT id FROM adk_a2a_tasks'), ['k9']);
});

test('audit: the storage appends events, and the table refuses UPDATE and DELETE (migration 0012)', { skip }, async () => {
  storage.audit({ event: 'auth.failure', outcome: 'denied', sourceIp: '10.0.0.9', detail: { path: '/x' } });
  await new Promise((r) => setTimeout(r, 200));
  const rows = (await pool.query("SELECT event, outcome, source_ip, detail FROM melchizedek_audit WHERE source_ip = '10.0.0.9'")).rows;
  assert.deepEqual(rows.map((r) => [r.event, r.outcome, r.detail.path]), [['auth.failure', 'denied', '/x']]);
  await assert.rejects(pool.query("UPDATE melchizedek_audit SET outcome = 'ok'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM melchizedek_audit'), /append-only/);
  assert.equal(Number((await pool.query('SELECT melchizedek_prune_audit(1) AS n')).rows[0].n), 0, 'nothing older than a day');
});

test('tool credentials (migration 0013): stored sealed, read back, refreshed on expiry, revoked, erased with the user', { skip }, async () => {
  const { aesGcmCipher } = await import('../lib/tools/credentialCipher.ts');
  const { randomBytes } = await import('node:crypto');
  const key = randomBytes(32);
  let refreshes = 0;
  const providers = {
    github: {
      refresh: async (rt: string) => {
        refreshes++;
        assert.equal(rt, 'fake-refresh-token-PG-0001');
        await new Promise((r) => setTimeout(r, 20));
        return { accessToken: 'fake-access-token-PG-0002', expiresAt: new Date(Date.now() + 3_600_000) };
      },
    },
  };
  const withCreds = postgresStorage({ pool, credentials: { cipher: aesGcmCipher(key), providers } });
  const other = postgresStorage({ pool, credentials: { cipher: aesGcmCipher(key), providers } });
  const wrong = postgresStorage({ pool, credentials: { cipher: aesGcmCipher(randomBytes(32)), providers } });
  try {
    await pool.query('TRUNCATE melchizedek_tool_credentials');
    const store = withCreds.credentials!;
    const k = { appName: 'cred.ns', userId: 'cu1', provider: 'github' };
    await store.put(k, { accessToken: 'fake-access-token-PG-0001', refreshToken: 'fake-refresh-token-PG-0001', scopes: ['repo', 'read:user'], expiresAt: new Date(Date.now() + 3_600_000) });
    assert.equal((await store.get(k))?.accessToken, 'fake-access-token-PG-0001');
    const raw = (await pool.query('SELECT * FROM melchizedek_tool_credentials')).rows;
    assert.equal(raw.length, 1);
    assert.ok(!JSON.stringify(raw).includes('fake-'), 'only ciphertext in the table');
    assert.deepEqual(raw[0].scopes, ['repo', 'read:user']);

    // Expired: two instances read at once, one refresh call each at most, and both get the new token.
    await pool.query("UPDATE melchizedek_tool_credentials SET expires_at = now() - interval '1 minute'");
    const [a, b] = await Promise.all([store.get(k), other.credentials!.get(k)]);
    assert.equal(a?.accessToken, 'fake-access-token-PG-0002');
    assert.equal(b?.accessToken, 'fake-access-token-PG-0002');
    assert.ok(refreshes >= 1 && refreshes <= 2);
    const after = (await pool.query('SELECT version, refreshed_at, refresh_token_enc FROM melchizedek_tool_credentials')).rows[0];
    assert.equal(after.version, 2, 'one refresh landed; the other read it back');
    assert.ok(after.refreshed_at);
    assert.equal((await store.get(k))?.accessToken, 'fake-access-token-PG-0002');

    // A wrong key fails closed.
    await assert.rejects(wrong.credentials!.get(k), /cannot be read/);

    // The table refuses a plaintext token.
    await assert.rejects(
      pool.query("INSERT INTO melchizedek_tool_credentials (app_name, user_id, provider, access_token_enc, key_id) VALUES ('x','y','z','fake-plaintext','k')"),
      /check constraint/,
    );

    // Revoke, then the user's erase (one call, every store) removes the rest.
    assert.equal(await store.revoke(k), true);
    assert.equal(await store.get(k), undefined);
    await store.put(k, { accessToken: 'fake-access-token-PG-0001' });
    await store.put({ ...k, provider: 'slack' }, { accessToken: 'fake-access-token-PG-0001' });
    await store.put({ ...k, userId: 'cu2' }, { accessToken: 'fake-access-token-PG-0001' });
    assert.equal(await store.eraseUser('cu1', { appName: 'cred.ns' }), 2);
    await store.put(k, { accessToken: 'fake-access-token-PG-0001' });
    const counts = await withCreds.erase('cu1');
    assert.equal(counts.credentials, 1);
    assert.deepEqual((await pool.query('SELECT user_id FROM melchizedek_tool_credentials')).rows.map((r) => r.user_id), ['cu2']);

    // Audit rows were written for every step, and hold no token.
    await new Promise((r) => setTimeout(r, 200));
    const audit = (await pool.query("SELECT event, outcome, scope_hash, detail FROM melchizedek_audit WHERE event LIKE 'credential.%' ORDER BY id")).rows;
    const events = audit.map((r) => r.event);
    for (const e of ['credential.put', 'credential.refresh', 'credential.revoke', 'credential.erase']) assert.ok(events.includes(e), e);
    assert.ok(!JSON.stringify(audit).includes('fake-') && !JSON.stringify(audit).includes('cu1'), 'no token and no user id in the audit trail');
  } finally {
    await withCreds.close();
    await other.close();
    await wrong.close();
  }
});

test('the usage store adds atomically under concurrency and reads back per day and subject', { skip }, async () => {
  const { postgresUsageStore } = await import('../lib/a2a/policy.ts');
  const store = postgresUsageStore(pool);
  const d = { tasks: 1, llmCalls: 2, inputTokens: 30, outputTokens: 4, thinkingTokens: 1 };
  await Promise.all(Array.from({ length: 20 }, () => store.add('2026-10-01', 'caller:alpha', d)));
  assert.deepEqual(await store.get('2026-10-01', 'caller:alpha'), { tasks: 20, llmCalls: 40, inputTokens: 600, outputTokens: 80, thinkingTokens: 20 });
  assert.equal((await store.get('2026-10-02', 'caller:alpha')).tasks, 0);
  assert.equal((await store.get('2026-10-01', 'caller:beta')).tasks, 0);
});

// ── The versioned agent registry (migration 0005, ADR 0018) ───────────────
const reg = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);

test('registry: publishing records versions, and identical content reuses one', { skip }, async () => {
  const [{ v: v1 }] = await reg(`SELECT melchizedek_registry_publish('it_alpha', $1, 'alice', 'first') AS v`, [{ syndicate_name: 'A', n: 1 }]);
  const [{ v: v2 }] = await reg(`SELECT melchizedek_registry_publish('it_alpha', $1, 'alice', 'second') AS v`, [{ syndicate_name: 'A', n: 2 }]);
  const [{ v: same }] = await reg(`SELECT melchizedek_registry_publish('it_alpha', $1, 'alice') AS v`, [{ n: 2, syndicate_name: 'A' }]);
  assert.deepEqual([v1, v2, same], [1, 2, 2]);
  const versions = await reg(`SELECT version, published_by, note FROM adk_agent_registry_versions WHERE id = 'it_alpha' ORDER BY version`);
  assert.deepEqual(versions, [
    { version: 1, published_by: 'alice', note: 'first' },
    { version: 2, published_by: 'alice', note: 'second' },
  ]);
});

test('registry: rollback re-activates a stored version without adding one', { skip }, async () => {
  const [{ v }] = await reg(`SELECT melchizedek_registry_activate('it_alpha', 1, 'bob') AS v`);
  assert.equal(v, 1);
  const [active] = await reg(`SELECT version, yaml_content->>'n' AS n, published_by FROM adk_agent_registry WHERE id = 'it_alpha'`);
  assert.deepEqual(active, { version: 1, n: '1', published_by: 'bob' });
  const [{ c }] = await reg(`SELECT count(*)::int AS c FROM adk_agent_registry_versions WHERE id = 'it_alpha'`);
  assert.equal(c, 2);
  await assert.rejects(reg(`SELECT melchizedek_registry_activate('it_alpha', 99, 'bob')`), /no version 99/);
});

test('registry: a direct write is versioned, history is append-only, retire keeps it', { skip }, async () => {
  await reg(`INSERT INTO adk_agent_registry (id, yaml_content) VALUES ('it_beta', $1)
             ON CONFLICT (id) DO UPDATE SET yaml_content = EXCLUDED.yaml_content`, [{ syndicate_name: 'B' }]);
  await reg(`UPDATE adk_agent_registry SET yaml_content = $1 WHERE id = 'it_beta'`, [{ syndicate_name: 'B', x: true }]);
  const [{ version }] = await reg(`SELECT version FROM adk_agent_registry WHERE id = 'it_beta'`);
  assert.equal(version, 2);
  await assert.rejects(reg(`UPDATE adk_agent_registry_versions SET note = 'x' WHERE id = 'it_beta'`), /append-only/);
  await assert.rejects(reg(`DELETE FROM adk_agent_registry_versions WHERE id = 'it_beta'`), /append-only/);
  await reg(`DELETE FROM adk_agent_registry WHERE id = 'it_beta'`);
  const [{ c }] = await reg(`SELECT count(*)::int AS c FROM adk_agent_registry_versions WHERE id = 'it_beta'`);
  assert.equal(c, 2, 'retiring an id keeps its history');
  await assert.rejects(reg(`SELECT melchizedek_registry_publish('bad id!', '{}'::jsonb, 'x')`), /invalid registry id/);
});

test('schemaVersion() reads what the migrations recorded: the shipped version', { skip }, async () => {
  const { shippedSchemaVersion } = await import('../lib/storage/schemaVersion.ts');
  assert.equal(await storage.schemaVersion(), shippedSchemaVersion());
});

test('turnLock: the real keys the server builds (NUL-separated) lock only their own conversation', { skip }, async () => {
  const { turnLockKey } = await import('../lib/a2a/turnLock.ts');
  const a = turnLockKey('ns', 'caller/user', 'ctx-1');
  const held = await storage.turnLock(a, { waitMs: 0 });
  assert.ok(held, 'a NUL-separated key takes a lock');
  assert.equal(await storage.turnLock(a, { waitMs: 100 }), null);
  const b = await storage.turnLock(turnLockKey('ns', 'caller/user', 'ctx-2'), { waitMs: 0 });
  assert.ok(b);
  await b!();
  await held!();
});

test('turnLock: an advisory lock shared by two instances on one database', { skip }, async () => {
  const other = postgresStorage({ pool: new pg.Pool({ connectionString: urlFor(DB), max: 2 }) });
  try {
    const held = await storage.turnLock('conv-1', { waitMs: 0 });
    assert.ok(held, 'the first instance takes the lock');
    assert.equal(await other.turnLock('conv-1', { waitMs: 300 }), null, 'the second instance cannot');
    const elsewhere = await other.turnLock('conv-2', { waitMs: 0 });
    assert.ok(elsewhere, 'a different conversation is free');
    await elsewhere!();
    const waiting = other.turnLock('conv-1', { waitMs: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    await held!();
    const got = await waiting;
    assert.ok(got, 'released on one instance, taken on the other');
    await got!();
  } finally {
    await other.close();
    await other.pool.end();
  }
});

test('task leases: running tasks are leased, finished ones are not, and expired ones are failed', { skip }, async () => {
  const { PostgresTaskStore, renewTaskLeases, reapExpiredTasks } = await import('../lib/storage/postgres/taskStore.ts');
  const lease = { instanceId: 'it-instance', ttlMs: 400 };
  const store = new PostgresTaskStore(pool, 'lease-desk', { lease });
  const as = new ServerCallContext({ user: { isAuthenticated: true, userName: 'lessee' } } as any);
  const t = (id: string, state: number) => ({ id, contextId: `ctx-${id}`, status: { state, timestamp: new Date().toISOString() }, artifacts: [], history: [] }) as any;
  const row = async (id: string) =>
    (await pool.query(`SELECT state, lease_owner, lease_until FROM adk_a2a_tasks WHERE agent_id = 'lease-desk' AND id = $1`, [id])).rows[0];

  await store.save(t('run', 2), as);
  assert.equal((await row('run')).lease_owner, 'it-instance', 'a working task is leased');
  await store.save(t('done', 2), as);
  await store.save(t('done', 3), as);
  assert.equal((await row('done')).lease_owner, null, 'a completed task holds no lease');
  await store.save(t('waiting', 6), as);
  assert.equal((await row('waiting')).lease_owner, null, 'input-required holds no lease');

  // Renewal keeps a live instance's task alive past its first deadline.
  await new Promise((r) => setTimeout(r, 250));
  assert.ok((await renewTaskLeases(pool, lease)) >= 1);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(await reapExpiredTasks(pool), 0, 'a renewed lease is not reaped');

  // A dead instance renews nothing: the task is failed with a reason.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await reapExpiredTasks(pool), 1);
  const reaped = await store.load('run', as);
  assert.equal((reaped as any).status.state, 4);
  assert.match((reaped as any).status.message.parts[0].content.value, /stopped before it finished/);
  assert.equal((await row('run')).lease_owner, null);
  assert.equal((await row('done')).state, 3, 'finished tasks are untouched');
});

test('task queue: concurrent workers never claim the same job; a dead worker\'s job comes back', { skip }, async () => {
  const q = storage.taskQueue;
  for (let i = 0; i < 3; i++) {
    await q.mutate('queue-owner', (s: any) => {
      s.tasks.push({ id: `t${s.next_id}`, kind: 'background', status: 'queued', title: `job ${i}`, instruction: 'x', created_at: '', updated_at: '' });
      s.next_id += 1;
    });
  }
  const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => q.claimNext({ workerId: `w${i}`, leaseMs: 60_000 })));
  const got = claims.filter(Boolean).map((j: any) => j.id).sort();
  assert.deepEqual(got, ['t1', 't2', 't3'], 'each job claimed exactly once');

  const crashed = claims.find((j: any) => j?.id === 't1')!;
  await pool.query(`UPDATE melchizedek_tasks SET lease_until = now() - interval '1 second' WHERE owner = 'queue-owner' AND id = 't1'`);
  const rec = await q.recover();
  assert.deepEqual(rec.requeued, ['queue-owner:t1']);
  const again = await q.claimNext({ workerId: 'w-new', leaseMs: 60_000 });
  assert.equal(again?.id, 't1');
  assert.equal(again?.attempts, 2);
  await q.finish(again!, { result: 'done' });
  assert.equal(crashed.owner, 'queue-owner');
  const row = (await pool.query(`SELECT status, lease_owner FROM melchizedek_tasks WHERE owner = 'queue-owner' AND id = 't1'`)).rows[0];
  assert.deepEqual(row, { status: 'done', lease_owner: null });
});

test('durable runs (migration 0014): checkpoints beside the record, leased, kept on requeue, dropped otherwise; a running job can be cancelled', { skip }, async () => {
  const { taskUpdateContract } = await import('../lib/tools/taskTools.ts');
  const q = storage.taskQueue;
  const owner = 'durable-owner';
  const w = { workerId: 'dw-1', leaseMs: 60_000 };
  const other = { workerId: 'dw-2', leaseMs: 60_000 };
  const queue = (title: string) =>
    q.mutate(owner, (s: any) => {
      s.tasks.push({ id: `t${s.next_id}`, kind: 'background', status: 'queued', title, instruction: 'x', created_at: '', updated_at: '' });
      s.next_id += 1;
    });
  const row = async (id: string) =>
    (await pool.query(`SELECT status, record, checkpoint, checkpoint_at, lease_owner FROM melchizedek_tasks WHERE owner = $1 AND id = $2`, [owner, id])).rows[0];
  // Only this test's owner: other tests leave queued jobs of their own owners.
  const claimMine = async (worker: typeof w) => {
    const j = await q.claimNext(worker);
    assert.equal(j?.owner, owner, 'no other owner has a queued job left');
    return j!;
  };

  // Saved by the lease holder only, read back, never inside the record.
  await queue('long run');
  const job = await claimMine(w);
  assert.equal(await q.loadCheckpoint!(job), null);
  assert.equal(await q.saveCheckpoint!(w, job, { step: 1, memo: 'a' }), true);
  assert.equal(await q.saveCheckpoint!(other, job, { step: 99 }), false, 'another worker cannot write it');
  assert.deepEqual(await q.loadCheckpoint!(job), { step: 1, memo: 'a' });
  let r = await row(job.id);
  assert.ok(r.checkpoint_at, 'stamped');
  assert.ok(!JSON.stringify(r.record).includes('step'), 'the record never carries the checkpoint');
  assert.ok(!JSON.stringify((await q.read(owner)).tasks).includes('step'), 'read() never returns it');
  assert.equal(await q.renew(w, job), true);
  assert.equal(await q.renew(other, job), false, 'renew by a non-holder reports no claim');

  // A live lease is not recovered: the checkpoint and claim stay.
  assert.deepEqual((await q.recover()).requeued.filter((x) => x.startsWith(owner)), []);
  assert.equal((await row(job.id)).lease_owner, 'dw-1');

  // Interrupted: requeued keeps it, the next claim resumes from it; recover leaves the queued job alone.
  await pool.query(`UPDATE melchizedek_tasks SET lease_until = now() - interval '1 second' WHERE owner = $1 AND id = $2`, [owner, job.id]);
  assert.deepEqual((await q.recover()).requeued, [`${owner}:${job.id}`]);
  r = await row(job.id);
  assert.equal(r.status, 'queued');
  assert.deepEqual(r.checkpoint, { step: 1, memo: 'a' });
  assert.equal(await q.saveCheckpoint!(w, job, { step: 2 }), false, 'the old lease is gone');
  assert.deepEqual(await q.recover(), { requeued: [], failed: [] }, 'a queued job is never touched by recover');
  assert.deepEqual((await row(job.id)).checkpoint, { step: 1, memo: 'a' });
  const resumed = await claimMine(other);
  assert.equal(resumed.id, job.id);
  assert.deepEqual(await q.loadCheckpoint!(resumed), { step: 1, memo: 'a' }, 'claimNext leaves it');
  assert.equal(await q.saveCheckpoint!(w, resumed, { step: 2 }), false, 'the first worker no longer holds it');
  assert.equal(await q.saveCheckpoint!(other, resumed, { step: 2 }), true);

  // Finished: done drops it.
  await q.finish(resumed, { result: 'ok' });
  r = await row(job.id);
  assert.equal(r.status, 'done');
  assert.equal(r.checkpoint, null);
  assert.equal(r.checkpoint_at, null);
  assert.equal(await q.loadCheckpoint!(resumed), null);
  assert.equal(await q.renew(other, resumed), false);

  // Failed after MAX_ATTEMPTS by recover: dropped.
  await queue('crashy');
  for (;;) {
    const j = await claimMine(w);
    await q.saveCheckpoint!(w, j, { attempt: j.attempts });
    await pool.query(`UPDATE melchizedek_tasks SET lease_until = now() - interval '1 second' WHERE owner = $1 AND id = $2`, [owner, j.id]);
    const rec = await q.recover();
    if (rec.failed.length) {
      assert.deepEqual(rec.failed, [`${owner}:${j.id}`]);
      r = await row(j.id);
      assert.equal(r.status, 'failed');
      assert.equal(r.checkpoint, null);
      break;
    }
    assert.deepEqual((await row(j.id)).checkpoint, { attempt: j.attempts });
  }

  // Cancelled while running, through the tool: accepted, the claim and checkpoint end, a late outcome is ignored.
  const { setTaskBackend, fileTaskBackend } = await import('../lib/tools/taskTools.ts');
  await queue('to cancel');
  const running = await claimMine(w);
  assert.equal(await q.saveCheckpoint!(w, running, { step: 1 }), true);
  setTaskBackend(q);
  try {
    assert.match(
      await taskUpdateContract.execute({ id: running.id, status: 'cancelled' } as any, { userId: owner }),
      /\[cancelled · background\]/,
    );
  } finally {
    setTaskBackend(fileTaskBackend);
  }
  assert.equal(await q.renew(w, running), false, 'the worker learns the claim is gone');
  assert.equal(await q.saveCheckpoint!(w, running, { step: 2 }), false);
  r = await row(running.id);
  assert.deepEqual([r.status, r.checkpoint, r.lease_owner], ['cancelled', null, null]);
  await q.finish(running, { result: 'late' });
  assert.equal((await row(running.id)).status, 'cancelled', 'the outcome leaves a cancelled record alone');

  // A deleted record takes its checkpoint along.
  await queue('pruned');
  const gone = await claimMine(w);
  await q.saveCheckpoint!(w, gone, { step: 1 });
  await q.mutate(owner, (s: any) => {
    s.tasks = s.tasks.filter((t: any) => t.id !== gone.id);
  });
  assert.equal(await q.loadCheckpoint!(gone), null);
});

test('a private schema: the whole chain installs into it and the stores work there', { skip }, async () => {
  const { sqlForSchema } = await import('../lib/storage/schema.ts');
  const { shippedSchemaVersion } = await import('../lib/storage/schemaVersion.ts');
  for (const f of [...migrations().filter((x) => x.includes('/migrations/')), 'db/hardening.sql']) {
    await pool.query(sqlForSchema(readFileSync(f, 'utf-8'), 'it_private'));
  }
  const privatePool = new pg.Pool({ connectionString: urlFor(DB), max: 2, options: '-c search_path=it_private,public' });
  const priv = postgresStorage({ pool: privatePool });
  try {
    assert.equal(await priv.schemaVersion(), shippedSchemaVersion());
    const s = await priv.sessionService.create({ appName: 'pns', userId: 'pu', sessionId: 'pc' });
    assert.ok(await priv.sessionService.get({ appName: 'pns', userId: 'pu', sessionId: s.id }));
    const inPrivate = await pool.query(`SELECT count(*)::int AS c FROM it_private.adk_sessions WHERE user_id = 'pu'`);
    assert.equal(inPrivate.rows[0].c, 1, 'the session row is in the private schema');
    const counts = await priv.erase('pu');
    assert.equal(counts.sessions, 1);
  } finally {
    await priv.close();
    await privatePool.end();
  }
});

test('a conversation the Supabase service wrote keeps its history after the move to DATABASE_URL', { skip }, async () => {
  const legacy = [
    { id: 'e1', author: 'user', timestamp: 1, content: { role: 'user', parts: [{ text: 'first' }] }, actions: {} },
    { id: 'e2', author: 'Lead', timestamp: 2, content: { role: 'model', parts: [{ text: 'second' }] }, actions: {} },
  ];
  await pool.query(
    `INSERT INTO adk_sessions (id, app_name, user_id, state, events, last_update_time) VALUES ('legacy:lu:lc', 'legacy', 'lu', '{}', $1::jsonb, 2)`,
    [JSON.stringify(legacy)],
  );
  const svc = storage.sessionService;
  const s = await svc.get({ appName: 'legacy', userId: 'lu', sessionId: 'lc' });
  assert.deepEqual(s!.events.map((e) => e.id), ['e1', 'e2'], 'the JSON history, in order');
  // Reading again does not import twice; an append lands after the history.
  await svc.get({ appName: 'legacy', userId: 'lu', sessionId: 'lc' });
  await svc.append(s!, { id: 'e3', author: 'user', timestamp: 3, invocationId: 'i', content: { role: 'user', parts: [{ text: 'third' }] }, actions: {} } as any);
  const again = await svc.get({ appName: 'legacy', userId: 'lu', sessionId: 'lc' });
  assert.deepEqual(again!.events.map((e) => e.id), ['e1', 'e2', 'e3']);
  const rows = await pool.query(`SELECT seq FROM adk_session_events WHERE session_id = 'legacy:lu:lc' ORDER BY seq`);
  assert.deepEqual(rows.rows.map((r) => r.seq), [1, 2, 3]);
  // An append before any read imports first, too.
  await pool.query(
    `INSERT INTO adk_sessions (id, app_name, user_id, state, events, last_update_time) VALUES ('legacy:lu:ld', 'legacy', 'lu', '{}', $1::jsonb, 2)`,
    [JSON.stringify(legacy)],
  );
  await svc.append({ id: 'ld', appName: 'legacy', userId: 'lu', state: {}, events: [], lastUpdateTime: 0 } as any, { id: 'e3', author: 'user', timestamp: 3, invocationId: 'i', content: { role: 'user', parts: [{ text: 'x' }] }, actions: {} } as any);
  const d = await svc.get({ appName: 'legacy', userId: 'lu', sessionId: 'ld' });
  assert.deepEqual(d!.events.map((e) => e.id), ['e1', 'e2', 'e3']);
});
