/**
 * lib/models/kimiLlm.ts — Moonshot AI (Kimi) provider for the ADK LLMRegistry.
 *
 * WHY this file exists:
 *   Model optionality is a primary driver of this framework: the agent YAML
 *   declares `model`, and the registry routes it to the right provider.
 *   Kimi K3 (July 2026) is the strongest open-weight model on the public
 *   coding and research boards, and Moonshot serves it first-party with
 *   tool calling, strict structured output and vision, so it earns a
 *   direct adapter rather than only the gateway path.
 *
 * WHY it subclasses the chat-completions base (lib/models/openAiCompatibleLlm.ts):
 *   Moonshot's API is OpenAI Chat Completions at https://api.moonshot.ai/v1
 *   (it also serves Responses on the same base and Anthropic Messages at
 *   /anthropic; neither adds a capability the chat dialect lacks here).
 *   The base provides tool calling, strict `json_schema` structured output
 *   (Moonshot documents `strict: true`), SSE streaming with usage, image
 *   parts as base64 data URIs (Moonshot rejects public image URLs, which is
 *   what the base never sends), `reasoning_content` surfaced as THINKING
 *   output, retries, and the llm.request span.
 *
 * HOW TO ENABLE:
 *   1. Create a key at https://platform.moonshot.ai (international; the
 *      .cn console serves mainland China) and put it in .env as
 *      MOONSHOT_API_KEY.
 *   2. Set model: "kimi-k3" (or any kimi-* id) in your YAML.
 *   registerAvailableProviders() registers this adapter when the key is set.
 *   Optional: MOONSHOT_BASE_URL for a proxy that speaks the same dialect.
 *
 * THE FAMILY (platform.moonshot.ai › Model list, October 2026; USD per 1M tokens):
 *
 *     model                      context   in / cache hit / out   use it for
 *     ──────────────────────────────────────────────────────────────────────
 *     kimi-k3                    1M        $3.00 / $0.30 / $15    DEFAULT — the flagship: 2.8T MoE, vision,
 *                                                                 always-on thinking, effort low|high|max
 *     kimi-k2.6                  256K      $0.95 / $0.16 / $4     the cheaper general tier: vision, thinking
 *                                                                 switchable; fragile on complex schemas
 *     kimi-k2.7-code             256K      $0.95 / $0.19 / $4     coding; thinking cannot be turned off
 *     kimi-k2.7-code-highspeed   256K      $1.90 / $0.38 / $8     the same model at ~180 tokens/s
 *
 * CHOOSING A MODEL (cost is a design property; see the model-routing skill):
 *   K3 is priced like a mid-tier closed model, not like an open-weight
 *   bargain: $3 / $15 is Claude Sonnet 4.6's price, and Claude Sonnet 5.5
 *   ($2 / $10, cache reads $0.20) undercuts it on every token while sitting
 *   above it on the coding boards. Two things make K3 dearer than its list
 *   price: thinking is always on and billed as output, and Moonshot's
 *   default effort is max — hence the pinned DEFAULT_KIMI_REASONING_EFFORT
 *   and the zoo agent at "low". What K3 buys is the strongest open-weight
 *   model (a self-host option) and a 1M context at a flat rate. For cost,
 *   reach for kimi-k2.6 (a quarter of K3's price, vision and tools) on
 *   subagent and bulk work, or serve K3 through the gateway: OpenRouter's
 *   endpoints range from about $0.88 to $3.45 per 1M input, the cheap ones
 *   quantized, with fidelity as the trade.
 *
 *   There is no small or "flash" K3; K2.6 is the light tier. K3's weights
 *   are open (moonshotai/Kimi-K3 on Hugging Face), so the id is also served
 *   by OpenRouter, Together, Fireworks, Vercel AI Gateway and others; with
 *   no direct key, MODEL_GATEWAY serves it as `moonshotai/kimi-k3`
 *   (lib/models/gateway.ts). kimi-k2.5 and the moonshot-v1 ids were retired
 *   on 2026-08-31 and are not routed here on purpose.
 *
 * REASONING:
 *   K3 always thinks; the lever is the top-level `reasoning_effort`
 *   (low | high | max, Moonshot's default max). Requests pin
 *   DEFAULT_KIMI_REASONING_EFFORT (lib/config.ts) unless the agent sets
 *   generateContentConfig.reasoningEffort; "none" is mapped to "low" on
 *   K3, which cannot switch thinking off. K2.x models take no
 *   reasoning_effort: a `thinking: { type }` switch instead, so on those
 *   ids reasoningEffort "none" or thinkingBudget 0 sends `disabled` and
 *   any effort value is dropped from the body (K2.7 Code rejects
 *   disabled thinking; Moonshot's own error says so).
 *
 * LIMITATIONS:
 *   - web_search: Moonshot's model-side `$web_search` built-in retires on
 *     2026-10-20 and its replacement is a separate REST API
 *     (POST /v1/tools/search, billed per call), not a tool the model
 *     enables in the request. The sentinel is therefore dropped with a
 *     warning, like on Ollama; `web_extract` works, and `MOONSHOT_API_KEY`
 *     would fund a client-side search tool over that REST API if one is
 *     added (lib/tools/).
 *   - Thinking with tools: Moonshot asks that K3's `reasoning_content` be
 *     passed back with the assistant message on a tool loop. This base
 *     keeps scratchpads out of history, so K3 re-reasons each step
 *     (degraded, stated in lib/models/capabilities.ts); if Moonshot ever
 *     enforces it, the turn ends with MOONSHOT_HTTP_ERROR naming the field.
 *   - Every cell of its capability row is asserted against the request body
 *     the adapter sends (tests/capabilityMatrix.test.ts), as for every other
 *     provider. Verified live on 2026-10-03 through `npm run demo:models`:
 *     kimi-k3 at low effort answered the zoo's explainer prompt in 17.9 s,
 *     440 tokens in, 486 out, 262 of them thinking, the scratchpad surfaced
 *     from reasoning_content; tool loops and search were not exercised.
 */

