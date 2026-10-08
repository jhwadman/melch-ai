/**
 * lib/models/openAiCompatibleLlm.ts — the ADK shim base for every
 * chat-completions adapter (Ollama, Kimi, the gateway).
 *
 * WHY this file exists:
 *   The chat-completions translation lives on the engine's own model
 *   contract, in lib/models/chatCompletionsAdapter.ts and one adapter per
 *   provider (ollamaAdapter.ts, kimiAdapter.ts, gatewayAdapter.ts). ADK
 *   still runs every turn (ADR 0045), so each adapter runs behind an ADK
 *   BaseLlm: OllamaLlm, KimiLlm and GatewayLlm, subclasses of this class,
 *   which is an AdkShim (lib/models/adkShim.ts, ADR 0053). The shim charges
 *   the turn, opens the llm.request span and maps the request and responses;
 *   the adapter does the provider's work.
 *
 * WHAT THIS CLASS ADDS TO THE SHIM (ADR 0057): the ADK path stays what it
 * was before the adapters moved onto the contract.
 *   - The request: an agent's older generateContentConfig spelling that the
 *     contract leaves out rides beside it (olderSpellingOf): an effort word
 *     that is no contract level (Kimi K3's `max`), and JSON mode without a
 *     schema.
 *   - The response: the final keeps the shape these classes always yielded,
 *     which the ledger and FallbackLlm read. usageMetadata counts the
 *     reasoning inside candidatesTokenCount, as the provider's
 *     completion_tokens does, so llm.tokens.output and the turn's charge are
 *     unchanged (the shim's default is Gemini's meaning, which excludes it).
 *     finishReason is set only for a reply cut short (MAX_TOKENS); a final
 *     with no parts keeps its empty content; an HTTP failure keeps its
 *     top-level `status` and `retryable` beside the verdict in
 *     customMetadata.
 *
 * A /chat/completions provider of your own is a ChatCompletionsAdapter
 * subclass (the endpoint, headers, wire name, reasoning field and error
 * wording), run under ADK as `adkShim(adapter)` or as a subclass of this
 * class.
 */

import { FinishReason } from '@google/genai';
import type { GenerateContentConfig } from '@google/genai';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { AdkShim } from './adkShim.ts';
import type { AdkShimOptions } from './adkShim.ts';
import type { ModelResponse, Usage } from './contract.ts';
import type { ModelRequestOptions } from './genaiMapping.ts';
import type { ChatCompletionsAdapter, ChatCompletionsRequest, ChatMessage, OlderSpelling } from './chatCompletionsAdapter.ts';
import { setLlmSpanAttribute } from '../observability/tracer.ts';
import { isRetryableStatus } from './retry.ts';
import { statusDecision, withRetryVerdict } from './errorResponse.ts';

export { REASONING_CONTENT_KIND, splitThinkBlocks, ThinkStreamSplitter } from './chatCompletionsAdapter.ts';

/** The effort words a contract ReasoningSetting carries (genaiMapping's reasoningOf); any other rides as the older spelling. */
const CONTRACT_EFFORT_WORDS: ReadonlySet<string> = new Set(['none', 'minimal', 'low', 'medium', 'high']);

/**
 * What a generateContentConfig asks of a chat-completions provider that the
 * contract has no field for, or undefined when it asks nothing more:
 *   - `reasoningEffort` when it is a word no ReasoningSetting carries
 *     (`max`, `xhigh`), sent as written;
 *   - JSON mode: `responseMimeType: application/json` with no schema.
 */
