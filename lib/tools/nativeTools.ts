/**
 * lib/tools/nativeTools.ts — the server-side tools as the engine's own
 * markers (ADR 0062).
 *
 * WHY this file exists:
 *   web_search, x_search, url_context and collections_search are run by the
 *   provider, not here: the model asks its own vendor to search or read, and
 *   the answer arrives inside the model's response. Each was an ADK BaseTool
 *   that declared nothing and left itself in the request for the adapter to
 *   find. The native runtime needs them without ADK, so each is first a
 *   NativeToolMarker (lib/tools/tool.ts): a name, a description for a reader,
 *   and the NativeTool it stands for. A marker declares no function; a
 *   request carries it in `nativeTools`, and each adapter adds its
 *   provider's tool object or drops it (lib/models/capabilities.ts).
 *
 *   The ADK runtime keeps its sentinels (lib/tools/webSearchTool.ts and its
 *   siblings), which carry the same marker symbol, so every reader
 *   (nativeToolOf in lib/models/schemaNormalize.ts) recognises both by
 *   marker. lib/tools/adkTool.ts turns a marker into its sentinel
 *   (toAdkNativeTool). google_search is ADK's own GOOGLE_SEARCH on that
 *   runtime, recognised by ADK's marker.
 *
 *   Code execution is not here: it is an agent's `code_execution: gemini`,
 *   not a tool it lists, and reaches the request as the agent's code
 *   executor.
 *
 * A LEAF: nothing in its import graph names @google/*.
 */

import { nativeToolMarker } from './tool.ts';

/** The provider's own web search: Gemini grounding, Anthropic, OpenAI, xAI. */
export const WEB_SEARCH_MARKER = nativeToolMarker(
  'web_search',
  "Web search via the agent model's native search capability " +
    '(Gemini grounding / Anthropic web_search / OpenAI web_search / xAI web_search).',
);

/** xAI's live search over X posts. */
export const X_SEARCH_MARKER = nativeToolMarker(
  'x_search',
  'Live search over X (Twitter) posts via xAI Agent Tools — ' +
    'grok-* models only; a no-op sentinel on every other provider.',
);

/** Gemini reads the pages at URLs in the conversation. */
export const URL_CONTEXT_MARKER = nativeToolMarker(
  'url_context',
  'Gemini reads the pages at URLs in the conversation (server-side).',
);

/** xAI's semantic search over hosted document collections. */
export const COLLECTIONS_SEARCH_MARKER = nativeToolMarker(
  'collections_search',
  'Semantic search over xAI Collections (hosted document stores) via ' +
    'Agent Tools — grok-* models only; a no-op sentinel on every other ' +
    'provider. Collections are selected by XAI_COLLECTION_IDS.',
);

/** Gemini grounding, kept for YAMLs that name it. */
export const GOOGLE_SEARCH_MARKER = nativeToolMarker('google_search', 'Gemini grounding with Google Search.');
