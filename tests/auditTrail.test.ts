/**
 * tests/auditTrail.test.ts — the A2A server's audit trail (ADR 0042): a failed
 * authentication, a task's outcome and an erasure each leave one event with
 * the caller, the source address and a scope HASH, never the scope key or
 * any conversation content. Offline: a scripted model, a stub storage.
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
import { postgresAuditSink, scopeHashOf } from '../lib/observability/audit.ts';
import type { AuditEvent } from '../lib/observability/audit.ts';
import { ScriptedLlm, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const dir = mkdtempSync(join(tmpdir(), 'melch-audit-'));
writeFileSync(join(dir, 'echo.yaml'), ['syndicate_name: Echo', 'orchestrator:', '  name: Echo', '  model: scripted/echo', '  instruction: Echo.', 'subagents: []'].join('\n'));
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

const events: AuditEvent[] = [];
let built: A2AApp;
let server: Server;
let base = '';

before(async () => {
  built = await createA2AApp({
    defaultSyndicate: 'echo.yaml',
    serverSecret: SECRET,
    storage: {
      sessionService: new InMemorySessionService(),
      erase: async () => ({ memory_facts: 2, sessions: 1, turns: 3, spans: 0, payloads: 0, verdicts: 0, labels: 0, tasks: 1, memory_markers: 1, task_tools: 0 }),
    },
    audit: (e) => events.push(e),
    resolveModel: () => new ScriptedLlm('scripted/echo', () => text('the secret recipe is basil')),
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

const headers = { Authorization: `Bearer ${SECRET}`, 'X-User-Id': 'alice.smith', 'Content-Type': 'application/json' };

test('a failed authentication is recorded as denied, with the source address', async () => {
  events.length = 0;
  const res = await fetch(`${base}/.well-known/agent-card.json`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(res.status, 401);
  const e = events.find((x) => x.event === 'auth.failure');
  assert.ok(e, 'an auth.failure event');
  assert.equal(e.outcome, 'denied');
  assert.match(e.sourceIp ?? '', /127\.0\.0\.1/);
  assert.equal(e.detail?.path, '/.well-known/agent-card.json');
});

test("a task's outcome is recorded with the caller and a scope hash, and no content", async () => {
  events.length = 0;
  const res = await fetch(`${base}/a2a/jsonrpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'what is the secret recipe?' }] } } }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const e = events.find((x) => x.event === 'task.end');
  assert.ok(e, 'a task.end event');
  assert.equal(e.outcome, 'completed');
  assert.equal(e.caller, 'shared-secret');
  assert.equal(e.scopeHash, scopeHashOf('alice.smith'));
  assert.ok(e.taskId);
  const serialized = JSON.stringify(e);
  assert.doesNotMatch(serialized, /alice\.smith|recipe|basil/, 'no scope key and no conversation content');
});

test('an erasure is recorded with its counts and a scope hash', async () => {
  events.length = 0;
  const res = await fetch(`${base}/memory`, { method: 'DELETE', headers });
  assert.equal(res.status, 200);
  const e = events.find((x) => x.event === 'memory.erase');
  assert.ok(e, 'a memory.erase event');
  assert.deepEqual([e.outcome, e.scopeHash, (e.detail?.deleted as any)?.turns], ['ok', scopeHashOf('alice.smith'), 3]);
  assert.doesNotMatch(JSON.stringify(e), /alice\.smith/);
});

test('the Postgres sink inserts one row per event, and a failed write falls back to stderr once-logged', async () => {
  const rows: unknown[][] = [];
  let fail = false;
  const pool = { query: async (_sql: string, params: unknown[]) => { if (fail) throw new Error('db down'); rows.push(params); return { rows: [] }; } };
  const warnings: string[] = [];
  const sink = postgresAuditSink(pool as any, (m) => warnings.push(m));
  sink({ event: 'auth.failure', outcome: 'denied', sourceIp: '10.0.0.1', detail: { path: '/x' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.slice(0, 5), ['auth.failure', 'denied', null, null, '10.0.0.1']);
  fail = true;
  const err = console.error;
  const spilled: string[] = [];
  console.error = (m: string) => spilled.push(m);
  try {
    sink({ event: 'task.end', outcome: 'failed' });
    sink({ event: 'task.end', outcome: 'failed' });
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.error = err;
  }
  assert.equal(warnings.filter((w) => /could not write/.test(w)).length, 1, 'logged once per outage');
  assert.equal(spilled.length, 2, 'every event still reaches stderr');
});
