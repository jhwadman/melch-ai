/**
 * lib/workflow/turn.ts — one turn of a workflow syndicate on the native
 * runtime: the message stored, the graph walked by the engine's scheduler,
 * and every event the walk stores yielded in the order it was stored, the
 * node inputs aside, as ADK's Runner yielded them (ADR 0095).
 *
 * WHY this file exists:
 *   runSyndicateTurn (lib/runtime/syndicateTurn.ts) hands this generator to
 *   the turn's reader (drainAgentStream), under the turn's root span, as it
 *   once handed ADK's Runner stream, so the progress lines, onProgress
 *   calls, node errors, the paused input and the ledger rows come out of
 *   the one reader every turn uses. Everything a node does is
 *   the WS4 modules': the scheduler (scheduler.ts), agent nodes on the
 *   native loop (agentNode.ts), tool nodes (toolNode.ts), ask_user nodes and
 *   the workflow's pause record (pause.ts), and the resume rebuilt from the
 *   session (resume.ts). This file wires them for one turn, as ADK's Runner
 *   and Workflow wired theirs:
 *
 *   1. THE MESSAGE. Stored as the user's event under a new `e-` invocation
 *      id, before the walk, as the Runner stored it (runNativeAgent does the
 *      same for one agent). A turn whose signal aborted first stores nothing.
 *   2. THE START. workflowResume rebuilds every node's prior runs and the
 *      answers from the session, as ADK's rehydration did on every message:
 *      with nothing paused every node runs fresh. The walk's input is the
 *      message's text, not its content, as ADK handed its root workflow, and
 *      that text is what the workflow's pause record keeps. A pause only ADK
 *      can resume (UnsupportedWorkflowResumeError) fails the turn; it never
 *      walks afresh and asks the person again.
 *   3. THE WALK. runWorkflowGraph with the runners chained (ask_user, tool,
 *      then agentNodeRuntime for agent nodes and map items), under the
 *      turn's signal. Every event a runner stores goes through the agent
 *      node runtime's one queue, in walk order: node inputs, the agents'
 *      events, tool and ask_user events, route steps, joins and maps, and
 *      the node-error event ADK wrote for a node that gave up
 *      (nodeErrorEvent, on the scheduler's `workflow` node_error). A node's
 *      input turn is stored and not yielded, as ADK's Runner never yielded
 *      it; a node agent's partial (streamed) event is yielded and not
 *      stored, as the Runner yielded it.
 *   4. THE END. A paused walk stores the workflow's own record
 *      (workflowPauseEvent) after every node's event. A walk the turn
 *      stopped (InvocationAbortedError, or any failure once the signal
 *      fired) ends quietly, as ADK's Runner ended an aborted run: the turn
 *      runner reads the stop reason from its control. A node that gave up
 *      rethrows its error once every event is stored and yielded, as ADK's
 *      Runner threw it.
 *   5. THE SPANS. `workflow.invoke <name>` around the walk, `node.execute
 *      <name>` around each node run (the scheduler's traceNode hook), and
 *      `tool.execute <name>` around a tool node's call
 *      (lib/runtime/native/telemetry.ts). An agent node's `agent.invoke`
 *      opens inside its node's span, so each model call is attributed to
 *      its node's agent in the ledger.
 *
 * WHAT IT REFUSES before any model call: refuseUnrunnableNodes throws, for
 * a tool node, ADK's compile-time refusals (an unregistered tool, a
 * long-running one), and an ADK tool (anything with runAsync), which 1.0.0
 * no longer runs. A pause raised inside an agent node is refused by
 * runAgentNode by name.
 *
 * It imports nothing from ADK: the caller passes the tool lookup (the
 * registry's own Tools) and the store as the engine's interface.
 * The message, the answers and every stored event are data the walk
 * carries, never instructions this module acts on.
 */

import { randomUUID } from 'node:crypto';

