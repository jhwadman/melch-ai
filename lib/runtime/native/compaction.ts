/**
 * lib/runtime/native/compaction.ts — context compaction on the native loop:
 * the YAML's `context:` block, run as ADK ran it (ADR 0033, ADR 0045).
 *
 * WHY this file exists:
 *   Under ADK `context:` compiled to ADK's TokenBasedContextCompactor with
 *   an LlmSummarizer, which ADK's ContextCompactorRequestProcessor ran
 *   before every model step of the agent. A session ADK wrote must be one
 *   the loop continues, so this is that compactor and that summarizer, rule
 *   for rule (context/token_based_context_compactor.js,
 *   context/compaction_utils.js and context/summarizers/llm_summarizer.js in
 *   Google ADK 2.2), and the event it stores is the one ADK stored:
 *
 *   - WHEN. Before each model step, over the session's active events (the
 *     latest compaction and what follows it, in the run's isolation scope).
 *     The raw events (compactions aside) must number more than
 *     `keep_recent_events`, and the cut must leave something to summarize:
 *     the cut starts `keep_recent_events` from the end and moves back while
 *     it would separate a call from its answer. Then the prompt size must
 *     pass `compact_after_tokens`: the latest active event's
 *     usageMetadata.promptTokenCount, or, when no event carries one, the
 *     characters of the agent's projected history (text, and each call and
 *     answer as JSON) divided by 4, rounded up.
 *   - WHAT IS SUMMARIZED. The raw events before the cut, after the active
 *     compaction when there is one, so a later summary folds the earlier in.
 *   - THE CALL. One user message: ADK's default prompt, a blank line, then
 *     per event `[Event i - Author: <author>]`, its text (thoughts aside) and
 *     a blank line. No system prompt, no tools, not streamed. It goes to
 *     `summary_model` (default the agent's own model), as a leaf adapter
 *     with no fallback, through traceLlmGeneration: the
 *     llm.request span, under the agent span and outside any model.call,
 *     and the turn's charge (ADR 0053, ADR 0076). The summary is the first
 *     response's first part's text and each later response's; a first
 *     response with no text throws "LLM failed to return a valid summary.",
 *     as ADK does, and the turn fails.
 *   - THE EVENT. author `system`, no invocation id, content `{ role: model,
 *     parts: [{ text: summary }] }`, `isCompacted: true`, `startTime` and
 *     `endTime` (the first and last summarized events' timestamps),
 *     `compactedContent`, and the run's isolation scope. The loop appends it
 *     before the step, so the step's request already reads it: the history
 *     builder (lib/runtime/native/history.ts) puts
 *     "[Previous Context Summary]:\n<summary>" in place of the events up to
 *     `endTime`. The full history stays stored.
 *
 * NOT PORTED: ADK's before/after context-compaction plugin hooks. No plugin
 * the engine installs implements them.
 */

import type { LlmRequest, LlmResponse } from '../../models/genaiMapping.ts';

import type { ModelAdapter, ModelRequest } from '../../models/contract.ts';
import { llmRequestToModelRequest, modelResponseToLlmResponse } from '../../models/genaiMapping.ts';
import { traceLlmGeneration } from '../../observability/tracer.ts';
import { createTurnEvent, getFunctionCalls, getFunctionResponses } from '../events.ts';
import type { TurnEvent } from '../events.ts';
import type { Session } from '../sessions.ts';
import { activeEvents, contentsOf, isCompacted } from './history.ts';
import type { CompactedEvent } from './history.ts';

/** An agent's `context:` block, in the YAML's spelling (ADR 0033). */
export interface ContextConfig {
  /** Compact when the last request's prompt passed this many tokens. */
  compact_after_tokens: number;
  /** Events kept verbatim after the summary. Default 6. */
  keep_recent_events?: number;
  /** The model that writes the summary. Default: the agent's own. */
  summary_model?: string;
}

export const DEFAULT_KEEP_RECENT_EVENTS = 6;

/** ADK's LlmSummarizer default prompt, which compile's summarizer uses. */
export const SUMMARY_PROMPT =
  'The following is a conversation history between a user and an AI agent. Please summarize the conversation, focusing on key information and decisions made, as well as any unresolved questions or tasks. The summary should be concise and capture the essence of the interaction.';

/** ADK's message when the summarizer's first response has no text. */
export const SUMMARY_FAILED = 'LLM failed to return a valid summary.';

const CHARS_PER_TOKEN = 4;

/** Where the agent stands when it compacts. */
export interface CompactionScope {
  agentName: string;
  session: Session;
  branch?: string;
  isolationScope?: string;
}

// ── When (ADK's shouldCompact) ───────────────────────────────────────────────

/** Where the verbatim tail starts: `keep` from the end, moved back so no answer loses its call. */
export function retainStartIndex(raw: readonly TurnEvent[], keep: number): number {
  let start = Math.max(0, raw.length - keep);
  while (start > 0) {
    if (getFunctionResponses(raw[start] as TurnEvent).length > 0 && getFunctionCalls(raw[start - 1] as TurnEvent).length > 0) start--;
    else break;
  }
  return start;
}

