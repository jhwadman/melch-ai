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
 * THE RULES:
 *   - Only provider-side failures count: what retry.ts classifies retryable
 *     (408/409/425/429/5xx, connection resets) once the adapter's own retries
 *     are spent. A 4xx is the request's fault and is thrown as it is; a
 *     canceled turn is never counted or redirected.
 *   - The fallback runs only if the primary produced nothing yet: a stream
 *     that failed midway is thrown, never replayed on another model.
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

import { classifyError } from './retry.ts';
import { providerForModel } from './providerMap.ts';
import { circuitOpen, recordFailure, recordSuccess } from './circuitBreaker.ts';

// The breaker's state lives in lib/models/circuitBreaker.ts, shared with the
// contract-level FallbackAdapter. Re-exported so existing imports keep working.
export { circuitOpen, resetCircuits } from './circuitBreaker.ts';

/** A provider-side failure: worth counting against the provider and worth a fallback. */
export function isProviderFailure(err: unknown): boolean {
  if ((err as { name?: string })?.name === 'AbortError') return false;
  return classifyError(err).retryable;
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
    try {
      for await (const r of this.primary.generateContentAsync(llmRequest, stream, abortSignal)) {
        yielded = true;
        yield r;
      }
      recordSuccess(this.primaryProvider);
    } catch (err) {
      if (abortSignal?.aborted || !isProviderFailure(err)) throw err;
      recordFailure(this.primaryProvider);
      if (yielded) throw err;
      yield* this.onFallback(llmRequest, stream, abortSignal, `${this.primary.model} failed (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`);
    }
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
