/**
 * lib/models/claudeLlm.ts — Anthropic Claude for the ADK LLMRegistry: the
 * Claude adapter on the engine's contract (lib/models/claudeAdapter.ts)
 * behind the ADK shim (lib/models/adkShim.ts).
 *
 * WHY this file exists:
 *   ADK's TypeScript line ships only Gemini models, but it takes any BaseLlm
 *   subclass registered with LLMRegistry, keyed by model-name patterns, so
 *   once registered every LlmAgent with model: "claude-*" routes here. The
 *   translation to the Messages API lives in ClaudeAdapter, which reads a
 *   ModelRequest and yields ModelResponses (ADR 0048). This class is the
 *   shim around it: the shim maps ADK's LlmRequest in and each response
 *   back, charges the turn and opens the llm.request span (ADR 0053).
 *
 * HOW TO ENABLE:
 *   1. Install the Anthropic SDK:
 *        npm install @anthropic-ai/sdk
 *   2. Add your API key to .env:
 *        ANTHROPIC_API_KEY=sk-ant-...
 *   3. registerAvailableProviders() (lib/models/registry.ts) registers this
 *      class automatically when the key is set.
 *   4. Set model: "claude-sonnet-4-6" (or any claude-* id) in your YAML.
 *
 * WHAT THIS CLASS ADDS TO THE SHIM: the agent's older reasoning spelling.
 *   The compiler writes `reasoning:` as generateContentConfig.thinkingConfig
 *   and reasoningEffort (ADR 0047), and an agent may set those directly. The
 *   contract's `reasoning` cannot say all of what ADR 0049 reads from them
 *   (the effort words `xhigh` and `max`, `minimal` as `low`, the budget rows
 *   reading the budget alone), so this class hands the adapter that reading
 *   as `claudeReasoning` (ADR 0055). Everything else is the shim's mapping.
 *
 * What the adapter does (thinking by model generation, signed blocks
 * replayed within the tool loop, structured output, images, web search) is
 * described in its header and in wiki/models/claude-adapter.md.
 */

import { LLMRegistry } from '@google/adk';
import type { LlmRequest } from '@google/adk';

import { AdkShim } from './adkShim.ts';
import { ClaudeAdapter, anthropicTools } from './claudeAdapter.ts';
import type { ClaudeModelRequest } from './claudeAdapter.ts';
import { claudeReasoningFromConfig } from './claudeModels.ts';
import type { ProviderEndpoint } from './endpoints.ts';
import { llmRequestToModelRequest } from './genaiMapping.ts';
import type { ModelRequestOptions } from './genaiMapping.ts';

export { THINKING_STATE_KIND } from './claudeAdapter.ts';

/**
 * The tool definitions ClaudeLlm sends for an LlmRequest's toolsDict, before
 * the platform is known: client tools with lowercase schemas, and the
 * web_search sentinel as Anthropic's native server tool (AnthropicTool, from
 * anthropicTools in lib/models/claudeAdapter.ts).
 */
export function buildAnthropicTools(llmRequest: LlmRequest): any[] {
  return anthropicTools(llmRequestToModelRequest(llmRequest));
}

export class ClaudeLlm extends AdkShim {
  /**
   * Regex patterns that map model name strings to this provider.
   * Any model: "claude-*" in a YAML config will route here after registration.
   */
  static readonly supportedModels: Array<string | RegExp> = [/^claude-.+/];

  /**
   * `apiKey`: a caller's own key, which wins over the endpoint's and
   * ANTHROPIC_API_KEY. `endpoint` (ADR 0023): where the request goes —
   * Anthropic's API (or a proxy at its base URL), Bedrock, or Vertex AI.
   * Default: the environment's (`ANTHROPIC_PLATFORM`).
   */
  constructor({ model, apiKey, endpoint }: { model: string; apiKey?: string; endpoint?: ProviderEndpoint }) {
    super(new ClaudeAdapter({ model, apiKey, endpoint }), { model });
  }

  /** The shim's ModelRequest, with the agent's older reasoning spelling read as ADR 0049 reads it (ADR 0055). */
  protected override toModelRequest(llmRequest: LlmRequest, options: ModelRequestOptions): ClaudeModelRequest {
    return {
      ...super.toModelRequest(llmRequest, options),
      claudeReasoning: claudeReasoningFromConfig((llmRequest.config ?? {}) as Record<string, unknown>),
    };
  }

}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers ClaudeLlm with the ADK LLMRegistry.
 *
 * WHY a separate function instead of auto-registering at import time:
 *   Auto-registration at module load would cause every consumer of this file
 *   to unconditionally register Claude, even if ANTHROPIC_API_KEY is absent.
 *   By making registration explicit, registerAvailableProviders() can
 *   conditionally call this only when the key is present, and log a clear
 *   message about which provider is active.
 */
export function registerClaudeLlm(): void {
  LLMRegistry.register(ClaudeLlm);
}
