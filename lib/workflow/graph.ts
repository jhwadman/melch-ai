/**
 * lib/workflow/graph.ts — the `workflow:` block as an engine-owned graph.
 *
 * The YAML (lib/workflowConfig.ts) says what runs after what in chains of
 * names; this module turns those chains into the graph a scheduler runs:
 * typed nodes (`start`, `agent`, `join`, `map`, `tool`, `ask_user`, and the
 * hidden `route` step after a node a routing map follows), directed edges
 * that are unconditional, keyed to a route, or the `default` route, and the
 * workflow's `max_concurrency`. It imports nothing from ADK.
 *
 * It is the same graph `compileWorkflow` (lib/workflow.ts) hands ADK's
 * `Workflow`: the same node names in the same order, the same edges in the
 * same order with the same routes (tests/workflowGraph.test.ts holds the
 * two together on every workflow fixture). The engine's own scheduler,
 * lib/workflow/scheduler.ts, runs it (ADR 0087).
 *
 * ── Validation ────────────────────────────────────────────────────────────
 * Two passes, each raising the message today's path raises:
 *   1. The block's cross-field rules — every name an agent or a declared
 *      node, `START` opening a chain, a routing map after the node it
 *      routes, a declared node exactly one kind, the reserved `__route`
 *      suffix, `workflow` without `dispatch`, `retry` and `timeout` refused on
 *      a map entry, and the pauses and remotes a node cannot carry yet. Same paths and messages as the schema's
 *      (lib/syndicateSchema.ts, `workflowProblems`), thrown together as a
 *      `WorkflowGraphError`.
 *   2. The graph's own rules, on the built edges — no empty routing map,
 *      `START` present, without routes and without incoming edges, every
 *      node reachable from `START`, no duplicate edge, one `default` per
 *      node, no unconditional cycle. Same messages ADK's graph validation
 *      throws when `compileWorkflow` builds the `Workflow`, first problem
 *      only, as ADK does.
 * The schema's type checks (an edge chain of at least two elements, a name
 * that is a non-empty string) are not repeated: the input is a syndicate
 * that has passed `validateSyndicateConfig`, or one shaped like it. Whether
 * a `tool` node's tool is registered is a compile-time question (the
 * registry), not a graph one.
 */

import type { SyndicateYamlConfig } from '../loadSyndicate.ts';
import { suggest } from '../syndicateSchema.ts';
import { DEFAULT_ROUTE_KEY, NODE_KINDS, ROUTE_STEP_SUFFIX, START_NAME, elementNames, isWorkflowSyndicate, nodeKind } from '../workflowConfig.ts';
import type { EdgeElement, RetryYaml, WorkflowConfig, WorkflowNodeYaml } from '../workflowConfig.ts';

// ── The model ────────────────────────────────────────────────────────────────

/**
 * The entry node's name in the graph. The YAML writes it `START`; the graph
 * names it as the ADK compile does, so a node path read from an ADK-written
 * workflow event names the same node here.
 */
export const START_NODE = '__START__';

/** What a node is. `route` is the hidden step after a node a routing map follows. */
export type GraphNodeKind = 'start' | 'agent' | 'join' | 'map' | 'tool' | 'ask_user' | 'route';

/** The modifiers a node entry carries (`retry`, `timeout`), in the YAML spelling. */
export interface GraphNodeSettings {
  retry?: RetryYaml;
  /** Seconds this node may run before it fails. */
  timeout?: number;
}

export interface StartNode {
  kind: 'start';
  name: typeof START_NODE;
}

export interface AgentNode {
  kind: 'agent';
  /** The agent's YAML name: the orchestrator or a subagent. */
  name: string;
  settings: GraphNodeSettings;
}

export interface JoinNode {
  kind: 'join';
  name: string;
  settings: GraphNodeSettings;
}

export interface MapNode {
  kind: 'map';
  name: string;
  /** The agent run once per item of the list input. It is not itself a graph node. */
  agent: string;
  /** Concurrency of the map; absent means the runtime's default (8). */
  maxParallel?: number;
  /**
   * The map entry's own modifiers: always empty, since the schema refuses
   * `retry` and `timeout` on a map entry (ADR 0103). ADK's compile hands
   * neither to its ParallelWorker.
   */
  settings: GraphNodeSettings;
  /** The mapped agent's own node modifiers (`nodes.<agent>`), which ADK applies to each item's run. */
  agentSettings: GraphNodeSettings;
}

