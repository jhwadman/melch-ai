/**
 * lib/workflow/agentNode.ts — an agent as a workflow node on the native
 * runtime, as ADK 2.2 runs an LlmAgent node (ADR 0030, ADR 0090).
 *
 * ADK runs an agent node through `runLlmAgentAsNode`
 * (workflow/run_llm_agent_as_node.js) inside its node runner
 * (workflow/node_runner.js). This module is the same run on the native
 * agent loop (lib/runtime/native/agentLoop.ts), rule for rule:
 *
 *   1. THE INPUT IS THE USER TURN. The previous node's output is stored as a
 *      user event on the node's branch before the agent runs: a Content as
 *      it is (role `user`), a string as one text part, anything else as its
 *      JSON. An undefined or null input stores nothing. The event carries no
 *      node path, as ADK appends it straight to the session.
 *   2. THE includeContents RULE. An agent whose YAML does not set
 *      `includeContents` runs with `none`: it sees the current turn, which
 *      is its input, and nothing else of the session. One that sets it keeps
 *      what it set. ADK sets this on the agent itself; here the node runs a
 *      copy, so the compiled agent is unchanged.
 *   3. TASK MODE. A `mode: task` agent gets no user turn and keeps its
 *      includeContents; the loop runs it as a task node (`taskNode`), which
 *      ends on finish_task's successful answer and writes the output on that
 *      event (lib/runtime/native/taskMode.ts, ADR 0081).
 *   4. THE OUTPUT. Outside task mode, each stored model event with content
 *      and no function call carries the node's output: its text (thought
 *      parts left out), or, with an output schema, the text parsed as JSON
 *      when it parses; and `nodeInfo.messageAsOutput` (ADK's maybeSetOutput).
 *      The node's output is the last output an event carried.
 *   5. THE STAMP. Every event the loop stores gets `nodeInfo.path` (the
 *      node's path, `<workflow>.<node>`, or `<workflow>.<map>.<agent>@<i>`
 *      for a map item), `nodeInfo.outputFor` on an event with an output,
 *      and the node's branch when it has none (ADK's enrichEvent). The loop
 *      calls the stamp before it stores each event (`nodeStamp`), after the
 *      outputKey and task hooks, the order ADK applies them in.
 *   6. FAILURE. An event carrying an error code is the node's reported
 *      error; a run that ends with one and no output throws
 *      NodeReportedError with ADK's message, which stops the walk as ADK's
 *      does. A run the turn stopped throws. A run that pauses on a person
 *      (an ask_user tool, an approval) is an interrupt, not run here yet.
 *
 * `agentNodeRuntime` puts it together for the scheduler: a `runNode` for
 * agent nodes and map items, and an `onEvent` that stores the event ADK
 * stores for each route step (lib/workflow/route.ts), so a session the
 * native walk writes holds what ADK's holds, in the same order.
 *
 * NOT HERE: workflow placeholders in an instruction (`{input.field}`,
 * `<field from Node>`; the native request leaves them as written), the
 * events ADK stores for a join or a map node itself, interrupts inside a
 * node (WS4-4a), tool and ask_user nodes (WS4-5, WS4-4a). It imports
 * nothing from ADK.
 */

import { createTurnEvent, getFunctionCalls } from '../runtime/events.ts';
import type { TurnContent, TurnEvent } from '../runtime/events.ts';
import { runAgentLoop } from '../runtime/native/agentLoop.ts';
import type { AgentLoopContext, AgentLoopEnd } from '../runtime/native/agentLoop.ts';
import type { NativeAgent } from '../runtime/native/request.ts';
import type { Session, SessionService } from '../runtime/sessions.ts';
import { routeStepEvent } from './route.ts';
import type { NodeResult, NodeRun, NodeRunner, SchedulerEvent } from './scheduler.ts';

// ── Errors, as ADK names them ────────────────────────────────────────────────

/** A node whose run ended on an error event and produced no output (ADK's NodeReportedError, same message). */
export class NodeReportedError extends Error {
  readonly code: string;
  readonly nodeName: string;
  constructor(options: { nodeName: string; errorCode?: string; errorMessage?: string }) {
    const code = options.errorCode ?? 'UNKNOWN_ERROR';
    const detail = options.errorMessage ?? code;
    super(`Node '${options.nodeName}' failed: ${code === 'UNKNOWN_ERROR' ? detail : `${code}: ${detail}`}`);
    this.name = 'NodeReportedError';
    this.code = code;
    this.nodeName = options.nodeName;
  }
}

