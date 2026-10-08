/**
 * lib/tools/urlContextTool.ts — `url_context`: the model reads the pages
 * whose URLs appear in the conversation, server-side, on Gemini.
 *
 * WHY: ADK's URL_CONTEXT is Gemini's built-in URL reading, and it THROWS for
 * any other model, which would fail a mixed-provider syndicate at request
 * time. This is the same tool made safe to declare anywhere, the pattern
 * web_search uses: on a Gemini model it adds `{ urlContext: {} }` to the
 * request; on any other it does nothing, and `npm run doctor` reports it as
 * dropped (lib/models/capabilities.ts). For reading a page on every
 * provider, declare `web_extract` (client-side, SSRF-guarded).
 *
 * Exposure: Google fetches the URLs, not this host, so no address of this
 * deployment's network is reachable through it. Page text arrives as model
 * input; treat it as data, as any fetched page.
 */
import { BaseTool } from '@google/adk';
import type { LlmRequest } from '@google/adk';

import { providerForModel } from '../models/providerMap.ts';
import { URL_CONTEXT_MARKER } from './nativeTools.ts';
import { NATIVE_TOOL } from './tool.ts';

export const URL_CONTEXT_TOOL_NAME = 'url_context';

/** The ADK runtime's form of URL_CONTEXT_MARKER (lib/tools/nativeTools.ts), carrying its marker. */
export class UrlContextTool extends BaseTool {
  readonly [NATIVE_TOOL] = URL_CONTEXT_MARKER[NATIVE_TOOL];

  constructor() {
    super({ name: URL_CONTEXT_TOOL_NAME, description: URL_CONTEXT_MARKER.description });
  }

  /** Never a client-side function tool. */
  _getDeclaration(): undefined {
    return undefined;
  }

  async runAsync(): Promise<unknown> {
    return Promise.resolve();
  }

  async processLlmRequest({ llmRequest }: { llmRequest: LlmRequest }): Promise<void> {
    if (!llmRequest.model || providerForModel(llmRequest.model) !== 'gemini') return;
    llmRequest.config = llmRequest.config ?? {};
    llmRequest.config.tools = llmRequest.config.tools ?? [];
    (llmRequest.config.tools as unknown[]).push({ urlContext: {} });
  }
}

export const URL_CONTEXT = new UrlContextTool();
