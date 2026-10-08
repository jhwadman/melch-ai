/**
 * tests/questionsA2a.test.ts — a pause over A2A: an `ask_user` call ends the
 * task input-required with an `input_request` data part, and the caller's next
 * message on the same conversation is the answer. The conversation runs on
 * ADK, on native (MELCHIZEDEK_RUNTIME, WS2-7b), and with the runtime switched
 * between the question and the answer: the task, its data part and the
 * stored events match. Scripted models, ephemeral port.
 *
 * The all-ADK conversation the others are held to is recorded
 * (tests/fixtures/adk-reference/questionsa2a, tests/helpers/adkReference.ts)
 * and runs live only under ADK_REFERENCE=live|record. The first case, and a
 * conversation with a turn on ADK, are the adk runtime's own behaviour and
 * still run ADK.
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
import { adkShim } from '../lib/models/adkShim.ts';
import { ScriptedModel, answer, lastToolResult, toolCall } from './helpers/scriptedModel.ts';
import { withRuntimeEnv } from './helpers/runtime.ts';
import type { RuntimeName } from './helpers/runtime.ts';
import { adkReferences } from './helpers/adkReference.ts';

const reference = adkReferences('questionsA2a');
// Every case here still runs a turn on ADK (the adk runtime's own behaviour), on ADK's own in-memory store.
const { InMemorySessionService, LogLevel, setLogLevel } = await import('@google/adk');
setLogLevel(LogLevel.ERROR);

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)

const dir = mkdtempSync(join(tmpdir(), 'melch-ask-'));
writeFileSync(
  join(dir, 'desk.yaml'),
  ['syndicate_name: Desk', 'orchestrator:', '  name: Boss', '  model: scripted/boss', '  instruction: Help.', '  tools: [ask_user]', 'subagents: []'].join('\n'),
);
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

/** The store, remembering each conversation's keys so a test can read its stored events. */
class RecordingSessions extends InMemorySessionService {
  readonly keys = new Map<string, { appName: string; userId: string }>();
  override async createSession(req: Parameters<InstanceType<typeof InMemorySessionService>['createSession']>[0]) {
    const session = await super.createSession(req);
    this.keys.set(session.id, { appName: req.appName, userId: req.userId });
    return session;
  }
}
const sessions = new RecordingSessions();
const boss = new ScriptedModel('scripted/boss', (req) => {
  const last = lastToolResult(req);
  return last ? answer(`paying from ${last.result}`) : toolCall('ask_user', { question: 'Which account?', options: ['personal', 'work'] }, 'call-ask');
});

let server: Server;
let base = '';
before(async () => {
  const built = await createA2AApp({
    defaultSyndicate: 'desk.yaml',
    serverSecret: SECRET,
    storage: { sessionService: sessions },
    keyMode: 'byok',
    resolveModel: () => adkShim(boss),
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

/** The two messages, each on its runtime (MELCHIZEDEK_RUNTIME, put back after): what the caller saw, and what the store holds. */
async function askAndAnswer(asks: RuntimeName, answers: RuntimeName) {
  const first = await withRuntimeEnv(asks, () => send([{ kind: 'text', text: 'pay the invoice' }]));
  const done = await withRuntimeEnv(answers, () => send([{ kind: 'text', text: 'work' }], { contextId: first.contextId, taskId: first.id }));
  const keys = sessions.keys.get(first.contextId);
  assert.ok(keys, 'the conversation has a session');
  const stored = await sessions.getSession({ ...keys, sessionId: first.contextId });
  return { first, done, events: JSON.parse(JSON.stringify(stored?.events ?? [])) as any[] };
}

/** What the caller reads, ids aside. */
const surface = (task: any) =>
  JSON.parse(JSON.stringify({ state: task.status.state, text: statusText(task), data: data(task) ? { ...data(task), interrupt_id: '<id>' } : undefined }));
const comparable = (events: any[]): unknown => events.map((e) => ({ ...e, id: '<id>', timestamp: 0, invocationId: '<inv>' }));

test('ask_user ends the task input-required with the question; the next message answers it', async () => {
  const { first, done } = await askAndAnswer('adk', 'adk');
  assert.equal(first.status.state, 'input-required');
  assert.match(statusText(first), /Input needed: Boss asks: Which account\? \(personal \/ work\)/);
  const request = data(first);
  assert.equal(request.type, 'input_request');
  assert.equal(request.node, 'Boss');
  assert.equal(request.message, 'Which account?');
  assert.deepEqual(request.payload, { options: ['personal', 'work'] });
  assert.ok(request.interrupt_id);

  assert.equal(done.status.state, 'completed', statusText(done));
  assert.match(statusText(done), /paying from work/);
});

test('on native, and across runtimes, the task and the stored events are the same as on ADK', async () => {
  // The reference: the conversation all on ADK, recorded as the caller saw it and as the store holds it.
  const adk = await reference('ask-and-answer-on-adk', async () => {
    const run = await askAndAnswer('adk', 'adk');
    return { first: surface(run.first), done: surface(run.done), events: run.events };
  });
  assert.ok(adk.events.some((e) => e.content?.parts?.[0]?.functionResponse?.name === 'ask_user'), 'the answer is stored as the call\'s response');
  for (const [asks, answers] of [['native', 'native'], ['adk', 'native'], ['native', 'adk']] as const) {
    const run = await askAndAnswer(asks, answers);
    assert.deepEqual(surface(run.first), adk.first, `${asks} → ${answers}: the question`);
    assert.equal(data(run.first).interrupt_id, 'call-ask');
    assert.deepEqual(surface(run.done), adk.done, `${asks} → ${answers}: the answer`);
    assert.deepEqual(comparable(run.events), comparable(adk.events), `${asks} → ${answers}: the stored events`);
  }
});
