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
 *      and the node's branch when it has none (ADK's enrichEvent, the one
 *      port in lib/workflow/toolNode.ts, enrichNodeEvent). The loop
 *      calls the stamp before it stores each event (`nodeStamp`), after the
 *      outputKey and task hooks, the order ADK applies them in.
 *   6. THE INSTRUCTION SCOPE. The run carries ADK's workflow instruction
 *      scope (`workflowScope`): the node's input, and the output every event
 *      of the invocation stored before the node ran, by node name
 *      (predecessorOutputs, ADK's collectPredecessorOutputs). The request
 *      fills `{x.field}` and `<x.field from Node>` from it
 *      (lib/runtime/native/request.ts, injectSessionState).
 *   7. FAILURE. An event carrying an error code is the node's reported
 *      error; a run that ends with one and no output returns it as the
 *      run's `error`, and the scheduler fails the attempt with
 *      NodeReportedError, ADK's message, retried or stopping the walk as
 *      ADK's does, and reported once (by the node's own event). A run the turn stopped throws. A run that pauses on
 *      an ask_user tool call is refused by name.
 *   8. APPROVALS (ADR 0098). A run that pauses on approval requests (a tool
 *      in the agent's `require_approval`) resolves with their ids as the
 *      node's interrupts: the node waits and the walk ends paused, as an
 *      ask_user node's does. The resumed walk reruns the node with
 *      `resumedInterruptIds`: until every request has a decision among the
 *      answers (a confirmation, never a plain-text message) it waits again
 *      without running, its open requests raised again on one event of the
 *      new run (`waitAgain`), so the run after still resumes them; then the
 *      agent's run continues instead of starting afresh, unless it already
 *      did on an earlier resume, whose stored output is then the node's
 *      (`outputAfter`). No input turn is stored, so the person's answer stays the
 *      latest user event, and the loop's approval resume
 *      (lib/runtime/native/interrupts.ts, ADR 0077) runs or refuses the
 *      pinned call before the next model step, which reads the node's turn
 *      from its input on. ADK's runLlmAgentAsNode stores the input again and
 *      starts the agent afresh, so the pinned call never runs there; ADK
 *      turns refuse gates on workflow nodes instead.
 *
 * `agentNodeRuntime` puts it together for the scheduler: a `runNode` for
 * agent nodes and map items, and an `onEvent` that stores the event ADK
 * stores for each route step (lib/workflow/route.ts), join and map
 * (lib/workflow/nodeEvents.ts), so a session the native walk writes holds
 * what ADK's holds, in the same order.
 *
 * NOT HERE: an ask_user tool call inside a node, a pause inside a map item,
 * tool nodes (lib/workflow/toolNode.ts) and ask_user nodes
 * (lib/workflow/pause.ts). It imports nothing from ADK.
 */

import { APPROVAL_REQUEST } from '../runtime/approvals.ts';
import { createTurnEvent, getFunctionCalls } from '../runtime/events.ts';
import type { TurnContent, TurnEvent } from '../runtime/events.ts';
import { runAgentLoop } from '../runtime/native/agentLoop.ts';
import type { AgentLoopContext, AgentLoopEnd } from '../runtime/native/agentLoop.ts';
import { predecessorOutputs } from '../runtime/native/request.ts';
import type { NativeAgent, WorkflowInstructionScope } from '../runtime/native/request.ts';
import type { Session, SessionService } from '../runtime/sessions.ts';
import { joinNodeEvent, mapNodeEvent } from './nodeEvents.ts';
import { routeStepEvent } from './route.ts';
import { enrichNodeEvent } from './toolNode.ts';
import type { NodeResult, NodeRun, NodeRunner, SchedulerEvent } from './scheduler.ts';

// ── Errors, as ADK names them ────────────────────────────────────────────────

/** A node whose run ended on an error event and produced no output: the scheduler's, which fails the attempt (rule 7). */
export { NodeReportedError } from './scheduler.ts';

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
function nodeStamp(agent: NativeAgent, run: Pick<NodeRun, 'input' | 'path' | 'branch'>, invocationId: string, state: NodeStampState): (event: TurnEvent) => void {
  const taskMode = agent.mode === 'task';
  return (event) => {
    if (!taskMode) {
      const output = eventOutput(agent, event);
      if (output !== undefined) {
        event.output = output;
        event.nodeInfo = { ...(event.nodeInfo ?? {}), messageAsOutput: true };
      }
    }
    enrichNodeEvent(event, run, { invocationId });
    // ADK's node runner (consume): an event that raises an interrupt records the node's input for the resume.
    if (event.longRunningToolIds?.length) event.actions = { ...event.actions, agentState: { ...(event.actions?.agentState ?? {}), input: run.input } };
    if (event.output !== undefined) state.output = event.output;
    if (event.errorCode !== undefined) state.reported = { errorCode: event.errorCode, ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}) };
  };
}

/** Whether `event` carries the approval request `id` (an `adk_request_confirmation` call). */
function isApprovalRequest(event: TurnEvent | undefined, id: string): boolean {
  return !!event && getFunctionCalls(event).some((call) => call.id === id && call.name === APPROVAL_REQUEST);
}

