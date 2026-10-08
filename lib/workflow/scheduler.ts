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
 * ── Seams for WS4-2b ───────────────────────────────────────────────────────
 * Retries, timeouts, abort, a deadline and the node-error policy are not here
 * yet. Every node run goes through `executeNode`, the one place a retry or a
 * timeout wraps; every run gets an `AbortSignal` (the caller's, chained to
 * the workflow's own controller); and a node that throws stops the walk as
 * ADK's does: the controller aborts, the runs still pending settle, and the
 * error is rethrown unchanged. Interrupts (ask_user's pause, WS4-4a), a
 * task-mode node that waits for its output (WS4-3) and resumption from stored
 * events are later tickets; a node result carries an output and a route only.
 */

import { routeOf } from '../workflowConfig.ts';
import { START_NODE, adkRouteString } from './graph.ts';
import type { AgentNode, AskUserNode, GraphNode, GraphNodeKind, MapNode, ToolNode, WorkflowGraph } from './graph.ts';

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
  /** Aborted when the walk stops: the caller's signal fired, or another node failed. */
  signal: AbortSignal;
}

/** What a node run produced. */
export interface NodeResult {
  /** The node's output, handed to its successors as their input. */
  output?: unknown;
  /** The route(s) the node emitted; only keyed edges read it. */
  route?: unknown;
}

export type NodeRunner = (run: NodeRun) => NodeResult | Promise<NodeResult>;

/** What the walk reports as it goes. */
export type SchedulerEvent =
  | { type: 'node_start'; node: string; kind: GraphNodeKind; runId: string; path: string; branch: string | undefined; input: unknown }
  | { type: 'node_end'; node: string; kind: GraphNodeKind; runId: string; path: string; branch: string | undefined; output: unknown; route?: unknown }
  | { type: 'item_start'; node: string; agent: string; index: number; path: string; branch: string | undefined; input: unknown }
  | { type: 'item_end'; node: string; agent: string; index: number; path: string; branch: string | undefined; output: unknown };

export interface RunWorkflowOptions {
  /** The workflow's input: what the nodes after START receive. */
  input: unknown;
  /** Runs agent, tool and ask_user nodes and map items. */
  runNode: NodeRunner;
  /** Aborts every run in flight when it fires. */
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
  const emit = options.onEvent ?? (() => {});

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener('abort', onParentAbort, { once: true });

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
    for (const name of [...triggers.keys()]) {
      if (pending.has(name)) continue;
      if (nodes.get(name)?.status === 'running') continue;
      if (atConcurrencyLimit()) break;
      const trigger = popTrigger(name);
      if (!trigger) continue;
      const state: NodeState = { status: 'running', runCounter: (nodes.get(name)?.runCounter ?? 0) + 1 };
      nodes.set(name, state);
      const runId = String(state.runCounter);
      const branch = trigger.branch !== undefined ? trigger.branch : trigger.useSubBranch ? subBranch(parentBranch, name, runId) : parentBranch;
      const node = nodeOf(name);
      const path = `${workflowPath}.${name}`;
      emit({ type: 'node_start', node: name, kind: node.kind, runId, path, branch, input: trigger.input });
      const run = executeNode(node, { input: trigger.input, runId, path, branch, signal: controller.signal }, options.runNode, emit).then(
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

  try {
    for (;;) {
      scheduleReadyNodes();
      if (pending.size === 0) break;
      const settled = await Promise.race(pending.values());
      pending.delete(settled.name);
      const state = nodes.get(settled.name)!;
      if (!('result' in settled)) {
        state.status = 'failed';
        controller.abort(settled.error);
        const outstanding = [...pending.values()];
        pending.clear();
        await Promise.allSettled(outstanding);
        throw settled.error;
      }
      const node = nodeOf(settled.name);
      const { branch, ...result } = settled.result;
      state.status = 'completed';
      if (result.output !== undefined) outputs.set(settled.name, result.output);
      branches.set(settled.name, branch ?? '');
      order.push(settled.name);
      emit({
        type: 'node_end',
        node: settled.name,
        kind: node.kind,
        runId: String(state.runCounter),
        path: `${workflowPath}.${settled.name}`,
        branch,
        output: result.output,
        ...(result.route !== undefined ? { route: result.route } : {}),
      });
      bufferDownstreamTriggers(settled.name, result, branch);
    }
  } finally {
    options.signal?.removeEventListener('abort', onParentAbort);
  }

  const terminalOutputs = graph.terminals.filter((n) => outputs.has(n)).map((n) => outputs.get(n));
  if (terminalOutputs.length > 1) {
    throw new Error(`Workflow ${graph.name}: multiple terminal nodes produced output (${terminalOutputs.length}). A workflow must have at most one terminal output.`);
  }
  return { output: terminalOutputs[0], outputs, order };
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

type RunContext = Omit<NodeRun, 'target'>;

/**
 * Runs one node. The single place a node executes, and so the seam where
 * WS4-2b wraps a retry and a timeout. Always asynchronous, so a node the
 * scheduler runs itself settles a tick later as one the runner runs does.
 */
async function executeNode(node: GraphNode, ctx: RunContext, runNode: NodeRunner, emit: (event: SchedulerEvent) => void): Promise<NodeResult> {
  switch (node.kind) {
    case 'agent':
    case 'tool':
    case 'ask_user':
      return await runNode({ target: node, ...ctx });
    case 'join':
      return { output: ctx.input };
    case 'route':
      return { output: ctx.input, route: routeOf(ctx.input, node.routeKey) };
    case 'map':
      return { output: await runMap(node, ctx, runNode, emit) };
    case 'start':
      throw new Error(`Node ${node.name} is the start node and never runs.`);
  }
}

/**
 * A map: ADK's ParallelWorker. A list input runs the agent once per item (a
 * non-list input is one item), on a pool of `min(maxParallel ?? 8, items)`
 * workers that each take the next index; the output is the list of results
 * by index. An empty list outputs `[]`. The first item error stops the pool
 * taking new items and is thrown once every worker has stopped.
 */
async function runMap(node: MapNode, ctx: RunContext, runNode: NodeRunner, emit: (event: SchedulerEvent) => void): Promise<unknown[]> {
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
        emit({ type: 'item_start', ...base, input: items[index] });
        const result = await runNode({ target: { kind: 'map_item', agent: node.agent, map: node, index }, input: items[index], runId: String(index), path, branch, signal: ctx.signal });
        results[index] = result.output;
        emit({ type: 'item_end', ...base, output: result.output });
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
