/**
 * lib/workflow/scheduler.ts — the engine's own walk of a workflow graph.
 *
 * `runWorkflowGraph(graph, options)` runs the `WorkflowGraph` that
 * `buildWorkflowGraph` (lib/workflow/graph.ts) builds: a node runs when a
 * predecessor's completion triggers it, a node with several successors fans
 * out, a `join` waits until every predecessor has completed, a `map` runs its
 * agent once per item under `maxParallel`, and each node's output is the
 * input its successors receive. It imports nothing from ADK.
 *
 * What a node DOES is not this module's business. Agent, tool and ask_user
 * nodes, and each item of a map, are run by the `runNode` function the caller
 * passes in (WS4-3, WS4-5 and WS4-4a supply them). The scheduler runs the
 * kinds that are pure graph mechanics itself: the start node seeds the walk,
 * a `join` outputs `{ <predecessor>: <output> }`, a `route` step re-emits its
 * input with the route `routeOf` reads from it, and a `map` is the worker
 * pool around its items.
 *
 * ── The same walk as ADK's Workflow ──────────────────────────────────────
 * The loop is ADK 2.2's (`Workflow.runLoop`, workflow/workflow.js), step for
 * step, so a graph completes in the order ADK records for it
 * (tests/workflowScheduler.test.ts runs both and compares):
 *
 *   - Triggers are buffered per node, in the order they were pushed. Each
 *     pass starts every buffered node that is not already running, in the
 *     buffer's order, until `maxConcurrency` nodes are pending.
 *   - The loop then waits for the first pending node to settle, by
 *     `Promise.race` over the pending runs in the order they started, so of
 *     two runs already settled the one started first is handled first.
 *   - A completed node pushes one trigger to each successor its route
 *     selects (`always` edges, the edges keyed to its route compared as
 *     strings in ADK's spelling of the key, else the `default` edge). A join
 *     is triggered only once every predecessor has COMPLETED, with their
 *     outputs keyed in edge order. A node triggered while it runs runs again
 *     afterwards, once per trigger, as ADK does: only a join waits for all.
 *   - Branches and node paths are ADK's (`Planner@1`, `Six.Fan.Agent@0`), so
 *     the events a node runner writes can carry the values ADK writes.
 *   - The workflow's output is the one terminal node's output; two terminal
 *     outputs fail the run with ADK's message.
 *
 * ── The controls (ADK's node_runner.js, ADR 0089) ─────────────────────────
 * Every node run goes through `executeNode`, and every attempt of it through
 * `withControls`, which is ADK's `runChildNode` loop:
 *
 *   - **Timeout.** A node with `timeout` races each attempt against a timer;
 *     the runner's signal aborts when it fires and the attempt fails with
 *     `NodeTimeoutError`. Without a timeout the attempt is awaited, as ADK
 *     awaits it: the runner gets the signal and must settle when it aborts.
 *   - **Retry.** A failed attempt is retried while the node's `retry` allows
 *     (`max_attempts`, default 5; an `exceptions` list of error names when
 *     one is given), after ADK's backoff with its jitter. An abort and a map
 *     item's failure are never retried; an abort cuts a backoff short.
 *   - **Node errors.** A runner reports an error by returning `error`: the
 *     walk emits it (`node_error`, source `node`) and, when the result has no
 *     output and no route, the attempt fails with `NodeReportedError`. A node
 *     that gives up fails the walk; the walk emits that error once (source
 *     `workflow`) unless the node already reported it or the walk was
 *     aborted, then aborts the other runs, lets them settle and rethrows the
 *     error unchanged. Every `node_error` is collected in `nodeErrors`, in
 *     the shape runSyndicateTurn's drain collects ADK's error events.
 *   - **Abort and deadline.** The walk's signal is the caller's, else the
 *     current turn's (lib/runtime/turnControl.ts), so a cancel or a deadline
 *     reaches every run. Once it fires no node starts, and the walk rejects
 *     with `InvocationAbortedError` when nothing is left running.
 *   - **max_concurrency** counts every pending run, a retrying one included.
 *
 * A map item runs under its agent's own modifiers (`nodes.<agent>`), and an
 * item that gives up fails the map with `DynamicNodeFailError`, as ADK's
 * ParallelWorker does; the map entry's own `retry` and `timeout` are not
 * applied, because ADK's compile does not apply them.
 *
 * Interrupts (ask_user's pause, WS4-4a), a task-mode node that waits for its
 * output (WS4-3) and resumption from stored events are later tickets.
 */

