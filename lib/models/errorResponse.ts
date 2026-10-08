/**
 * lib/models/errorResponse.ts — an ADK adapter's error response, saying
 * whether another attempt or another model may succeed.
 *
 * WHY: every adapter but Gemini reports a failed provider call as a yielded
 * LlmResponse carrying `errorCode`, never a throw. FallbackLlm
 * (lib/models/fallback.ts, ADR 0044) must tell a provider-side failure from
 * the request's own error without parsing a message, so an adapter's catch
 * site builds that response here, with the retry policy's verdict in its
 * customMetadata (Claude, GPT and Grok, and the chat-completions base for
 * Kimi, Ollama and the gateway). A
 * response without the verdict is read as not retryable: passed on, never
 * redirected.
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
import type { LlmResponse } from '@google/adk';

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

/**
 * The error response for a caught provider error: `errorCode`, the message
 * (the error's own text unless the adapter words it), and the verdict from
 * classifyError.
 */
export function providerErrorResponse(err: unknown, errorCode: string, errorMessage: string = errorText(err)): LlmResponse {
  return withRetryVerdict({ errorCode, errorMessage }, errorDecision(err));
}

/** True when a response is an error its adapter marked retryable: a provider-side failure. */
export function isRetryableErrorResponse(response: LlmResponse): boolean {
  return !!response.errorCode && response.customMetadata?.[ERROR_RETRYABLE_KEY] === true;
}
