/**
 * lib/workflow/resume.ts — a paused workflow resumes on the engine's own
 * scheduler, as ADK 2.2 resumes it (ADR 0094).
 *
 * A walk that paused on an `ask_user` node (lib/workflow/pause.ts, ADR 0092)
 * ended the turn `input-required`. The next message answers it. ADK keeps no
 * workflow state between the two turns: it rebuilds every node's state from
 * the session's events (workflow/utils/rehydration_utils.js) and walks the
 * graph again from START. This module is that rebuild, with no ADK import,
 * function for function:
 *
 *   1. THE RUN'S EVENTS (eventsForCurrentRun). The events of the current
 *      invocation, plus those of every paused run immediately before it, so
 *      a run paused twice resumes with both halves.
 *   2. THE ANSWERS. A plain-text message answers the one open interrupt
 *      (run_node_as_invocation.js resumeInputsFromPlainText), and a
 *      function response named for an interrupt answers it explicitly
 *      (resolvedInterruptResponses: `{ result: x }` unwrapped, a structured
 *      reply checked against the request's `response_schema`, a reply to an
 *      unknown or already-answered interrupt refused with ADK's message).
 *      Together they are ADK's `ctx.resumeInputs`.
 *   3. THE NODE STATES (reconstructNodeRuns). Per direct child of the
 *      workflow, its runs in order: the output, route and branch an event
 *      carried, the interrupts it raised, the answers to them, and the
 *      input recorded in `actions.agentState.input` (pause.ts writes it).
 *   4. THE WALK'S INPUT (extractNodeInput): the message's text, else the
 *      message itself, as ADK hands its root workflow.
 *
 * `workflowResume` puts the four together; the scheduler
 * (lib/workflow/scheduler.ts, `RunWorkflowOptions.resume`) then treats a
 * node whose prior run has an output and no open interrupt as done
 * (`isFastForwardable`), reruns a paused node that reruns on resume
 * (`rerunsOnResume`) on its recorded input with the answers in
 * `NodeRun.resumeInputs`, and walks on. An ask_user node rerun with an
 * answer outputs `{ reply, input }` (pause.ts), as the FunctionNode
 * lib/workflow.ts compiles does.
 *
 * TRUST: the answers are the person's words and the stored events are the
 * session's; both are data the walk carries, never instructions this module
 * acts on. A function call in an event the user authored raises nothing:
 * only a node's event opens an interrupt. No regular expression reads input.
 */

import { z } from 'zod';

import type { TurnContent, TurnEvent, TurnPart } from '../runtime/events.ts';
import { APPROVAL_REQUEST } from '../runtime/approvals.ts';
import { CREDENTIAL_REQUEST } from '../runtime/credentials.ts';
import { INPUT_REQUEST } from '../workflowConfig.ts';
import type { GraphNode } from './graph.ts';
import { RESPONSE_SCHEMA_ARG } from './pause.ts';

/** The key ADK unwraps a bare reply from: `{ result: <value> }`. */
const RESULT_KEY = 'result';

/** A stored event, as far as the resume reads it. */
export type StoredEvent = Partial<Pick<TurnEvent, 'author' | 'invocationId' | 'content' | 'longRunningToolIds' | 'output' | 'route' | 'branch' | 'nodeInfo' | 'actions'>>;

/** One run of a node, rebuilt from the stored events (ADK's rehydrated node run). */
export interface PriorNodeRun {
  output?: unknown;
  route?: unknown;
  /** The branch of the event that carried the output. */
  branch?: string;
  /** The input recorded for the resume (`actions.agentState.input`). */
  input?: unknown;
  /** The interrupts the run raised. */
  interruptIds: Set<string>;
  /** The answers to them, by interrupt id. */
  resolvedResponses: Map<string, unknown>;
}

/** What the scheduler resumes from: every node's prior runs and the answers. */
export interface ResumeState {
  /** Per direct child of the workflow, its runs in the order they ran. The scheduler takes one per activation. */
  priorRuns: Map<string, PriorNodeRun[]>;
  /** The answers, by interrupt id (ADK's ctx.resumeInputs), in the order ADK collects them. */
  resumeInputs: Record<string, unknown>;
}

