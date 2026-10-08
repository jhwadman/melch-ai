/**
 * tests/postgresStorage.test.ts — the direct-Postgres adapter against a REAL
 * Postgres with pgvector (ADR 0021): migrations, sessions under concurrent
 * appends, memory on the shared store, owner-scoped A2A tasks, erase, and a
 * full ADK turn persisted and resumed.
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
import { LlmAgent, Runner, setLogLevel, LogLevel } from '@google/adk';
import { ServerCallContext } from '@a2a-js/sdk/server';

import { postgresStorage } from '../lib/storage/postgres/index.ts';
import type { PostgresStorage } from '../lib/storage/postgres/index.ts';
import { persistedDelta } from '../lib/storage/postgres/sessionService.ts';
import type { Embedder, MemoryExtractor } from '../lib/memory/providers.ts';
import { namespacedMemoryService } from '../lib/memory/namespace.ts';
import type { MemoryService } from '../lib/runtime/memoryService.ts';
import { ScriptedLlm, sentTexts, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);
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
  const session = await s.createSession({ appName: 'ns', userId: 'u', state: { a: 1 } });
  await s.appendEvent({
    session,
    event: { id: 'e1', author: 'user', invocationId: 'i', timestamp: 1, content: { role: 'user', parts: [{ text: 'hi' }] }, actions: { stateDelta: { b: 2, 'temp:x': 9 } } } as any,
  });
  await s.appendEvent({ session, event: { id: 'p', author: 'agent', partial: true, actions: {} } as any });
  const back = await s.getSession({ appName: 'ns', userId: 'u', sessionId: session.id });
  assert.deepEqual(back!.state, { a: 1, b: 2 });
  assert.equal(back!.events.length, 1, 'partial events are not stored');
  assert.equal((back!.events[0].content!.parts![0] as any).text, 'hi');
  assert.deepEqual(persistedDelta({ 'temp:a': 1, k: 2 }), { k: 2 });
});

test('sessions: two writers on one conversation both land, in order, with no lost event', { skip }, async () => {
  const s = storage.sessionService;
  const created = await s.createSession({ appName: 'ns', userId: 'race' });
  // Two "processes", each holding its own copy of the session.
  const a = await s.getSession({ appName: 'ns', userId: 'race', sessionId: created.id });
  const b = await s.getSession({ appName: 'ns', userId: 'race', sessionId: created.id });
  const ev = (n: number) => ({ id: `e${n}`, author: 'agent', invocationId: 'i', timestamp: n, content: { role: 'model', parts: [{ text: `t${n}` }] }, actions: { stateDelta: { [`k${n}`]: n } } }) as any;
  await Promise.all([
    ...[1, 3, 5, 7, 9].map((n) => s.appendEvent({ session: a!, event: ev(n) })),
    ...[2, 4, 6, 8, 10].map((n) => s.appendEvent({ session: b!, event: ev(n) })),
  ]);
  const back = await s.getSession({ appName: 'ns', userId: 'race', sessionId: created.id });
  assert.equal(back!.events.length, 10, 'every event from both writers is stored');
  assert.equal(Object.keys(back!.state).length, 10, 'every state key from both writers survives');
  const seqs = await pool.query('SELECT seq FROM adk_session_events WHERE session_id = $1 ORDER BY seq', [`ns:race:${created.id}`]);
  assert.deepEqual(seqs.rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // A late "create" for the same id must not wipe what is there.
  await s.createSession({ appName: 'ns', userId: 'race', sessionId: created.id });
  const again = await s.getSession({ appName: 'ns', userId: 'race', sessionId: created.id, config: { numRecentEvents: 3 } });
  assert.equal(again!.events.length, 10 - 7, 'numRecentEvents returns the newest three');
  const lastThree = await pool.query(
    'SELECT event FROM adk_session_events WHERE session_id = $1 ORDER BY seq DESC LIMIT 3',
    [`ns:race:${created.id}`],
  );
  assert.deepEqual(again!.events.map((e) => e.id), lastThree.rows.map((r) => r.event.id).reverse(), 'oldest first');
});

test('sessions: list pages with the real total, delete cascades to events', { skip }, async () => {
  const s = storage.sessionService;
  for (let i = 0; i < 5; i++) await s.createSession({ appName: 'lister', userId: 'u', sessionId: `s${i}` });
  const page = await s.listSessions({ appName: 'lister', userId: 'u', limit: 2, page: 2, order: 'asc' });
  assert.equal(page.totalItems, 5);
  assert.equal(page.totalPages, 3);
  assert.equal(page.sessions.length, 2);
  assert.ok(page.sessions.every((x) => x.id.startsWith('s')));

  const one = await s.getSession({ appName: 'lister', userId: 'u', sessionId: 's0' });
  await s.appendEvent({ session: one!, event: { id: 'z', author: 'user', invocationId: 'i', timestamp: 1, actions: {} } as any });
  await s.deleteSession({ appName: 'lister', userId: 'u', sessionId: 's0' });
  const left = await pool.query("SELECT count(*)::int AS n FROM adk_session_events WHERE session_id = 'lister:u:s0'");
  assert.equal(left.rows[0].n, 0);
});

test('a full ADK turn persists to Postgres and the next turn resumes it', { skip }, async () => {
  const model = new ScriptedLlm('scripted-pg', (_req, n) => text(n === 1 ? 'Noted: green tea.' : 'You said green tea.'));
  const agent = new LlmAgent({ name: 'Desk', model, instruction: 'Answer briefly.' });
  const userId = `scope-${randomUUID()}`;
  const runTurn = async (message: string, sessionId: string) => {
    const runner = new Runner({ appName: 'turns.ns', agent, sessionService: storage.sessionService });
    let answer = '';
    for await (const ev of runner.runAsync({ userId, sessionId, newMessage: { role: 'user', parts: [{ text: message }] } })) {
      for (const p of ev.content?.parts ?? []) if (p.text && !ev.partial) answer = p.text;
    }
    return answer;
  };
  const session = await storage.sessionService.createSession({ appName: 'turns.ns', userId });
  assert.equal(await runTurn('I like green tea.', session.id), 'Noted: green tea.');
  // A different Runner (another instance) resumes from the database alone.
  assert.equal(await runTurn('What do I like?', session.id), 'You said green tea.');
  assert.ok(sentTexts(model.requests[1]).some((t) => t.includes('I like green tea.')), 'turn 2 saw turn 1');
  const stored = await pool.query('SELECT count(*)::int AS n FROM adk_session_events WHERE session_id = $1', [
    `turns.ns:${userId}:${session.id}`,
  ]);
  assert.equal(stored.rows[0].n, 4, 'two user messages and two answers');
});

test('memory: facts are stored, deduplicated, recalled and superseded on the Postgres store', { skip }, async () => {
  const mk = (lines: string) =>
    postgresStorage({ pool, memory: { extractor: fakeExtractor(lines), embedder: fakeEmbedder } }).memoryService!;
  const session = (id: string) =>
    ({ id, appName: 'mem.ns', userId: 'u1', events: [{ author: 'user', content: { role: 'user', parts: [{ text: 'stuff' }] } }] }) as any;

  await mk('[PREFERENCE | date: 2026-10-01 | source: user | keys: tea] The user prefers green tea.').addSessionToMemory(session('m1'));
  // The same fact again is a duplicate, not a second row.
  await mk('[PREFERENCE | date: 2026-10-01 | source: user | keys: tea] The user prefers green tea.').addSessionToMemory(session('m2'));
  let rows = await pool.query("SELECT fact, status FROM adk_memory_facts WHERE user_key = 'mem.ns/u1'");
  assert.equal(rows.rowCount, 1);

  // A correction retires what it supersedes.
  await mk(
    '[CORRECTION | date: 2026-10-02 | source: user | keys: tea | supersedes: The user prefers green tea.] The user now prefers black tea.',
  ).addSessionToMemory(session('m3'));
  rows = await pool.query("SELECT fact, status FROM adk_memory_facts WHERE user_key = 'mem.ns/u1' ORDER BY created_at");
  assert.deepEqual(rows.rows.map((r) => r.status), ['superseded', 'active']);

  const found = await mk('').searchMemory({ appName: 'mem.ns', userId: 'u1', query: 'The user now prefers black tea.' });
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

  // ADK's name reads the same silo the same way.
  const viaAdk = await service('').searchMemory({ appName: 'eng.ns', userId: 'u1', query: 'The user takes coffee black.' });
  assert.deepEqual(viaAdk, found);

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
    await pool.query('TRUNCATE adk_sessions, adk_session_events, adk_memory_facts, adk_turns, adk_telemetry, adk_payloads, adk_a2a_tasks, melchizedek_memory_ingest, melchizedek_tasks, melchizedek_task_owners');
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
    `);
  };
  const ids = async (sql: string) => (await pool.query(sql)).rows.map((r) => Object.values(r)[0]).sort();

  await seed();
  const a = await storage.erase('u1', { namespace: 'ns1' });
  assert.deepEqual(
    { ...a },
    { memory_facts: 2, sessions: 3, turns: 2, spans: 1, payloads: 1, verdicts: 0, labels: 0, tasks: 1, memory_markers: 1, task_tools: 0 },
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
  assert.deepEqual(await ids('SELECT owner FROM melchizedek_task_owners'), ['u2']);
  assert.deepEqual(await ids('SELECT id FROM adk_sessions'), ['ns1:u1/end:c3', 'ns1:u2:c1']);

  await seed();
  const c = await storage.erase('u1', { namespace: 'ns1', includeNested: true });
  assert.equal(c.memory_facts, 3);
  assert.equal(c.memory_markers, 2, 'ns1/u1 and the nested ns1/u1/end');
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
    const s = await priv.sessionService.createSession({ appName: 'pns', userId: 'pu', sessionId: 'pc' });
    assert.ok(await priv.sessionService.getSession({ appName: 'pns', userId: 'pu', sessionId: s.id }));
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
  const s = await svc.getSession({ appName: 'legacy', userId: 'lu', sessionId: 'lc' });
  assert.deepEqual(s!.events.map((e) => e.id), ['e1', 'e2'], 'the JSON history, in order');
  // Reading again does not import twice; an append lands after the history.
  await svc.getSession({ appName: 'legacy', userId: 'lu', sessionId: 'lc' });
  await svc.appendEvent({ session: s!, event: { id: 'e3', author: 'user', timestamp: 3, invocationId: 'i', content: { role: 'user', parts: [{ text: 'third' }] }, actions: {} } as any });
  const again = await svc.getSession({ appName: 'legacy', userId: 'lu', sessionId: 'lc' });
  assert.deepEqual(again!.events.map((e) => e.id), ['e1', 'e2', 'e3']);
  const rows = await pool.query(`SELECT seq FROM adk_session_events WHERE session_id = 'legacy:lu:lc' ORDER BY seq`);
  assert.deepEqual(rows.rows.map((r) => r.seq), [1, 2, 3]);
  // An append before any read imports first, too.
  await pool.query(
    `INSERT INTO adk_sessions (id, app_name, user_id, state, events, last_update_time) VALUES ('legacy:lu:ld', 'legacy', 'lu', '{}', $1::jsonb, 2)`,
    [JSON.stringify(legacy)],
  );
  await svc.appendEvent({ session: { id: 'ld', appName: 'legacy', userId: 'lu', state: {}, events: [], lastUpdateTime: 0 } as any, event: { id: 'e3', author: 'user', timestamp: 3, invocationId: 'i', content: { role: 'user', parts: [{ text: 'x' }] }, actions: {} } as any });
  const d = await svc.getSession({ appName: 'legacy', userId: 'lu', sessionId: 'ld' });
  assert.deepEqual(d!.events.map((e) => e.id), ['e1', 'e2', 'e3']);
});
