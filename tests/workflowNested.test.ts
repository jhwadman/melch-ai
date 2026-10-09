/**
 * tests/workflowNested.test.ts — a workflow syndicate as a plan-dispatch
 * route or as a node of another workflow (ADR 0106). Either way the
 * `yaml_reference` runs the whole graph, as a delegated subagent does (ADR
 * 0098): on the child session filed under the entry's name, the graph's last
 * yielded event's text the route's answer or the node's output.
 *
 *   - The route stores the sessions ADK 2.2 stored: the child session holds
 *     the walk, the conversation the message and the route's answer.
 *   - The node's walk is filed the same way; the caller's walk stores one
 *     event for the node, carrying its output.
 *
 * The route's parity case reads ADK's side from
 * tests/fixtures/adk-reference/workflownested (tests/helpers/adkReference.ts).
 * Scripted models, in-memory sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { compileEntrySpec, compileSubagentSpec, compileWorkflowSpec } from '../lib/compile.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { adkReferences } from './helpers/adkReference.ts';
import { ScriptedModel, answer, requestTexts, shimResolver } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { virtualClock } from './helpers/virtualClock.ts';
import { comparable, requestsOf } from './helpers/workflowParity.ts';

// ADK's side of the route's parity case is recorded (tests/fixtures/adk-reference/workflownested).
const reference = adkReferences('workflowNested');

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

function conversation(cfg: SyndicateYamlConfig, script: Record<string, ModelScript> = scripts()): Conversation {
  const models = Object.fromEntries(Object.entries(script).map(([key, s]) => [key, new ScriptedModel(`scripted/${key}`, s)]));
  const service = new InProcessSessionService();
  return {
    models,
    turn: async (text) =>
      runSyndicateTurn({
        config: cfg,
        parts: [{ text }],
        appName: 'app',
        userId: 'u',
        sessionId: 's',
        sessionService: service,
        compile: { resolveModel: shimResolver(models), loadNested: () => pipeline(), log: () => {} },
        trace: false,
      }),
    events: async (appName) => JSON.parse(JSON.stringify((await service.get({ appName, userId: 'u', sessionId: 's' }))?.events ?? [])) as TurnEvent[],
  };
}

// ── As a plan-dispatch route ─────────────────────────────────────────────────

test('a dispatch route that is a workflow syndicate runs the whole graph; its last output is the answer', async () => {
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

test('the next turn reads the workflow route’s exchange as any route’s', async () => {
  const { turn, models } = conversation(desk());
  await turn('write me something on cats');
  const second = await turn('thanks!');
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(second.route?.route, 'Chat');
  const digest = requestTexts(models.router!.requests[1]!).join('\n');
  assert.match(digest, /write me something on cats/);
  assert.ok(digest.includes(edited('write me something on cats')), 'the classifier sees the route’s answer');
});

test('a workflow route stores the same sessions and sends the same requests as ADK recorded', async () => {
  const run = async () => {
    const c = conversation(desk());
    const result = await c.turn('write me something on cats');
    return { result, models: c.models, shared: await c.events('app'), child: await c.events('Writer') };
  };
  const adk = await reference<{ status: string; text: string; shared: TurnEvent[]; child: TurnEvent[]; requests: Record<string, unknown> }>('workflow-route-sessions-and-requests');
  const native = await run();
  assert.equal(native.result.status, adk.status);
  assert.equal(native.result.text, adk.text);
  assert.deepEqual(comparable(native.child), comparable(adk.child), 'the child session');
  assert.deepEqual(comparable(native.shared), comparable(adk.shared), 'the conversation');
  for (const key of Object.keys(adk.requests)) {
    assert.deepEqual(requestsOf(native.models[key]!), adk.requests[key], `the requests ${key} received`);
  }
});

test('a node of the workflow route that gives up fails the turn at the dispatch stage', async () => {
  const { turn } = conversation(desk(), { ...scripts(), edit: () => { throw new Error('the editor broke'); } });
  const result = await turn('write me something on cats');
  assert.equal(result.status, 'failed');
  assert.equal(result.failedStage, 'dispatch');
  assert.equal(result.error?.code, 'NODE_FAILED');
  assert.match(result.error?.message ?? '', /the editor broke/);
});

// ── As a workflow node ───────────────────────────────────────────────────────

test('native: a workflow node that is a workflow syndicate runs the whole graph; its last output is the node’s', async () => {
  const { turn, models, events } = conversation(newsroom());
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
  const { turn, models } = conversation(cfg);
  const first = await turn('cats');
  assert.equal(first.status, 'input-required', first.error?.message);
  const second = await turn('yes');
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(models.plan!.calls, 1, 'the nested graph ran once');
  assert.match(second.text, /^published\(/);
  assert.ok(second.text.includes('yes'));
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
      runSyndicateTurn({ config: cfg, parts: [{ text: 'cats' }], appName: 'app', userId: 'u', sessionId: 's', sessionService: new InProcessSessionService(), compile: { resolveModel: shimResolver(models), loadNested: () => asking, log: () => {} }, trace: false }),
      /pipeline\.yaml: the ask_user node 'Confirm' pauses for a person, which a workflow run as a dispatch route or a workflow node \(Writer\) cannot carry to the turn yet/,
    );
  }
});



// ── The node-run ceiling (ADR 0105) ──────────────────────────────────────────

registerTool(
  'nested_poll',
  defineTool({
    name: 'nested_poll',
    description: 'Polls; routes back to itself until n reaches until.',
    schema: z.object({ n: z.number(), until: z.number(), route: z.string().optional() }),
    execute: async ({ n, until }) => ({ n: n + 1, until, route: n + 1 < until ? 'again' : 'done' }) as unknown as string,
  }),
  { override: true },
);

/** The nested workflow: Triage starts a poll that loops on its route step `until` times, then Done answers. */
const polling = (): SyndicateYamlConfig =>
  validateSyndicateConfig(
    {
      syndicate_name: 'Poller',
      memory_system: 'internal-only',
      orchestrator: agent('Triage'),
      subagents: [agent('Done')],
      workflow: { edges: [['START', 'Triage', 'Poll', { again: 'Poll', default: 'Done' }]], nodes: { Poll: { tool: 'nested_poll' } } },
    },
    'poll.yaml',
  ) as SyndicateYamlConfig;

