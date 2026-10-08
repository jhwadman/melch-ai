/**
 * tests/helpers/runtime.ts — the turn-level suites on both runtimes (WS2-12,
 * ADR 0045's G2, ADR 0084).
 *
 * `forEachRuntime(name, fn)` registers one test per runtime, named
 * `name [adk]` and `name [native]`, so every `npm test` runs the case on
 * both whatever MELCHIZEDEK_RUNTIME says. Inside, the runtime reaches the
 * turn two ways, as each surface allows:
 *
 *   - a suite that calls runSyndicateTurn spreads `runtimeOption()` into
 *     its options (the turn's own `runtime`, ADR 0073), usually in its one
 *     turn helper;
 *   - a suite that goes through createA2AApp or a script cannot pass an
 *     option, so the helper sets MELCHIZEDEK_RUNTIME for the test's body
 *     and puts back what was there (unset included) when it ends, pass or
 *     fail.
 *
 * Both are set for every case, so a helper that forgets the option still
 * runs on the runtime the test is named for.
 *
 * `acrossRuntimes(name, fn)` registers the conversation written on one
 * runtime and continued on the other, both ways (`adk → native`,
 * `native → adk`): the rollback path until 1.0 is a native-written session
 * resuming under adk.
 *
 * A case one runtime cannot run yet is never skipped silently: `notOn`
 * names the runtime, the reason and the ticket that lifts it, and that
 * runtime's test is registered as skipped, the reason on its SKIP line.
 * `differsOn` is a known difference still open (an open question of the
 * PR that found it): the case runs as a todo, so the output shows whether
 * it still differs without failing the suite. Every other difference
 * between the runtimes is a defect of the native path.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { RUNTIMES } from '../../lib/runtime/runtimeFlag.ts';
import type { RuntimeName } from '../../lib/runtime/runtimeFlag.ts';

export type { RuntimeName };
export { RUNTIMES };

/** The other runtime. */
export const otherRuntime = (runtime: RuntimeName): RuntimeName => (runtime === 'adk' ? 'native' : 'adk');

const current = new AsyncLocalStorage<RuntimeName>();

/** The runtime of the forEachRuntime case running now; undefined outside one (the turn then follows MELCHIZEDEK_RUNTIME). */
export function testRuntime(): RuntimeName | undefined {
  return current.getStore();
}

/** The turn's runtime option for the case running now: `{ runtime }` inside forEachRuntime, else nothing. Spread it into runSyndicateTurn's options. */
export function runtimeOption(): { runtime?: RuntimeName } {
  const runtime = current.getStore();
  return runtime ? { runtime } : {};
}

/** A reason a runtime cannot run a case yet, naming the ticket that lifts it. */
export interface NotYet {
  reason: string;
  ticket: string;
}

export interface RuntimeCaseOptions {
  /** Runtimes that cannot run the case yet: registered as skipped, with the reason and the ticket. */
  notOn?: Partial<Record<RuntimeName, NotYet>>;
  /** Runtimes where the case is a known, open difference: run as a todo, with the reason. */
  differsOn?: Partial<Record<RuntimeName, string>>;
  /** Skips the case on both runtimes, as test's own option does (a suite whose service is absent). */
  skip?: boolean | string;
  timeout?: number;
}

/** Runs `body`, then puts MELCHIZEDEK_RUNTIME back as it was (unset included), pass or fail. */
export async function keepingRuntimeEnv<T>(body: () => T | Promise<T>): Promise<T> {
  const had = Object.hasOwn(process.env, 'MELCHIZEDEK_RUNTIME');
  const before = process.env.MELCHIZEDEK_RUNTIME;
  try {
    return await body();
  } finally {
    if (had) process.env.MELCHIZEDEK_RUNTIME = before;
    else delete process.env.MELCHIZEDEK_RUNTIME;
  }
}

/** Runs `body` with MELCHIZEDEK_RUNTIME set to `runtime`, then puts back what was there. */
export function withRuntimeEnv<T>(runtime: RuntimeName, body: () => T | Promise<T>): Promise<T> {
  return keepingRuntimeEnv(() => {
    process.env.MELCHIZEDEK_RUNTIME = runtime;
    return body();
  });
}

/** Runs `body` as the runtime's case: the turn option through testRuntime(), and MELCHIZEDEK_RUNTIME. */
export function onRuntime<T>(runtime: RuntimeName, body: () => T | Promise<T>): Promise<T> {
  return current.run(runtime, () => withRuntimeEnv(runtime, body));
}

function register(name: string, runtime: RuntimeName, options: RuntimeCaseOptions, fn: (t: TestContext) => unknown): void {
  const notYet = options.notOn?.[runtime];
  const differs = options.differsOn?.[runtime];
  const testOptions = {
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.skip ? { skip: options.skip } : {}),
    ...(notYet ? { skip: `not on ${runtime} yet: ${notYet.reason} (${notYet.ticket})` } : {}),
    ...(differs ? { todo: `differs on ${runtime}: ${differs}` } : {}),
  };
  test(name, testOptions, async (t) => {
    await fn(t);
  });
}

/** One test per runtime, `name [adk]` and `name [native]`; `fn` runs with that runtime set (see the header). */
export function forEachRuntime(name: string, fn: (runtime: RuntimeName, t: TestContext) => unknown, options: RuntimeCaseOptions = {}): void {
  for (const runtime of RUNTIMES) {
    register(`${name} [${runtime}]`, runtime, options, (t) => onRuntime(runtime, () => fn(runtime, t)));
  }
}

/**
 * One test per direction, `name [adk → native]` and `name [native → adk]`:
 * `fn` gets the runtime that writes the conversation and the one that
 * continues it, and switches between them with `onRuntime` (or by passing
 * the runtime option itself). MELCHIZEDEK_RUNTIME is put back after.
 */
export function acrossRuntimes(
  name: string,
  fn: (writer: RuntimeName, reader: RuntimeName, t: TestContext) => unknown,
  options: Omit<RuntimeCaseOptions, 'differsOn'> = {},
): void {
  for (const writer of RUNTIMES) {
    const reader = otherRuntime(writer);
    // A direction is blocked when either of its runtimes cannot run the case.
    const blockedOn = [writer, reader].find((r) => options.notOn?.[r]);
    const caseOptions: RuntimeCaseOptions = { ...(options.timeout !== undefined ? { timeout: options.timeout } : {}), ...(options.skip ? { skip: options.skip } : {}), ...(blockedOn ? { notOn: { [blockedOn]: options.notOn![blockedOn]! } } : {}) };
    register(`${name} [${writer} → ${reader}]`, blockedOn ?? writer, caseOptions, (t) => keepingRuntimeEnv(() => fn(writer, reader, t)));
  }
}
