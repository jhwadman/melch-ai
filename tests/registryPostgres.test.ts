/**
 * tests/registryPostgres.test.ts — the agent registry over a direct Postgres
 * connection (DATABASE_URL), offline on embedded Postgres with every
 * migration: publish, versions, show, rollback and retire through a pool run
 * the migration's own SQL functions; loadSyndicateFromRegistry reads through
 * postgresRegistryReader; and createA2AApp on postgresStorage serves a
 * registry row as its default and a bare registry id per request, with no
 * Supabase credentials in the environment.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

import { activateVersion, getVersion, listAgents, listVersions, postgresRegistryReader, publishAgent, retireAgent } from '../lib/registry.ts';
import { loadSyndicateFromRegistry } from '../lib/loadSyndicate.ts';
import { createA2AApp } from '../lib/a2a/app.ts';
import { inProcessTurnLock, postgresStorage } from '../lib/storage/postgres/index.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';

setLogLevel('error');

const INSTALL = [...readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => `db/migrations/${f}`), 'db/hardening.sql'];
const SECRET = 'registry-pg-test-secret-0123456789abcdef'; // gitleaks:allow (test fixture)

const desk = (name: string, instruction: string) => ({
  syndicate_name: name,
  memory_system: 'session-only',
  orchestrator: { name: name.replace(/\s+/g, '_'), model: 'scripted/desk', instruction },
  subagents: [],
});

let db: PGlite;
let socket: PGLiteSocketServer;
let url: string;

before(async () => {
  db = await PGlite.create({ extensions: { vector } });
  for (const f of INSTALL) await db.exec(readFileSync(f, 'utf-8'));
  socket = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 8 });
  await socket.start();
  const address = (socket as unknown as { server: { address(): { port: number } } }).server.address();
  url = `postgres://postgres@127.0.0.1:${address.port}/postgres`;
});

after(async () => {
  await socket?.stop();
  await db?.close();
});

test('publish, versions, show, rollback and retire run over a direct connection', async () => {
  assert.equal(await publishAgent(db, 'support', desk('Support', 'v one'), { author: 'jimmy', note: 'first' }), 1);
  assert.equal(await publishAgent(db, 'support', desk('Support', 'v two'), { author: 'jimmy', note: 'second' }), 2);
  assert.equal(await publishAgent(db, 'support', desk('Support', 'v one'), { author: 'jimmy' }), 1, 'the same definition again re-activates its version');

  const versions = await listVersions(db, 'support');
  assert.deepEqual(versions.map((v) => [v.version, v.active]), [[2, false], [1, true]]);
  assert.equal(versions[1]!.publishedBy, 'jimmy');
  assert.equal(versions[1]!.note, 'first');
  assert.match(versions[0]!.publishedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(((await getVersion(db, 'support', 2)) as any).orchestrator.instruction, 'v two');

  assert.equal(await activateVersion(db, 'support', 2, { author: 'jimmy', note: 'roll forward' }), 2);
  const [entry] = await listAgents(db);
  assert.equal(entry!.id, 'support');
  assert.equal(entry!.version, 2);

  await assert.rejects(getVersion(db, 'support', 9), /no version 9/);
  await assert.rejects(publishAgent(db, 'bad id!', desk('X', 'x')), /Invalid registry id/);
  await assert.rejects(publishAgent(db, 'broken', { syndicate_name: 'Broken', orchestrator: { name: 'X' } }), /model|instruction|required/i, 'validated before anything is written');
  assert.equal((await listAgents(db)).length, 1);
});

test('the loader reads the active row, a pinned version, and says when there is none', async () => {
  const registry = postgresRegistryReader(db);
  assert.equal((await loadSyndicateFromRegistry('support', { registry })).orchestrator.instruction, 'v two');
  assert.equal((await loadSyndicateFromRegistry('support@1', { registry })).orchestrator.instruction, 'v one');
  await assert.rejects(loadSyndicateFromRegistry('nobody', { registry }), /not found/);
  await assert.rejects(loadSyndicateFromRegistry('support@7', { registry }), /not found/);
});

test('without a reader or Supabase credentials, the loader names both ways to reach a registry', async () => {
  await assert.rejects(loadSyndicateFromRegistry('support'), /DATABASE_URL.*SUPABASE_URL/);
});

test('the A2A server on postgresStorage serves registry rows with no Supabase API', async () => {
  await publishAgent(db, 'desk', desk('Front Desk', 'Greet.'));
  const storage = postgresStorage({ connectionString: url, poolConfig: { max: 2 }, turnLock: inProcessTurnLock() });
  let server: Server | undefined;
  try {
    const built = await createA2AApp({
      defaultSyndicate: 'registry:support',
      registryAgents: ['desk'],
      serverSecret: SECRET,
      storage,
      allowSchemaMismatch: true,
      log: () => {},
      warn: () => {},
    });
    server = await new Promise<Server>((resolve) => {
      const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const auth = { Authorization: `Bearer ${SECRET}` };
    const card = await fetch(`${base}/.well-known/agent-card.json`, { headers: auth });
    assert.equal(card.status, 200);
    assert.equal(((await card.json()) as any).name, 'Support', 'the default syndicate is the registry row');
    const deskCard = await fetch(`${base}/desk/.well-known/agent-card.json`, { headers: auth });
    assert.equal(deskCard.status, 200);
    assert.equal(((await deskCard.json()) as any).name, 'Front_Desk', 'a bare registry id loads per request');
    assert.equal((await fetch(`${base}/registry:nobody/.well-known/agent-card.json`, { headers: auth })).status, 404);
  } finally {
    server?.close();
    await storage.pool.end();
  }
});

test('retire stops serving an id and keeps its history', async () => {
  assert.equal(await retireAgent(db, 'support'), true);
  assert.equal(await retireAgent(db, 'support'), false);
  await assert.rejects(loadSyndicateFromRegistry('support', { registry: postgresRegistryReader(db) }), /not found/);
  assert.equal((await listVersions(db, 'support')).length, 2);
  assert.ok((await listVersions(db, 'support')).every((v) => !v.active));
});

test('melchizedek-registry runs its commands against a direct connection', async () => {
  const { main } = await import('../scripts/registry.ts');
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    assert.equal(await main(['list'], db), 0);
    assert.equal(await main(['versions', 'desk'], db), 0);
    assert.equal(await main(['show', 'desk@1'], db), 0);
  } finally {
    console.log = log;
  }
  assert.ok(lines.some((l) => /^desk\s+v1/.test(l)), 'list names the active id and version');
  assert.ok(lines.some((l) => /^\* v1/.test(l)), 'versions marks the active one');
});
