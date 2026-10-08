/**
 * lib/workflow/toolNode.ts — a workflow `tool:` node on the engine's own
 * runtime: the registry tool run once with the previous node's output as its
 * arguments, as ADK 2.2's `ToolNode` ran it (workflow/nodes/tool_node.js).
 *
 * `toolNodeRunner(context)` is a `NodeRunner` for the scheduler
 * (lib/workflow/scheduler.ts): it runs a tool node's run and leaves every
 * other kind to the runner it is given. `runToolNode(node, run, context)` is
 * the same for one run. It imports nothing from ADK, and nothing in its
 * import graph does: the tool is resolved by the caller's `resolveTool`, so
 * the registry stays outside.
 *
 * ── What ADK's ToolNode did, and so what this does ───────────────────────
 *   1. INPUT TO ARGUMENTS (coerceToolArgs). A content's text, a string parsed
 *      as JSON when it parses (a blank string is no arguments), null or
 *      undefined as `{}`. Anything that is then not a plain object (a list,
 *      a number, text that is not JSON) throws ADK's TypeError, which fails
 *      the node as any node error does.
 *   2. ONE CALL, id `<node path>:<run id>` (`Graph.Lookup:1`), through ADK's
 *      handleFunctionCallList semantics for a single call: the own Tool runs
 *      as ADK's FunctionTool ran it (its approval gate, then execute, a throw
 *      reported as `Error in tool '<name>': <message>`). An ADK tool (an
 *      object with runAsync) is refused, naming 1.0.0 and defineTool, as
 *      registerTool refuses one. A throw becomes `{ error: <message> }`, a
 *      result that is not an object `{ result }`, a list `{ results }`.
 *   3. ONE EVENT, built as ADK built it and enriched as ADK's node runner
 *      enriched it: a `user` content holding the function response, the
 *      call's actions (its state writes, an approval it asked for), the run's
 *      branch, `author` the node's YAML name, `output` the response object,
 *      and `nodeInfo { path, outputFor }`. Serialized, it is the JSON ADK
 *      stored, key for key (tests/workflowToolNode.test.ts compares them).
 *   4. THE OUTPUT is the response object, which the next node receives:
 *      `{ result: 'found needle' }` for a tool that returned a string.
 *
 * The event goes to `context.onEvent` before the run resolves, so a caller
 * that drains events through the turn runner's reader (drainAgentStream)
 * prints the same progress lines ADK's did: `⇢ Node: Lookup`, then
 * `← Result: <tool> — <n> chars`, and `Running node: Lookup` to onProgress.
 *
 * The call runs inside the caller's `traceCall` when it passes one (the
 * native turn opens the engine's `tool.execute` span there, as ADK opened
 * `execute_tool`).
 *
 * Not here: a long-running tool is refused, as ADK's ToolNode refused it
 * (resolveToolNode, which the turn also calls before any model call);
 * tool callbacks and plugins do not exist on a workflow node; retries,
 * timeouts and the node-error event are the scheduler's (WS4-2b).
 *
 * The node's input is the previous node's output, usually model text: it is
 * data the tool validates (defineTool does it from the schema), never an
 * instruction this module acts on.
 */

import { createEventActions, createTurnEvent } from '../runtime/events.ts';
import type { TurnContent, TurnEvent, TurnEventActions, TurnToolConfirmation } from '../runtime/events.ts';
import { APPROVAL_TEXTS, createToolContext, toolOf } from '../tools/tool.ts';
import type { Tool, ToolContextInit } from '../tools/tool.ts';
import type { ToolNode } from './graph.ts';
import type { NodeResult, NodeRun, NodeRunner } from './scheduler.ts';

