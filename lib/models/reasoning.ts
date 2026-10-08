/**
 * lib/models/reasoning.ts — the generateContentConfig fields a `reasoning:`
 * setting becomes for one model (ADR 0047).
 *
 * WHY HERE: the compiler maps an agent's `reasoning:` key through this, and
 * a model adapter on the contract (lib/models/geminiAdapter.ts) maps a
 * ModelRequest's `reasoning` the same way. Keeping it out of lib/compile.ts
 * keeps ADK out of an adapter's imports. lib/compile.ts re-exports both
 * names, so existing imports keep working.
 */
import type { ReasoningLevel, ReasoningSetting } from './contract.ts';
import { providerForModel } from './providerMap.ts';

/**
 * Thinking tokens per level, for the providers that take a budget (Claude,
 * Gemini 2.x). The same table rounds a `budget_tokens` value up to a level
 * for the providers that take only a level or an effort word.
 */
export const REASONING_BUDGETS: Readonly<Record<ReasoningLevel, number>> = { none: 0, low: 2048, medium: 8192, high: 16384 };

const GEMINI_THINKING_LEVEL: Readonly<Record<ReasoningLevel, string>> = { none: 'MINIMAL', low: 'LOW', medium: 'MEDIUM', high: 'HIGH' };

/** The smallest level whose budget covers the setting: never less thought than asked. */
function reasoningLevel(setting: ReasoningSetting): ReasoningLevel {
  if (typeof setting === 'string') return setting;
  const n = setting.budget_tokens;
  return n <= 0 ? 'none' : n <= REASONING_BUDGETS.low ? 'low' : n <= REASONING_BUDGETS.medium ? 'medium' : 'high';
}

/**
 * The effort word for `generateContentConfig.reasoningEffort`, which the
 * chat-completions adapters, the gateway and the Responses adapters read.
 * A word the provider lacks becomes its nearest setting above.
 */
function reasoningEffort(model: string, level: ReasoningLevel): string {
  switch (providerForModel(model)) {
    case 'openai':
      if (level !== 'none') return level;
      // o-series cannot stop reasoning; the first GPT-5 generation says
      // "minimal"; GPT-5.1 and later say "none".
      return /^o\d/.test(model) ? 'low' : /^gpt-5(?![.\d])/.test(model) ? 'minimal' : 'none';
    case 'xai':
      return level === 'none' ? 'low' : level; // Grok 4.5/4.7 cannot stop reasoning
    case 'moonshot':
      return level === 'medium' ? 'high' : level; // K3 has low | high | max
    default:
      return level;
  }
}

/**
 * The generateContentConfig fields a `reasoning:` setting becomes for one
 * model (ADR 0047). `reasoningEffort` is always set, so the gateway (which
 * may serve any id) carries the level too; the Claude adapter reads it first
 * on the adaptive generations (ADR 0049), and the genai SDK drops it from a
 * Gemini request. Claude and Gemini also get the `thinkingConfig` their
 * adapters read.
 */
export function reasoningConfig(model: string, setting: ReasoningSetting): Record<string, unknown> {
  const level = reasoningLevel(setting);
  const budget = typeof setting === 'string' ? REASONING_BUDGETS[setting] : setting.budget_tokens;
  const out: Record<string, unknown> = { reasoningEffort: reasoningEffort(model, level) };
  const provider = providerForModel(model);
  if (provider === 'anthropic') out.thinkingConfig = { thinkingBudget: budget };
  if (provider === 'gemini') {
    // Gemini 3 takes a level; 2.x and older take only a budget. An explicit
    // budget is sent as one on any Gemini, except 0, which is `none`.
    const budgetOnly = /^gemini-[12]\./.test(model);
    out.thinkingConfig = budgetOnly || (typeof setting !== 'string' && budget > 0) ? { thinkingBudget: budget } : { thinkingLevel: GEMINI_THINKING_LEVEL[level] };
  }
  return out;
}