export interface ToolNode {
  kind: 'tool';
  name: string;
  /** The registry tool run with the node input as its arguments. */
  tool: string;
  settings: GraphNodeSettings;
}

export interface AskUserNode {
  kind: 'ask_user';
  name: string;
  /** The question. */
  message: string;
  /** JSON Schema a structured reply must satisfy. */
  schema?: Record<string, unknown>;
  settings: GraphNodeSettings;
}

export interface RouteNode {
  kind: 'route';
  /** `<source>__route`. */
  name: string;
  /** The node whose output this step reads the route from. */
  source: string;
  /** Property of a JSON output holding the route (`route_key`, default "route"); else the trimmed text. */
  routeKey: string;
}

export type GraphNode = StartNode | AgentNode | JoinNode | MapNode | ToolNode | AskUserNode | RouteNode;

/**
 * When an edge fires: always (`always`), when the source's route is `key`
 * (`key`, the YAML routing-map key verbatim), or when no keyed edge from the
 * same source matched (`default`).
 */
export type EdgeRoute = { kind: 'always' } | { kind: 'key'; key: string } | { kind: 'default' };

export interface GraphEdge {
  from: string;
  to: string;
  route: EdgeRoute;
}

export interface WorkflowGraph {
  /** The syndicate's name, which names the workflow. */
  name: string;
  /** Every node, by name, in order of first appearance in `edges` (`START_NODE` first). */
  nodes: Map<string, GraphNode>;
  /** Every edge, chain by chain, element pair by element pair. */
  edges: GraphEdge[];
  /** Nodes that may run at once; absent means unbounded. */
  maxConcurrency?: number;
  /** Nodes with no outgoing edge: the workflow's output is theirs. */
  terminals: string[];
  /** Every agent the syndicate declares (orchestrator first), including one reached only through a map. */
  agents: string[];
}

/** One problem the block's rules found, with the key path the schema reports it at. */
export interface GraphProblem {
  path: readonly PropertyKey[];
  message: string;
}

/**
 * Thrown by `buildWorkflowGraph`. For the block's rules, `problems` holds one
 * `<key.path> — <what>` line per problem and the message reads as
 * `SyndicateValidationError`'s does without a file; for a graph rule, it
 * holds the one message, which is the error's message.
 */
export class WorkflowGraphError extends Error {
  readonly problems: string[];
  constructor(problems: string[], message?: string) {
    super(
      message ?? (problems.length === 1 ? problems[0] : `${problems.length} problems in syndicate config:\n  ${problems.join('\n  ')}`),
    );
    this.name = 'WorkflowGraphError';
    this.problems = problems;
  }
}

// ── Building ─────────────────────────────────────────────────────────────────

/**
 * The graph a workflow syndicate declares. Throws `WorkflowGraphError` on a
 * rule the block breaks, and an `Error` when the syndicate has no
 * `workflow:` block, with `compileWorkflow`'s message.
 */
