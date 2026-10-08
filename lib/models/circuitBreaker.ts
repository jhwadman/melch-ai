/**
 * lib/models/circuitBreaker.ts — the per-provider circuit breaker behind
 * `fallback_model:` (ADR 0044).
 *
 * WHY its own module:
 *   FallbackAdapter (lib/models/fallbackAdapter.ts) answers a failing
 *   provider from an agent's fallback model, around two adapters on the
 *   engine's own contract (ADR 0048), and the native loop's own fallback
 *   step does the same. Both read and write the circuits here, so a provider
 *   tripped on one path is skipped on the other.
 *
 * THE RULES:
 *   - One circuit per provider id (lib/models/providerMap.ts), shared by
 *     every wrapped agent in the process.
 *   - MODEL_BREAKER_THRESHOLD consecutive failures (default 5; 0 disables)
 *     open it for MODEL_BREAKER_COOLDOWN_MS (default 30 s). Both are read on
 *     every failure, so a change takes effect without a restart.
 *   - While it is open, a wrapper skips the provider and goes straight to
 *     its fallback. After the cooldown, calls go through again; the count
 *     stays at the threshold, so the next failure reopens the circuit at
 *     once and a success closes it.
 *   - The callers decide what counts as a failure: only a provider-side one,
 *     never a request's own error or a canceled turn.
 *
 * A LEAF: no imports, so the contract path (FallbackAdapter) stays free of
 * @google/*.
 */

interface Circuit {
  failures: number;
  openUntil: number;
}

const circuits = new Map<string, Circuit>();

/** One clock for every circuit, so both wrappers compare times from the same source. */
let clock: () => number = Date.now;

/** For tests: replace the breaker's clock. Returns a function that restores the one before. */
export function setBreakerClock(now: () => number): () => void {
  const previous = clock;
  clock = now;
  return () => {
    clock = previous;
  };
}

/** The threshold and cooldown, from the environment. A value that is not a non-negative number falls back to the default. */
export function breakerSettings(env: NodeJS.ProcessEnv = process.env): { threshold: number; cooldownMs: number } {
  const n = (name: string, fallback: number) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
  };
  return { threshold: n('MODEL_BREAKER_THRESHOLD', 5), cooldownMs: n('MODEL_BREAKER_COOLDOWN_MS', 30_000) };
}

/** True while `provider`'s circuit is open (calls skip it). */
export function circuitOpen(provider: string, now = clock()): boolean {
  const c = circuits.get(provider);
  return !!c && c.openUntil > now;
}

/** Counts one provider-side failure; at the threshold the circuit opens for the cooldown. */
export function recordFailure(provider: string, now = clock()): void {
  const { threshold, cooldownMs } = breakerSettings();
  if (threshold === 0) return;
  const c = circuits.get(provider) ?? { failures: 0, openUntil: 0 };
  c.failures += 1;
  if (c.failures >= threshold) c.openUntil = now + cooldownMs;
  circuits.set(provider, c);
}

/** A call that succeeded closes the circuit and clears its count. */
export function recordSuccess(provider: string): void {
  circuits.delete(provider);
}

/** For tests: close every circuit. */
export function resetCircuits(): void {
  circuits.clear();
}
