/**
 * tests/nestedDispatch.test.ts — a nested dispatch (plan-dispatch) syndicate
 * behaves as it does at the top (ADR 0120): its classifier picks a route,
 * the route runs on the nested syndicate's own conversation, and the
 * route's final text is the nested syndicate's answer. Delegated to, as a
 * dispatch route and as a workflow node; gates and questions on its routes
 * (and inside a route's own delegation) pause the turn with the path and
 * resume on the answer; child sessions carry their kind (route:, node:)
 * so a delegated call's key never equals a route's or a node's. Consent
 * inside a nested dispatch route: tests/delegatedScriptsConsent.test.ts.
 * Scripted models, in-memory sessions, no network.
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
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { childAppName, entryAppName } from '../lib/runtime/native/delegate.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { MessagePart, SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { APPROVAL_TEXTS } from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

const sent: string[] = [];
registerTool(
  'nd_send',
  defineTool({
    name: 'nd_send',
    description: 'Send a note.',
    schema: z.object({ to: z.string() }),
    execute: async ({ to }) => (sent.push(to), `sent to ${to}`),
  }),
  { override: true },
);

const resultOf = (req: ModelRequest): string | undefined => {
  const r = lastToolResult(req);
  return r ? JSON.stringify(r.result) : undefined;
};

/** Calls `name` with `args` the first time; once a tool result is in the history, answers with it under `label`. */
const delegating =
  (label: string, name: string, args: Record<string, unknown>, id: string): ModelScript =>
  (req) => {
    const r = resultOf(req);
    return r === undefined ? toolCall(name, args, id) : answer(`${label}: ${r}`);
  };

const lastText = (request: ModelRequest) => requestTexts(request).at(-1) ?? '';
const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });
const config = (raw: Record<string, unknown>, file = 'nested-dispatch'): SyndicateYamlConfig => validateSyndicateConfig(raw, file) as SyndicateYamlConfig;
const route = (name: string, reason = 'picked') => answer(JSON.stringify({ route: name, reason }));

/** The nested dispatch syndicate: Router classifies between Chat and Ops; Ops sends notes behind a gate when `gated`. */
const desk = (ops: Record<string, unknown> = {}) =>
  config(
    {
      syndicate_name: 'Desk',
      orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
      subagents: [agent('Chat'), agent('Ops', ops)],
      dispatch: { default_route: 'Chat' },
    },
    'desk.yaml',
  );
const gatedOps = { tools: ['nd_send'], require_approval: ['nd_send'] };

/** Boss delegates to the nested dispatch syndicate, named Team. */
const top = () => config({ syndicate_name: 'Top', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Ask the team.' }, subagents: [{ name: 'Team', description: 'A team', yaml_reference: 'desk.yaml' }] });
/** A dispatch syndicate whose route Team is the nested one. */
const front = () =>
  config({
    syndicate_name: 'Front',
    orchestrator: { name: 'Front', model: 'scripted/front', instruction: 'Classify.' },
    subagents: [agent('Small'), { name: 'Team', description: 'A team', yaml_reference: 'desk.yaml' }],
    dispatch: { default_route: 'Small' },
  });
/** A workflow whose node Team is the nested one. */
const room = () =>
  config({
    syndicate_name: 'Room',
    orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Brief.' },
    subagents: [{ name: 'Team', description: 'A team', yaml_reference: 'desk.yaml' }],
    workflow: { edges: [['START', 'Lead', 'Team']] },
  });

function converse(cfg: SyndicateYamlConfig, scripts: Record<string, ModelScript>, nested: Record<string, SyndicateYamlConfig>) {
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
  const events = async (appName: string): Promise<TurnEvent[]> => (await sessionService.get({ appName, userId: 'u', sessionId: 's' }))?.events ?? [];
  return { turn, models, sessionService, events };
}

const authors = (events: TurnEvent[]) => events.map((e) => e.author);

// ── Delegated to ─────────────────────────────────────────────────────────────

test('delegated: the nested classifier picks a route, the route answers on the nested conversation, and its final text is the call’s result', async () => {
  let calls = 0;
  // Boss calls Team for each message, and relays the result.
  const boss: ModelScript = (req) => (req.messages.at(-1)?.role === 'user' ? toolCall('Team', { request: lastText(req) }, `call-team-${++calls}`) : answer(`Boss: ${resultOf(req)}`));
  const c = converse(top(), { boss, router: () => route('Ops'), ops: () => answer('ops did it'), chat: () => answer('chat') }, { 'desk.yaml': desk() });
  const result = await c.turn([{ text: 'ship it' }]);
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.text, 'Boss: "ops did it"', 'the route’s final text, not the classifier’s verdict');
  assert.equal(c.models.router!.calls, 1);
  assert.equal(c.models.chat!.calls, 0);
  assert.match(lastText(c.models.router!.requests[0]!), /ship it/);
  // The nested syndicate's conversation, filed under the delegation's agent path, holds what a top-level dispatch turn stores.
  const conv = await c.events('app/Boss/Team');
  assert.deepEqual(authors(conv), ['user', 'Ops']);
  assert.ok(!JSON.stringify(conv).includes('"route"'), 'the classifier’s verdict never enters the conversation');
  // A second call continues the same conversation: the route reads the first exchange.
  const again = await c.turn([{ text: 'and again' }]);
  assert.equal(again.status, 'completed', again.error?.message);
  assert.deepEqual(authors(await c.events('app/Boss/Team')), ['user', 'Ops', 'user', 'Ops']);
});

test('delegated: a gate on a nested route pauses the turn with the path; approve runs the call once and completes', async () => {
  const c = converse(
    top(),
    { boss: delegating('Boss', 'Team', { request: 'tell ops' }, 'call-team-1'), router: () => route('Ops'), ops: delegating('Ops', 'nd_send', { to: 'ops@acme.test' }, 'call-send-1'), chat: () => answer('chat') },
    { 'desk.yaml': desk(gatedOps) },
  );
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.approval?.agent, 'Ops');
  assert.equal(first.approval?.tool, 'nd_send');
  assert.deepEqual(first.approval?.path, ['Boss', 'Team', 'Ops']);
  assert.deepEqual(sent, []);
  // A message that is not the decision repeats the request; a wrong id fails.
  const wrong = await c.turn([approvalResponsePart('nope', true) as MessagePart]);
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.error?.code, 'NO_PENDING_APPROVAL');
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(second.text, 'Boss: "Ops: \\"sent to ops@acme.test\\""');
  assert.equal(c.models.router!.calls, 1, 'the resume does not classify again');
});

