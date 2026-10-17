/**
 * lib/script/journal.ts — a script run's record of its calls, kept as
 * node-style events in the conversation (ADR 0137 items 8, 9 and 11).
 *
 * ONE EVENT PER CALL. Each agent, tool, askUser, now and random call a run
 * makes is one event: authored by the script's name, `nodeInfo.path`
 * `<script>.<seq>`, the call in `actions.agentState.script_call` (the run,
 * its seq, the kind, the name and a hash of the arguments) and its result in
 * `event.output`, with no content parts. Those are the fields the Supabase
 * store's trimEventForStorage never touches, so the journal replays the same
 * from it and from Postgres; and with no text part, long-term memory
 * ingestion (which reads text) never sees it.
 *
 * THE PAUSE. A live askUser writes the request ADK's ask_user node writes
 * (`adk_request_input`, lib/workflow/pause.ts), so `result.input` is one
 * shape for every method, plus `script_pause`: the run's pinned source, its
 * message and transcript, which the resume runs again (item 11). Its answer
 * is a second event for the same seq, carrying `{ reply, input }`.
 *
 * WHEN IT IS STORED. Only a run that pauses needs its journal, to replay
 * it, so the runner keeps the events in memory and stores them with the
 * pause; a run that finishes stores none, and the conversation keeps only
 * the exchange, as for a dispatch route (on the Supabase store every append
 * rewrites the session's events). A resumed run that ends stores its
 * answer's event and an `end` marker, closing it.
 *
 * WHICH RUN IS OPEN. The conversation's last journal event decides: a pause
 * with no answer after it is a run waiting for the person; anything else is
 * a finished run, and the next message starts a new one.
 */

import { createHash } from 'node:crypto';

import { createTurnEvent } from '../runtime/events.ts';
import type { TurnEvent } from '../runtime/events.ts';
import { requestInputEvent } from '../workflow/pause.ts';
import { APPROVAL_REQUEST, approvalRequestOf } from '../runtime/approvals.ts';
import type { PendingApproval } from '../runtime/approvals.ts';
import { getFunctionCalls } from '../runtime/events.ts';
import { inputRequestFrom } from '../workflowConfig.ts';
import type { PendingInput } from '../workflowConfig.ts';

/** What a script calls. */
/** What a script calls; `end` marks a resumed run that finished, so the next message starts a new one. */
export type ScriptCallKind = 'agent' | 'tool' | 'askUser' | 'now' | 'random' | 'end';

/** `actions.agentState.script_call`. */
export interface ScriptCallRecord {
  run: string;
  seq: number;
  kind: ScriptCallKind;
  name: string;
  hash: string;
}

/** `actions.agentState.script_run`: what a resume runs again, pinned when the run first stores anything. */
export interface ScriptPinRecord {
  run: string;
  source: string;
  source_hash: string;
  message: string;
  transcript: string;
}

/** `actions.agentState.script_pause`: the pin, and what the run waits on. */
export interface ScriptPauseRecord extends ScriptPinRecord {
  /** The interrupt id the person's answer resolves: a question's, or an approval request's. */
  interrupt_id: string;
  /** `question` (askUser) or `approval` (a gated tool() call). Absent: question. */
  kind?: 'question' | 'approval';
}

/** What one call returned, as the journal keeps it: a value, or the error it threw into the script. */
export type ScriptCallOutcome = { value: unknown } | { error: { name: string; message: string } };

/** One recorded call. */
export interface JournalEntry extends ScriptCallRecord {
  /** Absent for a pause still waiting for its answer. */
  outcome?: ScriptCallOutcome;
  /** The pause record, on an askUser that paused the run. */
  pause?: ScriptPauseRecord;
}

/** The journal events' marker keys under agentState. */
export const SCRIPT_CALL = 'script_call';
export const SCRIPT_PAUSE = 'script_pause';
export const SCRIPT_RUN = 'script_run';

