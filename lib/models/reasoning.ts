/**
 * lib/models/reasoning.ts — the generateContentConfig fields a `reasoning:`
 * setting becomes for one model (ADR 0047).
 *
 * WHY HERE: the compiler maps an agent's `reasoning:` key through this, and
 * a model adapter on the contract (lib/models/geminiAdapter.ts) maps a
 * ModelRequest's `reasoning` the same way. Keeping it out of lib/compile.ts
 * keeps the compiler out of an adapter's imports. lib/compile.ts re-exports both
 * names, so existing imports keep working.
 */
import type { ReasoningLevel, ReasoningSetting } from './contract.ts';
import { geminiMajorVersion } from './geminiState.ts';
import { providerForModel } from './providerMap.ts';

/**
 * Thinking tokens per level, for the providers that take a budget (Claude,
 * Gemini 2.x). The same table rounds a `budget_tokens` value up to a level
 * for the providers that take only a level or an effort word. `xhigh` and
 * `max` take `high`'s budget (ADR 0117): above it a non-streaming Claude
 * request passes the Anthropic SDK's ceiling (ADR 0047), so a budget path
 * sends them as `high`, and a budget never rounds up to either.
 */
export const REASONING_BUDGETS: Readonly<Record<ReasoningLevel, number>> = { none: 0, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 };

const GEMINI_THINKING_LEVEL: Readonly<Record<ReasoningLevel, string>> = { none: 'MINIMAL', low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'HIGH', max: 'HIGH' };

/**
 * Gemini 4's levels: no `MINIMAL` (the API rejects it, 400), so `none` goes
 * as `LOW`; `XHIGH` on the ids that take it (geminiTakesXhigh), else `HIGH`.
 */
const GEMINI_4_THINKING_LEVEL: Readonly<Record<ReasoningLevel, string>> = { none: 'LOW', low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'XHIGH', max: 'XHIGH' };

/** A Gemini id (bare or under a resource path) that takes thinkingLevel `XHIGH`: gemini-4-hydrogen and gemini-4-neon. */
export function geminiTakesXhigh(model: string): boolean {
  return /^gemini-4-(?:hydrogen|neon)(?![a-z0-9])/.test(model.slice(model.lastIndexOf('/') + 1));
}

/** The thinkingLevel a level goes as on one Gemini model that takes levels (Gemini 3 and later). */
function geminiThinkingLevel(model: string, level: ReasoningLevel): string {
  if (geminiMajorVersion(model) < 4) return GEMINI_THINKING_LEVEL[level];
  const sent = GEMINI_4_THINKING_LEVEL[level];
  return sent === 'XHIGH' && !geminiTakesXhigh(model) ? 'HIGH' : sent;
}

/**
 * The level asked for when a Gemini request for `model` thinks other than
 * asked, for the span's `llm.reasoning.weakened`; undefined when it goes as
 * asked. Above `high`: anything past effortCeiling(model) (`max` everywhere,
 * `xhigh` except on gemini-4-hydrogen and gemini-4-neon). On Gemini 4 and
 * later, `none` and a budget of 0 too: those models cannot stop thinking,
 * so they think at `LOW`.
 */
export function geminiWeakened(model: string, setting: ReasoningSetting): ReasoningLevel | undefined {
  const level = reasoningLevel(setting);
  if (level === 'none') return geminiMajorVersion(model) >= 4 ? 'none' : undefined;
  if (!isAboveHigh(level)) return undefined;
  return REASONING_ORDER.indexOf(level) > REASONING_ORDER.indexOf(effortCeiling(model)) ? level : undefined;
}

/**
 * Whether `model` thinks at its highest level when a request sends none:
 * Gemini 4 and later (`high`; Gemini 3 defaulted to `medium`). The engine's
 * own calls that run outside an agent's YAML (the compaction summary, the
 * wiki agent run, the vision passes) send such a model an explicit level.
 */
export function thinksHighByDefault(model: string): boolean {
  return providerForModel(model) === 'gemini' && geminiMajorVersion(model) >= 4;
}

/**
 * The generateContentConfig fields for one of the engine's own calls at
 * `level` (reasoningConfig), on a model that thinks high by default; `{}`
 * on every other model, whose calls go as they did.
 */
export function internalReasoningConfig(model: string, level: ReasoningLevel): Record<string, unknown> {
  return thinksHighByDefault(model) ? reasoningConfig(model, level) : {};
}

/**
 * The genai config for one of the engine's own direct Gemini calls (the
 * vision passes) at `level`: `{ thinkingConfig }` on a model that thinks
 * high by default, undefined elsewhere, so the call goes with no config.
 */