test('delegated: reject never runs the gated call, and the turn completes', async () => {
  const c = converse(
    top(),
    { boss: delegating('Boss', 'Team', { request: 'tell ops' }, 'call-team-1'), router: () => route('Ops'), ops: delegating('Ops', 'nd_send', { to: 'ops@acme.test' }, 'call-send-1'), chat: () => answer('chat') },
    { 'desk.yaml': desk(gatedOps) },
  );
  const first = await c.turn([{ text: 'tell ops' }]);
  const second = await c.turn([approvalResponsePart(first.approval!.id, false) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, []);
  assert.equal(resultOf(c.models.ops!.requests[1]!), JSON.stringify(APPROVAL_TEXTS.rejected));
});

test('delegated: ask_user on a nested route pauses the turn with the path; the next message is its answer', async () => {
  const c = converse(
    top(),
    { boss: delegating('Boss', 'Team', { request: 'which?' }, 'call-team-1'), router: () => route('Ops'), ops: delegating('Ops', 'ask_user', { question: 'Which one?' }, 'call-ask-1'), chat: () => answer('chat') },
    { 'desk.yaml': desk({ tools: ['ask_user'] }) },
  );
  const first = await c.turn([{ text: 'pick one' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.input?.message, 'Which one?');
  assert.deepEqual(first.input?.path, ['Boss', 'Team', 'Ops']);
  const second = await c.turn([{ text: 'the blue one' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.text, 'Boss: "Ops: \\"the blue one\\""');
});

test('delegated: a gate inside a nested route’s own delegation pauses with the whole path, filed under the route’s name', async () => {
  const sender = config({ syndicate_name: 'Sender', orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Delegate.' }, subagents: [agent('Mailer', gatedOps)] }, 'sender.yaml');
  const nested = config(
    { syndicate_name: 'Desk', orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' }, subagents: [agent('Chat'), { name: 'Ops', description: 'Ops', yaml_reference: 'sender.yaml' }], dispatch: { default_route: 'Chat' } },
    'desk.yaml',
  );
  const c = converse(
    top(),
    {
      boss: delegating('Boss', 'Team', { request: 'tell ops' }, 'call-team-1'),
      router: () => route('Ops'),
      lead: delegating('Lead', 'Mailer', { request: 'send it' }, 'call-mailer-1'),
      mailer: delegating('Mailer', 'nd_send', { to: 'ops@acme.test' }, 'call-send-1'),
      chat: () => answer('chat'),
    },
    { 'desk.yaml': nested, 'sender.yaml': sender },
  );
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.deepEqual(first.approval?.path, ['Boss', 'Team', 'Ops', 'Mailer']);
  assert.ok((await c.events('app/Boss/Team/Ops/Mailer')).length > 0, 'the route files its delegation under its own name, as a route at the top does');
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.match(second.text, /^Boss: "Lead: .*sent to ops@acme\.test/);
});

// ── As a dispatch route ──────────────────────────────────────────────────────

test('as a route: the nested syndicate classifies and routes on its own conversation; its route’s answer is the turn’s', async () => {
  const c = converse(front(), { front: () => route('Team'), small: () => answer('small'), router: () => route('Ops'), ops: () => answer('ops did it'), chat: () => answer('chat') }, { 'desk.yaml': desk() });
  const result = await c.turn([{ text: 'ship it' }]);
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.text, 'ops did it');
  assert.equal(result.route?.route, 'Team');
  assert.deepEqual(authors(await c.events('app')), ['user', 'Team']);
  assert.deepEqual(authors(await c.events('app/route:Team')), ['user', 'Ops']);
});

test('as a route: a gate on the nested route pauses the turn with the path from the route down; approve resumes it without classifying', async () => {
  const c = converse(
    front(),
    { front: () => route('Team'), small: () => answer('small'), router: () => route('Ops'), ops: delegating('Ops', 'nd_send', { to: 'ops@acme.test' }, 'call-send-1'), chat: () => answer('chat') },
    { 'desk.yaml': desk(gatedOps) },
  );
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.deepEqual(first.approval?.path, ['Team', 'Ops']);
  // The conversation ends on the route's pause record.
  const record = (await c.events('app')).at(-1)!;
  assert.equal(record.author, 'Team');
  assert.deepEqual(record.longRunningToolIds, [first.approval!.id]);
  // A message that is not the decision repeats the request and runs nothing.
  const repeat = await c.turn([{ text: 'well?' }]);
  assert.equal(repeat.status, 'input-required');
  assert.equal(repeat.approval?.id, first.approval!.id);
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.route?.decidedBy, 'approval');
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(second.text, 'Ops: "sent to ops@acme.test"');
  assert.equal(c.models.front!.calls, 1, 'the top does not classify again');
  assert.equal(c.models.router!.calls, 1, 'the nested syndicate does not classify again');
});

test('as a route: ask_user on the nested route pauses with the path; the next message answers it', async () => {
  const c = converse(
    front(),
    { front: () => route('Team'), small: () => answer('small'), router: () => route('Ops'), ops: delegating('Ops', 'ask_user', { question: 'Which one?' }, 'call-ask-1'), chat: () => answer('chat') },
    { 'desk.yaml': desk({ tools: ['ask_user'] }) },
  );
  const first = await c.turn([{ text: 'pick one' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.deepEqual(first.input?.path, ['Team', 'Ops']);
  const second = await c.turn([{ text: 'the blue one' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.route?.decidedBy, 'answer');
  assert.equal(second.text, 'Ops: "the blue one"');
});

// ── As a workflow node ───────────────────────────────────────────────────────

test('as a node: the nested syndicate routes its input; its route’s answer is the node’s output', async () => {
  const c = converse(room(), { lead: () => answer('brief'), router: () => route('Ops'), ops: (req) => answer(`ops(${lastText(req)})`), chat: () => answer('chat') }, { 'desk.yaml': desk() });
  const result = await c.turn([{ text: 'go' }]);
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.text, 'ops(brief)');
  assert.deepEqual(authors(await c.events('app/node:Team')), ['user', 'Ops']);
});

test('as a node: a gate on the nested route pauses the walk and the turn with the path; approve completes the node', async () => {
  const c = converse(
    room(),
    { lead: () => answer('brief'), router: () => route('Ops'), ops: delegating('Ops', 'nd_send', { to: 'ops@acme.test' }, 'call-send-1'), chat: () => answer('chat') },
    { 'desk.yaml': desk(gatedOps) },
  );
  const first = await c.turn([{ text: 'go' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.deepEqual(first.approval?.path, ['Team', 'Ops']);
  assert.equal(first.approval?.tool, 'nd_send');
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(second.text, 'Ops: "sent to ops@acme.test"');
});

test('as a node: ask_user on the nested route pauses with the path; the answer completes the node', async () => {
  const c = converse(
    room(),
    { lead: () => answer('brief'), router: () => route('Ops'), ops: delegating('Ops', 'ask_user', { question: 'Which one?' }, 'call-ask-1'), chat: () => answer('chat') },
    { 'desk.yaml': desk({ tools: ['ask_user'] }) },
  );
  const first = await c.turn([{ text: 'go' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.deepEqual(first.input?.path, ['Team', 'Ops']);
  const second = await c.turn([{ text: 'the blue one' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.text, 'Ops: "the blue one"');
});

// ── Load ─────────────────────────────────────────────────────────────────────

test('load: a nested dispatch syndicate that reaches itself is refused by name before any model call; a route named as the entry is refused', async () => {
  const loop = config({ syndicate_name: 'Desk', orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' }, subagents: [agent('Chat'), { name: 'Again', description: 'again', yaml_reference: 'desk.yaml' }], dispatch: { default_route: 'Chat' } }, 'desk.yaml');
  const c = converse(top(), { boss: () => answer('never') }, { 'desk.yaml': loop });
  await assert.rejects(c.turn([{ text: 'hi' }]), /desk\.yaml: a nested syndicate reaches itself/);
  assert.equal(c.models.boss!.calls, 0);
  const named = config({ syndicate_name: 'Desk', orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' }, subagents: [agent('Team')], dispatch: { default_route: 'Team' } }, 'desk.yaml');
  const d = converse(top(), { boss: () => answer('never') }, { 'desk.yaml': named });
  await assert.rejects(d.turn([{ text: 'hi' }]), /desk\.yaml: the route 'Team' has the name its caller gives the nested syndicate/);
});

// ── Keys ─────────────────────────────────────────────────────────────────────

test('keys: a delegated call’s child session never shares a key with a route’s or a node’s (ADR 0120)', () => {
  const delegated = childAppName({ appName: 'app' }, 'X', 'Y');
  const nodeBelowRoute = entryAppName(entryAppName('app', 'X', 'route'), 'Y', 'node');
  assert.equal(delegated, 'app/X/Y');
  assert.equal(nodeBelowRoute, 'app/route:X/node:Y');
  assert.notEqual(delegated, nodeBelowRoute);
  assert.equal(childAppName({ appName: 'app/X/Y', delegated: true }, 'Y', 'Z'), 'app/X/Y/Z');
});

// ── Over A2A ─────────────────────────────────────────────────────────────────

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

const TOP_YAML = ['syndicate_name: Top', 'memory_system: internal-only', 'orchestrator:', '  name: Boss', '  model: scripted/boss', '  instruction: Delegate.', 'subagents:', '  - name: Team', '    description: A team.', '    yaml_reference: desk.yaml'].join('\n');
const DESK_YAML = [
  'syndicate_name: Desk',
  'memory_system: internal-only',
  'orchestrator:',
  '  name: Router',
  '  model: scripted/router',
  '  instruction: Classify.',
  'subagents:',
  '  - name: Chat',
  '    description: Chat.',
  '    model: scripted/chat',
  '    instruction: Chat.',
  '  - name: Ops',
  '    description: Ops.',
  '    model: scripted/ops',
  '    instruction: Ops.',
  '    tools: [nd_send]',
  '    require_approval: [nd_send]',
  'dispatch:',
  '  default_route: Chat',
].join('\n');

test('over A2A: a gate on a nested dispatch route raises the approval data part with the path; "approve" resumes it and completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-nested-dispatch-'));
  writeFileSync(join(dir, 'top.yaml'), TOP_YAML);
  writeFileSync(join(dir, 'desk.yaml'), DESK_YAML);
  process.env.MELCHIZEDEK_AGENTS_DIR = dir;
  resetCircuits();
  sent.length = 0;
  const scripts: Record<string, ModelScript> = {
    boss: delegating('Boss', 'Team', { request: 'tell ops' }, 'call-team-1'),
    router: () => route('Ops'),
    ops: (request) => (lastToolResult(request) ? answer(`ops saw ${JSON.stringify(lastToolResult(request)!.result)}`) : toolCall('nd_send', { to: 'ops@acme.test' }, 'call-send-1')),
    chat: () => answer('chat'),
  };
  const built = await createA2AApp({
    defaultSyndicate: 'top.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InProcessSessionService() },
    keyMode: 'byok',
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
  servers.push(listening);
  const addr = listening.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const send = async (parts: unknown[], ids: { contextId?: string; taskId?: string } = {}): Promise<any> => {
    const res = await fetch(`${base}/top/a2a/jsonrpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'X-API-Key': 'caller-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts, ...ids } } }),
    });
    const body = (await res.json()) as any;
    assert.ok(body.result, JSON.stringify(body.error ?? body));
    return body.result;
  };
  const statusText = (task: any) => (task.status?.message?.parts ?? []).map((p: any) => p.text ?? '').join('');
  const dataPart = (task: any) => (task.status?.message?.parts ?? []).find((p: any) => p.kind === 'data')?.data;

  const first = await send([{ kind: 'text', text: 'tell ops' }]);
  assert.equal(first.status.state, 'input-required', statusText(first));
  const request = dataPart(first);
  assert.equal(request.type, 'approval_request');
  assert.equal(request.agent, 'Ops');
  assert.deepEqual(request.path, ['Boss', 'Team', 'Ops']);
  assert.deepEqual(sent, []);
  const done = await send([{ kind: 'text', text: 'approve' }], { contextId: first.contextId, taskId: first.id });
  assert.equal(done.status.state, 'completed', statusText(done));
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.match(statusText(done), /sent to ops@acme.test/);
});
