/**
 * tests/workflowNested.test.ts — a workflow syndicate as a plan-dispatch
 * route or as a node of another workflow (ADR 0106). Either way the
 * `yaml_reference` runs the whole graph, as a delegated subagent does (ADR
 * 0098): on the child session filed under the entry's name, the graph's last
 * yielded event's text the route's answer or the node's output.
 *
 *   - The route runs on both runtimes and stores the same sessions: the
 *     child session holds the walk, the conversation the message and the
 *     route's answer.
 *   - The node runs on native. ADK, which would run a nested Workflow inline
 *     in the caller's session, refuses it by name before the session is
 *     touched.
 *
 * Scripted models, in-memory sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';

import { compileEntrySpec, compileSubagentSpec, compileWorkflowSpec } from '../lib/compile.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { UnsupportedOnRuntimeError } from '../lib/runtime/runtimeFlag.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { compileWorkflow } from '../lib/workflow.ts';
import { forEachRuntime, runtimeOption } from './helpers/runtime.ts';
import { ScriptedModel, answer, requestTexts, shimResolver } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { virtualClock } from './helpers/virtualClock.ts';
import { comparable } from './helpers/workflowParity.ts';

setLogLevel(LogLevel.ERROR);

/** The clock a slow script waits on: a finish order is the scripts' timeline, never a race of real timers (tests/helpers/virtualClock.ts). */
const clock = virtualClock();

const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });

/** The nested workflow: a planner fans out to a writer and a checker, a join hands both to an editor. */
function pipeline(): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Pipeline',
      memory_system: 'internal-only',
      orchestrator: agent('Plan'),
      subagents: [agent('Write'), agent('Check'), agent('Edit')],
      workflow: { edges: [['START', 'Plan', ['Write', 'Check']], [['Write', 'Check'], 'Both', 'Edit']], nodes: { Both: { join: true } } },
    },
    'pipeline.yaml',
  ) as SyndicateYamlConfig;
}

const writer = { name: 'Writer', description: 'Writes an article.', yaml_reference: 'pipeline.yaml' };

/** A plan-dispatch desk: a classifier, the nested workflow as a route, and a plain chat route. */
function desk(): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Desk',
      memory_system: 'internal-only',
      orchestrator: agent('Router'),
      subagents: [writer, agent('Chat')],
      dispatch: { default_route: 'Chat' },
    },
    'desk.yaml',
  ) as SyndicateYamlConfig;
}

/** A workflow whose middle node is the nested workflow: Brief → Writer (the pipeline) → Publish. */
function newsroom(): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Newsroom',
      memory_system: 'internal-only',
      orchestrator: agent('Brief'),
      subagents: [writer, agent('Publish')],
      workflow: { edges: [['START', 'Brief', 'Writer', 'Publish']] },
    },
    'newsroom.yaml',
  ) as SyndicateYamlConfig;
}

const lastText = (request: ModelRequest) => requestTexts(request).at(-1) ?? '';

/** Scripts whose finish times stay 30 ms apart on the virtual clock where a fan-out runs two nodes at once. */
function scripts(): Record<string, ModelScript> {
  return {
    router: (request) => answer(/cats/.test(lastText(request).split('--- MESSAGE TO CLASSIFY ---').at(-1)!) ? '{"route":"Writer","reason":"an article"}' : '{"route":"Chat"}'),
    chat: (request) => answer(`chat(${lastText(request)})`),
    brief: (request) => answer(`brief(${lastText(request)})`),
    plan: (request) => answer(`plan(${lastText(request)})`),
    write: (request) => answer(`draft(${lastText(request)})`),
    check: async (request) => {
      await clock.sleep(30);
      return answer(`claims(${lastText(request)})`);
    },
    edit: (request) => answer(`edited(${lastText(request)})`),
    publish: (request) => answer(`published(${lastText(request)})`),
  };
}

const edited = (input: string) => `edited({"Write":"draft(plan(${input}))","Check":"claims(plan(${input}))"})`;

interface Conversation {
  turn(text: string): Promise<SyndicateTurnResult>;
  models: Record<string, ScriptedModel>;
  events(appName: string): Promise<TurnEvent[]>;
}

function conversation(cfg: SyndicateYamlConfig, runtime?: 'adk' | 'native', script: Record<string, ModelScript> = scripts()): Conversation {
  const models = Object.fromEntries(Object.entries(script).map(([key, s]) => [key, new ScriptedModel(`scripted/${key}`, s)]));
  const sessionService = new InMemorySessionService();
  return {
    models,
    turn: (text) =>
      runSyndicateTurn({
        ...(runtime ? { runtime } : runtimeOption()),
        config: cfg,
        parts: [{ text }],
        appName: 'app',
        userId: 'u',
        sessionId: 's',
        sessionService,
        compile: { resolveModel: shimResolver(models), loadNested: () => pipeline(), log: () => {} },
        trace: false,
      }),
    events: async (appName) => JSON.parse(JSON.stringify((await sessionService.getSession({ appName, userId: 'u', sessionId: 's' }))?.events ?? [])) as TurnEvent[],
  };
}

