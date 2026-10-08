/**
 * lib/models/fallback.ts — a fallback model and a per-provider circuit
 * breaker for an agent that declares `fallback_model:` (ADR 0044).
 *
 * WHY: lib/models/retry.ts makes one call survive a blip. It does nothing for
 * an outage: every turn on a provider that is down spends its retries and
 * fails. An agent that names a fallback model now answers from it instead,
 * and a provider that keeps failing is skipped for a cooldown rather than
 * tried on every turn.
 *
 * TWO WAYS A PRIMARY FAILS: Gemini throws; the other adapters yield an
 * error response (`errorCode`) whose customMetadata['error.retryable'] carries
 * retry.ts's verdict (lib/models/errorResponse.ts). Both are read here by
 * the same rules.
 *
 * THE RULES:
 *   - Only provider-side failures count: what retry.ts classifies retryable
 *     (408/409/425/429/5xx, connection resets) once the adapter's own retries
 *     are spent. A 4xx is the request's fault and is thrown, or its error
 *     response passed on, as it is; a canceled turn is never counted or
 *     redirected.
 *   - The fallback runs only if the primary produced nothing yet: a stream
 *     that failed midway is thrown, or its error passed on, never replayed
 *     on another model. A redirected error response is never yielded.
 *   - Only a call that yielded content and no error counts as a success.
 *   - The breaker is per provider, shared by every agent in the process:
 *     MODEL_BREAKER_THRESHOLD consecutive failures (default 5; 0 disables)
 *     open it for MODEL_BREAKER_COOLDOWN_MS (default 30 s). While open, a
 *     wrapped agent goes straight to its fallback; after the cooldown calls
 *     go through again, the next failure reopens it at once, and a success
 *     closes it. Its state is lib/models/circuitBreaker.ts, which the
 *     contract-level wrapper (lib/models/fallbackAdapter.ts) shares.
 */
import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';

import { errorDecision, errorText, isRetryableErrorResponse } from './errorResponse.ts';
import { providerForModel } from './providerMap.ts';
import { circuitOpen, recordFailure, recordSuccess } from './circuitBreaker.ts';
import { currentTurnSignal } from '../runtime/turnControl.ts';

// The breaker's state lives in lib/models/circuitBreaker.ts, shared with the
// contract-level FallbackAdapter. Re-exported so existing imports keep working.
export { circuitOpen, resetCircuits } from './circuitBreaker.ts';

/** A provider-side failure: worth counting against the provider and worth a fallback. A cancellation never is. */
export function isProviderFailure(err: unknown): boolean {
  return errorDecision(err).retryable;
}

/** A response that carries something the model produced. */
function hasContent(response: LlmResponse): boolean {
  return (response.content?.parts?.length ?? 0) > 0;
}

/** The turn was canceled: by the signal ADK passes, or the turn's own. */
function canceled(abortSignal: AbortSignal | undefined): boolean {
  return !!abortSignal?.aborted || !!currentTurnSignal()?.aborted;
}

export class FallbackLlm extends BaseLlm {
  readonly primary: BaseLlm;
  readonly fallback: BaseLlm;
  private readonly log: (m: string) => void;
  private readonly primaryProvider: string;

  constructor(primary: BaseLlm, fallback: BaseLlm, log: (m: string) => void = (m) => console.warn(m)) {
    super({ model: primary.model });
    this.primary = primary;
    this.fallback = fallback;
    this.log = log;
    this.primaryProvider = providerForModel(primary.model);
  }

  async *generateContentAsync(llmRequest: LlmRequest, stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    if (circuitOpen(this.primaryProvider)) {
      yield* this.onFallback(llmRequest, stream, abortSignal, `${this.primaryProvider} circuit is open`);
      return;
    }
    let yielded = false;
    let answered = false;
    let errored = false;
    let redirect: string | undefined;
    try {
      for await (const r of this.primary.generateContentAsync(llmRequest, stream, abortSignal)) {
        if (r.errorCode) {
          errored = true;
          if (!canceled(abortSignal) && isRetryableErrorResponse(r)) {
            recordFailure(this.primaryProvider);
            if (!yielded && !hasContent(r)) {
              // Leaving the loop closes the primary's call before the fallback's opens.
              redirect = `${this.primary.model} failed (${r.errorCode}: ${String(r.errorMessage ?? '').slice(0, 120)})`;
              break;
            }
          }
        } else if (hasContent(r)) {
          answered = true;
        }
        yielded = true;
        yield r;
      }
      if (answered && !errored) recordSuccess(this.primaryProvider);
    } catch (err) {
      if (canceled(abortSignal) || !isProviderFailure(err)) throw err;
      recordFailure(this.primaryProvider);
      if (yielded) throw err;
      redirect = `${this.primary.model} failed (${errorText(err).slice(0, 120)})`;
    }
    if (redirect) yield* this.onFallback(llmRequest, stream, abortSignal, redirect);
  }

  private async *onFallback(llmRequest: LlmRequest, stream: boolean | undefined, abortSignal: AbortSignal | undefined, why: string): AsyncGenerator<LlmResponse, void> {
    this.log(`[models] ${why}; answering from ${this.fallback.model}.`);
    const request = { ...llmRequest, model: this.fallback.model } as LlmRequest;
    yield* this.fallback.generateContentAsync(request, stream, abortSignal);
  }

  connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return this.primary.connect(llmRequest);
  }
}
