/**
 * tests/claimedJob.test.ts — the worker's lease policy and the end of one
 * claimed job (lib/runtime/claimedJob.ts, ADR 0157), on a fake clock and a
 * fake backend: one renewal at a time, a failing renewal retried only inside
 * the last window the store confirmed, and a lost claim told apart from a
 * graceful stop and from an ordinary error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClaimLost, Interrupted, keepLease, runClaimedJob } from '../lib/runtime/claimedJob.ts';
import type { JobTurnResult, LeaseClock } from '../lib/runtime/claimedJob.ts';
import type { ClaimedTask, FencedTaskBackend, JobOutcome, WorkerLease } from '../lib/tools/taskTools.ts';

const LEASE = 60_000;

/** Timers that fire only when the test advances the clock; each firing lets promises settle. */
class FakeClock implements LeaseClock {
  t = 0;
  private next = 1;
  private timers = new Map<number, { at: number; run: () => void }>();
  now = () => this.t;
  setTimeout = (run: () => void, ms: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, run });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number);
  };
  get pending() {
    return this.timers.size;
  }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const due = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].run();
    }
    this.t = end;
    await flush();
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function keeper(renew: () => Promise<boolean>, clock: FakeClock, confirmedAt = 0) {
  const lost: string[] = [];
  const logged: string[] = [];
  const k = keepLease({ renew, leaseMs: LEASE, confirmedAt, clock, onLost: (why) => lost.push(why), log: (l) => logged.push(l) });
  return { k, lost, logged };
}

test('one renewal at a time: a slow renewal is not overlapped', async () => {
  const clock = new FakeClock();
  const slow = deferred<boolean>();
  let calls = 0;
  const { k, lost } = keeper(() => {
    calls += 1;
    return calls === 1 ? slow.promise : Promise.resolve(true);
  }, clock);
  await clock.advance(50_000);
  assert.equal(calls, 1, 'the second interval waits on the first renewal');
  assert.deepEqual(lost, []);
  slow.resolve(true);
  await clock.advance(20_000);
  assert.equal(calls, 2, 'the next renewal follows the settled one');
  k.stop();
});

test('a renewal that throws inside the known window retries, and a success renews the window', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const { k, lost, logged } = keeper(async () => {
    calls += 1;
    if (calls <= 2) throw new Error('connection reset');
    return true;
  }, clock);
  await clock.advance(20_000 + 5_000 + 5_000);
  assert.equal(calls, 3, 'retried sooner than the usual interval');
  assert.deepEqual(lost, []);
  assert.match(logged[0]!, /connection reset/);
  await clock.advance(70_000);
  assert.deepEqual(lost, [], 'the window moved with the success');
  k.stop();
});

test('a renewal that keeps throwing stops the run at the last confirmed expiry', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const { k, lost } = keeper(async () => {
    calls += 1;
    throw new Error('database is down');
  }, clock);
  await clock.advance(59_999);
  assert.deepEqual(lost, [], 'still inside the window');
  await clock.advance(1);
  assert.equal(lost.length, 1, 'past it, the claim is lost');
  assert.match(lost[0]!, /lease/);
  const atExpiry = calls;
  await clock.advance(120_000);
  assert.equal(calls, atExpiry, 'no renewal after the loss');
  assert.equal(lost.length, 1, 'reported once');
  assert.equal(clock.pending, 0);
  k.stop();
});

test('a renewal that hangs past the known expiry stops the run', async () => {
  const clock = new FakeClock();
  const { k, lost } = keeper(() => new Promise<boolean>(() => {}), clock);
  await clock.advance(60_000);
  assert.equal(lost.length, 1);
  k.stop();
});

test('the store answering false loses the claim at once', async () => {
  const clock = new FakeClock();
  const { k, lost } = keeper(async () => false, clock);
  await clock.advance(20_000);
  assert.equal(lost.length, 1);
  assert.match(lost[0]!, /claim/);
  assert.equal(clock.pending, 0);
  k.stop();
});