export function buildWorkflowGraph(config: SyndicateYamlConfig): WorkflowGraph {
  if (!isWorkflowSyndicate(config)) throw new Error(`${config.syndicate_name}: no workflow block`);
  const raw = config as unknown as Record<string, unknown>;
  const subs = Array.isArray(raw.subagents) ? (raw.subagents as unknown[]) : [];
  const problems = workflowConfigProblems(raw, subs);
  if (problems.length) throw new WorkflowGraphError(problems.map((p) => `${formatPath(p.path)} — ${p.message}`));

  const wf: WorkflowConfig = config.workflow;
  const nodeYaml = wf.nodes ?? {};
  const agents = [config.orchestrator.name, ...(config.subagents ?? []).map((s) => s.name)];
  const nodes = declaredNodes(agents, nodeYaml);

  const nodeOf = (name: string): GraphNode => {
    const node = nodes.get(name);
    if (!node) throw new Error(`workflow: '${name}' is not an agent or a declared node of this syndicate`);
    return node;
  };
  const routeStepAfter = (name: string): RouteNode => {
    const stepName = `${name}${ROUTE_STEP_SUFFIX}`;
    const existing = nodes.get(stepName);
    if (existing?.kind === 'route') return existing;
    const step: RouteNode = { kind: 'route', name: stepName, source: name, routeKey: nodeYaml[name]?.route_key ?? 'route' };
    nodes.set(stepName, step);
    return step;
  };

  // The chains as compileWorkflow hands them to ADK: a name, a list of names,
  // or a routing map, with the route step inserted before each map.
  type Element = { names: string[] } | { map: Array<[string, string[]]> };
  const edges: GraphEdge[] = [];
  for (const chain of wf.edges) {
    const out: Element[] = [];
    chain.forEach((element, i) => {
      if (typeof element === 'string') {
        out.push({ names: [element === START_NAME ? START_NODE : nodeOf(element).name] });
      } else if (Array.isArray(element)) {
        out.push({ names: element.map((n) => nodeOf(n).name) });
      } else {
        const previous = chain[i - 1];
        if (typeof previous !== 'string' || previous === START_NAME) {
          throw new Error(`workflow: a routing map must follow the name of the node whose output it routes`);
        }
        out.push({ names: [routeStepAfter(previous).name] });
        out.push({ map: Object.entries(element).map(([key, target]): [string, string[]] => [key, (Array.isArray(target) ? target : [target]).map((n) => nodeOf(n).name)]) });
      }
    });
    for (let i = 0; i < out.length - 1; i++) {
      const from = out[i];
      const to = out[i + 1];
      if ('map' in to) {
        if ('map' in from) throw new WorkflowGraphError([CONSECUTIVE_MAPS], CONSECUTIVE_MAPS);
        if (to.map.length === 0) throw new WorkflowGraphError([EMPTY_MAP], EMPTY_MAP);
        for (const [key, targets] of to.map) {
          const route: EdgeRoute = key === DEFAULT_ROUTE_KEY ? { kind: 'default' } : { kind: 'key', key };
          for (const f of from.names) for (const t of targets) edges.push({ from: f, to: t, route });
        }
      } else if ('names' in from) {
        for (const f of from.names) for (const t of to.names) edges.push({ from: f, to: t, route: { kind: 'always' } });
      }
    }
  }

  // Nodes in order of first appearance, as a graph of edges orders them.
  const ordered = new Map<string, GraphNode>();
  for (const edge of edges) {
    for (const name of [edge.from, edge.to]) {
      if (ordered.has(name)) continue;
      ordered.set(name, name === START_NODE ? { kind: 'start', name: START_NODE } : nodes.get(name)!);
    }
  }

  const graphProblem = graphRuleProblem([...ordered.keys()], edges);
  if (graphProblem) throw new WorkflowGraphError([graphProblem], graphProblem);

  const sources = new Set(edges.map((e) => e.from));
  return {
    name: config.syndicate_name,
    nodes: ordered,
    edges,
    ...(wf.max_concurrency !== undefined ? { maxConcurrency: wf.max_concurrency } : {}),
    terminals: [...ordered.keys()].filter((n) => n !== START_NODE && !sources.has(n)),
    agents,
  };
}

/** Every agent as a node, then every declared node, from the YAML. */
function declaredNodes(agents: string[], nodeYaml: Record<string, WorkflowNodeYaml>): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  for (const name of agents) nodes.set(name, { kind: 'agent', name, settings: settingsOf(nodeYaml[name]) });
  for (const [name, entry] of Object.entries(nodeYaml)) {
    const kind = nodeKind(entry);
    if (!kind) continue; // modifiers on an agent
    const settings = settingsOf(entry);
    if (kind === 'ask_user') {
      nodes.set(name, { kind, name, message: entry.ask_user ?? '', ...(entry.schema ? { schema: entry.schema } : {}), settings });
    } else if (kind === 'join') {
      nodes.set(name, { kind, name, settings });
    } else if (kind === 'map') {
      if (!agents.includes(entry.map!)) throw new Error(`workflow node '${name}': map names '${entry.map}', which is not an agent of this syndicate`);
      nodes.set(name, { kind, name, agent: entry.map!, ...(entry.max_parallel !== undefined ? { maxParallel: entry.max_parallel } : {}), settings, agentSettings: settingsOf(nodeYaml[entry.map!]) });
    } else if (kind === 'tool') {
      nodes.set(name, { kind, name, tool: entry.tool!, settings });
    }
  }
  return nodes;
}

function settingsOf(entry: WorkflowNodeYaml | undefined): GraphNodeSettings {
  const out: GraphNodeSettings = {};
  if (entry?.retry) out.retry = entry.retry;
  if (entry?.timeout !== undefined) out.timeout = entry.timeout;
  return out;
}

