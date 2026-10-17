/**
 * lib/script/run.ts — one run of a syndicate's `script:` (ADR 0137 Part B):
 * the script in the sandbox, its calls journaled, a paused or interrupted
 * run resumed by replaying them.
 *
 * WHAT THE SCRIPT IS PASSED (item 6): `message`, `transcript` and
 * `variables`, and the functions `agent`, `tool`, `askUser`, `now`,
 * `random`, `log`, plus the sandbox's `parallel`. Nothing else reaches it.
 * The host (lib/runtime/syndicateTurn.ts) supplies what `agent` and `tool`
 * do; this module owns the journal, the replay, the pauses and the spans.
 *
 * REPLAY (item 9). A paused run's next message runs the script again from
 * the top, on the source, message and transcript the run pinned. Each call
 * is answered from the journal while one is recorded for it: a call is
 * matched on its kind, its name and the hash of its arguments, the first
 * unconsumed entry that matches, so concurrency under `parallel` (whose
 * calls start in an order that depends on what finished first) replays the
 * same. The open pause takes the person's answer; the calls after it run
 * live. A run that ends with recorded calls it never made again diverged:
 * it fails SCRIPT_DIVERGED, naming the first. Replayed calls are never
 * charged again, open no span, and log() lines are not repeated while the
 * run replays.
 *
 * THE PAUSES (items 8 and 10). A live askUser, and a tool() call to a tool
 * in `script.require_approval`, let the calls already in flight settle,
 * store the run's journal and the pause, then halt the sandbox; a call
 * started after it waits forever and dies with the run, so a second pause
 * is reached only once the first is answered. A question's answer is the
 * next message (a JSON reply to a question with a schema is parsed, plain
 * text passes as is, as an ask_user node's). An approval's answer is the
 * decision: approved, the pinned arguments run; refused, the script gets
 * `{ error }`, as a refused tool node's output is.
 *
 * WHEN THE JOURNAL IS STORED. Only a paused run reads it, so by default it
 * is stored with the pause and a run that finishes stores none (on the
 * Supabase store every append rewrites the session's events). A durable
 * run's store (JOURNAL_EVERY_CALL, lib/runtime/native/checkpoint.ts) takes
 * each event as its call ends, the first carrying the pin, and treats each
 * as a checkpoint boundary, so a worker killed mid-script resumes from its
 * last call. A resumed run that ends, and a durable run that finishes,
 * store an `end` marker.
 *
 * THE SPANS (item 16). `script.invoke <name>` around the run and
 * `script.call <kind>:<name>` around each live call, in their own trace,
 * with no argument and no result on them; each agent() call's own turn
 * span carries `script.run` and `script.call.seq` (the host adds them), so
 * a trace view pairs them.
 */

import { randomUUID } from 'node:crypto';

import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

import type { TurnEvent } from '../runtime/events.ts';
import { getFunctionCalls } from '../runtime/events.ts';
import { approvalRequestOf } from '../runtime/approvals.ts';
import type { PendingApproval } from '../runtime/approvals.ts';
import { RUNTIME_SPAN_SCOPE } from '../observability/lineage.ts';
import { startEngineSpan } from '../observability/tracer.ts';
import { SandboxHalt, runInSandbox } from '../sandbox/sandbox.ts';
import type { SandboxLimits } from '../sandbox/sandbox.ts';
import { APPROVAL_TEXTS } from '../tools/tool.ts';
import { inputRequestFrom } from '../workflowConfig.ts';
import type { PendingInput } from '../workflowConfig.ts';
import { approvalEvent, callEvent, callHash, endEvent, pauseEvent, sourceHash } from './journal.ts';
import type { JournalEntry, ScriptCallKind, ScriptCallOutcome, ScriptCallRecord, ScriptPinRecord } from './journal.ts';

/** The most calls one run may journal (item 13), as a walk has NODE_RUN_LIMIT. */
export const SCRIPT_CALL_LIMIT = 1_000;

/** Where a call sits in its run: what the host stamps on an agent's span and lane. */
export interface ScriptCallSite {
  run: string;
  seq: number;
}