test('the window is measured from when a confirmed renewal was sent, not when its answer came', async () => {
  const clock = new FakeClock();
  const answer = deferred<boolean>();
  let calls = 0;
  const { k, lost } = keeper(() => {
    calls += 1;
    return calls === 1 ? answer.promise : Promise.reject(new Error('down'));
  }, clock);
  await clock.advance(20_000); // sent at 20 s
  await clock.advance(10_000);
  answer.resolve(true); // answered at 30 s: the lease is known to 20 + 60 = 80 s
  await clock.advance(49_999);
  assert.deepEqual(lost, []);
  await clock.advance(1);
  assert.equal(lost.length, 1);
  k.stop();
});

test('a claim that took long counts from before it was sent; stop cancels everything', async () => {
  const clock = new FakeClock();
  clock.t = 10_000;
  const { k, lost } = keeper(async () => true, clock, 0);
  assert.equal(k.withinLease(), true);
  k.stop();
  assert.equal(clock.pending, 0);
  await clock.advance(120_000);
  assert.deepEqual(lost, []);
});

// ── One claimed job ──────────────────────────────────────────────────────────

const lease: WorkerLease = { workerId: 'w', leaseMs: LEASE };
const job = { id: 't1', owner: 'o', kind: 'background', status: 'running', title: 'x', instruction: 'y', created_at: '', updated_at: '', claim: { workerId: 'w', token: 'tok' } } as ClaimedTask;

function fakeBackend(over: Partial<FencedTaskBackend> = {}) {
  const finishes: JobOutcome[] = [];
  const requeues: number[] = [];
  const backend = {
    fencedClaims: true,
    renew: async () => true,
    saveCheckpoint: async () => true,
    loadCheckpoint: async () => null,
    finish: async (_job: unknown, outcome: JobOutcome) => {
      finishes.push(outcome);
      return 'accepted';
    },
    requeueInterrupted: async () => {
      requeues.push(1);
      return 'requeued';
    },
    ...over,
  } as unknown as FencedTaskBackend;
  return { backend, finishes, requeues };
}

const completed = (text = 'the answer'): JobTurnResult => ({ status: 'completed', text, lostClaim: false, resumedFromStep: 0 });

/** A turn that runs until it is aborted, as a model call in flight does, then ends the way an aborted run ends. */
const untilAborted = ({ signal }: { signal: AbortSignal }) =>
  new Promise<JobTurnResult>((resolve) => {
    signal.addEventListener('abort', () => resolve({ status: 'canceled', text: '', lostClaim: false, resumedFromStep: 0 }), { once: true });
  });

function run(backend: FencedTaskBackend, turn: Parameters<typeof runClaimedJob>[0]['turn'], clock = new FakeClock()) {
  const controller = new AbortController();
  const logged: string[] = [];
  const end = runClaimedJob({ backend, lease, job, claimedAt: clock.now(), controller, turn, log: (l) => logged.push(l), clock });
  return { end, controller, logged, clock };
}

test('a completed run records its result', async () => {
  const f = fakeBackend();
  const { end, logged } = run(f.backend, async () => completed());
  assert.equal(await end, 'done');
  assert.deepEqual(f.finishes, [{ result: 'the answer' }]);
  assert.match(logged.join('\n'), /t1 \(o\) done/);
});

test('a renewal that says the claim is gone aborts the run with ClaimLost and writes nothing', async () => {
  const f = fakeBackend({ renew: async () => false });
  const clock = new FakeClock();
  const seen: unknown[] = [];
  const { end, controller } = run(
    f.backend,
    (args) => {
      args.signal.addEventListener('abort', () => seen.push(args.signal.reason), { once: true });
      return untilAborted(args);
    },
    clock,
  );
  await clock.advance(20_000);
  assert.equal(await end, 'lost');
  assert.ok(controller.signal.reason instanceof ClaimLost);
  assert.ok(seen[0] instanceof ClaimLost);
  assert.deepEqual(f.finishes, []);
  assert.deepEqual(f.requeues, []);
});

