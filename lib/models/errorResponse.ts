/**
 * lib/models/errorResponse.ts — what a failed provider call says about
 * trying again, and the genai-shaped error response that carries it.
 *
 * WHY: an adapter reports a failed provider call as a final response with
 * `error`, never a throw, and the fallback (FallbackAdapter,
 * lib/models/fallbackAdapter.ts, ADR 0044) must tell a provider-side
 * failure from the request's own error without parsing a message. The
 * adapters' catch sites (Claude, GPT and Grok, and the chat-completions base
 * for Kimi, Ollama and the gateway) take the verdict and the scrubbed text
 * from here (errorDecision, statusDecision, errorText). A genai-shaped
 * LlmResponse (lib/models/genaiMapping.ts) carries the same verdict in its
 * customMetadata (withRetryVerdict). A response without the verdict is read
 * as not retryable: passed on, never redirected.
 *
 *   'error.retryable'  true when lib/models/retry.ts classifies the failure
 *                      retryable (408/409/425/429/5xx, a connection reset);
 *                      false for any other error and for a cancellation.
 *   'error.status'     the HTTP status, when the failure had one.
 *
 * THE MESSAGE keeps the adapter's own wording. Key-shaped text (the
 * `secret` patterns of lib/observability/redact.ts) is replaced before it
 * leaves the adapter, so an error never carries a key into a session, the
 * ledger or a log.
 */
import type { LlmResponse } from './genaiMapping.ts';

import { patternRedactor } from '../observability/redact.ts';
import { classifyError, isRetryableStatus } from './retry.ts';
import type { RetryDecision } from './retry.ts';

/** customMetadata key: whether another attempt or model may succeed. */
export const ERROR_RETRYABLE_KEY = 'error.retryable';
/** customMetadata key: the HTTP status of the failure, when it had one. */
export const ERROR_STATUS_KEY = 'error.status';

const scrubKeys = patternRedactor(['secret']);

/** A caught error's text, with key-shaped text removed. */
export function errorText(err: unknown): string {
  return scrubKeys(err instanceof Error ? err.message : String(err));
}

/** What a caught error says about trying again. A cancellation never is retryable. */
export function errorDecision(err: unknown): RetryDecision {
  const decision = classifyError(err);
  return (err as { name?: string } | undefined)?.name === 'AbortError' ? { ...decision, retryable: false } : decision;
}

/** What a non-2xx HTTP status says about trying again. */
export function statusDecision(status: number): RetryDecision {
  return { retryable: isRetryableStatus(status), status };
}

/**
 * Stamps an adapter's error response with the retry policy's verdict, and
 * scrubs key-shaped text from its message. Its errorCode and wording are
 * the adapter's own; customMetadata it already carries is kept.
 */
export function withRetryVerdict(response: LlmResponse, decision: RetryDecision): LlmResponse {
  return {
    ...response,
    ...(typeof response.errorMessage === 'string' ? { errorMessage: scrubKeys(response.errorMessage) } : {}),
    customMetadata: {
      ...response.customMetadata,
      [ERROR_RETRYABLE_KEY]: decision.retryable,
      ...(decision.status !== undefined ? { [ERROR_STATUS_KEY]: decision.status } : {}),
    },
  };
}
