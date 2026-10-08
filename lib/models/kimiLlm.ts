/**
 * lib/models/kimiLlm.ts — Moonshot AI (Kimi), as an ADK BaseLlm for the
 * LLMRegistry.
 *
 * WHY this file exists:
 *   The provider's work is KimiAdapter (lib/models/kimiAdapter.ts), on the
 *   engine's own model contract; its header covers the family, cost, the
 *   reasoning controls per generation, and reasoning_content on tool loops
 *   (ADR 0046). ADK still runs every turn, so this class runs the adapter
 *   under ADK: it is the chat-completions shim
 *   (lib/models/openAiCompatibleLlm.ts, ADR 0057), registered for any
 *   `kimi-*` id when MOONSHOT_API_KEY is set. The constructor and
 *   supportedModels are what they were before the adapter moved onto the
 *   contract, so lib/models/registry.ts and every caller are unchanged. On
 *   this path an agent's older spelling `reasoningEffort: max` still reaches
 *   K3, which the contract has no level for.
 */

import { LLMRegistry } from '@google/adk';

import { KimiAdapter } from './kimiAdapter.ts';
import { OpenAiCompatibleLlm } from './openAiCompatibleLlm.ts';

export { MOONSHOT_BASE_URL, isKimiK3, wantsReasoningReplay } from './kimiAdapter.ts';

// ── KimiLlm ───────────────────────────────────────────────────────────────────

export class KimiLlm extends OpenAiCompatibleLlm {
  /** Any model: "kimi-*" in a YAML config routes here after registration. */
  static readonly supportedModels: Array<string | RegExp> = [/^kimi-.+/];

  /** `apiKey` defaults to MOONSHOT_API_KEY; `baseUrl` to MOONSHOT_BASE_URL, else https://api.moonshot.ai/v1. */
  constructor({ model, apiKey, baseUrl }: { model: string; apiKey?: string; baseUrl?: string }) {
    super(new KimiAdapter({ model, apiKey, baseUrl }), { model });
  }
}

// ── Registration helper ───────────────────────────────────────────────────────

/** Registers KimiLlm with the ADK LLMRegistry (called when MOONSHOT_API_KEY is set). */
export function registerKimiLlm(): void {
  LLMRegistry.register(KimiLlm);
}
