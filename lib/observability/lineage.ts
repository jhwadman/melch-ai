/**
 * lib/observability/lineage.ts — provenance stamps for the ledger.
 *
 * A stored output is evidence only if you know exactly what produced it.
 * Every turn row carries two stamps computed here:
 *
 *   config_hash     SHA-256 (first 16 hex) of the RESOLVED syndicate config
 *                   with every nested `yaml_reference` inlined — the exact
 *                   prompts, models, tools and generation settings that ran.
 *                   Two deployments serving "the same" syndicate with a
 *                   drifted registry row or a stale file produce different
 *                   hashes, which is the first time that drift is visible in
 *                   stored data. Eval runs hash the overridden config, so a
 *                   variant's rows are distinguishable from production's.
 *   engine_version  package version plus the git commit (or the platform's
 *                   SOURCE_VERSION / HEROKU_SLUG_COMMIT), so a behaviour
 *                   change can be pinned to a deploy.
 *
 * Both are deterministic and cheap; neither touches the network.
 *
 * It also names the spans each runtime opens around an agent, a model call
 * and a tool call, which the tracer's span lineage and the exporter read
 * (below, ADR 0076).
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SyndicateYamlConfig } from '../loadSyndicate.ts';

/** Schema version stamped on every ledger row (adk_turns / adk_payloads). */
export const TELEMETRY_SCHEMA_VERSION = 2;

// ── Span lineage: the names each runtime gives its spans ─────────────────────
// A turn's spans nest root → agent → model call → llm.request, with tool
// calls under the agent. The ADK runtime opens `invoke_agent <name>`,
// `call_llm` and `execute_tool <name>` (scope gcp.vertex.agent); the native
// loop opens `agent.invoke <name>`, `model.call` and `tool.execute <name>`
// (scope melchizedek.runtime, lib/runtime/native/telemetry.ts). The tracer's
// lineage (which agent made a call, tool time) and the exporter's payload
// tier read both schemes through these helpers (ADR 0076).

/** ADK's tracer scope. */
export const ADK_SPAN_SCOPE = 'gcp.vertex.agent';
/** The native loop's tracer scope. */
export const RUNTIME_SPAN_SCOPE = 'melchizedek.runtime';

const AGENT_SPAN_PREFIXES = ['invoke_agent ', 'agent.invoke '] as const;
const TOOL_SPAN_PREFIXES = ['execute_tool ', 'tool.execute '] as const;

/** The agent an agent span names (`invoke_agent X`, `agent.invoke X`), else null. */
export function agentOfSpanName(name: string): string | null {
  for (const prefix of AGENT_SPAN_PREFIXES) if (name.startsWith(prefix)) return name.slice(prefix.length);
  return null;
}

/** True for a tool call's span on either runtime. */
export function isToolSpanName(name: string): boolean {
  return TOOL_SPAN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** True for one agent step's model-call span: ADK's `call_llm`, the loop's `model.call`. */
export function isModelCallSpan(name: string, scope: string): boolean {
  return (name === 'call_llm' && scope === ADK_SPAN_SCOPE) || (name === 'model.call' && scope === RUNTIME_SPAN_SCOPE);
}

/** JSON with object keys sorted at every depth — stable across reloads. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** The config with every `yaml_reference` replaced by the loaded syndicate. */
export function inlineReferences(
  config: SyndicateYamlConfig,
  loadNested: (ref: string) => SyndicateYamlConfig,
  seen: Set<string> = new Set(),
): Record<string, unknown> {
  return {
    ...config,
    subagents: (config.subagents ?? []).map((sub) => {
      if (!sub.yaml_reference || seen.has(sub.yaml_reference)) return sub;
      const next = new Set(seen);
      next.add(sub.yaml_reference);
      let nested: Record<string, unknown>;
      try {
        nested = inlineReferences(loadNested(sub.yaml_reference), loadNested, next);
      } catch (err: unknown) {
        nested = { unresolved: sub.yaml_reference, error: err instanceof Error ? err.message : String(err) };
      }
      return { ...sub, resolved_reference: nested };
    }),
  };
}

/**
 * Hash of the fully resolved config. `loadNested` is the same loader the
 * caller compiles with (the server's plain loadSyndicate; the observatory's
 * override-applying loader), so the hash describes what actually ran.
 */
export function configDigest(
  config: SyndicateYamlConfig,
  loadNested: (ref: string) => SyndicateYamlConfig,
): string {
  const resolved = inlineReferences(config, loadNested);
  return createHash('sha256').update(stableStringify(resolved)).digest('hex').slice(0, 16);
}

let cachedEngineVersion: string | undefined;

/** "<package version>+<commit>" — commit from the platform env or git, else "local". */
export function engineVersion(): string {
  if (cachedEngineVersion) return cachedEngineVersion;
  let pkgVersion = '0.0.0';
  try {
    const pkgPath = join(process.cwd(), 'package.json');
    if (existsSync(pkgPath)) {
      pkgVersion = String(JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? pkgVersion);
    }
  } catch {
    /* no package.json in cwd — version stays 0.0.0 */
  }
  let commit =
    process.env.SOURCE_VERSION ?? process.env.HEROKU_SLUG_COMMIT ?? process.env.GIT_COMMIT ?? '';
  if (!commit) {
    try {
      commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      commit = 'local';
    }
  }
  cachedEngineVersion = `${pkgVersion}+${commit.slice(0, 12)}`;
  return cachedEngineVersion;
}
