/**
 * lib/model.ts — the `melchizedek-agents/model` entry: the engine's model
 * layer on its own (ADR 0068).
 *
 * What it holds: the model contract's types (ADR 0048), every provider's
 * contract adapter, resolveAdapter and resolveAdapterWithFallback over the
 * one prefix table (ADR 0060), FallbackAdapter and the circuit breaker's
 * helpers (ADR 0044). A consumer can call any model through it without
 * loading the compiler or the runtime.
 *
 * Gemini: resolveAdapter returns the engine's GeminiAdapter for a Gemini id;
 * GEMINI_ADAPTER=adk throws, naming 1.0.0 (ADR 0107).
 *
 * tests/packageSurface.test.ts walks this module's runtime import graph:
 * @google/* appears in it only in the Gemini adapter and the genai mapping.
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
export { DeepSeekAdapter } from './models/deepseekAdapter.ts';
export type { DeepSeekAdapterOptions } from './models/deepseekAdapter.ts';
// TypeSafe Jev, a decision model: the adapter, and the typed System One call under it (ADR 0144).
export { JevAdapter } from './models/jevAdapter.ts';
export type { JevAdapterOptions } from './models/jevAdapter.ts';
export { JevError, choice, decide, noul, objectFromAnswers, questionsFromSchema, score } from './models/jev.ts';
export type { JevAnswer, JevAnswerFor, JevAnswers, JevChoice, JevChoiceAnswer, JevEndpoint, JevNoul, JevNoulAnswer, JevQuestion, JevQuestions, JevRequest, JevResponse, JevScore, JevScoreAnswer, JevState } from './models/jev.ts';
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