import type { ModelAdapter } from '../models/contract.ts';
import { APPROVAL_REQUEST } from '../runtime/approvals.ts';
import { createTurnEvent, getFunctionCalls } from '../runtime/events.ts';
import type { TurnContent, TurnEvent, TurnFunctionCall, TurnPart } from '../runtime/events.ts';
import { entrySession } from '../runtime/native/delegate.ts';
import type { WorkflowSubagentEnd } from '../runtime/native/delegate.ts';
import { INPUT_REQUEST } from '../workflowConfig.ts';
import type { MemoryService } from '../runtime/memoryService.ts';
import type { NativeAgent } from '../runtime/native/request.ts';
import type { SelfCorrection } from '../runtime/native/selfCorrection.ts';
import { traceNodeExecution, traceToolNodeCall, traceWorkflowInvocation } from '../runtime/native/telemetry.ts';
import { TEMP_STATE_PREFIX } from '../runtime/sessions.ts';
import type { Session, SessionService } from '../runtime/sessions.ts';
import type { CredentialStore } from '../tools/auth.ts';
import { NodeStoppedError, agentNodeRuntime, nodeInputContent } from './agentNode.ts';
import type { WorkflowGraph } from './graph.ts';
import { askUserNodeRunner, workflowPauseEvent } from './pause.ts';
import { workflowResume } from './resume.ts';
import { InvocationAbortedError, nodeErrorEvent, runWorkflowGraph } from './scheduler.ts';
import type { NodeResult, NodeRun, SchedulerEvent, WorkflowRun } from './scheduler.ts';
import { enrichNodeEvent, resolveToolNode, toolNodeRunner } from './toolNode.ts';

export interface NativeWorkflowParams {
  graph: WorkflowGraph;
  /** Every agent of the syndicate compiled for native, by YAML name. */
  agents: ReadonlyMap<string, NativeAgent>;
  /** The leaf adapter for a model id, for every node agent. */
  adapterFor: (model: string) => ModelAdapter;
  /** The registry entry for a tool node's tool name, or undefined. */
  resolveTool: (name: string) => unknown;
  sessions: SessionService;
  appName: string;
  userId: string;
  sessionId: string;
  /** The message's parts. */
  userParts: unknown[];
  /** The turn's signal: a cancel, the deadline or max_steps stops the walk. */
  signal?: AbortSignal;
  /** Stream text as partial events (the node agents' loops). */
  stream?: boolean;
  memory?: Pick<MemoryService, 'search'>;
  log?: (message: string) => void;
  selfCorrection?: SelfCorrection;
  /** The run's tool credentials, pinned to its app (ADR 0072). */
  credentials?: Pick<CredentialStore, 'get'>;
  /** The agent nodes that are a nested workflow syndicate (ADR 0106) or a nested dispatch syndicate (ADR 0120), by YAML name. */
  workflows?: ReadonlyMap<string, NestedWorkflow | NestedRun>;
}

/** A workflow syndicate run as a node of another (ADR 0106): its graph, its agents, its tool nodes' lookup, and its own nested nodes. */
export interface NestedWorkflow {
  graph: WorkflowGraph;
  agents: ReadonlyMap<string, NativeAgent>;
  resolveTool: (name: string) => unknown;
  workflows?: ReadonlyMap<string, NestedWorkflow | NestedRun>;
}

/** Where a node's own run goes: its child session, the message, the turn's signal. */
export interface NestedRunParams {
  sessions: SessionService;
  appName: string;
  userId: string;
  sessionId: string;
  userParts: unknown[];
  signal?: AbortSignal;
}

/**
 * A node that runs as something other than a graph (ADR 0120): a nested
 * dispatch syndicate, its own turn (lib/runtime/native/delegate.ts
 * nestedDispatchWalk). It runs where a nested workflow's walk runs, on the
 * same child session, and ends as a walk ends.
 */
export interface NestedRun {
  walk(run: NestedRunParams): AsyncGenerator<TurnEvent, WorkflowSubagentEnd | undefined>;
}

/** ADK's AgentTool answer: the last event's non-thought text parts, joined by a newline. */
function lastText(event: TurnEvent | undefined): string {
  return (event?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text)
    .filter((t) => t)
    .join('\n');
}

