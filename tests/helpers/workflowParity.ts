/**
 * tests/helpers/workflowParity.ts — one workflow syndicate run with
 * scripted models and held equal to ADK's recorded side, for the workflow
 * parity suites.
 *
 * `onNativeTurn` runs the turn (runSyndicateTurn: lib/workflow/turn.ts).
 * `adkSide` is ADK's side as the suites compare it, recorded in
 * tests/fixtures/adk-reference by WS5-2a before 1.0.0 removed ADK
 * (tests/helpers/adkReference.ts). `onNative`
 * drives the native modules by hand, as the turn wires them: the user's
 * message stored as the Runner stores it, then the scheduler
 * (lib/workflow/scheduler.ts) with the ask_user and tool node runners
 * chained onto agentNodeRuntime (lib/workflow/agentNode.ts), every agent
 * compiled for native. `bothAgree` holds all three equal. `comparable`
 * drops what differs per run (ids, times, the invocation id). No network.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { compileNativeSubagent } from '../../lib/compileNative.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../../lib/loadSyndicate.ts';
import type { ModelAdapter, ModelRequest } from '../../lib/models/contract.ts';
import { createTurnEvent } from '../../lib/runtime/events.ts';
import type { TurnContent, TurnEvent } from '../../lib/runtime/events.ts';
import type { NativeAgent } from '../../lib/runtime/native/request.ts';
import { InProcessSessionService } from '../../lib/runtime/sessions.ts';
import { drainAgentStream, runSyndicateTurn } from '../../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../../lib/syndicateSchema.ts';
import { resolveTools } from '../../lib/toolRegistry.ts';
import { agentNodeRuntime } from '../../lib/workflow/agentNode.ts';
import { askUserNodeRunner, workflowPauseEvent } from '../../lib/workflow/pause.ts';
import { buildWorkflowGraph } from '../../lib/workflow/graph.ts';
import { runWorkflowGraph } from '../../lib/workflow/scheduler.ts';
import type { NodeRunner } from '../../lib/workflow/scheduler.ts';
import { toolNodeRunner } from '../../lib/workflow/toolNode.ts';
import { ScriptedModel, shimResolver } from './scriptedModel.ts';
import type { ModelScript } from './scriptedModel.ts';
import type { AdkReference } from './adkReference.ts';

export const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });

export function workflowConfig(workflow: Record<string, unknown>, subagents: Record<string, unknown>[], orchestrator: Record<string, unknown> = agent('Triage')): SyndicateYamlConfig {
  return validateSyndicateConfig({ syndicate_name: 'Graph', memory_system: 'internal-only', orchestrator, subagents, workflow }, 'test') as SyndicateYamlConfig;
}

export type Scripts = Record<string, ModelScript>;

/** One side's record of a run. */
export interface Side {
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

/** ADK's side as recorded: a Side whose models are the requests each received (signal aside) and its call count. */
export interface AdkSide extends Omit<Side, 'models'> {
  requests: Record<string, Array<Omit<ModelRequest, 'signal'>>>;
  calls: Record<string, number>;
}

/** A model's requests as a side compares them: the signal aside, in JSON's form (what a recording holds). */
export const requestsOf = (m: ScriptedModel): Array<Omit<ModelRequest, 'signal'>> => JSON.parse(JSON.stringify(m.requests.map(({ signal: _s, ...r }) => r)));

const modelsFor = (scripts: Scripts) => Object.fromEntries(Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));

const routesOf = (events: TurnEvent[]) => Object.fromEntries(events.filter((e) => e.route !== undefined).map((e) => [e.author!, e.route]));

/** The terminal node's output, as both runtimes store it: the last stored output of a node the graph ends on. */
function terminalOutput(cfg: SyndicateYamlConfig, events: TurnEvent[]): unknown {
  const terminals = new Set(buildWorkflowGraph(cfg).terminals.map((n) => `${cfg.syndicate_name}.${n}`));
  return events.filter((e) => e.output !== undefined && terminals.has(e.nodeInfo?.path ?? '')).at(-1)?.output;
}

export async function progressOf(events: TurnEvent[]): Promise<string[]> {
  const progress: string[] = [];
  async function* stream() {
    for (const e of events) yield e as any;
  }
  await drainAgentStream(stream(), { publishToolStatus: true, errorPolicy: 'collect', events: { onProgress: (t: string) => progress.push(t) } });
  return progress;
}

/** Native: the turn as runSyndicateTurn runs it on the engine's scheduler (lib/workflow/turn.ts). */
export async function onNativeTurn(cfg: SyndicateYamlConfig, scripts: Scripts, text: string, state?: Record<string, unknown>): Promise<Side> {
  const models = modelsFor(scripts);
  const sessionService = new InProcessSessionService();
  if (state) await sessionService.create({ appName: 'app', userId: 'u', sessionId: 's', state });
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
    events: { onProgress: (t: string) => progress.push(t) },
  });
  const events = JSON.parse(JSON.stringify((await sessionService.get({ appName: 'app', userId: 'u', sessionId: 's' }))!.events)) as TurnEvent[];
  return { status: r.status, ...(r.error ? { error: r.error.message } : {}), events, models, progress, routes: routesOf(events), output: terminalOutput(cfg, events) };
}

/** ADK's side of case `name`, as recorded. */
export const adkSide = (reference: AdkReference, name: string): Promise<AdkSide> => reference<AdkSide>(name);

