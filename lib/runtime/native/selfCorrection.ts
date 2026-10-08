/**
 * lib/runtime/native/selfCorrection.ts — self-correction on the native loop:
 * a model error and a tool error retried with reflection, as ADK's
 * reflect-and-retry plugins do it on the ADK runtime (ADR 0034, ADR 0075).
 *
 * WHY this file exists:
 *   runSyndicateTurn installs ADK's ReflectAndRetryModelPlugin and
 *   ReflectAndRetryToolPlugin on every Runner it builds, retries at their
 *   defaults unless the syndicate's `retries:` says otherwise. They change
 *   what the model is sent and what the store holds, so the native loop
 *   does what they do, word for word, or a session one runtime wrote would
 *   read differently on the other:
 *
 *   THE MODEL (`retries.model_errors`, default 2; 0 off):
 *   - The reflection tool, `adk_handle_model_error`, is one of every step's
 *     tools, after the agent's own: the plugin's beforeModelCallback adds it
 *     to the request's toolsDict last, and never to its config. Whether the
 *     model is told of it depends on the model class ADK hands the request
 *     to (ADR 0097): the ADK shim and the engine's own ADK classes declare
 *     the toolsDict, so the tool is declared; ADK's own Gemini sends the
 *     config alone, so a Gemini model is never told of it. The step asks
 *     `declaresReflectionTool` and runs the tool either way.
 *   - Each response is checked (afterModelCallback), partials included. A
 *     response that calls the reflection tool itself, or whose finish reason
 *     is MALFORMED_FUNCTION_CALL, is replaced by a call to the reflection
 *     tool: id `adk_handle_model_error_<uuid>`, the error in its arguments,
 *     the retry's number counted per agent in the run. The loop runs that
 *     call like any other, and the tool answers with reflection guidance.
 *     Any other response resets the agent's count.
 *   - Past the limit the step ends on ADK's error event for a callback that
 *     threw: UNKNOWN_ERROR, and the plugin manager's message.
 *
 *   THE TOOLS (`retries.tool_errors`, default 3; 0 off):
 *   - A tool that throws an Error, and a call naming no tool, answer with
 *     reflection guidance (onToolErrorCallback) in place of the plain error,
 *     counted per tool name in the run; past the limit, the "retry limit
 *     exceeded" guidance (the plugin is built not to throw).
 *   - A call that answered resets its tool's count (afterToolCallback),
 *     unless the answer is itself reflection guidance.
 *   - ADK runs a step's calls one after another; the native loop runs them
 *     in parallel. The counts are kept in call order all the same: each
 *     call's count waits for the calls before it (StepCorrection).
 *
 * The texts, the argument names and the counting quirks are ADK 2.2.0's
 * (plugins/reflect_retry_*.js), the reflection tool's "attempt 1" included:
 * it reads `retryCount` where the call carries `retry_count`.
 * tests/selfCorrection.test.ts and tests/nativeLoop.test.ts hold the two
 * runtimes to the same stored events.
 *
 * ADK stays out of this file but for the LlmResponse type the step already
 * reads responses as.
 */

import { randomUUID } from 'node:crypto';

import type { LlmResponse } from '@google/adk';

import { GEMINI_PROVIDER } from '../../models/geminiState.ts';
import type { Tool } from '../../tools/tool.ts';

// ── The settings ─────────────────────────────────────────────────────────────

/** The syndicate's `retries:` key (lib/syndicateSchema.ts). */
export interface Retries {
  model_errors?: number;
  tool_errors?: number;
}

export const DEFAULT_MODEL_ERROR_RETRIES = 2;
export const DEFAULT_TOOL_ERROR_RETRIES = 3;

export const ADK_HANDLE_MODEL_ERROR = 'adk_handle_model_error';
export const REFLECT_AND_RETRY_RESPONSE_TYPE = 'ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN';

