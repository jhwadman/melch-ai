/**
 * lib/runtime/native/tempState.ts — the run's `temp:` state, kept beside
 * the session and never in it (ADR 0071, ADR 0073).
 *
 * WHY this file exists:
 *   On the ADK runtime a tool's `state.set('temp:x', …)` writes into the
 *   live session object as well as the event's delta, so the next step of
 *   the same invocation reads it (an instruction's `{temp:x}`, a tool's
 *   `state.get`), and the store drops it when it saves the event. The
 *   native loop applies a delta to the session only through the store
 *   (SessionService.append), which drops `temp:` keys as every store must.
 *   Writing them into the session object instead would reach a store that
 *   saves the whole session (the Supabase store does). So the run keeps
 *   them here: every event the loop stores is read for its `temp:` keys
 *   before the store sees it, and each step reads the session's state with
 *   these laid over it.
 *
 * Own keys only, set as own properties, so a key such as `__proto__` is a
 * key and never a prototype.
 */

import { TEMP_STATE_PREFIX } from '../sessions.ts';
import type { TurnEvent } from '../events.ts';

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** The `temp:` keys one run has written so far. */
export interface RunTempState {
  /** Reads `event`'s delta for `temp:` keys. Call it before the event is stored: the store drops them. */
  record(event: TurnEvent): void;
  /** The keys written so far, as a new object. */
  values(): Record<string, unknown>;
}

export function createRunTempState(): RunTempState {
  const held: Record<string, unknown> = {};
  return {
    record(event) {
      if (event.partial) return;
      const delta = event.actions?.stateDelta;
      if (!delta) return;
      for (const [key, value] of Object.entries(delta)) if (key.startsWith(TEMP_STATE_PREFIX)) setOwn(held, key, value);
    },
    values() {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(held)) setOwn(out, key, value);
      return out;
    },
  };
}

/** `state` with `overlay`'s keys laid over it, as a new object; `state` itself when there is nothing to lay. */
export function withStateOverlay(
  state: Readonly<Record<string, unknown>>,
  overlay: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (!overlay || Object.keys(overlay).length === 0) return state;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) setOwn(out, key, value);
  for (const [key, value] of Object.entries(overlay)) setOwn(out, key, value);
  return out;
}