// ── As a plan-dispatch route ─────────────────────────────────────────────────

forEachRuntime('a dispatch route that is a workflow syndicate runs the whole graph; its last output is the answer', async () => {
  const { turn, models, events } = conversation(desk());
  const result = await turn('write me something on cats');
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.route?.route, 'Writer');
  assert.equal(result.text, edited('write me something on cats'));
  for (const key of ['plan', 'write', 'check', 'edit']) assert.equal(models[key]!.calls, 1, `${key} ran once`);
  assert.equal(lastText(models.plan!.requests[0]!), 'write me something on cats', 'the first node gets the message');
  // The walk is the route's child session, every node path rooted at the entry's name.
  const child = await events('Writer');
  assert.deepEqual([...new Set(child.map((e) => e.nodeInfo?.path).filter(Boolean))].sort(), ['Writer.Both', 'Writer.Check', 'Writer.Edit', 'Writer.Plan', 'Writer.Write']);
  // The conversation holds the message and the route's answer, as any route's exchange.
  const shared = await events('app');
  assert.deepEqual(
    shared.map((e) => [e.author, e.content?.parts?.[0]?.text]),
    [
      ['user', 'write me something on cats'],
      ['Writer', result.text],
    ],
  );
});

forEachRuntime('the next turn reads the workflow route’s exchange as any route’s', async () => {
  const { turn, models } = conversation(desk());
  await turn('write me something on cats');
  const second = await turn('thanks!');
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(second.route?.route, 'Chat');
  const digest = requestTexts(models.router!.requests[1]!).join('\n');
  assert.match(digest, /write me something on cats/);
  assert.ok(digest.includes(edited('write me something on cats')), 'the classifier sees the route’s answer');
});

test('a workflow route stores the same sessions and sends the same requests on both runtimes', async () => {
  const run = async (runtime: 'adk' | 'native') => {
    const c = conversation(desk(), runtime);
    const result = await c.turn('write me something on cats');
    return { result, models: c.models, shared: await c.events('app'), child: await c.events('Writer') };
  };
  const adk = await run('adk');
  const native = await run('native');
  assert.equal(native.result.status, adk.result.status);
  assert.equal(native.result.text, adk.result.text);
  assert.deepEqual(comparable(native.child), comparable(adk.child), 'the child session');
  assert.deepEqual(comparable(native.shared), comparable(adk.shared), 'the conversation');
  for (const key of Object.keys(adk.models)) {
    const strip = (m: ScriptedModel) => m.requests.map(({ signal: _s, ...r }) => r);
    assert.deepEqual(strip(native.models[key]!), strip(adk.models[key]!), `the requests ${key} received`);
  }
});

forEachRuntime('a node of the workflow route that gives up fails the turn at the dispatch stage', async () => {
  const { turn } = conversation(desk(), undefined, { ...scripts(), edit: () => { throw new Error('the editor broke'); } });
  const result = await turn('write me something on cats');
  assert.equal(result.status, 'failed');
  assert.equal(result.failedStage, 'dispatch');
  assert.equal(result.error?.code, 'NODE_FAILED');
  assert.match(result.error?.message ?? '', /the editor broke/);
});

// ── As a workflow node ───────────────────────────────────────────────────────

test('native: a workflow node that is a workflow syndicate runs the whole graph; its last output is the node’s', async () => {
  const { turn, models, events } = conversation(newsroom(), 'native');
  const result = await turn('cats');
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(lastText(models.plan!.requests[0]!), 'brief(cats)', 'the nested graph gets the node’s input');
  assert.equal(result.text, `published(${edited('brief(cats)')})`);
  for (const key of ['brief', 'plan', 'write', 'check', 'edit', 'publish']) assert.equal(models[key]!.calls, 1, `${key} ran once`);
  const child = await events('Writer');
  assert.deepEqual([...new Set(child.map((e) => e.nodeInfo?.path).filter(Boolean))].sort(), ['Writer.Both', 'Writer.Check', 'Writer.Edit', 'Writer.Plan', 'Writer.Write']);
  // The caller's walk stores one event for the node, carrying its output, so a resume completes it.
  const node = (await events('app')).filter((e) => e.nodeInfo?.path === 'Newsroom.Writer');
  assert.equal(node.length, 1);
  assert.equal(node[0]!.output, edited('brief(cats)'));
  assert.deepEqual(node[0]!.nodeInfo?.outputFor, ['Newsroom.Writer']);
});

