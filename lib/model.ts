/**
 * lib/model.ts — the `melchizedek-agents/model` entry: the engine's model
 * layer on its own, with no @google/adk (ADR 0068).
 *
 * What it holds: the model contract's types (ADR 0048), every provider's
 * contract adapter, resolveAdapter and resolveAdapterWithFallback over the
 * one prefix table (ADR 0060), FallbackAdapter and the circuit breaker's
 * helpers (ADR 0044). A consumer can call any model through it without
 * installing ADK, the peer dependency the rest of the package needs.
 *
 * What it leaves out, because each loads ADK: AdkGeminiAdapter, the ADK
 * shims (ClaudeLlm, GptLlm and the rest), TracedGemini, resolveModel and
 * registerAvailableProviders. They stay at `melchizedek-agents/models/*`.
 *
 * Gemini: resolveAdapter here returns the engine's GeminiAdapter for a
 * Gemini id. Asking for `adk` (the option, or GEMINI_ADAPTER=adk) throws and
 * names `melchizedek-agents/models/registry`, whose resolveAdapter keeps
 * ADR 0060's default until gate G3.
 *
 * tests/packageSurface.test.ts walks this module's runtime import graph and
 * fails if any module in it names @google/adk.
 */

// ── The contract ────────────────────────────────────────────────────────────
export type * from './models/contract.ts';

// ── Resolve an adapter by model id ──────────────────────────────────────────
export { resolveAdapter, resolveAdapterWithFallback, geminiAdapterSetting } from './models/adapterResolver.ts';
export type { GeminiAdapterChoice, ResolveAdapterOptions } from './models/adapterResolver.ts';
export { PROVIDERS, providerForModel, providerKeyPresent } from './models/providerMap.ts';
export type { ProviderId } from './models/providerMap.ts';
export type { Platform, ProviderEndpoint } from './models/endpoints.ts';

// ── The adapters ────────────────────────────────────────────────────────────
export { ClaudeAdapter } from './models/claudeAdapter.ts';
export type { ClaudeAdapterOptions } from './models/claudeAdapter.ts';
export { GptAdapter } from './models/gptAdapter.ts';
export type { GptAdapterOptions } from './models/gptAdapter.ts';
export { GrokAdapter } from './models/grokAdapter.ts';
export type { GrokAdapterOptions } from './models/grokAdapter.ts';
export { ChatCompletionsAdapter } from './models/chatCompletionsAdapter.ts';
export type { ChatCompletionsAdapterOptions } from './models/chatCompletionsAdapter.ts';
export { KimiAdapter } from './models/kimiAdapter.ts';
export type { KimiAdapterOptions } from './models/kimiAdapter.ts';
export { OllamaAdapter } from './models/ollamaAdapter.ts';
export type { OllamaAdapterOptions } from './models/ollamaAdapter.ts';
export { GatewayAdapter } from './models/gatewayAdapter.ts';
export type { GatewayAdapterOptions } from './models/gatewayAdapter.ts';
export { GeminiAdapter } from './models/geminiAdapter.ts';
export type { GeminiAdapterOptions } from './models/geminiAdapter.ts';

// ── Fallback and the circuit breaker ────────────────────────────────────────
export { FallbackAdapter, isProviderError } from './models/fallbackAdapter.ts';
export type { FallbackAdapterOptions } from './models/fallbackAdapter.ts';
export { breakerSettings, circuitOpen, recordFailure, recordSuccess, resetCircuits } from './models/circuitBreaker.ts';
