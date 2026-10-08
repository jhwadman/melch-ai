/**
 * tests/workflowAgentNode.test.ts — an agent as a workflow node on the
 * native runtime (lib/workflow/agentNode.ts) and route derivation
 * (lib/workflow/route.ts), against ADK's Workflow on ADR 0030's routing
 * cases (ADR 0090).
 *
 * Each case runs one workflow syndicate twice with the same scripted models
 * on the engine's contract: once as today's turn runs it on ADK
 * (runSyndicateTurn, runtime adk: compileWorkflow, ADK's Runner), once as
 * the native walk will (the scheduler, lib/workflow/scheduler.ts, with
 * agentNodeRuntime as its runNode and onEvent, every agent compiled for
 * native). The two must store the same events (ids and times aside), send
 * every model the same requests, take the same routes, end on the same
 * output, and publish the same progress lines, which name declared nodes
 * only. The turn runner does not run a workflow on native yet (WS4-6), so
 * the native side is driven here. No network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';

import { compileNativeSubagent } from '../lib/compileNative.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter } from '../lib/models/contract.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import type { TurnContent, TurnEvent } from '../lib/runtime/events.ts';
import type { NativeAgent } from '../lib/runtime/native/request.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { drainAgentStream, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { NodeReportedError, agentNodeRuntime, asNodeAgent, eventOutput, nodeInputContent } from '../lib/workflow/agentNode.ts';
import { buildWorkflowGraph } from '../lib/workflow/graph.ts';
import { routeOf, routeStepEvent } from '../lib/workflow/route.ts';
import { runWorkflowGraph } from '../lib/workflow/scheduler.ts';
import type { NodeRunner } from '../lib/workflow/scheduler.ts';
import { toolNodeRunner } from '../lib/workflow/toolNode.ts';
import { registerTool, resolveTools } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { z } from 'zod';
import { routeOf as configRouteOf } from '../lib/workflowConfig.ts';
import { ScriptedModel, answer, failure, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { importGraph, specifiersOf } from './helpers/importGraph.ts';

setLogLevel(LogLevel.ERROR);

const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });

function config(workflow: Record<string, unknown>, subagents: Record<string, unknown>[], orchestrator: Record<string, unknown> = agent('Triage')): SyndicateYamlConfig {
  return validateSyndicateConfig({ syndicate_name: 'Graph', memory_system: 'internal-only', orchestrator, subagents, workflow }, 'test') as SyndicateYamlConfig;
}

type Scripts = Record<string, ModelScript>;

/** One side's record of a run. */
interface Side {
  status: string;
  error?: string;
  events: TurnEvent[];
  models: Record<string, ScriptedModel>;
  progress: string[];
  /** The route each route step stored, by step. */
  routes: Record<string, unknown>;
  /** The workflow's output: the terminal node's. */
  output: unknown;
}

const modelsFor = (scripts: Scripts) => Object.fromEntries(Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));

const routesOf = (events: TurnEvent[]) => Object.fromEntries(events.filter((e) => e.route !== undefined).map((e) => [e.author!, e.route]));

/** The terminal node's output, as both runtimes store it: the last stored output of a node the graph ends on. */
function terminalOutput(cfg: SyndicateYamlConfig, events: TurnEvent[]): unknown {
  const terminals = new Set(buildWorkflowGraph(cfg).terminals.map((n) => `${cfg.syndicate_name}.${n}`));
  return events.filter((e) => e.output !== undefined && terminals.has(e.nodeInfo?.path ?? '')).at(-1)?.output;
}

async function progressOf(events: TurnEvent[]): Promise<string[]> {
  const progress: string[] = [];
  async function* stream() {
    for (const e of events) yield e as any;
  }
  await drainAgentStream(stream(), { publishToolStatus: true, errorPolicy: 'collect', events: { onProgress: (t: string) => progress.push(t) } });
  return progress;
}

