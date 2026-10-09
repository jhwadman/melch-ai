/**
 * tests/a2aCancel.test.ts — progress and cancellation of a running A2A task
 * (ADR 0113), over HTTP on an ephemeral port with scripted models and
 * in-memory persistence. No provider calls.
 *
 * Pins: a multi-step run streamed over message/stream publishes `working`
 * status updates (`[STATUS]` progress) before its final status; tasks/cancel
 * on the instance running the task stops it in flight, ends it `canceled`,
 * and no model is called after; and a cancel recorded through another
 * instance (the leases' `cancelRequested`) reaches the run on the lease
 * heartbeat. The SQL side is in tests/a2aCancelPostgres.test.ts.
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

import { createA2AApp } from '../lib/a2a/app.ts';
import type { A2AApp } from '../lib/a2a/app.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { ScriptedLlm, call, hangUntilAborted, text } from './helpers/scriptedLlm.ts';

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const dir = mkdtempSync(join(tmpdir(), 'melch-cancel-'));
const syndicate = (name: string, lead: string, helper: string) =>
  [
    `syndicate_name: ${name}`,
    'orchestrator:',
    `  name: ${name}`,
    `  model: scripted/${lead}`,
    '  instruction: Delegate, then answer.',
    'subagents:',
    '  - name: Helper',
    '    description: Looks things up.',
    `    model: scripted/${helper}`,
    '    instruction: Help.',
  ].join('\n');
writeFileSync(join(dir, 'steps.yaml'), syndicate('Steps', 'lead', 'helper'));
writeFileSync(join(dir, 'stuck.yaml'), syndicate('Stuck', 'stucklead', 'stuckhelper'));
writeFileSync(join(dir, 'slow.yaml'), ['syndicate_name: Slow', 'orchestrator:', '  name: Slow', '  model: scripted/slow', '  instruction: Hang.', 'subagents: []'].join('\n'));
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

// Model calls per scripted model, across every instance a resolver built.
const calls: Record<string, number> = {};
const count = (key: string) => {
  calls[key] = (calls[key] ?? 0) + 1;
};
const models: Record<string, () => ScriptedLlm> = {
  // Two steps: delegate to the helper, then answer.
  lead: () =>
    new ScriptedLlm('scripted/lead', (_req, n) => {
      count('lead');
      return n === 1 ? call('Helper', { request: 'look it up' }) : text('Done after the helper.');
    }),
  helper: () => new ScriptedLlm('scripted/helper', () => (count('helper'), text('helper result'))),
  // Delegates, and the helper hangs until the run is aborted.
  stucklead: () =>
    new ScriptedLlm('scripted/stucklead', (_req, n) => {
      count('stucklead');
      return n === 1 ? call('Helper', { request: 'take forever' }) : text('should never be asked');
    }),
  stuckhelper: () =>
    new ScriptedLlm('scripted/stuckhelper', (_req, _n, signal) => {
      count('stuckhelper');
      return hangUntilAborted(signal);
    }),
  slow: () =>
    new ScriptedLlm('scripted/slow', (_req, _n, signal) => {
      count('slow');
      return hangUntilAborted(signal);
    }),
};

// What the heartbeat's cancelRequested returns: ids another instance recorded.
let requestedElsewhere: string[] = [];

let built: A2AApp;
let server: Server;
let base = '';

before(async () => {
  built = await createA2AApp({
    defaultSyndicate: 'steps.yaml',
    serverSecret: SECRET,
    storage: {
      sessionService: new InProcessSessionService(),
      // Heartbeat every second (a third of the lease, floored at 1 s).
      leases: { ttlMs: 3000, renew: async () => 0, reap: async () => 0, cancelRequested: async () => requestedElsewhere },
    },
    keyMode: 'byok',
    resolveModel: (id) => models[(id ?? '').replace('scripted/', '')]!(),
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
  await built?.shutdown(0);
  server?.close();
});

const headers = { Authorization: `Bearer ${SECRET}`, 'X-API-Key': 'caller-key', 'Content-Type': 'application/json' };

function userMessage(question: string) {
  return { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: question }] } };
}

async function rpc(agent: string, method: string, params: unknown): Promise<any> {
  const res = await fetch(`${base}/${agent}/a2a/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return res.json();
}

/**
 * Opens message/stream and yields each result as it arrives. The SSE body is
 * split on newlines by indexOf, never by a pattern.
 */
