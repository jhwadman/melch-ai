/**
 * tests/workflowChildPauses.test.ts — a nested workflow run as a dispatch
 * route or as a node of another workflow pauses the turn (ADR 0119): its
 * ask_user node's question and its gated agent node's approval request
 * reach the top-level turn input-required with the path from the entry
 * down to the node that asked, and the answer walks back into the nested
 * graph. Approve, reject and ask_user, as a route and as a node, a node
 * nested two deep, a delegated workflow whose node is one; child sessions
 * filed under the agent path; sessions 1.1.0 stored under the entry's name
 * alone continuing. Over runSyndicateTurn and over A2A. Scripted models,
 * in-memory sessions, no network.
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
import type { ModelRequest } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { MessagePart, SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

const sent: string[] = [];
registerTool(
  'wcp_send',
  defineTool({
    name: 'wcp_send',
    description: 'Send a note.',
    schema: z.object({ to: z.string() }),
    execute: async ({ to }) => (sent.push(to), `sent to ${to}`),
  }),
  { override: true },
);

const lastText = (request: ModelRequest) => requestTexts(request).at(-1) ?? '';
const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });
const config = (raw: Record<string, unknown>, file = 'workflow-child-pauses'): SyndicateYamlConfig => validateSyndicateConfig(raw, file) as SyndicateYamlConfig;
const writer = { name: 'Writer', description: 'Writes.', yaml_reference: 'pipeline.yaml' };

/** Plan → Confirm (ask_user) → Edit. */
const askingFlow = () =>
  config(
    {
      syndicate_name: 'Pipeline',
      memory_system: 'internal-only',
      orchestrator: agent('Plan'),
      subagents: [agent('Edit')],
      workflow: { edges: [['START', 'Plan', 'Confirm', 'Edit']], nodes: { Confirm: { ask_user: 'Publish?' } } },
    },
    'pipeline.yaml',
  );

/** Plan → Send (gated) → Report. */
const gatedFlow = () =>
  config(
    {
      syndicate_name: 'Pipeline',
      memory_system: 'internal-only',
      orchestrator: agent('Plan'),
      subagents: [agent('Send', { tools: ['wcp_send'], require_approval: ['wcp_send'] }), agent('Report')],
      workflow: { edges: [['START', 'Plan', 'Send', 'Report']] },
    },
    'pipeline.yaml',
  );

/** Plan → Plan's answer, one node: what a continued child session counts. */
const countingFlow = () => config({ syndicate_name: 'Pipeline', memory_system: 'internal-only', orchestrator: agent('Plan'), workflow: { edges: [['START', 'Plan']] } }, 'pipeline.yaml');

/** A dispatch syndicate: the classifier routes "thanks" to Chat, anything else to Writer. */
const front = () =>
  config({
    syndicate_name: 'Front',
    memory_system: 'internal-only',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [agent('Chat'), writer],
    dispatch: { default_route: 'Chat' },
  });

/** A workflow syndicate: Lead → Writer (a nested workflow) → Wrap. */
const room = () =>
  config({
    syndicate_name: 'Room',
    memory_system: 'internal-only',
    orchestrator: agent('Lead'),
    subagents: [writer, agent('Wrap')],
    workflow: { edges: [['START', 'Lead', 'Writer', 'Wrap']] },
  });

const scripts = (): Record<string, ModelScript> => ({
  router: (request) => answer(lastText(request).endsWith('thanks') ? '{"route":"Chat"}' : '{"route":"Writer"}'),
  chat: () => answer('you are welcome'),
  lead: (request) => answer(`lead(${lastText(request)})`),
  wrap: (request) => answer(`wrap(${lastText(request)})`),
  plan: (request) => answer(`plan(${lastText(request)})`),
  edit: (request) => answer(`edited(${lastText(request)})`),
  send: (request, n) => (n === 1 ? toolCall('wcp_send', { to: 'ops@acme.test' }, 'call-send-1') : answer(`send saw ${JSON.stringify(lastToolResult(request)?.result ?? null)}`)),
  report: (request) => answer(`report(${lastText(request)})`),
  boss: (request) => (lastToolResult(request) ? answer(`Boss: ${JSON.stringify(lastToolResult(request)!.result)}`) : toolCall('Writer', { request: 'cats' }, 'call-writer-1')),
});