import { routeOf } from '../workflowConfig.ts';
import { currentTurnSignal } from '../runtime/turnControl.ts';
import { START_NODE, adkRouteString } from './graph.ts';
import type { AgentNode, AskUserNode, GraphNode, GraphNodeKind, GraphNodeSettings, MapNode, ToolNode, WorkflowGraph } from './graph.ts';
import type { RetryYaml } from '../workflowConfig.ts';

/** ADK's ParallelWorker pool size when `max_parallel` is not set. */
export const DEFAULT_MAX_PARALLEL = 8;

/** A graph node the caller's runner executes. */
export type RunnableNode = AgentNode | ToolNode | AskUserNode;

/** One item of a map: the map's agent run on `items[index]`. */
export interface MapItem {
  kind: 'map_item';
  /** The agent run on the item. */
  agent: string;
  /** The map node. */
  map: MapNode;
  index: number;
}

/** One run of a node, as the scheduler hands it to the runner. */
export interface NodeRun {
  target: RunnableNode | MapItem;
  /** The predecessor's output; a join's `{ <predecessor>: <output> }`; the workflow input after START; a map's item. */
  input: unknown;
  /** The node's run counter as a string ("1", "2", ...); a map item's index. */
  runId: string;
  /** ADK's node path: `<workflow>.<node>`, or `<workflow>.<map>.<agent>@<index>` for a map item. */
  path: string;
  /** ADK's branch, undefined at the workflow's own branch. */
  branch: string | undefined;
  /**
   * Aborted when this attempt must stop: the walk's signal fired (a cancel,
   * the turn's deadline, another node failed) or the node's timeout did.
   * A runner settles promptly once it aborts.
   */
  signal: AbortSignal;
  /** Which attempt this is, from 1; above 1 only for a node with `retry`. */
  attempt: number;
}

/** An error a node reports instead of throwing, as an ADK event's errorCode and errorMessage. */
export interface ReportedNodeError {
  code: string;
  message: string;
}

/** What a node run produced. */
export interface NodeResult {
  /** The node's output, handed to its successors as their input. */
  output?: unknown;
  /** The route(s) the node emitted; only keyed edges read it. */
  route?: unknown;
  /**
   * An error the node reported. It is emitted and collected; with no output
   * and no route the attempt fails (`NodeReportedError`) and may be retried.
   */
  error?: ReportedNodeError;
}

export type NodeRunner = (run: NodeRun) => NodeResult | Promise<NodeResult>;

/** One collected node error, in the shape runSyndicateTurn's `answer.nodeErrors` holds. */
export interface CollectedNodeError {
  node: string;
  code: string;
  message: string;
}

/** What the walk reports as it goes. */
export type SchedulerEvent =
  | { type: 'node_start'; node: string; kind: GraphNodeKind; runId: string; path: string; branch: string | undefined; input: unknown }
  | { type: 'node_end'; node: string; kind: GraphNodeKind; runId: string; path: string; branch: string | undefined; output: unknown; route?: unknown }
  | { type: 'item_start'; node: string; agent: string; index: number; path: string; branch: string | undefined; input: unknown }
  | { type: 'item_end'; node: string; agent: string; index: number; path: string; branch: string | undefined; output: unknown }
  | {
      type: 'node_error';
      /**
       * `node`: the node reported it on an attempt (ADK: the node's own event
       * carrying an errorCode). `workflow`: the node gave up and the walk
       * reports why (ADK: the workflow's node-error event).
       */
      source: 'node' | 'workflow';
      /** The node, or a map item's agent, as ADK's event author. */
      node: string;
      path: string;
      /** The run's branch for `node`; the workflow's own branch for `workflow`, as ADK writes it. */
      branch: string | undefined;
      code: string;
      message: string;
      /** The error's class name (ADK's errorType); `workflow` only. */
      errorType?: string;
      /** The attempt it happened on; for `workflow`, the attempts made. */
      attempt: number;
    };