/** What the turn runner gives a run. */
export interface ScriptHost {
  /** The script's name: every journal event's author and span's. */
  script: string;
  invocationId: string;
  /** The conversation, for the spans. */
  sessionId?: string;
  /** Runs a declared agent; a plain Error is thrown into the script, a SandboxHalt ends the run. */
  agent(name: string, input: unknown, opts: Record<string, unknown>, site: ScriptCallSite): Promise<unknown>;
  /** Runs an allowed registry tool; errors as for agent. */
  tool(name: string, args: unknown, site: ScriptCallSite): Promise<unknown>;
  /** Whether a tool's calls wait for a person's approval (`script.require_approval`). */
  gated?(name: string): boolean;
  /** Appends a journal event to the conversation. */
  append(event: TurnEvent): Promise<void>;
  /** Every journal event as its call ends (a durable run), not only when the run pauses. */
  journalEveryCall?: boolean;
  /** Called once, before a pause is stored. */
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
  /**
   * The run being resumed: its id and journal, and what the open pause
   * takes: the person's answer to a question, or the decision on an
   * approval. A run a stopped worker left (no pause) takes neither.
   */
  resume?: { run: string; entries: JournalEntry[]; answer?: string; decision?: { approved: boolean } };
  callLimit?: number;
  limits?: Partial<SandboxLimits>;
}

export type ScriptRunOutcome =
  | { status: 'completed'; run: string; value: unknown; logs: string }
  | { status: 'paused'; run: string; input: PendingInput; logs: string }
  | { status: 'approval'; run: string; approval: PendingApproval; logs: string }
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

