/**
 * lib/models/geminiState.ts — the ids Gemini's provider-opaque state is
 * written under (ADR 0046), and the prefix of a call id the genai mapping
 * mints, in one place.
 *
 * WHY: two modules write or replay a Gemini `thoughtSignature` as
 * `providerState`: the genai mapping (lib/models/genaiMapping.ts) and the
 * engine's Gemini adapter (lib/models/geminiAdapter.ts). A reader replays
 * only the provider and kind it wrote (`providerStateOf`), so the two must
 * spell them the same. Each re-exports these names where they were exported
 * before.
 *
 * A leaf with no imports, so a module takes the ids without the mapping and
 * its @google/genai import graph.
 */

/** The provider id the Gemini adapters report, and write their state under (lib/models/providerMap.ts). */
export const GEMINI_PROVIDER = 'gemini';

/** The providerState kind for a Gemini thought signature; the payload is the signature. */
export const THOUGHT_SIGNATURE_KIND = 'thought_signature';

/**
 * The thought signature Gemini documents for a function call that has no
 * real one. Gemini 3 rejects a current-turn function call without a
 * signature; this value passes its validator (ADR 0065).
 */
export const PLACEHOLDER_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/**
 * The providerState kind the Gemini adapter writes for the Gemini parts the
 * contract has no type for (code execution, server-side invocations),
 * carried whole on the next output part (ADR 0065). The payload is
 * `{ before: <the genai parts>, signature?: <the part's own signature> }`.
 * The genai mapping writes them back out as the parts they were (ADR 0100).
 */
export const CARRIED_PARTS_KIND = 'carried_parts';

/**
 * The providerState kind the genai mapping writes for a genai part the
 * contract cannot hold exactly; the payload is the part, verbatim.
 */
export const GENAI_PART_KIND = 'genai_part';

/** A Gemini part the contract has no type for and Gemini wants back within the turn: code execution, a server-side invocation. */
export function isCarriedWirePart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const p = part as Record<string, unknown>;
  return p.executableCode !== undefined || p.codeExecutionResult !== undefined || p.toolCall !== undefined || p.toolResponse !== undefined;
}

/**
 * The prefix of an id the genai mapping (lib/models/genaiMapping.ts) made
 * for a call or result that had none. Such an id never goes on the wire: the
 * mapping leaves it off, and so does the Gemini adapter.
 */
export const MINTED_CALL_ID_PREFIX = 'genai-noid-';
