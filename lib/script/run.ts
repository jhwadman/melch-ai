/**
 * lib/script/run.ts — one run of a syndicate's `script:` (ADR 0137 Part B):
 * the script in the sandbox, its calls journaled, a paused run resumed by
 * replaying them.
 *
 * WHAT THE SCRIPT IS PASSED (item 6): `message`, `transcript` and
 * `variables`, and the functions `agent`, `tool`, `askUser`, `now`,
 * `random`, `log`, plus the sandbox's `parallel`. Nothing else reaches it.
 * The host (lib/runtime/syndicateTurn.ts) supplies what `agent` and `tool`
 * do; this module owns the journal, the replay and the pause.
 *
 * REPLAY (item 9). A paused run's next message runs the script again from
 * the top, on the source, message and transcript the pause pinned. Each
 * call is answered from the journal while one is recorded for it: a call is
 * matched on its kind, its name and the hash of its arguments, the first
 * unconsumed entry that matches, so concurrency under `parallel` (whose
 * calls start in an order that depends on what finished first) replays the
 * same. The open askUser takes the person's answer; the calls after it run
 * live. A run that ends with recorded calls it never made again diverged:
 * it fails SCRIPT_DIVERGED, naming the first. Replayed calls are never
 * charged again, and log() lines are not repeated while the run replays.
 *
 * THE PAUSE (item 10). A live askUser lets the calls already in flight
 * settle, stores the run's journal and the pause, then halts the sandbox; a call
 * started after it waits forever and dies with the run, so a second
 * question is asked only once the first is answered.
 */

import { randomUUID } from 'node:crypto';

import type { TurnEvent } from '../runtime/events.ts';
import { getFunctionCalls } from '../runtime/events.ts';
import { SandboxHalt, runInSandbox } from '../sandbox/sandbox.ts';
import type { SandboxLimits } from '../sandbox/sandbox.ts';
import { inputRequestFrom } from '../workflowConfig.ts';
import type { PendingInput } from '../workflowConfig.ts';
import { callEvent, callHash, endEvent, pauseEvent, sourceHash } from './journal.ts';
import type { JournalEntry, ScriptCallKind, ScriptCallOutcome, ScriptCallRecord } from './journal.ts';

/** The most calls one run may journal (item 13), as a walk has NODE_RUN_LIMIT. */
export const SCRIPT_CALL_LIMIT = 1_000;

/** What the turn runner gives a run. */
export interface ScriptHost {
  /** The script's name: every journal event's author. */
  script: string;
  invocationId: string;
  /** Runs a declared agent; a plain Error is thrown into the script, a SandboxHalt ends the run. */
  agent(name: string, input: unknown, opts: Record<string, unknown>, seq: number): Promise<unknown>;
  /** Runs an allowed registry tool; errors as for agent. */
  tool(name: string, args: unknown, seq: number): Promise<unknown>;
  /** Appends journal events to the conversation, in order (only when the run pauses, or a resumed run ends). */
  append(event: TurnEvent): Promise<void>;
  /** Called once, before the pause event is written. */
  beforePause?(): Promise<void>;
  /** A `[STATUS]` progress line. */
  log(text: string): void;
  signal: AbortSignal;
  newInterruptId?: () => string;
}

export interface ScriptRunInput {
  source: string;
  message: string;
  transcript: string;
  variables: Record<string, unknown>;
  /** The paused run being resumed: its id, its journal, and the person's answer. */
  resume?: { run: string; entries: JournalEntry[]; answer: string };
  callLimit?: number;
  limits?: Partial<SandboxLimits>;
}

export type ScriptRunOutcome =
  | { status: 'completed'; run: string; value: unknown; logs: string }
  | { status: 'paused'; run: string; input: PendingInput; logs: string }
  | { status: 'failed'; run: string; error: { code: string; message: string }; logs: string };

/** Fatal: thrown by a host function to fail the turn with a code. */
export class ScriptFatal extends SandboxHalt {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message, { code });
    this.code = code;
  }
}

const never = <T>(): Promise<T> => new Promise<T>(() => {});

