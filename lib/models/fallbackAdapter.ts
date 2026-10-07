/**
 * lib/models/fallbackAdapter.ts — `fallback_model:` and the per-provider
 * circuit breaker (ADR 0044) on the engine's own model contract (ADR 0048).
 *
 * WHY: FallbackLlm (lib/models/fallback.ts) wraps two ADK BaseLlm adapters
 * and reads a failure from a throw. On the contract a failure is a final
 * response with `error` set, never a throw, and `error.retryable` already
 * says whether another model may succeed. This wrapper is the same rule set
 * read from that: one ModelAdapter around a primary and a fallback adapter.
 *
 * THE RULES (ADR 0044, unchanged):
 *   - Only a provider-side failure counts and redirects: `error.retryable`
 *     (lib/models/retry.ts classifies it: 408/409/425/429/5xx, a reset), with
 *     a `status`, when there is one, in retry.ts's retryable set. Any other
 *     4xx is the request's fault and is passed on as it is.
 *   - A canceled call is never counted or redirected: the request's signal
 *     is aborted, whatever the adapter reported.
 *   - The fallback answers only if the primary produced nothing: no partial
 *     was yielded and the failed final holds no parts. A call that failed
 *     midway is passed on, never replayed on another model.
 *   - The breaker (lib/models/circuitBreaker.ts) is keyed on the primary's
 *     `provider` and shared with FallbackLlm, so a provider tripped on one
 *     path is skipped on the other. While it is open the primary is not
 *     called. A success closes it; the fallback's own outcome is not counted.
 *
 * THE FALLBACK'S REQUEST: the caller's request with `model` rewritten to the
 * fallback's id. `reasoning` goes unchanged, and the fallback adapter maps it
 * to its own provider's field (ADR 0047), never the primary's mapping.
 *
 * The wrapper reports the primary's `provider` and `model`; each adapter
 * reports its own call to telemetry.
 *
 * It does not repair a primary that breaks the contract: a throw, or a call
 * that ends without a final, reaches the caller as it is, neither counted
 * nor redirected, for the caller to handle as it would from any adapter.
 */
import type { FinalModelResponse, ModelAdapter, ModelError, ModelRequest, ModelResponse } from './contract.ts';
import { circuitOpen, recordFailure, recordSuccess } from './circuitBreaker.ts';
import { isRetryableStatus } from './retry.ts';

export interface FallbackAdapterOptions {
  /** Where the redirect notice goes. Default `console.warn`. */
  log?: (message: string) => void;
}

/** A provider-side failure on the contract: worth counting against the provider and worth a fallback. */
export function isProviderError(error: ModelError): boolean {
  if (!error.retryable) return false;
  return error.status === undefined || isRetryableStatus(error.status);
}

export class FallbackAdapter implements ModelAdapter {
  readonly provider: string;
  readonly model: string;
  readonly primary: ModelAdapter;
  readonly fallback: ModelAdapter;
  private readonly log: (message: string) => void;

  constructor(primary: ModelAdapter, fallback: ModelAdapter, options: FallbackAdapterOptions = {}) {
    this.primary = primary;
    this.fallback = fallback;
    this.provider = primary.provider;
    this.model = primary.model;
    this.log = options.log ?? ((m) => console.warn(m));
  }

  async *generate(request: ModelRequest): AsyncIterable<ModelResponse> {
    if (circuitOpen(this.provider)) {
      yield* this.onFallback(request, `${this.provider} circuit is open`);
      return;
    }
    let produced = false;
    let failed: ModelError | undefined;
    for await (const response of this.primary.generate(request)) {
      if (response.partial) {
        produced = true;
        yield response;
        continue;
      }
      if (this.redirects(request, response, produced)) {
        failed = response.error;
        break;
      }
      yield response;
      return;
    }
    // The primary's call is closed before the fallback's opens.
    if (failed) yield* this.onFallback(request, `${this.model} failed (${failed.code}: ${failed.message.slice(0, 120)})`);
  }

  /** Counts the primary's final against its provider, and says whether the fallback answers it instead. */
  private redirects(request: ModelRequest, final: FinalModelResponse, produced: boolean): boolean {
    const { error } = final;
    if (!error) {
      recordSuccess(this.provider);
      return false;
    }
    if (request.signal?.aborted || !isProviderError(error)) return false;
    recordFailure(this.provider);
    return !produced && final.parts.length === 0;
  }

  private async *onFallback(request: ModelRequest, why: string): AsyncGenerator<ModelResponse, void> {
    this.log(`[models] ${why}; answering from ${this.fallback.model}.`);
    yield* this.fallback.generate({ ...request, model: this.fallback.model });
  }
}