/** A node run the turn stopped (cancel, deadline, max_steps): the stop's code and message. */
export class NodeStoppedError extends Error {
  readonly code: string;
  readonly nodeName: string;
  constructor(nodeName: string, stop: { code: string; message: string } | undefined) {
    super(`Node '${nodeName}' stopped: ${stop ? `${stop.code}: ${stop.message}` : 'the turn stopped it'}`);
    this.name = 'NodeStoppedError';
    this.code = stop?.code ?? 'STOPPED';
    this.nodeName = nodeName;
  }
}

// ── The rules, one function each ─────────────────────────────────────────────

/** ADK's isContent: an object with a `parts` array. */
function isContent(value: unknown): value is TurnContent {
  return typeof value === 'object' && value !== null && Array.isArray((value as { parts?: unknown }).parts);
}

/** The user turn a node input becomes (ADK's toUserContent). */
export function nodeInputContent(input: unknown): TurnContent {
  if (isContent(input)) return { ...input, role: 'user' };
  if (typeof input === 'string') return { role: 'user', parts: [{ text: input }] };
  return { role: 'user', parts: [{ text: JSON.stringify(input) }] };
}

/** The agent a node runs: outside task mode, `includeContents: none` unless the agent set it. A copy; the compiled agent is unchanged. */
export function asNodeAgent(agent: NativeAgent): NativeAgent {
  if (agent.mode === 'task' || agent.includeContents !== undefined) return agent;
  return { ...agent, includeContents: 'none' };
}

/** ADK's maybeSetOutput: the output a stored model event carries outside task mode, or undefined when it carries none. */
export function eventOutput(agent: Pick<NativeAgent, 'outputSchema'>, event: TurnEvent): unknown {
  if (event.partial) return undefined;
  if (getFunctionCalls(event).length > 0) return undefined;
  const content = event.content;
  if (!content || content.role !== 'model' || !content.parts) return undefined;
  const text = content.parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('');
  if (agent.outputSchema && text.trim()) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** What a node's stamp has seen: the last output and the last reported error. */
interface NodeStampState {
  output: unknown;
  reported?: { errorCode?: string; errorMessage?: string };
}

/** The stamp the loop applies to each event before it stores it (rules 4 and 5). */
function nodeStamp(agent: NativeAgent, run: Pick<NodeRun, 'path' | 'branch'>, state: NodeStampState): (event: TurnEvent) => void {
  const taskMode = agent.mode === 'task';
  return (event) => {
    if (!taskMode) {
      const output = eventOutput(agent, event);
      if (output !== undefined) {
        event.output = output;
        event.nodeInfo = { ...(event.nodeInfo ?? {}), messageAsOutput: true };
      }
    }
    event.nodeInfo = { ...(event.nodeInfo ?? {}), path: run.path };
    if (event.output !== undefined) {
      event.nodeInfo.outputFor = [run.path];
      state.output = event.output;
    }
    if (run.branch !== undefined && event.branch === undefined) event.branch = run.branch;
    if (event.errorCode !== undefined) state.reported = { errorCode: event.errorCode, ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}) };
  };
}

// ── One node ─────────────────────────────────────────────────────────────────

/** The loop options a node run takes from its caller; the node sets the rest. */
export type AgentNodeLoopOptions = Omit<AgentLoopContext, 'session' | 'sessions' | 'invocationId' | 'userContent' | 'branch' | 'signal' | 'taskNode' | 'nodeStamp'>;

export interface AgentNodeContext {
  session: Session;
  sessions: SessionService;
  /** The workflow run's invocation id: every event of every node carries it. */
  invocationId: string;
  /** The message that started the turn (the invocation's user content). */
  userContent?: TurnContent;
  /** Loop options for every node: adapters, self-correction, memory, streaming. */
  loop?: AgentNodeLoopOptions;
  /** Each event as it is stored, in order. */
  onEvent?: (event: TurnEvent) => void;
  /** Stores the node's user turn; default `sessions.append`. agentNodeRuntime passes its queue. */
  appendInput?: (event: TurnEvent) => Promise<TurnEvent>;
}

/**
 * Runs `agent` as the node `run` names, on the native loop, and resolves
 * with the node's output. Throws NodeReportedError when the run ended on an
 * error with no output, NodeStoppedError when the turn stopped it, and an
 * Error when it paused on a person.
 */
