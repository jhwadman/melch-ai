/**
 * tests/readiness.test.ts — /readyz answers what a load balancer needs during a
 * rollout: not ready while the database is unreachable (logged once per change,
 * naming no host in the answer), and not ready after markUnready() while every
 * other route keeps serving, so the instance is deregistered before it closes.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';

import { createA2AApp } from '../lib/a2a/app.ts';

const SHIPPED = readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).length;
const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)

test('/readyz: storage outages, recovery, a shared cached check, and markUnready while serving', async () => {
  let dbUp = true;
  let probes = 0;
  const warnings: string[] = [];
  const logs: string[] = [];
  const built = await createA2AApp({
    defaultSyndicate: 'assistant.yaml',
    servedAgents: ['assistant.yaml'],
    serverSecret: SECRET,
    storage: {
      sessionService: new InProcessSessionService(),
      schemaVersion: async () => {
        probes++;
        if (!dbUp) throw new Error('connect ECONNREFUSED db.internal:5432');
        return SHIPPED;
      },
    },
    log: (m) => logs.push(m),
    warn: (m) => warnings.push(m),
  });
  const server = built.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const pastCache = () => new Promise((r) => setTimeout(r, 2_100));
  const ready = async () => {
    const res = await fetch(`${base}/readyz`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  try {
    const before = probes;
    const burst = await Promise.all(Array.from({ length: 20 }, () => ready()));
    assert.ok(burst.every((r) => r.status === 200));
    assert.equal(probes - before, 1, 'twenty concurrent probes share one database read');
    await ready();
    assert.equal(probes - before, 1, 'a probe within 2 s reuses the answer');

    await pastCache();
    dbUp = false;
    const down = await ready();
    assert.deepEqual([down.status, down.body], [503, { status: 'unavailable', reason: 'storage' }]);
    assert.ok(!JSON.stringify(down.body).includes('db.internal'), 'the answer names no host');
    await pastCache();
    await ready();
    assert.equal(warnings.filter((w) => /database is unreachable/.test(w)).length, 1, 'logged once per outage, not per probe');

    await pastCache();
    dbUp = true;
    assert.equal((await ready()).status, 200);
    assert.ok(logs.some((l) => /database answers again/.test(l)));

    built.markUnready();
    const stopping = await ready();
    assert.deepEqual([stopping.status, stopping.body.status], [503, 'draining']);
    const card = await fetch(`${base}/.well-known/agent-card.json`, { headers: { Authorization: `Bearer ${SECRET}` } });
    assert.equal(card.status, 200, 'requests are still served while readiness fails');
  } finally {
    server.close();
    await built.shutdown(0);
  }
});
