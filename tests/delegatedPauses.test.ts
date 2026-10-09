/**
 * tests/delegatedPauses.test.ts — a pause inside a delegated subagent
 * reaches the turn (WS6-2a, ADR 0110): an approval request or an ask_user
 * question raised in a child loop ends the turn input-required with the
 * agent path in the pending record; the answer goes back down into the
 * child, the child finishes, and the caller continues. One level and two
 * levels deep (a nested syndicate), two pauses in one step, the schema and
 * the A2A surface. Skill scripts and OAuth consent in a child are
 * tests/delegatedScriptsConsent.test.ts (ADR 0118). Scripted models, in-memory sessions, no network.
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
import { z } from 'zod';

import { createA2AApp } from '../lib/a2a/app.ts';
import type { FinalModelResponse, ModelRequest } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { delegatedPauses } from '../lib/runtime/native/interrupts.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { MessagePart, SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { APPROVAL_TEXTS } from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

const sent: string[] = [];
registerTool(
  'dp_send',
  defineTool({
    name: 'dp_send',
    description: 'Send a note.',
    schema: z.object({ to: z.string() }),
    execute: async ({ to }) => (sent.push(to), `sent to ${to}`),
  }),
  { override: true },
);

const result = (req: ModelRequest): string | undefined => {
  const r = lastToolResult(req);
  return r ? JSON.stringify(r.result) : undefined;
};

/** Calls `name` with `args` the first time; once a tool result is in the history, answers with it under `label`. */
const delegating =
  (label: string, name: string, args: Record<string, unknown>, id: string): ModelScript =>
  (req) => {
    const r = result(req);
    return r === undefined ? toolCall(name, args, id) : answer(`${label}: ${r}`);
  };

const gatedScout = (extra: Record<string, unknown> = {}) => ({
  name: 'Scout',
  model: 'scripted/scout',
  instruction: 'Send it.',
  description: 'Sends notes',
  tools: ['dp_send'],
  require_approval: ['dp_send'],
  ...extra,
});

const config = (raw: Record<string, unknown>): SyndicateYamlConfig => validateSyndicateConfig(raw, 'delegated-pauses') as SyndicateYamlConfig;