export async function runAgentNode(agent: NativeAgent, run: Pick<NodeRun, 'input' | 'path' | 'branch' | 'signal'>, ctx: AgentNodeContext): Promise<NodeResult> {
  const taskMode = agent.mode === 'task';
  const nodeAgent = asNodeAgent(agent);
  const { session, sessions, invocationId } = ctx;
  if (!taskMode && run.input !== undefined && run.input !== null) {
    const userEvent = createTurnEvent({ author: 'user', invocationId, branch: run.branch, content: nodeInputContent(run.input) });
    const stored = await (ctx.appendInput ?? ((e: TurnEvent) => sessions.append(session, e)))(userEvent);
    ctx.onEvent?.(stored);
  }
  const state: NodeStampState = { output: undefined };
  const loop = runAgentLoop(nodeAgent, {
    ...(ctx.loop ?? {}),
    session,
    sessions,
    invocationId,
    ...(ctx.userContent ? { userContent: ctx.userContent } : {}),
    ...(run.branch !== undefined ? { branch: run.branch } : {}),
    signal: run.signal,
    taskNode: taskMode,
    nodeStamp: nodeStamp(agent, run, state),
  });
  let end: AgentLoopEnd;
  for (;;) {
    const next = await loop.next();
    if (next.done) {
      end = next.value;
      break;
    }
    if (!next.value.partial) ctx.onEvent?.(next.value);
  }
  if (end.reason === 'paused') {
    throw new Error(`Node '${agent.name}' paused on ${(end.pending ?? []).join(', ')}: a pause inside an agent node does not run on the native runtime yet (WS4-4a).`);
  }
  if (end.reason === 'stopped') throw new NodeStoppedError(agent.name, end.stop);
  // ADK's failIfNodeReportedError: an error with an output is not the node's failure.
  if (state.reported && state.output === undefined) throw new NodeReportedError({ nodeName: agent.name, ...state.reported });
  return state.output === undefined ? {} : { output: state.output };
}

// ── The runner the scheduler takes ───────────────────────────────────────────

export interface AgentNodeRuntimeOptions extends Omit<AgentNodeContext, 'appendInput'> {
  /** Every agent of the syndicate, compiled for native, by YAML name. */
  agents: ReadonlyMap<string, NativeAgent>;
  /**
   * Runs every run that is not an agent node or a map item (tool, ask_user),
   * as toolNodeRunner(context, next) hands on what it does not run, so the
   * runners chain. Default: refuses them by name.
   */
  next?: NodeRunner;
}

export interface AgentNodeRuntime {
  /** The scheduler's runNode: agent nodes and map items run here; every other run goes to `next`. */
  runNode: NodeRunner;
  /** The scheduler's onEvent: stores the event ADK stores for each route step. */
  onEvent: (event: SchedulerEvent) => void;
  /** Resolves once every event queued for storage is stored; rejects with the first store error. */
  settled(): Promise<void>;
}

/**
 * The scheduler's node runner for a syndicate's agents, and the store for
 * its route steps' events. Node user turns and route events are stored in
 * the order the walk reaches them, through one queue, so a route step's
 * event lands before its successor's input as on ADK.
 */
export function agentNodeRuntime(options: AgentNodeRuntimeOptions): AgentNodeRuntime {
  const { agents, session, sessions, invocationId } = options;
  let tail: Promise<unknown> = Promise.resolve();
  let failure: { error: unknown } | undefined;
  const enqueue = (event: TurnEvent, onStored?: (stored: TurnEvent) => void): Promise<TurnEvent> => {
    const stored = tail.then(async () => {
      const appended = await sessions.append(session, event);
      onStored?.(appended);
      return appended;
    });
    tail = stored.then(
      () => undefined,
      (error: unknown) => {
        failure ??= { error };
      },
    );
    return stored;
  };
  const ctx: AgentNodeContext = {
    session,
    sessions,
    invocationId,
    ...(options.userContent ? { userContent: options.userContent } : {}),
    ...(options.loop ? { loop: options.loop } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    appendInput: (event) => enqueue(event),
  };
  const agentNamed = (name: string): NativeAgent => {
    const agent = agents.get(name);
    if (!agent) throw new Error(`workflow: '${name}' is not a compiled agent of this syndicate`);
    return agent;
  };
  const runNode: NodeRunner = async (run) => {
    await tail;
    if (failure) throw failure.error;
    const target = run.target;
    if (target.kind === 'agent') return runAgentNode(agentNamed(target.name), run, ctx);
    if (target.kind === 'map_item') return runAgentNode(agentNamed(target.agent), run, ctx);
    if (options.next) return options.next(run);
    throw new Error(`agentNodeRunner runs agent nodes and map items only; ${target.name} is a ${target.kind} run`);
  };
  const onEvent = (event: SchedulerEvent): void => {
    if (event.type !== 'node_end' || event.kind !== 'route') return;
    enqueue(routeStepEvent({ name: event.node, path: event.path, branch: event.branch, invocationId, output: event.output, route: event.route }), options.onEvent).catch(() => {}); // surfaced by runNode and settled()
  };
  return {
    runNode,
    onEvent,
    async settled() {
      await tail;
      if (failure) throw failure.error;
    },
  };
}
