/**
 * lib/models/contextWindow.ts — how many tokens a model's context holds,
 * read from the model id (ADR 0154).
 *
 * WHY this file exists:
 *   Compaction on by default needs a threshold per model, and nothing in the
 *   registry said how big a window is. The numbers here are each provider's
 *   published context length for the id families the engine routes
 *   (lib/models/providerMap.ts), newest row first; an id a family does not
 *   name gets the family's newest row, as the Claude generation table does.
 *   Ollama's is whatever the server was started with: OLLAMA_CONTEXT_LENGTH
 *   when set, else Ollama's 4,096 default (lib/models/ollamaAdapter.ts), the
 *   one provider that cannot report an overflow, which is why its threshold
 *   must be right.
 *
 *   `compactAfterTokens(model)` is the default `compact_after_tokens`: 60%
 *   of the window, so a step's own output, the summary and a tool result
 *   or two still fit after the threshold is passed. A window the table does
 *   not know gets UNKNOWN_WINDOW.
 */

import { providerForModel } from './providerMap.ts';

/** Assumed for a provider the table does not know. */
export const UNKNOWN_WINDOW = 100_000;
/** The share of the window past which an agent compacts by default. */
export const COMPACT_AT_SHARE = 0.6;
/** Ollama's context length unless the server says otherwise. */
export const OLLAMA_DEFAULT_CONTEXT = 4_096;

/** A family's rows: the first pattern that matches wins; the last row is the family's newest. */
type Row = [pattern: RegExp, tokens: number];

const CLAUDE: Row[] = [[/^claude-/, 200_000]];
const OPENAI: Row[] = [
  [/^gpt-4o/, 128_000],
  [/^gpt-4\.1/, 1_047_576],
  [/^o[0-9]/, 200_000],
  [/^gpt-5/, 400_000],
];
const GEMINI: Row[] = [[/^gemini-/, 1_048_576]];
const XAI: Row[] = [
  [/^grok-3/, 131_072],
  [/^grok-4/, 256_000],
];
const MOONSHOT: Row[] = [
  [/^kimi-k2/, 262_144],
  [/^kimi-k3/, 1_000_000],
];
const DEEPSEEK: Row[] = [[/^deepseek-/, 1_000_000]];

const FAMILIES: Partial<Record<ReturnType<typeof providerForModel>, Row[]>> = {
  anthropic: CLAUDE,
  openai: OPENAI,
  gemini: GEMINI,
  xai: XAI,
  moonshot: MOONSHOT,
  deepseek: DEEPSEEK,
};

/** The Ollama server's context length: OLLAMA_CONTEXT_LENGTH, else Ollama's default. */
export function ollamaContextLength(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.OLLAMA_CONTEXT_LENGTH);
  return Number.isFinite(set) && set > 0 ? Math.floor(set) : OLLAMA_DEFAULT_CONTEXT;
}

/** The tokens `model`'s context holds, or undefined for a provider the table does not know (Jev, a gateway-only id). */
export function contextWindowOf(model: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const provider = providerForModel(model);
  if (provider === 'ollama') return ollamaContextLength(env);
  const rows = FAMILIES[provider];
  if (!rows || rows.length === 0) return undefined;
  const bare = model.replace(/^[a-z-]+\//, '');
  const hit = rows.find(([pattern]) => pattern.test(bare));
  return (hit ?? rows[rows.length - 1]!)[1];
}

/** The default `compact_after_tokens` for `model`: COMPACT_AT_SHARE of its window. */
export function compactAfterTokens(model: string, env: NodeJS.ProcessEnv = process.env): number {
  return Math.round((contextWindowOf(model, env) ?? UNKNOWN_WINDOW) * COMPACT_AT_SHARE);
}
