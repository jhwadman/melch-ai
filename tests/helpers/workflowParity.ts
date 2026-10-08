/**
 * tests/helpers/workflowParity.ts — one workflow syndicate run on both
 * runtimes with the same scripted models, for the workflow parity suites.
 *
 * `onAdk` runs the turn as it runs today on ADK (runSyndicateTurn, runtime
 * adk: compileWorkflow, ADK's Runner). `onNative` runs it as the native walk
 * does: the user's message stored as the Runner stores it, then the
 * scheduler (lib/workflow/scheduler.ts) with the tool node runner chained
 * onto agentNodeRuntime (lib/workflow/agentNode.ts), every agent compiled
 * for native. `comparable` drops what differs per run (ids, times, the
 * invocation id). No network.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InMemorySessionService } from '@google/adk';

import { compileNativeSubagent } from '../../lib/compileNative.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../../lib/loadSyndicate.ts';
import type { ModelAdapter } from '../../lib/models/contract.ts';
import { createTurnEvent } from '../../lib/runtime/events.ts';
import type { TurnContent, TurnEvent } from '../../lib/runtime/events.ts';
import type { NativeAgent } from '../../lib/runtime/native/request.ts';
import { InProcessSessionService } from '../../lib/runtime/sessions.ts';
import { drainAgentStream, runSyndicateTurn } from '../../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../../lib/syndicateSchema.ts';
import { resolveTools } from '../../lib/toolRegistry.ts';
import { agentNodeRuntime } from '../../lib/workflow/agentNode.ts';
import { buildWorkflowGraph } from '../../lib/workflow/graph.ts';
import { runWorkflowGraph } from '../../lib/workflow/scheduler.ts';
import type { NodeRunner } from '../../lib/workflow/scheduler.ts';
import { toolNodeRunner } from '../../lib/workflow/toolNode.ts';
import { ScriptedModel, shimResolver } from './scriptedModel.ts';
import type { ModelScript } from './scriptedModel.ts';

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

/** ADK: the turn as it runs today. */
export async function onAdk(cfg: SyndicateYamlConfig, scripts: Scripts, text: string, state?: Record<string, unknown>): Promise<Side> {
  const models = modelsFor(scripts);
  const sessionService = new InMemorySessionService();
  if (state) await sessionService.createSession({ appName: 'app', userId: 'u', sessionId: 's', state });
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
export async function nativeAgents(cfg: SyndicateYamlConfig): Promise<Map<string, NativeAgent>> {
  const agents = new Map<string, NativeAgent>();
  for (const sub of [{ description: '', ...cfg.orchestrator } as SubagentYamlConfig, ...(cfg.subagents ?? [])]) agents.set(sub.name, await compileNativeSubagent(sub, { log: () => {} }));
  return agents;
}

/** Native: the user's message stored as the Runner stores it, then the scheduler with the agent node runtime. */
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
  // Tool nodes first, everything else to the agent runtime; the tool's event on the same queue.
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

/** The stored events without what differs per run: ids, times, the invocation id, ADK's call ids. */
export const comparable = (events: TurnEvent[]): unknown =>
  JSON.parse(JSON.stringify(events.map((e) => ({ ...e, id: '<id>', timestamp: 0, invocationId: '<inv>' }))), (_k, v) => (typeof v === 'string' && v.startsWith('adk-') ? '<adk-id>' : v));

/** Runs both sides and holds them equal: stored events, requests, routes, output, progress. */
export async function bothAgree(cfg: SyndicateYamlConfig, scripts: Scripts, text: string, state?: Record<string, unknown>): Promise<{ adk: Side; native: Side }> {
  const adk = await onAdk(cfg, scripts, text, state);
  const native = await onNative(cfg, scripts, text, state);
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