/** Two nested pollers fanned out and joined. max_steps 6: a ceiling of 120 node runs per walk, and room for the 6 model calls. */
const twoPollers = (): SyndicateYamlConfig =>
  validateSyndicateConfig(
    {
      syndicate_name: 'Twin',
      memory_system: 'internal-only',
      max_steps: 6,
      orchestrator: agent('Brief'),
      subagents: [
        { name: 'Left', description: 'polls', yaml_reference: 'poll.yaml' },
        { name: 'Right', description: 'polls', yaml_reference: 'poll.yaml' },
        agent('Publish'),
      ],
      workflow: { edges: [['START', 'Brief', ['Left', 'Right']], [['Left', 'Right'], 'Both', 'Publish']], nodes: { Both: { join: true } } },
    },
    'twin.yaml',
  ) as SyndicateYamlConfig;

async function pollTurn(until: number): Promise<SyndicateTurnResult> {
  const models = {
    brief: new ScriptedModel('scripted/brief', () => answer('go')),
    triage: new ScriptedModel('scripted/triage', () => answer(JSON.stringify({ n: 0, until }))),
    done: new ScriptedModel('scripted/done', () => answer('polled')),
    publish: new ScriptedModel('scripted/publish', (request) => answer(`published(${lastText(request)})`)),
  };
  return runSyndicateTurn({
    config: twoPollers(),
    parts: [{ text: 'go' }],
    appName: 'app',
    userId: 'u',
    sessionId: 's',
    sessionService: new InProcessSessionService(),
    compile: { resolveModel: shimResolver(models), loadNested: () => polling(), log: () => {} },
    trace: false,
  });
}

test('native: a nested workflow node’s runs count against its own walk’s ceiling, not its caller’s', async () => {
  // Each nested walk runs about 100 nodes (under 120); the two together, about 200, would be over one shared ceiling.
  const result = await pollTurn(50);
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.text, 'published({"Left":"polled","Right":"polled"})');
});

test('native: a nested walk over its own ceiling fails the node, and the turn NODE_RUN_LIMIT', async () => {
  const result = await pollTurn(1_000_000);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'NODE_RUN_LIMIT');
  assert.match(result.error?.message ?? '', /Workflow (Left|Right) reached its limit of 120 node runs/);
});