/** ADK: the turn as it runs today. */
async function onAdk(cfg: SyndicateYamlConfig, scripts: Scripts, text: string): Promise<Side> {
  const models = modelsFor(scripts);
  const sessionService = new InMemorySessionService();
  const progress: string[] = [];
  const r = await runSyndicateTurn({
    config: cfg,
    parts: [{ text }],
    appName: 'app',
    userId: 'u',
    sessionId: 's',
    sessionService,
    compile: { resolveModel: shimResolver(models), log: () => {} },
    trace: false,
    runtime: 'adk',
    events: { onProgress: (t: string) => progress.push(t) },
  });
  const events = JSON.parse(JSON.stringify((await sessionService.getSession({ appName: 'app', userId: 'u', sessionId: 's' }))!.events)) as TurnEvent[];
  return { status: r.status, ...(r.error ? { error: r.error.message } : {}), events, models, progress, routes: routesOf(events), output: terminalOutput(cfg, events) };
}

/** Every agent of the syndicate compiled for native, by YAML name. */
async function nativeAgents(cfg: SyndicateYamlConfig): Promise<Map<string, NativeAgent>> {
  const agents = new Map<string, NativeAgent>();
  for (const sub of [{ description: '', ...cfg.orchestrator } as SubagentYamlConfig, ...(cfg.subagents ?? [])]) agents.set(sub.name, await compileNativeSubagent(sub, { log: () => {} }));
  return agents;
}

/** Native: the user's message stored as the Runner stores it, then the scheduler with the agent node runtime. */
async function onNative(cfg: SyndicateYamlConfig, scripts: Scripts, text: string): Promise<Side> {
  const models = modelsFor(scripts);
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: 'app', userId: 'u', sessionId: 's' });
  const invocationId = `e-${randomUUID()}`;
  const userContent: TurnContent = { role: 'user', parts: [{ text }] };
  await sessions.append(session, createTurnEvent({ invocationId, author: 'user', content: userContent }));
  const yielded: TurnEvent[] = [];
  const runtime = agentNodeRuntime({
    agents: await nativeAgents(cfg),
    session,
    sessions,
    invocationId,
    userContent,
    loop: { adapterFor: (model) => models[model.replace(/^scripted\//, '')] as ModelAdapter, stream: false, log: () => {} },
    onEvent: (e) => yielded.push(e),
  });
  // The chain WS4-5 set: tool nodes first, everything else to the agent runtime; the tool's event on the same queue.
  const runNode: NodeRunner = toolNodeRunner(
    { invocationId, appName: 'app', userId: 'u', sessionId: 's', userContent, resolveTool: (name) => resolveTools([name])[0], state: () => session.state, onEvent: (e) => void runtime.store(e) },
    runtime.runNode,
  );
  let status = 'completed';
  let error: string | undefined;
  try {
    await runWorkflowGraph(buildWorkflowGraph(cfg), { input: userContent, runNode, onEvent: runtime.onEvent });
  } catch (e) {
    status = 'failed';
    error = (e as Error).message;
  }
  await runtime.settled();
  const events = JSON.parse(JSON.stringify((await sessions.get({ appName: 'app', userId: 'u', sessionId: 's' }))!.events)) as TurnEvent[];
  assert.deepEqual(yielded.map((e) => e.id), events.slice(1).map((e) => e.id), 'onEvent sees every stored event, in the order stored');
  return { status, ...(error ? { error } : {}), events, models, progress: await progressOf(yielded), routes: routesOf(events), output: terminalOutput(cfg, events) };
}

const comparable = (events: TurnEvent[]): unknown =>
  JSON.parse(JSON.stringify(events.map((e) => ({ ...e, id: '<id>', timestamp: 0, invocationId: '<inv>' }))), (_k, v) => (typeof v === 'string' && v.startsWith('adk-') ? '<adk-id>' : v));

/** Runs both sides and holds them equal: stored events, requests, routes, output, progress. */
async function bothAgree(cfg: SyndicateYamlConfig, scripts: Scripts, text: string): Promise<{ adk: Side; native: Side }> {
  const adk = await onAdk(cfg, scripts, text);
  const native = await onNative(cfg, scripts, text);
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'the stored events');
  for (const key of Object.keys(scripts)) {
    const strip = (m: ScriptedModel) => m.requests.map(({ signal: _s, ...r }) => r);
    assert.deepEqual(strip(native.models[key]!), strip(adk.models[key]!), `the requests ${key} received`);
  }
  assert.deepEqual(native.routes, adk.routes, 'the routes');
  assert.deepEqual(native.output, adk.output, 'the workflow output');
  assert.deepEqual(native.progress, adk.progress, 'the progress lines');
  return { adk, native };
}

// ── Route derivation ─────────────────────────────────────────────────────────

test('routeOf: the route_key property of an object, else the trimmed text, else empty; one function on both paths', () => {
  assert.equal(configRouteOf, routeOf, 'lib/workflowConfig.ts re-exports the one function the ADK path calls');
  assert.equal(routeOf({ route: ' bug ', x: 1 }), 'bug');
  assert.equal(routeOf({ kind: 'article' }, 'kind'), 'article');
  assert.equal(routeOf({ kind: 'article' }), '', 'an absent property is the empty route, which the default catches');
  assert.equal(routeOf({ kind: null }, 'kind'), '');
  assert.equal(routeOf({ kind: 2 }, 'kind'), '2');
  assert.equal(routeOf('  question \n'), 'question');
  assert.equal(routeOf('{"kind":"article"}', 'kind'), '{"kind":"article"}', 'JSON text is text: only an output schema parses it');
  assert.equal(routeOf(['a']), 'a');
  assert.equal(routeOf(true), 'true');
  assert.equal(routeOf(undefined), '');
  assert.equal(routeOf(`${' '.repeat(100_000)}x${'\t'.repeat(100_000)}`), 'x', 'a long run of whitespace trims in linear time');
});

test("routeStepEvent is the event ADK's route step stores", () => {
  const e = routeStepEvent({ name: 'Planner__route', path: 'Graph.Planner__route', branch: undefined, invocationId: 'e-1', output: { kind: 'a' }, route: 'a' });
  assert.deepEqual(
    { ...e, id: '<id>', timestamp: 0 },
    {
      author: 'Planner__route',
      invocationId: 'e-1',
      id: '<id>',
      timestamp: 0,
      actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {} },
      longRunningToolIds: [],
      branch: undefined,
      output: { kind: 'a' },
      route: 'a',
      nodeInfo: { path: 'Graph.Planner__route', outputFor: ['Graph.Planner__route'] },
    },
  );
});

