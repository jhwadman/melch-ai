/**
 * lib/agentDialect.ts — the YAML v2 agent keys and the engine form they map to
 * (ADR 0115).
 *
 * WHY this file exists:
 *   An agent's sampling and structured-output settings were spelled in
 *   Gemini's dialect (`generateContentConfig.temperature`, `outputSchema`),
 *   which is what the engine still reads (lib/runtime/native/request.ts
 *   buildModelRequest). YAML v2 spells them provider-neutrally (`sampling`,
 *   `output`, and `tool_choice` from ADR 0117) and adds per-provider
 *   instruction overrides (`model_overrides`).
 *   This module is the one place the two spellings meet:
 *
 *   - `V2_SPELLINGS`: each v2 key path and the v1 path it replaces. The
 *     loader (lib/syndicateSchema.ts crossFieldProblems) refuses a file that
 *     sets both; `toEngineAgent` refuses a config built in code that does.
 *   - `toEngineAgent`: folds `sampling`, `output` and `tool_choice` into
 *     the engine form.
 *     validateSyndicateConfig applies it to every agent it returns, so every
 *     loader hands downstream the engine form; lib/compile.ts applies it
 *     again (idempotent) for configs built in code.
 *   - `v1SpellingsOf`: the deprecated v1 key paths a raw file still uses, for
 *     the loader's one-line deprecation warning (paths only, never values).
 *   - `instructionFor`: an agent's instruction with its `model_overrides`
 *     entry for the provider of the model it runs on applied.
 *
 * Internal: not in the lib/index.ts barrel nor the package exports map.
 */

import type { AgentYamlConfig } from './loadSyndicate.ts';
import { providerForModel } from './models/providerMap.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One v2 key and the v1 (engine) path it replaces. Both paths are relative to the agent. */
export interface V2Spelling {
  readonly v2: readonly string[];
  readonly v1: readonly string[];
  /** The engine value for the v2 value, when the two are spelled differently. */
  readonly toV1?: (value: unknown) => unknown;
}

/**
 * `tool_choice` as Gemini's function-calling config, which the engine reads
 * (lib/models/genaiMapping.ts toolChoiceOf): `auto` is AUTO, `none` NONE,
 * `required` ANY, and `{ name }` ANY with that one name allowed (ADR 0117).
 */
export function functionCallingConfigOf(choice: unknown): Record<string, unknown> {
  if (choice === 'none') return { mode: 'NONE' };
  if (choice === 'required') return { mode: 'ANY' };
  if (isObj(choice) && typeof choice.name === 'string') return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  return { mode: 'AUTO' };
}

/** Every v2 key with a v1 equivalent; the mapper writes the v1 path. */
export const V2_SPELLINGS: readonly V2Spelling[] = [
  { v2: ['sampling', 'temperature'], v1: ['generateContentConfig', 'temperature'] },
  { v2: ['sampling', 'top_p'], v1: ['generateContentConfig', 'topP'] },
  { v2: ['sampling', 'max_output_tokens'], v1: ['generateContentConfig', 'maxOutputTokens'] },
  { v2: ['sampling', 'stop'], v1: ['generateContentConfig', 'stopSequences'] },
  { v2: ['output', 'schema'], v1: ['outputSchema'] },
  { v2: ['output', 'mime'], v1: ['generateContentConfig', 'responseMimeType'] },
  { v2: ['tool_choice'], v1: ['generateContentConfig', 'toolConfig', 'functionCallingConfig'], toV1: functionCallingConfigOf },
];

/** The v2 agent keys, which an inline agent alone may carry (not a yaml_reference or a2a_agent_url subagent). */
export const V2_AGENT_KEYS = ['sampling', 'output', 'tool_choice', 'model_overrides'] as const;

/** The v1 spellings ADR 0115 deprecates, as agent keys. */
export const V1_AGENT_KEYS = ['generateContentConfig', 'outputSchema'] as const;