const partsOf = (event: Pick<StoredEvent, 'content'>): TurnPart[] => event.content?.parts ?? [];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringOr = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// ── 1. The run's events ──────────────────────────────────────────────────────

/**
 * ADK's raisedInterrupt (requiresUserInput): the event carries an input,
 * credential or confirmation request with an interrupt id.
 */
export function raisedInterrupt(event: Pick<StoredEvent, 'content'>): boolean {
  for (const part of partsOf(event)) {
    const call = part.functionCall;
    if (!call?.name) continue;
    if (call.name !== INPUT_REQUEST && call.name !== CREDENTIAL_REQUEST && call.name !== APPROVAL_REQUEST) continue;
    const args = call.args ?? {};
    const credential = call.name === CREDENTIAL_REQUEST;
    // ADK camel-cases a credential request's keys before it reads functionCallId.
    const id = call.id ?? stringOr(args.interruptId) ?? stringOr(args.functionCallId) ?? (credential ? stringOr(args.function_call_id) : undefined);
    if (id) return true;
  }
  return false;
}

/**
 * ADK's eventsForCurrentRun: the events from the start of the current
 * invocation, extended back over every run just before it that paused (an
 * event without an invocation id belongs to the one before it; events
 * without a node path neither start nor pause a run).
 */
export function eventsForCurrentRun<E extends StoredEvent>(events: readonly E[], currentInvocationId: string): E[] {
  const priorRuns: Array<{ start: number; invocationId: string | undefined; paused: boolean }> = [];
  let currentStart = events.length;
  let lastInvocationId: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const invocationId = event.invocationId || lastInvocationId;
    if (event.invocationId) lastInvocationId = event.invocationId;
    if (invocationId === currentInvocationId) {
      if (currentStart === events.length) currentStart = i;
      continue;
    }
    if (!event.nodeInfo?.path) continue;
    let entry = priorRuns[priorRuns.length - 1];
    if (!entry || entry.invocationId !== invocationId) {
      entry = { start: i, invocationId, paused: false };
      priorRuns.push(entry);
    }
    if (raisedInterrupt(event)) entry.paused = true;
  }
  let boundary = currentStart;
  for (let i = priorRuns.length - 1; i >= 0 && priorRuns[i]!.paused; i--) boundary = priorRuns[i]!.start;
  return events.slice(boundary);
}

// ── 2. The answers ───────────────────────────────────────────────────────────

/** ADK's responseSchemasByInterruptId: the schema each input request declared. */
export function responseSchemasByInterruptId(events: readonly StoredEvent[]): Map<string, unknown> {
  const schemas = new Map<string, unknown>();
  for (const event of events) {
    for (const part of partsOf(event)) {
      const call = part.functionCall;
      if (call?.name !== INPUT_REQUEST || !call.id) continue;
      const schema = call.args?.[RESPONSE_SCHEMA_ARG];
      if (schema) schemas.set(call.id, schema);
    }
  }
  return schemas;
}

/** ADK's acceptsString: whether a JSON Schema admits a string. */
function acceptsString(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  const type = schema.type;
  if (type === 'string') return true;
  if (Array.isArray(type) && type.includes('string')) return true;
  for (const key of ['anyOf', 'oneOf']) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some(acceptsString)) return true;
  }
  return false;
}

/** ADK's unwrapResponse: `{ result: x }` is x, a JSON string parsed unless the schema takes a string. */
export function unwrapResponse(response: unknown, responseSchema?: unknown): unknown {
  if (isRecord(response) && Object.keys(response).length === 1 && RESULT_KEY in response) {
    const value = response[RESULT_KEY];
    if (typeof value !== 'string' || acceptsString(responseSchema)) return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return response;
}

/**
 * ADK's interruptResponseMismatch: a structured reply (an object) that the
 * request's schema refuses, as ADK's message; a scalar reply, or a schema
 * zod cannot read, is not checked.
 */
export function interruptResponseMismatch(interruptId: string, value: unknown, jsonSchema: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (jsonSchema === null || typeof jsonSchema !== 'object') return undefined;
  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return undefined;
  }
  const result = validator.safeParse(value);
  if (result.success) return undefined;
  const issues = result.error.issues
    .map((issue) => `${issue.message}${issue.path.length ? ` at '${issue.path.join('.')}'` : ''}`)
    .join('; ');
  return `The reply to interrupt '${interruptId}' does not match the responseSchema it declared: ${issues}. A structured reply must either match that schema, or wrap a bare value as {result: <value>}; a plain-text reply is accepted as-is and is not checked. The interrupt is still waiting, so you can answer it again.`;
}

