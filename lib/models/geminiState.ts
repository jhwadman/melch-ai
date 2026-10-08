/**
 * lib/models/geminiState.ts — the ids Gemini's provider-opaque state is
 * written under (ADR 0046), in one place.
 *
 * WHY: three modules write or replay a Gemini `thoughtSignature` as
 * `providerState`: the genai mapping (lib/models/genaiMapping.ts), the
 * engine's own Gemini adapter (lib/models/geminiAdapter.ts) and the wrapper
 * over ADK's Gemini (lib/models/adkGeminiAdapter.ts). A reader replays only
 * the provider and kind it wrote (`providerStateOf`), so the three must spell
 * them the same. Each re-exports these names where they were exported before.
 *
 * A leaf with no imports, so the Gemini adapter takes the ids without the
 * mapping, whose import graph names ADK's types.
 */

/** The provider id the Gemini adapters report, and write their state under (lib/models/providerMap.ts). */
export const GEMINI_PROVIDER = 'gemini';

/** The providerState kind for a Gemini thought signature; the payload is the signature. */
export const THOUGHT_SIGNATURE_KIND = 'thought_signature';
