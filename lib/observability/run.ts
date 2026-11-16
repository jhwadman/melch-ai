/**
 * lib/observability/run.ts — a program's run in the ledger (ADR 0159).
 *
 * A program that runs several turns (a pipeline, a batch job, a nightly
 * build of something) had nothing in the ledger that said those turns
 * belong together, and no row for its own stages. This module gives it both:
 *
 *   traceRun({ name, id?, meta? }, fn)   the run: a root step in a trace of
 *                                        its own, and a run context
 *   traceStep(name, fn, { meta? })       a step of it, nested under the step
 *                                        that is active
 *   traceModelCall({ provider, model }, fn)   a model call made outside an
 *                                        agent, as an `llm.request` span
 *
 * A step is a span named `step.execute <name>`; the ledger keeps a row for
 * it (kind `step`, lib/observability/lineage.ts). A turn started inside a
 * step is NOT a child of it: every turn is the root of its own trace, since
 * a turn's trace id keys its stats, its price, its payload policy and its
 * erasure. The tracer ties the two by key instead (lib/observability/
 * tracer.ts, the lineage processor): the turn's root span carries `run.id`,
 * `run.name` and `run.step_span_id`, and every step and every model call made
 * directly under one carries `run.id`.
 *
 * A step records its name, its timing, whether it failed and its `meta.*`
 * labels. It records no argument, no result and no error message: a step's
 * row has no session to be erased with, so it holds nothing a person said.
 */

import { randomUUID } from 'node:crypto';

import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, context, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

import { RUNTIME_SPAN_SCOPE, STEP_SPAN_PREFIX } from './lineage.ts';
import { MAX_META_KEYS, MAX_META_VALUE_CHARS, isSecretShaped, metaAttributes, metadataEntryProblem } from './metadata.ts';
import type { Metadata } from './metadata.ts';
import { RUN_ID_ATTRIBUTE, RUN_NAME_ATTRIBUTE, currentRun, runWithRunContext } from './runContext.ts';
import type { RunContext } from './runContext.ts';
import { startEngineSpan, takeTraceStats, traceLlmGeneration } from './tracer.ts';
import { usageToMetadata } from '../models/genaiMapping.ts';
import type { LlmResponse } from '../models/genaiMapping.ts';
import type { FinalModelResponse, Usage } from '../models/contract.ts';

export { currentRun } from './runContext.ts';
export type { RunContext } from './runContext.ts';

/** The longest step name, in characters. */
export const MAX_STEP_NAME_CHARS = 128;

export interface TraceRunOptions {
  /** The run's name, and its root step's: `step.execute <name>`. */
  name: string;
  /**
   * The run's id, when the program has one of its own (a date, a job id): a
   * non-empty string of at most 256 characters. Default: a UUID. The ledger
   * stores it as written, never redacted, so it must not be a secret; one
   * shaped like a key or token is refused.
   */
  id?: string;
  /** Labels on the root step, as `meta.<key>` (the limits of lib/observability/metadata.ts). */
  meta?: Metadata;
}

export interface TraceStepOptions {
  /** Labels on the step, as `meta.<key>` (the limits of lib/observability/metadata.ts). */
  meta?: Metadata;
}

/** A step's name, trimmed, or a TypeError saying what a name is. */
function stepName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > MAX_STEP_NAME_CHARS || /[\r\n]/.test(trimmed)) {
    throw new TypeError(`A run or step name is a non-empty string of at most ${MAX_STEP_NAME_CHARS} characters on one line.`);
  }
  // The name is the span's name, which the ledger stores as written (span_name is never redacted).
  if (isSecretShaped(trimmed)) throw new TypeError('A run or step name looks like a key or token: it is stored as written, so it must not be a credential.');
  return trimmed;
}

/** A run's id, trimmed, or a TypeError saying what an id is. Never quotes the value. */
function runId(id: unknown): string {
  if (id === undefined) return randomUUID();
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!trimmed || trimmed.length > MAX_META_VALUE_CHARS) {
    throw new TypeError(`A run id is a non-empty string of at most ${MAX_META_VALUE_CHARS} characters.`);
  }
  if (isSecretShaped(trimmed)) throw new TypeError('A run id looks like a key or token: it is stored as written, so it must not be a credential.');
  return trimmed;
}

/**
 * A step's metadata as span attributes: the entries that pass the metadata
 * rules, at most 32, strings through the telemetry redactor in force. An
 * entry that is not metadata, a credential-shaped value, a key reserved for
 * agent spans and anything past the limit are dropped with one warning that
 * names keys, never values.
 */
export function stepMetaAttributes(meta: Metadata | undefined, step: string): Record<string, string | number | boolean> {
  if (!meta) return {};
  const kept: Metadata = {};
  const dropped: string[] = [];
  let count = 0;
  for (const [key, value] of Object.entries(meta)) {
    const invalid = metadataEntryProblem(key, value) !== undefined || key.startsWith('agent.');
    if (invalid || (typeof value === 'string' && isSecretShaped(value)) || count >= MAX_META_KEYS) {
      dropped.push(key.length > 64 ? `${key.slice(0, 64)}…` : key);
      continue;
    }
    kept[key] = value;
    count++;
  }
  if (dropped.length) {
    console.warn(
      `⚠ step "${step}": ${dropped.length} metadata entr${dropped.length === 1 ? 'y' : 'ies'} dropped (${dropped.slice(0, 8).join(', ')}${dropped.length > 8 ? ', …' : ''}). ` +
        `A key is letters, digits and _ . : - (at most 64, not starting "agent."), a value a string of at most ${MAX_META_VALUE_CHARS} characters, a finite number or a boolean, never a credential; a step carries at most ${MAX_META_KEYS}.`,
    );
  }
  return metaAttributes(kept);
}