const RESERVED_TOOL_CALL = 'RESERVED_TOOL_CALL';
/** The finish reasons the model plugin retries (its onModelErrors default). */
const MODEL_ERRORS: readonly string[] = ['MALFORMED_FUNCTION_CALL'];
const MODEL_PLUGIN = 'reflect_retry_model_plugin';

// ── Where ADK declares the reflection tool ──────────────────────────────────

/** Gemini adapters a caller handed over as a contract adapter or behind the ADK shim: on ADK the shim declares the toolsDict. */
const SHIMMED_GEMINI = new WeakSet<object>();

/**
 * Marks `adapter` as one the ADK runtime would call through the ADK shim
 * (a resolver's shim or contract adapter, lib/compileNative.ts), not through
 * ADK's own Gemini. Returns it.
 */
export function servedThroughShim<T extends object>(adapter: T): T {
  SHIMMED_GEMINI.add(adapter);
  return adapter;
}

/**
 * Whether the ADK runtime would tell this adapter's model of the reflection
 * tool (ADR 0097). The plugin puts the tool in the toolsDict alone. Every
 * model class the engine hands ADK declares the toolsDict, but ADK's own
 * Gemini (and TracedGemini over it) sends only the request's config, which
 * never holds it. A Gemini adapter stands for ADK's Gemini unless a caller
 * handed it over behind the shim (servedThroughShim).
 */
export function declaresReflectionTool(adapter: { readonly provider: string }): boolean {
  return adapter.provider !== GEMINI_PROVIDER || SHIMMED_GEMINI.has(adapter);
}

// ── Counting, per run ────────────────────────────────────────────────────────

/** ADK's ScopedFailureTracker: failures per name, within one run (invocation scope). */
class FailureTracker {
  readonly #counts = new Map<string, Map<string, number>>();

  increment(scope: string, name: string): number {
    let counter = this.#counts.get(scope);
    if (!counter) {
      counter = new Map();
      this.#counts.set(scope, counter);
    }
    const next = (counter.get(name) ?? 0) + 1;
    counter.set(name, next);
    return next;
  }

  reset(scope: string, name: string): void {
    const counter = this.#counts.get(scope);
    if (!counter) return;
    counter.delete(name);
    if (counter.size === 0) this.#counts.delete(scope);
  }
}

// ── What the step and the loop call ──────────────────────────────────────────

/** What afterModel leaves of a response: the response to record, or the error event that ends the step. */
export type CorrectedResponse =
  | { response: LlmResponse; replaced: boolean }
  | { failed: { code: string; message: string } };

/** The model side, for one agent's steps in one run (lib/runtime/native/step.ts). */
export interface ModelCorrection {
  /** After the agent's own tools: the reflection tool. Declared to the model only where ADK declares it (declaresReflectionTool). */
  readonly tools: readonly Tool[];
  /** ADK's afterModelCallback, on every response the step reads. */
  afterModel(response: LlmResponse): CorrectedResponse;
}

/** The tool side, for one call (lib/runtime/native/agentLoop.ts). Each call makes exactly one of these. */
export interface CallCorrection {
  /**
   * The call threw, or named no tool: the guidance that answers it in place
   * of the error, or undefined to answer the error as it is (a throw that is
   * not an Error, which ADK hands to no plugin).
   */
  failed(toolName: string, args: Record<string, unknown>, error: unknown): Promise<Record<string, unknown> | undefined>;
  /** The call answered: its tool's count starts again. */
  answered(toolName: string, result: unknown): Promise<void>;
}

/** The tool side for one step's calls, counted in call order. `release(i)` when call i is done, whatever it did. */
export interface StepCorrection {
  call(index: number): CallCorrection;
  release(index: number): void;
}

/**
 * Self-correction for a run: ADK's two plugins, with their counters. One per
 * turn, as runSyndicateTurn builds one pair of plugins per Runner; the
 * counters are kept per run (invocation id) within it.
 */