import { LLMRegistry } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { DEFAULT_KIMI_REASONING_EFFORT } from '../config.ts';
import { OpenAiCompatibleLlm } from './openAiCompatibleLlm.ts';

export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';

/** The flagship takes `reasoning_effort`; the K2 generation takes a `thinking` switch. */
export function isKimiK3(model: string): boolean {
  return /^kimi-k3\b/.test(model);
}

// ── KimiLlm ───────────────────────────────────────────────────────────────────

export class KimiLlm extends OpenAiCompatibleLlm {
  /** Any model: "kimi-*" in a YAML config routes here after registration. */
  static readonly supportedModels: Array<string | RegExp> = [/^kimi-.+/];

  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor({ model, apiKey, baseUrl }: { model: string; apiKey?: string; baseUrl?: string }) {
    super({ model });
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || process.env.MOONSHOT_BASE_URL || MOONSHOT_BASE_URL).replace(/\/+$/, '');
  }

  protected providerId(): string {
    return 'moonshot';
  }

  protected endpointUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  private key(): string | undefined {
    return this.apiKey ?? process.env.MOONSHOT_API_KEY;
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key() ?? ''}` };
  }

  protected override missingRequirement(): LlmResponse | undefined {
    if (this.key()) return undefined;
    return {
      errorCode: 'MOONSHOT_MISSING_KEY',
      errorMessage: 'MOONSHOT_API_KEY is not set in environment.',
    };
  }

  protected override httpError(status: number, detail: string): LlmResponse {
    const hint =
      status === 401
        ? ' Check MOONSHOT_API_KEY (platform.moonshot.ai).'
        : status === 404
          ? ` Is "${this.model}" a current Kimi id? kimi-k2.5 and moonshot-v1-* were retired on 2026-08-31.`
          : '';
    return {
      errorCode: 'MOONSHOT_HTTP_ERROR',
      errorMessage: `Moonshot returned ${status}: ${detail.slice(0, 4000)}.${hint}`,
    };
  }

  /**
   * The reasoning controls, per generation (see the header). The base has
   * already put `reasoning_effort` in the body when the agent set one;
   * these fields are merged after it, so an `undefined` here removes it
   * (JSON.stringify drops undefined keys).
   */
  protected override extraBodyFields(llmRequest: LlmRequest): Record<string, unknown> {
    const cfg = (llmRequest.config as any) ?? {};
    const effort: string | undefined = cfg.reasoningEffort;
    if (isKimiK3(this.model)) {
      if (effort === undefined) return { reasoning_effort: DEFAULT_KIMI_REASONING_EFFORT };
      if (effort === 'none') return { reasoning_effort: 'low' }; // K3 cannot switch thinking off
      return {};
    }
    const budget = cfg.thinkingConfig?.thinkingBudget;
    const off = effort === 'none' || budget === 0;
    return {
      reasoning_effort: undefined,
      ...(off ? { thinking: { type: 'disabled' } } : {}),
    };
  }
}

// ── Registration helper ───────────────────────────────────────────────────────

/** Registers KimiLlm with the ADK LLMRegistry (called when MOONSHOT_API_KEY is set). */
export function registerKimiLlm(): void {
  LLMRegistry.register(KimiLlm);
}
