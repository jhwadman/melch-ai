/**
 * lib/runtime/turnControl.ts — the controls one syndicate turn runs under:
 * a cancellation signal and a budget of model calls, shared by every agent
 * the turn reaches.
 *
 * WHY an AsyncLocalStorage and not a Runner parameter:
 *   ADK's own ceiling (`runConfig.maxLlmCalls`, default 500) was counted per
 *   Runner, and every AgentTool built a NEW Runner for its subagent without
 *   forwarding the run config — so in DELEGATE mode each subagent call
 *   started with a fresh 500, and the real bound on a turn was
 *   multiplicative. Before this module the YAML's `max_steps` was passed as
 *   `maxSteps`, a parameter ADK did not have, so it bounded nothing at all.
 *
 *   Every model call in this framework, on every provider, goes through
 *   `traceLlmGeneration` (lib/observability/tracer.ts). That wrapper charges
 *   the budget here, so one counter sees the orchestrator, every subagent,
 *   and every nested syndicate in the turn. The context is carried by
 *   AsyncLocalStorage, which follows every call the loop makes — including
 *   each subagent's child loop — without any of them knowing about it.
 *
 *   The same context carries the turn's AbortSignal, so adapters can hand it
 *   to their provider SDK and a cancel or a deadline stops the HTTP call in
 *   flight, not just the loop around it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Why a turn was stopped before it finished on its own. */
export type TurnStopReason = 'canceled' | 'deadline' | 'step_limit';

export interface TurnControl {
  /** Aborted when the turn must stop: cancel, deadline, or step limit. */
  readonly signal: AbortSignal;
  /** Model calls made so far in this turn, across every agent. */
  llmCalls: number;
  /** Tokens reported by the providers so far in this turn, across every agent. */
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Ceiling on model calls for the whole turn; undefined = no ceiling. */
  readonly maxLlmCalls?: number;
  /**
   * The turn opted out of tracing (`runSyndicateTurn({ trace: false })`):
   * nothing it runs opens a span or starts the tracer, so it reaches no
   * sink. The budget and the token charge still apply.
   */
  readonly untraced?: boolean;
  /** Set once, by whichever control stopped the turn first. */
  stopReason?: TurnStopReason;
  /** Stop the turn. The first reason wins. */
  stop(reason: TurnStopReason): void;
  /**
   * Runs a nested dispatch syndicate as its own turn on its own
   * conversation, under this turn's controls (ADR 0120): set by the turn
   * runner (lib/runtime/syndicateTurn.ts), read where a nested dispatch
   * syndicate runs (a delegated call, a dispatch route, a workflow node),
   * which sit below the turn runner and cannot import it.
   */
  nestedDispatch?: (run: NestedDispatchRun) => Promise<NestedDispatchEnd>;
}

/** One run of a nested dispatch syndicate (ADR 0120): what it is, where its conversation is filed, and the message. */
export interface NestedDispatchRun {
  /** The nested syndicate's config (a SyndicateYamlConfig with a `dispatch:` block). */
  config: unknown;
  /** The compile options it loads its routes with (CompileOptions, its nesting chain included). */
  compile: unknown;
  /** The entry's name: the nested syndicate as its caller lists it. */
  name: string;
  /** The store, and the key its conversation is filed under (already opened by the caller). */
  sessions: unknown;
  appName: string;
  userId: string;
  sessionId: string;
  /** The message's parts: the request, or the answer to what waits in it. */
  parts: unknown[];
}

/** How a nested dispatch syndicate's turn ended (ADR 0120). */
export interface NestedDispatchEnd {
  status: 'completed' | 'input-required' | 'failed' | 'canceled';
  /** The route's final text: the nested syndicate's answer. */
  text: string;
  /** Its conversation's state writes this run, `temp:` keys aside. */
  stateDelta: Record<string, unknown>;
  /** What it waits on, when paused: the request's id, and the request as the turn reports it (a PendingApproval, a PendingInput, a PendingConsent). */
  interruptId?: string;
  approval?: unknown;
  input?: unknown;
  consent?: unknown;
  error?: { code: string; message: string };
}

const storage = new AsyncLocalStorage<TurnControl>();