// ── The block's rules (the schema's messages) ────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function formatPath(p: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of p) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || '(root)';
}

/**
 * The cross-field rules of a `workflow:` block, with the paths and messages
 * `validateSyndicateConfig` reports for them, in the same order. Empty for a
 * block that keeps them all.
 */
export function workflowConfigProblems(raw: Record<string, unknown>, subs: unknown[]): GraphProblem[] {
  const out: GraphProblem[] = [];
  const wf = isObj(raw.workflow) ? raw.workflow : {};
  if (isObj(raw.dispatch)) {
    out.push({ path: ['workflow'], message: 'a syndicate is a workflow or a plan-dispatch router, not both; remove `dispatch`' });
  }
  const agentNames: string[] = [];
  if (isObj(raw.orchestrator) && typeof raw.orchestrator.name === 'string') agentNames.push(raw.orchestrator.name);
  for (const sub of subs) if (isObj(sub) && typeof sub.name === 'string') agentNames.push(sub.name);
  const nodes = isObj(wf.nodes) ? (wf.nodes as Record<string, WorkflowNodeYaml>) : {};
  const declared = Object.keys(nodes);
  const known = new Set([...agentNames, ...declared]);
  const mapped = new Set<string>();

  // Declared nodes: an agent takes modifiers only; anything else is one kind.
  for (const [name, entry] of Object.entries(nodes)) {
    if (!isObj(entry)) continue;
    const kinds = NODE_KINDS.filter((k) => (entry as Record<string, unknown>)[k] !== undefined);
    const isAgent = agentNames.includes(name);
    if (isAgent && kinds.length > 0) {
      out.push({ path: ['workflow', 'nodes', name], message: `'${name}' is an agent; its node entry may carry only route_key, retry and timeout` });
    } else if (!isAgent && kinds.length !== 1) {
      out.push({ path: ['workflow', 'nodes', name], message: `a declared node is exactly one of ${NODE_KINDS.join(', ')}${kinds.length ? ` (has ${kinds.join(', ')})` : ''}` });
    }
    if (name.endsWith(ROUTE_STEP_SUFFIX) || name === START_NAME) {
      out.push({ path: ['workflow', 'nodes', name], message: `'${name}' is reserved` });
    }
    const kind = nodeKind(entry as WorkflowNodeYaml);
    if (kind === 'map') {
      const target = (entry as WorkflowNodeYaml).map!;
      if (!agentNames.includes(target)) {
        const hint = suggest(target, agentNames);
        out.push({ path: ['workflow', 'nodes', name, 'map'], message: `'${target}' is not an agent of this syndicate${hint ? ` (did you mean "${hint}"?)` : ''}` });
      } else {
        mapped.add(target);
      }
    }
    if (kind !== 'ask_user' && (entry as WorkflowNodeYaml).schema !== undefined) {
      out.push({ path: ['workflow', 'nodes', name, 'schema'], message: 'schema applies to ask_user only' });
    }
    if (kind !== 'map' && (entry as WorkflowNodeYaml).max_parallel !== undefined) {
      out.push({ path: ['workflow', 'nodes', name, 'max_parallel'], message: 'max_parallel applies to map only' });
    }
    // A map item runs under its agent's own modifiers, as on ADK (ADR 0089, ADR 0103): the map entry's would be applied by neither runtime.
    if (kind === 'map') {
      for (const key of ['retry', 'timeout'] as const) {
        if ((entry as WorkflowNodeYaml)[key] === undefined) continue;
        const target = (entry as WorkflowNodeYaml).map!;
        out.push({ path: ['workflow', 'nodes', name, key], message: `${key} on a map node is not applied: each item runs under its agent's own ${key}; set it on nodes.${target}` });
      }
    }
  }
  for (const name of agentNames) {
    if (name.endsWith(ROUTE_STEP_SUFFIX)) out.push({ path: ['workflow'], message: `agent name '${name}' ends with the reserved suffix ${ROUTE_STEP_SUFFIX}` });
  }

  // Edges.
  const edges = Array.isArray(wf.edges) ? (wf.edges as unknown[]) : [];
  let starts = 0;
  const referenced = new Set<string>();
  const checkName = (name: string, path: readonly PropertyKey[]) => {
    if (known.has(name)) {
      referenced.add(name);
      return;
    }
    const hint = suggest(name, [...known]);
    out.push({ path, message: `'${name}' is not an agent or a declared node${hint ? ` (did you mean "${hint}"?)` : ''}` });
  };
  edges.forEach((chain, i) => {
    if (!Array.isArray(chain)) return;
    chain.forEach((element, j) => {
      const path: readonly PropertyKey[] = ['workflow', 'edges', i, j];
      if (typeof element === 'string') {
        if (element === START_NAME) {
          if (j !== 0) out.push({ path, message: 'START opens a chain; it cannot follow a node' });
          else starts++;
          return;
        }
        checkName(element, path);
      } else if (Array.isArray(element)) {
        element.forEach((name, k) => typeof name === 'string' && checkName(name, [...path, k]));
      } else if (isObj(element)) {
        const previous = chain[j - 1];
        if (typeof previous !== 'string' || previous === START_NAME) {
          out.push({ path, message: 'a routing map follows the name of the node whose output it routes' });
        } else if (!agentNames.includes(previous) && nodeKind(nodes[previous]) !== 'tool') {
          out.push({ path, message: `'${previous}' is a ${nodeKind(nodes[previous]) ?? 'node'}; only an agent or a tool node emits a route` });
        }
        if (j !== chain.length - 1) out.push({ path, message: 'a routing map ends its chain; start another chain from each target' });
        for (const [key, target] of Object.entries(element)) {
          const targets = Array.isArray(target) ? target : [target];
          targets.forEach((name, k) => typeof name === 'string' && checkName(name, [...path, key, k]));
        }
      }
      for (const name of isObj(element) || Array.isArray(element) || typeof element === 'string' ? elementNames(element as EdgeElement) : []) {
        if (mapped.has(name)) out.push({ path, message: `'${name}' is run by a map node; it cannot also appear in an edge` });
      }
    });
  });
  if (edges.length && starts === 0) out.push({ path: ['workflow', 'edges'], message: `no chain begins with ${START_NAME}` });
  for (const name of declared) {
    if (!referenced.has(name) && !agentNames.includes(name)) out.push({ path: ['workflow', 'nodes', name], message: 'declared but used in no edge' });
  }

  // What a node cannot carry yet (lib/workflow.ts, "Not in this version").
  const agents: Array<[readonly PropertyKey[], unknown]> = [
    [['orchestrator'], raw.orchestrator],
    ...subs.map((sub, i): [readonly PropertyKey[], unknown] => [['subagents', i], sub]),
  ];
  for (const [path, agent] of agents) {
    if (!isObj(agent)) continue;
    // A map item cannot pause: the walk resumes a paused agent node, not an item of a map (ADR 0094, ADR 0098).
    if (typeof agent.name === 'string' && mapped.has(agent.name) && Array.isArray(agent.require_approval) && agent.require_approval.length) {
      out.push({ path: [...path, 'require_approval'], message: 'approval gates are not supported on an agent a map node runs: a map item cannot pause the walk' });
    }
    // A skill script run pauses on the same approval (ADR 0106): allowed on a node, not on a map item.
    if (typeof agent.name === 'string' && mapped.has(agent.name) && isObj(agent.skills) && agent.skills.scripts === 'local') {
      out.push({ path: [...path, 'skills', 'scripts'], message: 'skill scripts (an approval pause) are not supported on an agent a map node runs: a map item cannot pause the walk' });
    }
    if (typeof agent.a2a_agent_url === 'string') {
      out.push({ path: [...path, 'a2a_agent_url'], message: 'a remote agent cannot be a workflow node yet' });
    }
  }
  return out;
}

