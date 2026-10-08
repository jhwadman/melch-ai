/**
 * lib/models/grokAdapter.ts — xAI's Grok behind the engine's own model
 * contract (lib/models/contract.ts, ADR 0048).
 *
 * WHY it extends GptAdapter (the Responses API) and not the chat-completions
 * base: xAI retired Live Search on chat completions (the API answers 410
 * "Live search is deprecated. Please switch to the Agent Tools API"). The
 * Agent Tools API lives at https://api.x.ai/v1/responses and speaks OpenAI's
 * Responses wire: the same `input` items, `function` and `web_search` tools,
 * and `reasoning`, `message` and `function_call` output items (verified live
 * 2026-07-19). So Grok reuses the GptAdapter translation through the openai
 * SDK's baseURL, and overrides only the vendor hooks below. The contract's
 * xAI table (wiki/models/model-contract.md) lists what differs.
 *
 * WHAT DIFFERS FROM GPT:
 *   - Provider id `xai`, key XAI_API_KEY, endpoint api.x.ai only (no platforms).
 *   - A per-attempt timeout (XAI_TIMEOUT_MS, grokTimeoutMs).
 *   - `reasoning.effort` on grok-4.5, grok-4.6 and grok-4.7, pinned to
 *     DEFAULT_GROK_REASONING_EFFORT when the request sets none; `none` is
 *     sent as `low`, since these models cannot stop reasoning.
 *   - Reasoning items replayed across a tool loop on the same ids (ADR 0050).
 *   - Native tools: web_search with XAI_WEB_SEARCH_* filters, x_search with
 *     XAI_X_SEARCH_* bounds, collections_search as `file_search` over
 *     XAI_COLLECTION_IDS (omitted while that is empty). Deployment
 *     configuration, never request fields.
 */

import { DEFAULT_GROK_REASONING_EFFORT } from '../config.ts';
import type { ModelRequest, NativeTool, ReasoningSetting } from './contract.ts';
import type { ProviderEndpoint } from './endpoints.ts';
import { GptAdapter } from './gptAdapter.ts';
import type { GptAdapterOptions, NativeToolPlan } from './gptAdapter.ts';
import { reasoningConfig } from './reasoning.ts';
import { xaiWebSearchParamsFromEnv } from '../tools/webSearchTool.ts';
import { xSearchParamsFromEnv } from '../tools/xSearchTool.ts';
import { collectionIdsFromEnv, collectionsMaxResultsFromEnv } from '../tools/collectionsSearchTool.ts';

export const XAI_BASE_URL = 'https://api.x.ai/v1';

/**
 * The ids that take a reasoning effort and return encrypted reasoning:
 * grok-4.5, grok-4.6 and grok-4.7 (docs.x.ai › Model capabilities › Text ›
 * Reasoning). Older ids (grok-3, grok-4-1-fast-reasoning) take neither.
 */
export const GROK_REASONING_IDS = /^grok-4\.[5-7](?!\d)/;

export const DEFAULT_GROK_TIMEOUT_MS = 600_000;
const MIN_GROK_TIMEOUT_MS = 120_000;

/** The per-attempt timeout: XAI_TIMEOUT_MS, floored at two minutes. */
export function grokTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.XAI_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_GROK_TIMEOUT_MS;
  return Math.max(MIN_GROK_TIMEOUT_MS, raw);
}

/** The native tools xAI runs, in the order a request sends them. */
const XAI_NATIVE_ORDER: readonly NativeTool[] = ['web_search', 'x_search', 'collections_search'];

/** GptAdapter's options. `endpoint` is ignored: xAI has no platforms, and every request goes to api.x.ai. */
export type GrokAdapterOptions = GptAdapterOptions;

export class GrokAdapter extends GptAdapter {
  override readonly provider: string = 'xai';
  protected override readonly label: string = 'xAI';

