/**
 * tests/nestedPauses.test.ts — pauses inside nested syndicates (WS6-2b,
 * ADR 0111): an approval request or a question raised inside a
 * `yaml_reference` subagent pauses the top-level turn input-required with
 * the agent path, and the answer resumes it. A nested delegate syndicate's
 * own orchestrator, a nested dispatch syndicate's classifier, and a nested
 * workflow's ask_user node and gated agent node; what stays refused, with
 * its reason; child sessions filed under the agent path, and conversations
 * stored under the old key resuming. Over runSyndicateTurn and over A2A.
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
import { APPROVAL_TEXTS } from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

const sent: string[] = [];
registerTool(
  'np_send',
  defineTool({
    name: 'np_send',
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

const lastText = (request: ModelRequest) => requestTexts(request).at(-1) ?? '';
const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });
const config = (raw: Record<string, unknown>, file = 'nested-pauses'): SyndicateYamlConfig => validateSyndicateConfig(raw, file) as SyndicateYamlConfig;

/** The top: Boss delegates to one nested syndicate, named Team. */
const top = (ref = 'team.yaml') => config({ syndicate_name: 'Top', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Ask the team.' }, subagents: [{ name: 'Team', description: 'A team', yaml_reference: ref }] });

/** One conversation: each message a turn, one store, fresh models. */
function converse(cfg: SyndicateYamlConfig, scripts: Record<string, ModelScript>, nested: Record<string, SyndicateYamlConfig> = {}, sessionService = new InProcessSessionService()) {
  resetCircuits();
  sent.length = 0;
  const models = Object.fromEntries(Object.entries(scripts).map(([k, s]) => [k, new ScriptedModel(`scripted/${k}`, s)]));
  const turn = (parts: MessagePart[], with_ = cfg): Promise<SyndicateTurnResult> =>
    runSyndicateTurn({
      config: with_,
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

// ── A nested delegate syndicate's own orchestrator ───────────────────────────

const gatedTeam = () => config({ syndicate_name: 'Team', orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Send it.', tools: ['np_send'], require_approval: ['np_send'] } }, 'team.yaml');

test('a gate on a nested syndicate’s own orchestrator: approve pauses the turn with the path and resumes it', async () => {
  const c = converse(top(), { boss: delegating('Boss', 'Team', { request: 'tell ops' }, 'call-team-1'), lead: delegating('Lead', 'np_send', { to: 'ops@acme.test' }, 'call-send-1') }, { 'team.yaml': gatedTeam() });
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  // The nested orchestrator runs under its entry's name.
  assert.equal(first.approval?.agent, 'Team');
  assert.deepEqual(first.approval?.path, ['Boss', 'Team']);
  assert.deepEqual(sent, []);
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(second.text, 'Boss: "Lead: \\"sent to ops@acme.test\\""');
});

test('a gate on a nested syndicate’s own orchestrator: reject never runs the call, and the turn completes', async () => {
  const c = converse(top(), { boss: delegating('Boss', 'Team', { request: 'tell ops' }, 'call-team-1'), lead: delegating('Lead', 'np_send', { to: 'ops@acme.test' }, 'call-send-1') }, { 'team.yaml': gatedTeam() });
  const first = await c.turn([{ text: 'tell ops' }]);
  const second = await c.turn([approvalResponsePart(first.approval!.id, false) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, []);
  assert.equal(result(c.models.lead!.requests[1]!), JSON.stringify(APPROVAL_TEXTS.rejected));
});

test('ask_user on a nested syndicate’s own orchestrator: the next message is its answer', async () => {
  const team = config({ syndicate_name: 'Team', orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Ask.', tools: ['ask_user'] } }, 'team.yaml');
  const c = converse(top(), { boss: delegating('Boss', 'Team', { request: 'which?' }, 'call-team-1'), lead: delegating('Lead', 'ask_user', { question: 'Which one?' }, 'call-ask-1') }, { 'team.yaml': team });
  const first = await c.turn([{ text: 'pick one' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.equal(first.input?.message, 'Which one?');
  assert.deepEqual(first.input?.path, ['Boss', 'Team']);
  const second = await c.turn([{ text: 'the blue one' }]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(second.text, 'Boss: "Lead: \\"the blue one\\""');
});

// ── A nested dispatch syndicate ──────────────────────────────────────────────

test('a nested dispatch syndicate: its classifier may gate and pauses the turn; a gate on a route, which never runs nested, is refused by name', async () => {
  const desk = (routeGate: boolean) =>
    config(
      {
        syndicate_name: 'Team',
        orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.', tools: ['np_send'], require_approval: ['np_send'] },
        subagents: [agent('Chat', routeGate ? { tools: ['np_send'], require_approval: ['np_send'] } : {})],
        dispatch: { default_route: 'Chat' },
      },
      'team.yaml',
    );
  const c = converse(top(), { boss: delegating('Boss', 'Team', { request: 'tell ops' }, 'call-team-1'), router: delegating('Router', 'np_send', { to: 'ops@acme.test' }, 'call-send-1'), chat: () => answer('chat') }, { 'team.yaml': desk(false) });
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.deepEqual(first.approval?.path, ['Boss', 'Team']);
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);

  const refused = converse(top(), { boss: () => answer('never') }, { 'team.yaml': desk(true) });
  await assert.rejects(refused.turn([{ text: 'tell ops' }]), /team\.yaml: approval gates \(require_approval, or skill scripts\) on the route 'Chat' never run: a nested dispatch syndicate runs its classifier alone/);
  assert.equal(refused.models.boss!.calls, 0, 'refused before any model call');
});

// ── A nested workflow syndicate ──────────────────────────────────────────────

/** Plan → Confirm (ask_user) → Edit, nested under the entry name Writer. */
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

/** Plan → Send (gated) → Report, nested under the entry name Writer. */
const gatedFlow = () =>
  config(
    {
      syndicate_name: 'Pipeline',
      memory_system: 'internal-only',
      orchestrator: agent('Plan'),
      subagents: [agent('Send', { tools: ['np_send'], require_approval: ['np_send'] }), agent('Report')],
      workflow: { edges: [['START', 'Plan', 'Send', 'Report']] },
    },
    'pipeline.yaml',
  );

const desk = () => config({ syndicate_name: 'Desk', memory_system: 'internal-only', orchestrator: agent('Boss'), subagents: [{ name: 'Writer', description: 'Writes.', yaml_reference: 'pipeline.yaml' }] });

const flowScripts = (): Record<string, ModelScript> => ({
  boss: delegating('Boss', 'Writer', { request: 'cats' }, 'call-writer-1'),
  plan: (request) => answer(`plan(${lastText(request)})`),
  edit: (request) => answer(`edited(${lastText(request)})`),
  send: (request, n) => (n === 1 ? toolCall('np_send', { to: 'ops@acme.test' }, 'call-send-1') : answer(`send saw ${JSON.stringify(lastToolResult(request)?.result ?? null)}`)),
  report: (request) => answer(`report(${lastText(request)})`),
});

test('a nested workflow’s ask_user node pauses the turn with the path; the answer resumes the walk and the caller', async () => {
  const c = converse(desk(), flowScripts(), { 'pipeline.yaml': askingFlow() });
  const first = await c.turn([{ text: 'write about cats' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.equal(first.input?.message, 'Publish?');
  assert.equal(first.input?.node, 'Confirm');
  assert.deepEqual(first.input?.path, ['Boss', 'Writer', 'Confirm']);
  assert.equal(c.models.edit!.calls, 0, 'the walk waits on the node');
  // The walk paused in the child session filed under the agent path; the caller's call stays open.
  assert.ok((await c.events('app/Boss/Writer')).some((e) => e.longRunningToolIds?.includes(first.input!.id)));

  const second = await c.turn([{ text: 'yes, publish' }]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(c.models.plan!.calls, 1, 'a finished node is not run again');
  assert.equal(c.models.edit!.calls, 1);
  assert.match(lastText(c.models.edit!.requests[0]!), /yes, publish/);
  assert.equal(c.models.boss!.calls, 2);
  assert.match(second.text, /^Boss: "edited\(/);
});

test('a nested workflow’s gated agent node: approve runs the call once and the walk and the caller go on', async () => {
  const c = converse(desk(), flowScripts(), { 'pipeline.yaml': gatedFlow() });
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.equal(first.approval?.agent, 'Send');
  assert.deepEqual(first.approval?.path, ['Boss', 'Writer', 'Send']);
  assert.deepEqual(sent, []);
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(second.text, 'Boss: "report(send saw \\"sent to ops@acme.test\\")"');
  const third = await c.turn([{ text: 'thanks' }]);
  assert.equal(third.status, 'completed', third.error?.message);
  assert.deepEqual(sent, ['ops@acme.test'], 'a later turn never runs the call again');
});

test('a nested workflow’s gated agent node: reject never runs the call; the node is told and the walk goes on', async () => {
  const c = converse(desk(), flowScripts(), { 'pipeline.yaml': gatedFlow() });
  const first = await c.turn([{ text: 'tell ops' }]);
  const wrong = await c.turn([approvalResponsePart('adk-not-this-one', true) as MessagePart]);
  assert.equal(wrong.error?.code, 'NO_PENDING_APPROVAL');
  const second = await c.turn([approvalResponsePart(first.approval!.id, false) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, []);
  assert.match(second.text, /^Boss: "report\(send saw .*rejected/);
});

test('a nested workflow’s gates stay refused where its pause cannot reach the turn: as a dispatch route and as a workflow node', async () => {
  const route = config({
    syndicate_name: 'Front',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [agent('Chat'), { name: 'Writer', description: 'Writes.', yaml_reference: 'pipeline.yaml' }],
    dispatch: { default_route: 'Chat' },
  });
  const node = config({
    syndicate_name: 'Room',
    memory_system: 'internal-only',
    orchestrator: agent('Lead'),
    subagents: [{ name: 'Writer', description: 'Writes.', yaml_reference: 'pipeline.yaml' }],
    workflow: { edges: [['START', 'Lead', 'Writer']] },
  });
  for (const cfg of [route, node]) {
    const c = converse(cfg, { router: () => answer('{"route":"Writer"}'), lead: () => answer('go') }, { 'pipeline.yaml': gatedFlow() });
    await assert.rejects(c.turn([{ text: 'go' }]), /pipeline\.yaml: approval gates \(require_approval, or skill scripts\) in a workflow run as a dispatch route or a workflow node cannot pause the turn yet/);
  }
});

// ── Child sessions by agent path ─────────────────────────────────────────────

/** Answers with how many user messages its request holds: a subagent's history, counted. */
const counting: ModelScript = (req) => answer(`saw ${req.messages.filter((m) => m.role === 'user').length}`);

test('two syndicates with a same-named subagent on one conversation keep separate child sessions', async () => {
  const a = config({ syndicate_name: 'A', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'i' }, subagents: [agent('Scout')] });
  const b = config({ syndicate_name: 'B', orchestrator: { name: 'Chief', model: 'scripted/chief', instruction: 'i' }, subagents: [agent('Scout')] });
  const c = converse(a, { boss: delegating('Boss', 'Scout', { request: 'one' }, 'call-a'), chief: delegating('Chief', 'Scout', { request: 'two' }, 'call-b'), scout: counting });
  assert.equal((await c.turn([{ text: 'first' }], a)).text, 'Boss: "saw 1"');
  assert.equal((await c.turn([{ text: 'second' }], b)).text, 'Chief: "saw 1"', 'B’s Scout starts its own session');
  assert.deepEqual((await c.events('app/Boss/Scout')).filter((e) => e.author === 'user').map((e) => e.content?.parts?.[0]?.text), ['one']);
  assert.deepEqual((await c.events('app/Chief/Scout')).filter((e) => e.author === 'user').map((e) => e.content?.parts?.[0]?.text), ['two']);
  assert.equal(await c.sessionService.get({ appName: 'Scout', userId: 'u', sessionId: 's' }), undefined, 'nothing is filed under the bare name');
});

/** Moves a child session to the key ADK used (the subagent's name), as a conversation stored before ADR 0111 holds it. */
async function storeUnderOldKey(service: InProcessSessionService, from: string, name: string): Promise<void> {
  const moved = await service.get({ appName: from, userId: 'u', sessionId: 's' });
  assert.ok(moved, `no session ${from}`);
  const old = await service.create({ appName: name, userId: 'u', sessionId: 's', state: {} });
  for (const event of moved.events) await service.append(old, structuredClone(event));
  await service.delete({ appName: from, userId: 'u', sessionId: 's' });
}

test('a conversation stored under the old key resumes: the open approval there is found, decided and run, and nothing is filed under the path', async () => {
  const cfg = config({ syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'i' }, subagents: [agent('Scout', { tools: ['np_send'], require_approval: ['np_send'] })] });
  const c = converse(cfg, { boss: delegating('Boss', 'Scout', { request: 'tell ops' }, 'call-scout-1'), scout: delegating('Scout', 'np_send', { to: 'ops@acme.test' }, 'call-send-1') });
  const first = await c.turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required');
  await storeUnderOldKey(c.sessionService, 'app/Boss/Scout', 'Scout');
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(await c.sessionService.get({ appName: 'app/Boss/Scout', userId: 'u', sessionId: 's' }), undefined);
  assert.ok((await c.events('Scout')).some((e) => e.author === 'Scout' && e.content?.parts?.some((p) => p.functionResponse?.name === 'np_send')));
});

test('a conversation stored under the old key continues its subagent’s session on the next call', async () => {
  const cfg = config({ syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'i' }, subagents: [agent('Scout')] });
  const c = converse(cfg, { boss: (req, n) => (result(req) === undefined || n % 2 === 1 ? toolCall('Scout', { request: `ask ${n}` }, `call-scout-${n}`) : answer(`Boss: ${result(req)}`)), scout: counting });
  assert.equal((await c.turn([{ text: 'first' }])).text, 'Boss: "saw 1"');
  await storeUnderOldKey(c.sessionService, 'app/Boss/Scout', 'Scout');
  assert.equal((await c.turn([{ text: 'second' }])).text, 'Boss: "saw 2"', 'the subagent read its earlier exchange');
  assert.equal(await c.sessionService.get({ appName: 'app/Boss/Scout', userId: 'u', sessionId: 's' }), undefined);
});

// ── Over A2A ─────────────────────────────────────────────────────────────────

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function a2a(files: Record<string, string>, scripts: Record<string, ModelScript>) {
  const dir = mkdtempSync(join(tmpdir(), 'melch-nested-pauses-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  process.env.MELCHIZEDEK_AGENTS_DIR = dir;
  resetCircuits();
  sent.length = 0;
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

const DESK_YAML = ['syndicate_name: Desk', 'memory_system: internal-only', 'orchestrator:', '  name: Boss', '  model: scripted/boss', '  instruction: Delegate.', 'subagents:', '  - name: Writer', '    description: Writes.', '    yaml_reference: pipeline.yaml'].join('\n');
const flowYaml = (subagents: string[], workflow: string[]) =>
  ['syndicate_name: Pipeline', 'memory_system: internal-only', 'orchestrator:', '  name: Plan', '  description: Plan', '  model: scripted/plan', '  instruction: Plan.', 'subagents:', ...subagents, 'workflow:', ...workflow].join('\n');

test('over A2A: a nested workflow’s gated node raises the approval data part with the path; "approve" resumes it and completes', async () => {
  const send = await a2a(
    {
      'desk.yaml': DESK_YAML,
      'pipeline.yaml': flowYaml(
        ['  - name: Send', '    description: Send', '    model: scripted/send', '    instruction: Send.', '    tools: [np_send]', '    require_approval: [np_send]', '  - name: Report', '    description: Report', '    model: scripted/report', '    instruction: Report.'],
        ['  edges:', '    - [START, Plan, Send, Report]'],
      ),
    },
    // Each resolution is a fresh model: Send answers from its request alone.
    { ...flowScripts(), send: (request) => (lastToolResult(request) ? answer(`send saw ${JSON.stringify(lastToolResult(request)!.result)}`) : toolCall('np_send', { to: 'ops@acme.test' }, 'call-send-1')) },
  );
  const first = await send([{ kind: 'text', text: 'tell ops' }]);
  assert.equal(first.status.state, 'input-required', statusText(first));
  const request = dataPart(first);
  assert.equal(request.type, 'approval_request');
  assert.equal(request.agent, 'Send');
  assert.deepEqual(request.path, ['Boss', 'Writer', 'Send']);
  const again = await send([{ kind: 'text', text: 'hm?' }], { contextId: first.contextId, taskId: first.id });
  assert.equal(again.status.state, 'input-required');
  assert.equal(dataPart(again).approval_id, request.approval_id);
  assert.deepEqual(sent, []);
  const done = await send([{ kind: 'text', text: 'approve' }], { contextId: first.contextId, taskId: first.id });
  assert.equal(done.status.state, 'completed', statusText(done));
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.match(statusText(done), /sent to ops@acme.test/);
});

test('over A2A: a nested workflow’s ask_user node raises the input request with the path; the reply completes the task', async () => {
  const send = await a2a(
    {
      'desk.yaml': DESK_YAML,
      'pipeline.yaml': flowYaml(['  - name: Edit', '    description: Edit', '    model: scripted/edit', '    instruction: Edit.'], ['  edges:', '    - [START, Plan, Confirm, Edit]', '  nodes:', '    Confirm:', '      ask_user: Publish?']),
    },
    flowScripts(),
  );
  const first = await send([{ kind: 'text', text: 'write about cats' }]);
  assert.equal(first.status.state, 'input-required', statusText(first));
  const request = dataPart(first);
  assert.equal(request.type, 'input_request');
  assert.equal(request.message, 'Publish?');
  assert.deepEqual(request.path, ['Boss', 'Writer', 'Confirm']);
  const done = await send([{ kind: 'text', text: 'yes, publish' }], { contextId: first.contextId, taskId: first.id });
  assert.equal(done.status.state, 'completed', statusText(done));
  assert.match(statusText(done), /edited\(/);
});
