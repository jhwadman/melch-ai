/**
 * lib/script/config.ts — the `script:` block's shape (ADR 0137 Part B), a
 * leaf the loader, the schema's types and the runner share.
 *
 * The fourth orchestration method: DELEGATE, PLAN-DISPATCH and WORKFLOW
 * decide the order agents run in, and none can hold logic. A script is one
 * JavaScript module, run in the engine's sandbox (lib/sandbox/), that calls
 * the syndicate's own agents, its allowed tools and a person as functions,
 * so the routing, the per-call model and the pauses live in the syndicate
 * document and change with a deploy, not an engine release. The runner is
 * lib/script/run.ts.
 */

/** The `script:` block. */
export interface ScriptConfig {
  /** One module whose default export is an async function of the script API. Not interpolated. */
  source: string;
  /** The models agent(…, { model }) may move a call to; every agent is compiled on each. */
  models?: string[];
  /** The registry tools tool(name, args) may run. */
  tools?: string[];
  /** Tools from `tools` whose every call waits for a person's approval. */
  require_approval?: string[];
  /**
   * The syndicate's `variables`, bound as the loader bound them (the YAML's
   * defaults, then the caller's bindings): what the script reads as
   * `variables`. Written by the loader, never by hand.
   */
  variables?: Record<string, string | number | boolean>;
}

/** True when this syndicate orchestrates with a script. */
export function isScriptSyndicate(config: { script?: unknown }): config is { script: ScriptConfig } {
  const script = config.script as { source?: unknown } | undefined;
  return !!script && typeof script === 'object' && typeof script.source === 'string';
}
