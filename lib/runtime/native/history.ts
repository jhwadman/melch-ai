/**
 * lib/runtime/native/history.ts — which stored events a native model call
 * sees, and in what form (ADR 0045, ADR 0066).
 *
 * WHY this file exists:
 *   A model request's history is the session's events projected for one
 *   agent: its own turns as they are, the person's words as they are,
 *   another agent's turns retold as context, approvals and credential
 *   requests left out, and a tool's late answer moved next to the call it
 *   answers. ADK's content processor does this on the ADK runtime
 *   (agents/processors/content_processor_utils.js in @google/adk 2.2), and a
 *   session one runtime wrote must read the same on the other, so this is
 *   that processor, rule for rule, over TurnEvents:
 *
 *   - includeContents `default`: every visible event; `none`: from the
 *     latest message by the person or by another agent, reaching back to
 *     the calls its tool answers answer (getCurrentTurnContents).
 *   - Skipped: an event with no role, or whose first part is empty text; an
 *     event on another branch (a branch that is not a prefix of this one);
 *     an event in another isolation scope; ADK's credential, confirmation
 *     and input-request calls and answers.
 *   - Another agent's event becomes a user message: "For context:", then
 *     `[name] said: …`, `[name] called tool …`, `[name] tool … returned
 *     result: …`, any other part copied.
 *   - The latest compaction summary stands in for the events it covers, as
 *     "[Previous Context Summary]:\n<summary>".
 *   - The answer to the latest call is merged and moved next to that call;
 *     an earlier call's answers likewise.
 *   - ADK's own call ids (`adk-…`) are removed: the provider never sees them.
 *   The contents are deep copies, so nothing here changes a stored event.
 *
 * The result is genai-shaped content, as stored. The request builder maps it
 * to the model contract through lib/models/genaiMapping.ts, the same mapping
 * the ADK shim applies, so both runtimes hand an adapter the same messages.
 */

import type { TurnContent, TurnEvent, TurnFunctionCall, TurnPart } from '../events.ts';
import { getFunctionCalls, getFunctionResponses } from '../events.ts';

/** ADK prefixes the call ids it makes with this (AF_FUNCTION_CALL_ID_PREFIX). */
export const ADK_CALL_ID_PREFIX = 'adk-';

/** ADK's framework calls that a model never sees in its history. */
export const REQUEST_CONFIRMATION_CALL = 'adk_request_confirmation';
export const REQUEST_CREDENTIAL_CALL = 'adk_request_credential';
export const REQUEST_INPUT_CALL = 'adk_request_input';

const UNSTRINGIFIABLE_VALUE = '<unstringifiable value>';

/** Where in a session the projecting agent stands. */
export interface HistoryScope {
  /** The agent whose request this is: its own events stay as they are. */
  agentName: string;
  /** `default` (the conversation) or `none` (the current turn only). */
  includeContents?: 'default' | 'none';
  /** The invocation's branch; undefined at the root. */
  branch?: string;
  /** The invocation's isolation scope; undefined outside one. */
  isolationScope?: string;
}

/** A compaction ADK stored: a summary in place of the events up to `endTime`. */
interface CompactedEvent extends TurnEvent {
  isCompacted: true;
  compactedContent?: string;
  endTime?: number;
}

function isCompacted(event: TurnEvent): event is CompactedEvent {
  return (event as { isCompacted?: unknown }).isCompacted === true;
}

function isVisible(event: TurnEvent, scope: string | undefined): boolean {
  return event.isolationScope === undefined || event.isolationScope === scope;
}

/** The latest compaction and what follows it, or every visible event when there is none. */
function activeEvents(events: readonly TurnEvent[], scope: string | undefined): TurnEvent[] {
  const visible = events.filter((e) => isVisible(e, scope));
  const latest = visible.filter(isCompacted).pop();
  if (!latest) return visible;
  return [latest, ...visible.filter((e) => !isCompacted(e) && e.timestamp > (latest.endTime as number))];
}

function isSegmentPrefix(current: string | undefined, target: string | undefined): boolean {
  return !target || target === current || (!!current && current.startsWith(`${target}.`));
}

function namesCall(event: TurnEvent, name: string): boolean {
  return (event.content?.parts ?? []).some((p) => p.functionCall?.name === name || p.functionResponse?.name === name);
}

function shouldInclude(event: TurnEvent, branch: string | undefined, scope: string | undefined): boolean {
  if (!event.content?.role || event.content.parts?.[0]?.text === '') return false;
  if (branch && event.branch && !isSegmentPrefix(branch, event.branch)) return false;
  if (!isVisible(event, scope)) return false;
  return !namesCall(event, REQUEST_CREDENTIAL_CALL) && !namesCall(event, REQUEST_CONFIRMATION_CALL) && !namesCall(event, REQUEST_INPUT_CALL);
}

