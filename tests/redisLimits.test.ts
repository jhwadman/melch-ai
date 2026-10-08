/**
 * tests/redisLimits.test.ts — the request limits in a shared store (ADR 0021
 * item 5): a fake Redis that runs the store's script, the store's counts and
 * expiry, and two server instances sharing one window.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';

import { createA2AApp } from '../lib/a2a/app.ts';
import { redisRateLimitStore } from '../lib/a2a/redisLimits.ts';

/** Just enough Redis for the store: its EVAL script, DECR, DEL, with expiry. */
function fakeRedis() {
  const data = new Map<string, { n: number; until: number }>();
  const live = (k: string) => {
    const v = data.get(k);
    if (v && v.until <= Date.now()) data.delete(k);
    return data.get(k);
  };
  const calls: string[][] = [];
  const command = async (args: string[]) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === 'EVAL') {
      const key = args[3]!;
      const ttl = Number(args[4]);
      const cur = live(key) ?? { n: 0, until: Date.now() + ttl };
      cur.n += 1;
      data.set(key, cur);
      return [cur.n, cur.until - Date.now()];
    }
    if (cmd === 'DECR') {
      const cur = live(args[1]!);
      if (cur) cur.n -= 1;
      return cur?.n ?? -1;
    }
    if (cmd === 'DEL') return data.delete(args[1]!) ? 1 : 0;
    throw new Error(`unexpected ${cmd}`);
  };
  return { command, calls, data };
}

test('the store counts per key, expires with the window, decrements and resets', async () => {
  const redis = fakeRedis();
  const store = redisRateLimitStore({ command: redis.command, prefix: 'p:' });
  store.init?.({ windowMs: 80 } as any);
  assert.equal((await store.increment('a')).totalHits, 1);
  assert.equal((await store.increment('a')).totalHits, 2);
  assert.equal((await store.increment('b')).totalHits, 1, 'keys are independent');
  await store.decrement('a');
  assert.equal((await store.increment('a')).totalHits, 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await store.increment('a')).totalHits, 1, 'a new window after expiry');
  await store.resetKey('a');
  assert.equal((await store.increment('a')).totalHits, 1);
  assert.ok(redis.calls.every((c) => c[0] !== 'EVAL' || c[3]!.startsWith('p:')), 'every key carries the prefix');
  assert.equal(store.localKeys, false);
});

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function instance(command: (a: string[]) => Promise<unknown>) {
  const built = await createA2AApp({
    defaultSyndicate: 'assistant.yaml',
    servedAgents: ['assistant.yaml'],
    serverSecret: SECRET,
    storage: { sessionService: new InProcessSessionService() },
    rateLimit: { windowMs: 60_000, max: 2 },
    limitStore: (limiter) => redisRateLimitStore({ command, prefix: `t:${limiter}:` }),
    log: () => {},
    warn: () => {},
  });
  const server: Server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

test('two server instances sharing the store share one window', async () => {
  const redis = fakeRedis();
  const [a, b] = await Promise.all([instance(redis.command), instance(redis.command)]);
  // A POST the limiter counts and the route then refuses cheaply (no body).
  const post = (base: string) =>
    fetch(`${base}/a2a/jsonrpc`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.status);
  assert.notEqual(await post(a), 429);
  assert.notEqual(await post(b), 429);
  assert.equal(await post(a), 429, 'the third request is over the shared limit, whichever instance gets it');
  assert.equal(await post(b), 429);
});
