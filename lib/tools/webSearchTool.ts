/**
 * lib/tools/webSearchTool.ts — provider-agnostic web search.
 *
 * WHY this file exists:
 *   ADK's built-in GOOGLE_SEARCH tool is Gemini grounding — it THROWS for any
 *   non-Gemini model. But every cloud provider this framework routes to has
 *   its own native web search: Gemini grounding, Anthropic's web_search
 *   server tool, OpenAI's Responses web_search tool, xAI's web_search server
 *   tool.
 *   Declaring `web_search` in an agent's YAML tools list routes to whichever
 *   of those the agent's model supports — the YAML stays model-agnostic.
 *
 * HOW IT WORKS:
 *   ADK calls processLlmRequest() on every tool while building the request,
 *   with llmRequest.model already set (LlmAgent resolves the model first).
 *   - Gemini model  → push { googleSearch: {} } into config.tools, exactly
 *     what ADK's own GoogleSearchTool does for Gemini 2+.
 *   - Anything else → self-register in llmRequest.toolsDict as a sentinel.
 *     _getDeclaration() returns undefined, so the sentinel is never sent as
 *     a client-side function tool; each provider adapter calls
 *     wantsWebSearch(llmRequest) and enables its provider's NATIVE search
 *     (Claude: web_search server tool; GPT: Responses web_search; Grok:
 *     Agent Tools web_search). Models with no native search (local Ollama) omit
 *     the tool and warn — local mode stays keyless by design.
 *
 *   `google_search` remains available as the Gemini-only ADK tool for
 *   backward compatibility; new YAMLs should declare `web_search`.
 */

import { BaseTool } from '../adkPeer.ts';
import type { LlmRequest } from '@google/adk';

import { providerForModel } from '../models/providerMap.ts';
import { WEB_SEARCH_MARKER } from './nativeTools.ts';
import { NATIVE_TOOL, nativeToolMarkerOf } from './tool.ts';

export const WEB_SEARCH_TOOL_NAME = 'web_search';

/** The ADK runtime's form of WEB_SEARCH_MARKER (lib/tools/nativeTools.ts), carrying its marker. */
export class WebSearchTool extends BaseTool {
  readonly [NATIVE_TOOL] = WEB_SEARCH_MARKER[NATIVE_TOOL];

  constructor() {
    super({ name: WEB_SEARCH_TOOL_NAME, description: WEB_SEARCH_MARKER.description });
  }

  /** Never a client-side function tool — providers run search server-side. */
  _getDeclaration(): undefined {
    return undefined;
  }

  /** Server-side tool: nothing to execute locally. */
  async runAsync(): Promise<unknown> {
    return Promise.resolve();
  }

  async processLlmRequest({ llmRequest }: { llmRequest: LlmRequest }): Promise<void> {
    if (!llmRequest.model) return;

    if (providerForModel(llmRequest.model) === 'gemini') {
      // Native Gemini grounding — same wire shape ADK's GoogleSearchTool
      // emits for Gemini 2+ (we can't reuse that class: it throws for
      // non-Gemini models, and this tool must never throw on routing).
      llmRequest.config = llmRequest.config ?? {};
      llmRequest.config.tools = llmRequest.config.tools ?? [];
      (llmRequest.config.tools as unknown[]).push({ googleSearch: {} });
      return;
    }

    // Non-Gemini: leave a sentinel for the provider adapter. Safe because
    // _getDeclaration() is undefined — ADK's appendTools never adds this
    // to the function-tool declarations sent to the model.
    llmRequest.toolsDict[WEB_SEARCH_TOOL_NAME] = this;
  }
}

/** Shared instance, mirroring ADK's GOOGLE_SEARCH constant pattern. */
export const WEB_SEARCH = new WebSearchTool();

/** True when the agent requested web search (non-Gemini sentinel path), by marker. */
export function wantsWebSearch(llmRequest: LlmRequest): boolean {
  return isWebSearchSentinel(llmRequest.toolsDict?.[WEB_SEARCH_TOOL_NAME]);
}

/** True for toolsDict entries adapters must NOT send as function tools: the web_search marker, on either form. */
export function isWebSearchSentinel(tool: unknown): boolean {
  return nativeToolMarkerOf(tool) === 'web_search';
}

// ── xAI-only server-side constraints ─────────────────────────────────────────
//
// xAI's web_search domain filters (XAI_WEB_SEARCH_ALLOWED_DOMAINS /
// XAI_WEB_SEARCH_EXCLUDED_DOMAINS) are read in lib/tools/xaiSearchParams.ts,
// which imports nothing, so GrokAdapter reaches no @google/adk. Re-exported
// here under the old name.

export { xaiWebSearchParamsFromEnv } from './xaiSearchParams.ts';
