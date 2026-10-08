/**
 * lib/models/kimiAdapter.ts — Moonshot AI (Kimi) behind the engine's own
 * model contract (lib/models/contract.ts, ADR 0048).
 *
 * WHY this file exists:
 *   Model optionality is a primary driver of this framework: the agent YAML
 *   declares `model`, and the registry routes it to the right provider.
 *   Kimi K3 (July 2026) is the strongest open-weight model on the public
 *   coding and research boards, and Moonshot serves it first-party with
 *   tool calling, strict structured output and vision, so it earns a
 *   direct adapter rather than only the gateway path. Under ADK it runs
 *   behind KimiLlm (lib/models/kimiLlm.ts), which any `kimi-*` id routes to.
 *
 * WHY the chat-completions base (lib/models/chatCompletionsAdapter.ts):
 *   Moonshot's API is OpenAI Chat Completions at https://api.moonshot.ai/v1
 *   (it also serves Responses on the same base and Anthropic Messages at
 *   /anthropic; neither adds a capability the chat dialect lacks here).
 *   The base provides tool calling, strict `json_schema` structured output
 *   (Moonshot documents `strict: true`), SSE streaming with usage, image
 *   parts as base64 data URIs (Moonshot rejects public image URLs, so a URL
 *   blob is never sent), `reasoning_content` surfaced as thinking, and
 *   retries.
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
 * REASONING (ADR 0047):
 *   K3 always thinks; the lever is the top-level `reasoning_effort`
 *   (low | high | max, Moonshot's default max). A request's `reasoning`
 *   goes as its Kimi word (`medium` → `high`, a budget → the level that
 *   covers it), `none` as `low` since K3 cannot switch thinking off, and a
 *   request with none pins DEFAULT_KIMI_REASONING_EFFORT (lib/config.ts).
 *   `max` has no contract level: an agent that needs it writes the older
 *   spelling `generateContentConfig.reasoningEffort: max`, which the ADK
 *   path carries beside the contract (ChatCompletionsRequest.olderSpelling).
 *   K2.x models take no reasoning_effort: a `thinking: { type }` switch
 *   instead, so `none` (or a budget of 0) sends `disabled` and any other
 *   setting sends nothing (K2.7 Code rejects disabled thinking; Moonshot's
 *   own error says so).
 *
 * TOOL CHOICE: auto and none (none by sending no tools). `required` and a
 *   named tool are weakened to auto, with llm.tool_choice.weakened on the
 *   span, until they are verified against Moonshot (toolChoiceModes).
 *
 * LIMITATIONS:
 *   - web_search: Moonshot's model-side `$web_search` built-in retires on
 *     2026-10-20 and its replacement is a separate REST API
 *     (POST /v1/tools/search, billed per call), not a tool the model
 *     enables in the request. The tool is therefore dropped with a
 *     warning, like on Ollama; `web_extract` works, and `MOONSHOT_API_KEY`
 *     would fund a client-side search tool over that REST API if one is
 *     added (lib/tools/).
 *   - Thinking with tools: Moonshot's thinking-model guide (October 2026)
 *     asks for every id above that an assistant message's
 *     `reasoning_content` be sent back on the next request of a tool loop
 *     ("required" on K3). This adapter turns on the base's
 *     replaysReasoningContent for those ids (wantsReasoningReplay), so the
 *     field rides as providerState on the part that followed it and goes
 *     back on that message within the turn's tool loop, for the same model
 *     only (ADR 0046). Earlier turns' reasoning is not sent: K3 and
 *     K2.7 Code also ask for it across turns ("preserved thinking"), and
 *     the stored history of a past turn is not what the model saw. The
 *     replayed text is billed again as input on every later step of the
 *     loop, mostly at the cache-hit price, since the prefix is unchanged.
 *   - Every cell of its capability row is asserted against the request body
 *     the adapter sends (tests/capabilityMatrix.test.ts), as for every other
 *     provider. Verified live on 2026-10-03 through `npm run demo:models`:
 *     kimi-k3 at low effort answered the zoo's explainer prompt in 17.9 s,
 *     440 tokens in, 486 out, 262 of them thinking, the scratchpad surfaced
 *     from reasoning_content; tool loops and search were not exercised.
 */

