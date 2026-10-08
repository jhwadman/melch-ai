/**
 * tests/turnLock.test.ts — one turn at a time per conversation (ADR 0021):
 * the in-process lock, and the server serialising (or refusing) a second
 * turn on a busy conversation. The advisory lock across instances is in
 * tests/postgresStorage.test.ts.
 *
 * The cases that run a turn run on both runtimes, through
 * MELCHIZEDEK_RUNTIME (tests/helpers/runtime.ts).
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';

import { createA2AApp } from '../lib/a2a/app.ts';
import { inProcessTurnLock, turnLockKey } from '../lib/a2a/turnLock.ts';
import { ScriptedLlm, sentTexts, text } from './helpers/scriptedLlm.ts';
import { forEachRuntime } from './helpers/runtime.ts';

setLogLevel(LogLevel.ERROR);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('in-process lock: a second holder waits, then gets it on release', async () => {
  const lock = inProcessTurnLock();
  const order: string[] = [];
  const a = await lock('k', { waitMs: 1000 });
  assert.ok(a);
  const bP = lock('k', { waitMs: 1000 }).then((rel) => (order.push('b'), rel));
  await sleep(20);
  order.push('a-done');
  await a!();
  const b = await bP;
  assert.ok(b);
  assert.deepEqual(order, ['a-done', 'b']);
  await b!();
  assert.ok(await lock('k', { waitMs: 0 }), 'free again after the last release');
});

test('in-process lock: the wait runs out, an abort gives up, other keys are independent', async () => {
  const lock = inProcessTurnLock();
  const a = await lock('k', { waitMs: 0 });
  assert.equal(await lock('k', { waitMs: 30 }), null);
  const ac = new AbortController();
  const p = lock('k', { waitMs: 5000, signal: ac.signal });
  ac.abort();
  assert.equal(await p, null);
  assert.ok(await lock('other', { waitMs: 0 }), 'a different conversation is not blocked');
  await a!();
  assert.ok(await lock('k', { waitMs: 0 }), 'timed-out and aborted waiters left no trace');
});

test('turnLockKey keeps namespace, scope and conversation apart', () => {
  assert.notEqual(turnLockKey('a', 'b', 'c'), turnLockKey('a', 'bc', ''));
});

// ── The server ──────────────────────────────────────────────────────────────
const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const dir = mkdtempSync(join(tmpdir(), 'melch-lock-'));
writeFileSync(join(dir, 'slowecho.yaml'), ['syndicate_name: SlowEcho', 'orchestrator:', '  name: SlowEcho', '  model: scripted/slowecho', '  instruction: Echo.', 'subagents: []'].join('\n'));
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function serve(turnLockWaitMs: number) {
  const built = await createA2AApp({
    defaultSyndicate: 'slowecho.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InMemorySessionService() },
    keyMode: 'byok',
    turnLockWaitMs,
    resolveModel: () =>
      new ScriptedLlm('scripted/slowecho', async (req) => {
        await sleep(250);
        return text(`saw ${sentTexts(req).length} message(s): ${sentTexts(req).join(' | ')}`);
      }),
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

async function send(base: string, textValue: string, contextId: string) {
  const res = await fetch(`${base}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'X-API-Key': 'caller-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', contextId, parts: [{ kind: 'text', text: textValue }] } },
    }),
  });
  const r = (await res.json()) as any;
  const status = r.result?.status;
  return { state: status?.state, text: (status?.message?.parts ?? []).map((p: any) => p.text ?? '').join('') };
}

forEachRuntime('two turns on one conversation run one after the other; the second sees the first', async () => {
  const base = await serve(10_000);
  const ctx = crypto.randomUUID();
  const [first, second] = await Promise.all([send(base, 'one', ctx), sleep(30).then(() => send(base, 'two', ctx))]);
  assert.equal(first.state, 'completed');
  assert.equal(second.state, 'completed');
  assert.match(second.text, /one/, 'the second turn ran after the first and saw its exchange');
});

forEachRuntime('a second turn that waits too long is refused, and other conversations are not held up', async () => {
  const base = await serve(50);
  const ctx = crypto.randomUUID();
  const [first, second, other] = await Promise.all([
    send(base, 'one', ctx),
    sleep(30).then(() => send(base, 'two', ctx)),
    sleep(30).then(() => send(base, 'elsewhere', crypto.randomUUID())),
  ]);
  assert.equal(first.state, 'completed');
  assert.equal(second.state, 'rejected');
  assert.match(second.text, /still running/);
  assert.equal(other.state, 'completed');
});
