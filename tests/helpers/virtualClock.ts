/**
 * tests/helpers/virtualClock.ts — stub delays on a clock the test controls,
 * so a workflow case's finish order is its timeline's and never a race
 * between real timers.
 *
 * `clock.sleep(ms)` waits until the clock reaches its start plus `ms`. The
 * clock moves only when the process has settled: every microtask drained,
 * no immediate and no file read pending, so whatever the last finish set
 * off (stored events, the next nodes started, their own sleeps registered)
 * has happened before the next sleep ends. Then the earliest sleep ends,
 * ties in the order they were registered, one at a time. The engines under
 * test (ADK's Workflow, the native scheduler) run as they are; only the
 * stubs' waiting is the clock's.
 *
 * A virtual sleep does not race a real timer: the clock does not wait for
 * one. A case whose stubs race a node timeout or a retry's backoff waits on
 * real time instead, with its finish times far apart.
 */

import { setImmediate as nextImmediate } from 'node:timers/promises';

/** Pending work the clock waits for before it moves: an immediate, a file read (a module loading). */
const PENDING = /^(Immediate|FSReq)/;

/** Turns a settle waits at most. */
const MAX_TURNS = 10_000;

/** The settle under way: every clock in the process shares it, so no clock's turns keep another's from settling. */
let settling: Promise<void> | undefined;

/**
 * Resolves once nothing but timers and idle handles is left: every microtask
 * drained, no immediate or file read pending, for three turns in a row (so
 * work an immediate hands on to the next turn is seen too). A process that
 * never settles (something polling on immediates) moves on after
 * MAX_TURNS turns rather than hang the test.
 */
function settled(): Promise<void> {
  settling ??= (async () => {
    for (let quiet = 0, turns = 0; quiet < 3 && turns < MAX_TURNS; turns++) {
      await nextImmediate();
      quiet = process.getActiveResourcesInfo().some((r) => PENDING.test(r)) ? 0 : quiet + 1;
    }
  })().finally(() => {
    settling = undefined;
  });
  return settling;
}

export interface VirtualClock {
  /** Waits `ms` on the clock (0 included: it still ends in its turn). */
  sleep(ms: number): Promise<void>;
  /** The clock's time, in ms since it was made. */
  readonly now: number;
}

export function virtualClock(): VirtualClock {
  let now = 0;
  let seq = 0;
  const sleepers: Array<{ at: number; seq: number; wake: () => void }> = [];
  let running = false;

  async function run(): Promise<void> {
    running = true;
    try {
      for (;;) {
        await settled();
        if (sleepers.length === 0) return;
        sleepers.sort((x, y) => x.at - y.at || x.seq - y.seq);
        const next = sleepers.shift()!;
        now = next.at;
        next.wake();
      }
    } finally {
      running = false;
    }
  }

  return {
    sleep(ms: number) {
      return new Promise<void>((wake) => {
        sleepers.push({ at: now + Math.max(0, ms), seq: seq++, wake });
        if (!running) void run();
      });
    },
    get now() {
      return now;
    },
  };
}
