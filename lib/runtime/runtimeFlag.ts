/**
 * lib/runtime/runtimeFlag.ts — which runtime runs a turn: MELCHIZEDEK_RUNTIME
 * and the turn's `runtime` option (ADR 0045, ADR 0073).
 *
 * `adk` runs each agent on Google ADK's Runner, `native` on the engine's own
 * agent loop (lib/runtime/native/agentLoop.ts). The default is `adk` until
 * the release that makes native the default (ADR 0045). A feature the native
 * runtime does not run yet fails before any model call with
 * UnsupportedOnRuntimeError, which names the feature and the runtime.
 *
 * A leaf module: it imports nothing, so every caller (the compiler, the
 * turn runner, the wiki agent runner) can read the flag without a cycle.
 */

/** The runtime a turn runs on: Google ADK's Runner, or the engine's own loop. */
export type RuntimeName = 'adk' | 'native';

export const RUNTIMES: readonly RuntimeName[] = ['adk', 'native'];

/** The runtime when neither the turn nor MELCHIZEDEK_RUNTIME names one. */
export const DEFAULT_RUNTIME: RuntimeName = 'adk';

function asRuntime(raw: string, source: string): RuntimeName {
  const value = raw.trim().toLowerCase();
  if (value === 'adk' || value === 'native') return value;
  throw new Error(`${source} must be "adk" or "native".`);
}

/** MELCHIZEDEK_RUNTIME as set, or undefined when unset or blank. Any other value is a configuration error. */
export function runtimeSetting(env: NodeJS.ProcessEnv = process.env): RuntimeName | undefined {
  const raw = env.MELCHIZEDEK_RUNTIME;
  if (!raw || !raw.trim()) return undefined;
  return asRuntime(raw, 'MELCHIZEDEK_RUNTIME');
}

/** The runtime to use: the caller's option, else MELCHIZEDEK_RUNTIME, else adk. */
export function chooseRuntime(option?: string, env: NodeJS.ProcessEnv = process.env): RuntimeName {
  if (option !== undefined) return asRuntime(option, 'The runtime option');
  return runtimeSetting(env) ?? DEFAULT_RUNTIME;
}

/** A feature the chosen runtime does not run yet. Thrown before any model call. */
export class UnsupportedOnRuntimeError extends Error {
  readonly feature: string;
  readonly runtime: RuntimeName;

  constructor(feature: string, runtime: RuntimeName, where: string) {
    super(`${where}: ${feature} is not supported on the ${runtime} runtime yet. Run it on the ${runtime === 'native' ? 'adk' : 'native'} runtime (MELCHIZEDEK_RUNTIME, or the turn's runtime option).`);
    this.name = 'UnsupportedOnRuntimeError';
    this.feature = feature;
    this.runtime = runtime;
  }
}

/** The error for a feature the native runtime does not run yet; `where` names the agent or syndicate. */
export function unsupportedOnNative(feature: string, where: string): UnsupportedOnRuntimeError {
  return new UnsupportedOnRuntimeError(feature, 'native', where);
}
