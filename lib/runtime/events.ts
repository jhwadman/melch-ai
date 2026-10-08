/**
 * lib/runtime/events.ts — the engine's own event type: one step of a
 * conversation as a session stores it (ADR 0045, ADR 0052).
 *
 * WHY this file exists:
 *   The engine reads and writes the sessions ADK wrote, and the
 *   stored Event JSON in adk_sessions.events and adk_session_events is one of
 *   the four shapes ADR 0045 fixes. So the engine's event is not a new
 *   format: TurnEvent IS that JSON, typed. Every field the engine reads has
 *   ADK's name, position in the object and meaning, and a TurnEvent
 *   serializes to the bytes ADK would have stored (tests/events.test.ts
 *   proves it on every session fixture, in both stored forms). The content
 *   stays @google/genai `Content` in shape, described here structurally;
 *   the model contract (lib/models/contract.ts) is what a model call speaks,
 *   reached through lib/models/genaiMapping.ts (ADR 0048 item 8).
 *
 * THE PARSE CARRIES EVERYTHING:
 *   parseTurnEvent checks the type of every field this file declares and
 *   returns the same object, never a projection. A field ADK writes that the
 *   engine does not know (a live-streaming field, a part's videoMetadata, the
 *   camelCase toolCall some providers emit) is kept as it is, in place. That
 *   matters because the Supabase service rewrites a conversation's whole
 *   events array on every append: a parse that dropped an unknown field would
 *   erase it from every stored row the engine touched. It rejects
 *   only what the engine cannot read, with the path of the field and the
 *   type it found, never the value, since events hold what people said.
 *
 * NO RUNTIME IMPORTS: every import here is a type. Nothing in this module's
 * import graph names @google/* (tests/events.test.ts asserts it).
 */

import type { ProviderState } from '../models/contract.ts';

// ── Content (genai's shape, structurally) ────────────────────────────────────