/** The requests a walk's interrupts are, as a node raises them: an approval request or an input request. */
const RAISED = new Set([APPROVAL_REQUEST, INPUT_REQUEST]);

/** The latest request call, by id, among `ids` that `events` hold (an agent's or a node's, never the user's). */
function requestCalls(events: readonly TurnEvent[], ids: readonly string[], author?: string): Map<string, TurnFunctionCall> {
  const wanted = new Set(ids);
  const calls = new Map<string, TurnFunctionCall>();
  for (let i = events.length - 1; i >= 0 && calls.size < wanted.size; i--) {
    const event = events[i]!;
    if (!event.author || event.author === 'user' || (author !== undefined && event.author !== author)) continue;
    for (const call of getFunctionCalls(event)) {
      if (call.id && call.name && RAISED.has(call.name) && wanted.has(call.id) && !calls.has(call.id)) calls.set(call.id, call);
    }
  }
  return calls;
}

/**
 * Whether a resumed walk's answer to `call` answers it: a decision for an
 * approval request (a ToolConfirmation, or ADK's `{ response: <json> }`
 * form, as lib/workflow/agentNode.ts reads one), any answer for an input
 * request.
 */
function answers(call: TurnFunctionCall | undefined, value: unknown): boolean {
  if (value === undefined || !call) return false;
  if (call.name !== APPROVAL_REQUEST) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  return typeof answer.confirmed === 'boolean' || typeof answer.response === 'string';
}

/** The part that carries `value` down to the nested walk, as the answer to `call`: its explicit reply, under the request's name. */
function answerPart(call: TurnFunctionCall, value: unknown): TurnPart {
  const response = call.name === APPROVAL_REQUEST ? (value as Record<string, unknown>) : { result: value };
  return { functionResponse: { id: call.id, name: call.name, response } };
}

/**
 * A node whose answered interrupts an earlier resume already carried down
 * (another node's answer was the one since): the output it stored after
 * the last event that raised them, else undefined.
 */
function outputAfterRaise(events: readonly TurnEvent[], path: string, ids: readonly string[]): unknown {
  const open = new Set(ids);
  let start = -1;
  events.forEach((event, i) => {
    if (event.nodeInfo?.path === path && (event.longRunningToolIds ?? []).some((id) => open.has(id))) start = i;
  });
  if (start === -1) return undefined;
  for (let i = events.length - 1; i > start; i--) {
    const event = events[i]!;
    if (event.nodeInfo?.path === path && event.output !== undefined && !event.partial) return event.output;
  }
  return undefined;
}

/**
 * The node's pause on its caller's walk (ADR 0119): every request its own
 * walk waits on, raised again as one event of the node's (a copy of each
 * call, stamped with the node's path, the ids in `longRunningToolIds`, the
 * node's input recorded for the resume), so the caller's walk pauses on
 * the same ids, its resume reruns the node with their answers, and the
 * turn finds the request (lib/runtime/native/interrupts.ts follows it down
 * by id to the node that asked). Carries the walk's state writes so far.
 */
function raiseAgain(name: string, run: NodeRun, invocationId: string, calls: TurnFunctionCall[], stateDelta: Record<string, unknown>): TurnEvent {
  const event = createTurnEvent({
    author: name,
    invocationId,
    content: { role: 'model', parts: calls.map((call) => ({ functionCall: structuredClone(call) })) },
    ...(Object.keys(stateDelta).length ? { actions: { stateDelta } } : {}),
  });
  event.longRunningToolIds = calls.map((call) => call.id as string);
  enrichNodeEvent(event, run, { invocationId });
  event.actions = { ...event.actions, agentState: { ...(event.actions?.agentState ?? {}), input: run.input } };
  return event;
}