/** Everything a tool node needs from the turn it runs in. */
export interface ToolNodeContext extends Pick<ToolContextInit, 'appName' | 'userId' | 'sessionId' | 'userContent' | 'memory' | 'credentials'> {
  /** The run's invocation id, written on the event. */
  invocationId: string;
  /** The registry entry for a tool name, or undefined when none is registered (the turn runner passes the registry's). */
  resolveTool: (name: string) => unknown;
  /** The session state as the call should read it, at the moment it runs. */
  state?: () => Readonly<Record<string, unknown>>;
  /** Receives the node's event, before the run resolves. */
  onEvent?: (event: TurnEvent) => void;
  /** ADK's `outputFor` ancestors: the paths this node's output also answers for. Default none. */
  outputForAncestors?: string[];
  /** ADK's isolation scope, written on the event when set. */
  isolationScope?: string;
  /**
   * Wraps the call, as ADK's tool runner opens `execute_tool <name>` around
   * it; the turn runner passes the engine's tool span
   * (lib/runtime/native/telemetry.ts). Default: a plain call.
   */
  traceCall?: (call: { id: string; name: string }, tool: unknown, run: () => Promise<unknown>) => Promise<unknown>;
}

// ── 1. Input to arguments ────────────────────────────────────────────────────

/** ADK's isContent: an object with a `parts` list. */
function isContent(value: unknown): value is TurnContent {
  return typeof value === 'object' && value !== null && 'parts' in value && Array.isArray((value as TurnContent).parts);
}

/**
 * A node input as tool arguments, as ADK's ToolNode coerces it: a content's
 * text; a string parsed as JSON when it parses, a blank string as nothing;
 * nothing as `{}`. Throws ADK's TypeError for anything else that is not an
 * object.
 */
export function coerceToolArgs(input: unknown): Record<string, unknown> {
  let args: unknown = input;
  if (isContent(args)) args = (args.parts ?? []).map((p) => p.text ?? '').join('');
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) {
      args = null;
    } else {
      try {
        args = JSON.parse(trimmed);
      } catch {
        // Not JSON: left a string, refused below.
      }
    }
  }
  if (args === null || args === undefined) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError(`The input to ToolNode must be an object of tool arguments or null, but got ${typeof args}.`);
  }
  return args as Record<string, unknown>;
}

// ── 2. The call ──────────────────────────────────────────────────────────────


/** ADK's normalizeCallbackResponse: a result as a function response. */
function asResponse(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return { result: value };
  if (Array.isArray(value)) return { results: value };
  return value as Record<string, unknown>;
}

/**
 * The registry entry for the node's tool, refused as ADK refused it at
 * compile time: unregistered, or long-running; and an ADK tool (anything
 * with runAsync), which 1.0.0 no longer runs. The turn runner calls it for
 * every tool node before the walk starts, so a refusal comes before any
 * model call.
 */
export function resolveToolNode(node: ToolNode, context: Pick<ToolNodeContext, 'resolveTool'>): { own: Tool; name: string } {
  const entry = context.resolveTool(node.tool);
  if (!!entry && typeof entry === 'object' && 'runAsync' in entry) {
    throw new Error(`workflow node '${node.name}': tool '${node.tool}' is an ADK tool, which melchizedek-agents 1.0.0 no longer runs (ADR 0107); define it with defineTool (melchizedek-agents) instead`);
  }
  const own = toolOf(entry);
  if (!own) throw new Error(`workflow node '${node.name}': tool '${node.tool}' is not registered`);
  if (own.longRunning === true) {
    throw new Error(`ToolNode does not support long-running tools yet (tool '${own.name}').`);
  }
  return { own, name: own.name };
}

/**
 * An own Tool's call, as ADK's FunctionTool ran a wrapped Tool: its
 * approval gate (a tool node has no resume, so a gated call always asks),
 * then execute, a throw named for the tool.
 */