/** A tool call the model made: `part.functionCall`. */
export interface TurnFunctionCall {
  /** ADK's `adk-<uuid>`, or the provider's id. Absent in a request ADK built: it strips its own ids. */
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

/** A tool's answer: `part.functionResponse`. */
export interface TurnFunctionResponse {
  /** The id of the call it answers. */
  id?: string;
  name?: string;
  /**
   * ADK wraps a result that is not an object as `{ result }`. In a trimmed
   * row a result over 2,000 characters is `{ elided: '<size> chars dropped
   * before storage — …' }` (trimEventForStorage, lib/session/transcript.ts).
   */
  response?: Record<string, unknown>;
}

/** One part of a content: genai's `Part`, with the fields the engine reads or writes. */
export interface TurnPart {
  text?: string;
  /** The text is the model's reasoning, shown but never replayed as speech. */
  thought?: boolean;
  /** Gemini's opaque signature. A trimmed row keeps only a call's, as `skip_thought_signature_validator`. */
  thoughtSignature?: string;
  functionCall?: TurnFunctionCall;
  functionResponse?: TurnFunctionResponse;
  inlineData?: { mimeType?: string; data?: string; displayName?: string };
  fileData?: { mimeType?: string; fileUri?: string; displayName?: string };
  executableCode?: { code?: string; language?: string };
  codeExecutionResult?: { outcome?: string; output?: string };
  /** Another provider's reasoning state (ADR 0046), stored whole on the part it belongs before. */
  providerState?: ProviderState;
}

export interface TurnContent {
  /** `user` or `model`. A tool's answer is a `user` content; ADK's confirmation request is too. */
  role?: string;
  parts?: TurnPart[];
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** A pending approval, keyed in `requestedToolConfirmations` by the gated call's id. */
export interface TurnToolConfirmation {
  hint?: string;
  confirmed?: boolean;
  payload?: unknown;
}

/**
 * What the event does besides speak: ADK's `EventActions`. ADK writes the
 * four dictionaries on every event (createTurnEvent does too); they are
 * optional here because a reader must not fail on a row that lacks one.
 */
export interface TurnEventActions {
  /** State writes. `temp:` keys never reach a store (applyEvent, lib/runtime/sessions.ts). */
  stateDelta?: Record<string, unknown>;
  /** Artifact name to version. */
  artifactDelta?: Record<string, number>;
  /** Auth configurations a tool asked for, by call id. */
  requestedAuthConfigs?: Record<string, unknown>;
  /** Approvals asked for, by the gated call's id (ADR 0028). */
  requestedToolConfirmations?: Record<string, TurnToolConfirmation>;
  /** The run ends on this tool response, without a model call to summarize it. */
  skipSummarization?: boolean;
  transferToAgent?: string;
  escalate?: boolean;
  /** A workflow node's checkpointed input, read back when a paused workflow resumes (ADR 0030). */
  agentState?: Record<string, unknown>;
  endOfAgent?: boolean;
}

// ── Usage ────────────────────────────────────────────────────────────────────

/**
 * `usageMetadata`, in Gemini's meanings: `candidatesTokenCount` excludes the
 * thinking counted in `thoughtsTokenCount`. The turn runner sums it per
 * turn: the largest prompt, every completion, every thought.
 */
export interface TurnUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

// ── The event ────────────────────────────────────────────────────────────────

/** Where a workflow event came from (ADR 0030). */
export interface TurnNodeInfo {
  /** The node path, e.g. `Pipeline.Triage`; the root's has no dot. */
  path?: string;
  outputFor?: string[];
  messageAsOutput?: boolean;
}

export type TurnRouteKey = string | number | boolean;

/**
 * One event of a session: the stored ADK Event JSON, typed. The first group
 * is what the engine reads to run and resume a turn; the second is what ADK
 * writes beside it, which the engine stores and reads back unchanged.
 */
export interface TurnEvent {
  /** Eight letters and digits (newEventId). An append with an id already in the session replaces that event. */
  id: string;
  /** Every event of one run shares it. ADK writes `e-<uuid>`. */
  invocationId: string;
  /** `user`, or the name of the agent or workflow node that wrote it. */
  author?: string;
  /** Absent on an event that only carries actions (a workflow's pause marker). */
  content?: TurnContent;
  actions: TurnEventActions;
  /** A streaming fragment: shown, never stored. */
  partial?: boolean;
  /** The model finished this response. */
  turnComplete?: boolean;
  /** Milliseconds since the epoch. */
  timestamp: number;
  /** Labels an adapter attaches, e.g. `responses.server_tool_calls`; JSON only. */
  customMetadata?: Record<string, unknown>;
  /** Ids of this event's calls that wait for a person (`ask_user`, a workflow's input request). */
  longRunningToolIds?: string[];
  /** `parent.child` path that keeps a subagent's events from its peers. */
  branch?: string;
  /**
   * A failure. Gemini reports its finish or block reason here, and `STOP` is
   * not a failure: the turn runner ignores an error whose code is `STOP`.
   */
  errorCode?: string;
  errorMessage?: string;
  usageMetadata?: TurnUsage;