export class SelfCorrection {
  readonly modelErrors: number;
  readonly toolErrors: number;
  readonly #models = new FailureTracker();
  readonly #tools = new FailureTracker();

  constructor(retries: Retries = {}) {
    this.modelErrors = retries.model_errors ?? DEFAULT_MODEL_ERROR_RETRIES;
    this.toolErrors = retries.tool_errors ?? DEFAULT_TOOL_ERROR_RETRIES;
    if (this.modelErrors < 0 || this.toolErrors < 0) throw new Error('maxRetries must be a non-negative integer.');
  }

  /** The model side for `agentName`'s steps in run `invocationId`; undefined when model retries are off. */
  forModel(agentName: string, invocationId: string): ModelCorrection | undefined {
    if (this.modelErrors <= 0) return undefined;
    const max = this.modelErrors;
    const tracker = this.#models;
    const name = agentName || 'default_model';
    const retry = (errorType: string, errorDetails: string, finishReason: string): CorrectedResponse => {
      const count = tracker.increment(invocationId, name);
      if (count > max) {
        const thrown = `The model has failed consecutively ${max} times and the retry limit has been exceeded.`;
        return { failed: { code: 'UNKNOWN_ERROR', message: `Error in plugin '${MODEL_PLUGIN}' during 'afterModelCallback' callback: Error: ${thrown}` } };
      }
      const args = { response_type: REFLECT_AND_RETRY_RESPONSE_TYPE, error_type: errorType, error_details: errorDetails, finish_reason: finishReason, retry_count: count };
      const response: LlmResponse = {
        content: { role: 'model', parts: [{ functionCall: { id: `${ADK_HANDLE_MODEL_ERROR}_${randomUUID()}`, name: ADK_HANDLE_MODEL_ERROR, args } }] },
      };
      return { response, replaced: true };
    };
    return {
      tools: [reflectionTool(max)],
      afterModel(response) {
        if (response.content?.parts?.some((p) => p.functionCall?.name === ADK_HANDLE_MODEL_ERROR)) {
          return retry(
            RESERVED_TOOL_CALL,
            `Model attempted to call reserved tool ${ADK_HANDLE_MODEL_ERROR} directly. This tool is reserved for framework use only. Do not call it.`,
            'OTHER',
          );
        }
        if (response.finishReason && MODEL_ERRORS.includes(response.finishReason)) {
          return retry(response.errorCode ?? 'MODEL_ERROR', response.errorMessage ?? 'Model error encountered.', response.finishReason);
        }
        tracker.reset(invocationId, name);
        return { response, replaced: false };
      },
    };
  }

  /** The tool side for one step of `count` calls in run `invocationId`; undefined when tool retries are off. */
  forCalls(invocationId: string, count: number): StepCorrection | undefined {
    if (this.toolErrors <= 0 || count === 0) return undefined;
    const max = this.toolErrors;
    const tracker = this.#tools;
    // Call i's count waits for calls 0..i-1: ADK counts in call order.
    const done: Array<() => void> = [];
    const settled = Array.from({ length: count }, (_, i) => new Promise<void>((resolve) => (done[i] = resolve)));
    const inTurn = async <T>(index: number, op: () => T): Promise<T> => {
      if (index > 0) await settled[index - 1];
      try {
        return op();
      } finally {
        done[index]?.();
      }
    };
    return {
      release: (index) => done[index]?.(),
      call: (index) => ({
        failed: (toolName, args, error) =>
          inTurn(index, () => {
            if (!(error instanceof Error)) {
              tracker.reset(invocationId, toolName);
              return undefined;
            }
            const retries = tracker.increment(invocationId, toolName);
            return retries <= max ? toolReflection(toolName, args, error, retries, max) : toolRetryExceeded(toolName, args, error, max);
          }),
        answered: (toolName, result) =>
          inTurn(index, () => {
            const reflected = !!result && typeof result === 'object' && (result as Record<string, unknown>).response_type === REFLECT_AND_RETRY_RESPONSE_TYPE;
            if (!reflected) tracker.reset(invocationId, toolName);
          }),
      }),
    };
  }
}

