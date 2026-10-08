/**
 * lib/models/claudeModels.ts — what each Claude model generation accepts,
 * read from the model id (ADR 0049).
 *
 * WHY this file exists:
 *   The Messages API is one endpoint, but its request surface moved under it.
 *   `thinking: { type: 'enabled', budget_tokens }` is a 400 from Opus 4.7 and
 *   Sonnet 5 on; the current models take adaptive thinking with
 *   `output_config.effort`. Forced `tool_choice` is a 400 on Fable 5.1, Opus
 *   5.5 and Sonnet 5.5. Thinking can be turned off three different ways, or
 *   not at all. Thinking blocks are bound to the conversation on the newest
 *   models. One request shape for every `claude-*` id no longer exists, so
 *   the Claude adapter (lib/models/claudeAdapter.ts) asks this table which shape
 *   a model takes.
 *
 * An id the table does not know, a newer model's, gets the newest row
 * (`CURRENT`): adaptive thinking, no forced tool use, blocks bound to the
 * conversation. Every id that reads as Claude 4.6 or earlier gets the
 * budget row.
 *
 * How hard a request asks Claude to think reaches the table as one
 * `ClaudeReasoning`: from the contract's `reasoning` (claudeReasoningOf),
 * or, on the ADK path, from the agent's generateContentConfig as ADR 0049
 * reads it (claudeReasoningFromConfig, ADR 0055).
 */

import type { ReasoningSetting } from './contract.ts';
import type { Platform } from './endpoints.ts';
import { REASONING_BUDGETS } from './reasoning.ts';

export interface ClaudeGeneration {
  /** The row's name, for docs, spans and tests. */
  name: string;
  /**
   * `budget`: `thinking: { type: 'enabled', budget_tokens }` from
   * thinkingConfig.thinkingBudget. `adaptive`: `thinking: { type: 'adaptive' }`
   * with `output_config.effort`.
   */
  thinking: 'budget' | 'adaptive';
  /** Adaptive rows: a request that omits `thinking` thinks. */
  thinksByDefault: boolean;
  /**
   * How `reasoning: none` turns thinking off: no `thinking` field (budget
   * rows), `{ type: 'disabled' }`, `{ type: 'between_tools' }`, or adaptive
   * thinking at `low` effort where the model has no off switch the engine
   * uses. Every off switch is sent at `low` effort.
   */
  off: 'omit' | 'disabled' | 'between_tools' | 'low_effort';
  /** `tool_choice: { type: 'tool' | 'any' }` is accepted. */
  forcedToolChoice: boolean;
  /** How an outputSchema travels: a forced (or offered) tool, or `output_config.format`. */
  structuredOutput: 'forced_tool' | 'output_format';
  /** `thinking.display` can be set; the adapter asks for `summarized`. */
  display: boolean;
  /** Thinking blocks are bound to the conversation that produced them (preserved thinking). */
  bindsConversation: boolean;
}

const BUDGET: ClaudeGeneration = {
  name: 'budget',
  thinking: 'budget',
  thinksByDefault: false,
  off: 'omit',
  forcedToolChoice: true,
  structuredOutput: 'forced_tool',
  display: false,
  bindsConversation: false,
};

/** Adaptive thinking, off unless asked for; structured outputs are not documented for Opus 4.7. */
const OPUS_4_7: ClaudeGeneration = {
  name: 'opus-4.7',
  thinking: 'adaptive',
  thinksByDefault: false,
  off: 'disabled',
  forcedToolChoice: true,
  structuredOutput: 'forced_tool',
  display: true,
  bindsConversation: false,
};

const OPUS_4_8: ClaudeGeneration = { ...OPUS_4_7, name: 'opus-4.8', structuredOutput: 'output_format' };

const SONNET_5: ClaudeGeneration = { ...OPUS_4_8, name: 'sonnet-5', thinksByDefault: true };

/**
 * Opus 5 accepts `disabled` at `high` effort or below, but Anthropic documents
 * two failure modes for it there (a tool call written as text that never
 * runs, internal tags in the reply), so `none` is adaptive at `low` (ADR 0049).
 */
const OPUS_5: ClaudeGeneration = { ...SONNET_5, name: 'opus-5', off: 'low_effort' };

/** Fable 5 and Mythos 5: thinking is always on. */
const FABLE_5: ClaudeGeneration = { ...OPUS_5, name: 'fable-5' };

/** `disabled` only at `high` effort or below; blocks bound to the conversation. */
const HAIKU_5_5: ClaudeGeneration = { ...SONNET_5, name: 'haiku-5.5', bindsConversation: true };

