/**
 * tests/questionsA2a.test.ts — a pause over A2A: an `ask_user` call ends the
 * task input-required with an `input_request` data part, and the caller's next
 * message on the same conversation is the answer. Scripted models, ephemeral
 * port.
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
import { ScriptedLlm, call, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)

const dir = mkdtempSync(join(tmpdir(), 'melch-ask-'));
writeFileSync(
  join(dir, 'desk.yaml'),
  ['syndicate_name: Desk', 'orchestrator:', '  name: Boss', '  model: scripted/boss', '  instruction: Help.', '  tools: [ask_user]', 'subagents: []'].join('\n'),
);
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

let server: Server;
let base = '';
before(async () => {
  const built = await createA2AApp({
    defaultSyndicate: 'desk.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InMemorySessionService() },
    keyMode: 'byok',
    resolveModel: () =>
      new ScriptedLlm('scripted/boss', (req) => {
        const last = req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response;
        return last ? text(`paying from ${last.result}`) : call('ask_user', { question: 'Which account?', options: ['personal', 'work'] });
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
  const res = await fetch(`${base}/desk/a2a/jsonrpc`, {
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
const data = (task: any) => (task.status?.message?.parts ?? []).find((p: any) => p.kind === 'data')?.data;

test('ask_user ends the task input-required with the question; the next message answers it', async () => {
  const first = await send([{ kind: 'text', text: 'pay the invoice' }]);
  assert.equal(first.status.state, 'input-required');
  assert.match(statusText(first), /Input needed: Boss asks: Which account\? \(personal \/ work\)/);
  const request = data(first);
  assert.equal(request.type, 'input_request');
  assert.equal(request.node, 'Boss');
  assert.equal(request.message, 'Which account?');
  assert.deepEqual(request.payload, { options: ['personal', 'work'] });
  assert.ok(request.interrupt_id);

  const done = await send([{ kind: 'text', text: 'work' }], { contextId: first.contextId, taskId: first.id });
  assert.equal(done.status.state, 'completed', statusText(done));
  assert.match(statusText(done), /paying from work/);
});