// ── The graph's rules (ADK's graph-validation messages) ──────────────────────

const CONSECUTIVE_MAPS = 'Consecutive routing maps are not allowed in a chain. Split them into separate edge items.';
const EMPTY_MAP = 'Routing map must not be empty. Provide at least one route -> node mapping.';
/** The route value ADK stores for the `default` key. */
const ADK_DEFAULT_ROUTE = '__DEFAULT__';

/**
 * A routing-map key as the ADK compile stores it and prints it: an integer
 * spelling becomes a number and `true`/`false` a boolean, compared as
 * strings, so `01` and `1` name the same route there. Used for the
 * duplicate-edge rule and its message, and by the scheduler
 * (lib/workflow/scheduler.ts) to match an emitted route as ADK matches it
 * (ADR 0087); the graph keeps the key verbatim.
 */
export function adkRouteString(route: EdgeRoute): string | null {
  if (route.kind === 'always') return null;
  if (route.kind === 'default') return ADK_DEFAULT_ROUTE;
  if (/^-?\d+$/.test(route.key)) return String(Number(route.key));
  return route.key;
}

/**
 * The first rule the built graph breaks, with ADK's message, in ADK's order
 * (`validateGraph`): START present, START edges unrouted, reachability,
 * START without incoming edges, duplicate edges, one default per node,
 * no unconditional cycle. Undefined when it keeps them all.
 */
