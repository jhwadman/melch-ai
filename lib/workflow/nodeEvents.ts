/**
 * lib/workflow/nodeEvents.ts — the events ADK 2.2 stores for the workflow
 * nodes the scheduler runs itself: a join and a map (ADR 0030, ADR 0093).
 *
 * The scheduler (lib/workflow/scheduler.ts) runs joins and maps as graph
 * mechanics and hands back their outputs; on ADK each is a node whose
 * output becomes a stored event. A session the native walk writes must hold
 * the same events, so agentNodeRuntime (lib/workflow/agentNode.ts) stores
 * these on the scheduler's `node_end`, beside the route step's
 * (lib/workflow/route.ts):
 *
 *   - A JOIN is ADK's JoinNode: one event it creates itself, authored by the
 *     node, on its branch, its output the joined `{ <predecessor>: <output> }`,
 *     with no content.
 *   - A MAP is ADK's ParallelWorker, which yields its result list as a plain
 *     value. BaseNode.toEvent turns that into an event with the list as its
 *     output and `toContent(list)` as its content: genai's
 *     createModelContent of the list when every item is a string or a Part,
 *     else one text part holding the list's JSON.
 *
 * Both are then stamped as ADK's node runner stamps every event
 * (enrichNodeEvent: the path, `outputFor`). Item runs have no wrapper event
 * on ADK: each item's agent stores its own events. It imports nothing from
 * ADK.
 */

import { createTurnEvent } from '../runtime/events.ts';
import type { TurnContent, TurnEvent, TurnPart } from '../runtime/events.ts';
import type { NodeRun } from './scheduler.ts';
import { enrichNodeEvent } from './toolNode.ts';

/** Where the node ran: the scheduler's node_end for it, and the run's invocation. */
export interface GraphNodeEventRun extends Pick<NodeRun, 'path' | 'branch'> {
  /** The node's YAML name: the event's author. */
  name: string;
  invocationId: string;
  output: unknown;
}

/** The event ADK's JoinNode stores: createEvent({ author, invocationId, branch, output }), stamped. */
export function joinNodeEvent(run: GraphNodeEventRun): TurnEvent {
  const event = createTurnEvent({ author: run.name, invocationId: run.invocationId, branch: run.branch, output: run.output });
  return enrichNodeEvent(event, run, { invocationId: run.invocationId });
}

/**
 * The event ADK stores for a map's result list (BaseNode.toEvent of the
 * value its ParallelWorker yields): createEvent({ author, invocationId,
 * branch, content: toContent(output), output }), stamped. Undefined when
 * there is no output, as ADK yields nothing then.
 */
export function mapNodeEvent(run: GraphNodeEventRun): TurnEvent | undefined {
  if (run.output === undefined || run.output === null) return undefined;
  const event = createTurnEvent({ author: run.name, invocationId: run.invocationId, branch: run.branch, content: nodeOutputContent(run.output), output: run.output });
  return enrichNodeEvent(event, run, { invocationId: run.invocationId });
}

/** ADK's isContent: an object with a `parts` array. */
function isContent(value: unknown): value is TurnContent {
  return typeof value === 'object' && value !== null && Array.isArray((value as { parts?: unknown }).parts);
}

/** genai's _isPart: an object carrying one of a Part's data keys. */
const PART_KEYS = ['fileData', 'text', 'functionCall', 'functionResponse', 'inlineData', 'videoMetadata', 'codeExecutionResult', 'executableCode'];
function isPart(value: unknown): value is TurnPart {
  return typeof value === 'object' && value !== null && PART_KEYS.some((key) => key in value);
}

/** genai's _toParts: a string, a Part, or a non-empty list of strings and Parts; anything else throws. */
function toParts(value: unknown): TurnPart[] {
  if (typeof value === 'string') return [{ text: value }];
  if (isPart(value)) return [value];
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error('partOrString cannot be an empty array');
    return value.map((item) => {
      if (typeof item === 'string') return { text: item };
      if (isPart(item)) return item;
      throw new Error('element in PartUnion must be a Part object or string');
    });
  }
  throw new Error('partOrString must be a Part object, string, or array');
}

/** ADK's valueToText: a string as it is, else its JSON, else its string form. */
function valueToText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * ADK's toContent (workflow/base_node.js) for a node's output: a Content as
 * it is; else genai's createModelContent of it; when that throws (a number,
 * an object, an empty list, a list holding anything but strings and Parts),
 * one model text part holding the value's text.
 */
export function nodeOutputContent(value: unknown): TurnContent | undefined {
  if (value === null || value === undefined) return undefined;
  if (isContent(value)) return value;
  try {
    return { role: 'model', parts: toParts(value) };
  } catch {
    return { role: 'model', parts: [{ text: valueToText(value) }] };
  }
}
