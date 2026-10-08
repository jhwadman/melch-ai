/**
 * lib/runtime/runtimeFlag.ts — the runtime a turn runs on: MELCHIZEDEK_RUNTIME
 * and the turn's `runtime` option (ADR 0045, ADR 0073, ADR 0107).
 *
 * Every agent runs on the engine's own agent loop
 * (lib/runtime/native/agentLoop.ts): `native` is the only runtime. The
 * setting and the option stay readable so a deployment that names its
 * runtime keeps working: `native` is accepted and changes nothing. `adk`
 * named the Google ADK runtime that 1.0.0 removed; it is refused with
 * RuntimeRemovedError, which names the release and the fix, so a server
 * configured for it fails at startup rather than serve on a runtime it did
 * not ask for. Any other value is a configuration error.
 *
 * A feature the runtime does not run fails before any model call with
 * UnsupportedOnRuntimeError, which names the feature.
 *
 * A leaf module: it imports nothing, so every caller (the compiler, the
 * turn runner, the wiki agent runner) can read the flag without a cycle.
 */

/** The runtime a turn runs on: the engine's own loop. */
export type RuntimeName = 'native';

export const RUNTIMES: readonly RuntimeName[] = ['native'];

/** The runtime when neither the turn nor MELCHIZEDEK_RUNTIME names one. */
export const DEFAULT_RUNTIME: RuntimeName = 'native';

/** A runtime that a release removed: `adk` (1.0.0, ADR 0107). */
export class RuntimeRemovedError extends Error {
  readonly runtime: string;

  constructor(runtime: string, source: string) {
    super(
      `${source} is "${runtime}", but the ${runtime} runtime was removed in melchizedek-agents 1.0.0 (ADR 0107): ` +
        `every turn runs on the native runtime. Unset ${source} (or set it to "native"); ` +
        `to stay on ADK, pin melchizedek-agents@0.20.`,
    );
    this.name = 'RuntimeRemovedError';
    this.runtime = runtime;
  }
}

function asRuntime(raw: string, source: string): RuntimeName {
  const value = raw.trim().toLowerCase();
  if (value === 'native') return value;
  if (value === 'adk') throw new RuntimeRemovedError(value, source);
  throw new Error(`${source} must be "native" (the only runtime since 1.0.0).`);
}

/**
 * MELCHIZEDEK_RUNTIME as set, or undefined when unset or blank. `adk`
 * throws RuntimeRemovedError; any other value but `native` is a
 * configuration error. The A2A server and the bins read it at startup.
 */
export function runtimeSetting(env: NodeJS.ProcessEnv = process.env): RuntimeName | undefined {
  const raw = env.MELCHIZEDEK_RUNTIME;
  if (!raw || !raw.trim()) return undefined;
  return asRuntime(raw, 'MELCHIZEDEK_RUNTIME');
}

/** The runtime to use: the caller's option, else MELCHIZEDEK_RUNTIME, else native. Throws for `adk` (see the header). */
export function chooseRuntime(option?: string, env: NodeJS.ProcessEnv = process.env): RuntimeName {
  if (option !== undefined) return asRuntime(option, 'The runtime option');
  return runtimeSetting(env) ?? DEFAULT_RUNTIME;
}

/** A feature the runtime does not run. Thrown before any model call. */
export class UnsupportedOnRuntimeError extends Error {
  readonly feature: string;
  readonly runtime: RuntimeName;

  constructor(feature: string, runtime: RuntimeName, where: string) {
    super(`${where}: ${feature} is not supported on the ${runtime} runtime.`);
    this.name = 'UnsupportedOnRuntimeError';
    this.feature = feature;
    this.runtime = runtime;
  }
}

/** The error for a feature the native runtime does not run; `where` names the agent or syndicate. */
export function unsupportedOnNative(feature: string, where: string): UnsupportedOnRuntimeError {
  return new UnsupportedOnRuntimeError(feature, 'native', where);
}

/** Where the runtime in use came from: the caller's option, MELCHIZEDEK_RUNTIME, or the default. */
export type RuntimeSource = 'option' | 'MELCHIZEDEK_RUNTIME' | 'default';

/** The runtime chooseRuntime picks, and where it came from (the doctor prints both). */
export function describeRuntime(option?: string, env: NodeJS.ProcessEnv = process.env): { runtime: RuntimeName; source: RuntimeSource } {
  if (option !== undefined) return { runtime: asRuntime(option, 'The runtime option'), source: 'option' };
  const set = runtimeSetting(env);
  return set ? { runtime: set, source: 'MELCHIZEDEK_RUNTIME' } : { runtime: DEFAULT_RUNTIME, source: 'default' };
}