async function runOwnTool(tool: Tool, args: Record<string, unknown>, call: ReturnType<typeof createToolContext>): Promise<unknown> {
  try {
    if (tool.requiresApproval === true && !call.confirmation) {
      call.requestConfirmation({ hint: APPROVAL_TEXTS.hint(tool.name) });
      call.actions.skipSummarization = true;
      return { error: APPROVAL_TEXTS.pending };
    }
    return await tool.execute(args, call);
  } catch (e) {
    throw new Error(`Error in tool '${tool.name}': ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 3 and 4. One run ─────────────────────────────────────────────────────────

/**
 * Run one tool node: the call, its event (to `context.onEvent`), and the
 * response object as the node's output.
 */
export async function runToolNode(node: ToolNode, run: NodeRun, context: ToolNodeContext): Promise<NodeResult> {
  const resolved = resolveToolNode(node, context);
  const args = coerceToolArgs(run.input);
  const functionCallId = `${run.path}:${run.runId}`;
  const call = createToolContext({
    invocationId: context.invocationId,
    functionCallId,
    appName: context.appName,
    userId: context.userId,
    sessionId: context.sessionId,
    state: context.state?.() ?? {},
    signal: run.signal,
    userContent: context.userContent,
    memory: context.memory,
    credentials: context.credentials,
  });

  // handleFunctionCallList starts from null: a call that threw an empty message answers `{ result: null }`.
  let response: unknown = null;
  let error: unknown;
  const invoke = (): Promise<unknown> => runOwnTool(resolved.own, args, call);
  try {
    response = await (context.traceCall ? context.traceCall({ id: functionCallId, name: resolved.name }, resolved.own, invoke) : invoke());
  } catch (e) {
    // handleFunctionCallList: an Error's message, any other throw as it is.
    error = e instanceof Error ? e.message : e;
  }
  const answer = error ? { error } : response === null || response === undefined ? { result: response } : asResponse(response);

  const event = createTurnEvent({
    invocationId: context.invocationId,
    author: node.name,
    content: { role: 'user', parts: [{ functionResponse: { id: functionCallId, name: resolved.name, response: answer } }] },
    actions: callActions(call, functionCallId),
    branch: run.branch,
  });
  event.output = answer;
  enrichNodeEvent(event, run, context);
  context.onEvent?.(event);
  return { output: answer };
}

/** The call's actions as ADK's Context holds them: its state writes, the approval it asked for, skipSummarization. */
function callActions(call: ReturnType<typeof createToolContext>, functionCallId: string): TurnEventActions {
  const actions = createEventActions({ stateDelta: { ...call.stateDelta } });
  const request = call.confirmationRequest;
  if (request) {
    const confirmation: TurnToolConfirmation = { hint: request.hint ?? '', confirmed: false, payload: request.payload };
    (actions.requestedToolConfirmations as Record<string, TurnToolConfirmation>)[functionCallId] = confirmation;
  }
  if (call.actions.skipSummarization !== undefined) actions.skipSummarization = call.actions.skipSummarization;
  return actions;
}

/**
 * What ADK's node runner writes on every event a node yields (enrichEvent,
 * workflow/node_runner.js): the author and invocation id when absent, the
 * node path, `outputFor` when the event carries an output, the branch and
 * the isolation scope when the event has none.
 */
export function enrichNodeEvent(event: TurnEvent, run: Pick<NodeRun, 'path' | 'branch'>, context: Pick<ToolNodeContext, 'invocationId' | 'outputForAncestors' | 'isolationScope'>): TurnEvent {
  const name = run.path.slice(run.path.lastIndexOf('.') + 1);
  if (!event.author) event.author = name;
  if (!event.invocationId) event.invocationId = context.invocationId;
  event.nodeInfo = { ...(event.nodeInfo ?? {}), path: run.path };
  if (event.output !== undefined) event.nodeInfo.outputFor = [run.path, ...(context.outputForAncestors ?? [])];
  if (run.branch !== undefined && event.branch === undefined) event.branch = run.branch;
  if (context.isolationScope !== undefined && event.isolationScope === undefined) event.isolationScope = context.isolationScope;
  return event;
}

/**
 * A scheduler runner that runs tool nodes and hands every other run (agent
 * and ask_user nodes, map items) to `next`. Without `next`, any other run is
 * refused by name.
 */
export function toolNodeRunner(context: ToolNodeContext, next?: NodeRunner): NodeRunner {
  return (run) => {
    if (run.target.kind === 'tool') return runToolNode(run.target, run, context);
    if (next) return next(run);
    const name = run.target.kind === 'map_item' ? `${run.target.map.name}[${run.target.index}]` : run.target.name;
    throw new Error(`toolNodeRunner runs tool nodes only; ${name} is a ${run.target.kind} run`);
  };
}