  /** Gemini's finish reason, e.g. `STOP`. */
  finishReason?: string;
  /** Gemini search grounding: queries and sources (lib/grounding.ts reads it). */
  groundingMetadata?: object;
  citationMetadata?: object;
  /** A live session was interrupted mid-answer. */
  interrupted?: boolean;
  modelVersion?: string;
  /** A workflow node's result (ADR 0030). */
  output?: unknown;
  /** The route a workflow routing node chose. */
  route?: TurnRouteKey | TurnRouteKey[];
  nodeInfo?: TurnNodeInfo;
  isolationScope?: string;
}

// ── Reading events: ADK's semantics ──────────────────────────────────────────

/** The event's tool calls, in order: the parts' `functionCall` objects themselves, not copies. */
export function getFunctionCalls(event: TurnEvent): TurnFunctionCall[] {
  const calls: TurnFunctionCall[] = [];
  for (const part of event.content?.parts ?? []) if (part.functionCall) calls.push(part.functionCall);
  return calls;
}

/** The event's tool responses, in order: the parts' `functionResponse` objects themselves. */
export function getFunctionResponses(event: TurnEvent): TurnFunctionResponse[] {
  const responses: TurnFunctionResponse[] = [];
  for (const part of event.content?.parts ?? []) if (part.functionResponse) responses.push(part.functionResponse);
  return responses;
}

/** The last part is a code execution result: the model has more to say about it. */
export function hasTrailingCodeExecutionResult(event: TurnEvent): boolean {
  const parts = event.content?.parts;
  if (!parts?.length) return false;
  return parts[parts.length - 1]?.codeExecutionResult !== undefined;
}

/**
 * The event ends its agent's run: ADK's `isFinalResponse`, case for case.
 *
 * Final at once when the run is meant to stop on it: a tool response that
 * skips summarization (an approval request), a call that waits for a person
 * (long-running ids), or a tool asking for auth. Otherwise final when it
 * carries no tool call, no tool response, is not a streaming fragment, and
 * does not end on a code execution result.
 */
export function isFinal(event: TurnEvent): boolean {
  const actions = event.actions;
  if (
    actions?.skipSummarization ||
    (event.longRunningToolIds && event.longRunningToolIds.length > 0) ||
    (actions?.requestedAuthConfigs && Object.keys(actions.requestedAuthConfigs).length > 0)
  ) {
    return true;
  }
  return (
    getFunctionCalls(event).length === 0 &&
    getFunctionResponses(event).length === 0 &&
    !event.partial &&
    !hasTrailingCodeExecutionResult(event)
  );
}

// ── Making events: ADK's defaults ────────────────────────────────────────────

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A new event id: eight letters and digits, as ADK makes them. */
export function newEventId(): string {
  let id = '';
  const bytes = new Uint8Array(16);
  while (id.length < 8) {
    globalThis.crypto.getRandomValues(bytes);
    // 248 = 4 × 62: a byte at or above it would favour the first letters.
    for (const b of bytes) if (b < 248 && id.length < 8) id += ID_ALPHABET[b % 62];
  }
  return id;
}

/** Actions with ADK's four dictionaries present, then `actions` over them. */
export function createEventActions(actions: TurnEventActions = {}): TurnEventActions {
  return { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {}, ...actions };
}

/** What createTurnEvent takes: any field, every one optional. */
export type TurnEventInit = Partial<Omit<TurnEvent, 'actions'>> & { actions?: TurnEventActions };

/**
 * A new event, built as ADK's `createEvent` builds one, so it serializes to
 * the same JSON, key order included: the given fields first, then the
 * defaults in ADK's order (an id, an empty invocation id, the four action
 * dictionaries, no long-running ids, the time now).
 */
export function createTurnEvent(init: TurnEventInit = {}): TurnEvent {
  return {
    ...init,
    id: init.id || newEventId(),
    invocationId: init.invocationId || '',
    author: init.author,
    actions: createEventActions(init.actions),
    longRunningToolIds: init.longRunningToolIds || [],
    branch: init.branch,
    timestamp: init.timestamp || Date.now(),
  };
}

// ── Parsing stored events ────────────────────────────────────────────────────

/** A stored event the engine cannot read, and where in it. */
export class TurnEventError extends Error {
  /** e.g. `events[3].content.parts[0].functionCall.name` */
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.name = 'TurnEventError';
    this.path = path;
  }
}

type Check = (value: unknown, path: string) => void;

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function fail(path: string, expected: string, value: unknown): never {
  throw new TurnEventError(path, `expected ${expected}, got ${kindOf(value)}`);
}

const isString: Check = (v, p) => {
  if (typeof v !== 'string') fail(p, 'a string', v);
};
const isBoolean: Check = (v, p) => {
  if (typeof v !== 'boolean') fail(p, 'a boolean', v);
};
const isNumber: Check = (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(p, 'a finite number', v);
};
const isRecord: Check = (v, p) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(p, 'an object', v);
};
/** Tool arguments and results: JSON objects, an array allowed (ADK wraps only a non-object result). */
const isObjectOrArray: Check = (v, p) => {
  if (typeof v !== 'object' || v === null) fail(p, 'an object', v);
};
const isAnything: Check = () => {};
const isStringArray: Check = (v, p) => {
  if (!Array.isArray(v)) fail(p, 'an array', v);
  v.forEach((item, i) => isString(item, `${p}[${i}]`));
};
const isNumberRecord: Check = (v, p) => {
  isRecord(v, p);
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) isNumber(x, `${p}.${k}`);
};

