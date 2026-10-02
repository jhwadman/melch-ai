/**
 * tests/approvalsA2a.test.ts — approval gates over A2A (ADR 0028): the task
 * ends input-required with the pending call, and the caller's answer on the
 * same conversation runs or refuses it. Scripted models, ephemeral port.
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
import { FunctionTool, InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import { z } from 'zod';

import { createA2AApp } from '../lib/a2a/app.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { ScriptedLlm, call, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const sent: string[] = [];
registerTool(
  'a2a_approval_send',
  new FunctionTool({
    name: 'a2a_approval_send',
    description: 'Send.',
    parameters: z.object({ to: z.string() }),
    execute: async ({ to }) => (sent.push(to), `sent to ${to}`),
  }),
  { override: true },
);

const dir = mkdtempSync(join(tmpdir(), 'melch-approve-'));
writeFileSync(
  join(dir, 'mailer.yaml'),
  [
    'syndicate_name: Mailer',
    'orchestrator:',
    '  name: Boss',
    '  model: scripted/boss',
    '  instruction: Send.',
    '  tools: [a2a_approval_send]',
    '  require_approval: [a2a_approval_send]',
    'subagents: []',
  ].join('\n'),
);
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

let server: Server;
let base = '';
before(async () => {
  const built = await createA2AApp({
    defaultSyndicate: 'mailer.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InMemorySessionService() },
    keyMode: 'byok',
    // A fresh script per resolution: each turn compiles its own model.
    resolveModel: () =>
      new ScriptedLlm('scripted/boss', (req, n) => {
        const last = req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response;
        return n === 1 && !last ? call('a2a_approval_send', { to: 'ops@acme.test' }) : text(`result ${JSON.stringify(last ?? null)}`);
      }),
    log: () => {},
    warn: () => {},
  });
  server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(() => server?.close());

async function send(parts: unknown[], ids: { contextId?: string; taskId?: string } = {}): Promise<any> {
  const res = await fetch(`${base}/mailer/a2a/jsonrpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'X-API-Key': 'caller-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts, ...ids } },
    }),
  });
  const body = (await res.json()) as any;
  assert.ok(body.result, JSON.stringify(body.error ?? body));
  return body.result;
}

const statusText = (task: any) => (task.status?.message?.parts ?? []).map((p: any) => p.text ?? '').join('');
const approvalData = (task: any) => (task.status?.message?.parts ?? []).find((p: any) => p.kind === 'data')?.data;

test('the task ends input-required with the call; "approve" on the conversation runs it', async () => {
  sent.length = 0;
  const first = await send([{ kind: 'text', text: 'tell ops' }]);
  assert.equal(first.status.state, 'input-required');
  assert.match(statusText(first), /Approval needed: Boss wants to run a2a_approval_send\(\{"to":"ops@acme.test"\}\)/);
  const data = approvalData(first);
  assert.equal(data.type, 'approval_request');
  assert.deepEqual(data.args, { to: 'ops@acme.test' });
  assert.deepEqual(sent, []);

  // Anything but an answer repeats the request.
  const again = await send([{ kind: 'text', text: 'hm?' }], { contextId: first.contextId, taskId: first.id });
  assert.equal(again.status.state, 'input-required');
  assert.equal(approvalData(again).approval_id, data.approval_id);
  assert.deepEqual(sent, []);

  const done = await send([{ kind: 'text', text: 'approve' }], { contextId: first.contextId, taskId: first.id });
  assert.equal(done.status.state, 'completed', statusText(done));
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.match(statusText(done), /sent to ops@acme.test/);
});

test('a data-part refusal never runs the call', async () => {
  sent.length = 0;
  const first = await send([{ kind: 'text', text: 'tell ops' }]);
  const id = approvalData(first).approval_id;
  const done = await send([{ kind: 'data', data: { approval: { id, approved: false } } }], { contextId: first.contextId });
  assert.equal(done.status.state, 'completed', statusText(done));
  assert.deepEqual(sent, []);
  assert.match(statusText(done), /rejected/);
});
