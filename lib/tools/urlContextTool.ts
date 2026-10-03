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

export const URL_CONTEXT_TOOL_NAME = 'url_context';

export class UrlContextTool extends BaseTool {
  constructor() {
    super({ name: URL_CONTEXT_TOOL_NAME, description: 'Gemini reads the pages at URLs in the conversation (server-side).' });
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