/** Checks the declared fields of an object; undeclared ones pass untouched. Undefined counts as absent. */
function fields<T>(table: { [K in keyof T]-?: Check }, required: ReadonlyArray<keyof T> = []): Check {
  return (v, p) => {
    isRecord(v, p);
    const obj = v as Record<string, unknown>;
    for (const key of required) {
      if (obj[key as string] === undefined) throw new TurnEventError(`${p}.${String(key)}`, 'required, but absent');
    }
    for (const key of Object.keys(table) as Array<keyof T & string>) {
      if (obj[key] !== undefined) table[key](obj[key], `${p}.${key}`);
    }
  };
}

const checkFunctionCall = fields<TurnFunctionCall>({ id: isString, name: isString, args: isObjectOrArray });
const checkFunctionResponse = fields<TurnFunctionResponse>({ id: isString, name: isString, response: isObjectOrArray });

const checkPart = fields<TurnPart>({
  text: isString,
  thought: isBoolean,
  thoughtSignature: isString,
  functionCall: checkFunctionCall,
  functionResponse: checkFunctionResponse,
  inlineData: isRecord,
  fileData: isRecord,
  executableCode: isRecord,
  codeExecutionResult: isRecord,
  providerState: isRecord,
});

const checkParts: Check = (v, p) => {
  if (!Array.isArray(v)) fail(p, 'an array', v);
  v.forEach((part, i) => checkPart(part, `${p}[${i}]`));
};

const checkContent = fields<TurnContent>({ role: isString, parts: checkParts });

const checkActions = fields<TurnEventActions>({
  stateDelta: isRecord,
  artifactDelta: isNumberRecord,
  requestedAuthConfigs: isRecord,
  requestedToolConfirmations: isRecord,
  skipSummarization: isBoolean,
  transferToAgent: isString,
  escalate: isBoolean,
  agentState: isRecord,
  endOfAgent: isBoolean,
});

const checkUsage = fields<TurnUsage>({
  promptTokenCount: isNumber,
  candidatesTokenCount: isNumber,
  thoughtsTokenCount: isNumber,
  totalTokenCount: isNumber,
  cachedContentTokenCount: isNumber,
  toolUsePromptTokenCount: isNumber,
});

const checkNodeInfo = fields<TurnNodeInfo>({ path: isString, outputFor: isStringArray, messageAsOutput: isBoolean });

const isRouteKey: Check = (v, p) => {
  if (typeof v !== 'string' && typeof v !== 'boolean' && (typeof v !== 'number' || !Number.isFinite(v))) {
    fail(p, 'a string, number or boolean', v);
  }
};
const checkRoute: Check = (v, p) => {
  if (Array.isArray(v)) v.forEach((key, i) => isRouteKey(key, `${p}[${i}]`));
  else isRouteKey(v, p);
};

/** Every field TurnEvent declares, with its check; the mapped type keeps this table and the type in step. */
const checkEvent = fields<TurnEvent>(
  {
    id: isString,
    invocationId: isString,
    author: isString,
    content: checkContent,
    actions: checkActions,
    partial: isBoolean,
    turnComplete: isBoolean,
    timestamp: isNumber,
    customMetadata: isRecord,
    longRunningToolIds: isStringArray,
    branch: isString,
    errorCode: isString,
    errorMessage: isString,
    usageMetadata: checkUsage,
    finishReason: isString,
    groundingMetadata: isRecord,
    citationMetadata: isRecord,
    interrupted: isBoolean,
    modelVersion: isString,
    output: isAnything,
    route: checkRoute,
    nodeInfo: checkNodeInfo,
    isolationScope: isString,
  },
  ['id', 'invocationId', 'actions', 'timestamp'],
);

/**
 * A stored event, checked: the same object, typed. Throws TurnEventError
 * naming the first field the engine cannot read. Nothing is copied, added,
 * dropped or reordered, so `JSON.stringify` of the result is the stored JSON.
 */
export function parseTurnEvent(value: unknown, path = 'event'): TurnEvent {
  checkEvent(value, path);
  return value as TurnEvent;
}

/** A stored events array (a session's `events`, or a row's), checked the same way. */
export function parseTurnEvents(value: unknown, path = 'events'): TurnEvent[] {
  if (!Array.isArray(value)) fail(path, 'an array', value);
  value.forEach((event, i) => checkEvent(event, `${path}[${i}]`));
  return value as TurnEvent[];
}
