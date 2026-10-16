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

// ── Cost (ADR 0136): model_pricing and cost_usd at write time ───────────────

const toolResultCount = (req: { messages: Array<{ role: string; parts: unknown[] }> }): number =>
  req.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts).length;

/** A Boss on `boss` delegating once to a Clerk on `clerk`, each reporting its usage. */
async function delegatedTurn(syndicate: string, boss: string, clerk: string) {
  const models = {
    [boss]: new ScriptedModel(`scripted/${boss}`, (req) =>
      toolResultCount(req) === 0
        ? { partial: false, parts: [{ type: 'toolCall', id: 'call-clerk', name: 'Clerk', args: { request: 'file it' } }], finishReason: 'tool_call', usage: { inputTokens: 1_000, outputTokens: 100 } }
        : answer('Filed.', { inputTokens: 2_000, outputTokens: 200, thinkingTokens: 50 }),
    ),
    [clerk]: new ScriptedModel(`scripted/${clerk}`, () => answer('done', { inputTokens: 500, outputTokens: 40 })),
  } as Record<string, ScriptedModel>;
  const config = {
    syndicate_name: syndicate,
    orchestrator: { name: 'Boss', model: `scripted/${boss}`, instruction: 'Delegate.' },
    subagents: [{ name: 'Clerk', model: `scripted/${clerk}`, instruction: 'File.', description: 'Files.' }],
  } as unknown as SyndicateYamlConfig;
  const r = await runSyndicateTurn({
    config, parts: [{ text: 'File this.' }], appName: 'ledger', userId: 'u', sessionId: syndicate,
    sessionService: storage.sessionService, compile: { resolveModel: shimResolver(models), log: () => {} },
  });
  assert.equal(r.status, 'completed', r.error?.message);
  await flushTracing();
  const turn = (await storage.pool.query(`SELECT * FROM adk_turns WHERE syndicate = $1`, [syndicate])).rows[0];
  const calls = (await storage.pool.query(`SELECT model, cost_usd FROM adk_telemetry WHERE trace_id = $1 AND span_name = 'llm.request' ORDER BY ts, id`, [turn.trace_id])).rows;
  return { turn, calls };
}

test('cost: a turn is priced per model from model_pricing at write time, input summed per call, thinking at the output rate', async () => {
  await storage.pool.query(`INSERT INTO model_pricing (model, input_per_mtok, output_per_mtok) VALUES ('scripted/boss-priced', 3, 15), ('scripted/clerk-priced', 1, 5) ON CONFLICT (model) DO NOTHING`);
  const { turn, calls } = await delegatedTurn('CostDesk', 'boss-priced', 'clerk-priced');
  const usage = JSON.parse(turn.attributes['syndicate.usage']);
  assert.deepEqual(usage, {
    'scripted/boss-priced': { calls: 2, input: 3_000, output: 250, thinking: 50 },
    'scripted/clerk-priced': { calls: 1, input: 500, output: 40, thinking: 0 },
  });
  // The contract's outputTokens include thinking; the ledger splits them (200 → 150 output + 50 thinking), and both bill at the output rate.
  // Boss: 3000×3 + (250+50)×15 = 13500; Clerk: 500×1 + 40×5 = 700 → 14200 / 1e6.
  assert.equal(Number(turn.cost_usd), 0.0142);
  assert.equal(turn.input_tokens, 2_000, 'input_tokens keeps its meaning (peak prompt); cost sums every call');
  assert.deepEqual(calls.map((c) => [c.model, Number(c.cost_usd)]), [
    ['scripted/boss-priced', (1_000 * 3 + 100 * 15) / 1e6],
    ['scripted/clerk-priced', (500 * 1 + 40 * 5) / 1e6],
    ['scripted/boss-priced', (2_000 * 3 + (150 + 50) * 15) / 1e6],
  ]);
  const root = (await storage.pool.query(`SELECT cost_usd FROM adk_telemetry WHERE trace_id = $1 AND model IS NULL`, [turn.trace_id])).rows;
  assert.ok(root.length >= 1 && root.every((r) => Number(r.cost_usd) === 0.0142), 'the root span row carries the turn cost');
});