// ── The node rules ───────────────────────────────────────────────────────────

test("a node's input becomes the user turn as ADK's toUserContent makes it", () => {
  assert.deepEqual(nodeInputContent('hi'), { role: 'user', parts: [{ text: 'hi' }] });
  assert.deepEqual(nodeInputContent({ kind: 'a' }), { role: 'user', parts: [{ text: '{"kind":"a"}' }] });
  assert.deepEqual(nodeInputContent({ role: 'model', parts: [{ text: 'x' }] }), { role: 'user', parts: [{ text: 'x' }] });
  assert.deepEqual(nodeInputContent(3), { role: 'user', parts: [{ text: '3' }] });
});

test('includeContents: none unless the agent set it, never for task mode, and the compiled agent is unchanged', () => {
  const plain: NativeAgent = { name: 'A', model: 'm' };
  const node = asNodeAgent(plain);
  assert.equal(node.includeContents, 'none');
  assert.equal(plain.includeContents, undefined, 'a copy');
  const explicit: NativeAgent = { name: 'A', model: 'm', includeContents: 'default' };
  assert.equal(asNodeAgent(explicit), explicit);
  const task: NativeAgent = { name: 'A', model: 'm', mode: 'task' };
  assert.equal(asNodeAgent(task).includeContents, undefined);
});

test("a node's output: the text without thoughts, JSON only with a schema, nothing for a call or a non-model event", () => {
  const ev = (parts: object[], role = 'model') => createTurnEvent({ author: 'A', content: { role, parts } as TurnContent });
  assert.equal(eventOutput({}, ev([{ text: 'thinking', thought: true }, { text: 'a' }, { text: 'b' }])), 'ab');
  assert.equal(eventOutput({}, ev([{ text: '{"k":1}' }])), '{"k":1}');
  assert.deepEqual(eventOutput({ outputSchema: { type: 'OBJECT' } }, ev([{ text: '{"k":1}' }])), { k: 1 });
  assert.equal(eventOutput({ outputSchema: { type: 'OBJECT' } }, ev([{ text: 'not json' }])), 'not json');
  assert.equal(eventOutput({}, ev([{ functionCall: { name: 't', args: {} } }])), undefined);
  assert.equal(eventOutput({}, ev([{ text: 'x' }], 'user')), undefined);
  assert.equal(eventOutput({}, ev([{ text: '' }])), '', "an empty answer is the empty string, as ADK's");
});