import type { ReasoningSetting } from './contract.ts';
import { DEFAULT_KIMI_REASONING_EFFORT } from '../config.ts';
import { ChatCompletionsAdapter, reasonsNotAtAll } from './chatCompletionsAdapter.ts';
import type { ChatFailure } from './chatCompletionsAdapter.ts';
import { reasoningConfig } from './reasoning.ts';
import { trimTrailingSlashes } from './urls.ts';

export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';

/** The flagship takes `reasoning_effort`; the K2 generation takes a `thinking` switch. */
export function isKimiK3(model: string): boolean {
  return /^kimi-k3\b/.test(model);
}

/**
 * The ids Moonshot documents as wanting `reasoning_content` back on a tool
 * loop: K3, K2.6 and K2.7 Code (with its highspeed variant).
 */
export function wantsReasoningReplay(model: string): boolean {
  return isKimiK3(model) || /^kimi-k2\.(6|7-code)\b/.test(model);
}

export interface KimiAdapterOptions {
  /** The model id as the YAML names it: "kimi-*". */
  model: string;
  /** A caller's own key; default MOONSHOT_API_KEY, read at call time. */
  apiKey?: string;
  /** Default: MOONSHOT_BASE_URL in the environment, else https://api.moonshot.ai/v1. */
  baseUrl?: string;
}

export class KimiAdapter extends ChatCompletionsAdapter {
  readonly provider = 'moonshot';
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;

  constructor({ model, apiKey, baseUrl }: KimiAdapterOptions) {
    super({ model });
    this.#apiKey = apiKey;
    this.#baseUrl = trimTrailingSlashes(baseUrl || process.env.MOONSHOT_BASE_URL || MOONSHOT_BASE_URL);
  }

  protected endpointUrl(): string {
    return `${this.#baseUrl}/chat/completions`;
  }

  #key(): string | undefined {
    return this.#apiKey ?? process.env.MOONSHOT_API_KEY;
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#key() ?? ''}` };
  }

  /** reasoning_content goes back on the tool loop for the ids that ask for it (see the header). */
  protected override replaysReasoningContent(model: string): boolean {
    return wantsReasoningReplay(model);
  }

  protected override missingRequirement(): ChatFailure | undefined {
    if (this.#key()) return undefined;
    return { code: 'MOONSHOT_MISSING_KEY', message: 'MOONSHOT_API_KEY is not set in environment.' };
  }

  protected override httpError(status: number, detail: string, model: string): ChatFailure {
    const hint =
      status === 401
        ? ' Check MOONSHOT_API_KEY (platform.moonshot.ai).'
        : status === 404
          ? ` Is "${model}" a current Kimi id? kimi-k2.5 and moonshot-v1-* were retired on 2026-08-31.`
          : '';
    return {
      code: 'MOONSHOT_HTTP_ERROR',
      message: `Moonshot returned ${status}: ${detail.slice(0, 4000)}.${hint}`,
    };
  }

  /** The reasoning controls, per generation (see the header). */
  protected override reasoningFields(model: string, setting: ReasoningSetting | undefined, olderWord: string | undefined): Record<string, unknown> {
    if (isKimiK3(model)) {
      if (olderWord !== undefined) return { reasoning_effort: olderWord };
      if (setting === undefined) return { reasoning_effort: DEFAULT_KIMI_REASONING_EFFORT };
      const word = reasoningConfig(model, setting).reasoningEffort;
      return { reasoning_effort: word === 'none' ? 'low' : word }; // K3 cannot switch thinking off
    }
    return reasonsNotAtAll(setting) ? { thinking: { type: 'disabled' } } : {};
  }
}
