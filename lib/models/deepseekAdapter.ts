/**
 * lib/models/deepseekAdapter.ts — DeepSeek behind the engine's own model
 * contract (lib/models/contract.ts, ADR 0048).
 *
 * WHY this file exists:
 *   Model optionality is a primary driver of this framework: the agent YAML
 *   declares `model`, and the registry routes it to the right provider.
 *   DeepSeek V4 is the cheapest capable model with tool calling and a 1M
 *   context on a first-party API (Flash at $0.15 / $0.60 per 1M off-peak),
 *   and its thinking mode needs request-side care the gateway cannot give
 *   it (reasoning_content back on every tool request, below), so it earns a
 *   direct adapter rather than only the gateway path; any `deepseek-*` id
 *   resolves to it (resolveAdapter, lib/models/adapterResolver.ts).
 *
 * WHY the chat-completions base (lib/models/chatCompletionsAdapter.ts):
 *   DeepSeek's API is OpenAI Chat Completions at https://api.deepseek.com
 *   (`/chat/completions`; it also serves a Responses API and an
 *   Anthropic-format API, neither adding a capability the chat dialect lacks
 *   here). The base provides tool calling, JSON mode, SSE streaming with
 *   usage, image parts as base64 data URIs, `reasoning_content` surfaced as
 *   thinking, and retries.
 *
 * HOW TO ENABLE:
 *   1. Create a key at https://platform.deepseek.com/api_keys and put it in
 *      .env as DEEPSEEK_API_KEY.
 *   2. Set model: "deepseek-flash" (or any deepseek-* id) in your YAML.
 *   The adapter is available when the key is set (logProviderStatuses()
 *   reports it).
 *   Optional: DEEPSEEK_BASE_URL for a proxy that speaks the same dialect.
 *
 * THE FAMILY (api-docs.deepseek.com › Models & Pricing, checked 2026-10-22;
 *   USD per 1M tokens, off-peak; peak is exactly double):
 *
 *     model              context  max out  in (miss) / cache hit / out   use it for
 *     ─────────────────────────────────────────────────────────────────────────────
 *     deepseek-flash     1M       384K     $0.15 / $0.003 / $0.60        DEFAULT — DeepSeek-V4.1-Flash-1017:
 *                                                                        vision, tools, thinking
 *     deepseek-v4-pro    1M       384K     $0.66 / $0.022 / $1.98        DeepSeek-V4-Pro-0813: the deeper
 *                                                                        tier; text only, no vision
 *
 *   Peak hours are 01:00–04:00 and 06:00–10:00 UTC on weekdays. The price
 *   rows (db/migrations/0019_deepseek_kimi_pricing.sql) carry the PEAK
 *   rates, so a budget never underestimates a call.
 *   Retired but still accepted: `deepseek-v4-flash` and
 *   `deepseek-v4-flash-vision-exp`, both served by V4.1-Flash and billed at
 *   Flash's price. The pre-V4 `deepseek-chat` and `deepseek-reasoner` were
 *   retired after 2026-07-24 (third-party reports); the 404 hint names the
 *   current ids. With no direct key, MODEL_GATEWAY serves an id as
 *   `deepseek/<id>` (lib/models/gateway.ts), the gateways' own catalog
 *   permitting.
 *
 * REASONING (ADR 0047; api-docs.deepseek.com › Thinking Mode):
 *   Both models think by default, at effort `high`. The switch is
 *   `thinking: { type: "enabled" | "disabled" }` in the body, the depth
 *   `reasoning_effort` (low | high | max). A request with no `reasoning`
 *   sends neither: the vendor's default (`high`, the middle of three) is not
 *   its slowest, so no effort is pinned in lib/config.ts. `none` (or a
 *   budget of 0) sends `thinking: disabled` and no effort; any other level
 *   sends `thinking: enabled` and its DeepSeek word: `medium` → `high`,
 *   `xhigh` → `max` (a missing word rounds up, as on Kimi K3, ADR 0117;
 *   DeepSeek's own server-side mapping would take `xhigh` as `high`), a
 *   budget → the level that covers it. In thinking mode temperature,
 *   presence_penalty and frequency_penalty are ignored without an error.
 *
 * THINKING WITH TOOLS (the one rule this adapter exists for):
 *   When a request carries `tools`, the `reasoning_content` of ALL previous
 *   assistant messages must be sent back, or the API returns 400; without
 *   tools it is ignored. The adapter turns on the base's
 *   replaysReasoningContent and replaysReasoningOnEveryTurn: the field rides
 *   as providerState on the part that followed it (ADR 0046) and goes back
 *   on every assistant message of a tool request, earlier turns included,
 *   for the same model; where none of its own is stored (an earlier turn's
 *   state dropped by the transcript projection, another model's turn) it is
 *   sent as an empty string, so the field is never missing. Whether DeepSeek
 *   accepts an empty string there is not verified live. The replayed text is
 *   billed again as input, mostly at the cache-hit price.
 *
 * TOOL CHOICE: auto and none. Whether thinking mode honours a forced
 *   `tool_choice` is not documented on the thinking-mode page and not
 *   checked live, so `required` and a named tool are weakened to auto and
 *   marked on the span (llm.tool_choice.weakened).
 *
 * LIMITATIONS:
 *   - Structured output is JSON mode (`response_format: json_object`), not a
 *     strict schema: an outputSchema goes as JSON mode with the schema asked
 *     for in the system message (takesStrictJsonSchema), and the engine
 *     validates the reply. Beside tools the schema goes as set_model_response.
 *   - web_search: DeepSeek's Search and Fetch are separate per-request REST
 *     APIs, not a chat request field, so the sentinel is dropped with a
 *     warning, as on Kimi; `web_extract` works.
 *   - Vision on deepseek-flash only; an image sent to deepseek-v4-pro is
 *     refused by the API.
 *   - Not run live: no DeepSeek key was available when this adapter was
 *     written (2026-10-22). Every cell of its capability row is asserted
 *     against the request body the adapter sends
 *     (tests/capabilityMatrix.test.ts), and the reasoning replay in
 *     tests/models.test.ts, all offline.
 */