/** The value at `path` under `root`, or undefined. */
function at(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** The v2/v1 pairs an agent sets both of: each is a conflict. */
export function conflictsOf(agent: unknown): V2Spelling[] {
  return V2_SPELLINGS.filter((s) => at(agent, s.v2) !== undefined && at(agent, s.v1) !== undefined);
}

/** The loader's message for one conflict, reported against the v2 key path. */
export function conflictMessage(s: V2Spelling): string {
  return `cannot be combined with ${s.v1.join('.')}; ${s.v2.join('.')} replaces it, so keep one (ADR 0115)`;
}

/**
 * An agent in the engine form: `sampling`, `output` and `tool_choice` folded
 * into `generateContentConfig` and `outputSchema` (the table above) and
 * removed; `model_overrides` kept (lib/compile.ts applies it). The same
 * object when the agent has none of the three, so it is idempotent. Throws
 * when a v2 key and the v1 key it replaces are both set.
 */
export function toEngineAgent<T extends object>(agent: T): T {
  const a = agent as Obj;
  if (a.sampling === undefined && a.output === undefined && a.tool_choice === undefined) return agent;
  const clash = conflictsOf(a);
  if (clash.length) {
    const name = typeof a.name === 'string' ? a.name : 'agent';
    throw new Error(`${name}: ${clash.map((s) => `${s.v2.join('.')} cannot be combined with ${s.v1.join('.')}`).join('; ')}; the v2 key replaces it, so keep one (ADR 0115)`);
  }
  const { sampling: _sampling, output: _output, tool_choice: _toolChoice, ...rest } = a;
  const out: Obj = { ...rest };
  for (const s of V2_SPELLINGS) {
    const raw = at(a, s.v2);
    if (raw === undefined) continue;
    const value = s.toV1 ? s.toV1(raw) : raw;
    // Copy each object on the v1 path, so the caller's config is never written to.
    let parent = out;
    for (const seg of s.v1.slice(0, -1)) {
      const next: Obj = { ...(isObj(parent[seg]) ? (parent[seg] as Obj) : {}) };
      parent[seg] = next;
      parent = next;
    }
    parent[s.v1[s.v1.length - 1]!] = value;
  }
  return out as T;
}

/**
 * The deprecated v1 key paths a raw syndicate uses, in file order:
 * `orchestrator.generateContentConfig`, `subagents[2].outputSchema`, ...
 * Paths only: the loader logs them, never the values under them.
 */
export function v1SpellingsOf(raw: unknown): string[] {
  if (!isObj(raw)) return [];
  const agents: Array<[string, unknown]> = [['orchestrator', raw.orchestrator]];
  if (Array.isArray(raw.subagents)) raw.subagents.forEach((sub, i) => agents.push([`subagents[${i}]`, sub]));
  const out: string[] = [];
  for (const [path, agent] of agents) {
    if (!isObj(agent)) continue;
    for (const key of V1_AGENT_KEYS) if (agent[key] !== undefined) out.push(`${path}.${key}`);
  }
  return out;
}

/**
 * An agent's base instruction for the model it runs on: its
 * `model_overrides` entry for that model's provider replaces it
 * (`instruction`) or is appended after a blank line (`instruction_append`).
 * The base instruction when there is no entry or no model id. The skills
 * index (lib/compile.ts withSkills) is appended after this.
 */
export function instructionFor(
  agent: Pick<AgentYamlConfig, 'model_overrides'> & { instruction?: string },
  modelId: string | undefined,
): string {
  const base = agent.instruction ?? '';
  if (!agent.model_overrides || modelId === undefined) return base;
  const entry = agent.model_overrides[providerForModel(modelId)];
  if (!entry) return base;
  if (entry.instruction !== undefined) return entry.instruction;
  if (entry.instruction_append !== undefined) return base ? `${base}\n\n${entry.instruction_append}` : entry.instruction_append;
  return base;
}
