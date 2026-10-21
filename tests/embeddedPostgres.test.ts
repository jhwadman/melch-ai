/**
 * tests/embeddedPostgres.test.ts — the schema and the direct-Postgres adapter
 * on embedded Postgres (PGlite with pgvector, ADR 0130), offline: every
 * migration, telemetry.sql and hardening.sql install and re-install on a
 * database with no Supabase API roles; the role revokes still apply where
 * the roles exist; postgresStorage runs over pglite-socket; and the turn
 * lock is exclusive only with the `turnLock` option.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

import { inProcessTurnLock, postgresStorage } from '../lib/storage/postgres/index.ts';
import type { PostgresStorage } from '../lib/storage/postgres/index.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { ScriptedModel, answer, requestTexts, shimResolver } from './helpers/scriptedModel.ts';

setLogLevel('error');
process.env.OTEL_CONSOLE_SPANS = 'false';

// The set `melchizedek-db apply --telemetry` installs, in its order.
const INSTALL = [
  ...readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => `db/migrations/${f}`),
  'db/hardening.sql',
  'db/telemetry.sql',
  'db/hardening.sql',
];

/** The highest numbered migration: what a fully installed database records. */
const HIGHEST = Math.max(...INSTALL.filter((f) => f.startsWith('db/migrations/')).map((f) => Number(f.slice('db/migrations/'.length, 'db/migrations/'.length + 4))));

async function install(db: PGlite): Promise<void> {
  for (const f of INSTALL) await db.exec(readFileSync(f, 'utf-8'));
}

const API_TABLES = ['adk_sessions', 'adk_memory_facts', 'adk_turns', 'adk_payloads', 'adk_agent_registry', 'melchizedek_tool_credentials', 'model_pricing'];

let plain: PGlite;
let server: PGLiteSocketServer;
let url: string;

before(async () => {
  plain = await PGlite.create({ extensions: { vector } });
  await install(plain);
  server = new PGLiteSocketServer({ db: plain, port: 0, host: '127.0.0.1', maxConnections: 16 });
  await server.start();
  const address = (server as unknown as { server: { address(): { port: number } } }).server.address();
  url = `postgres://postgres@127.0.0.1:${address.port}/postgres`;
});

after(async () => {
  await server?.stop();
  await plain?.close();
});

test('the whole install applies twice on a database with no Supabase API roles, and creates none', async () => {
  await install(plain); // the second time: every file is idempotent
  const roles = await plain.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`);
  assert.deepEqual(roles.rows, [], 'hardening.sql must not create roles');
  const version = await plain.query<{ v: number }>('SELECT max(version) AS v FROM melchizedek_schema_version');
  assert.equal(version.rows[0].v, HIGHEST);
  const rls = await plain.query<{ table_name: string; rls_enabled: boolean }>('SELECT * FROM melchizedek_rls_status()');
  assert.ok(rls.rows.length >= 17);
  assert.deepEqual(rls.rows.filter((r) => !r.rls_enabled), [], 'RLS is on for every listed table');
  // PGlite is one session, so the helpers are still visible here; what matters
  // is that they live only in the session's temporary schema, not in public.
  const helpers = await plain.query<{ nspname: string }>(
    `SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname IN ('melchizedek_api_roles', 'melchizedek_revoke_api')`,
  );
  assert.ok(helpers.rows.length > 0 && helpers.rows.every((r) => r.nspname.startsWith('pg_temp')), 'the helpers live in pg_temp only');
});

test('where the API roles exist, hardening revokes their table and function privileges', async () => {
  const db = await PGlite.create({ extensions: { vector } });
  try {
    for (const r of ['anon', 'authenticated', 'service_role']) await db.exec(`CREATE ROLE ${r} NOLOGIN`);
    // Supabase grants the API roles everything on public by default; do the same.
    await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated');
    await install(db);
    for (const role of ['anon', 'authenticated']) {
      for (const t of API_TABLES) {
        const r = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, t]);
        assert.equal(r.rows[0].ok, false, `${role} may not read ${t}`);
      }
      const fn = await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, 'melchizedek_rls_status()', 'EXECUTE') AS ok`, [role]);
      assert.equal(fn.rows[0].ok, false, `${role} may not execute melchizedek_rls_status()`);
    }
    const sr = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', 'melchizedek_rls_status()', 'EXECUTE') AS ok`);
    assert.equal(sr.rows[0].ok, true, 'service_role keeps the boot check');
  } finally {
    await db.close();
  }
});

test('the advisory turn lock excludes nothing on one embedded session; the turnLock option does', async () => {
  const advisory = postgresStorage({ connectionString: url, poolConfig: { max: 2 }, lockPoolMax: 2 });
  const single = postgresStorage({ connectionString: url, poolConfig: { max: 2 }, turnLock: inProcessTurnLock() });
  try {
    const a1 = await advisory.turnLock('k', { waitMs: 50 });
    const a2 = await advisory.turnLock('k', { waitMs: 50 });
    assert.ok(a1 && a2, 'pglite-socket runs every connection in one session, where an advisory lock is re-entrant');
    await a1(); await a2();

    const s1 = await single.turnLock('k', { waitMs: 50 });
    const s2 = await single.turnLock('k', { waitMs: 50 });
    assert.ok(s1);
    assert.equal(s2, null, 'the in-process lock holds the second turn back');
    await s1();
    const s3 = await single.turnLock('k', { waitMs: 50 });
    assert.ok(s3, 'released, the key can be taken again');
    await s3();
  } finally {
    await advisory.close();
    await single.close();
  }
});

test('a conversation through runSyndicateTurn persists on embedded Postgres and the next turn resumes it', async () => {
  const storage: PostgresStorage = postgresStorage({ connectionString: url, poolConfig: { max: 2 }, turnLock: inProcessTurnLock() });
  try {
    const desk = new ScriptedModel('scripted/emb', (req) => answer(`Seen: ${requestTexts(req).filter((t) => !t.startsWith('Seen')).join(' | ')}`));
    const config = { syndicate_name: 'Desk', orchestrator: { name: 'Desk', model: 'scripted/emb', instruction: 'Answer briefly.' }, subagents: [] } as unknown as SyndicateYamlConfig;
    const texts: string[] = [];
    for (const message of ['first', 'second']) {
      const r = await runSyndicateTurn({
        config, parts: [{ text: message }], appName: 'emb', userId: 'u', sessionId: 'c',
        sessionService: storage.sessionService, compile: { resolveModel: shimResolver({ emb: desk }), log: () => {} }, trace: false,
      });
      assert.equal(r.status, 'completed', r.error?.message);
      texts.push(r.text);
    }
    assert.match(texts[1], /first/, 'the second turn carried the first message from the rows');
    const rows = await storage.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM adk_session_events WHERE session_id = 'emb:u:c'`);
    assert.equal(rows.rows[0].n, 4);
    assert.equal(await storage.schemaVersion(), HIGHEST);
  } finally {
    await storage.close();
  }
});
