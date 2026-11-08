/**
 * lib/runtime/claimedJob.ts — one claimed background job, from the claim to
 * its end: the lease kept while it runs, and the job left in exactly one of
 * four ways (ADR 0157). scripts/assistant_worker.ts is the only caller; the
 * policy is here so it can be tested without starting a worker.
 *
 * WHAT THE WORKER KNOWS ABOUT ITS LEASE:
 *   Only the last renewal the store confirmed. keepLease measures from the
 *   moment that renewal was SENT, on this process's own monotonic clock, so
 *   the window it trusts always ends at or before the store's own expiry and
 *   no clock is compared across machines.
 *
 * THE POLICY:
 *   - One renewal runs at a time; the next is scheduled when it has settled.
 *   - A renewal the store answers false ends the claim at once.
 *   - A renewal that throws is retried, sooner than usual, but only inside
 *     the known window. At the window's end the claim is lost, even if a
 *     renewal is still in flight: the worker can no longer say it owns the
 *     job, and the store would refuse its writes anyway.
 *
 * HOW A JOB ENDS (JobEnd):
 *   done         the run finished and the store accepted the result.
 *   failed       the run failed (an ordinary model or tool error) and the
 *                store accepted the error.
 *   interrupted  a graceful stop (SIGTERM): back in the queue with its
 *                checkpoint, or failed after MAX_ATTEMPTS interruptions.
 *   lost         the claim ended: cancelled, reclaimed, or the lease ran out.
 *                Nothing is written; whoever holds the job now owns it.
 *
 * A write that throws (finish, the requeue) is retried with the same outcome
 * for at most one lease, so a database blip neither turns a finished run into
 * a failed one nor loses it. A retry can only be refused as lost, never
 * applied twice, because the first write that lands ends the claim.
 */

import type { DurableTurnResult, CheckpointSink } from './native/checkpoint.ts';
import type { ClaimedTask, FencedTaskBackend, JobOutcome, WorkerLease } from '../tools/taskTools.ts';

/** The run no longer holds its claim (cancelled, taken by another worker, or the lease ran out). */
export class ClaimLost extends Error {}
/** A graceful stop (SIGTERM): the job goes back in the queue, it is not failed. */
export class Interrupted extends Error {}

