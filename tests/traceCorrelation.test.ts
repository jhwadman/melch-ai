/**
 * tests/traceCorrelation.test.ts — a request can be followed across systems
 * (OPS-04): a caller's W3C traceparent is linked from the turn's root span
 * (never adopted: the turn's own trace id stays unique), and every
 * task record carries its task id and trace id. Offline: a scripted model.
 *
 * The cases that run a turn run on both runtimes, through
 * MELCHIZEDEK_RUNTIME (tests/helpers/runtime.ts).
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';

import { createA2AApp } from '../lib/a2a/app.ts';
import type { A2AApp } from '../lib/a2a/app.ts';
import { validTraceparent } from '../lib/observability/tracer.ts';
import type { TaskRecord } from '../lib/observability/metrics.ts';
import { ScriptedLlm, text } from './helpers/scriptedLlm.ts';
import { forEachRuntime } from './helpers/runtime.ts';

setLogLevel(LogLevel.ERROR);

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const dir = mkdtempSync(join(tmpdir(), 'melch-trace-'));
writeFileSync(join(dir, 'echo.yaml'), ['syndicate_name: Echo', 'orchestrator:', '  name: Echo', '  model: scripted/echo', '  instruction: Echo.', 'subagents: []'].join('\n'));
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

const records: TaskRecord[] = [];
let built: A2AApp;
let server: Server;
let base = '';

before(async () => {
  built = await createA2AApp({
    defaultSyndicate: 'echo.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InMemorySessionService() },
    onTaskEnd: (r) => records.push(r),
    resolveModel: () => new ScriptedLlm('scripted/echo', () => text('ok')),
    log: () => {},
    warn: () => {},
  });
  server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(async () => {
  server?.close();
  await built.shutdown(0);
});

async function send(extra: Record<string, string> = {}) {
  const res = await fetch(`${base}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'hi' }] } } }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  await new Promise((r) => setTimeout(r, 30));
  return body.result?.id as string;
}

test('validTraceparent accepts W3C version 00 and refuses anything else', () => {
  assert.equal(validTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.equal(validTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), undefined, 'an all-zero trace id is invalid');
  assert.equal(validTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), undefined);
  assert.equal(validTraceparent('garbage'), undefined);
  assert.equal(validTraceparent(undefined), undefined);
});

forEachRuntime("a caller's traceparent is linked, never adopted: the turn keeps a trace id of its own", async () => {
  records.length = 0;
  const taskId = await send({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
  const r = records.at(-1)!;
  assert.equal(r.callerTraceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.match(r.traceId ?? '', /^[0-9a-f]{32}$/);
  assert.notEqual(r.traceId, r.callerTraceId, 'a caller cannot choose the id the ledger and erasure key on');
  assert.equal(r.taskId, taskId);
});

forEachRuntime('two requests naming the same traceparent still get two distinct trace ids', async () => {
  records.length = 0;
  const tp = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
  await Promise.all([send({ traceparent: tp }), send({ traceparent: tp })]);
  const ids = records.map((r) => r.traceId);
  assert.equal(new Set(ids).size, 2, `distinct: ${ids.join(', ')}`);
});

forEachRuntime('without a traceparent (or with a malformed one) the task still gets its own trace id', async () => {
  records.length = 0;
  await send({ traceparent: 'not-a-trace' });
  const r = records.at(-1)!;
  assert.match(r.traceId ?? '', /^[0-9a-f]{32}$/);
  assert.equal(r.callerTraceId, undefined, 'a malformed traceparent is ignored');
  assert.ok(r.taskId);
});
