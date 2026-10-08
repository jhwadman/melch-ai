/**
 * lib/models/gptLlm.ts — OpenAI GPT for ADK's LLMRegistry: the ADK shim
 * (lib/models/adkShim.ts) around GptAdapter (lib/models/gptAdapter.ts).
 *
 * WHY this file exists:
 *   Model optionality: any agent YAML with model: "gpt-*" (or an o-series id
 *   like "o4-mini") routes here after registration. The Responses API
 *   translation lives in GptAdapter, on the engine's own model contract
 *   (ADR 0048), so the native runtime can call it without ADK. GptLlm is
 *   what ADK registers and calls: the shim maps ADK's LlmRequest to a
 *   ModelRequest, charges the turn and opens the llm.request span once
 *   (ADR 0053), and maps each ModelResponse back. GrokLlm subclasses it.
 *
 * HOW TO ENABLE:
 *   1. Install the SDK (already in package.json):  npm install
 *   2. Add your API key to .env:  OPENAI_API_KEY=sk-...
 *   3. Set model: "gpt-5-mini" (or any gpt-* / o-series id) in your YAML.
 *   registerAvailableProviders() registers this adapter when the key is set.
 *
 * WHAT IT KEEPS FROM THE ADK PATH (ADR 0056), beyond the shim's mapping:
 *   - Usage in the Responses meaning: `candidatesTokenCount` is
 *     `output_tokens`, reasoning included, so llm.tokens.output, the turn's
 *     token charge and the ledger count what they always counted for GPT and
 *     Grok. (The shim's mapping writes Gemini's meaning, reasoning excluded.)
 *   - The server-side tool calls (web_search, x_search…) as
 *     customMetadata['responses.server_tool_calls'] and the vendor's counters
 *     as ['responses.server_tool_usage'], which the root span turns into
 *     ToolCall events so adk_turns.tool_calls counts a searched answer.
 *   - No groundingMetadata: the A2A server's sources lines stay Gemini's.
 *
 * The LlmRequest builders below (buildResponsesInput, buildResponsesTools)
 * are the adapter's own, run on the LlmRequest mapped to the contract.
 */

import { LLMRegistry } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { AdkShim } from './adkShim.ts';
import type { ModelResponse } from './contract.ts';
import type { ProviderEndpoint } from './endpoints.ts';
import { llmRequestToModelRequest, reasoningOf } from './genaiMapping.ts';
import { GptAdapter, responsesFunctionTools, responsesInput, responsesServerTools } from './gptAdapter.ts';
import type { GptAdapterOptions, ReasoningReplay } from './gptAdapter.ts';
import { GrokAdapter } from './grokAdapter.ts';
import { providerForModel } from './providerMap.ts';

export {
  REASONING_STATE_KIND,
  extractServerToolCalls,
  serverToolUsage,
  streamEventDelta,
} from './gptAdapter.ts';
export type { ServerToolCall } from './gptAdapter.ts';

// ── The LlmRequest builders (the adapter's, on the mapped request) ───────────

/** The ModelRequest an LlmRequest maps to, for the request's own model id. */
function toModelRequest(llmRequest: LlmRequest) {
  return llmRequestToModelRequest(llmRequest, { model: llmRequest.model || 'unknown' });
}

/**
 * ADK Contents → Responses API `input` items + `instructions` string: the
 * LlmRequest mapped to the contract (lib/models/genaiMapping.ts), then
 * GptAdapter's responsesInput. With `replay`, that provider's reasoning items
 * for that model are sent back before their part's item, within the current
 * turn's tool loop only (ADR 0050).
 */
export function buildResponsesInput(
  llmRequest: LlmRequest,
  replay?: ReasoningReplay,
): {
  instructions: string | undefined;
  input: any[];
} {
  const { instructions, input } = responsesInput(toModelRequest(llmRequest), replay);
  return { instructions, input };
}

/**
 * ADK toolsDict (+ the native-tool sentinels) → Responses API tool
 * definitions: the function tools, then the vendor's native tools, the
 * request's model choosing the vendor (xAI's filters ride only on grok ids).
 */
export function buildResponsesTools(llmRequest: LlmRequest): any[] {
  const request = toModelRequest(llmRequest);
  const adapter = providerForModel(request.model) === 'xai' ? new GrokAdapter({ model: request.model }) : new GptAdapter({ model: request.model });
  return [...responsesFunctionTools(request), ...adapter.nativeToolPlan(request).tools];
}

// ── GptLlm ───────────────────────────────────────────────────────────────────

/** GptLlm's constructor options: the adapter's (ADR 0023 for `endpoint`). */
export type GptLlmOptions = GptAdapterOptions;

export class GptLlm extends AdkShim {
  /** gpt-* and o-series ids route here after registration. */
  static readonly supportedModels: Array<string | RegExp> = [/^gpt-.+/, /^o[0-9].*/];

  declare readonly adapter: GptAdapter;

  /** The adapter a class builds for its options: GptAdapter here, GrokAdapter in GrokLlm. */
  protected static createAdapter(options: GptLlmOptions): GptAdapter {
    return new GptAdapter(options);
  }

  /**
   * `endpoint` (ADR 0023): OpenAI's API (or a proxy at its base URL) or Azure
   * OpenAI. Default: the environment's (`OPENAI_PLATFORM`).
   */
  constructor(options: { model: string; apiKey?: string; endpoint?: ProviderEndpoint }) {
    super((new.target as typeof GptLlm).createAdapter(options), { model: options.model });
  }

  /**
   * The shim's mapping, with the Responses usage meaning and the server-side
   * tool record the ADK path has always carried, and without groundingMetadata
   * (see the header, ADR 0056).
   */
  protected override toLlmResponse(response: ModelResponse): LlmResponse {
    const mapped = super.toLlmResponse(response);
    if (response.partial) return mapped;
    const { groundingMetadata: _dropped, ...out } = mapped;
    if (response.usage && out.usageMetadata) {
      out.usageMetadata = { ...out.usageMetadata, candidatesTokenCount: response.usage.outputTokens };
    }
    const tools = responsesServerTools(response);
    if (tools) {
      out.customMetadata = {
        ...out.customMetadata,
        ...(tools.calls.length > 0 ? { 'responses.server_tool_calls': tools.calls } : {}),
        ...(Object.keys(tools.usage).length > 0 ? { 'responses.server_tool_usage': tools.usage } : {}),
      };
    }
    return out;
  }

  /** The `reasoning` field this model sends for an LlmRequest's config (ADR 0047), as the adapter maps it. */
  protected reasoningParam(llmRequest?: LlmRequest): Record<string, unknown> | undefined {
    return this.adapter.reasoningParam(reasoningOf(llmRequest?.config));
  }

  /**
   * A Responses reply (non-delta) as the LlmResponses ADK sees: the reasoning
   * summaries as one thought partial (unless `skipThoughts`), then the final,
   * through the adapter's finalOf and this class's mapping.
   */
  protected *mapFinalResponse(response: any, opts: { skipThoughts?: boolean } = {}): Generator<LlmResponse> {
    const { thinking, final } = this.adapter.finalOf(response, this.model, opts);
    if (thinking) yield this.toLlmResponse(thinking);
    yield this.toLlmResponse(final);
  }
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers GptLlm with the ADK LLMRegistry. Called by
 * registerAvailableProviders() when OPENAI_API_KEY is present.
 */
export function registerGptLlm(): void {
  LLMRegistry.register(GptLlm);
}