/** One conversation: each message a turn, one store, fresh models. */
function converse(cfg: SyndicateYamlConfig, nested: Record<string, SyndicateYamlConfig>, overrides: Record<string, ModelScript> = {}) {
  resetCircuits();
  sent.length = 0;
  const sessionService = new InProcessSessionService();
  const models = Object.fromEntries(Object.entries({ ...scripts(), ...overrides }).map(([k, s]) => [k, new ScriptedModel(`scripted/${k}`, s)]));
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

// ── As a dispatch route ──────────────────────────────────────────────────────

test('a route’s ask_user node pauses the turn with the path; the next message answers it and the walk completes', async () => {
  const c = converse(front(), { 'pipeline.yaml': askingFlow() });
  const first = await c.turn([{ text: 'write about cats' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.equal(first.route?.route, 'Writer');
  assert.equal(first.input?.message, 'Publish?');
  assert.equal(first.input?.node, 'Confirm');
  assert.deepEqual(first.input?.path, ['Writer', 'Confirm']);
  assert.equal(first.text, 'Publish?');
  assert.equal(c.models.edit!.calls, 0, 'the walk waits on the node');
  // The walk is filed under the agent path; the conversation ends on the route's pause record.
  assert.ok((await c.events('app/route:Writer')).some((e) => e.longRunningToolIds?.includes(first.input!.id)));
  assert.equal(await c.sessionService.get({ appName: 'Writer', userId: 'u', sessionId: 's' }), undefined, 'nothing is filed under the bare name');
  const record = (await c.events('app')).at(-1)!;
  assert.equal(record.author, 'Writer');
  assert.deepEqual(record.longRunningToolIds, [first.input!.id]);
  assert.equal(record.content?.parts?.length ?? 0, 0);

  const second = await c.turn([{ text: 'yes, publish' }]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(second.route?.route, 'Writer');
  assert.equal(second.route?.decidedBy, 'answer');
  assert.equal(c.models.router!.calls, 1, 'the answer is not classified');
  assert.equal(c.models.plan!.calls, 1, 'a finished node is not run again');
  assert.match(lastText(c.models.edit!.requests[0]!), /yes, publish/);
  assert.match(second.text, /^edited\(/);
  // The conversation reads as any route's exchange: the person's words, and the route's answer last.
  const shared = await c.events('app');
  assert.equal(shared.at(-1)?.author, 'Writer');
  assert.equal(shared.at(-1)?.content?.parts?.[0]?.text, second.text);
  assert.ok(shared.some((e) => e.author === 'user' && e.content?.parts?.[0]?.text === 'yes, publish'));

  const third = await c.turn([{ text: 'thanks' }]);
  assert.equal(third.route?.route, 'Chat', 'the pause is closed: the next message is classified');
});

test('a route’s gated node: the request reaches the turn; a message that is not its decision repeats it; approve runs the call once', async () => {
  const c = converse(front(), { 'pipeline.yaml': gatedFlow() });
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.equal(first.approval?.agent, 'Send');
  assert.equal(first.approval?.tool, 'wcp_send');
  assert.deepEqual(first.approval?.path, ['Writer', 'Send']);
  assert.deepEqual(sent, []);
  const stored = (await c.events('app')).length;

  const again = await c.turn([{ text: 'hm?' }]);
  assert.equal(again.status, 'input-required');
  assert.equal(again.approval?.id, first.approval!.id);
  assert.equal((await c.events('app')).length, stored, 'nothing is stored');
  assert.equal(c.models.router!.calls, 1, 'nothing runs');
  const wrong = await c.turn([approvalResponsePart('adk-not-this-one', true) as MessagePart]);
  assert.equal(wrong.error?.code, 'NO_PENDING_APPROVAL');

  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(second.route?.decidedBy, 'approval');
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(second.text, 'report(send saw "sent to ops@acme.test")');
  const third = await c.turn([{ text: 'thanks' }]);
  assert.equal(third.status, 'completed', third.error?.message);
  assert.equal(third.route?.route, 'Chat');
  assert.deepEqual(sent, ['ops@acme.test'], 'a later turn never runs the call again');
});

test('a route’s gated node: reject never runs the call; the node is told and the walk completes', async () => {
  const c = converse(front(), { 'pipeline.yaml': gatedFlow() });
  const first = await c.turn([{ text: 'tell ops' }]);
  const second = await c.turn([approvalResponsePart(first.approval!.id, false) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, []);
  assert.match(second.text, /^report\(send saw .*rejected/);
});

// ── As a workflow node ───────────────────────────────────────────────────────

test('a node’s ask_user node pauses the caller’s walk and the turn with the path; the answer walks back down', async () => {
  const c = converse(room(), { 'pipeline.yaml': askingFlow() });
  const first = await c.turn([{ text: 'cats' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.equal(first.input?.message, 'Publish?');
  assert.equal(first.input?.node, 'Confirm');
  assert.deepEqual(first.input?.path, ['Writer', 'Confirm']);
  assert.equal(c.models.edit!.calls, 0);
  assert.equal(c.models.wrap!.calls, 0, 'the caller’s walk waits on the node');
  assert.ok((await c.events('app/node:Writer')).some((e) => e.longRunningToolIds?.includes(first.input!.id)));
  // The node raised its walk's request again on the caller's walk, at its own path.
  const raised = (await c.events('app')).filter((e) => e.nodeInfo?.path === 'Room.Writer' && e.longRunningToolIds?.includes(first.input!.id));
  assert.equal(raised.length, 1);

  const second = await c.turn([{ text: 'yes, publish' }]);
  assert.equal(second.status, 'completed', second.error?.message);
  for (const key of ['lead', 'plan', 'edit', 'wrap']) assert.equal(c.models[key]!.calls, 1, `${key} ran once`);
  assert.match(lastText(c.models.edit!.requests[0]!), /yes, publish/);
  assert.match(second.text, /^wrap\(edited\(/);
});

test('a node’s gated node: approve runs the call once, reject never runs it, and the caller’s walk goes on', async () => {
  const c = converse(room(), { 'pipeline.yaml': gatedFlow() });
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.equal(first.approval?.agent, 'Send');
  assert.deepEqual(first.approval?.path, ['Writer', 'Send']);
  const again = await c.turn([{ text: 'hm?' }]);
  assert.equal(again.approval?.id, first.approval!.id, 'a message that is not the decision repeats the request');
  assert.equal(c.models.lead!.calls, 1);
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(second.text, 'wrap(report(send saw "sent to ops@acme.test"))');
  const third = await c.turn([{ text: 'thanks' }]);
  assert.equal(third.status, 'completed', third.error?.message);
  assert.deepEqual(sent, ['ops@acme.test'], 'a later turn never runs the call again');
});

test('a node’s gated node: reject never runs the call', async () => {
  const c = converse(room(), { 'pipeline.yaml': gatedFlow() });
  const first = await c.turn([{ text: 'tell ops' }]);
  const second = await c.turn([approvalResponsePart(first.approval!.id, false) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, []);
  assert.match(second.text, /^wrap\(report\(send saw .*rejected/);
});

// ── Two deep ─────────────────────────────────────────────────────────────────

/** Plan → Inner (a nested workflow: the gated flow) → Edit, as pipeline.yaml. */
const outerFlow = () =>
  config(
    {
      syndicate_name: 'Pipeline',
      memory_system: 'internal-only',
      orchestrator: agent('Plan'),
      subagents: [{ name: 'Inner', description: 'Inner.', yaml_reference: 'inner.yaml' }, agent('Edit')],
      workflow: { edges: [['START', 'Plan', 'Inner', 'Edit']] },
    },
    'pipeline.yaml',
  );

test('a route whose node is a nested workflow: the gate two levels down pauses the turn with the whole path, and approve completes it', async () => {
  const c = converse(front(), { 'pipeline.yaml': outerFlow(), 'inner.yaml': gatedFlow() });
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.deepEqual(first.approval?.path, ['Writer', 'Inner', 'Send']);
  assert.ok((await c.events('app/route:Writer/node:Inner')).some((e) => e.longRunningToolIds?.includes(first.approval!.id)), 'each walk is filed below its caller’s');
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(c.models.plan!.calls, 2, 'each walk’s Plan ran once');
  assert.match(second.text, /^edited\(report\(send saw/);
});

test('a delegated workflow whose node is a nested workflow: the question two levels down reaches the turn, and the answer completes it', async () => {
  const desk = config({ syndicate_name: 'Desk', memory_system: 'internal-only', orchestrator: agent('Boss'), subagents: [writer] });
  const outer = config(
    { syndicate_name: 'Pipeline', memory_system: 'internal-only', orchestrator: agent('Lead'), subagents: [{ name: 'Inner', description: 'Inner.', yaml_reference: 'inner.yaml' }], workflow: { edges: [['START', 'Lead', 'Inner']] } },
    'pipeline.yaml',
  );
  const c = converse(desk, { 'pipeline.yaml': outer, 'inner.yaml': askingFlow() });
  const first = await c.turn([{ text: 'write about cats' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.deepEqual(first.input?.path, ['Boss', 'Writer', 'Inner', 'Confirm']);
  const second = await c.turn([{ text: 'yes, publish' }]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.match(second.text, /^Boss: "edited\(/);
  assert.match(lastText(c.models.edit!.requests[0]!), /yes, publish/);
});

// ── Sessions 1.1.0 stored ────────────────────────────────────────────────────

/** Answers with how many user messages its request holds: a node agent's history, counted. */
const counting: ModelScript = (req) => answer(`saw ${req.messages.filter((m) => m.role === 'user').length}`);

/** Moves a child session to the key 1.1.0 used (the entry's name alone). */
async function storeUnderOldKey(service: InProcessSessionService, from: string, name: string): Promise<void> {
  const moved = await service.get({ appName: from, userId: 'u', sessionId: 's' });
  assert.ok(moved, `no session ${from}`);
  const old = await service.create({ appName: name, userId: 'u', sessionId: 's', state: moved.state });
  for (const event of moved.events) await service.append(old, structuredClone(event));
  await service.delete({ appName: from, userId: 'u', sessionId: 's' });
}

for (const [where, cfg] of [
  ['route', front],
  ['node', room],
] as const) {
  for (const [stored, oldKey] of [
    ['the entry’s name alone (1.1.0)', 'Writer'],
    ['the path without its kind (ADR 0119)', 'app/Writer'],
  ] as const) {
    test(`a ${where}’s child session stored under ${stored} is continued, and nothing is filed under the path`, async () => {
      const c = converse(cfg(), { 'pipeline.yaml': countingFlow() }, { plan: (req) => answer(`plan ${req.messages.length}`) });
      const first = await c.turn([{ text: 'one' }]);
      assert.equal(first.status, 'completed', first.error?.message);
      await storeUnderOldKey(c.sessionService, `app/${where}:Writer`, oldKey);
      const before = (await c.events(oldKey)).length;
      const second = await c.turn([{ text: 'two' }]);
      assert.equal(second.status, 'completed', second.error?.message);
      assert.ok((await c.events(oldKey)).length > before, 'the walk went on in the old session');
      assert.equal(await c.sessionService.get({ appName: `app/${where}:Writer`, userId: 'u', sessionId: 's' }), undefined);
    });
  }
}

test('a conversation that never ran the entry does not read another’s session under the bare name', async () => {
  const c = converse(front(), { 'pipeline.yaml': countingFlow() }, { plan: counting });
  const other = await c.sessionService.create({ appName: 'Writer', userId: 'u', sessionId: 's', state: {} });
  const before = other.events.length;
  const result = await c.turn([{ text: 'one' }]);
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal((await c.events('Writer')).length, before);
  assert.ok((await c.events('app/route:Writer')).length > 0);
});

// ── Over A2A ─────────────────────────────────────────────────────────────────

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function a2a(files: Record<string, string>, overrides: Record<string, ModelScript> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'melch-workflow-child-pauses-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  process.env.MELCHIZEDEK_AGENTS_DIR = dir;
  resetCircuits();
  sent.length = 0;
  const all = { ...scripts(), ...overrides };
  const built = await createA2AApp({
    defaultSyndicate: 'desk.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InProcessSessionService() },
    keyMode: 'byok',
    // A fresh model per resolution, answering from the request alone.
    resolveModel: (id?: string) => {
      const key = (id ?? '').replace(/^scripted\//, '');
      return shimResolver({ [key]: new ScriptedModel(`scripted/${key}`, all[key]!) })(id);
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
  return async (parts: unknown[], ids: { contextId?: string; taskId?: string } = {}): Promise<any> => {
    const res = await fetch(`${base}/desk/a2a/jsonrpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'X-API-Key': 'caller-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts, ...ids } } }),
    });
    const body = (await res.json()) as any;
    assert.ok(body.result, JSON.stringify(body.error ?? body));
    return body.result;
  };
}

const statusText = (task: any) => (task.status?.message?.parts ?? []).map((p: any) => p.text ?? '').join('');
const dataPart = (task: any) => (task.status?.message?.parts ?? []).find((p: any) => p.kind === 'data')?.data;

const flowYaml = (subagents: string[], workflow: string[]) =>
  ['syndicate_name: Pipeline', 'memory_system: internal-only', 'orchestrator:', '  name: Plan', '  description: Plan', '  model: scripted/plan', '  instruction: Plan.', 'subagents:', ...subagents, 'workflow:', ...workflow].join('\n');
const GATED_YAML = flowYaml(
  ['  - name: Send', '    description: Send', '    model: scripted/send', '    instruction: Send.', '    tools: [wcp_send]', '    require_approval: [wcp_send]', '  - name: Report', '    description: Report', '    model: scripted/report', '    instruction: Report.'],
  ['  edges:', '    - [START, Plan, Send, Report]'],
);
const ASKING_YAML = flowYaml(['  - name: Edit', '    description: Edit', '    model: scripted/edit', '    instruction: Edit.'], ['  edges:', '    - [START, Plan, Confirm, Edit]', '  nodes:', '    Confirm:', '      ask_user: Publish?']);
const WRITER = ['  - name: Writer', '    description: Writes.', '    yaml_reference: pipeline.yaml'];
const FRONT_YAML = ['syndicate_name: Front', 'memory_system: internal-only', 'orchestrator:', '  name: Router', '  model: scripted/router', '  instruction: Classify.', 'subagents:', '  - name: Chat', '    description: Chat', '    model: scripted/chat', '    instruction: Chat.', ...WRITER, 'dispatch:', '  default_route: Chat'].join('\n');
const ROOM_YAML = ['syndicate_name: Room', 'memory_system: internal-only', 'orchestrator:', '  name: Lead', '  description: Lead', '  model: scripted/lead', '  instruction: Lead.', 'subagents:', ...WRITER, '  - name: Wrap', '    description: Wrap', '    model: scripted/wrap', '    instruction: Wrap.', 'workflow:', '  edges:', '    - [START, Lead, Writer, Wrap]'].join('\n');

/** Each resolution is a fresh model: Send answers from its request alone. */
const sendFromRequest: ModelScript = (request) => (lastToolResult(request) ? answer(`send saw ${JSON.stringify(lastToolResult(request)!.result)}`) : toolCall('wcp_send', { to: 'ops@acme.test' }, 'call-send-1'));

for (const [where, top] of [
  ['route', FRONT_YAML],
  ['node', ROOM_YAML],
] as const) {
  test(`over A2A: a ${where}’s gated node raises the approval data part with the path; "approve" resumes it and completes`, async () => {
    const send = await a2a({ 'desk.yaml': top, 'pipeline.yaml': GATED_YAML }, { send: sendFromRequest });
    const first = await send([{ kind: 'text', text: 'tell ops' }]);
    assert.equal(first.status.state, 'input-required', statusText(first));
    const request = dataPart(first);
    assert.equal(request.type, 'approval_request');
    assert.equal(request.agent, 'Send');
    assert.deepEqual(request.path, ['Writer', 'Send']);
    const again = await send([{ kind: 'text', text: 'hm?' }], { contextId: first.contextId, taskId: first.id });
    assert.equal(again.status.state, 'input-required');
    assert.equal(dataPart(again).approval_id, request.approval_id);
    assert.deepEqual(dataPart(again).path, ['Writer', 'Send']);
    assert.deepEqual(sent, []);
    const done = await send([{ kind: 'text', text: 'approve' }], { contextId: first.contextId, taskId: first.id });
    assert.equal(done.status.state, 'completed', statusText(done));
    assert.deepEqual(sent, ['ops@acme.test']);
    assert.match(statusText(done), /sent to ops@acme.test/);
  });

  test(`over A2A: a ${where}’s ask_user node raises the input request with the path; the reply completes the task`, async () => {
    const send = await a2a({ 'desk.yaml': top, 'pipeline.yaml': ASKING_YAML });
    const first = await send([{ kind: 'text', text: 'write about cats' }]);
    assert.equal(first.status.state, 'input-required', statusText(first));
    const request = dataPart(first);
    assert.equal(request.type, 'input_request');
    assert.equal(request.message, 'Publish?');
    assert.deepEqual(request.path, ['Writer', 'Confirm']);
    const done = await send([{ kind: 'text', text: 'yes, publish' }], { contextId: first.contextId, taskId: first.id });
    assert.equal(done.status.state, 'completed', statusText(done));
    assert.match(statusText(done), /edited\(/);
  });
}
