/**
 * lib/workflowConfig.ts — the `workflow:` block's contract: its types, the
 * names it reserves, and the pure helpers the schema (lib/syndicateSchema.ts),
 * the compiler (lib/workflow.ts) and the turn runner share. No imports
 * beyond types, so the schema can read it without pulling the compiler in.
 */

import type { RetryConfig as AdkRetryConfig } from '@google/adk';

/** `START` in an edge chain: the graph's entry. Not a node. */
export const START_NAME = 'START';
/** The routing-map key that catches an unmatched route. */
export const DEFAULT_ROUTE_KEY = 'default';
/** Suffix of the hidden step inserted after an agent a routing map follows. */
export const ROUTE_STEP_SUFFIX = '__route';

/** One element of an edge chain: a name, several names (fan-out or fan-in), or a routing map. */
export type EdgeElement = string | string[] | Record<string, string | string[]>;

export interface RetryYaml {
  /** Attempts including the first. 1 = no retry. Default 5 in ADK. */
  max_attempts?: number;
  /** Seconds before the first retry. */
  initial_delay?: number;
  max_delay?: number;
  backoff_factor?: number;
  /** Randomness of the backoff: 0 none, default 1 (ADK's). */
  jitter?: number;
  /** Error names a failure is retried on (its class's or its `name`); every error when absent. */
  exceptions?: string[];
}

/** Per-node settings. A node is an agent (modifiers only) or exactly one of the kinds. */
export interface WorkflowNodeYaml {
  /** Pause and ask the person this; the reply becomes the node's output. */
  ask_user?: string;
  /** JSON Schema a structured reply to `ask_user` must satisfy. A plain-text reply passes as is. */
  schema?: Record<string, unknown>;
  /** Wait for every predecessor, then output `{ <predecessor>: <output> }`. */
  join?: true;
  /** Run this agent once per item of a list input, concurrently; output the list of results. */
  map?: string;
  /** Concurrency of `map`. Default 8. */
  max_parallel?: number;
  /** Run this registry tool with the node input as its arguments. */
  tool?: string;
  /** Property of a JSON output holding the route (agents). Default "route". */
  route_key?: string;
  retry?: RetryYaml;
  /** Seconds this node may run before it fails. */
  timeout?: number;
}

export interface WorkflowConfig {
  /** Chains, each a list of elements; `START` begins at least one of them. */
  edges: EdgeElement[][];
  nodes?: Record<string, WorkflowNodeYaml>;
  /** Nodes that may run at once. Default: unbounded. */
  max_concurrency?: number;
}

/** True when the syndicate is a graph (a `workflow:` block is present). */
export function isWorkflowSyndicate(config: { workflow?: unknown }): config is { workflow: WorkflowConfig } {
  return !!config.workflow && typeof config.workflow === 'object';
}

export const NODE_KINDS = ['ask_user', 'join', 'map', 'tool'] as const;

/** The kind a node entry declares, or undefined for a modifier-only entry (an agent). */
export function nodeKind(node: WorkflowNodeYaml | undefined): (typeof NODE_KINDS)[number] | undefined {
  if (!node) return undefined;
  return NODE_KINDS.find((k) => node[k] !== undefined);
}

/** Every name an edge element references (`START` excluded). */
export function elementNames(element: EdgeElement): string[] {
  if (typeof element === 'string') return element === START_NAME ? [] : [element];
  if (Array.isArray(element)) return element;
  return Object.values(element).flatMap((v) => (Array.isArray(v) ? v : [v]));
}

/** ADK's retry config from the YAML spelling. */
export function toRetryConfig(retry: RetryYaml | undefined): AdkRetryConfig | undefined {
  if (!retry) return undefined;
  const out: AdkRetryConfig = {};
  if (retry.max_attempts !== undefined) out.maxAttempts = retry.max_attempts;
  if (retry.initial_delay !== undefined) out.initialDelay = retry.initial_delay;
  if (retry.max_delay !== undefined) out.maxDelay = retry.max_delay;
  if (retry.backoff_factor !== undefined) out.backoffFactor = retry.backoff_factor;
  if (retry.jitter !== undefined) out.jitter = retry.jitter;
  if (retry.exceptions !== undefined) out.exceptions = [...retry.exceptions];
  return out;
}

/** The BaseNode fields a node entry's modifiers map to. */
export function nodeSettings(node: WorkflowNodeYaml | undefined): { retryConfig?: AdkRetryConfig; timeout?: number } {
  const out: { retryConfig?: AdkRetryConfig; timeout?: number } = {};
  const retry = toRetryConfig(node?.retry);
  if (retry) out.retryConfig = retry;
  if (node?.timeout !== undefined) out.timeout = node.timeout;
  return out;
}

/**
 * The route an output names: the `routeKey` property of an object (a parsed
 * JSON output), else the trimmed text. Never undefined, so an edge with a
 * `default` key always has something to fall back from. One function for
 * both runtimes; it lives in lib/workflow/route.ts.
 */
export { routeOf } from './workflow/route.ts';

/** A pause raised by an `ask_user` node, read from the run's events (`adk_request_input`). */
export interface PendingInput {
  /** The interrupt id. A plain-text next message answers it. */
  id: string;
  /** The node that asked. */
  node: string;
  /** The question. */
  message: string;
  payload?: unknown;
  /** JSON Schema a structured answer must satisfy, when the node declared one. */
  schema?: unknown;
}

/** ADK's function-call name for a workflow input request. */
export const INPUT_REQUEST = 'adk_request_input';

/** The request an `adk_request_input` call carries, or undefined for another call. */
export function inputRequestFrom(author: string | undefined, call: { name?: string; args?: Record<string, unknown> }): PendingInput | undefined {
  if (call.name !== INPUT_REQUEST) return undefined;
  const args = call.args ?? {};
  return {
    id: String(args.interruptId ?? ''),
    node: author ?? '',
    message: typeof args.message === 'string' ? args.message : '',
    ...(args.payload !== undefined && args.payload !== null ? { payload: args.payload } : {}),
    ...(args.response_schema !== undefined && args.response_schema !== null ? { schema: args.response_schema } : {}),
  };
}

/** One line a person can read: what the workflow is waiting for. */
export function describeInput(input: PendingInput): string {
  const options = (input.payload as { options?: unknown } | undefined)?.options;
  const choices = Array.isArray(options) && options.length ? ` (${options.join(' / ')})` : '';
  return `${input.node} asks: ${input.message || '(no question text)'}${choices}`;
}
