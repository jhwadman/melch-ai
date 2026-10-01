/**
 * tests/taskLeases.test.ts — the server reaps expired task leases at boot,
 * renews its own on a heartbeat, and stops both on shutdown (ADR 0021).
 * The SQL is exercised against Postgres in tests/postgresStorage.test.ts.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionService } from '@google/adk';

import { createA2AApp } from '../lib/a2a/app.ts';

test('leases: reaped at boot, renewed on a heartbeat, stopped on shutdown', async () => {
  let reaps = 0;
  let renewals = 0;
  const warnings: string[] = [];
  const app = await createA2AApp({
    defaultSyndicate: 'assistant.yaml',
    servedAgents: ['assistant.yaml'],
    serverSecret: 'test-secret-0123456789abcdef0123456789', // gitleaks:allow (test fixture)
    storage: {
      sessionService: new InMemorySessionService(),
      leases: { ttlMs: 3000, reap: async () => (++reaps === 1 ? 2 : 0), renew: async () => ++renewals },
    },
    log: () => {},
    warn: (m) => warnings.push(m),
  });
  assert.equal(reaps, 1, 'reaped once at boot');
  assert.ok(warnings.some((w) => /Failed 2 task\(s\) left running by a stopped instance/.test(w)));
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(renewals >= 1, 'renewed on the heartbeat (a third of the lease)');
  await app.shutdown(0);
  const after = renewals;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(renewals, after, 'no renewals after shutdown');
});
