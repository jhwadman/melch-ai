/**
 * lib/runtime/logging.ts — the engine's log level (ADR 0080).
 *
 * WHY this file exists:
 *   A surface (the A2A server bin, the REPL, the worker, the demos) chooses
 *   how much the engine prints. That choice is the engine's, set here,
 *   rather than a call to ADK's logger from every script. While the ADK
 *   runtime is loaded it follows this level: lib/compileAdk.ts subscribes
 *   and sets ADK's logger to the same level, so a surface that runs a turn
 *   never names ADK to quiet it. When ADK leaves, that subscription goes and
 *   nothing else changes.
 *
 * DEFAULT: `info`, and nothing is pushed to a subscriber until a surface
 *   sets a level. A process that never calls setLogLevel keeps ADK's own
 *   default, and a test that sets ADK's level itself keeps what it set.
 *
 * A leaf: no imports, so nothing in its import graph names @google/*.
 */

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

/** Most verbose first. */
export const LOG_LEVELS: readonly LogLevelName[] = ['debug', 'info', 'warn', 'error'];

let current: LogLevelName = 'info';
let chosen = false;
const listeners = new Set<(level: LogLevelName) => void>();

function isLevel(value: unknown): value is LogLevelName {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Sets the level for the process and tells every subscriber. Throws on an unknown level. */
export function setLogLevel(level: LogLevelName): void {
  if (!isLevel(level)) throw new Error(`Unknown log level: expected one of ${LOG_LEVELS.join(', ')}.`);
  current = level;
  chosen = true;
  for (const listener of listeners) listener(level);
}

/** The level in force. */
export function logLevel(): LogLevelName {
  return current;
}

/** Whether a line at `level` is shown at the level in force. */
export function logs(level: LogLevelName): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(current);
}

/**
 * Calls `listener` on every change of level, and at once when a surface has
 * already set one. Returns the unsubscribe.
 */
export function onLogLevel(listener: (level: LogLevelName) => void): () => void {
  listeners.add(listener);
  if (chosen) listener(current);
  return () => {
    listeners.delete(listener);
  };
}
