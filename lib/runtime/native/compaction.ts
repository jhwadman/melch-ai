/**
 * lib/runtime/native/compaction.ts — context compaction on the native loop:
 * the YAML's `context:` block (ADR 0033, ADR 0153).
 *
 * WHY this file exists:
 *   A long conversation must not overflow the model's window, and what the
 *   summary keeps decides what the agent still knows. The when and the
 *   stored event are ADK's (ADR 0078), so a session ADK compacted reads on;
 *   the summary itself is the engine's own (ADR 0153):
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
 *     answer as JSON) divided by 4, rounded up. No `compact_after_tokens`,
 *     no compaction.
 *   - WHAT IS SUMMARIZED. The raw events before the cut, after the active
 *     compaction when there is one. The summary is anchored: the summarizer
 *     reads the previous summary and the newly cut span only, never the
 *     whole history again, and updates the summary rather than rewriting
 *     it from scratch.
 *   - THE CALL. A system prompt that is the same every time
 *     (SUMMARY_INSTRUCTION: the six sections, the rules, the word budget)
 *     and one user message: the previous summary under its heading when
 *     there is one, then the span, per event `[Event i - Author: <author>]`
 *     with its text (thoughts aside), each tool call as JSON and each tool
 *     result's text cut at RESULT_RENDER_CHARS. No tools, not streamed,
 *     output capped at SUMMARY_MAX_TOKENS. It goes to `summary_model`
 *     (default the agent's own model), as a leaf adapter with no fallback,
 *     through traceLlmGeneration: the llm.request span, under the agent
 *     span and outside any model.call, and the turn's charge (ADR 0053,
 *     ADR 0076).
 *   - FAILURE. A summary with no text, an error, or one past the word
 *     budget by half again is not stored: the step runs uncompacted, the
 *     reason goes to the log and the agent span (`compaction.skipped`), and
 *     the next step tries again. The turn never fails for its housekeeping.
 *   - THE EVENT. author `system`, no invocation id, content `{ role: model,
 *     parts: [{ text: summary }] }`, `isCompacted: true`, `startTime` and
 *     `endTime` (the first and last summarized events' timestamps),
 *     `compactedContent`, `summaryFormat: 'sections/1'`, and the run's
 *     isolation scope. The loop appends it before the step, so the step's
 *     request already reads it: the history builder
 *     (lib/runtime/native/history.ts) puts
 *     "[Previous Context Summary]:\n<summary>" in place of the events up to
 *     `endTime`. The full history stays stored.
 */

import { trace } from '@opentelemetry/api';

import type { LlmRequest, LlmResponse } from '../../models/genaiMapping.ts';

import type { ModelAdapter, ModelRequest, ModelResponse } from '../../models/contract.ts';
import { llmRequestToModelRequest, modelResponseToLlmResponse } from '../../models/genaiMapping.ts';
import { traceLlmGeneration } from '../../observability/tracer.ts';
import { createTurnEvent } from '../events.ts';
import type { TurnEvent } from '../events.ts';
import type { Session } from '../sessions.ts';
import { DEFAULT_KEEP_RECENT_EVENTS, activeEvents, contentsOf, isCompacted, retainStartIndex } from './history.ts';
import type { CompactedEvent } from './history.ts';

export { DEFAULT_KEEP_RECENT_EVENTS, retainStartIndex };

/** An agent's `context:` block, in the YAML's spelling (ADR 0033, ADR 0152). */
export interface ContextConfig {
  /** Compact when the last request's prompt passed this many tokens. Unset: no compaction. */
  compact_after_tokens?: number;
  /** Events kept verbatim after the summary, and before masking. Default 6. */
  keep_recent_events?: number;
  /** The model that writes the summary. Default: the agent's own. */
  summary_model?: string;
  /** A tool result older than the verbatim tail and longer than this becomes a stub (ADR 0152). Default 1,000; 0 masks none. */
  mask_over_chars?: number;
}

/** The summary's sections, every one present even when empty. */
export const SUMMARY_SECTIONS = ['Intent', 'Stated facts', 'Decisions', 'Artifacts', 'Open', 'Last state'] as const;

/** Words the summary stays under; one past it by half again is not stored. */
export const SUMMARY_WORD_BUDGET = 1_200;
/** The summarizer's output cap, in tokens. */
export const SUMMARY_MAX_TOKENS = 2_048;
/** A tool result's text, as the summarizer reads it, is cut here. */
export const RESULT_RENDER_CHARS = 2_000;
/** The stored event's format mark (ADR 0153). */
export const SUMMARY_FORMAT = 'sections/1';