function fromAnotherAgent(agentName: string, event: TurnEvent): boolean {
  return !!agentName && event.author !== agentName && event.author !== 'user';
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') return json;
  } catch {
    // fall through to String()
  }
  try {
    return String(value);
  } catch {
    return UNSTRINGIFIABLE_VALUE;
  }
}

/** Another agent's event, retold to this one as context in a user message. */
function retold(event: TurnEvent): TurnEvent {
  if (!event.content?.parts?.length) return event;
  const parts: TurnPart[] = [{ text: 'For context:' }];
  for (const part of event.content.parts) {
    if (part.text && !part.thought) {
      parts.push({ text: `[${event.author}] said: ${part.text}` });
    } else if (part.functionCall) {
      parts.push({ text: `[${event.author}] called tool \`${part.functionCall.name}\` with parameters: ${safeStringify(part.functionCall.args)}` });
    } else if (part.functionResponse) {
      parts.push({ text: `[${event.author}] tool \`${part.functionResponse.name}\` returned result: ${safeStringify(part.functionResponse.response)}` });
    } else {
      parts.push(clone(part));
    }
  }
  return { ...event, author: 'user', content: { role: 'user', parts } };
}

function summaryOf(event: CompactedEvent): TurnEvent {
  return { ...event, author: 'user', content: { role: 'user', parts: [{ text: `[Previous Context Summary]:\n${event.compactedContent}` }] } };
}

/** Several answer events as one, a later answer to a call replacing an earlier one in place. */
function mergeResponses(events: readonly TurnEvent[]): TurnEvent {
  if (events.length === 0) throw new Error('Cannot merge an empty list of events.');
  const first = events[0] as TurnEvent;
  const content = clone(first.content);
  const parts = content?.parts;
  if (!parts || parts.length === 0) throw new Error('There should be at least one function_response part.');
  const index = new Map<string, number>();
  parts.forEach((part, i) => {
    if (part.functionResponse?.id) index.set(part.functionResponse.id, i);
  });
  for (const event of events.slice(1)) {
    if (!event.content?.parts) throw new Error('There should be at least one function_response part.');
    for (const part of event.content.parts) {
      const copy = clone(part);
      const id = copy.functionResponse?.id;
      if (id) {
        const at = index.get(id);
        if (at !== undefined) parts[at] = copy;
        else {
          parts.push(copy);
          index.set(id, parts.length - 1);
        }
      } else {
        parts.push(copy);
      }
    }
  }
  return { ...first, content };
}

/** The latest event answers calls: its answers, merged, sit right after the event that made those calls. */
function latestAnswerNextToItsCall(events: TurnEvent[]): TurnEvent[] {
  if (events.length === 0) return events;
  const latest = events[events.length - 1] as TurnEvent;
  const responses = getFunctionResponses(latest);
  if (!responses.length) return events;
  const ids = new Set(responses.filter((r) => !!r.id).map((r) => r.id as string));
  const secondLatest = events.at(-2);
  if (secondLatest && getFunctionCalls(secondLatest).some((c) => c.id && ids.has(c.id))) return events;

  let match: { at: number; ids: Set<string> } | undefined;
  for (let i = events.length - 2; i >= 0 && !match; i--) {
    const calls = getFunctionCalls(events[i] as TurnEvent);
    if (!calls.length) continue;
    if (!calls.some((c) => c.id && ids.has(c.id))) continue;
    const callIds = new Set(calls.map((c) => c.id).filter((id): id is string => !!id));
    if (![...ids].every((id) => callIds.has(id))) {
      throw new Error(
        `Last response event should only contain the responses for the function calls in the same function call event. Function call ids found : ${[...callIds].join(', ')}, function response ids provided: ${[...ids].join(', ')}`,
      );
    }
    match = { at: i, ids: callIds };
  }
  if (!match) throw new Error(`No function call event found for function responses ids: ${[...ids].join(', ')}`);

  const answers: TurnEvent[] = [];
  for (let i = match.at + 1; i < events.length - 1; i++) {
    const event = events[i] as TurnEvent;
    if (getFunctionResponses(event).some((r) => r.id && match.ids.has(r.id))) answers.push(event);
  }
  answers.push(latest);
  return [...events.slice(0, match.at + 1), mergeResponses(answers)];
}