/**
 * Set on a session store that wants every journal event as its call ends,
 * not only when the run pauses: the durable-run store (ADR 0113), whose
 * checkpoint boundary a journal append is, so a worker killed mid-script
 * resumes from its last call (ADR 0137 item 8).
 */
export const JOURNAL_EVERY_CALL: unique symbol = Symbol.for('melchizedek.script.journalEveryCall');

/** True when `sessions` asks for every journal event as its call ends. */
export function journalsEveryCall(sessions: unknown): boolean {
  return !!sessions && typeof sessions === 'object' && (sessions as Record<PropertyKey, unknown>)[JOURNAL_EVERY_CALL] === true;
}

/** True for a script's journal event. */
export function isJournalEvent(event: TurnEvent): boolean {
  return !!recordOf(event);
}

/** A canonical JSON text: object keys sorted, so a hash does not depend on key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** The hash a call is matched on: its kind, name and arguments. */
export function callHash(kind: ScriptCallKind, name: string, args: unknown): string {
  return createHash('sha256').update(canonical([kind, name, args])).digest('hex').slice(0, 24);
}

/** The hash a run's source is pinned by. */
export function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 24);
}

/** The event for a call that returned (or threw into the script); `pin` on the first event a run stores call by call. */
export function callEvent(script: string, invocationId: string, call: ScriptCallRecord, outcome: ScriptCallOutcome, pin?: ScriptPinRecord): TurnEvent {
  return createTurnEvent({
    author: script,
    invocationId,
    nodeInfo: { path: `${script}.${call.seq}` },
    actions: { agentState: { [SCRIPT_CALL]: { ...call }, ...(pin ? { [SCRIPT_RUN]: { ...pin } } : {}) } },
    output: outcome,
  });
}

/** The marker a resumed run that ended leaves: its run is closed. */
export function endEvent(script: string, invocationId: string, run: string, seq: number): TurnEvent {
  return createTurnEvent({
    author: script,
    invocationId,
    nodeInfo: { path: `${script}.${seq}` },
    actions: { agentState: { [SCRIPT_CALL]: { run, seq, kind: 'end', name: 'end', hash: '' } } },
  });
}

/** The event for an askUser that pauses the run: ADK's input request, stamped as a journal entry, with the pinned run. */
export function pauseEvent(
  script: string,
  invocationId: string,
  call: ScriptCallRecord,
  pause: ScriptPauseRecord,
  request: { message: string; payload?: unknown; schema?: Record<string, unknown> },
): TurnEvent {
  const event = requestInputEvent({ interruptId: pause.interrupt_id, message: request.message, payload: request.payload, ...(request.schema ? { responseSchema: request.schema } : {}) });
  event.author = script;
  event.invocationId = invocationId;
  event.nodeInfo = { path: `${script}.${call.seq}` };
  event.actions.agentState = { [SCRIPT_CALL]: { ...call }, [SCRIPT_PAUSE]: { ...pause } };
  return event;
}

/**
 * The event for a gated tool() call that pauses the run: ADK's approval
 * request (`adk_request_confirmation`, lib/runtime/approvals.ts), pinning
 * the call and its arguments, stamped as a journal entry, with the pinned run.
 */
export function approvalEvent(
  script: string,
  invocationId: string,
  call: ScriptCallRecord,
  pause: ScriptPauseRecord,
  request: { tool: string; args: unknown; hint: string },
): TurnEvent {
  const originalFunctionCall = { name: request.tool, args: request.args ?? {}, id: `${call.run}.${call.seq}` };
  return createTurnEvent({
    author: script,
    invocationId,
    nodeInfo: { path: `${script}.${call.seq}` },
    content: {
      role: 'model',
      parts: [{ functionCall: { name: APPROVAL_REQUEST, id: pause.interrupt_id, args: { originalFunctionCall, toolConfirmation: { hint: request.hint, confirmed: false } } } }],
    },
    actions: { agentState: { [SCRIPT_CALL]: { ...call }, [SCRIPT_PAUSE]: { ...pause, kind: 'approval' } } },
  });
}