/**
 * Whether a resumed walk's answer to an approval request is a decision: a
 * ToolConfirmation (`{ confirmed }`), or ADK's `{ response: <json> }` form.
 * A plain-text message the resume read as the answer is not one, and the
 * node keeps waiting.
 */
function isApprovalAnswer(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  return typeof answer.confirmed === 'boolean' || typeof answer.response === 'string';
}

/**
 * Rule 8, a node whose decided requests an earlier resume already acted on
 * (another node's approval was the one answered since): the output its run
 * stored after the last of those requests, else undefined. The node does
 * not run again.
 */
function outputAfter(events: readonly TurnEvent[], path: string, ids: readonly string[]): unknown {
  const open = new Set(ids);
  let start = -1;
  events.forEach((event, i) => {
    if (getFunctionCalls(event).some((call) => call.name === APPROVAL_REQUEST && call.id !== undefined && open.has(call.id))) start = i;
  });
  if (start === -1) return undefined;
  for (let i = events.length - 1; i > start; i--) {
    const event = events[i]!;
    if (event.nodeInfo?.path === path && event.output !== undefined && !event.partial) return event.output;
  }
  return undefined;
}

/**
 * Rule 8, a node still waiting: its open requests raised again, as one event
 * of this run (a copy of each request call, stamped as the node's), so the
 * next message's resume finds the walk paused in this invocation as in the
 * one before; nothing runs. Resolves with the ids it waits on.
 */
async function waitAgain(agent: NativeAgent, run: Pick<NodeRun, 'input' | 'path' | 'branch'>, ctx: AgentNodeContext, waiting: string[]): Promise<NodeResult> {
  const open = new Set(waiting);
  const calls = ctx.session.events.flatMap((event) => getFunctionCalls(event).filter((call) => call.name === APPROVAL_REQUEST && call.id !== undefined && open.has(call.id)));
  const seen = new Set<string>();
  const parts = calls.filter((call) => !seen.has(call.id!) && seen.add(call.id!)).map((call) => ({ functionCall: structuredClone(call) }));
  const event = createTurnEvent({ author: agent.name, invocationId: ctx.invocationId, content: { role: 'model', parts } });
  event.longRunningToolIds = [...seen];
  nodeStamp(agent, run, ctx.invocationId, { output: undefined })(event);
  const stored = await (ctx.appendInput ?? ((e: TurnEvent) => ctx.sessions.append(ctx.session, e)))(event);
  ctx.onEvent?.(stored);
  return { interruptIds: [...seen] };
}

// ── One node ─────────────────────────────────────────────────────────────────

/** The loop options a node run takes from its caller; the node sets the rest. */
export type AgentNodeLoopOptions = Omit<AgentLoopContext, 'session' | 'sessions' | 'invocationId' | 'userContent' | 'branch' | 'signal' | 'taskNode' | 'nodeStamp' | 'workflowScope'>;

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
  /** Each partial (streamed, never stored) event the node's loop yields, as it yields it. */
  onPartial?: (event: TurnEvent) => void;
  /** Stores the node's user turn; default `sessions.append`. agentNodeRuntime passes its queue. Called synchronously, before the run's first await. */
  appendInput?: (event: TurnEvent) => Promise<TurnEvent>;
}

/**
 * Runs `agent` as the node `run` names, on the native loop, and resolves
 * with the node's output, or with the error it reported when it ended on
 * one with no output. Throws NodeStoppedError when the turn stopped it, and
 * an Error when it paused on a person.
 */
