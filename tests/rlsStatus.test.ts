/**
 * tests/rlsStatus.test.ts — the hardening check holds on both storage paths:
 * one set of rules (lib/storage/rlsStatus.ts), and the server refuses a public
 * deployment on the DATABASE_URL path as it does on supabase-js.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { InMemorySessionService } from '@google/adk';

import { createA2AApp } from '../lib/a2a/app.ts';
import { evaluatePostgresRls, evaluateRlsRows } from '../lib/storage/rlsStatus.ts';
import type { RlsHardeningStatus } from '../lib/storage/rlsStatus.ts';

const on = (table_name: string, rls_enabled = true) => ({ table_name, rls_enabled });

test('the rules: both core tables need RLS, an open registry fails, open telemetry only warns', () => {
  assert.equal(evaluateRlsRows([on('adk_memory_facts'), on('adk_sessions')]).applied, true);
  assert.match(evaluateRlsRows([on('adk_memory_facts'), on('adk_sessions', false)]).detail, /disabled on: adk_sessions/);
  assert.equal(evaluateRlsRows([]).applied, false, 'tables missing from the answer count as unprotected');
  const registry = evaluateRlsRows([on('adk_memory_facts'), on('adk_sessions'), on('adk_agent_registry', false)]);
  assert.deepEqual([registry.applied, /adk_agent_registry/.test(registry.detail)], [false, true]);
  const telemetry = evaluateRlsRows([on('adk_memory_facts'), on('adk_sessions'), on('adk_telemetry', false)]);
  assert.deepEqual([telemetry.applied, /NOT on adk_telemetry/.test(telemetry.detail)], [true, true]);
});

test('on a direct connection: no API roles or a private schema means nothing exposes the tables', () => {
  assert.equal(evaluatePostgresRls({ apiRoles: false, schema: 'public', rows: [] }).applied, true);
  assert.match(evaluatePostgresRls({ apiRoles: true, schema: 'melch', rows: [] }).detail, /schema "melch"/);
  assert.equal(evaluatePostgresRls({ apiRoles: true, schema: 'public', rows: [] }).applied, false);
  assert.equal(evaluatePostgresRls({ apiRoles: true, schema: 'public', rows: [on('adk_memory_facts'), on('adk_sessions')] }).applied, true);
});

const SHIPPED = readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).length;

async function boot(status: RlsHardeningStatus, requireHardenedDb: boolean) {
  const warnings: string[] = [];
  const logs: string[] = [];
  await createA2AApp({
    defaultSyndicate: 'assistant.yaml',
    servedAgents: ['assistant.yaml'],
    serverSecret: 'test-secret-0123456789abcdef0123456789', // gitleaks:allow (test fixture)
    storage: { sessionService: new InMemorySessionService(), schemaVersion: async () => SHIPPED, rlsHardening: async () => status },
    requireHardenedDb,
    log: (m) => logs.push(m),
    warn: (m) => warnings.push(m),
  });
  return { warnings, logs };
}

test('the DATABASE_URL path refuses a public deployment without hardening, and warns a private one', async () => {
  const open = { applied: false, detail: 'RLS is disabled on: adk_sessions' };
  await assert.rejects(boot(open, true), /hardening is missing \(RLS is disabled on: adk_sessions\).*ALLOW_UNHARDENED_DB/);
  const local = await boot(open, false);
  assert.ok(local.warnings.some((w) => /hardening not applied/.test(w)));
  const ok = await boot({ applied: true, detail: 'RLS enabled on adk_memory_facts and adk_sessions' }, true);
  assert.ok(ok.logs.some((l) => /DB hardening verified/.test(l)));
});
