/**
 * tests/postgresLedger.test.ts — the telemetry ledger over a direct Postgres
 * connection (ADR 0131), offline on embedded Postgres (PGlite): a traced
 * turn through postgresStorage({ ledger: true }) lands in adk_turns,
 * adk_telemetry and adk_payloads with the columns the Supabase sink writes,
 * credentials redacted, and the client refuses any table but the ledger's.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
process.env.TELEMETRY_PAYLOADS = 'all';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

import { inProcessTurnLock, postgresStorage } from '../lib/storage/postgres/index.ts';
import type { PostgresStorage } from '../lib/storage/postgres/index.ts';
import { postgresLedgerClient } from '../lib/observability/supabaseSpanExporter.ts';
import { flushTracing } from '../lib/observability/tracer.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { ScriptedModel, answer, shimResolver } from './helpers/scriptedModel.ts';

setLogLevel('error');

const INSTALL = [
  ...readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => `db/migrations/${f}`),
  'db/hardening.sql',
  'db/telemetry.sql',
  'db/hardening.sql',
];

let db: PGlite;
let server: PGLiteSocketServer;
let storage: PostgresStorage;

before(async () => {
  db = await PGlite.create({ extensions: { vector } });
  for (const f of INSTALL) await db.exec(readFileSync(f, 'utf-8'));
  server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 16 });
  await server.start();
  const { port } = (server as unknown as { server: { address(): { port: number } } }).server.address();
  storage = postgresStorage({
    connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
    poolConfig: { max: 2 },
    turnLock: inProcessTurnLock(),
    ledger: { deadLetterFile: '' },
  });
});

after(async () => {
  await storage?.close();
  await server?.stop();
  await db?.close();
});

// A credential-shaped string the redactor must keep out of every ledger row.
const FAKE_KEY = 'sk-ant-api03-' + 'x'.repeat(40);

test('a traced turn writes adk_turns, adk_telemetry and adk_payloads through the pool', async () => {
  const desk = new ScriptedModel('scripted/ledger', () => answer('Ledger noted.', { inputTokens: 120, outputTokens: 7 }));
  const config = { syndicate_name: 'LedgerDesk', orchestrator: { name: 'Desk', model: 'scripted/ledger', instruction: 'Answer briefly.' }, subagents: [] } as unknown as SyndicateYamlConfig;
  const r = await runSyndicateTurn({
    config, parts: [{ text: `Remember this. My key is ${FAKE_KEY}` }], appName: 'ledger', userId: 'u', sessionId: 'c',
    sessionService: storage.sessionService, compile: { resolveModel: shimResolver({ ledger: desk }), log: () => {} },
  });
  assert.equal(r.status, 'completed', r.error?.message);
  await flushTracing();

  const turns = await storage.pool.query(`SELECT * FROM adk_turns WHERE syndicate = 'LedgerDesk'`);
  assert.equal(turns.rows.length, 1, 'one turn row');
  const turn = turns.rows[0];
  assert.equal(turn.session_id, 'c');
  assert.equal(turn.output, 'Ledger noted.');
  assert.equal(turn.input_tokens, 120);
  assert.equal(turn.output_tokens, 7);
  assert.equal(turn.llm_calls, 1);
  assert.ok(Array.isArray(turn.models) && turn.models.length === 1, 'TEXT[] column filled from a JSON array');
  assert.ok(Array.isArray(turn.tool_events), 'JSONB column filled');
  assert.ok(typeof turn.id === 'string' || typeof turn.id === 'number', 'the identity column kept its default');
  assert.ok(!String(turn.input).includes(FAKE_KEY), 'the credential is redacted in adk_turns.input');

  const telemetry = await storage.pool.query(`SELECT count(*)::int AS n FROM adk_telemetry WHERE trace_id = $1`, [turn.trace_id]);
  assert.ok(telemetry.rows[0].n >= 1, 'model-call spans in adk_telemetry');
  const payloads = await storage.pool.query(`SELECT request, response FROM adk_payloads WHERE trace_id = $1`, [turn.trace_id]);
  assert.ok(payloads.rows.length >= 1, 'TELEMETRY_PAYLOADS=all keeps the payload');
  assert.ok(!JSON.stringify(payloads.rows).includes(FAKE_KEY), 'the credential is redacted in adk_payloads');
});

test('the ledger client names only the ledger tables', async () => {
  const client = postgresLedgerClient(storage.pool);
  const { error } = await client.from('adk_sessions').insert([{ id: 'x' }]);
  assert.match(error?.message ?? '', /not a ledger table/);
  assert.deepEqual(await client.from('adk_turns').insert([]), { error: null });
});