async function* stream(agent: string, question: string): AsyncGenerator<any> {
  const res = await fetch(`${base}/${agent}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { ...headers, Accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream', params: userMessage(question) }),
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffered += decoder.decode(value, { stream: true });
    let nl = buffered.indexOf('\n');
    while (nl >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line.startsWith('data:')) {
        const result = JSON.parse(line.slice(5)).result;
        if (result) yield result;
      }
      nl = buffered.indexOf('\n');
    }
    if (done) return;
  }
}

const statusText = (r: any): string => (r?.status?.message?.parts ?? []).map((p: any) => p.text ?? '').join('');

test('a multi-step run streams working updates before its final status', async () => {
  const results: any[] = [];
  for await (const r of stream('steps', 'two steps please')) results.push(r);
  const updates = results.filter((r) => r.kind === 'status-update');
  const final = updates.at(-1);
  assert.equal(final.status.state, 'completed');
  assert.equal(statusText(final), 'Done after the helper.');
  const working = updates.slice(0, -1).filter((u) => u.status.state === 'working');
  assert.ok(working.length >= 1, 'at least one working update before the final status');
  assert.ok(
    working.some((u) => statusText(u).startsWith('[STATUS] ') && statusText(u).includes('Helper')),
    `a [STATUS] line names the step: ${JSON.stringify(working.map(statusText))}`,
  );
  assert.equal(calls.lead, 2);
  assert.equal(calls.helper, 1);
});

test('tasks/cancel on the running instance stops the run in flight: canceled, and no model call after', async () => {
  let taskId = '';
  let canceledWith: any;
  const seen: any[] = [];
  for await (const r of stream('stuck', 'this will hang')) {
    seen.push(r);
    if (r.kind === 'task') taskId = r.id;
    // The helper has been called and hangs: cancel now, mid-run.
    if (r.kind === 'status-update' && r.status.state === 'working' && !canceledWith) {
      while (!calls.stuckhelper) await new Promise((res) => setTimeout(res, 10));
      canceledWith = await rpc('stuck', 'tasks/cancel', { id: taskId });
    }
  }
  assert.ok(taskId, 'the stream opened with the task');
  assert.equal(canceledWith?.result?.status?.state, 'canceled', JSON.stringify(canceledWith));
  const final = seen.filter((r) => r.kind === 'status-update').at(-1);
  assert.equal(final.status.state, 'canceled');
  assert.equal(final.final ?? true, true);
  const stored = await rpc('stuck', 'tasks/get', { id: taskId });
  assert.equal(stored.result.status.state, 'canceled');
  // Let anything still scheduled run, then check nothing called a model.
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(calls.stucklead, 1, 'the lead is not asked again after the cancel');
  assert.equal(calls.stuckhelper, 1);
});

test('a cancel recorded through another instance reaches the run on the lease heartbeat', async () => {
  const sent = await rpc('slow', 'message/send', { ...userMessage('wait'), configuration: { blocking: false } });
  const taskId = sent.result.id as string;
  assert.ok(taskId);
  while (!calls.slow) await new Promise((res) => setTimeout(res, 10));
  // A single-step run publishes no progress line: it stays submitted until its final status.
  assert.ok(['submitted', 'working'].includes((await rpc('slow', 'tasks/get', { id: taskId })).result.status.state));
  requestedElsewhere = [taskId];
  try {
    const deadline = Date.now() + 4000;
    let state = '';
    while (Date.now() < deadline) {
      state = (await rpc('slow', 'tasks/get', { id: taskId })).result.status.state;
      if (state === 'canceled') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(state, 'canceled', 'the heartbeat aborted the run and it ended canceled');
    assert.equal(calls.slow, 1);
  } finally {
    requestedElsewhere = [];
  }
});