const waitingList = (open: Set<string>): string =>
  open.size ? `Still waiting: ${[...open].map((id) => `'${id}'`).join(', ')}.` : 'This run has no interrupt waiting for an answer.';

function lastUserEvent<E extends StoredEvent>(events: readonly E[]): E | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.author === 'user') return events[i];
  return undefined;
}

/**
 * ADK's resolvedInterruptResponses: every interrupt a function response in
 * a user event answered, with the answer unwrapped. The newest user turn is
 * held to account: a reply there to an interrupt that is not open, or one
 * its schema refuses, throws ADK's message; an older one is skipped.
 */
export function resolvedInterruptResponses(events: readonly StoredEvent[]): Map<string, unknown> {
  const responseSchemas = responseSchemasByInterruptId(events);
  const newestUserTurn = lastUserEvent(events);
  const raised = new Set<string>();
  const open = new Set<string>();
  const resolved = new Map<string, unknown>();
  for (const event of events) {
    if (event.author === 'user' && event.content?.parts) {
      for (const part of event.content.parts) {
        const response = part.functionResponse;
        if (!response?.id) continue;
        if (!open.has(response.id)) {
          if (response.name === INPUT_REQUEST && event === newestUserTurn) {
            throw new Error(
              raised.has(response.id)
                ? `Interrupt '${response.id}' has already been answered, so this reply resolves nothing. Sending it again does not change the earlier answer, and it would otherwise be served as a new message, restarting the node that asked. ${waitingList(open)}`
                : `The reply carries interrupt id '${response.id}', which does not match any interrupt this run raised. ${waitingList(open)} A reply must use the id from the 'adk_request_input' function call it answers. Nothing was resolved, so any waiting interrupt can still be answered.`,
            );
          }
          continue;
        }
        const schema = responseSchemas.get(response.id);
        const value = unwrapResponse(response.response, schema);
        const mismatch = interruptResponseMismatch(response.id, value, schema);
        if (mismatch) {
          if (event === newestUserTurn) throw new Error(mismatch);
          continue;
        }
        open.delete(response.id);
        resolved.set(response.id, value);
      }
      continue;
    }
    for (const id of event.longRunningToolIds ?? []) {
      raised.add(id);
      open.add(id);
    }
  }
  return resolved;
}

// ── 3. The node states ───────────────────────────────────────────────────────

/** ADK's nodeNameFromPath: the last segment of a path, without its `@<run>` suffix. */
export function nodeNameFromPath(path: string): string {
  let start = 0;
  for (let i = 0; i < path.length; i++) if (path[i] === '.' || path[i] === '/') start = i + 1;
  const leaf = path.slice(start);
  const at = leaf.indexOf('@');
  return at === -1 ? leaf : leaf.slice(0, at);
}

/** ADK's directChildName: the child of `parentPath` an event's path names, or undefined for any other path. */
export function directChildName(path: string, parentPath: string): string | undefined {
  const prefix = `${parentPath}.`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  if (rest.includes('.')) return undefined;
  const at = rest.indexOf('@');
  return at === -1 ? rest : rest.slice(0, at);
}

const isRunClosed = (run: PriorNodeRun): boolean => run.output !== undefined || run.route !== undefined || run.interruptIds.size > 0;

type KeyFor = (event: StoredEvent) => string | undefined;

function keyFn(parentPath: string | undefined): KeyFor {
  if (parentPath) return (event) => (event.nodeInfo?.path ? directChildName(event.nodeInfo.path, parentPath) : undefined);
  return (event) => (event.nodeInfo?.path ? nodeNameFromPath(event.nodeInfo.path) : event.author);
}