function recordOf(event: TurnEvent): ScriptCallRecord | undefined {
  const rec = event.actions?.agentState?.[SCRIPT_CALL] as ScriptCallRecord | undefined;
  return rec && typeof rec.run === 'string' && typeof rec.seq === 'number' && typeof rec.kind === 'string' ? rec : undefined;
}

/** A run the conversation has not finished: one waiting on the person, or one a stopped worker left mid-way. */
export interface OpenRun {
  /** `paused`: its last event is a pause. `unfinished`: a run stored call by call whose last event is a call (a durable job resumed after its worker stopped). */
  state: 'paused' | 'unfinished';
  pin: ScriptPinRecord;
  /** The pause, when paused. */
  pause?: ScriptPauseRecord;
  /** Every call it recorded, in seq order. */
  entries: JournalEntry[];
}

/** The run a conversation has open, or undefined: the last journal event decides (a pause, a call of a run stored call by call, or a closing `end`). */
export function openRun(events: readonly TurnEvent[], script: string): OpenRun | undefined {
  let last: TurnEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.author === script && recordOf(e)) {
      last = e;
      break;
    }
  }
  if (!last) return undefined;
  const lastRec = recordOf(last)!;
  if (lastRec.kind === 'end') return undefined;
  const pause = last.actions.agentState?.[SCRIPT_PAUSE] as ScriptPauseRecord | undefined;
  const run = lastRec.run;
  const bySeq = new Map<number, JournalEntry>();
  let pin: ScriptPinRecord | undefined = pause && typeof pause.source === 'string' ? pause : undefined;
  for (const e of events) {
    const rec = e.author === script ? recordOf(e) : undefined;
    if (!rec || rec.run !== run) continue;
    const outcome = e.output as ScriptCallOutcome | undefined;
    const p = e.actions.agentState?.[SCRIPT_PAUSE] as ScriptPauseRecord | undefined;
    const pinned = e.actions.agentState?.[SCRIPT_RUN] as ScriptPinRecord | undefined;
    if (!pin && pinned && typeof pinned.source === 'string') pin = pinned;
    const prior = bySeq.get(rec.seq);
    bySeq.set(rec.seq, {
      ...rec,
      ...(outcome && typeof outcome === 'object' && ('value' in outcome || 'error' in outcome) ? { outcome } : prior?.outcome ? { outcome: prior.outcome } : {}),
      ...(p ? { pause: p } : prior?.pause ? { pause: prior.pause } : {}),
    });
  }
  if (!pin) return undefined;
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  // The last event a pause whose answer has not been stored: the run waits on it.
  if (pause && typeof pause.source === 'string' && !bySeq.get(lastRec.seq)?.outcome) return { state: 'paused', pin, pause, entries };
  return { state: 'unfinished', pin, entries };
}

/**
 * What a script run in a conversation waits on, read as a caller reads a
 * nested syndicate's conversation (lib/runtime/native/interrupts.ts): the
 * open pause of the run whose last event it is, as an approval request or a
 * question, authored by the script. With `id`, only that request counts.
 */
export function scriptPauseIn(events: readonly TurnEvent[], id?: string): { asker: string; approval?: PendingApproval; question?: PendingInput } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const rec = recordOf(e);
    if (!rec || !e.author) continue;
    const pause = e.actions.agentState?.[SCRIPT_PAUSE] as ScriptPauseRecord | undefined;
    if (!pause || e.output !== undefined || (id !== undefined && pause.interrupt_id !== id)) return undefined;
    for (const call of getFunctionCalls(e)) {
      if (call.id !== pause.interrupt_id) continue;
      if (call.name === APPROVAL_REQUEST) return { asker: e.author, approval: approvalRequestOf(e, call as Record<string, any>) };
      const question = inputRequestFrom(e.author, call);
      if (question) return { asker: e.author, question };
    }
    return undefined;
  }
  return undefined;
}