import type { ReasoningSetting } from './contract.ts';
import { ChatCompletionsAdapter, reasonsNotAtAll } from './chatCompletionsAdapter.ts';
import type { ChatFailure } from './chatCompletionsAdapter.ts';
import { trimTrailingSlashes } from './urls.ts';
import { credentialValue } from './credentialSource.ts';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export interface DeepSeekAdapterOptions {
  /** The model id as the YAML names it: "deepseek-*". */
  model: string;
  /** A caller's own key; default DEEPSEEK_API_KEY, read at call time. */
  apiKey?: string;
  /** Default: DEEPSEEK_BASE_URL in the environment, else https://api.deepseek.com. */
  baseUrl?: string;
}

export class DeepSeekAdapter extends ChatCompletionsAdapter {
  readonly provider = 'deepseek';
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;

  constructor({ model, apiKey, baseUrl }: DeepSeekAdapterOptions) {
    super({ model });
    this.#apiKey = apiKey;
    this.#baseUrl = trimTrailingSlashes(baseUrl || process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL);
  }

  protected endpointUrl(): string {
    return `${this.#baseUrl}/chat/completions`;
  }

  #key(): string | undefined {
    return this.#apiKey ?? credentialValue('DEEPSEEK_API_KEY');
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#key() ?? ''}` };
  }

  /** reasoning_content goes back on the tool loop (see the header). */
  protected override replaysReasoningContent(_model: string): boolean {
    return true;
  }

  /** ...and on every earlier assistant message of a request with tools, or DeepSeek returns 400. */
  protected override replaysReasoningOnEveryTurn(_model: string): boolean {
    return true;
  }

  /** JSON mode only: no strict json_schema response_format. */
  protected override takesStrictJsonSchema(_model: string): boolean {
    return false;
  }

  protected override missingRequirement(): ChatFailure | undefined {
    if (this.#key()) return undefined;
    return { code: 'DEEPSEEK_MISSING_KEY', message: 'DEEPSEEK_API_KEY is not set in environment.' };
  }

  protected override httpError(status: number, detail: string, model: string): ChatFailure {
    const hint =
      status === 401
        ? ' Check DEEPSEEK_API_KEY (platform.deepseek.com/api_keys).'
        : status === 404
          ? ` Is "${model}" a current DeepSeek id? The current ids are deepseek-flash and deepseek-v4-pro; deepseek-chat and deepseek-reasoner were retired after 2026-07-24.`
          : '';
    return {
      code: 'DEEPSEEK_HTTP_ERROR',
      message: `DeepSeek returned ${status}: ${detail.slice(0, 4000)}.${hint}`,
    };
  }

  /** The thinking switch and its effort (see the header). */
  protected override reasoningFields(model: string, setting: ReasoningSetting | undefined): Record<string, unknown> {
    if (setting === undefined) return {}; // DeepSeek's default: thinking on, effort high
    if (reasonsNotAtAll(setting)) return { thinking: { type: 'disabled' } };
    return { thinking: { type: 'enabled' }, reasoning_effort: this.effortFor(model, setting) };
  }
}