const oneLevel = () =>
  config({ syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout.' }, subagents: [gatedScout()] });

/** One conversation: each message a turn, one store, fresh models. */
async function converse(cfg: SyndicateYamlConfig, scripts: Record<string, ModelScript>, nested: Record<string, SyndicateYamlConfig> = {}) {
  resetCircuits();
  sent.length = 0;
  const models = Object.fromEntries(Object.entries(scripts).map(([k, s]) => [k, new ScriptedModel(`scripted/${k}`, s)]));
  const sessionService = new InProcessSessionService();
  const turn = (parts: MessagePart[]): Promise<SyndicateTurnResult> =>
    runSyndicateTurn({
      config: cfg,
      parts,
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      sessionService,
      compile: {
        resolveModel: shimResolver(models),
        log: () => {},
        loadNested: (ref) => {
          const n = nested[ref];
          if (!n) throw new Error(`no nested syndicate ${ref}`);
          return n;
        },
      },
      trace: false,
    });
  const events = async (appName: string) => (await sessionService.get({ appName, userId: 'u', sessionId: 's' }))?.events ?? [];
  return { turn, models, sessionService, events };
}

const callNames = (events: Array<{ content?: { parts?: Array<{ functionCall?: { name?: string } }> } }>) =>
  events.flatMap((e) => (e.content?.parts ?? []).flatMap((p) => (p.functionCall?.name ? [p.functionCall.name] : [])));

test('approve in a child: the turn pauses with the path, the answer runs the pinned call in the child, then the caller continues', async () => {
  const c = await converse(oneLevel(), {
    boss: delegating('Boss', 'Scout', { request: 'tell ops' }, 'call-scout-1'),
    scout: delegating('Scout', 'dp_send', { to: 'ops@acme.test' }, 'call-send-1'),
  });
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.equal(first.approval?.agent, 'Scout');
  assert.equal(first.approval?.tool, 'dp_send');
  assert.deepEqual(first.approval?.args, { to: 'ops@acme.test' });
  assert.equal(first.approval?.callId, 'call-send-1');
  assert.deepEqual(first.approval?.path, ['Boss', 'Scout']);
  assert.match(first.text, /^Approval needed: Scout wants to run dp_send/);
  assert.deepEqual(sent, [], 'nothing ran before the decision');
  // The request lives in the child's session, in the shape the engine always stored; the caller's holds the open call.
  assert.deepEqual(callNames(await c.events('app/Boss/Scout')), ['dp_send', 'adk_request_confirmation']);
  assert.deepEqual(callNames(await c.events('app')), ['Scout']);

  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test'], 'the pinned call ran once');
  assert.equal(second.text, 'Boss: "Scout: \\"sent to ops@acme.test\\""');
  assert.equal(c.models.boss!.calls, 2, 'the caller resumed its own loop: one step before the pause, one after');
  assert.equal(c.models.scout!.calls, 2);
  // The caller's next request pairs the call with the child's answer; the answer message it stored is not in it.
  const resumed = c.models.boss!.requests[1]!;
  assert.equal(resumed.messages.filter((m) => m.role === 'tool').length, 1);
  assert.equal(result(resumed), '"Scout: \\"sent to ops@acme.test\\""');

  const third = await c.turn([{ text: 'thanks' }]);
  assert.equal(third.status, 'completed', third.error?.message);
  assert.deepEqual(sent, ['ops@acme.test'], 'a later turn never runs the call again');
});

test('reject in a child: the pinned call never runs, the child reads the refusal, and the caller continues', async () => {
  const c = await converse(oneLevel(), {
    boss: delegating('Boss', 'Scout', { request: 'tell ops' }, 'call-scout-1'),
    scout: delegating('Scout', 'dp_send', { to: 'ops@acme.test' }, 'call-send-1'),
  });
  const first = await c.turn([{ text: 'tell ops' }]);
  const second = await c.turn([approvalResponsePart(first.approval!.id, false) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, []);
  assert.equal(result(c.models.scout!.requests[1]!), JSON.stringify(APPROVAL_TEXTS.rejected));
  assert.match(second.text, /^Boss: "Scout: /);
});

test('a decision naming another id is refused, and the request stays open', async () => {
  const c = await converse(oneLevel(), {
    boss: delegating('Boss', 'Scout', { request: 'tell ops' }, 'call-scout-1'),
    scout: delegating('Scout', 'dp_send', { to: 'ops@acme.test' }, 'call-send-1'),
  });
  const first = await c.turn([{ text: 'tell ops' }]);
  const wrong = await c.turn([approvalResponsePart('adk-not-this-one', true) as MessagePart]);
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.error?.code, 'NO_PENDING_APPROVAL');
  assert.deepEqual(sent, []);
  const right = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(right.status, 'completed', right.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);
});

test('ask_user in a child: the turn asks with the path, and the next message is the child call’s answer', async () => {
  const cfg = config({
    syndicate_name: 'Desk',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout.' },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Ask.', description: 'Asks', tools: ['ask_user'] }],
  });
  const c = await converse(cfg, {
    boss: delegating('Boss', 'Scout', { request: 'which account?' }, 'call-scout-1'),
    scout: delegating('Scout', 'ask_user', { question: 'Which account?', options: ['personal', 'work'] }, 'call-ask-1'),
  });
  const first = await c.turn([{ text: 'pay the invoice' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.equal(first.input?.node, 'Scout');
  assert.equal(first.input?.id, 'call-ask-1');
  assert.equal(first.input?.message, 'Which account?');
  assert.deepEqual(first.input?.payload, { options: ['personal', 'work'] });
  assert.deepEqual(first.input?.path, ['Boss', 'Scout']);
  assert.equal(first.text, 'Which account?');

  const second = await c.turn([{ text: 'work' }]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(result(c.models.scout!.requests[1]!), '"work"', 'the child reads the answer as its question’s result');
  assert.equal(second.text, 'Boss: "Scout: \\"work\\""');
  assert.equal(c.models.boss!.calls, 2);
  // The answer message stored in the caller's session answers no call of the caller's: its history leaves it out.
  assert.equal(c.models.boss!.requests[1]!.messages.filter((m) => m.role === 'tool').length, 1);
  assert.ok(!JSON.stringify(c.models.boss!.requests[1]!.messages).includes('call-ask-1'));
});

test('a new message instead of an answer moves on: the open call is abandoned and nothing below it runs', async () => {
  const c = await converse(oneLevel(), {
    boss: (req, n) => (n === 1 ? toolCall('Scout', { request: 'tell ops' }, 'call-scout-1') : answer(`moved on (${result(req) ?? 'no result'})`)),
    scout: delegating('Scout', 'dp_send', { to: 'ops@acme.test' }, 'call-send-1'),
  });
  await c.turn([{ text: 'tell ops' }]);
  const moved = await c.turn([{ text: 'never mind, what time is it?' }]);
  assert.equal(moved.status, 'completed', moved.error?.message);
  assert.deepEqual(sent, []);
  assert.deepEqual(await delegatedPauses({ sessions: c.sessionService, userId: 'u', sessionId: 's' }, await c.events('app')), []);
});

test('two levels deep: a gate in a nested syndicate’s subagent pauses the turn, and the answer travels down and back up', async () => {
  const team = config({ syndicate_name: 'Team', orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Ask Scout.' }, subagents: [gatedScout()] });
  const top = config({
    syndicate_name: 'Top',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Ask the team.' },
    subagents: [{ name: 'Team', description: 'A team that sends notes', yaml_reference: 'team.yaml' }],
  });
  const c = await converse(
    top,
    {
      boss: delegating('Boss', 'Team', { request: 'tell ops' }, 'call-team-1'),
      lead: delegating('Lead', 'Scout', { request: 'tell ops, please' }, 'call-scout-1'),
      scout: delegating('Scout', 'dp_send', { to: 'ops@acme.test' }, 'call-send-1'),
    },
    { 'team.yaml': team },
  );
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.deepEqual(first.approval?.path, ['Boss', 'Team', 'Scout']);
  assert.equal(first.approval?.agent, 'Scout');
  assert.deepEqual(callNames(await c.events('app')), ['Team']);
  assert.deepEqual(callNames(await c.events('app/Boss/Team')), ['Scout']);

  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(second.text, 'Boss: "Lead: \\"Scout: \\\\\\"sent to ops@acme.test\\\\\\"\\""');
  assert.deepEqual([c.models.boss!.calls, c.models.lead!.calls, c.models.scout!.calls], [2, 2, 2]);
});

test('two levels deep: a question asked two levels down is answered by the next message', async () => {
  const team = config({
    syndicate_name: 'Team',
    orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Ask Scout.' },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Ask.', description: 'Asks', tools: ['ask_user'] }],
  });
  const top = config({
    syndicate_name: 'Top',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Ask the team.' },
    subagents: [{ name: 'Team', description: 'A team', yaml_reference: 'team.yaml' }],
  });
  const c = await converse(
    top,
    {
      boss: delegating('Boss', 'Team', { request: 'which?' }, 'call-team-1'),
      lead: delegating('Lead', 'Scout', { request: 'which?' }, 'call-scout-1'),
      scout: delegating('Scout', 'ask_user', { question: 'Which one?' }, 'call-ask-1'),
    },
    { 'team.yaml': team },
  );
  const first = await c.turn([{ text: 'pick one' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.deepEqual(first.input?.path, ['Boss', 'Team', 'Scout']);
  const second = await c.turn([{ text: 'the blue one' }]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(result(c.models.scout!.requests[1]!), '"the blue one"');
});

test('two subagents pause in one step: each request is raised in turn, and the caller steps once both are decided', async () => {
  const both = (): FinalModelResponse => ({
    partial: false,
    parts: [
      { type: 'toolCall', id: 'call-a', name: 'ScoutA', args: { request: 'tell a' } },
      { type: 'toolCall', id: 'call-b', name: 'ScoutB', args: { request: 'tell b' } },
    ],
    finishReason: 'tool_call',
  });
  const cfg = config({
    syndicate_name: 'Desk',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate.' },
    subagents: [gatedScout({ name: 'ScoutA', model: 'scripted/a' }), gatedScout({ name: 'ScoutB', model: 'scripted/b' })],
  });
  const c = await converse(cfg, {
    boss: (req) => (lastToolResult(req) ? answer(`done (${req.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts).length} results)`) : both()),
    a: delegating('A', 'dp_send', { to: 'a@acme.test' }, 'call-send-a'),
    b: delegating('B', 'dp_send', { to: 'b@acme.test' }, 'call-send-b'),
  });
  const first = await c.turn([{ text: 'tell both' }]);
  assert.equal(first.status, 'input-required');
  assert.deepEqual(first.approval?.path, ['Boss', 'ScoutA']);
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'input-required', second.error?.message);
  assert.deepEqual(second.approval?.path, ['Boss', 'ScoutB']);
  assert.deepEqual(sent, ['a@acme.test']);
  assert.equal(c.models.boss!.calls, 1, 'the caller does not step while a call still waits');
  const third = await c.turn([approvalResponsePart(second.approval!.id, true) as MessagePart]);
  assert.equal(third.status, 'completed', third.error?.message);
  assert.deepEqual(sent, ['a@acme.test', 'b@acme.test']);
  assert.equal(third.text, 'done (2 results)');
});

test('the schema: a delegated subagent may gate, ask, and run skill scripts (ADR 0118)', () => {
  assert.doesNotThrow(() => oneLevel());
  assert.doesNotThrow(() => config({ syndicate_name: 'D', orchestrator: { name: 'B', model: 'm', instruction: 'i' }, subagents: [gatedScout({ skills: { dir: 'skills', scripts: 'local' } })] }));
});

test('a dispatch route that delegates: a gate in the route’s subagent pauses the turn, and the decision resumes that route without classifying', async () => {
  const team = config({ syndicate_name: 'Team', orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Ask Scout.' }, subagents: [gatedScout()] });
  const top = config({
    syndicate_name: 'Front',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      { name: 'Team', description: 'sends notes', yaml_reference: 'team.yaml' },
    ],
    dispatch: { default_route: 'Chat' },
  });
  const c = await converse(
    top,
    {
      router: () => answer('{"route":"Team","reason":"a note"}'),
      chat: () => answer('chat'),
      lead: delegating('Lead', 'Scout', { request: 'tell ops' }, 'call-scout-1'),
      scout: delegating('Scout', 'dp_send', { to: 'ops@acme.test' }, 'call-send-1'),
    },
    { 'team.yaml': team },
  );
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.deepEqual(first.approval?.path, ['Team', 'Scout']);
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(second.route?.decidedBy, 'approval');
  assert.equal(c.models.router!.calls, 1, 'the classifier ran once, for the original message');
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(second.text, 'Lead: "Scout: \\"sent to ops@acme.test\\""');
});

// ── Over A2A ─────────────────────────────────────────────────────────────────

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
let server: Server | undefined;
after(() => server?.close());

test('over A2A: input-required with the same data part plus the path; "approve" resumes the child and completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-delegated-'));
  writeFileSync(
    join(dir, 'desk.yaml'),
    [
      'syndicate_name: Desk',
      'orchestrator:',
      '  name: Boss',
      '  model: scripted/boss',
      '  instruction: Delegate to Scout.',
      'subagents:',
      '  - name: Scout',
      '    model: scripted/scout',
      '    description: Sends notes',
      '    instruction: Send it.',
      '    tools: [dp_send]',
      '    require_approval: [dp_send]',
    ].join('\n'),
  );
  process.env.MELCHIZEDEK_AGENTS_DIR = dir;
  sent.length = 0;
  const scripts: Record<string, ModelScript> = {
    boss: delegating('Boss', 'Scout', { request: 'tell ops' }, 'call-scout-1'),
    scout: delegating('Scout', 'dp_send', { to: 'ops@acme.test' }, 'call-send-1'),
  };
  const built = await createA2AApp({
    defaultSyndicate: 'desk.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InProcessSessionService() },
    keyMode: 'byok',
    // A fresh model per resolution, answering from the request alone.
    resolveModel: (id?: string) => {
      const key = (id ?? '').replace(/^scripted\//, '');
      return shimResolver({ [key]: new ScriptedModel(`scripted/${key}`, scripts[key]!) })(id);
    },
    log: () => {},
    warn: () => {},
  });
  const listening = await new Promise<Server>((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  server = listening;
  const addr = listening.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const send = async (parts: unknown[], ids: { contextId?: string; taskId?: string } = {}): Promise<any> => {
    const res = await fetch(`${base}/desk/a2a/jsonrpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'X-API-Key': 'caller-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts, ...ids } } }),
    });
    const body = (await res.json()) as any;
    assert.ok(body.result, JSON.stringify(body.error ?? body));
    return body.result;
  };
  const statusText = (task: any) => (task.status?.message?.parts ?? []).map((p: any) => p.text ?? '').join('');
  const data = (task: any) => (task.status?.message?.parts ?? []).find((p: any) => p.kind === 'data')?.data;

  const first = await send([{ kind: 'text', text: 'tell ops' }]);
  assert.equal(first.status.state, 'input-required', statusText(first));
  assert.match(statusText(first), /Approval needed: Scout wants to run dp_send\(\{"to":"ops@acme.test"\}\)/);
  const request = data(first);
  assert.deepEqual(Object.keys(request).sort(), ['agent', 'approval_id', 'args', 'path', 'tool', 'type']);
  assert.equal(request.type, 'approval_request');
  assert.equal(request.agent, 'Scout');
  assert.deepEqual(request.path, ['Boss', 'Scout']);

  // Anything but an answer repeats the request, without a model call.
  const again = await send([{ kind: 'text', text: 'hm?' }], { contextId: first.contextId, taskId: first.id });
  assert.equal(again.status.state, 'input-required');
  assert.equal(data(again).approval_id, request.approval_id);
  assert.deepEqual(data(again).path, ['Boss', 'Scout']);
  assert.deepEqual(sent, []);

  const done = await send([{ kind: 'text', text: 'approve' }], { contextId: first.contextId, taskId: first.id });
  assert.equal(done.status.state, 'completed', statusText(done));
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.match(statusText(done), /sent to ops@acme.test/);
});
