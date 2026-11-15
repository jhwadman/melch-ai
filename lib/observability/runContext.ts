/**
 * lib/observability/runContext.ts — the run a piece of code is executing in
 * (ADR 0159).
 *
 * A program's run is a trace of steps (lib/observability/run.ts). Every turn
 * stays a trace of its own, so nothing ties a turn to the run that started it
 * unless the tracer writes the run's key on the turn's root span, and
 * OpenTelemetry has no attribute inheritance. This is the context the tracer
 * reads when a span starts: an AsyncLocalStorage, as lib/runtime/
 * turnControl.ts uses, so it follows every call made inside `traceRun` or
 * `traceStep` without a parameter on any of them.
 *
 * It lives apart from run.ts so the tracer can read it without importing the
 * functions that open steps, which import the tracer.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The attributes the run key is written as. Public names (ADR 0159). */
export const RUN_ID_ATTRIBUTE = 'run.id';
export const RUN_NAME_ATTRIBUTE = 'run.name';
export const RUN_STEP_ATTRIBUTE = 'run.step_span_id';

export interface RunContext {
  /** The run's id: the caller's own (a date, a job id) or a UUID. */
  id: string;
  /** The run's name: its root step's. */
  name: string;
  /** The run's trace: the one its steps are in. Never a turn's. */
  traceId: string;
  /** The span id of the step now executing, in the run's trace. */
  stepSpanId: string;
}

const storage = new AsyncLocalStorage<RunContext>();

/** The run the calling code is executing in, with the step that is active; undefined outside a run. */
export function currentRun(): RunContext | undefined {
  return storage.getStore();
}

/** Runs `fn` with `run` as the active run and step. */
export function runWithRunContext<T>(run: RunContext, fn: () => T): T {
  return storage.run(run, fn);
}