test('cost: a model with no price row leaves the call null and the whole turn null, never a partial sum', async () => {
  const { turn, calls } = await delegatedTurn('UnpricedDesk', 'boss-priced', 'clerk-unpriced');
  assert.equal(turn.cost_usd, null);
  assert.deepEqual(calls.map((c) => [c.model, c.cost_usd === null ? null : Number(c.cost_usd)]), [
    ['scripted/boss-priced', 0.0045],
    ['scripted/clerk-unpriced', null],
    ['scripted/boss-priced', 0.009],
  ]);
});

test('cost: the pricing functions, the prefix row, the shipped seed, and a value the writer set', async () => {
  const one = async (sql: string, values: unknown[] = []) => (await storage.pool.query(sql, values)).rows[0].v;
  assert.equal(Number(await one(`SELECT melchizedek_cost_usd('ollama/qwen3:8b', 1000000, 1000000, 0) AS v`)), 0, 'ollama/* prices every local model at zero');
  assert.equal(Number(await one(`SELECT melchizedek_cost_usd('claude-opus-5', 1000000, 1000000, 1000000) AS v`)), 55);
  assert.equal(await one(`SELECT melchizedek_cost_usd('no-such-model', 10, 10, 0) AS v`), null);
  assert.equal(Number(await one(`SELECT melchizedek_usage_cost('{}'::jsonb) AS v`)), 0, 'no model call costs nothing');
  assert.equal(await one(`SELECT melchizedek_usage_cost(NULL) AS v`), null);
  assert.equal(await one(`SELECT melchizedek_usage_cost('[1]'::jsonb) AS v`), null);
  const seeded = (await storage.pool.query(`SELECT model, verified_at FROM model_pricing WHERE source = 'melch-obs/pricing.toml' ORDER BY model`)).rows;
  assert.equal(seeded.length, 15, 'every pricing.toml row is seeded');
  assert.equal(seeded.filter((r) => r.verified_at === null).map((r) => r.model).join(','), 'gemini-3.1-flash-lite,gemini-3.7-flash,gemini-3.8-flash,grok-4.5,grok-4.7');
  // An explicit value is kept; unreadable usage leaves the cost null without failing the insert.
  const client = postgresLedgerClient(storage.pool);
  const row = { ts: new Date().toISOString(), trace_id: 't-explicit', span_id: 's1', syndicate: 'X', stage: 'delegate', input: '', output: '', relay_fallback: false, tool_calls: 0, models: [], tool_events: [], schema_version: 2 };
  assert.deepEqual(await client.from('adk_turns').insert([{ ...row, cost_usd: 1.25, attributes: { 'syndicate.usage': '{"claude-opus-5":{"input":1}}' } }]), { error: null });
  assert.deepEqual(await client.from('adk_turns').insert([{ ...row, span_id: 's2', attributes: { 'syndicate.usage': 'not json' } }]), { error: null });
  const costs = (await storage.pool.query(`SELECT span_id, cost_usd FROM adk_turns WHERE trace_id = 't-explicit' ORDER BY span_id`)).rows;
  assert.deepEqual(costs.map((c) => [c.span_id, c.cost_usd === null ? null : Number(c.cost_usd)]), [['s1', 1.25], ['s2', null]]);
});

test('cost: a role that may insert into the ledger but not read model_pricing still gets the cost (SECURITY DEFINER trigger)', async () => {
  await storage.pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_writer') THEN CREATE ROLE ledger_writer NOLOGIN; END IF; END $$`);
  await storage.pool.query(`GRANT INSERT, SELECT ON adk_telemetry TO ledger_writer`);
  await storage.pool.query(`DROP POLICY IF EXISTS ledger_writer_all ON adk_telemetry`);
  await storage.pool.query(`CREATE POLICY ledger_writer_all ON adk_telemetry TO ledger_writer USING (true) WITH CHECK (true)`);
  const client = await storage.pool.connect();
  try {
    await client.query('SET ROLE ledger_writer');
    await assert.rejects(client.query('SELECT * FROM model_pricing'), /permission denied/);
    await client.query(
      `INSERT INTO adk_telemetry (trace_id, span_id, span_name, model, input_tokens, output_tokens, thinking_tokens, latency_ms, span) VALUES ('t-role', 's', 'llm.request', 'claude-haiku-4-5', 1000000, 0, 0, 1, '{}')`,
    );
    const r = await client.query(`SELECT cost_usd FROM adk_telemetry WHERE trace_id = 't-role'`);
    assert.equal(Number(r.rows[0].cost_usd), 1);
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    client.release();
  }
});