/** Time as the lease policy reads it; tests supply a fake. */
export interface LeaseClock {
  /** Monotonic milliseconds. */
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: LeaseClock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface LeaseKeeperOptions {
  /** Resolves false when the claim is gone; throws when the store could not answer. */
  renew: () => Promise<boolean>;
  leaseMs: number;
  /** The clock's reading from just before the claim was sent. */
  confirmedAt: number;
  /** Called at most once, with why. */
  onLost: (why: string) => void;
  log?: (line: string) => void;
  clock?: LeaseClock;
}

export interface LeaseKeeper {
  /** The claim has not been lost and the last confirmed lease has not run out. */
  withinLease(): boolean;
  stop(): void;
}

/** Keeps one claim's lease renewed; see the policy in the header. */
export function keepLease(options: LeaseKeeperOptions): LeaseKeeper {
  const clock = options.clock ?? systemClock;
  const every = Math.floor(options.leaseMs / 3);
  const retry = Math.floor(options.leaseMs / 12);
  let expiry = options.confirmedAt + options.leaseMs;
  let ended = false;
  let nextRenewal: unknown;
  let deadline: unknown;

  const end = () => {
    ended = true;
    clock.clearTimeout(nextRenewal);
    clock.clearTimeout(deadline);
  };
  const lose = (why: string) => {
    end();
    options.onLost(why);
  };
  const armDeadline = () => {
    clock.clearTimeout(deadline);
    deadline = clock.setTimeout(() => lose('the lease ran out with no renewal confirmed'), Math.max(0, expiry - clock.now()));
  };
  const renewOnce = async () => {
    const sentAt = clock.now();
    try {
      const kept = await options.renew();
      if (ended) return;
      if (!kept) return lose('the claim is gone: cancelled or taken by another worker');
      expiry = sentAt + options.leaseMs;
      armDeadline();
      nextRenewal = clock.setTimeout(() => void renewOnce(), every);
    } catch (error) {
      if (ended) return;
      options.log?.(`lease renewal failed: ${error instanceof Error ? error.message : String(error)}`);
      nextRenewal = clock.setTimeout(() => void renewOnce(), retry);
    }
  };

  armDeadline();
  nextRenewal = clock.setTimeout(() => void renewOnce(), every);
  return { withinLease: () => !ended && clock.now() < expiry, stop: end };
}

/** What runClaimedJob reads of a finished turn. */
export type JobTurnResult = Pick<DurableTurnResult, 'status' | 'text' | 'lostClaim' | 'resumedFromStep'> & Partial<Pick<DurableTurnResult, 'error'>>;

export type JobEnd = 'done' | 'failed' | 'interrupted' | 'lost';

export interface ClaimedJobOptions {
  backend: FencedTaskBackend;
  lease: WorkerLease;
  job: ClaimedTask;
  /** The clock's reading from just before claimNext was sent. */
  claimedAt: number;
  /** The caller's, so a signal can abort the run with Interrupted. */
  controller: AbortController;
  turn: (args: { signal: AbortSignal; checkpoints: CheckpointSink }) => Promise<JobTurnResult>;
  log: (line: string) => void;
  clock?: LeaseClock;
}

/** Runs one claimed job under its lease and leaves it in exactly one JobEnd. */
export async function runClaimedJob(options: ClaimedJobOptions): Promise<JobEnd> {
  const { backend, lease, job, controller, log } = options;
  const clock = options.clock ?? systemClock;
  const label = job.owner ? `${job.id} (${job.owner})` : job.id;
  const started = clock.now();
  const keeper = keepLease({
    renew: () => backend.renew(lease, job),
    leaseMs: lease.leaseMs,
    confirmedAt: options.claimedAt,
    onLost: (why) => controller.abort(new ClaimLost(why)),
    log,
    clock,
  });

  /** Retries a write that throws, for at most one lease; 'lost' when it never landed. */
  const settled = async <T>(what: string, write: () => Promise<T>): Promise<T | 'lost'> => {
    const giveUpAt = clock.now() + lease.leaseMs;
    for (;;) {
      try {
        return await write();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!keeper.withinLease() || clock.now() >= giveUpAt) {
          log(`${label}: ${what} could not be written (${message}); the job is left to its lease`);
          return 'lost';
        }
        log(`${label}: ${what} not written yet (${message})`);
        await new Promise<void>((resolve) => clock.setTimeout(resolve, Math.floor(lease.leaseMs / 12)));
      }
    }
  };

  const runTurn = async (): Promise<string> => {
    const result = await options.turn({
      signal: controller.signal,
      checkpoints: {
        load: async () => (await backend.loadCheckpoint(job)) as Awaited<ReturnType<CheckpointSink['load']>>,
        save: (checkpoint) => backend.saveCheckpoint(lease, job, checkpoint),
      },
    });
    if (result.resumedFromStep > 0) log(`${job.id} resumed from step ${result.resumedFromStep}`);
    if (result.lostClaim) throw new ClaimLost('the job was cancelled or claimed elsewhere');
    if (controller.signal.reason instanceof ClaimLost || controller.signal.reason instanceof Interrupted) throw controller.signal.reason;
    if (result.status !== 'completed') throw new Error(`${result.error?.code ?? 'ERROR'}: ${result.error?.message ?? ''}`.trim());
    if (!result.text.trim()) throw new Error('the agent returned no text');
    return result.text.trim();
  };

  try {
    let outcome: JobOutcome;
    try {
      outcome = { result: await runTurn() };
    } catch (thrown) {
      const reason = controller.signal.reason;
      const stop = reason instanceof ClaimLost || reason instanceof Interrupted ? reason : thrown;
      if (stop instanceof ClaimLost) {
        // The record already says what happened, or the job is another claim's: nothing is written over it.
        log(`${label} stopped: ${stop.message}`);
        return 'lost';
      }
      if (stop instanceof Interrupted) {
        const requeued = await settled('the requeue', () => backend.requeueInterrupted(job));
        log(`${label} interrupted: ${requeued}`);
        return requeued === 'lost' ? 'lost' : 'interrupted';
      }
      outcome = { error: stop instanceof Error ? stop.message : String(stop) };
    }

    const finished = await settled('the outcome', () => backend.finish(job, outcome));
    if (finished === 'lost') {
      log(`${label} lost its claim before its outcome was recorded; nothing was written`);
      return 'lost';
    }
    if ('error' in outcome) {
      log(`${label} failed: ${outcome.error}`);
      return 'failed';
    }
    log(`${label} done in ${Math.round((clock.now() - started) / 1000)} s`);
    return 'done';
  } finally {
    keeper.stop();
  }
}