/** ADK's reconstructRuns: each key's runs, a run closing on an output, a route or an interrupt. */
function reconstructRuns(events: readonly StoredEvent[], keyFor: KeyFor): Map<string, PriorNodeRun[]> {
  const nodes = new Map<string, PriorNodeRun[]>();
  const interruptOwner = new Map<string, PriorNodeRun>();
  const resolved = resolvedInterruptResponses(events);
  const currentRun = (name: string): PriorNodeRun => {
    let runs = nodes.get(name);
    if (!runs) {
      runs = [];
      nodes.set(name, runs);
    }
    const open = runs[runs.length - 1];
    if (open && !isRunClosed(open)) return open;
    const run: PriorNodeRun = { interruptIds: new Set(), resolvedResponses: new Map() };
    runs.push(run);
    return run;
  };
  for (const event of events) {
    if (event.author === 'user' && event.content?.parts) {
      for (const part of event.content.parts) {
        const id = part.functionResponse?.id;
        if (id && interruptOwner.has(id) && resolved.has(id)) interruptOwner.get(id)!.resolvedResponses.set(id, resolved.get(id));
      }
      continue;
    }
    const key = keyFor(event);
    if (!key) continue;
    const run = currentRun(key);
    if (event.output !== undefined) {
      run.output = event.output;
      run.branch = event.branch;
    }
    if (event.route !== undefined) run.route = event.route;
    for (const id of event.longRunningToolIds ?? []) {
      run.interruptIds.add(id);
      interruptOwner.set(id, run);
    }
    const agentState = event.actions?.agentState;
    if (isRecord(agentState) && 'input' in agentState) run.input = agentState.input;
  }
  return nodes;
}

/** ADK's reconstructNodeRuns: per direct child of `parentPath` (or per node name at the root), its runs in order. */
export function reconstructNodeRuns(events: readonly StoredEvent[], parentPath?: string): Map<string, PriorNodeRun[]> {
  return reconstructRuns(events, keyFn(parentPath));
}

/** ADK's reconstructNodeStates: each key's runs merged into one state. */
export function reconstructNodeStates(events: readonly StoredEvent[], parentPath?: string): Map<string, PriorNodeRun> {
  const merged = new Map<string, PriorNodeRun>();
  for (const [key, runs] of reconstructRuns(events, keyFn(parentPath))) {
    const node: PriorNodeRun = { interruptIds: new Set(), resolvedResponses: new Map() };
    for (const run of runs) {
      if (run.output !== undefined) {
        node.output = run.output;
        node.branch = run.branch;
      }
      if (run.route !== undefined) node.route = run.route;
      if (run.input !== undefined) node.input = run.input;
      for (const id of run.interruptIds) node.interruptIds.add(id);
      for (const [id, value] of run.resolvedResponses) node.resolvedResponses.set(id, value);
    }
    merged.set(key, node);
  }
  return merged;
}

/** ADK's isFastForwardable: the run produced an output or a route, and every interrupt it raised is answered. */
export function isFastForwardable(run: PriorNodeRun): boolean {
  if (run.output === undefined && run.route === undefined) return false;
  for (const id of run.interruptIds) if (!run.resolvedResponses.has(id)) return false;
  return true;
}

/**
 * ADK's rerunOnResume, by node kind as lib/workflow.ts compiles them: an
 * agent (LlmAgent), an ask_user node (its FunctionNode sets it) and a map
 * (ParallelWorker) run again on resume; a tool node, a join and a route
 * step (BaseNode's default) do not, and resolve to their answers instead.
 */
export function rerunsOnResume(node: GraphNode): boolean {
  return node.kind === 'agent' || node.kind === 'ask_user' || node.kind === 'map';
}

// ── 4. The walk's input, and the plain-text answer ───────────────────────────

/** ADK's extractNodeInput: the message's text parts joined, else the message itself. */
export function workflowNodeInput(content: TurnContent | undefined): unknown {
  if (!content) return undefined;
  const texts = (content.parts ?? []).filter((p) => typeof p.text === 'string');
  if (texts.length > 0) return texts.map((p) => p.text).join('');
  return content;
}

/**
 * ADK's resumeInputsFromPlainText: a message of text parts only answers the
 * one interrupt left open in the run's events; with none or several open,
 * it answers nothing (it is the walk's new input).
 */