/** The latest prompt token count an active event carries, else the estimate from the projected history. */
function promptTokens(active: readonly TurnEvent[], scope: CompactionScope): number | undefined {
  for (let i = active.length - 1; i >= 0; i--) {
    const count = active[i]?.usageMetadata?.promptTokenCount;
    if (count !== undefined) return count;
  }
  // ADK estimates from getContents with no isolation scope: scoped events count for nothing here.
  let chars = 0;
  for (const content of contentsOf(active, scope.agentName, scope.branch, undefined)) {
    for (const part of content.parts ?? []) {
      if (part.text) chars += part.text.length;
      if (part.functionCall) chars += JSON.stringify(part.functionCall).length;
      if (part.functionResponse) chars += JSON.stringify(part.functionResponse).length;
    }
  }
  return chars <= 0 ? undefined : Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * The events a compaction would summarize now (the active compaction first,
 * when there is one), or undefined when the agent should not compact.
 */
export function eventsToCompact(config: ContextConfig, scope: CompactionScope): TurnEvent[] | undefined {
  const keep = config.keep_recent_events ?? DEFAULT_KEEP_RECENT_EVENTS;
  const active = activeEvents(scope.session.events, scope.isolationScope);
  const raw = active.filter((e) => !isCompacted(e));
  if (raw.length <= keep) return undefined;
  const start = retainStartIndex(raw, keep);
  if (start === 0) return undefined;
  const tokens = promptTokens(active, scope);
  if (tokens === undefined || tokens <= config.compact_after_tokens) return undefined;
  const present = active.find(isCompacted);
  const cut = raw.slice(0, start);
  return present ? [present, ...cut] : cut;
}

// ── The summary (ADK's LlmSummarizer) ────────────────────────────────────────

/** An event's text, thoughts aside (ADK's stringifyContent). */
function textOf(event: TurnEvent): string {
  const parts = event.content?.parts;
  if (!parts) return '';
  return parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
}

/** The one request the summarizer sends, as genaiMapping maps the genai-shaped request for it. */
export function summaryRequest(events: readonly TurnEvent[], model: string, signal?: AbortSignal): ModelRequest {
  let formatted = '';
  events.forEach((event, i) => {
    formatted += `[Event ${i + 1} - Author: ${event.author}]\n`;
    formatted += `${textOf(event)}\n\n`;
  });
  const llmRequest = {
    contents: [{ role: 'user', parts: [{ text: `${SUMMARY_PROMPT}\n\n${formatted}` }] }],
    toolsDict: {},
    liveConnectConfig: {},
  } as unknown as LlmRequest;
  return llmRequestToModelRequest(llmRequest, { model, stream: false, ...(signal ? { signal } : {}) });
}

/**
 * Summarizes `events` with `adapter` under `model` and returns the
 * compacted event (not stored). Charged and traced as one model call.
 * Throws SUMMARY_FAILED when the first response carries no text.
 */
export async function summarize(
  events: readonly TurnEvent[],
  adapter: ModelAdapter,
  model: string,
  options: { signal?: AbortSignal; isolationScope?: string } = {},
): Promise<CompactedEvent> {
  if (events.length === 0) throw new Error('Cannot summarize an empty list of events.');
  const startTime = (events[0] as TurnEvent).timestamp;
  const endTime = (events[events.length - 1] as TurnEvent).timestamp;
  const request = summaryRequest(events, model, options.signal);
  async function* inner(): AsyncGenerator<LlmResponse, void> {
    for await (const response of adapter.generate(request)) yield modelResponseToLlmResponse(response);
  }
  const responses = traceLlmGeneration({ provider: adapter.provider, model, request }, inner());
  // As ADK: the first response must carry text; nothing after a failure is read.
  const first = await responses.next();
  const head = first.done ? undefined : first.value.content?.parts?.[0]?.text;
  if (!head) throw new Error(SUMMARY_FAILED);
  let summary = head;
  for await (const chunk of responses) {
    const text = chunk.content?.parts?.[0]?.text;
    if (text) summary += text;
  }
  const event: CompactedEvent = {
    ...createTurnEvent({ author: 'system', content: { role: 'model', parts: [{ text: summary }] } }),
    isCompacted: true,
    startTime,
    endTime,
    compactedContent: summary,
  };
  if (options.isolationScope !== undefined) event.isolationScope = options.isolationScope;
  return event;
}

// ── The loop's hook ──────────────────────────────────────────────────────────

/**
 * Before a model step: the compacted event when the agent's `context:` says
 * to compact now, else undefined. The caller stores it before the step.
 */
export async function compactBeforeStep(
  agent: { name: string; model: string; context?: ContextConfig },
  scope: Omit<CompactionScope, 'agentName'> & { adapterFor: (model: string) => ModelAdapter; signal?: AbortSignal },
): Promise<CompactedEvent | undefined> {
  if (!agent.context) return undefined;
  const events = eventsToCompact(agent.context, { ...scope, agentName: agent.name });
  if (!events) return undefined;
  const model = agent.context.summary_model ?? agent.model;
  return summarize(events, scope.adapterFor(model), model, {
    ...(scope.signal ? { signal: scope.signal } : {}),
    ...(scope.isolationScope !== undefined ? { isolationScope: scope.isolationScope } : {}),
  });
}