test('renewals failing past the known expiry stop the run; failing inside it does not', async () => {
  let up = false;
  const f = fakeBackend({
    renew: async () => {
      if (!up) throw new Error('down');
      return true;
    },
  });
  const clock = new FakeClock();
  const gate = deferred<void>();
  const { end } = run(f.backend, async ({ signal }) => {
    await Promise.race([gate.promise, new Promise((r) => signal.addEventListener('abort', r, { once: true }))]);
    return signal.aborted ? { status: 'canceled', text: '', lostClaim: false, resumedFromStep: 0 } : completed('survived');
  }, clock);

  // Failing for 30 s, inside the 60 s window, and then back.
  await clock.advance(30_000);
  up = true;
  await clock.advance(10_000);
  gate.resolve();
  assert.equal(await end, 'done');
  assert.deepEqual(f.finishes, [{ result: 'survived' }]);

  const g = fakeBackend({ renew: async () => Promise.reject(new Error('down')) });
  const later = new FakeClock();
  const stopped = run(g.backend, untilAborted, later);
  await later.advance(60_000);
  assert.equal(await stopped.end, 'lost');
  assert.deepEqual(g.finishes, []);
});

test('SIGTERM is a graceful stop: a requeue under the claim, distinct from a lost claim', async () => {
  const f = fakeBackend();
  const { end, controller } = run(f.backend, untilAborted);
  controller.abort(new Interrupted('SIGTERM'));
  assert.equal(await end, 'interrupted');
  assert.deepEqual(f.requeues, [1]);
  assert.deepEqual(f.finishes, []);
});

test('SIGTERM after the claim is gone requeues nothing and reports the loss', async () => {
  const f = fakeBackend({ requeueInterrupted: async () => 'lost' });
  const { end, controller, logged } = run(f.backend, untilAborted);
  controller.abort(new Interrupted('SIGTERM'));
  assert.equal(await end, 'lost');
  assert.match(logged.join('\n'), /interrupted: lost/);
});

test('an ordinary model error is recorded as the job\'s failure', async () => {
  const f = fakeBackend();
  const { end } = run(f.backend, async () => ({ status: 'failed', text: '', lostClaim: false, resumedFromStep: 0, error: { code: 'MODEL_ERROR', message: 'the provider said no' } }));
  assert.equal(await end, 'failed');
  assert.deepEqual(f.finishes, [{ error: 'MODEL_ERROR: the provider said no' }]);
});

test('a checkpoint save that found the claim gone ends the run as lost', async () => {
  const f = fakeBackend();
  const { end } = run(f.backend, async () => ({ status: 'canceled', text: '', lostClaim: true, resumedFromStep: 0 }));
  assert.equal(await end, 'lost');
  assert.deepEqual(f.finishes, []);
});

test('a finish reported lost is not a success', async () => {
  const f = fakeBackend({ finish: async () => 'lost' });
  const { end, logged } = run(f.backend, async () => completed());
  assert.equal(await end, 'lost');
  assert.doesNotMatch(logged.join('\n'), /done in/);
});

test('a finish that throws is retried with the same outcome inside the window, never turned into a failure', async () => {
  const outcomes: JobOutcome[] = [];
  const f = fakeBackend({
    finish: async (_j, outcome) => {
      outcomes.push(outcome);
      if (outcomes.length === 1) throw new Error('connection reset');
      return 'accepted';
    },
  });
  const clock = new FakeClock();
  const { end } = run(f.backend, async () => completed(), clock);
  await clock.advance(5_000);
  assert.equal(await end, 'done');
  assert.deepEqual(outcomes, [{ result: 'the answer' }, { result: 'the answer' }]);
});

test('a finish that keeps throwing gives up inside one lease, and is not reported done', async () => {
  const f = fakeBackend({ finish: async () => Promise.reject(new Error('down')) });
  const clock = new FakeClock();
  const { end, logged } = run(f.backend, async () => completed(), clock);
  await clock.advance(61_000);
  assert.equal(await end, 'lost');
  assert.doesNotMatch(logged.join('\n'), /done in/);
});