test('native: a resumed walk completes a finished workflow node from its stored output, without walking it again', async () => {
  const cfg = validateSyndicateConfig(
    {
      syndicate_name: 'Newsroom',
      memory_system: 'internal-only',
      orchestrator: agent('Brief'),
      subagents: [writer, agent('Publish')],
      workflow: { edges: [['START', 'Brief', 'Writer', 'Confirm', 'Publish']], nodes: { Confirm: { ask_user: 'Publish it?' } } },
    },
    'newsroom.yaml',
  ) as SyndicateYamlConfig;
  const { turn, models } = conversation(cfg, 'native');
  const first = await turn('cats');
  assert.equal(first.status, 'input-required', first.error?.message);
  const second = await turn('yes');
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(models.plan!.calls, 1, 'the nested graph ran once');
  assert.match(second.text, /^published\(/);
  assert.ok(second.text.includes('yes'));
});

test('adk: a workflow node that is a workflow syndicate is refused by name before the session is touched', async () => {
  const models = Object.fromEntries(Object.entries(scripts()).map(([key, s]) => [key, new ScriptedModel(`scripted/${key}`, s)]));
  const sessionService = new InMemorySessionService();
  await assert.rejects(
    runSyndicateTurn({ runtime: 'adk', config: newsroom(), parts: [{ text: 'cats' }], appName: 'app', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: shimResolver(models), loadNested: () => pipeline(), log: () => {} }, trace: false }),
    (e: unknown) => e instanceof UnsupportedOnRuntimeError && /^Newsroom: a workflow syndicate as a workflow node \(Writer\) is not supported on the adk runtime yet/.test((e as Error).message),
  );
  assert.equal(await sessionService.getSession({ appName: 'app', userId: 'u', sessionId: 's' }), undefined);
  assert.equal(models.brief!.calls, 0);
  // compileWorkflow, which builds ADK's Workflow, refuses it too.
  await assert.rejects(compileWorkflow(newsroom(), { resolveModel: shimResolver(models), loadNested: () => pipeline(), log: () => {} }), /a workflow syndicate as a workflow node \(Writer, yaml_reference pipeline\.yaml\)/);
});

// ── Compile ──────────────────────────────────────────────────────────────────

test('compile: an entry naming a workflow syndicate is its whole graph; as one agent it is refused by name', async () => {
  const models = Object.fromEntries(Object.keys(scripts()).map((key) => [key, new ScriptedModel(`scripted/${key}`, () => answer(''))]));
  const opts = { resolveModel: shimResolver(models), loadNested: () => pipeline(), log: () => {} };
  const entry = await compileEntrySpec(writer as SubagentYamlConfig, opts);
  assert.equal(entry.kind, 'workflow');
  assert.ok(entry.kind === 'workflow');
  assert.equal(entry.workflow.name, 'Writer');
  assert.deepEqual(entry.workflow.agents.map((a) => a.yaml.name), ['Plan', 'Write', 'Check', 'Edit']);
  await assert.rejects(compileSubagentSpec(writer as SubagentYamlConfig, opts), /pipeline\.yaml: 'Writer' is a workflow syndicate, which runs as its whole graph, not as one agent/);
  const spec = await compileWorkflowSpec(newsroom(), opts);
  assert.deepEqual(spec.agents.map((a) => a.yaml.name), ['Brief', 'Publish']);
  assert.deepEqual(spec.workflows.map((w) => [w.yaml.name, w.workflow.name]), [['Writer', 'Writer']]);
});

test('compile: a map over a workflow syndicate is refused by name', async () => {
  const cfg = validateSyndicateConfig(
    { syndicate_name: 'Fan', memory_system: 'internal-only', orchestrator: agent('Split'), subagents: [writer], workflow: { edges: [['START', 'Split', 'Each']], nodes: { Each: { map: 'Writer' } } } },
    'fan.yaml',
  ) as SyndicateYamlConfig;
  await assert.rejects(compileWorkflowSpec(cfg, { loadNested: () => pipeline(), log: () => {} }), /Fan: the map node 'Each' runs 'Writer', a workflow syndicate \(pipeline\.yaml\); a map runs one agent per item/);
});

test('a nested workflow with an ask_user node is refused by name as a route and as a node', async () => {
  const asking = validateSyndicateConfig(
    { syndicate_name: 'Pipeline', memory_system: 'internal-only', orchestrator: agent('Plan'), subagents: [agent('Edit')], workflow: { edges: [['START', 'Plan', 'Confirm', 'Edit']], nodes: { Confirm: { ask_user: 'Go?' } } } },
    'pipeline.yaml',
  ) as SyndicateYamlConfig;
  for (const cfg of [desk(), newsroom()]) {
    const models = Object.fromEntries(Object.entries(scripts()).map(([key, s]) => [key, new ScriptedModel(`scripted/${key}`, s)]));
    await assert.rejects(
      runSyndicateTurn({ runtime: 'native', config: cfg, parts: [{ text: 'cats' }], appName: 'app', userId: 'u', sessionId: 's', sessionService: new InMemorySessionService(), compile: { resolveModel: shimResolver(models), loadNested: () => asking, log: () => {} }, trace: false }),
      /pipeline\.yaml: the ask_user node 'Confirm' pauses for a person, which a workflow nested in another syndicate \(Writer\) cannot carry to its caller/,
    );
  }
});


