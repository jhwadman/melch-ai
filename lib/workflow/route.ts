/**
 * lib/workflow/route.ts — the route a workflow node's output takes, and the
 * event a route step stores (ADR 0030, ADR 0090).
 *
 * ADK's TypeScript port never derives a route from an agent's output, so a
 * routing map after a node gets a hidden step, `<Node>__route`, that reads
 * the route from the output and re-emits the output with it (lib/workflow.ts
 * compiles it as a FunctionNode; lib/workflow/scheduler.ts runs it itself).
 * The rule is one function both runtimes call, `routeOf`:
 *
 *   - an object output (an agent with an output schema, a join, a tool's
 *     result): its `route_key` property, `route` by default, trimmed, `''`
 *     when the property is absent or null;
 *   - a string output: the text, trimmed. A JSON object an agent WITHOUT an
 *     output schema writes is text, as ADK keeps it (run_llm_agent_as_node's
 *     maybeSetOutput parses only with a schema), so it routes on its whole
 *     text, which usually takes the `default` edge;
 *   - anything else: its string form, trimmed; `''` for undefined or null.
 *
 * The scheduler then matches the route against the keys in ADK's spelling
 * and takes the `default` edge when no key matched (scheduler.ts nextNodes),
 * so the default catches every route no key names, `''` included.
 *
 * `routeStepEvent` is the event ADK's route step stores, so a session the
 * native walk writes holds what ADK's holds: authored by the step, the
 * output and the route, the step's node path, no content.
 *
 * No ADK import: the ADK path (lib/workflow.ts) imports `routeOf` from here
 * through lib/workflowConfig.ts.
 */

import { createTurnEvent } from '../runtime/events.ts';
import type { TurnEvent, TurnRouteKey } from '../runtime/events.ts';

/** The route_key a routing map reads when the node sets none. */
export const DEFAULT_ROUTE_PROPERTY = 'route';

/**
 * The route a node's output takes: the `routeKey` property of an object
 * output, else the trimmed text, else `''`. Linear in the output's size; no
 * regular expression.
 */
export function routeOf(output: unknown, routeKey: string = DEFAULT_ROUTE_PROPERTY): string {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const value = (output as Record<string, unknown>)[routeKey];
    if (value === undefined || value === null) return '';
    return String(value).trim();
  }
  if (typeof output === 'string') return output.trim();
  return output === undefined || output === null ? '' : String(output).trim();
}

/** Where a route step ran: the scheduler's node_end for it. */
export interface RouteStepRun {
  /** The step's name, `<Node>__route`. */
  name: string;
  /** Its node path, `<workflow>.<Node>__route`. */
  path: string;
  branch: string | undefined;
  invocationId: string;
  /** The output it re-emits: its predecessor's. */
  output: unknown;
  /** The route it emitted (routeOf). */
  route: unknown;
}

/**
 * The event ADK stores for a route step: its FunctionNode's createEvent
 * (author, invocation, branch, output, route), stamped by the node runner
 * with the step's path and `outputFor` (node_runner.js enrichEvent).
 */
export function routeStepEvent(run: RouteStepRun): TurnEvent {
  const event = createTurnEvent({
    author: run.name,
    invocationId: run.invocationId,
    ...(run.branch !== undefined ? { branch: run.branch } : {}),
  });
  if (run.output !== undefined) event.output = run.output;
  if (run.route !== undefined) event.route = run.route as TurnRouteKey | TurnRouteKey[];
  event.nodeInfo = { path: run.path, ...(run.output !== undefined ? { outputFor: [run.path] } : {}) };
  return event;
}