// ── The reflection tool and the texts ────────────────────────────────────────

/** The reflection tool as the model plugin declares it: a FunctionTool with no parameters. */
function reflectionTool(maxRetries: number): Tool {
  return {
    name: ADK_HANDLE_MODEL_ERROR,
    declaration: () => ({
      name: ADK_HANDLE_MODEL_ERROR,
      description: 'A tool that triggers reflection. Reserved for internal framework use only. Do not call directly.',
      parameters: { type: 'object', properties: {} },
    }),
    // ADK's adkHandleModelError reads `retryCount`; the call carries `retry_count`, so it says attempt 1.
    execute: async (args) => {
      const attempt = (args as { retryCount?: unknown }).retryCount ?? 1;
      return {
        reflection_guidance: `
The call to the model failed.

**Reflection Guidance:**
- This is retry attempt **${String(attempt)}** of **${maxRetries}**
- Analyze the error and the arguments you provided. Do not repeat the exact same call.

Formulate a new plan based on your analysis and try a corrected or different approach.
`.trim(),
      };
    },
  };
}

const errorDetailsOf = (error: Error): string => `${error.name || 'Error'}: ${error.message}`;

function toolReflection(toolName: string, args: Record<string, unknown>, error: Error, retryCount: number, maxRetries: number): Record<string, unknown> {
  const reflectionMessage = `
The call to tool \`${toolName}\` failed.

**Error Details:**
\`\`\`
${errorDetailsOf(error)}
\`\`\`

**Tool Arguments Used:**
\`\`\`json
${JSON.stringify(args ?? {}, null, 2)}
\`\`\`

**Reflection Guidance:**
This is retry attempt **${retryCount} of ${maxRetries}**. Analyze the error and the arguments you provided. Do not repeat the exact same call. Consider the following before your next attempt:

1.  **Invalid Parameters**: Does the error suggest that one or more arguments are incorrect, badly formatted, or missing? Review the tool's schema and your arguments.
2.  **State or Preconditions**: Did a previous step fail or not produce the necessary state/resource for this tool to succeed?
3.  **Alternative Approach**: Is this the right tool for the job? Could another tool or a different sequence of steps achieve the goal?
4.  **Simplify the Task**: Can you break the problem down into smaller, simpler steps?
5.  **Wrong Function Name**: Does the error indicates the tool is not found? Please check again and only use available tools.

Formulate a new plan based on your analysis and try a corrected or different approach.
`.trim();
  return {
    response_type: REFLECT_AND_RETRY_RESPONSE_TYPE,
    error_type: error.name || 'Error',
    error_details: error.message,
    retry_count: retryCount,
    reflection_guidance: reflectionMessage,
  };
}

function toolRetryExceeded(toolName: string, args: Record<string, unknown>, error: Error, maxRetries: number): Record<string, unknown> {
  const reflectionMessage = `
The tool \`${toolName}\` has failed consecutively ${maxRetries} times and the retry limit has been exceeded.

**Last Error:**
\`\`\`
${errorDetailsOf(error)}
\`\`\`

**Last Arguments Used:**
\`\`\`json
${JSON.stringify(args ?? {}, null, 2)}
\`\`\`

**Final Instruction:**
**Do not attempt to use the \`${toolName}\` tool again for this task.** You must now try a different approach. Acknowledge the failure and devise a new strategy, potentially using other available tools or informing the user that the task cannot be completed.
`.trim();
  return {
    response_type: REFLECT_AND_RETRY_RESPONSE_TYPE,
    error_type: error.name || 'Error',
    error_details: error.message,
    retry_count: maxRetries,
    reflection_guidance: reflectionMessage,
  };
}