export interface RunWorkflowOptions {
  /** The workflow's input: what the nodes after START receive. */
  input: unknown;
  /** Runs agent, tool and ask_user nodes and map items. */
  runNode: NodeRunner;
  /** Aborts every run in flight when it fires. Default: the current turn's signal (turnControl), if any. */
  signal?: AbortSignal;
  /** Called synchronously for every event, in order. */
  onEvent?: (event: SchedulerEvent) => void;
  /** The workflow's own node path; default the graph's name. */
  nodePath?: string;
  /** The workflow's own branch; default none. */
  branch?: string;
}

export interface WorkflowRun {
  /** The terminal node's output, or undefined when no terminal node produced one. */
  output: unknown;
  /** Every completed node's latest output, by name (a node whose output was undefined is absent, as in ADK). */
  outputs: Map<string, unknown>;
  /** Node names in the order they completed (a node that ran twice appears twice). */
  order: string[];
  /** Every node error the walk emitted, in order: the attempts that failed and were retried or survived. */
  nodeErrors: CollectedNodeError[];
}

// ── Errors (ADK's workflow/errors.js; the names are ADK's, so errorType matches) ─

/** A node ran past its `timeout`. */
export class NodeTimeoutError extends Error {
  readonly nodeName: string;
  readonly timeout: number;
  constructor(options: { nodeName: string; timeout: number }) {
    super(`Node '${options.nodeName}' timed out after ${options.timeout} seconds.`);
    this.name = 'NodeTimeoutError';
    this.nodeName = options.nodeName;
    this.timeout = options.timeout;
  }
}

/** A node reported an error and produced no output and no route. */
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

/** The walk, or one node's run, stopped because its signal fired. */
export class InvocationAbortedError extends Error {
  constructor(message = 'Invocation aborted.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvocationAbortedError';
  }
}

/** A map item gave up; the map fails with this. */
export class DynamicNodeFailError extends Error {
  readonly error: Error;
  readonly errorNodePath: string;
  constructor(options: { message: string; error: Error; errorNodePath: string }) {
    super(options.message);
    this.name = 'DynamicNodeFailError';
    this.error = options.error;
    this.errorNodePath = options.errorNodePath;
  }
}

const isNamed = (error: unknown, name: string): boolean => error instanceof Error && error.name === name;

// ── Retry (ADK's retry_utils.js) ─────────────────────────────────────────────

/** ADK's defaults when a `retry` block leaves a field out. */
export const RETRY_DEFAULTS = { maxAttempts: 5, initialDelay: 1, maxDelay: 60, backoffFactor: 2, jitter: 1 } as const;

/**
 * A node's retry: the YAML's fields, plus ADK's two the YAML does not spell
 * yet (`exceptions`: the error names that may be retried, all when absent;
 * `jitter`: the random spread, default 1).
 */
export type RetrySettings = RetryYaml & { exceptions?: string[]; jitter?: number };

/** The names an error answers to: its class's and its `name`, as ADK matches `exceptions`. */
export function errorNames(error: unknown): string[] {
  if (error instanceof Error) return [...new Set([error.constructor?.name, error.name].filter((n): n is string => !!n))];
  if (typeof error === 'object' && error !== null) return [error.constructor.name];
  return [typeof error];
}

/** ADK's errorType: the class name, or the assigned name of a plain Error. */
export function errorName(error: unknown): string {
  const [className, assigned] = errorNames(error);
  return className === 'Error' && assigned ? assigned : className;
}