/** `between_tools` is the off switch (at `high` or below, no other field); forced tool use is a 400. */
const SONNET_5_5: ClaudeGeneration = {
  ...HAIKU_5_5,
  name: 'sonnet-5.5',
  off: 'between_tools',
  forcedToolChoice: false,
};

/** Opus 5.5, Fable 5.1, Mythos 5.1, and any id the table does not know. */
const CURRENT: ClaudeGeneration = {
  ...SONNET_5_5,
  name: 'current',
  off: 'low_effort',
};

/** family-major[-minor], e.g. claude-opus-5-5, claude-sonnet-4-5-20250929, claude-sonnet-4.6. */
const FAMILY_FIRST = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?!\d)/;
/** The Claude 3 naming, version first: claude-3-7-sonnet-latest, claude-3-opus-20240229. */
const VERSION_FIRST = /^claude-\d+(?:[-.]\d{1,2})?-(?:opus|sonnet|haiku)/;

/** The request surface a Claude model id takes (ADR 0049). */
export function claudeGeneration(model: string): ClaudeGeneration {
  if (VERSION_FIRST.test(model)) return BUDGET;
  const m = FAMILY_FIRST.exec(model);
  if (!m) return CURRENT;
  const family = m[1];
  const version = Number(m[2]) * 100 + Number(m[3] ?? 0);
  switch (family) {
    case 'opus':
      if (version <= 406) return BUDGET;
      if (version === 407) return OPUS_4_7;
      if (version === 408) return OPUS_4_8;
      if (version === 500) return OPUS_5;
      return CURRENT;
    case 'sonnet':
      if (version < 500) return BUDGET;
      if (version === 500) return SONNET_5;
      if (version === 505) return SONNET_5_5;
      return CURRENT;
    case 'haiku':
      if (version < 500) return BUDGET;
      if (version === 505) return HAIKU_5_5;
      return CURRENT;
    default: // fable, mythos
      return version === 500 ? FABLE_5 : CURRENT;
  }
}

// ── Reasoning on adaptive models ─────────────────────────────────────────────

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Thinking tokens behind each effort word, for the max_tokens floor: ADR
 * 0047's budgets for low, medium and high, and `high`'s for the two words
 * above it, which keeps a non-streaming request under the SDK's ceiling.
 */
const EFFORT_BUDGET: Readonly<Record<ClaudeEffort, number>> = { low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 };

/** Room for the reply beyond the thinking, as the budget path leaves it. */
const REPLY_HEADROOM = 2048;

/**
 * The level an agent's generateContentConfig asks for: the effort word the
 * compiler writes for every model (ADR 0047), else the older spelling's
 * thinking budget rounded up to a level. Undefined when it asks for neither.
 */
export function requestedEffort(cfg: Record<string, any>): 'none' | ClaudeEffort | undefined {
  const word = typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort.toLowerCase() : undefined;
  if (word === 'none') return 'none';
  if (word === 'minimal') return 'low';
  if (word && EFFORTS.has(word)) return word as ClaudeEffort;
  const budget = cfg.thinkingConfig?.thinkingBudget;
  if (typeof budget !== 'number') return undefined;
  if (budget === 0) return 'none';
  if (budget < 0) return undefined; // Gemini's "dynamic"; the model's default
  return budget <= 2048 ? 'low' : budget <= 8192 ? 'medium' : 'high';
}

/**
 * How hard one request asks Claude to think, in the terms the generation
 * table reads. The budget rows read `budget` alone; the adaptive rows read
 * `effort`, and take the max_tokens floor from `budget` when it is above 0.
 */
export interface ClaudeReasoning {
  /** The effort word, or `none`. Undefined: the model's own default. */
  effort?: 'none' | ClaudeEffort;
  /** A thinking budget in tokens: the budget rows' budget, and the adaptive rows' max_tokens floor. */
  budget?: number;
}

/**
 * The contract's ReasoningSetting (ADR 0047) as ClaudeReasoning: a level is
 * its effort word with ADR 0047's budget for it, so the budget rows think
 * with that budget; `{ budget_tokens: n }` is the level covering n, with n
 * as the budget; `none` and a budget of 0 are `none`.
 */
export function claudeReasoningOf(setting: ReasoningSetting | undefined): ClaudeReasoning {
  if (setting === undefined) return {};
  if (typeof setting === 'string') return { effort: setting, budget: REASONING_BUDGETS[setting] };
  const n = setting.budget_tokens;
  if (!(n > 0)) return { effort: 'none', budget: 0 };
  return { effort: n <= REASONING_BUDGETS.low ? 'low' : n <= REASONING_BUDGETS.medium ? 'medium' : 'high', budget: n };
}

