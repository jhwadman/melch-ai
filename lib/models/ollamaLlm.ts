/**
 * lib/models/ollamaLlm.ts — open-weight / local models served by Ollama, as
 * an ADK BaseLlm for the LLMRegistry.
 *
 * WHY this file exists:
 *   The provider's work is OllamaAdapter (lib/models/ollamaAdapter.ts), on
 *   the engine's own model contract; its header says how to install Ollama,
 *   which model to pull, and what a local model cannot do. ADK still runs
 *   every turn, so this class runs the adapter under ADK: it is the
 *   chat-completions shim (lib/models/openAiCompatibleLlm.ts, ADR 0057),
 *   registered for any `ollama/<model>` id. The constructor and
 *   supportedModels are what they were before the adapter moved onto the
 *   contract, so lib/models/registry.ts and every caller are unchanged.
 */

import { requireAdk } from '../adkPeer.ts';

import { OllamaAdapter } from './ollamaAdapter.ts';
import { OpenAiCompatibleLlm } from './openAiCompatibleLlm.ts';

// ── OllamaLlm ─────────────────────────────────────────────────────────────────

export class OllamaLlm extends OpenAiCompatibleLlm {
  /**
   * Model ids namespaced "ollama/<model>" route here after registration,
   * e.g. model: "ollama/qwen3:8b" in a syndicate YAML.
   */
  static readonly supportedModels: Array<string | RegExp> = [/^ollama\/.+/];

  /** `baseUrl` defaults to OLLAMA_BASE_URL, else http://localhost:11434/v1. */
  constructor({ model, baseUrl }: { model: string; baseUrl?: string }) {
    super(new OllamaAdapter({ model, baseUrl }), { model });
  }
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers OllamaLlm with the ADK LLMRegistry.
 *
 * Unlike registerClaudeLlm(), this needs no key gate — a local provider has
 * no credential to check. Registration is still explicit (not at import
 * time) so entrypoints stay in control of which providers are active.
 * If Ollama isn't running, agents fail at call time with a clear
 * OLLAMA_UNREACHABLE message that says how to start it.
 */
export function registerOllamaLlm(): void {
  requireAdk("Registering a model class with ADK's LLMRegistry").LLMRegistry.register(OllamaLlm);
}