/** Whether a node that has made `attempts` attempts and failed with `error` runs again. */
export function shouldRetry(error: unknown, retry: RetrySettings, attempts: number): boolean {
  if (attempts >= (retry.max_attempts ?? RETRY_DEFAULTS.maxAttempts)) return false;
  const exceptions = retry.exceptions;
  return exceptions === undefined || errorNames(error).some((name) => exceptions.includes(name));
}

/** Seconds to wait before the attempt after `attempts`: exponential backoff, capped, with ADK's jitter. */
export function retryDelaySeconds(retry: RetrySettings, attempts: number, random: () => number = Math.random): number {
  const initialDelay = retry.initial_delay ?? RETRY_DEFAULTS.initialDelay;
  const maxDelay = retry.max_delay ?? RETRY_DEFAULTS.maxDelay;
  const backoffFactor = retry.backoff_factor ?? RETRY_DEFAULTS.backoffFactor;
  const jitter = retry.jitter ?? RETRY_DEFAULTS.jitter;
  let delay = initialDelay * Math.pow(backoffFactor, Math.max(0, (attempts || 1) - 1));
  if (jitter > 0) {
    delay = Math.min(delay, maxDelay / (1 + jitter));
    const span = jitter * delay;
    delay = Math.max(0, delay - span + random() * (2 * span));
  }
  return Math.min(delay, maxDelay);
}

type NodeStatus = 'running' | 'completed' | 'failed';

interface Trigger {
  input: unknown;
  useSubBranch: boolean;
  /** Overrides the computed branch when set (a predecessor's branch, a join's common prefix). */
  branch?: string;
}

interface NodeState {
  status: NodeStatus;
  runCounter: number;
  /** Attempts made by the current run (ADK's nodeState.attemptCount). */
  attempts: { count: number };
}

/** What every node run in one walk shares. */
interface Walk {
  runNode: NodeRunner;
  emit: (event: SchedulerEvent) => void;
  /** Errors already reported (ADK's claimNodeErrorReport), so a failure is reported once. */
  claimed: WeakSet<object>;
}

type Settled = { name: string; result: NodeResult & { branch: string | undefined } } | { name: string; error: unknown };

// ── Branches (ADK's branch_path.js) ──────────────────────────────────────────

const segmentsOf = (branch: string | undefined): string[] => (branch ? branch.split('.') : []);

function subBranch(base: string | undefined, name: string, runId: string): string {
  return [...segmentsOf(base), `${name}@${runId}`].join('.');
}

function commonPrefix(branches: string[]): string {
  if (branches.length === 0) return '';
  const all = branches.map(segmentsOf);
  const common: string[] = [];
  const min = Math.min(...all.map((s) => s.length));
  for (let i = 0; i < min; i++) {
    const seg = all[0][i];
    if (all.every((s) => s[i] === seg)) common.push(seg);
    else break;
  }
  return common.join('.');
}

// ── The walk ─────────────────────────────────────────────────────────────────

/**
 * Run a workflow graph to its end. Resolves with the workflow's output, every
 * node's output and the completion order; rejects with the first node error,
 * after every run still pending has settled.
 */