function graphRuleProblem(nodeNames: string[], edges: GraphEdge[]): string | undefined {
  const names = new Set(nodeNames);
  if (!names.has(START_NODE)) return `Graph validation failed. START node (name: '${START_NODE}') not found in graph nodes.`;
  for (const edge of edges) {
    if (edge.from === START_NODE && edge.route.kind !== 'always') {
      return `Graph validation failed. Edges from START must not have routes (edge to ${edge.to} has route ${adkRouteString(edge.route)}).`;
    }
  }

  // Reachability from START.
  const adj = new Map<string, Set<string>>();
  for (const name of names) adj.set(name, new Set());
  const toNodes = new Set<string>();
  for (const edge of edges) {
    adj.get(edge.from)!.add(edge.to);
    toNodes.add(edge.to);
  }
  const reachable = new Set<string>();
  const stack = [START_NODE as string];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (reachable.has(node)) continue;
    reachable.add(node);
    for (const next of adj.get(node) ?? []) if (!reachable.has(next)) stack.push(next);
  }
  const unreachable = [...names].filter((n) => !reachable.has(n)).sort();
  if (unreachable.length > 0) return `Graph validation failed. The following nodes are unreachable from START: ${JSON.stringify(unreachable)}`;
  if (toNodes.has(START_NODE)) return 'Graph validation failed. START node must not have incoming edges.';

  // Duplicate edges.
  const seen = new Set<string>();
  for (const edge of edges) {
    const route = adkRouteString(edge.route);
    const key = JSON.stringify([edge.from, edge.to, route]);
    if (seen.has(key)) {
      const unconditional = route === null;
      return `Graph validation failed. Duplicate edge found: from=${edge.from}, to=${edge.to}${unconditional ? '' : `, route=${JSON.stringify(route)}`}. ${unconditional ? 'The same pair is already connected unconditionally' : 'That route already points at this node'}, so the target would be triggered twice.`;
    }
    seen.add(key);
  }

  // One default per node.
  const defaults = new Map<string, string>();
  for (const edge of edges) {
    if (edge.route.kind !== 'default') continue;
    const first = defaults.get(edge.from);
    if (first !== undefined) return `Graph validation failed. Multiple DEFAULT_ROUTE edges found from node ${edge.from} to ${first} and ${edge.to}`;
    defaults.set(edge.from, edge.to);
  }

  // No unconditional cycle (depth-first, in node order, as ADK walks it).
  const always = new Map<string, string[]>();
  for (const name of names) always.set(name, []);
  for (const edge of edges) if (edge.route.kind === 'always') always.get(edge.from)!.push(edge.to);
  const inStack = new Set<string>();
  const done = new Set<string>();
  const dfs = (node: string, path: string[]): string | undefined => {
    inStack.add(node);
    path.push(node);
    for (const neighbor of always.get(node) ?? []) {
      if (inStack.has(neighbor)) {
        const cycle = [...path.slice(path.indexOf(neighbor)), neighbor];
        return `Graph validation failed. Unconditional cycle detected: ${cycle.join(' -> ')}. An unconditional cycle has no exit and would loop forever; break it with at least one conditional (routed) edge so a node can leave the cycle by not emitting that route. (A routed cycle can still loop if a node keeps emitting the route — bounding that is the node's responsibility, not this validator's.)`;
      }
      if (!done.has(neighbor)) {
        const found = dfs(neighbor, path);
        if (found) return found;
      }
    }
    path.pop();
    inStack.delete(node);
    done.add(node);
    return undefined;
  };
  for (const name of names) {
    if (done.has(name)) continue;
    const found = dfs(name, []);
    if (found) return found;
  }
  return undefined;
}
