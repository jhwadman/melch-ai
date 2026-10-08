/**
 * lib/models/grokLlm.ts — xAI Grok for ADK's LLMRegistry: GptLlm (the ADK
 * shim around a Responses adapter) built on GrokAdapter
 * (lib/models/grokAdapter.ts).
 *
 * WHY this file exists:
 *   Model optionality is a primary driver of this framework: the agent YAML
 *   declares `model`, and the registry routes it to the right provider.
 *   xAI's Agent Tools API is wire-compatible with OpenAI's Responses API, so
 *   GrokAdapter extends GptAdapter and overrides only the vendor hooks
 *   (endpoint, key, timeout, reasoning effort, native tools), and GrokLlm
 *   extends GptLlm, which keeps the ADK path's usage meaning and
 *   server-side tool record (ADR 0056). Grok gets:
 *     - native web_search (server-side, with source citations)
 *     - x_search (live X posts) and collections_search (hosted document
 *       stores via the file_search wire shape — see collectionsSearchTool.ts)
 *     - reasoning summaries surfaced as { thought: true } THINKING output
 *     - reasoning carried across a tool loop on grok-4.5, 4.6 and 4.7
 *       (encrypted reasoning items as providerState, store: false — ADR 0050)
 *     - SSE streaming (ADK RunConfig streamingMode: SSE → partial deltas)
 *     - structured outputs (YAML outputSchema → text.format json_schema)
 *     - function tools with call_id round-tripping, lowercase schemas
 *
 * HOW TO ENABLE:
 *   1. Add your API key to .env as XAI_API_KEY (console.x.ai — paid).
 *   2. Set model: "grok-4.7" (or any grok-* id) in your YAML.
 *   registerAvailableProviders() registers this adapter when the key is set.
 *   grok-4.5, 4.6 and 4.7 requests carry reasoning effort 'medium' unless the
 *   agent sets `reasoning:` — DEFAULT_GROK_REASONING_EFFORT (lib/config.ts).
 *
 * API-DRIFT NOTE: every xAI-specific choice is confined to GrokAdapter's
 * overrides, so upstream drift stays a one-file fix. xAI's Responses endpoint
 * reports the serving backend in the response `model` field (e.g.
 * "grok-4.3"), which may differ from the requested id; invalid ids are
 * rejected with "Model not found".
 */

import { requireAdk } from '../adkPeer.ts';

import { GptLlm } from './gptLlm.ts';
import type { GptLlmOptions } from './gptLlm.ts';
import { GrokAdapter } from './grokAdapter.ts';

export { DEFAULT_GROK_TIMEOUT_MS, grokTimeoutMs } from './grokAdapter.ts';

// ── GrokLlm ───────────────────────────────────────────────────────────────────

export class GrokLlm extends GptLlm {
  /** Any model: "grok-*" in a YAML config routes here after registration. */
  static readonly supportedModels: Array<string | RegExp> = [/^grok-.+/];

  protected static override createAdapter(options: GptLlmOptions): GrokAdapter {
    return new GrokAdapter(options);
  }
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers GrokLlm with the ADK LLMRegistry. Called by
 * registerAvailableProviders() when XAI_API_KEY is present.
 */
export function registerGrokLlm(): void {
  requireAdk("Registering a model class with ADK's LLMRegistry").LLMRegistry.register(GrokLlm);
}