export function internalThinkingConfig(model: string, level: ReasoningLevel): { thinkingConfig: Record<string, unknown> } | undefined {
  const thinking = internalReasoningConfig(model, level).thinkingConfig as Record<string, unknown> | undefined;
  return thinking ? { thinkingConfig: thinking } : undefined;
}

/** The levels in order of how hard they ask the model to think. */
export const REASONING_ORDER: readonly ReasoningLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The levels above `high`, which only some models take (ADR 0117). */
export const isAboveHigh = (setting: ReasoningSetting | undefined): setting is 'xhigh' | 'max' => setting === 'xhigh' || setting === 'max';

/** An OpenAI id that takes `xhigh`: GPT-5.2 and later (the o-series and GPT-5 and 5.1 stop at `high`). */
function openAiTakesXhigh(model: string): boolean {
  const m = /^gpt-(\d{1,3})(?:\.(\d{1,3}))?/.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  return major > 5 || (major === 5 && Number(m[2] ?? 0) >= 2);
}

/** The smallest level whose budget covers the setting: never less thought than asked. */
export function reasoningLevel(setting: ReasoningSetting): ReasoningLevel {
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
    case 'deepseek':
      // K3 and DeepSeek have low | high | max: a missing word rounds up.
      return level === 'medium' ? 'high' : level === 'xhigh' ? 'max' : level;
    default:
      return level;
  }
}

/**
 * The highest level the direct adapter for `model` sends as asked (ADR
 * 0117); a level above it goes as this one. `max` where every level
 * passes: Claude's adaptive generations (the Claude adapter sends its budget
 * generations `high`'s budget), Kimi K3 and DeepSeek. OpenAI's GPT-5.2 and later and
 * grok-4.7, gemini-4-hydrogen and gemini-4-neon stop at `xhigh`; other
 * OpenAI, Grok and Gemini ids and Ollama at `high`. A gateway stops at
 * `high` whatever the id (gatewayAdapter.ts).
 */
export function effortCeiling(model: string): ReasoningLevel {
  switch (providerForModel(model)) {
    case 'anthropic':
    case 'moonshot':
    case 'deepseek':
      return 'max';
    case 'openai':
      return openAiTakesXhigh(model) ? 'xhigh' : 'high';
    case 'xai':
      return /^grok-4\.7(?!\d)/.test(model) ? 'xhigh' : 'high';
    case 'gemini':
      return geminiTakesXhigh(model) ? 'xhigh' : 'high';
    default:
      return 'high';
  }
}

/**
 * The effort word an adapter sends for one setting: ADR 0047's word for the
 * model, held at `ceiling` (default effortCeiling(model)). `weakened` is the
 * level asked for when the word sent is below it; the adapter marks the span
 * `llm.reasoning.weakened` with it.
 */
export function effortWord(model: string, setting: ReasoningSetting, ceiling: ReasoningLevel = effortCeiling(model)): { word: string; weakened?: ReasoningLevel } {
  const word = reasoningConfig(model, setting).reasoningEffort as string;
  if (!isAboveHigh(setting) || REASONING_ORDER.indexOf(word as ReasoningLevel) <= REASONING_ORDER.indexOf(ceiling)) return { word };
  return { word: ceiling, weakened: setting };
}

/**
 * The generateContentConfig fields a `reasoning:` setting becomes for one
 * model (ADR 0047). `reasoningEffort` is always set, so the gateway (which
 * may serve any id) carries the level too; the Claude adapter reads it first
 * on the adaptive generations (ADR 0049), and the genai SDK drops it from a
 * Gemini request. Claude and Gemini also get the `thinkingConfig` their
 * adapters read. `xhigh` and `max` are written as asked (Kimi's `xhigh` as
 * `max`), beside `high`'s thinkingConfig: the adapter holds the word at its
 * model's ceiling (effortWord), so the setting reaches it intact (ADR 0117).
 */
export function reasoningConfig(model: string, setting: ReasoningSetting): Record<string, unknown> {
  const level = reasoningLevel(setting);
  const budget = typeof setting === 'string' ? REASONING_BUDGETS[setting] : setting.budget_tokens;
  const out: Record<string, unknown> = { reasoningEffort: reasoningEffort(model, level) };
  const provider = providerForModel(model);
  if (provider === 'anthropic') out.thinkingConfig = { thinkingBudget: budget };
  if (provider === 'gemini') {
    // Gemini 3 and later take a level; 2.x and older take only a budget. An
    // explicit budget is sent as one on any Gemini, except 0, which is
    // `none`: `MINIMAL` on Gemini 3, `LOW` on Gemini 4 (geminiThinkingLevel).
    const budgetOnly = /^gemini-[12]\./.test(model);
    out.thinkingConfig = budgetOnly || (typeof setting !== 'string' && budget > 0) ? { thinkingBudget: budget } : { thinkingLevel: geminiThinkingLevel(model, level) };
  }
  return out;
}