/** The heading the previous summary sits under in the summarizer's input. */
export const PREVIOUS_SUMMARY_HEADING = '# Previous summary';
/** The heading the newly cut span sits under. */
export const NEW_EVENTS_HEADING = '# New events';

/** The summarizer's system prompt: the same words every call, so its own prefix caches. */
export const SUMMARY_INSTRUCTION = `You maintain the running summary of a conversation between a person and an AI agent, so the agent can continue the conversation when the earlier turns are no longer in its context.

You are given the previous summary, when there is one, and the events since it. Write the updated summary: fold the new events into the previous summary. Keep every item that is still true. When a new event supersedes an item, keep the item and mark it "(superseded: <what replaced it>)". Add nothing the events do not say. Write nothing about yourself.

Use exactly these six sections, each as a "## " heading, in this order, every one present even when empty ("(none)"):

## Intent
What the person is trying to get done, in their words where possible.
## Stated facts
What the person asserted about themselves or their situation: values with their units as stated, names, dates as absolute dates.
## Decisions
What was decided, by whom, and what it replaced.
## Artifacts
Files, paths, URLs, identifiers, and tool results worth reading again, each with its handle: the path, the URL, the id, or the tool call that produced it.
## Open
Unresolved questions, pending tasks, and what the person asked for that has not been delivered.
## Last state
Where the conversation stood at the last event: what was just asked or answered.

Stay under ${SUMMARY_WORD_BUDGET} words. Plain text and these headings only.`;

/** Why a compaction was skipped (the log and the `compaction.skipped` span event). */
export const SUMMARY_FAILED = 'the summary model returned no text';
export const SUMMARY_OVER_BUDGET = `the summary ran past ${Math.floor(SUMMARY_WORD_BUDGET * 1.5)} words`;

const CHARS_PER_TOKEN = 4;

/** Where the agent stands when it compacts. */
export interface CompactionScope {
  agentName: string;
  session: Session;
  branch?: string;
  isolationScope?: string;
}

// ── When (ADK's shouldCompact) ───────────────────────────────────────────────

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
  if (config.compact_after_tokens === undefined) return undefined;
  const keep = config.keep_recent_events ?? DEFAULT_KEEP_RECENT_EVENTS;
  const active = activeEvents(scope.session.events, scope.isolationScope);
  const raw = active.filter((e) => !isCompacted(e));
  if (raw.length <= keep) return undefined;
  const start = retainStartIndex(raw, keep);
  if (start === 0) return undefined;
  const tokens = promptTokens(active, scope);
  if (tokens === undefined || tokens <= (config.compact_after_tokens as number)) return undefined;
  const present = active.find(isCompacted);
  const cut = raw.slice(0, start);
  return present ? [present, ...cut] : cut;
}

// ── The summary (ADR 0153) ───────────────────────────────────────────────────

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** A tool result's text as the summarizer reads it: cut at RESULT_RENDER_CHARS, saying so. */
function renderResult(value: unknown): string {
  const text = stringify(value);
  return text.length <= RESULT_RENDER_CHARS ? text : `${text.slice(0, RESULT_RENDER_CHARS)}… [${text.length} characters; cut]`;
}

/** One event as the summarizer reads it: its text (thoughts aside), each call as JSON, each result cut. */
export function renderEvent(event: TurnEvent): string {
  const lines: string[] = [];
  for (const part of event.content?.parts ?? []) {
    if (part.thought) continue;
    if (part.text) lines.push(part.text);
    if (part.functionCall) lines.push(`[called ${part.functionCall.name ?? 'tool'} with ${stringify(part.functionCall.args ?? {})}]`);
    if (part.functionResponse) lines.push(`[${part.functionResponse.name ?? 'tool'} returned: ${renderResult(part.functionResponse.response)}]`);
  }
  return lines.join('\n');
}

/**
 * The summarizer's user message: the previous summary under its heading
 * (the active compaction, when `events` starts with one), then the new
 * events, each `[Event i - Author: <author>]` and its rendering.
 */
