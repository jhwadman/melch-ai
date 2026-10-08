/**
 * lib/workflow/pause.ts — a workflow `ask_user` node on the engine's own
 * runtime: the walk pauses on a person, as ADK 2.2 pauses it (ADR 0092).
 *
 * On ADK an ask_user node is a FunctionNode (lib/workflow.ts) whose handler
 * returns a `RequestInput` with the YAML's question, the node's input as the
 * payload, and the node's `schema`. ADK turns that into one event and the
 * node into a waiting one. This module writes the same event and reports the
 * same interrupt, with no ADK import:
 *
 *   1. THE REQUEST (base_node.js run, hitl_utils.js createRequestInputEvent).
 *      A `model` content holding one function call, `adk_request_input`,
 *      whose id is a fresh interrupt id and whose args are
 *      `{ interruptId, payload, message, response_schema }`: the node's
 *      input as the payload, the question, and the schema as ADK's
 *      `toJsonSchema` turns a YAML schema (genaiSchemaToJsonSchema, ported
 *      below), `null` for each one absent. `longRunningToolIds` holds the id.
 *   2. THE STAMP (node_runner.js enrichEvent and consume). The author is the
 *      node's YAML name, `nodeInfo.path` its path, the run's branch, and
 *      `actions.agentState.input` the node's input, which is what a resume
 *      reruns the node on.
 *   3. THE WAIT. The run resolves with the id in `interruptIds` and no
 *      output: the scheduler (lib/workflow/scheduler.ts) holds the node
 *      waiting and the walk ends paused.
 *   4. THE WORKFLOW'S RECORD. A walk that ends paused gets one more event,
 *      ADK's recordInputForResume for the workflow node itself:
 *      `workflowPauseEvent`, authored by the workflow, every open id in
 *      `longRunningToolIds`, and the workflow's input in `agentState`. The
 *      caller stores it after the walk, as it stores nodeErrorEvent.
 *
 * Serialized, both events are the JSON ADK stores, key for key
 * (tests/workflowPause.test.ts compares them), so the turn runner's reader
 * (drainAgentStream, inputRequestFrom) reads the same `result.input` from
 * either runtime, and the resume (lib/workflow/resume.ts) rebuilds the node states from
 * them as ADK's rehydration does.
 *
 * THE RESUME (ADR 0094). A resumed walk (lib/workflow/resume.ts) reruns
 * the paused node on the input it recorded, with the answers in
 * `run.resumeInputs`. With an answer there the node does not ask again: its
 * output is `{ reply, input }`, the last answer and its input, written on
 * one event as ADK's FunctionNode writes a handler's output, which is what
 * the FunctionNode lib/workflow.ts compiles returns.
 *
 * NOT HERE: a pause inside an agent node, and the native refusal of a
 * workflow syndicate, which WS4-6 lifts. The question and the payload are data written into
 * the event, never instructions this module acts on.
 */

import { randomUUID } from 'node:crypto';

import { createTurnEvent } from '../runtime/events.ts';
import type { TurnEvent } from '../runtime/events.ts';
import { INPUT_REQUEST } from '../workflowConfig.ts';
import type { AskUserNode } from './graph.ts';
import type { NodeResult, NodeRun, NodeRunner } from './scheduler.ts';
import { enrichNodeEvent } from './toolNode.ts';

/** The arg ADK writes the response schema under. */
export const RESPONSE_SCHEMA_ARG = 'response_schema';

/** Everything an ask_user node needs from the turn it runs in. */
export interface AskUserNodeContext {
  /** The run's invocation id, written on the event. */
  invocationId: string;
  /** Receives the node's event, before the run resolves. */
  onEvent?: (event: TurnEvent) => void;
  /** A fresh interrupt id; default a random UUID, as ADK's RequestInput draws it. */
  newInterruptId?: () => string;
  /** ADK's `outputFor` ancestors; the request carries no output, so only for symmetry with the other runners. */
  outputForAncestors?: string[];
  /** ADK's isolation scope, written on the event when set. */
  isolationScope?: string;
}

/** One input request, as ADK's RequestInput holds it. */
export interface InputRequest {
  interruptId: string;
  message?: string;
  payload?: unknown;
  /** The node's YAML schema, before ADK's conversion. */
  responseSchema?: Record<string, unknown>;
}

// ── The schema, as ADK's toJsonSchema writes a YAML schema ───────────────────

const NUMERIC_STRING_KEYS = new Set(['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties']);
const NON_JSON_SCHEMA_KEYS = new Set(['propertyOrdering', 'example']);
const TYPE_NAMES: Record<string, string> = { STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array', OBJECT: 'object', NULL: 'null' };

/**
 * ADK's genaiSchemaToJsonSchema (utils/genai_schema_to_json.js), which its
 * toJsonSchema applies to a schema that is not zod: genai's upper-case type
 * names become JSON Schema's, `nullable` a type list, the numeric-string
 * bounds numbers. A lower-case `type` is not a genai type name and is
 * dropped, as ADK drops it. Recursive in the schema's depth; no regular
 * expression.
 */
export function genaiSchemaToJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value === undefined || NON_JSON_SCHEMA_KEYS.has(key)) continue;
    switch (key) {
      case 'type':
      case 'nullable':
        break;
      case 'items':
        out.items = genaiSchemaToJsonSchema(value as Record<string, unknown>);
        break;
      case 'properties': {
        const properties: Record<string, unknown> = {};
        for (const [name, property] of Object.entries(value as Record<string, unknown>)) properties[name] = genaiSchemaToJsonSchema(property as Record<string, unknown>);
        out.properties = properties;
        break;
      }
      case 'anyOf':
        out.anyOf = (value as Record<string, unknown>[]).map(genaiSchemaToJsonSchema);
        break;
      case 'format':
        if (value !== 'enum') out.format = value;
        break;
      default:
        out[key] = NUMERIC_STRING_KEYS.has(key) ? Number(value) : value;
    }
  }
  const typeName = typeof schema.type === 'string' ? TYPE_NAMES[schema.type] : undefined;
  if (typeName) out.type = schema.nullable ? [typeName, 'null'] : typeName;
  if (Array.isArray(out.enum) && (typeName === 'integer' || typeName === 'number')) {
    out.enum = out.enum.map((member: unknown) => (typeof member === 'string' && member.trim() !== '' && !isNaN(Number(member)) ? Number(member) : member));
  }
  return out;
}