// ── ADR 0030's routing cases, both ways ──────────────────────────────────────

const lastText = (req: Parameters<ModelScript>[0]) => requestTexts(req).at(-1) ?? '';

const TEXT_ROUTE = config({ edges: [['START', 'Triage', { bug: 'Fixer', default: 'Other' }]] }, [agent('Fixer'), agent('Other')]);
const textScripts = (verdict: string): Scripts => ({
  triage: () => answer(`  ${verdict}\n`),
  fixer: (req) => answer(`fixed ${lastText(req)}`),
  other: (req) => answer(`other ${lastText(req)}`),
});

test('a chain routes on an agent\'s trimmed text: same events, requests, route and progress as ADK', async () => {
  const { native } = await bothAgree(TEXT_ROUTE, textScripts('bug'), 'it crashes');
  assert.deepEqual(native.routes, { Triage__route: 'bug' });
  assert.equal(native.output, 'fixed   bug\n', 'the next node gets the output as the agent wrote it; only the route is trimmed');
  assert.equal(native.models.other!.calls, 0);
  assert.deepEqual(native.progress, ['Running node: Triage', 'Running node: Fixer'], 'declared nodes only: never the root or the route step');
});

test('a route no key names takes the default edge, as on ADK', async () => {
  const { native } = await bothAgree(TEXT_ROUTE, textScripts('weird'), 'hm');
  assert.deepEqual(native.routes, { Triage__route: 'weird' });
  assert.equal(native.models.fixer!.calls, 0);
  assert.deepEqual(native.progress, ['Running node: Triage', 'Running node: Other']);
});

const JSON_ROUTE = (planner: Record<string, unknown>) =>
  config({ edges: [['START', 'Planner', { article: 'Writer', default: 'Answerer' }]], nodes: { Planner: { route_key: 'kind' } } }, [agent('Writer'), agent('Answerer')], agent('Planner', planner));
const jsonScripts: Scripts = {
  planner: () => answer('{"kind":"article","brief":"on cats"}'),
  writer: (req) => answer(`wrote ${lastText(req)}`),
  answerer: () => answer('answered'),
};

test('a JSON output with an output schema routes on route_key and reaches the next node as JSON', async () => {
  const { native } = await bothAgree(JSON_ROUTE({ outputSchema: { type: 'OBJECT', properties: { kind: { type: 'STRING' }, brief: { type: 'STRING' } } } }), jsonScripts, 'write about cats');
  assert.deepEqual(native.routes, { Planner__route: 'article' });
  assert.equal(native.output, 'wrote {"kind":"article","brief":"on cats"}');
  const planner = native.events.find((e) => e.author === 'Planner')!;
  assert.deepEqual(planner.output, { kind: 'article', brief: 'on cats' });
  assert.deepEqual(planner.nodeInfo, { messageAsOutput: true, path: 'Graph.Planner', outputFor: ['Graph.Planner'] });
});

test('JSON text from an agent without an output schema is text: it routes on the whole text, to the default, as on ADK', async () => {
  const { native } = await bothAgree(JSON_ROUTE({}), jsonScripts, 'write about cats');
  assert.deepEqual(native.routes, { Planner__route: '{"kind":"article","brief":"on cats"}' });
  assert.equal(native.models.writer!.calls, 0);
  assert.equal(native.output, 'answered');
});

