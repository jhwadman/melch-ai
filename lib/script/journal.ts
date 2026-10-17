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

/** `actions.agentState.script_pause`: what a resume runs again. */
export interface ScriptPauseRecord {
  run: string;
  source: string;
  source_hash: string;
  message: string;
  transcript: string;
  /** The interrupt id the person's answer resolves. */
  interrupt_id: string;
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

/** The journal events' marker key under agentState. */
export const SCRIPT_CALL = 'script_call';
export const SCRIPT_PAUSE = 'script_pause';

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

/** The event for a call that returned (or threw into the script). */
export function callEvent(script: string, invocationId: string, call: ScriptCallRecord, outcome: ScriptCallOutcome): TurnEvent {
  return createTurnEvent({
    author: script,
    invocationId,
    nodeInfo: { path: `${script}.${call.seq}` },
    actions: { agentState: { [SCRIPT_CALL]: { ...call } } },
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

const recordOf = (event: TurnEvent): ScriptCallRecord | undefined => {
  const rec = event.actions?.agentState?.[SCRIPT_CALL] as ScriptCallRecord | undefined;
  return rec && typeof rec.run === 'string' && typeof rec.seq === 'number' && typeof rec.kind === 'string' ? rec : undefined;
};

/** The run a conversation waits on: its pause, and every call it recorded, in seq order. Undefined when no run is open. */
export function openRun(events: readonly TurnEvent[], script: string): { pause: ScriptPauseRecord; entries: JournalEntry[] } | undefined {
  let last: TurnEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.author === script && recordOf(e)) {
      last = e;
      break;
    }
  }
  if (!last) return undefined;
  const pause = last.actions.agentState?.[SCRIPT_PAUSE] as ScriptPauseRecord | undefined;
  if (!pause || typeof pause.source !== 'string') return undefined;
  const run = pause.run;
  const bySeq = new Map<number, JournalEntry>();
  for (const e of events) {
    const rec = e.author === script ? recordOf(e) : undefined;
    if (!rec || rec.run !== run) continue;
    const outcome = e.output as ScriptCallOutcome | undefined;
    const p = e.actions.agentState?.[SCRIPT_PAUSE] as ScriptPauseRecord | undefined;
    const prior = bySeq.get(rec.seq);
    bySeq.set(rec.seq, {
      ...rec,
      ...(outcome && typeof outcome === 'object' && ('value' in outcome || 'error' in outcome) ? { outcome } : prior?.outcome ? { outcome: prior.outcome } : {}),
      ...(p ? { pause: p } : prior?.pause ? { pause: prior.pause } : {}),
    });
  }
  return { pause, entries: [...bySeq.values()].sort((a, b) => a.seq - b.seq) };
}