export function resumeInputsFromPlainText(content: TurnContent | undefined, events: readonly StoredEvent[], invocationId: string): Record<string, unknown> {
  const parts = content?.parts ?? [];
  if (!(parts.length > 0 && parts.every((p) => typeof p.text === 'string'))) return {};
  const text = parts.map((p) => p.text).join('');
  const pending = new Set<string>();
  for (const state of reconstructNodeStates(eventsForCurrentRun(events, invocationId)).values()) {
    for (const id of state.interruptIds) if (!state.resolvedResponses.has(id)) pending.add(id);
  }
  if (pending.size !== 1) return {};
  const [id] = pending;
  return { [id!]: text };
}

// ── What the native walk cannot resume yet ───────────────────────────────────

/**
 * A pause the native walk cannot resume: one raised inside an agent node
 * other than an approval (an `ask_user` tool call, a credential request) or
 * inside a map item. ADK resumes those inside the node (the agent's own
 * history, the ParallelWorker's item); the native agent node pauses only on
 * an approval (lib/workflow/agentNode.ts, ADR 0098), so it cannot pick the
 * others up. Resuming the walk anyway would run the node again from its
 * input and ask again, so the resume refuses by name instead.
 */
export class UnsupportedWorkflowResumeError extends Error {
  /** The node path the pause was raised at. */
  readonly nodePath: string;
  constructor(nodePath: string, why: string) {
    super(`Cannot resume the workflow on the native runtime: the pause at '${nodePath}' was raised ${why}, which only an ask_user node's pause or an agent node's approval supports here.`);
    this.name = 'UnsupportedWorkflowResumeError';
    this.nodePath = nodePath;
  }
}

/**
 * Throws UnsupportedWorkflowResumeError for the first interrupt in the run's
 * events that is neither an ask_user node's input request nor an agent
 * node's approval request at a direct child of the workflow (the workflow's
 * own record aside).
 */
export function assertResumable(runEvents: readonly StoredEvent[], workflowPath: string): void {
  for (const event of runEvents) {
    if (event.author === 'user' || !(event.longRunningToolIds?.length)) continue;
    const path = event.nodeInfo?.path ?? '';
    if (path === workflowPath) continue;
    if (directChildName(path, workflowPath) === undefined) throw new UnsupportedWorkflowResumeError(path || String(event.author ?? ''), 'inside a nested node (a map item)');
    const resumable = partsOf(event).some((p) => p.functionCall?.name === INPUT_REQUEST || p.functionCall?.name === APPROVAL_REQUEST);
    if (!resumable) throw new UnsupportedWorkflowResumeError(path, 'inside an agent node');
  }
}

// ── Together ─────────────────────────────────────────────────────────────────

export interface WorkflowResumeRequest {
  /** The session's events, the new message already stored (as the Runner stores it before the walk). */
  events: readonly StoredEvent[];
  /** The new turn's invocation id. */
  invocationId: string;
  /** The new message. */
  userContent: TurnContent | undefined;
  /** The workflow's node path (its name at the root). */
  workflowPath: string;
}

export interface WorkflowResumeStart {
  /** The walk's input: the new message's text, as ADK hands its root workflow. */
  input: unknown;
  /** What the scheduler resumes from (`RunWorkflowOptions.resume`). */
  resume: ResumeState;
}

/**
 * Everything a walk needs to resume as ADK's does: the new message as the
 * walk's input, the prior runs of each node of the workflow, and the
 * answers. On a session with nothing paused, every node runs fresh (its
 * prior runs belong to finished invocations, which the run's events leave
 * out). Throws ADK's message for a reply that answers nothing open, and
 * UnsupportedWorkflowResumeError for a pause only ADK can resume.
 */
export function workflowResume(request: WorkflowResumeRequest): WorkflowResumeStart {
  const resumeInputs = resumeInputsFromPlainText(request.userContent, request.events, request.invocationId);
  const runEvents = eventsForCurrentRun(request.events, request.invocationId);
  assertResumable(runEvents, request.workflowPath);
  const priorRuns = reconstructNodeRuns(runEvents, request.workflowPath || undefined);
  // ADK's applyResumeInputs: the explicit answers, over the plain-text one.
  for (const [id, value] of resolvedInterruptResponses(runEvents)) resumeInputs[id] = value;
  return { input: workflowNodeInput(request.userContent), resume: { priorRuns, resumeInputs } };
}