test('a task-mode node routes on its finish_task output; it gets no user turn and sees the history', async () => {
  const cfg = config(
    { edges: [['START', 'Lead', 'Extractor', { Lyon: 'Booker', default: 'Other' }]], nodes: { Extractor: { route_key: 'city' } } },
    [
      agent('Extractor', { mode: 'task', outputSchema: { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] } }),
      agent('Booker'),
      agent('Other'),
    ],
    agent('Lead'),
  );
  const scripts: Scripts = {
    lead: () => answer('two nights in Lyon please'),
    extractor: (_req, n) => (n === 1 ? toolCall('finish_task', { city: 'Lyon' }, 'c1') : answer('never asked')),
    booker: (req) => answer(`booked ${lastText(req)}`),
    other: () => answer('other'),
  };
  const { native } = await bothAgree(cfg, scripts, 'go');
  assert.equal(native.models.extractor!.calls, 1, 'the node ends on the successful answer');
  assert.deepEqual(native.routes, { Extractor__route: 'Lyon' });
  assert.equal(native.output, 'booked {"city":"Lyon"}');
  assert.ok(!native.events.some((e) => e.author === 'user' && e.content?.parts?.[0]?.text === 'two nights in Lyon please'), 'no user turn for a task node');
  assert.ok(requestTexts(native.models.extractor!.requests[0]!).some((t) => t.includes('two nights in Lyon please')), "the task node sees the Lead's answer in its history");
});

test("an agent that sets includeContents: default sees the conversation, retold, as on ADK", async () => {
  const cfg = config({ edges: [['START', 'Triage', 'Reader']] }, [agent('Reader', { includeContents: 'default' })]);
  const { native } = await bothAgree(cfg, { triage: () => answer('brief'), reader: (req) => answer(`read ${requestTexts(req).length}`) }, 'start');
  assert.ok(requestTexts(native.models.reader!.requests[0]!).length > 1, 'more than its input');
});

registerTool(
  'agent_node_lookup',
  defineTool({ name: 'agent_node_lookup', description: 'Look something up.', schema: z.object({ q: z.string() }), execute: async ({ q }) => `found ${q}` }),
  { override: true },
);

test('chained with the tool node runner: an agent routes, a tool node runs on its JSON, the next agent reads the result, as on ADK', async () => {
  const cfg = config(
    { edges: [['START', 'Planner', { look: 'Lookup', default: 'Reader' }], ['Lookup', 'Reader']], nodes: { Lookup: { tool: 'agent_node_lookup' } } },
    [agent('Reader')],
    agent('Planner', { outputSchema: { type: 'OBJECT', properties: { route: { type: 'STRING' }, q: { type: 'STRING' } } } }),
  );
  const scripts: Scripts = { planner: () => answer('{"route":"look","q":"cats"}'), reader: (req) => answer(`read ${lastText(req)}`) };
  const { native } = await bothAgree(cfg, scripts, 'go');
  assert.deepEqual(native.routes, { Planner__route: 'look' });
  assert.equal(native.output, 'read {"result":"found cats"}');
  assert.ok(native.progress.includes('Running node: Lookup'), native.progress.join(' | '));
});

test("a node whose model fails, with no output, fails the walk with ADK's NodeReportedError message", async () => {
  const cfg = config({ edges: [['START', 'Triage', { bug: 'Fixer', default: 'Other' }]] }, [agent('Fixer'), agent('Other')]);
  const scripts: Scripts = { triage: () => failure({ code: 'SCRIPTED_DOWN', message: 'the model is down' }), fixer: () => answer('x'), other: () => answer('y') };
  const adk = await onAdk(cfg, scripts, 'go');
  const native = await onNative(cfg, scripts, 'go');
  assert.equal(native.status, 'failed');
  assert.equal(adk.status, 'failed');
  assert.equal(native.error, new NodeReportedError({ nodeName: 'Triage', errorCode: 'SCRIPTED_DOWN', errorMessage: 'the model is down' }).message);
  assert.match(adk.error ?? '', /Triage/);
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'the stored events up to the failure');
  assert.equal(native.models.fixer!.calls + native.models.other!.calls, 0);
});

// ── No ADK ───────────────────────────────────────────────────────────────────

test('route.ts reaches nothing from @google; agentNode.ts names no @google package itself', () => {
  const reached = [...importGraph('lib/workflow/route.ts').values()].flat().filter((s) => !s.startsWith('.'));
  assert.deepEqual(reached.filter((s) => s.startsWith('@google/')), []);
  for (const file of ['lib/workflow/route.ts', 'lib/workflow/agentNode.ts']) {
    assert.deepEqual(specifiersOf(file).filter((s) => s.startsWith('@google/')), [], file);
  }
});