/** Opens a step's span, runs `fn` with it as the active step, ends it; a root step collects its trace's model calls. */
async function runStep<T>(name: string, run: { id: string; name: string } | undefined, meta: Metadata | undefined, fn: () => T | Promise<T>): Promise<T> {
  const parent = run ? undefined : currentRun();
  const owner = run ?? parent!;
  const span: Span = startEngineSpan(
    RUNTIME_SPAN_SCOPE,
    `${STEP_SPAN_PREFIX}${name}`,
    {
      ...(run ? { root: true } : {}),
      attributes: {
        'gen_ai.operation.name': 'execute_step',
        'step.name': name,
        [RUN_ID_ATTRIBUTE]: owner.id,
        ...(run ? { [RUN_NAME_ATTRIBUTE]: owner.name } : {}),
        ...stepMetaAttributes(meta, name),
      },
    },
    // A child step's parent is the step that is active, whatever span the calling code has
    // active (a tool call of a turn, say): a run's steps are all in the run's own trace.
    run ? ROOT_CONTEXT : trace.setSpanContext(ROOT_CONTEXT, { traceId: parent!.traceId, spanId: parent!.stepSpanId, traceFlags: TraceFlags.SAMPLED }),
  );
  // A turn that opted out of tracing: no span, no run context of its own, the code runs as it is.
  if (!span.isRecording()) {
    span.end();
    return await fn();
  }
  const ids = span.spanContext();
  const step: RunContext = { id: owner.id, name: owner.name, traceId: ids.traceId, stepSpanId: ids.spanId };
  const ctx = trace.setSpan(context.active(), span);
  try {
    return await runWithRunContext(step, () => context.with(ctx, fn));
  } catch (err) {
    // The failure and its kind, never its message: a step's row holds nothing a person said.
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', err instanceof Error ? err.name : typeof err);
    throw err;
  } finally {
    if (run) {
      // The model calls made directly under the run's steps (traceModelCall): no turn collects them.
      const stats = takeTraceStats(ids.traceId);
      span.setAttribute('run.llm_calls', stats?.llmCalls ?? 0);
      span.setAttribute('run.models', stats ? [...stats.models].sort().join(',') : '');
    }
    span.end();
  }
}

/**
 * Runs `fn` as a run: a root step named `name`, in a trace of its own, with
 * the run as the context of everything `fn` starts. Each turn started inside
 * it (a `runSyndicateTurn`, at any depth of `traceStep`) keeps its own trace
 * and records the run and the step that started it; each `traceStep` adds a
 * step; each `traceModelCall` adds a model call under its step. Resolves or
 * rejects as `fn` does; a run whose `fn` throws is marked failed. A run
 * started inside another run is a separate run.
 */
export async function traceRun<T>(options: TraceRunOptions, fn: () => T | Promise<T>): Promise<T> {
  const name = stepName(options?.name);
  return runStep(name, { id: runId(options.id), name }, options.meta, fn);
}

/**
 * Runs `fn` as a step named `name` under the step that is active. Outside a
 * run it is a run of its own (a UUID for its id, `name` for its name), so a
 * step always has a run to be found in. Resolves or rejects as `fn` does; a
 * step whose `fn` throws is marked failed.
 */
export async function traceStep<T>(name: string, fn: () => T | Promise<T>, options: TraceStepOptions = {}): Promise<T> {
  const step = stepName(name);
  return runStep(step, currentRun() ? undefined : { id: randomUUID(), name: step }, options.meta, fn);
}

/** What a traced model call hands back: the caller's own result, and what the provider counted. */
export interface ModelCallOutcome<T> {
  result: T;
  /**
   * The provider's token counts, in the engine's terms (lib/models/
   * contract.ts): `inputTokens` every input token, cached ones too;
   * `outputTokens` every generated token, thinking too. Absent when the
   * provider reported none: the row then holds zeros and prices at zero.
   */
  usage?: Usage;
}

/**
 * Traces one model call made outside an agent as an `llm.request` span, the
 * span every agent's model call gets: provider, model, tokens and latency in
 * `adk_telemetry`, priced by the ledger when `model` is an id `model_pricing`
 * holds. `fn` makes the call and returns its result with the usage the
 * provider reported; the result is returned. A call that throws is recorded
 * as failed and rethrown.
 *
 * Inside a step it is that step's child and carries the run's id, and the
 * run's root step counts it (`run.llm_calls`, `run.models`). Inside a turn it
 * counts against the turn's step budget and stops with the turn, as an
 * agent's call does: a refused call throws without calling `fn`. No request
 * and no response is recorded.
 */
export async function traceModelCall<T>(meta: { provider: string; model: string }, fn: () => Promise<ModelCallOutcome<T>>): Promise<T> {
  const made: { outcome?: ModelCallOutcome<T>; final?: FinalModelResponse } = {};
  async function* call(): AsyncGenerator<LlmResponse, void> {
    const outcome = await fn();
    const usage = outcome?.usage;
    made.outcome = outcome;
    made.final = { partial: false, parts: [], finishReason: 'stop', ...(usage ? { usage } : {}) };
    yield { ...(usage ? { usageMetadata: usageToMetadata(usage) } : {}), turnComplete: true } as LlmResponse;
  }
  let refused: { code: string; message: string } | undefined;
  for await (const response of traceLlmGeneration({ provider: meta.provider, model: meta.model, source: () => made.final }, call())) {
    if (response.errorCode) refused = { code: String(response.errorCode), message: String(response.errorMessage ?? '') };
  }
  if (!made.outcome) {
    const err = new Error(refused?.message || 'The model call was not made.');
    if (refused) (err as Error & { code?: string }).code = refused.code;
    throw err;
  }
  return made.outcome.result;
}