export async function runAgentNode(
  agent: NativeAgent,
  run: Pick<NodeRun, 'input' | 'path' | 'branch' | 'signal' | 'resumeInputs' | 'resumedInterruptIds'>,
  ctx: AgentNodeContext,
): Promise<NodeResult> {
  const taskMode = agent.mode === 'task';
  const nodeAgent = asNodeAgent(agent);
  const { session, sessions, invocationId } = ctx;
  // Rule 8: a node that waited on an approval resumes its own run once every request it raised is answered.
  const resumed = run.resumedInterruptIds ?? [];
  if (resumed.length > 0) {
    const waiting = resumed.filter((id) => !isApprovalAnswer(run.resumeInputs?.[id]));
    if (waiting.length > 0) return waitAgain(agent, run, ctx, waiting);
    const finished = outputAfter(ctx.session.events, run.path, resumed);
    if (finished !== undefined) return { output: finished };
  }
  if (resumed.length === 0 && !taskMode && run.input !== undefined && run.input !== null) {
    const userEvent = createTurnEvent({ author: 'user', invocationId, branch: run.branch, content: nodeInputContent(run.input) });
    const stored = await (ctx.appendInput ?? ((e: TurnEvent) => sessions.append(session, e)))(userEvent);
    ctx.onEvent?.(stored);
  }
  // ADK's withWorkflowInstructionScope: the input, and the outputs stored before the node runs.
  const workflowScope: WorkflowInstructionScope = { input: run.input, outputsByNode: predecessorOutputs(session.events, invocationId) };
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
    nodeStamp: nodeStamp(agent, run, invocationId, state),
    workflowScope,
  });
  let end: AgentLoopEnd;
  for (;;) {
    const next = await loop.next();
    if (next.done) {
      end = next.value;
      break;
    }
    if (next.value.partial) ctx.onPartial?.(next.value);
    else ctx.onEvent?.(next.value);
  }
  if (end.reason === 'paused') {
    // Rule 8: an approval request pauses the node, and the walk with it; any other pause (an ask_user call) is refused.
    const pending = end.pending ?? [];
    if (pending.length > 0 && pending.every((id) => isApprovalRequest(end.lastEvent, id))) return { interruptIds: [...pending] };
    throw new Error(`Node '${agent.name}' paused on ${pending.join(', ')}: a pause inside an agent node other than an approval does not run on the native runtime yet.`);
  }
  if (end.reason === 'stopped') throw new NodeStoppedError(agent.name, end.stop);
  // ADK's failIfNodeReportedError: an error with an output is not the node's failure. Without one the error is
  // returned, not thrown: the scheduler fails the attempt with its own NodeReportedError (this class's message), which
  // it knows the node reported, so it writes no node-error event of its own, as ADK writes none (ADR 0095).
  if (state.reported && state.output === undefined) {
    const code = state.reported.errorCode ?? 'UNKNOWN_ERROR';
    return { error: { code, message: state.reported.errorMessage ?? code } };
  }
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
  /**
   * The agent nodes that are a nested workflow syndicate (ADR 0106), by YAML
   * name, and how one runs: lib/workflow/turn.ts walks the nested graph on
   * its own child session. A name here is never looked up in `agents`.
   */
  workflowNodes?: { has(name: string): boolean; run(name: string, run: NodeRun): Promise<NodeResult> };
}

export interface AgentNodeRuntime {
  /** The scheduler's runNode: agent nodes and map items run here; every other run goes to `next`. */
  runNode: NodeRunner;
  /** The scheduler's onEvent: stores the event ADK stores for each route step, join and map. */
  onEvent: (event: SchedulerEvent) => void;
  /**
   * Stores an event another runner of the chain made (a tool node's, through
   * its context's onEvent) on the same queue, in walk order, and hands it to
   * the `onEvent` option once stored.
   */
  store(event: TurnEvent): Promise<TurnEvent>;
  /** Resolves once every event queued for storage is stored; rejects with the first store error. */
  settled(): Promise<void>;
}

/**
 * The scheduler's node runner for a syndicate's agents, and the store for
 * its route steps' events. Node user turns and route events are stored in
 * the order the walk reaches them, through one queue, so a route step's
 * event lands before its successor's input, as ADK's recorded walks have it.
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
    ...(options.onPartial ? { onPartial: options.onPartial } : {}),
    // An event queued before the input that failed to store stops the node before its agent runs.
    appendInput: async (event) => {
      const stored = await enqueue(event);
      if (failure) throw failure.error;
      return stored;
    },
  };
  const agentNamed = (name: string): NativeAgent => {
    const agent = agents.get(name);
    if (!agent) throw new Error(`workflow: '${name}' is not a compiled agent of this syndicate`);
    return agent;
  };
  // A node's user turn is queued as the node starts, in the same synchronous pass, as ADK's runLlmAgentAsNode appends it
  // straight to the session; so it lands after every event queued before it (a route step's, a predecessor's) and
  // before the events other runners hand over in that pass (`store`, below).
  const runNode: NodeRunner = async (run) => {
    if (failure) throw failure.error;
    const target = run.target;
    if (target.kind === 'agent' && options.workflowNodes?.has(target.name)) return options.workflowNodes.run(target.name, run);
    if (target.kind === 'agent') return runAgentNode(agentNamed(target.name), run, ctx);
    if (target.kind === 'map_item') return runAgentNode(agentNamed(target.agent), run, ctx);
    if (options.next) return options.next(run);
    throw new Error(`agentNodeRunner runs agent nodes and map items only; ${target.name} is a ${target.kind} run`);
  };
  const onEvent = (event: SchedulerEvent): void => {
    if (event.type !== 'node_end') return;
    const run = { name: event.node, path: event.path, branch: event.branch, invocationId, output: event.output };
    // The events ADK stores for the nodes the scheduler runs itself: a route step's, a join's, a map's.
    const stored = event.kind === 'route' ? routeStepEvent({ ...run, route: event.route }) : event.kind === 'join' ? joinNodeEvent(run) : event.kind === 'map' ? mapNodeEvent(run) : undefined;
    if (stored) enqueue(stored, options.onEvent).catch(() => {}); // surfaced by runNode and settled()
  };
  return {
    runNode,
    onEvent,
    // A node's event is stored a few ticks after it is yielded, behind the user turns of nodes started in the same
    // pass, as ADK's Runner stored it: queued one microtask later, which is still before the walk starts the node's successors.
    store: (event) => Promise.resolve().then(() => enqueue(event, options.onEvent)),
    async settled() {
      await tail;
      if (failure) throw failure.error;
    },
  };
}