export async function runWorkflowGraph(graph: WorkflowGraph, options: RunWorkflowOptions): Promise<WorkflowRun> {
  const workflowPath = options.nodePath ?? graph.name;
  const parentBranch = options.branch;
  const onEvent = options.onEvent ?? (() => {});
  const nodeErrors: CollectedNodeError[] = [];
  const emit = (event: SchedulerEvent) => {
    if (event.type === 'node_error') nodeErrors.push({ node: event.node, code: event.code, message: event.message });
    onEvent(event);
  };
  const walk: Walk = { runNode: options.runNode, emit, claimed: new WeakSet() };

  // The caller's signal, else the turn's: a cancel or the turn's deadline stops the walk.
  const parentSignal = options.signal ?? currentTurnSignal();
  const controller = new AbortController();
  /** True once the walk was stopped from outside (not by a node's failure). */
  let stopped = false;
  const onParentAbort = () => {
    stopped = true;
    controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const nodes = new Map<string, NodeState>();
  const outputs = new Map<string, unknown>();
  const branches = new Map<string, string>();
  const triggers = new Map<string, Trigger[]>();
  const pending = new Map<string, Promise<Settled>>();
  const order: string[] = [];

  const nodeOf = (name: string): GraphNode => {
    const node = graph.nodes.get(name);
    if (!node) throw new Error(`Node ${name} not found in graph.`);
    return node;
  };
  const pushTrigger = (name: string, trigger: Trigger) => {
    const buffer = triggers.get(name);
    if (buffer) buffer.push(trigger);
    else triggers.set(name, [trigger]);
  };
  const popTrigger = (name: string): Trigger | undefined => {
    const buffer = triggers.get(name);
    if (!buffer || buffer.length === 0) return undefined;
    const trigger = buffer.shift();
    if (buffer.length === 0) triggers.delete(name);
    return trigger;
  };
  const atConcurrencyLimit = () => graph.maxConcurrency !== undefined && pending.size >= graph.maxConcurrency;

  // Seed: one trigger per START edge, each on its own branch when there are several.
  const startEdges = graph.edges.filter((e) => e.from === START_NODE);
  for (const edge of startEdges) pushTrigger(edge.to, { input: options.input, useSubBranch: startEdges.length > 1 });

  const scheduleReadyNodes = () => {
    // A stopped walk starts nothing; the runs in flight have their signal.
    if (controller.signal.aborted) return;
    for (const name of [...triggers.keys()]) {
      if (pending.has(name)) continue;
      if (nodes.get(name)?.status === 'running') continue;
      if (atConcurrencyLimit()) break;
      const trigger = popTrigger(name);
      if (!trigger) continue;
      const state: NodeState = { status: 'running', runCounter: (nodes.get(name)?.runCounter ?? 0) + 1, attempts: { count: 1 } };
      nodes.set(name, state);
      const runId = String(state.runCounter);
      const branch = trigger.branch !== undefined ? trigger.branch : trigger.useSubBranch ? subBranch(parentBranch, name, runId) : parentBranch;
      const node = nodeOf(name);
      const path = `${workflowPath}.${name}`;
      emit({ type: 'node_start', node: name, kind: node.kind, runId, path, branch, input: trigger.input });
      const run = executeNode(node, { input: trigger.input, runId, path, branch, signal: controller.signal }, walk, state.attempts).then(
        (result): Settled => ({ name, result: { ...result, branch } }),
        (error: unknown): Settled => ({ name, error }),
      );
      pending.set(name, run);
    }
  };

  const bufferDownstreamTriggers = (name: string, result: NodeResult, branch: string | undefined) => {
    const next = nextNodes(graph, name, result.route);
    const useSubBranch = next.length > 1;
    for (const target of next) {
      if (nodeOf(target).kind !== 'join') {
        pushTrigger(target, { input: result.output, useSubBranch, ...(branch !== undefined ? { branch } : {}) });
        continue;
      }
      const predecessors = [...new Set(graph.edges.filter((e) => e.to === target).map((e) => e.from))];
      if (!predecessors.every((p) => nodes.get(p)?.status === 'completed')) continue;
      const joined: Record<string, unknown> = {};
      for (const p of predecessors) joined[p] = outputs.get(p);
      const common = commonPrefix(predecessors.map((p) => branches.get(p) ?? ''));
      pushTrigger(target, { input: joined, useSubBranch: false, ...(common ? { branch: common } : {}) });
    }
  };

  // ADK's reportNodeError: the error a node gave up with, once, unless the
  // node already reported it or the walk was stopped from outside.
  const reportNodeError = (name: string, error: unknown, attempts: number) => {
    if (isNamed(error, 'InvocationAbortedError') || controller.signal.aborted) return;
    if (typeof error === 'object' && error !== null) {
      if (walk.claimed.has(error)) return;
      walk.claimed.add(error);
    }
    emit({
      type: 'node_error',
      source: 'workflow',
      node: name,
      path: `${workflowPath}.${name}`,
      branch: parentBranch,
      code: errorCodeOf(error),
      message: errorMessageOf(error),
      errorType: errorName(error),
      attempt: attempts,
    });
  };

  /** Record a completed run and emit its end; returns what its successors need. */
  const complete = (name: string, settledResult: NodeResult & { branch: string | undefined }): [NodeResult, string | undefined] => {
    const state = nodes.get(name)!;
    const { branch, ...result } = settledResult;
    state.status = 'completed';
    if (result.output !== undefined) outputs.set(name, result.output);
    branches.set(name, branch ?? '');
    order.push(name);
    emit({
      type: 'node_end',
      node: name,
      kind: nodeOf(name).kind,
      runId: String(state.runCounter),
      path: `${workflowPath}.${name}`,
      branch,
      output: result.output,
      ...(result.route !== undefined ? { route: result.route } : {}),
    });
    return [result, branch];
  };

  try {
    for (;;) {
      scheduleReadyNodes();
      if (pending.size === 0) break;
      const settled = await Promise.race(pending.values());
      pending.delete(settled.name);
      const state = nodes.get(settled.name)!;
      if (!('result' in settled)) {
        state.status = 'failed';
        reportNodeError(settled.name, settled.error, state.attempts.count);
        controller.abort(settled.error);
        const outstanding = [...pending.values()];
        pending.clear();
        // A run that still finishes during the shutdown has written its output
        // on ADK (its node emits it), so it ends here too, in settle order,
        // and triggers nothing.
        await Promise.all(outstanding.map((run) => run.then((late) => ('result' in late ? complete(late.name, late.result) : undefined))));
        throw settled.error;
      }
      bufferDownstreamTriggers(settled.name, ...complete(settled.name, settled.result));
    }
  } finally {
    parentSignal?.removeEventListener('abort', onParentAbort);
  }

  // Stopped from outside: the nodes in flight finished, but the walk did not.
  if (stopped) throw new InvocationAbortedError(`Workflow ${graph.name} aborted.`, { cause: controller.signal.reason });

  const terminalOutputs = graph.terminals.filter((n) => outputs.has(n)).map((n) => outputs.get(n));
  if (terminalOutputs.length > 1) {
    throw new Error(`Workflow ${graph.name}: multiple terminal nodes produced output (${terminalOutputs.length}). A workflow must have at most one terminal output.`);
  }
  return { output: terminalOutputs[0], outputs, order, nodeErrors };
}

/** ADK's errorCodeOf: an error's `code` when it is a string or a number, else UNKNOWN_ERROR. */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : 'UNKNOWN_ERROR';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The walk as a stream: every event as it happens, then the run as the
 * generator's return value. The walk does not wait for the consumer, so a
 * slow reader never changes the order.
 */
export async function* streamWorkflowGraph(graph: WorkflowGraph, options: Omit<RunWorkflowOptions, 'onEvent'>): AsyncGenerator<SchedulerEvent, WorkflowRun> {
  const queue: SchedulerEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const done = runWorkflowGraph(graph, {
    ...options,
    onEvent: (event) => {
      queue.push(event);
      wake?.();
    },
  }).finally(() => {
    finished = true;
    wake?.();
  });
  done.catch(() => {}); // surfaced below, after the queued events
  for (;;) {
    while (queue.length > 0) yield queue.shift()!;
    if (finished) return await done;
    await new Promise<void>((resolve) => (wake = resolve));
    wake = undefined;
  }
}

/**
 * The successors a completed node triggers, as ADK's `getNextPendingNodes`
 * selects them: every `always` edge; every keyed edge whose key (in ADK's
 * spelling) equals the emitted route, or one of them, compared as strings;
 * and the `default` edge when no keyed edge matched.
 */
export function nextNodes(graph: WorkflowGraph, name: string, route: unknown): string[] {
  const next: string[] = [];
  const emitted = route === undefined || route === null ? [] : (Array.isArray(route) ? route : [route]).map(String);
  let matched = false;
  let fallback: string | undefined;
  for (const edge of graph.edges) {
    if (edge.from !== name) continue;
    if (edge.route.kind === 'always') {
      next.push(edge.to);
    } else if (edge.route.kind === 'default') {
      fallback = edge.to;
    } else if (emitted.includes(adkRouteString(edge.route)!)) {
      next.push(edge.to);
      matched = true;
    }
  }
  if (!matched && fallback !== undefined) next.push(fallback);
  return next;
}

// ── One node ─────────────────────────────────────────────────────────────────

type RunContext = Omit<NodeRun, 'target' | 'attempt'>;

/**
 * The modifiers a node runs under. A map's own are not applied (ADK's compile
 * does not hand them to its ParallelWorker); its items run under the agent's.
 */
function settingsFor(node: GraphNode): GraphNodeSettings {
  switch (node.kind) {
    case 'agent':
    case 'tool':
    case 'ask_user':
    case 'join':
      return node.settings;
    default:
      return {};
  }
}

/**
 * Runs one node: the single place a node executes, under its retry and
 * timeout. Always asynchronous, so a node the scheduler runs itself settles a
 * tick later as one the runner runs does.
 */
async function executeNode(node: GraphNode, ctx: RunContext, walk: Walk, attempts: { count: number }): Promise<NodeResult> {
  return withControls(node.name, settingsFor(node), ctx, walk, attempts, (signal, attempt) => runOnce(node, { ...ctx, signal }, attempt, walk));
}

/** One attempt of a node, without its controls. */
async function runOnce(node: GraphNode, ctx: RunContext, attempt: number, walk: Walk): Promise<NodeResult> {
  switch (node.kind) {
    case 'agent':
    case 'tool':
    case 'ask_user':
      return await walk.runNode({ target: node, ...ctx, attempt });
    case 'join':
      return { output: ctx.input };
    case 'route':
      return { output: ctx.input, route: routeOf(ctx.input, node.routeKey) };
    case 'map':
      return { output: await runMap(node, ctx, walk) };
    case 'start':
      throw new Error(`Node ${node.name} is the start node and never runs.`);
  }
}

/**
 * ADK's runChildNode loop around one run: each attempt under the timeout; a
 * reported error emitted, and fatal when the attempt produced nothing; a
 * failure retried while the retry allows, after the backoff. An abort and a
 * map item's failure are thrown at once. `attempts` is the run's counter,
 * which the walk reads when it reports the error the node gave up with.
 */
async function withControls(
  name: string,
  settings: GraphNodeSettings,
  ctx: RunContext,
  walk: Walk,
  attempts: { count: number },
  attemptOnce: (signal: AbortSignal, attempt: number) => Promise<NodeResult>,
): Promise<NodeResult> {
  for (;;) {
    try {
      const { error, ...result } = await underTimeout(name, settings.timeout, ctx.signal, (signal) => attemptOnce(signal, attempts.count));
      // ADK carries no output for a node that yields null: no output event,
      // nothing recorded, and its successors run on undefined.
      if (result.output === null) delete result.output;
      if (error) {
        walk.emit({ type: 'node_error', source: 'node', node: name, path: ctx.path, branch: ctx.branch, code: String(error.code), message: String(error.message), attempt: attempts.count });
        if (result.output === undefined && result.route === undefined) {
          const failure = new NodeReportedError({ nodeName: name, errorCode: error.code, errorMessage: error.message });
          walk.claimed.add(failure);
          throw failure;
        }
      }
      return result;
    } catch (error) {
      if (isNamed(error, 'InvocationAbortedError') || isNamed(error, 'DynamicNodeFailError')) throw error;
      const retry = settings.retry as RetrySettings | undefined;
      if (!retry || !shouldRetry(error, retry, attempts.count)) throw error;
      const seconds = retryDelaySeconds(retry, attempts.count);
      attempts.count += 1;
      await abortableDelay(seconds * 1000, ctx.signal);
    }
  }
}

/**
 * One attempt under a timeout, as ADK's runOnce: the attempt's own signal
 * follows the walk's and aborts when the timer fires, and the attempt fails
 * at once (`NodeTimeoutError`, or `InvocationAbortedError` on the walk's
 * abort) without waiting for the runner. Without a timeout the attempt is
 * awaited with the walk's signal.
 */
async function underTimeout(name: string, timeout: number | undefined, signal: AbortSignal, attempt: (signal: AbortSignal) => Promise<NodeResult>): Promise<NodeResult> {
  if (!(typeof timeout === 'number' && timeout > 0)) return await attempt(signal);
  const controller = new AbortController();
  let deadlineFired = false;
  const onParentAbort = () => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    deadlineFired = true;
    controller.abort(new NodeTimeoutError({ nodeName: name, timeout }));
  }, timeout * 1000);
  // Registered before the runner starts, so it settles the race first.
  const aborted = new Promise<never>((_, reject) => {
    const fail = () =>
      reject(deadlineFired ? new NodeTimeoutError({ nodeName: name, timeout }) : new InvocationAbortedError(`Invocation aborted while running node '${name}'.`, { cause: signal.reason }));
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {});
  const run = Promise.resolve().then(() => attempt(controller.signal));
  run.catch(() => {}); // an abandoned attempt's late failure is nobody's
  try {
    return await Promise.race([run, aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onParentAbort);
  }
}

/** A retry's backoff; the walk's abort cuts it short. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new InvocationAbortedError('Invocation aborted during retry.', { cause: signal.reason }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new InvocationAbortedError('Invocation aborted during retry.', { cause: signal.reason }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A map: ADK's ParallelWorker. A list input runs the agent once per item (a
 * non-list input is one item), on a pool of `min(maxParallel ?? 8, items)`
 * workers that each take the next index; the output is the list of results
 * by index. An empty list outputs `[]`. Each item runs under the agent's own
 * retry and timeout. The first item that gives up stops the pool taking new
 * items, and once every worker has stopped the map fails with
 * `DynamicNodeFailError` naming the agent, as ADK's dynamic-node scheduler
 * wraps it.
 */
async function runMap(node: MapNode, ctx: RunContext, walk: Walk): Promise<unknown[]> {
  const items = Array.isArray(ctx.input) ? ctx.input : [ctx.input];
  if (items.length === 0) return [];
  const results = new Array<unknown>(items.length);
  const poolSize = Math.min(node.maxParallel ?? DEFAULT_MAX_PARALLEL, items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed && !ctx.signal.aborted) {
      const index = nextIndex++;
      if (index >= items.length) break;
      const path = `${ctx.path}.${node.agent}@${index}`;
      const branch = subBranch(ctx.branch, node.agent, String(index));
      const base = { node: node.name, agent: node.agent, index, path, branch };
      try {
        walk.emit({ type: 'item_start', ...base, input: items[index] });
        const itemCtx: RunContext = { input: items[index], runId: String(index), path, branch, signal: ctx.signal };
        const target: MapItem = { kind: 'map_item', agent: node.agent, map: node, index };
        const result = await withControls(node.agent, node.agentSettings, itemCtx, walk, { count: 1 }, async (signal, attempt) =>
          walk.runNode({ target, ...itemCtx, signal, attempt }),
        ).catch((error: unknown) => {
          if (isNamed(error, 'DynamicNodeFailError')) throw error;
          const cause = error instanceof Error ? error : new Error(String(error));
          throw new DynamicNodeFailError({ message: `Dynamic node ${node.agent} failed: ${cause.message}`, error: cause, errorNodePath: path });
        });
        results[index] = result.output;
        walk.emit({ type: 'item_end', ...base, output: result.output });
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        break;
      }
    }
  };
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  if (failed) throw firstError;
  return results;
}

