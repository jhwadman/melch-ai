/**
 * lib/models/tracedGemini.ts — ADK's built-in Gemini, wrapped so Gemini calls
 * emit the same per-request llm.request spans (tokens, latency) as every other
 * provider, and get the shared transient-failure retries (lib/models/retry.ts).
 *
 * WHY its own module: two modules use it. lib/models/registry.ts registers it
 * for every Gemini id on the ADK path and builds it in resolveModel, and the
 * temporary AdkGeminiAdapter (lib/models/adkGeminiAdapter.ts) runs its calls
 * through generateWithRetries. registry.ts also builds that adapter in
 * resolveAdapter, so the class living in registry.ts would be an ESM import
 * cycle. registry.ts re-exports it, so `TracedGemini` imports from there keep
 * working.
 */

import { Gemini } from '@google/adk';
import type { GeminiParams, LlmRequest, LlmResponse } from '@google/adk';

import { endpointFromEnv, platformModel } from './endpoints.ts';
import type { ProviderEndpoint } from './endpoints.ts';
import { llmRequestToModelRequest } from './genaiMapping.ts';
import { errorStatus, retryUntilFirstYield } from './retry.ts';
import { setLlmSpanAttribute, traceLlmGeneration } from '../observability/tracer.ts';
import { currentTurnSignal } from '../runtime/turnControl.ts';

export class TracedGemini extends Gemini {
  // CRITICAL: reuse Gemini's exact regex instances. The LLMRegistry dict is
  // keyed by the regex OBJECT — registering the same instances REPLACES the
  // built-in Gemini entries instead of adding shadowed duplicates.
  static readonly supportedModels: Array<string | RegExp> =
    Gemini.supportedModels;

  /**
   * The Gemini platform (ADR 0023) applies to every construction, the
   * LLMRegistry's included: on Vertex AI the client authenticates with
   * Google Application Default Credentials for the configured project and
   * location, and an AI Studio key (the environment's or a caller's) is not
   * sent. `endpoint` overrides the environment's (the credentials plug point).
   */
  constructor(params: GeminiParams & { endpoint?: ProviderEndpoint } = {}) {
    const { endpoint: given, ...rest } = params;
    const e = given ?? endpointFromEnv('gemini');
    const model = rest.model ? platformModel(e, rest.model) : rest.model;
    super(
      e.platform === 'vertex'
        ? { ...rest, model, apiKey: e.apiKey, vertexai: true, project: e.project, location: e.location }
        : { ...rest, model, ...(e.apiKey && !rest.apiKey ? { apiKey: e.apiKey } : {}) },
    );
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    yield* traceLlmGeneration(
      {
        provider: 'gemini',
        model: this.model,
        request: () => llmRequestToModelRequest(llmRequest, { model: llmRequest.model || this.model, stream }),
      },
      this.generateWithRetries(llmRequest, stream, abortSignal ?? currentTurnSignal()),
    );
  }

  /**
   * One call through ADK's Gemini with the shared retries, tagging whatever
   * llm.request span is active (llm.web_search.native for Gemini grounding,
   * llm.retries, llm.http_status). generateContentAsync opens that span
   * around it; AdkGeminiAdapter (lib/models/adkGeminiAdapter.ts) runs it
   * inside the span its own caller opens (ADR 0053). A failed call throws,
   * as ADK's Gemini does. The abort signal is forwarded so a canceled turn stops the
   * request in flight (ADK's Gemini puts it on the genai request config).
   */
  async *generateWithRetries(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const hasGrounding = (llmRequest.config?.tools ?? []).some(
      (t: any) => t && (t.googleSearch || t.googleSearchRetrieval),
    );
    if (hasGrounding) setLlmSpanAttribute('llm.web_search.native', true);
    // Retries live here, not in genai's own httpOptions.retryOptions: that
    // hook (p-retry 4, client-level only) ignores the abort signal — it
    // sleeps and re-sends after a canceled turn — honours no Retry-After,
    // does not retry Node's "fetch failed" resets, and replaces a 4xx's
    // error body (e.g. "API key not valid") with a bare statusText. Wrapping
    // the call keeps genai's ApiError intact and applies the same policy as
    // every other adapter. A retry is only made while nothing has been
    // yielded, so a stream that fails mid-reply is surfaced, not replayed.
    // ADK's request preprocessing is idempotent, so re-sending the same
    // llmRequest is safe. The registry class, resolveModel()'s per-request
    // instances and AdkGeminiAdapter's are all TracedGemini, so all get this.
    try {
      yield* retryUntilFirstYield(
        () => super.generateContentAsync(llmRequest, stream, abortSignal),
        {
          signal: abortSignal,
          onRetry: ({ retries }) => setLlmSpanAttribute('llm.retries', retries),
        },
      );
    } catch (err) {
      // genai's ApiError carries the status; put it where the ledger reads.
      const status = errorStatus(err);
      if (status !== undefined) setLlmSpanAttribute('llm.http_status', status);
      throw err;
    }
  }
}