/** Each earlier call's answers, wherever they landed, sit right after the call. */
function answersNextToTheirCalls(events: readonly TurnEvent[]): TurnEvent[] {
  const answeredAt = new Map<string, number>();
  events.forEach((event, i) => {
    for (const r of getFunctionResponses(event)) if (r.id) answeredAt.set(r.id, i);
  });
  const out: TurnEvent[] = [];
  for (const event of events) {
    if (getFunctionResponses(event).length > 0) continue;
    const calls = getFunctionCalls(event);
    out.push(event);
    if (!calls.length) continue;
    const at = new Set<number>();
    for (const call of calls) {
      const i = call.id ? answeredAt.get(call.id) : undefined;
      if (i !== undefined) at.add(i);
    }
    if (at.size === 1) out.push(events[[...at][0] as number] as TurnEvent);
    else if (at.size > 1) out.push(mergeResponses([...at].sort((a, b) => a - b).map((i) => events[i] as TurnEvent)));
  }
  return out;
}

function stripAdkCallIds(content: TurnContent | undefined): void {
  for (const part of content?.parts ?? []) {
    if (part.functionCall?.id?.startsWith(ADK_CALL_ID_PREFIX)) part.functionCall.id = undefined;
    if (part.functionResponse?.id?.startsWith(ADK_CALL_ID_PREFIX)) part.functionResponse.id = undefined;
  }
}

/** The contents of every visible event, projected for `agentName` (ADK's getContents). */
function contentsOf(events: readonly TurnEvent[], agentName: string, branch: string | undefined, scope: string | undefined): TurnContent[] {
  const kept: TurnEvent[] = [];
  for (const event of events) {
    if (!isVisible(event, scope)) continue;
    if (isCompacted(event)) {
      kept.push(summaryOf(event));
      continue;
    }
    if (!shouldInclude(event, branch, scope)) continue;
    kept.push(fromAnotherAgent(agentName, event) ? retold(event) : event);
  }
  const arranged = answersNextToTheirCalls(latestAnswerNextToItsCall(kept));
  return arranged.map((event) => {
    const content = clone(event.content) as TurnContent;
    stripAdkCallIds(content);
    return content;
  });
}

/** Where the current turn starts: the anchor, or earlier when its answers answer earlier calls. */
function turnStart(events: readonly TurnEvent[], anchor: number): number {
  const answered = new Set<string>();
  for (const event of events.slice(anchor)) {
    for (const part of event.content?.parts ?? []) if (part.functionResponse?.id) answered.add(part.functionResponse.id);
  }
  if (answered.size === 0) return anchor;
  let start = anchor;
  for (let i = anchor - 1; i >= 0; i--) {
    const calls: TurnFunctionCall[] = (events[i]?.content?.parts ?? []).flatMap((p) => (p.functionCall ? [p.functionCall] : []));
    if (calls.some((c) => (c.id ? answered.has(c.id) : false))) start = i;
  }
  return start;
}

/**
 * The genai contents a model request carries for `scope.agentName`, from
 * the session's events (oldest first), as ADK's content processor builds
 * them for the same session.
 */
export function projectHistory(events: readonly TurnEvent[], scope: HistoryScope): TurnContent[] {
  const active = activeEvents(events, scope.isolationScope);
  if ((scope.includeContents ?? 'default') === 'default') {
    return contentsOf(active, scope.agentName, scope.branch, scope.isolationScope);
  }
  for (let i = active.length - 1; i >= 0; i--) {
    const event = active[i] as TurnEvent;
    if (!shouldInclude(event, scope.branch, scope.isolationScope)) continue;
    if (event.author === 'user' || fromAnotherAgent(scope.agentName, event)) {
      return contentsOf(active.slice(turnStart(active, i)), scope.agentName, scope.branch, scope.isolationScope);
    }
  }
  return [];
}

// ── Gemini code execution in the history ─────────────────────────────────────

/** ADK's BaseCodeExecutor delimiters: the first code block's, and the result's. */
const CODE_BLOCK = ['```tool_code\n', '\n```'] as const;
const EXECUTION_RESULT = ['```tool_output\n', '\n```'] as const;

/**
 * An agent with `code_execution: gemini`: a content that ends in code
 * becomes that code as a fenced block, and a content that is only a result
 * becomes the result as a user message (ADK's convertCodeExecutionParts,
 * which its code-execution processor applies to every content). In place.
 */
export function convertCodeExecutionParts(content: TurnContent): void {
  const parts = content.parts;
  if (!parts?.length) return;
  const last = parts[parts.length - 1] as TurnPart;
  if (last.executableCode) {
    parts[parts.length - 1] = { text: CODE_BLOCK[0] + (last.executableCode.code || '') + CODE_BLOCK[1] };
  } else if (parts.length === 1 && last.codeExecutionResult) {
    const output = last.codeExecutionResult.output;
    parts[parts.length - 1] = { text: output == null ? '' : EXECUTION_RESULT[0] + output + EXECUTION_RESULT[1] };
    content.role = 'user';
  }
}