export interface TurnControlOptions {
  maxLlmCalls?: number;
  /** Wall-clock budget for the whole turn, in milliseconds. */
  deadlineMs?: number;
  /** An outer signal (a cancel request); aborting it cancels the turn. */
  signal?: AbortSignal;
  /** The turn records no spans (TurnControl.untraced). */
  untraced?: boolean;
}

/**
 * A control for one turn. Call `dispose()` when the turn ends so the
 * deadline timer and the outer-signal listener are released.
 */
export function createTurnControl(opts: TurnControlOptions = {}): TurnControl & { dispose(): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const control: TurnControl & { dispose(): void } = {
    signal: controller.signal,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    maxLlmCalls: opts.maxLlmCalls && opts.maxLlmCalls > 0 ? opts.maxLlmCalls : undefined,
    ...(opts.untraced ? { untraced: true } : {}),
    stopReason: undefined,
    stop(reason) {
      if (control.stopReason) return;
      control.stopReason = reason;
      controller.abort(new Error(stopMessage(reason, control)));
    },
    dispose() {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    },
  };
  const onOuterAbort = () => control.stop('canceled');
  if (opts.signal) {
    if (opts.signal.aborted) control.stop('canceled');
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  if (opts.deadlineMs && opts.deadlineMs > 0) {
    timer = setTimeout(() => control.stop('deadline'), opts.deadlineMs);
  }
  return control;
}

/** Human-readable reason, used for the failed task's message. */
export function stopMessage(reason: TurnStopReason, control?: Pick<TurnControl, 'maxLlmCalls'>): string {
  switch (reason) {
    case 'canceled':
      return 'The task was canceled.';
    case 'deadline':
      return 'The turn exceeded its time limit and was stopped.';
    case 'step_limit':
      return `The turn reached its limit of ${control?.maxLlmCalls ?? '?'} model calls (max_steps) and was stopped.`;
  }
}

/** Run `fn` with `control` as the current turn's control. */
export function runWithTurnControl<T>(control: TurnControl, fn: () => T): T {
  return storage.run(control, fn);
}

/** The current turn's control, if this code is running inside a turn. */
export function currentTurnControl(): TurnControl | undefined {
  return storage.getStore();
}

/**
 * Whether the code running now belongs to a turn that opted out of tracing.
 * Every span the engine opens checks this first (lib/observability/
 * tracer.ts, lib/runtime/native/telemetry.ts): an untraced turn opens no
 * span and does not start the tracer. Outside a turn: false.
 */
export function turnUntraced(): boolean {
  return storage.getStore()?.untraced === true;
}

/** The current turn's abort signal, for adapters to pass to provider SDKs. */
export function currentTurnSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/**
 * Charge one model call against the current turn. Returns a refusal (and
 * stops the turn) when the call would exceed the budget, or when the turn
 * has already been stopped. Outside a turn this always allows the call.
 */
export function chargeLlmCall(): { ok: true } | { ok: false; code: string; message: string } {
  const control = storage.getStore();
  if (!control) return { ok: true };
  if (control.stopReason) {
    return { ok: false, code: stopCode(control.stopReason), message: stopMessage(control.stopReason, control) };
  }
  if (control.maxLlmCalls !== undefined && control.llmCalls >= control.maxLlmCalls) {
    control.stop('step_limit');
    return { ok: false, code: 'STEP_LIMIT', message: stopMessage('step_limit', control) };
  }
  control.llmCalls += 1;
  return { ok: true };
}

/**
 * Add one model call's reported tokens to the current turn (the tracer calls
 * this as each call finishes). Outside a turn it does nothing.
 */
export function chargeTokens(input: number, output: number, thinking: number): void {
  const control = storage.getStore();
  if (!control) return;
  control.inputTokens += Math.max(0, input || 0);
  control.outputTokens += Math.max(0, output || 0);
  control.thinkingTokens += Math.max(0, thinking || 0);
}

export function stopCode(reason: TurnStopReason): string {
  return reason === 'step_limit' ? 'STEP_LIMIT' : reason === 'deadline' ? 'DEADLINE_EXCEEDED' : 'CANCELED';
}

/**
 * Per-request options for a provider SDK call (Anthropic, OpenAI): carries
 * the turn's abort signal so a cancel or deadline aborts the HTTP request
 * in flight. Empty outside a turn.
 */
export function providerRequestOptions(): { signal?: AbortSignal } {
  const signal = currentTurnSignal();
  return signal ? { signal } : {};
}