/**
 * The older spelling in an agent's generateContentConfig, read as ADR 0049
 * reads it: the effort word first (`xhigh` and `max` pass through,
 * `minimal` is `low`), else the thinking budget rounded up to a level; and
 * the thinking budget as given, which is all the budget rows read. The ADK
 * path's ClaudeLlm hands the adapter this (ADR 0055).
 */
export function claudeReasoningFromConfig(cfg: Record<string, any>): ClaudeReasoning {
  const effort = requestedEffort(cfg);
  const budget = cfg.thinkingConfig?.thinkingBudget;
  return { ...(effort !== undefined ? { effort } : {}), ...(typeof budget === 'number' ? { budget } : {}) };
}

/** The beta that lets a request set `thinking.block_binding`. */
export const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

export interface AdaptiveThinkingPlan {
  /** The `thinking` field, or undefined to leave the model's default. */
  thinking?: Record<string, unknown>;
  /** `output_config.effort`, or undefined for the model's default. */
  effort?: ClaudeEffort;
  /** The least max_tokens the request needs, so thinking does not crowd out the reply. */
  minMaxTokens?: number;
  /** The request thinks (adaptive): the forced structured-output tool is offered under auto instead. */
  thinkingOn: boolean;
  /** `block_binding: drop_block` rides on `thinking`; the request needs THINKING_BINDING_BETA. */
  dropBlock: boolean;
  /**
   * Signed blocks may be replayed. False only where the blocks are bound to
   * the conversation and drop_block cannot ride (thinking off): a replayed
   * block whose history changed would be a 400 (ADR 0049).
   */
  replaySigned: boolean;
}

/**
 * The thinking and effort fields for an adaptive-generation model (ADR 0049).
 * `none` becomes the model's off switch, at `low` effort, or adaptive at
 * `low` where the engine uses none. Thinking that is on asks for a
 * `summarized` display, which the engine shows as dimmed text, and on a
 * conversation-bound model sets `drop_block`, so a replayed block whose
 * history changed (a resumed turn read back from storage) is dropped by the
 * API instead of failing the request.
 */
export function adaptiveThinking(gen: ClaudeGeneration, cfg: Record<string, any>): AdaptiveThinkingPlan {
  return adaptiveThinkingFor(gen, claudeReasoningFromConfig(cfg));
}

/** adaptiveThinking for a ClaudeReasoning, from either path. */
export function adaptiveThinkingFor(gen: ClaudeGeneration, reasoning: ClaudeReasoning): AdaptiveThinkingPlan {
  const level = reasoning.effort;
  const on = (effort: ClaudeEffort | undefined): AdaptiveThinkingPlan => {
    const budget = reasoning.budget;
    // With no effort sent the model thinks at its own default, which is at most `high`.
    const thinkingTokens = typeof budget === 'number' && budget > 0 ? budget : EFFORT_BUDGET[effort ?? 'high'];
    return {
      thinking: {
        type: 'adaptive',
        ...(gen.display ? { display: 'summarized' } : {}),
        ...(gen.bindsConversation ? { block_binding: { prefix_mismatch_behavior: 'drop_block' } } : {}),
      },
      ...(effort ? { effort } : {}),
      minMaxTokens: thinkingTokens + REPLY_HEADROOM,
      thinkingOn: true,
      dropBlock: gen.bindsConversation,
      replaySigned: true,
    };
  };
  const off = (thinking: Record<string, unknown>): AdaptiveThinkingPlan => ({
    thinking,
    effort: 'low',
    thinkingOn: false,
    dropBlock: false,
    replaySigned: !gen.bindsConversation,
  });

  if (level === undefined) {
    // The agent sets nothing: the model's own default, readable where it thinks.
    return gen.thinksByDefault ? on(undefined) : { thinkingOn: false, dropBlock: false, replaySigned: true };
  }
  if (level !== 'none') return on(level);
  switch (gen.off) {
    case 'disabled':
      return off({ type: 'disabled' });
    case 'between_tools':
      return off({ type: 'between_tools' });
    default:
      return on('low');
  }
}

/**
 * Whether a URL image source reaches Claude on this platform. Anthropic's
 * vision docs: on Amazon Bedrock and Google Cloud only base64 sources are
 * available.
 */
export function claudeUrlImagesOn(platform: Platform): boolean {
  return platform !== 'bedrock' && platform !== 'vertex';
}
