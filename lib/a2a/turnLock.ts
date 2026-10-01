/**
 * lib/a2a/turnLock.ts — one turn at a time per conversation (ADR 0021).
 *
 * Two turns on one conversation would interleave their events in one
 * session: each would answer without the other's exchange and the history
 * would read out of order. So the executor takes a lock on the conversation
 * (namespace, scope, context id) for the length of a turn. A second turn
 * waits for the first, up to a limit, and is then refused with a message the
 * client can show.
 *
 * The default lock lives in the process, which is exact for one instance.
 * postgresStorage supplies an advisory lock instead, shared by every
 * instance on the database (lib/storage/postgres/index.ts).
 */

/** Releases a held lock. Safe to call more than once. */
export type ReleaseTurnLock = () => Promise<void>;

/**
 * Acquire the lock for `key`, waiting up to `waitMs`. Resolves to a release
 * function, or to null when the wait ran out (or `signal` aborted).
 */
export type TurnLock = (key: string, options: { waitMs: number; signal?: AbortSignal }) => Promise<ReleaseTurnLock | null>;

/** A lock held in this process: exact for a single instance. */
export function inProcessTurnLock(): TurnLock {
  const held = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();

  const wake = (key: string) => {
    const queue = waiters.get(key);
    const next = queue?.shift();
    if (!queue?.length) waiters.delete(key);
    next?.();
  };

  return async (key, { waitMs, signal }) => {
    if (held.has(key)) {
      const got = await new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (!ok) {
            const queue = waiters.get(key);
            const i = queue?.indexOf(onWake) ?? -1;
            if (queue && i !== -1) queue.splice(i, 1);
            if (queue && !queue.length) waiters.delete(key);
          }
          resolve(ok);
        };
        const onWake = () => finish(true);
        const onAbort = () => finish(false);
        const timer = setTimeout(() => finish(false), Math.max(0, waitMs));
        signal?.addEventListener('abort', onAbort, { once: true });
        const queue = waiters.get(key) ?? [];
        queue.push(onWake);
        waiters.set(key, queue);
      });
      if (!got) return null;
      // Woken: the previous holder handed the lock straight to this waiter.
    } else {
      held.add(key);
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (waiters.get(key)?.length) wake(key); // hand over without unlocking
      else held.delete(key);
    };
  };
}

/** The lock key for one conversation: namespace, caller scope, context id. */
export function turnLockKey(namespace: string, scopeKey: string, contextId: string): string {
  return `${namespace}\u0000${scopeKey}\u0000${contextId}`;
}