export function summaryInput(events: readonly TurnEvent[]): string {
  const [first, ...rest] = events;
  const previous = first && isCompacted(first) ? first : undefined;
  const span = previous ? rest : events;
  let text = '';
  if (previous) text += `${PREVIOUS_SUMMARY_HEADING}\n${previous.compactedContent ?? ''}\n\n`;
  text += `${NEW_EVENTS_HEADING}\n\n`;
  span.forEach((event, i) => {
    text += `[Event ${i + 1} - Author: ${event.author}]\n${renderEvent(event)}\n\n`;
  });
  return text;
}

/** The one request the summarizer sends: the fixed instruction, the input, no tools, a capped output. */
export function summaryRequest(events: readonly TurnEvent[], model: string, signal?: AbortSignal): ModelRequest {
  const llmRequest = {
    contents: [{ role: 'user', parts: [{ text: summaryInput(events) }] }],
    config: { systemInstruction: SUMMARY_INSTRUCTION, maxOutputTokens: SUMMARY_MAX_TOKENS },
    toolsDict: {},
    liveConnectConfig: {},
  } as unknown as LlmRequest;
  return llmRequestToModelRequest(llmRequest, { model, stream: false, ...(signal ? { signal } : {}) });
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/**
 * Summarizes `events` with `adapter` under `model` and returns the
 * compacted event (not stored). Charged and traced as one model call.
 * Throws SUMMARY_FAILED when the response carries no text, and
 * SUMMARY_OVER_BUDGET when it ran past the budget by half again; the
 * loop's hook turns either into a skipped compaction.
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
  const sources = new WeakMap<LlmResponse, ModelResponse>();
  async function* inner(): AsyncGenerator<LlmResponse, void> {
    for await (const response of adapter.generate(request)) {
      const mapped = modelResponseToLlmResponse(response);
      sources.set(mapped, response);
      yield mapped;
    }
  }
  const responses = traceLlmGeneration({ provider: adapter.provider, model, request, source: (r) => sources.get(r) }, inner());
  let summary = '';
  for await (const chunk of responses) {
    if (chunk.errorCode) throw new Error(`${chunk.errorCode}: ${String((chunk as { errorMessage?: unknown }).errorMessage ?? '')}`.trim());
    for (const part of chunk.content?.parts ?? []) if (part.text && !part.thought) summary += part.text;
  }
  summary = summary.trim();
  if (!summary) throw new Error(SUMMARY_FAILED);
  if (wordCount(summary) > SUMMARY_WORD_BUDGET * 1.5) throw new Error(SUMMARY_OVER_BUDGET);
  const event: CompactedEvent = {
    ...createTurnEvent({ author: 'system', content: { role: 'model', parts: [{ text: summary }] } }),
    isCompacted: true,
    startTime,
    endTime,
    compactedContent: summary,
    summaryFormat: SUMMARY_FORMAT,
  };
  if (options.isolationScope !== undefined) event.isolationScope = options.isolationScope;
  return event;
}

// ── The loop's hook ──────────────────────────────────────────────────────────

/**
 * Before a model step: the compacted event when the agent's `context:` says
 * to compact now, else undefined. The caller stores it before the step. A
 * summary that fails is not stored: the reason goes to `log` and to the
 * active span as a `compaction.skipped` event, and the step runs
 * uncompacted. A stopped turn rethrows, as any step would.
 */
export async function compactBeforeStep(
  agent: { name: string; model: string; context?: ContextConfig },
  scope: Omit<CompactionScope, 'agentName'> & { adapterFor: (model: string) => ModelAdapter; signal?: AbortSignal; log?: (message: string) => void },
): Promise<CompactedEvent | undefined> {
  if (!agent.context) return undefined;
  const events = eventsToCompact(agent.context, { ...scope, agentName: agent.name });
  if (!events) return undefined;
  const model = agent.context.summary_model ?? agent.model;
  try {
    return await summarize(events, scope.adapterFor(model), model, {
      ...(scope.signal ? { signal: scope.signal } : {}),
      ...(scope.isolationScope !== undefined ? { isolationScope: scope.isolationScope } : {}),
    });
  } catch (err) {
    if (scope.signal?.aborted) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    scope.log?.(`[compaction] ${agent.name}: skipped, ${reason}; the step runs uncompacted and the next step tries again`);
    trace.getActiveSpan()?.addEvent('compaction.skipped', { 'compaction.model': model, 'compaction.reason': reason.slice(0, 500) });
    return undefined;
  }
}
