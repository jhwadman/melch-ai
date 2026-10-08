/**
 * tests/schemaVersion.test.ts — the server refuses a database behind the
 * migrations it ships (ADR 0021 item 3), warns on one ahead of them, and
 * starts anyway only when told to.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';

import { createA2AApp } from '../lib/a2a/app.ts';
import { compareSchema, packageDbDir, schemaBehindMessage, shippedSchemaVersion } from '../lib/storage/schemaVersion.ts';

const SHIPPED = readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).length;

test('the shipped version is the highest numbered migration', () => {
  assert.equal(shippedSchemaVersion(), SHIPPED);
  assert.match(packageDbDir(), /db$/);
});

test('compareSchema: behind, match, ahead; no version counts as behind', () => {
  assert.equal(compareSchema(SHIPPED, SHIPPED).state, 'match');
  assert.equal(compareSchema(SHIPPED - 1, SHIPPED).state, 'behind');
  assert.equal(compareSchema(null, SHIPPED).state, 'behind');
  assert.equal(compareSchema(SHIPPED + 1, SHIPPED).state, 'ahead');
  assert.match(schemaBehindMessage(compareSchema(null, SHIPPED)), /no recorded schema version.*melchizedek-db apply/);
});

async function boot(version: number | null, allowSchemaMismatch = false) {
  const warnings: string[] = [];
  const logs: string[] = [];
  const app = await createA2AApp({
    defaultSyndicate: 'assistant.yaml',
    servedAgents: ['assistant.yaml'],
    serverSecret: 'test-secret-0123456789abcdef0123456789', // gitleaks:allow (test fixture)
    storage: { sessionService: new InProcessSessionService(), schemaVersion: async () => version },
    allowSchemaMismatch,
    log: (m) => logs.push(m),
    warn: (m) => warnings.push(m),
  });
  return { app, warnings, logs };
}

test('a database behind the shipped migrations stops the server, naming the fix', async () => {
  await assert.rejects(boot(SHIPPED - 1), /schema version .*needs version .*melchizedek-db apply/);
  await assert.rejects(boot(null), /no recorded schema version/);
});

test('a matching database starts and says so; a newer one starts with a warning', async () => {
  const ok = await boot(SHIPPED);
  assert.ok(ok.logs.some((l) => l.includes(`DB schema version ${SHIPPED}`)));
  const ahead = await boot(SHIPPED + 1);
  assert.ok(ahead.warnings.some((w) => /newer than this server/.test(w)));
});

test('ALLOW_SCHEMA_MISMATCH starts a behind database with a warning', async () => {
  const r = await boot(SHIPPED - 1, true);
  assert.ok(r.warnings.some((w) => /Continuing because the mismatch is allowed/.test(w)));
});