// ── 1. The request ───────────────────────────────────────────────────────────

/** ADK's createRequestInputEvent: the `adk_request_input` call, before the node runner stamps it. */
export function requestInputEvent(request: InputRequest): TurnEvent {
  const args = {
    interruptId: request.interruptId,
    payload: request.payload ?? null,
    message: request.message ?? null,
    [RESPONSE_SCHEMA_ARG]: request.responseSchema ? genaiSchemaToJsonSchema(request.responseSchema) : null,
  };
  return createTurnEvent({
    content: { role: 'model', parts: [{ functionCall: { name: INPUT_REQUEST, args, id: request.interruptId } }] },
    longRunningToolIds: [request.interruptId],
  });
}

// ── 2 and 3. One run ─────────────────────────────────────────────────────────

/**
 * ADK's FunctionNode output event for a handler's value (base_node.js
 * toContent, function_node.js toEvent): the value as model text (a string as
 * it is, anything else as its JSON) and as the event's output, stamped.
 */
export function answeredEvent(output: unknown, run: Pick<NodeRun, 'path' | 'branch'>, context: Pick<AskUserNodeContext, 'invocationId' | 'outputForAncestors' | 'isolationScope'>): TurnEvent {
  const name = run.path.slice(run.path.lastIndexOf('.') + 1);
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const event = createTurnEvent({ author: name, invocationId: context.invocationId, branch: run.branch, content: { role: 'model', parts: [{ text }] }, output });
  return enrichNodeEvent(event, run, context);
}

/**
 * Run one ask_user node: its request event, stamped as ADK's node runner
 * stamps it, to `context.onEvent`, and the interrupt as the run's result.
 * On a resume with an answer, the node's `{ reply, input }` instead.
 */
export function runAskUserNode(node: AskUserNode, run: Pick<NodeRun, 'input' | 'path' | 'branch' | 'resumeInputs'>, context: AskUserNodeContext): NodeResult {
  // lib/workflow.ts's handler: every answer the resumed walk holds, the last one the reply.
  const replies = Object.values(run.resumeInputs ?? {});
  if (replies.length > 0) {
    const output = { reply: replies[replies.length - 1], input: run.input };
    context.onEvent?.(answeredEvent(output, run, context));
    return { output };
  }
  const interruptId = (context.newInterruptId ?? randomUUID)();
  const event = requestInputEvent({ interruptId, message: node.message, payload: run.input, ...(node.schema ? { responseSchema: node.schema } : {}) });
  enrichNodeEvent(event, run, context);
  // node_runner.js consume: an event with long-running ids records the node's input for the resume.
  event.actions.agentState = { ...(event.actions.agentState ?? {}), input: run.input };
  context.onEvent?.(event);
  return { interruptIds: [interruptId] };
}

/**
 * A scheduler runner that runs ask_user nodes and hands every other run to
 * `next`, as toolNodeRunner and agentNodeRuntime chain. Without `next`, any
 * other run is refused by name.
 */
export function askUserNodeRunner(context: AskUserNodeContext, next?: NodeRunner): NodeRunner {
  return (run) => {
    if (run.target.kind === 'ask_user') return runAskUserNode(run.target, run, context);
    if (next) return next(run);
    const name = run.target.kind === 'map_item' ? `${run.target.map.name}[${run.target.index}]` : run.target.name;
    throw new Error(`askUserNodeRunner runs ask_user nodes only; ${name} is a ${run.target.kind} run`);
  };
}

// ── 4. The workflow's record ─────────────────────────────────────────────────

/** Where the paused walk ran: the workflow node itself. */
export interface PausedWorkflow {
  /** The workflow's name, the event's author (ADK: the root's author, the syndicate name). */
  name: string;
  /** The workflow's node path; default its name. */
  path?: string;
  /** The workflow's own branch; default none. */
  branch?: string;
  invocationId: string;
  /** The workflow's input, recorded for the resume (ADK: the message's text). */
  input: unknown;
  /** Every open interrupt, as the walk returned them (WorkflowRun.interruptIds). */
  interruptIds: string[];
}

/**
 * ADK's recordInputForResume for the workflow node (node_runner.js): the
 * event ADK stores after the last node's when a workflow ends paused.
 */
export function workflowPauseEvent(paused: PausedWorkflow): TurnEvent {
  const event = createTurnEvent({
    author: paused.name,
    invocationId: paused.invocationId,
    branch: paused.branch,
    longRunningToolIds: [...paused.interruptIds],
    actions: { agentState: { input: paused.input } },
  });
  return enrichNodeEvent(event, { path: paused.path ?? paused.name, branch: paused.branch }, { invocationId: paused.invocationId });
}