/**
 * Runs `workflow` as the node `run` names (ADR 0106), as a delegated nested
 * workflow runs (ADR 0098): the whole graph walked on the child session
 * filed under the walk's app name and the node's behind its kind
 * (`<walk's app>/node:<node>`, entryAppName, ADR 0119, ADR 0120; the one
 * under an older key is continued when it ran there before), created from the caller's state the first time, `temp:` keys
 * dropped, and kept; the node's input as its message, its last yielded
 * event's text the node's output. The caller stores one event for the
 * node, carrying that output and the walk's state writes, so a resumed
 * walk completes the node from it.
 *
 * A walk that ends paused (an ask_user node, a gated agent node, a node of
 * its own that is a nested workflow) pauses the node on the same ids
 * (raiseAgain), and the caller's walk with it. Rerun on the resume, the
 * node walks its graph again on the answers among its ids, each as its
 * explicit reply (an approval decision as it came, an input request's
 * answer as `{ result }`), which the nested walk's resume reads as a
 * top-level one's; with none of them answered it waits again without
 * walking; once an earlier resume finished it, its stored output is the
 * node's.
 */
async function runWorkflowNode(
  name: string,
  workflow: NestedWorkflow | NestedRun,
  run: NodeRun,
  params: NativeWorkflowParams,
  parent: { session: Session; invocationId: string; userContent: TurnContent; store: (event: TurnEvent) => void },
): Promise<NodeResult> {
  const { sessions } = params;
  const resumed = run.resumedInterruptIds ?? [];
  let userParts: unknown[];
  if (resumed.length > 0) {
    const raised = requestCalls(parent.session.events, resumed, name);
    const answered = resumed.filter((id) => answers(raised.get(id), run.resumeInputs?.[id]));
    if (answered.length === 0) {
      parent.store(raiseAgain(name, run, parent.invocationId, resumed.map((id) => raised.get(id)).filter((c): c is TurnFunctionCall => !!c), {}));
      return { interruptIds: [...resumed] };
    }
    const finished = answered.length === resumed.length ? outputAfterRaise(parent.session.events, run.path, resumed) : undefined;
    if (finished !== undefined) return { output: finished };
    userParts = answered.map((id) => answerPart(raised.get(id)!, run.resumeInputs![id]));
  } else {
    const input = run.input === undefined || run.input === null ? parent.userContent : nodeInputContent(run.input);
    userParts = input.parts ?? [];
  }
  const state = Object.fromEntries(Object.entries(parent.session.state ?? {}).filter(([k]) => !k.startsWith(TEMP_STATE_PREFIX)));
  const child = await entrySession(sessions, { appName: parent.session.appName, userId: parent.session.userId, sessionId: parent.session.id, events: parent.session.events }, name, 'node', state, resumed.length > 0);
  // A nested dispatch syndicate runs its own turn there (ADR 0120); a nested workflow walks its graph.
  const walk: AsyncGenerator<TurnEvent, NativeWorkflowEnd | WorkflowSubagentEnd | undefined> = 'walk' in workflow
    ? workflow.walk({ sessions, appName: child.appName, userId: child.userId, sessionId: child.id, userParts, ...(run.signal ? { signal: run.signal } : {}) })
    : runNativeWorkflow({
    graph: workflow.graph,
    agents: workflow.agents,
    resolveTool: workflow.resolveTool,
    ...(workflow.workflows ? { workflows: workflow.workflows } : {}),
    sessions,
    appName: child.appName,
    userId: child.userId,
    sessionId: child.id,
    userParts,
    adapterFor: params.adapterFor,
    signal: run.signal,
    stream: false,
    ...(params.memory ? { memory: params.memory } : {}),
    ...(params.log ? { log: params.log } : {}),
    ...(params.selfCorrection ? { selfCorrection: params.selfCorrection } : {}),
    ...(params.credentials ? { credentials: params.credentials } : {}),
  });
  let last: TurnEvent | undefined;
  const stateDelta: Record<string, unknown> = {};
  let end: NativeWorkflowEnd | WorkflowSubagentEnd | undefined;
  for (;;) {
    const next = await walk.next();
    if (next.done) {
      end = next.value;
      break;
    }
    if (next.value.partial) continue;
    for (const [k, v] of Object.entries(next.value.actions?.stateDelta ?? {})) if (!k.startsWith(TEMP_STATE_PREFIX)) stateDelta[k] = v;
    last = next.value;
  }
  if (!end || end.stopped) throw new NodeStoppedError(name, undefined);
  const paused = end.run?.interruptIds ?? [];
  if (paused.length > 0) {
    const walked = (await sessions.get({ appName: child.appName, userId: child.userId, sessionId: child.id }))?.events ?? [];
    // A nested dispatch syndicate names the calls it waits on: they may sit in a route's delegation below its conversation (ADR 0120).
    const named = 'requests' in end && end.requests ? new Map(end.requests.map((call) => [call.id as string, call])) : undefined;
    const raised = named ?? requestCalls(walked, paused);
    const missing = paused.filter((id) => !raised.has(id));
    if (missing.length > 0) throw new Error(`Node '${name}': the ${'walk' in workflow ? 'syndicate' : 'workflow'} it runs paused on ${missing.join(', ')}, which is not an approval request or a question.`);
    parent.store(raiseAgain(name, run, parent.invocationId, paused.map((id) => raised.get(id)!), stateDelta));
    return { interruptIds: [...paused] };
  }
  const output = lastText(last);
  const event = createTurnEvent({
    author: name,
    invocationId: parent.invocationId,
    content: { role: 'model', parts: [{ text: output }] },
    ...(Object.keys(stateDelta).length ? { actions: { stateDelta } } : {}),
  });
  event.output = output;
  event.nodeInfo = { messageAsOutput: true };
  enrichNodeEvent(event, run, { invocationId: parent.invocationId });
  parent.store(event);
  return { output };
}