  constructor(options: GrokAdapterOptions) {
    super({ model: options.model, ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}) });
  }

  protected override endpoint(): ProviderEndpoint {
    return { platform: 'direct' };
  }

  protected override baseURL(): string {
    return XAI_BASE_URL;
  }

  protected override apiKeyFromEnv(): string | undefined {
    return process.env.XAI_API_KEY;
  }

  protected override missingKeyMessage(): string {
    return 'XAI_API_KEY is not set in environment.';
  }

  /**
   * Per-attempt request timeout. xAI's streaming docs use 3600 s for
   * reasoning models, but the OpenAI SDK retries a timed-out request twice on
   * top, so an hour per attempt let one hung call hold a task for three
   * hours. Ten minutes still clears the slowest reasoning turns seen, and
   * caps the worst case near half an hour. XAI_TIMEOUT_MS overrides it;
   * values under two minutes are raised to two. The turn's own deadline
   * (turnControl) still applies.
   */
  protected override clientOptions(): Record<string, unknown> {
    return { timeout: grokTimeoutMs() };
  }

  /**
   * grok-4.5, grok-4.6 and grok-4.7 take `reasoning.effort` (`low`, `medium`,
   * `high`; xAI's own default is `high`, and reasoning cannot be turned off).
   * The request's setting maps through ADR 0047's table, which sends `none`
   * as `low`; with none set, DEFAULT_GROK_REASONING_EFFORT (medium) is pinned,
   * since effort is part of the price. Other grok ids take no field.
   */
  override reasoningParam(setting: ReasoningSetting | undefined, model: string = this.model): Record<string, unknown> | undefined {
    if (!GROK_REASONING_IDS.test(model)) return undefined;
    return { effort: setting === undefined ? DEFAULT_GROK_REASONING_EFFORT : reasoningConfig(model, setting).reasoningEffort };
  }

  /**
   * grok-4.5, grok-4.6 and grok-4.7 carry their reasoning across a tool loop
   * (ADR 0050): xAI's Responses API takes `store: false` and
   * `include: ['reasoning.encrypted_content']` and accepts the returned
   * reasoning items back in `input`. Other grok ids send neither.
   */
  override replaysReasoning(model: string = this.model): boolean {
    return GROK_REASONING_IDS.test(model);
  }

  /** Sampling goes to every grok id, as it always has. */
  protected override acceptsSampling(): boolean {
    return true;
  }

  /**
   * xAI's tool objects. web_search carries the XAI_WEB_SEARCH_* domain filters
   * (it takes no date bounds; docs.x.ai, 2026-08-08), x_search the
   * XAI_X_SEARCH_* bounds, and collections_search is xAI's `file_search` over
   * XAI_COLLECTION_IDS, left out with a warning while that is empty. Each is
   * bare when nothing is configured. Every other native tool is dropped.
   */
  override nativeToolPlan(request: Pick<ModelRequest, 'nativeTools'>): NativeToolPlan {
    const plan: NativeToolPlan = { tools: [], dropped: [], attributes: {} };
    const asked = new Set(request.nativeTools ?? []);
    for (const tool of XAI_NATIVE_ORDER) {
      if (!asked.has(tool)) continue;
      if (tool === 'web_search') {
        plan.tools.push({ type: 'web_search', ...xaiWebSearchParamsFromEnv() });
        plan.attributes['llm.web_search.native'] = true;
      } else if (tool === 'x_search') {
        plan.tools.push({ type: 'x_search', ...xSearchParamsFromEnv() });
      } else {
        const ids = collectionIdsFromEnv();
        if (ids.length > 0) {
          const max = collectionsMaxResultsFromEnv();
          plan.tools.push({ type: 'file_search', vector_store_ids: ids, ...(max !== undefined ? { max_num_results: max } : {}) });
          plan.attributes['llm.collections_search.native'] = true;
        } else {
          console.warn('[collections_search] declared but XAI_COLLECTION_IDS is empty — tool omitted for this request.');
          plan.attributes['llm.collections_search.omitted'] = true;
        }
      }
    }
    for (const tool of asked) if (!XAI_NATIVE_ORDER.includes(tool)) plan.dropped.push(tool);
    return plan;
  }
}