export function olderSpellingOf(config: GenerateContentConfig | undefined): OlderSpelling | undefined {
  const cfg = (config ?? {}) as Record<string, unknown>;
  const out: OlderSpelling = {};
  const effort = cfg.reasoningEffort;
  if (typeof effort === 'string' && !CONTRACT_EFFORT_WORDS.has(effort)) out.reasoningEffort = effort;
  const schema = cfg.responseJsonSchema ?? cfg.responseSchema;
  const hasSchema = !!schema && typeof schema === 'object';
  if (cfg.responseMimeType === 'application/json' && !hasSchema) out.jsonMode = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Usage as the chat-completions classes have always reported it on the ADK
 * path: candidatesTokenCount is the provider's completion_tokens, reasoning
 * included, and thoughtsTokenCount the reasoning part of it.
 */
export function chatUsageMetadata(usage: Usage): NonNullable<LlmResponse['usageMetadata']> {
  return {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: usage.outputTokens,
    ...(usage.thinkingTokens !== undefined ? { thoughtsTokenCount: usage.thinkingTokens } : {}),
    totalTokenCount: usage.inputTokens + usage.outputTokens,
  };
}

// ── OpenAiCompatibleLlm ──────────────────────────────────────────────────────

export abstract class OpenAiCompatibleLlm extends AdkShim {
  declare readonly adapter: ChatCompletionsAdapter;

  constructor(adapter: ChatCompletionsAdapter, options: AdkShimOptions = {}) {
    super(adapter, options);
  }

  /** Provider id for telemetry: the adapter's (a gateway reports the upstream provider). */
  protected providerId(): string {
    return this.adapter.provider;
  }

  /** How the request reaches the provider: 'direct' or 'gateway:<id>' (llm.transport). */
  protected transport(): string {
    return this.adapter.transport();
  }

  /** The chat messages the adapter sends for this LlmRequest. */
  protected buildMessages(llmRequest: LlmRequest): ChatMessage[] {
    return this.adapter.messagesFor(this.toModelRequest(llmRequest, { model: this.model }));
  }

  /** The function tools the adapter sends for this LlmRequest (lowercase schemas). */
  protected buildTools(llmRequest: LlmRequest): unknown[] {
    return this.adapter.toolsFor(this.toModelRequest(llmRequest, { model: this.model }));
  }

  /** The genai mapping's request, with the older spelling the contract leaves out. */
  protected override toModelRequest(llmRequest: LlmRequest, options: ModelRequestOptions): ChatCompletionsRequest {
    const request = super.toModelRequest(llmRequest, options);
    const olderSpelling = olderSpellingOf(llmRequest.config);
    return olderSpelling ? { ...request, olderSpelling } : request;
  }

  /** The genai mapping's response, in the shape these classes have always yielded (see the header). */
  protected override toLlmResponse(response: ModelResponse): LlmResponse {
    const mapped = super.toLlmResponse(response);
    if (response.partial) return mapped;
    const { finishReason: _finish, usageMetadata: _usage, ...rest } = mapped;
    const error = response.error;
    return {
      ...(error ? {} : { content: { role: 'model', parts: [] } }),
      ...rest,
      ...(!error && response.finishReason === 'max_tokens' ? { finishReason: FinishReason.MAX_TOKENS } : {}),
      ...(response.usage ? { usageMetadata: chatUsageMetadata(response.usage) } : {}),
      ...(error?.status !== undefined ? { status: error.status, retryable: error.retryable } : {}),
    } as LlmResponse;
  }
}

// ── Kept for callers of the ADK-path helpers ─────────────────────────────────

/**
 * Stamps an HTTP error response with its numeric status and whether that
 * status is transient, and the same verdict in customMetadata
 * ('error.retryable', 'error.status'), where FallbackLlm reads it
 * (lib/models/errorResponse.ts). The chat-completions shims take these
 * fields from their adapter's error final instead (toLlmResponse).
 */
export function withHttpStatus(resp: LlmResponse, status: number): LlmResponse {
  setLlmSpanAttribute('llm.http_status', status);
  return { ...withRetryVerdict(resp, statusDecision(status)), status, retryable: isRetryableStatus(status) } as LlmResponse;
}

type GenaiUsage = NonNullable<ReturnType<typeof mapUsage>>;

/** Two genai usage records summed, field by field. */
export function addUsage(a: GenaiUsage | undefined, b: GenaiUsage | undefined): GenaiUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: GenaiUsage = {};
  for (const k of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount'] as const) {
    if (a[k] !== undefined || b[k] !== undefined) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  }
  return out;
}

/**
 * OpenAI-style usage → GenAI usageMetadata in the ADK-path meaning
 * (completion_tokens, reasoning included, as candidatesTokenCount), or
 * undefined when absent. The contract's meaning is chatUsage in
 * lib/models/chatCompletionsAdapter.ts.
 */
export function mapUsage(usage: any):
  | {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
    }
  | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    ...(usage.prompt_tokens !== undefined ? { promptTokenCount: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { candidatesTokenCount: usage.completion_tokens } : {}),
    ...(reasoning !== undefined ? { thoughtsTokenCount: reasoning } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokenCount: usage.total_tokens } : {}),
  };
}