/** A question's reply: parsed when the question declared a schema and the reply is JSON, else the text. */
function replyOf(answer: string, schema: unknown): unknown {
  if (!schema) return answer;
  const text = answer.trim();
  if (!/^[[{"]|^-?\d|^(true|false|null)$/.test(text)) return answer;
  try {
    return JSON.parse(text);
  } catch {
    return answer;
  }
}

export async function runScript(input: ScriptRunInput, host: ScriptHost): Promise<ScriptRunOutcome> {
  const run = input.resume?.run ?? `r-${randomUUID()}`;
  const pending: JournalEntry[] = input.resume ? input.resume.entries.filter((e) => e.outcome || e.pause) : [];
  let nextSeq = (input.resume?.entries ?? []).reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  const limit = input.callLimit ?? SCRIPT_CALL_LIMIT;
  const inflight = new Set<Promise<unknown>>();
  const askedIds = new Set<string>();
  const pin: ScriptPinRecord = { run, source: input.source, source_hash: sourceHash(input.source), message: input.message, transcript: input.transcript };
  // A run stored call by call pins itself on its first event; a resumed one already did.
  let pinStored = !!input.resume;
  let calls = 0;
  let replayedCalls = 0;
  let pausing = false;
  let paused: PendingInput | undefined;
  let approval: PendingApproval | undefined;
  let answeredPause = false;
  /** Journal events not yet stored: all of them until a pause, unless the host takes each as its call ends. */
  const journal: TurnEvent[] = [];
  const flush = async () => {
    for (const event of journal.splice(0)) await host.append(event);
  };
  const record = async (event: TurnEvent) => {
    journal.push(event);
    if (host.journalEveryCall) await flush();
  };
  const outcomeEvent = (call: ScriptCallRecord, outcome: ScriptCallOutcome): TurnEvent => {
    const withPin = host.journalEveryCall && !pinStored;
    if (withPin) pinStored = true;
    return callEvent(host.script, host.invocationId, call, outcome, withPin ? pin : undefined);
  };

  // ── Spans ──────────────────────────────────────────────────────────────────
  const invokeSpan: Span = startEngineSpan(RUNTIME_SPAN_SCOPE, `script.invoke ${host.script}`, {
    root: true,
    attributes: {
      'gen_ai.operation.name': 'invoke_script',
      'syndicate.name': host.script,
      'script.name': host.script,
      'script.run': run,
      'script.source_hash': pin.source_hash,
      'script.resumed': !!input.resume,
      'adk.invocation_id': host.invocationId,
      ...(host.sessionId ? { 'session.id': host.sessionId, 'gen_ai.conversation.id': host.sessionId } : {}),
    },
  });
  const parent = trace.setSpan(ROOT_CONTEXT, invokeSpan);
  const callSpan = (call: ScriptCallRecord): Span =>
    startEngineSpan(
      RUNTIME_SPAN_SCOPE,
      `script.call ${call.kind}:${call.name}`,
      {
        attributes: {
          'gen_ai.operation.name': 'execute_script_call',
          'syndicate.name': host.script,
          'script.name': host.script,
          'script.run': run,
          'script.call.kind': call.kind,
          'script.call.name': call.name,
          'script.call.seq': call.seq,
          ...(host.sessionId ? { 'session.id': host.sessionId } : {}),
        },
      },
      parent,
    );
  const endCall = (span: Span, status: 'completed' | 'error' | 'waiting' | 'refused') => {
    span.setAttribute('script.call.status', status);
    if (status === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  };

  /** The first recorded call with this kind, name and hash, removed from the journal still to replay. */
  const take = (kind: ScriptCallKind, name: string, hash: string): JournalEntry | undefined => {
    const at = pending.findIndex((e) => e.kind === kind && e.name === name && e.hash === hash);
    return at === -1 ? undefined : pending.splice(at, 1)[0];
  };
  const count = () => {
    if (++calls > limit) throw new ScriptFatal('SCRIPT_CALL_LIMIT', `The script made more than ${limit} calls in one run.`);
  };
  const track = <T>(running: Promise<T>): Promise<T> => {
    inflight.add(running);
    running.then(
      () => inflight.delete(running),
      () => inflight.delete(running),
    );
    return running;
  };

  /** Runs `exec` as a live call: its span, its journal event, its outcome thrown or returned into the script. */
  const live = (record_: ScriptCallRecord, exec: () => Promise<unknown>): Promise<unknown> =>
    track(
      (async () => {
        const span = callSpan(record_);
        let outcome: ScriptCallOutcome;
        try {
          outcome = { value: (await exec()) ?? null };
        } catch (err) {
          if (err instanceof SandboxHalt || host.signal.aborted) {
            endCall(span, 'error');
            throw err;
          }
          const e = err instanceof Error ? err : new Error(String(err));
          outcome = { error: { name: e.name || 'Error', message: e.message } };
        }
        endCall(span, 'error' in outcome ? 'error' : 'completed');
        await record(outcomeEvent(record_, outcome));
        return replayed(outcome);
      })(),
    );

  /** A call: replayed from the journal when recorded, else run and journaled. */
  const call = (kind: ScriptCallKind, name: string, args: unknown, exec: (site: ScriptCallSite) => Promise<unknown>): Promise<unknown> => {
    if (pausing) return never();
    count();
    const hash = callHash(kind, name, args);
    const recorded = take(kind, name, hash);
    if (recorded?.outcome) {
      replayedCalls++;
      return Promise.resolve().then(() => replayed(recorded.outcome!));
    }
    const rec: ScriptCallRecord = { run, seq: nextSeq++, kind, name, hash };
    return live(rec, () => exec({ run, seq: rec.seq }));
  };

  /** The run pauses here: the calls in flight settle and are stored, then the journal and the pause, then the sandbox halts. */
  const pause = async (rec: ScriptCallRecord, event: (interruptId: string) => TurnEvent): Promise<never> => {
    pausing = true;
    await Promise.allSettled([...inflight]);
    const interruptId = (host.newInterruptId ?? randomUUID)();
    await host.beforePause?.();
    await flush();
    const stored = event(interruptId);
    await host.append(stored);
    endCall(callSpan(rec), 'waiting');
    throw new SandboxHalt('waiting for the person');
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
    if (recorded?.outcome) {
      replayedCalls++;
      return replayed(recorded.outcome);
    }
    if (recorded?.pause && input.resume?.answer !== undefined && recorded.pause.kind !== 'approval') {
      // The question the run waits on: this turn's message is the answer.
      const value = { reply: replyOf(input.resume.answer, schema), input: args.payload };
      await record(callEvent(host.script, host.invocationId, { run, seq: recorded.seq, kind: 'askUser', name: id, hash }, { value }));
      answeredPause = true;
      return value;
    }
    if (pausing) return never();
    count();
    const rec: ScriptCallRecord = { run, seq: nextSeq++, kind: 'askUser', name: id, hash };
    return pause(rec, (interruptId) => {
      const event = pauseEvent(host.script, host.invocationId, rec, { ...pin, interrupt_id: interruptId, kind: 'question' }, {
        message: question,
        ...(o.payload !== undefined ? { payload: o.payload } : {}),
        ...(schema ? { schema } : {}),
      });
      const [request] = getFunctionCalls(event);
      paused = inputRequestFrom(host.script, request!);
      return event;
    });
  };

  const tool = async (name: unknown, args: unknown): Promise<unknown> => {
    if (typeof name !== 'string' || !name) throw new TypeError('tool(name, args): name must be a tool in script.tools');
    const a = args ?? {};
    if (!host.gated?.(name)) return call('tool', name, a, (site) => host.tool(name, a, site));
    // A gated tool (`script.require_approval`): a person approves the exact call first.
    if (pausing) return never();
    count();
    const hash = callHash('tool', name, a);
    const recorded = take('tool', name, hash);
    if (recorded?.outcome) {
      replayedCalls++;
      return replayed(recorded.outcome);
    }
    if (recorded?.pause && input.resume?.decision && recorded.pause.kind === 'approval') {
      answeredPause = true;
      const rec: ScriptCallRecord = { run, seq: recorded.seq, kind: 'tool', name, hash };
      if (input.resume.decision.approved) return live(rec, () => host.tool(name, a, { run, seq: rec.seq }));
      const refused = { error: APPROVAL_TEXTS.rejected };
      endCall(callSpan(rec), 'refused');
      await record(callEvent(host.script, host.invocationId, rec, { value: refused }));
      return refused;
    }
    const rec: ScriptCallRecord = { run, seq: nextSeq++, kind: 'tool', name, hash };
    return pause(rec, (interruptId) => {
      const event = approvalEvent(host.script, host.invocationId, rec, { ...pin, interrupt_id: interruptId, kind: 'approval' }, { tool: name, args: a, hint: APPROVAL_TEXTS.hint(name) });
      const [request] = getFunctionCalls(event);
      approval = approvalRequestOf(event, request as Record<string, any>);
      return event;
    });
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
        return call('agent', name, { input: agentInput ?? null, opts: o }, (site) => host.agent(name, agentInput ?? null, o as Record<string, unknown>, site));
      },
      tool: ([name, args]) => tool(name, args),
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
  const waiting = !!(paused || approval);
  // A resumed run, or one stored call by call, that ended (not one the turn's signal stopped) is closed, so the next message starts a new one.
  if (!waiting && !host.signal.aborted && (input.resume || (host.journalEveryCall && pinStored))) {
    await flush();
    await host.append(endEvent(host.script, host.invocationId, run, nextSeq++));
  }
  const unreplayed = () => {
    const left = pending[0];
    return left ? { code: 'SCRIPT_DIVERGED', message: `The resumed run did not make the call its journal holds: ${describe(left)}. A script must make the same calls, with the same arguments, on every run (ADR 0137 item 9).` } : undefined;
  };
  const finish = (outcome: ScriptRunOutcome): ScriptRunOutcome => {
    invokeSpan.setAttributes({ 'script.status': outcome.status, 'script.calls': calls, 'script.replayed_calls': replayedCalls });
    if (outcome.status === 'failed') {
      invokeSpan.setAttribute('script.error_code', outcome.error.code);
      invokeSpan.setStatus({ code: SpanStatusCode.ERROR });
    }
    invokeSpan.end();
    return outcome;
  };
  if (waiting) {
    const diverged = unreplayed();
    if (diverged) return finish({ status: 'failed', run, error: diverged, logs });
    return finish(approval ? { status: 'approval', run, approval, logs } : { status: 'paused', run, input: paused!, logs });
  }
  if (sandboxed.halt) {
    const code = sandboxed.halt instanceof ScriptFatal ? sandboxed.halt.code : 'SCRIPT_HALTED';
    return finish({ status: 'failed', run, error: { code, message: sandboxed.halt.message }, logs });
  }
  if (!sandboxed.ok) {
    const error = sandboxed.error!;
    return finish({ status: 'failed', run, error: { code: error.code === 'CODE_ERROR' ? 'SCRIPT_ERROR' : error.code, message: error.message }, logs });
  }
  const awaited = input.resume?.answer !== undefined || input.resume?.decision !== undefined;
  if (awaited && !answeredPause) {
    return finish({ status: 'failed', run, error: { code: 'SCRIPT_DIVERGED', message: 'The resumed run never reached the pause it was waiting on.' }, logs });
  }
  const diverged = unreplayed();
  if (diverged) return finish({ status: 'failed', run, error: diverged, logs });
  return finish({ status: 'completed', run, value: sandboxed.result, logs });
}