/** How the walk ended. */
export interface NativeWorkflowEnd {
  /** The walk's result; absent when the turn stopped it. */
  run?: WorkflowRun;
  /** The turn stopped the walk (cancel, deadline, max_steps): the caller reads why from its control. */
  stopped?: boolean;
}

/**
 * Throws, before any model call, what ADK's workflow compile threw for a
 * tool node: an unregistered tool, or a long-running one (ADR 0091).
 */
export function refuseUnrunnableNodes(graph: WorkflowGraph, resolveTool: (name: string) => unknown): void {
  for (const node of graph.nodes.values()) if (node.kind === 'tool') resolveToolNode(node, { resolveTool });
}

const isAborted = (error: unknown): boolean => error instanceof InvocationAbortedError || (error as { name?: unknown } | null)?.name === 'InvocationAbortedError';

/**
 * Runs one turn of the workflow: stores the message, walks the graph (a
 * resume when the session holds a paused walk), and yields every event the
 * walk stores, in the order stored, but the node inputs (ADK's Runner
 * yielded none of them). Returns how the walk ended, or
 * undefined when the signal fired before the message was stored. Throws
 * the error a node gave up with (after its events), ADK's message for a
 * reply that answers nothing, and UnsupportedWorkflowResumeError.
 */
export async function* runNativeWorkflow(params: NativeWorkflowParams): AsyncGenerator<TurnEvent, NativeWorkflowEnd | undefined> {
  const { graph, sessions, appName, userId, sessionId, signal } = params;
  const session = await sessions.get({ appName, userId, sessionId });
  if (!session) throw new Error(`Session not found: ${sessionId} (appName=${appName}, userId=${userId})`);
  if (signal?.aborted) return undefined;
  if (params.userParts.length === 0) throw new Error('No parts in the newMessage.');

  // 1. The message, as the Runner stores it.
  const invocationId = `e-${randomUUID()}`;
  const userContent = { role: 'user', parts: params.userParts } as TurnContent;
  await sessions.append(session, createTurnEvent({ invocationId, author: 'user', content: userContent }));
  if (signal?.aborted) return { stopped: true };

  // 2. The start: the message's text as the input, and every node's prior runs.
  const start = workflowResume({ events: session.events, invocationId, userContent, workflowPath: graph.name });

  // 3. The walk, its events handed on in the order they are stored.
  const queue: TurnEvent[] = [];
  let wake: (() => void) | undefined;
  const runtime = agentNodeRuntime({
    agents: params.agents,
    session,
    sessions,
    invocationId,
    userContent,
    loop: {
      adapterFor: params.adapterFor,
      stream: params.stream ?? false,
      ...(params.memory ? { memory: params.memory } : {}),
      ...(params.log ? { log: params.log } : {}),
      ...(params.selfCorrection ? { selfCorrection: params.selfCorrection } : {}),
      ...(params.credentials ? { credentials: params.credentials } : {}),
    },
    onEvent: (event) => {
      // A node's input turn is appended straight to the session, as ADK's runLlmAgentAsNode appends it: stored, never yielded.
      if (event.author === 'user') return;
      queue.push(event);
      wake?.();
    },
    // A node agent's streamed text, yielded as ADK's Runner yielded its partial events.
    onPartial: (event) => {
      queue.push(event);
      wake?.();
    },
    ...(params.workflows?.size
      ? {
          workflowNodes: {
            has: (name: string) => params.workflows!.has(name),
            run: (name: string, run: NodeRun) => runWorkflowNode(name, params.workflows!.get(name)!, run, params, { session, invocationId, userContent, store }),
          },
        }
      : {}),
  });
  // Every event handed over is queued a microtask later (agentNodeRuntime.store); `stored` waits for all of them.
  const handed = new Set<Promise<unknown>>();
  const store = (event: TurnEvent): void => {
    const queued = runtime.store(event).catch(() => {}); // a store error surfaces from settled()
    handed.add(queued);
    void queued.finally(() => handed.delete(queued));
  };
  const stored = async (): Promise<void> => {
    while (handed.size > 0) await Promise.all([...handed]);
    await runtime.settled();
  };
  const runNode = askUserNodeRunner(
    { invocationId, onEvent: store },
    toolNodeRunner(
      {
        invocationId,
        appName,
        userId,
        sessionId,
        userContent,
        resolveTool: params.resolveTool,
        state: () => session.state,
        ...(params.memory ? { memory: params.memory } : {}),
        ...(params.credentials ? { credentials: params.credentials } : {}),
        onEvent: store,
        traceCall: traceToolNodeCall,
      },
      runtime.runNode,
    ),
  );
  const onEvent = (event: SchedulerEvent): void => {
    runtime.onEvent(event);
    // ADK's reportNodeError: the workflow's own event for a node that gave up.
    if (event.type === 'node_error' && event.source === 'workflow') store(nodeErrorEvent(event, invocationId));
  };

  let end: NativeWorkflowEnd | undefined;
  let failure: { error: unknown } | undefined;
  let finished = false;
  const walk = traceWorkflowInvocation({ name: graph.name, path: graph.name }, { sessionId, invocationId }, async () => {
    try {
      const run = await runWorkflowGraph(graph, {
        input: start.input,
        resume: start.resume,
        runNode,
        onEvent,
        traceNode: traceNodeExecution,
        ...(signal ? { signal } : {}),
      });
      // 4. A paused walk: the workflow's own record, after every node's event.
      if (run.interruptIds.length > 0) store(workflowPauseEvent({ name: graph.name, invocationId, input: start.input, interruptIds: run.interruptIds }));
      await stored();
      return run;
    } catch (error) {
      await stored().catch(() => {});
      throw error;
    }
  }).then(
    (run) => {
      end = { run };
    },
    (error: unknown) => {
      // An aborted run ends without an error, as ADK's Runner ended one; the turn's control holds why.
      if (isAborted(error) || signal?.aborted) end = { stopped: true };
      else failure = { error };
    },
  ).finally(() => {
    finished = true;
    wake?.();
  });

  for (;;) {
    while (queue.length > 0) yield queue.shift()!;
    if (finished) break;
    await new Promise<void>((resolve) => (wake = resolve));
    wake = undefined;
  }
  await walk;
  if (failure) throw failure.error;
  return end;
}