/** Every agent of the syndicate compiled for native, by YAML name. */
export async function nativeAgents(cfg: SyndicateYamlConfig): Promise<Map<string, NativeAgent>> {
  const agents = new Map<string, NativeAgent>();
  for (const sub of [{ description: '', ...cfg.orchestrator } as SubagentYamlConfig, ...(cfg.subagents ?? [])]) agents.set(sub.name, await compileNativeSubagent(sub, { log: () => {} }));
  return agents;
}

/** Native by hand: the user's message stored as the Runner stores it, then the scheduler with the agent node runtime. */
export async function onNative(cfg: SyndicateYamlConfig, scripts: Scripts, text: string, state?: Record<string, unknown>): Promise<Side> {
  const models = modelsFor(scripts);
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: 'app', userId: 'u', sessionId: 's', ...(state ? { state } : {}) });
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
  // ask_user and tool nodes first, everything else to the agent runtime; their events on the same queue.
  const runNode: NodeRunner = askUserNodeRunner(
    { invocationId, onEvent: (e) => void runtime.store(e) },
    toolNodeRunner(
      { invocationId, appName: 'app', userId: 'u', sessionId: 's', userContent, resolveTool: (name) => resolveTools([name])[0], state: () => session.state, onEvent: (e) => void runtime.store(e) },
      runtime.runNode,
    ),
  );
  let status = 'completed';
  let error: string | undefined;
  try {
    const run = await runWorkflowGraph(buildWorkflowGraph(cfg), { input: userContent, runNode, onEvent: runtime.onEvent });
    // A paused walk: the workflow's own record, as the turn writes it.
    if (run.interruptIds.length > 0) {
      await runtime.store(workflowPauseEvent({ name: cfg.syndicate_name, invocationId, input: text, interruptIds: run.interruptIds }));
      status = 'input-required';
    }
  } catch (e) {
    status = 'failed';
    error = (e as Error).message;
  }
  await runtime.settled();
  const events = JSON.parse(JSON.stringify((await sessions.get({ appName: 'app', userId: 'u', sessionId: 's' }))!.events)) as TurnEvent[];
  assert.deepEqual(yielded.map((e) => e.id), events.slice(1).map((e) => e.id), 'onEvent sees every stored event, in the order stored');
  return { status, ...(error ? { error } : {}), events, models, progress: await progressOf(yielded), routes: routesOf(events), output: terminalOutput(cfg, events) };
}

/**
 * The stored events without what differs per run: ids, times, the invocation
 * id, ADK's call ids, each interrupt id (by its order of first appearance),
 * and a compaction's span, which must be the times of stored events.
 */
export const comparable = (events: TurnEvent[]): unknown => {
  const times = events.map((e) => e.timestamp);
  const interrupts = [...new Set(events.flatMap((e) => e.longRunningToolIds ?? []))];
  let json = JSON.stringify(
      events.map((e) => {
        const compacted = e as TurnEvent & { isCompacted?: boolean; startTime?: number; endTime?: number };
        if (!compacted.isCompacted) return { ...e, id: '<id>', timestamp: 0, invocationId: '<inv>' };
        assert.ok(times.includes(compacted.startTime!) && times.includes(compacted.endTime!), "a compaction's startTime and endTime are stored events' times");
        return { ...e, id: '<id>', timestamp: 0, invocationId: '<inv>', startTime: 0, endTime: 0 };
      }),
  );
  interrupts.forEach((id, i) => (json = json.split(JSON.stringify(id)).join(JSON.stringify(`<interrupt ${i + 1}>`))));
  return JSON.parse(json, (_k, v) => (typeof v === 'string' && v.startsWith('adk-') ? '<adk-id>' : v));
};

/** Holds a native side equal to ADK's: stored events, requests, routes, output, progress. */
function agrees(native: Side, adk: AdkSide, scripts: Scripts, how: string): void {
  assert.deepEqual(comparable(native.events), comparable(adk.events), `${how}: the stored events`);
  for (const key of Object.keys(scripts)) {
    assert.deepEqual(requestsOf(native.models[key]!), adk.requests[key], `${how}: the requests ${key} received`);
  }
  assert.deepEqual(native.routes, adk.routes, `${how}: the routes`);
  assert.deepEqual(native.output, adk.output, `${how}: the workflow output`);
  assert.deepEqual(native.progress, adk.progress, `${how}: the progress lines`);
}

/**
 * Takes ADK's recorded side of the case, runs it on the native modules by hand, and through the
 * native turn, and holds both native sides equal to ADK's; the turn's status
 * too, which the hand-driven side only approximates.
 */
export async function bothAgree(
  reference: AdkReference,
  name: string,
  cfg: SyndicateYamlConfig,
  scripts: Scripts,
  text: string,
  state?: Record<string, unknown>,
): Promise<{ adk: AdkSide; native: Side; turn: Side }> {
  const adk = await adkSide(reference, name);
  const native = await onNative(cfg, scripts, text, state);
  agrees(native, adk, scripts, 'the native walk');
  const turn = await onNativeTurn(cfg, scripts, text, state);
  agrees(turn, adk, scripts, 'the native turn');
  assert.equal(turn.status, adk.status, 'the native turn: the status');
  assert.equal(turn.error, adk.error, 'the native turn: the error');
  return { adk, native, turn };
}