function replayed(outcome: ScriptCallOutcome): unknown {
  if ('error' in outcome) {
    const err = new Error(outcome.error.message);
    err.name = outcome.error.name;
    throw err;
  }
  return outcome.value;
}

function describe(entry: Pick<JournalEntry, 'kind' | 'name' | 'seq'>): string {
  return `${entry.kind}(${JSON.stringify(entry.name)}) recorded as call ${entry.seq}`;
}

export async function runScript(input: ScriptRunInput, host: ScriptHost): Promise<ScriptRunOutcome> {
  const run = input.resume?.run ?? `r-${randomUUID()}`;
  const pending: JournalEntry[] = input.resume ? input.resume.entries.filter((e) => e.outcome || e.pause) : [];
  let nextSeq = (input.resume?.entries ?? []).reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  const limit = input.callLimit ?? SCRIPT_CALL_LIMIT;
  const inflight = new Set<Promise<unknown>>();
  const askedIds = new Set<string>();
  let calls = 0;
  let pausing = false;
  let paused: PendingInput | undefined;
  let answeredPause = false;
  /** This turn's journal events, stored only if the run pauses (or closes a resumed run). */
  const journal: TurnEvent[] = [];
  const flush = async () => {
    for (const event of journal.splice(0)) await host.append(event);
  };

  /** The first recorded call with this kind, name and hash, removed from the journal still to replay. */
  const take = (kind: ScriptCallKind, name: string, hash: string): JournalEntry | undefined => {
    const at = pending.findIndex((e) => e.kind === kind && e.name === name && e.hash === hash);
    return at === -1 ? undefined : pending.splice(at, 1)[0];
  };
  const count = () => {
    if (++calls > limit) throw new ScriptFatal('SCRIPT_CALL_LIMIT', `The script made more than ${limit} calls in one run.`);
  };

  /** A call: replayed from the journal when recorded, else run and journaled. */
  const call = (kind: ScriptCallKind, name: string, args: unknown, exec: (seq: number) => Promise<unknown>): Promise<unknown> => {
    if (pausing) return never();
    count();
    const hash = callHash(kind, name, args);
    const recorded = take(kind, name, hash);
    if (recorded?.outcome) return Promise.resolve().then(() => replayed(recorded.outcome!));
    const record: ScriptCallRecord = { run, seq: nextSeq++, kind, name, hash };
    const running = (async () => {
      let outcome: ScriptCallOutcome;
      try {
        outcome = { value: (await exec(record.seq)) ?? null };
      } catch (err) {
        if (err instanceof SandboxHalt || host.signal.aborted) throw err;
        const e = err instanceof Error ? err : new Error(String(err));
        outcome = { error: { name: e.name || 'Error', message: e.message } };
      }
      journal.push(callEvent(host.script, host.invocationId, record, outcome));
      return replayed(outcome);
    })();
    inflight.add(running);
    running.then(
      () => inflight.delete(running),
      () => inflight.delete(running),
    );
    return running;
  };

  const askUser = async (id: unknown, question: unknown, opts: unknown): Promise<unknown> => {
    if (typeof id !== 'string' || !id) throw new TypeError('askUser(id, question, { payload?, schema? }): id must be a non-empty string, unique within the run');
    if (typeof question !== 'string' || !question) throw new TypeError('askUser(id, question, …): question must be a non-empty string');
    const o = opts && typeof opts === 'object' ? (opts as { payload?: unknown; schema?: unknown }) : {};
    const schema = o.schema && typeof o.schema === 'object' ? (o.schema as Record<string, unknown>) : undefined;
    if (askedIds.has(id)) throw new Error(`askUser: the id '${id}' was already asked in this run; each question needs its own id`);
    askedIds.add(id);
    const args = { question, payload: o.payload ?? null, schema: schema ?? null };
    const hash = callHash('askUser', id, args);
    const recorded = take('askUser', id, hash);
    if (recorded?.outcome) return replayed(recorded.outcome);
    if (recorded?.pause && input.resume) {
      // The question the run waits on: this turn's message is the answer.
      const value = { reply: input.resume.answer, input: args.payload };
      journal.push(callEvent(host.script, host.invocationId, { run, seq: recorded.seq, kind: 'askUser', name: id, hash }, { value }));
      answeredPause = true;
      return value;
    }
    if (pausing) return never();
    count();
    pausing = true;
    // Calls already running finish and are journaled, so the resume replays them instead of paying again (item 10).
    await Promise.allSettled([...inflight]);
    const record: ScriptCallRecord = { run, seq: nextSeq++, kind: 'askUser', name: id, hash };
    const interruptId = (host.newInterruptId ?? randomUUID)();
    await host.beforePause?.();
    const event = pauseEvent(
      host.script,
      host.invocationId,
      record,
      { run, source: input.source, source_hash: sourceHash(input.source), message: input.message, transcript: input.transcript, interrupt_id: interruptId },
      { message: question, ...(o.payload !== undefined ? { payload: o.payload } : {}), ...(schema ? { schema } : {}) },
    );
    await flush();
    await host.append(event);
    const [request] = getFunctionCalls(event);
    paused = inputRequestFrom(host.script, request!);
    throw new SandboxHalt('waiting for the person');
  };

  const sandboxed = await runInSandbox({
    source: input.source,
    mode: 'api',
    value: { message: input.message, transcript: input.transcript, variables: input.variables },
    signal: host.signal,
    limits: { ...input.limits },
    functions: {
      agent: ([name, agentInput, opts]) => {
        if (typeof name !== 'string' || !name) throw new TypeError('agent(name, input, opts?): name must be a declared agent\'s name');
        const o = opts === undefined || opts === null ? {} : opts;
        if (typeof o !== 'object' || Array.isArray(o)) throw new TypeError('agent(name, input, opts?): opts must be an object');
        return call('agent', name, { input: agentInput ?? null, opts: o }, (seq) => host.agent(name, agentInput ?? null, o as Record<string, unknown>, seq));
      },
      tool: ([name, args]) => {
        if (typeof name !== 'string' || !name) throw new TypeError('tool(name, args): name must be a tool in script.tools');
        return call('tool', name, args ?? {}, (seq) => host.tool(name, args ?? {}, seq));
      },
      askUser: ([id, question, opts]) => askUser(id, question, opts),
      now: () => call('now', 'now', null, async () => Date.now()),
      random: () => call('random', 'random', null, async () => Math.random()),
      log: ([text]) => {
        // A replayed run already said these.
        if (!pending.length) host.log(typeof text === 'string' ? text : JSON.stringify(text));
        return null;
      },
    },
  });

  const logs = sandboxed.logs;
  // A resumed run that ended (not one the turn's signal stopped) is closed, so the next message starts a new one.
  if (input.resume && !paused && !host.signal.aborted) {
    await flush();
    await host.append(endEvent(host.script, host.invocationId, run, nextSeq++));
  }
  const unreplayed = () => {
    const left = pending[0];
    return left ? { code: 'SCRIPT_DIVERGED', message: `The resumed run did not make the call its journal holds: ${describe(left)}. A script must make the same calls, with the same arguments, on every run (ADR 0137 item 9).` } : undefined;
  };
  if (paused) {
    const diverged = unreplayed();
    if (diverged) return { status: 'failed', run, error: diverged, logs };
    return { status: 'paused', run, input: paused, logs };
  }
  if (sandboxed.halt) {
    const code = sandboxed.halt instanceof ScriptFatal ? sandboxed.halt.code : 'SCRIPT_HALTED';
    return { status: 'failed', run, error: { code, message: sandboxed.halt.message }, logs };
  }
  if (!sandboxed.ok) {
    const error = sandboxed.error!;
    return { status: 'failed', run, error: { code: error.code === 'CODE_ERROR' ? 'SCRIPT_ERROR' : error.code, message: error.message }, logs };
  }
  if (input.resume && !answeredPause) {
    return { status: 'failed', run, error: { code: 'SCRIPT_DIVERGED', message: 'The resumed run never reached the question it was waiting on.' }, logs };
  }
  const diverged = unreplayed();
  if (diverged) return { status: 'failed', run, error: diverged, logs };
  return { status: 'completed', run, value: sandboxed.result, logs };
}
