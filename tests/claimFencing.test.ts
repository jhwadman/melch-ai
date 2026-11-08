/**
 * tests/claimFencing.test.ts — a background job's mutations are bound to one
 * claim (ADR 0157), on the real schema, offline on embedded Postgres (PGlite)
 * with every migration, and on the JSON file store.
 *
 * A worker id names a process; a claim token names one claim. So a stale
 * worker, or the same worker id claiming the job again, can change nothing
 * the current claim holds. Interleavings that need two transactions really
 * open at once are in tests/postgresStorage.test.ts (TEST_DATABASE_URL).
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { z } from 'zod';

import { inProcessTurnLock, postgresStorage } from '../lib/storage/postgres/index.ts';
import type { PostgresStorage } from '../lib/storage/postgres/index.ts';
import { runClaimedJob } from '../lib/runtime/claimedJob.ts';
import { claimCheckpoints, runDurableTurn } from '../lib/runtime/native/checkpoint.ts';
import type { CheckpointSink } from '../lib/runtime/native/checkpoint.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { postgresTaskBackend } from '../lib/storage/postgres/taskQueue.ts';
import { defineTool, executeContract } from '../lib/tools/toolContract.ts';
import { fileTaskBackendWith, requireFencedBackend, setTaskBackend, fileTaskBackend, taskGetContract, taskQueueContract } from '../lib/tools/taskTools.ts';
import type { OwnedTask, TaskBackend, WorkerLease } from '../lib/tools/taskTools.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall, untilAborted } from './helpers/scriptedModel.ts';

const INSTALL = [...readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => `db/migrations/${f}`), 'db/hardening.sql'];

const dir = mkdtempSync(join(tmpdir(), 'melch-fencing-'));
let n = 0;
let db: PGlite;
let server: PGLiteSocketServer;
let storage: PostgresStorage;
let cappedPool: pg.Pool;
/** The same queue, with a cap every checkpoint here is over: the save path that writes nothing. */
let capped: ReturnType<typeof postgresTaskBackend>;

before(async () => {
  db = await PGlite.create({ extensions: { vector } });
  for (const f of INSTALL) await db.exec(readFileSync(f, 'utf-8'));
  server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 16 });
  await server.start();
  const { port } = (server as unknown as { server: { address(): { port: number } } }).server.address();
  const connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;
  storage = postgresStorage({ connectionString, poolConfig: { max: 2 }, turnLock: inProcessTurnLock() });
  cappedPool = new pg.Pool({ connectionString, max: 1 });
  capped = postgresTaskBackend(cappedPool, { checkpointMaxBytes: 5, log: () => {} });
});

after(async () => {
  await storage?.close();
  await cappedPool?.end();
  await server?.stop();
  await db?.close();
  delete process.env.MELCHIZEDEK_TASKS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.MELCHIZEDEK_TASKS_FILE = join(dir, `tasks-${n++}.json`);
  await db.query('DELETE FROM melchizedek_tasks'); // claimNext takes the oldest job of any owner
});

const A: WorkerLease = { workerId: 'worker-a', leaseMs: 60_000 };
const B: WorkerLease = { workerId: 'worker-b', leaseMs: 60_000 };

let owners = 0;
/** A fresh owner with one queued job, so no test sees another's. */
async function queued(): Promise<string> {
  const owner = `owner-${owners++}`;
  await storage.taskQueue.mutate(owner, (s) => {
    s.tasks.push({ id: `t${s.next_id}`, kind: 'background', status: 'queued', title: 'job', instruction: 'do it', created_at: '', updated_at: '' });
    s.next_id += 1;
  });
  return owner;
}

const row = async (job: Pick<OwnedTask, 'owner' | 'id'>) =>
  (await db.query<any>(`SELECT status, record, lease_owner, claim_token, checkpoint FROM melchizedek_tasks WHERE owner = $1 AND id = $2`, [job.owner, job.id])).rows[0];

/** The lease ran out, and no reaper has run. */
const expire = (job: Pick<OwnedTask, 'owner' | 'id'>) =>
  db.query(`UPDATE melchizedek_tasks SET lease_until = now() - interval '1 second' WHERE owner = $1 AND id = $2`, [job.owner, job.id]);

/** Takes the job back through recover, then claims it for `worker`. */
async function reclaim(job: OwnedTask, worker: WorkerLease): Promise<OwnedTask> {
  await expire(job);
  await storage.taskQueue.recover();
  const next = await storage.taskQueue.claimNext(worker);
  assert.equal(next?.id, job.id);
  assert.equal(next?.owner, job.owner);
  return next!;
}

// ── 1. The claim token ───────────────────────────────────────────────────────

test('two claims by the same worker id carry different tokens, recorded with the claim', async () => {
  const q = storage.taskQueue;
  const first = (await queued(), (await q.claimNext(A))!);
  assert.ok(first.claim?.token, 'the claim carries a token');
  assert.equal(first.claim!.workerId, A.workerId);
  assert.equal((await row(first)).claim_token, first.claim!.token);

  const second = await reclaim(first, A);
  assert.ok(second.claim?.token);
  assert.notEqual(second.claim!.token, first.claim!.token, 'a reused worker id gets a new token');
  assert.equal((await row(second)).claim_token, second.claim!.token);
  await q.mutate(second.owner, (s) => { s.tasks = []; });
});

test('Postgres: the token is never in the record, read() or task_get', async () => {
  const q = storage.taskQueue;
  const owner = await queued();
  const job = (await q.claimNext(A))!;
  const token = job.claim!.token;
  assert.ok(!JSON.stringify((await row(job)).record).includes(token), 'not in the stored record');
  assert.ok(!JSON.stringify(await q.read(owner)).includes(token), 'not in read()');
  setTaskBackend(q);
  try {
    const shown = String(await taskGetContract.execute({ id: job.id } as any, { userId: owner }));
    assert.match(shown, /running/);
    assert.ok(!shown.includes(token), 'not in task_get');
  } finally {
    setTaskBackend(fileTaskBackend);
  }
  await q.mutate(owner, (s) => { s.tasks = []; });
});

test('file store: two claims by one worker differ, and the token is never in read() or task_get', async () => {
  const q = fileTaskBackendWith();
  await executeContract(taskQueueContract, { title: 'One', instruction: 'Do the first thing.' });
  await executeContract(taskQueueContract, { title: 'Two', instruction: 'Do the second thing.' });
  const one = (await q.claimNext(A))!;
  const two = (await q.claimNext(A))!;
  assert.ok(one.claim?.token && two.claim?.token);
  assert.notEqual(one.claim!.token, two.claim!.token);
  assert.equal(one.claim!.workerId, A.workerId);
  assert.ok(!JSON.stringify(await q.read('')).includes(one.claim!.token), 'not in read()');
  const shown = String(await executeContract(taskGetContract, { id: one.id }));
  assert.ok(!shown.includes(one.claim!.token), 'not in task_get');
});

test('the operator view does not show the token, and the migration records itself', async () => {
  const columns = (await db.query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'melchizedek_task_queue'`)).rows.map((r) => r.column_name);
  assert.ok(!columns.includes('claim_token'), 'the operator view does not show the token');
  const version = (await db.query<any>(`SELECT 1 FROM melchizedek_schema_version WHERE name = '0025_task_claim_token'`)).rows;
  assert.equal(version.length, 1, 'the migration records itself');
});

// ── 2. Every mutation is fenced ──────────────────────────────────────────────

/** Everything of a job a mutation could change. */
const state = async (job: Pick<OwnedTask, 'owner' | 'id'>) =>
  (await db.query<any>(`SELECT status, record, lease_owner, lease_until, claim_token, checkpoint, checkpoint_at, updated_at FROM melchizedek_tasks WHERE owner = $1 AND id = $2`, [job.owner, job.id])).rows[0];

/** `worker`, holding the stale `job`, tries every worker mutation: none reports success. */
async function everyMutationRefused(worker: WorkerLease, job: OwnedTask) {
  const q = storage.taskQueue;
  assert.equal(await q.renew(worker, job), false, 'renew');
  assert.equal(await q.saveCheckpoint(worker, job, { step: 'stale' }), false, 'saveCheckpoint');
  assert.equal(await capped.saveCheckpoint(worker, job, { step: 'stale, and over the cap' }), false, 'saveCheckpoint over the cap');
  assert.equal(await q.finish(job, { result: 'stale result' }), 'lost', 'finish with a result');
  assert.equal(await q.finish(job, { error: 'stale error' }), 'lost', 'finish with an error');
  assert.equal(await q.requeueInterrupted(job), 'lost', 'interrupted requeue');
}

test('worker A expires, B reclaims: every mutation A attempts is refused and changes nothing of B\'s', async () => {
  const q = storage.taskQueue;
  await queued();
  const stale = (await q.claimNext(A))!;
  assert.equal(await q.saveCheckpoint(A, stale, { step: 1 }), true);
  const current = await reclaim(stale, B);
  assert.equal(await q.saveCheckpoint(B, current, { step: 2 }), true);
  const before = await state(current);

  await everyMutationRefused(A, stale);

  assert.deepEqual(await state(current), before, 'B\'s job is untouched');
  assert.equal(await q.renew(B, current), true, 'and B still holds it');
});

test('the same worker id on a new claim: the old claim is as stale as another worker\'s', async () => {
  const q = storage.taskQueue;
  await queued();
  const stale = (await q.claimNext(A))!;
  const current = await reclaim(stale, A);
  assert.equal(await q.saveCheckpoint(A, current, { step: 2 }), true);
  const before = await state(current);

  await everyMutationRefused(A, stale);

  assert.deepEqual(await state(current), before);
  assert.equal(await q.renew(A, current), true);
});

test('an expired lease is no longer owned, before any reaper has run', async () => {
  const q = storage.taskQueue;
  await queued();
  const job = (await q.claimNext(A))!;
  await expire(job);
  const before = await state(job);

  await everyMutationRefused(A, job);

  assert.deepEqual(await state(job), before, 'still running, still expired, nothing written');
  const recovered = await q.recover();
  assert.deepEqual(recovered.requeued, [`${job.owner}:${job.id}`], 'the reaper takes it as usual');
});

test('a job carrying no claim changes nothing: no unfenced path', async () => {
  const q = storage.taskQueue;
  await queued();
  const job = (await q.claimNext(A))!;
  const { claim: _claim, ...bare } = job;
  const before = await state(job);

  await everyMutationRefused(A, bare);
  assert.deepEqual(await state(job), before);
  await q.finish(job, { result: 'done' });
});

test('cancelled while running, retried and claimed again: the first claim stays stale', async () => {
  const q = storage.taskQueue;
  await queued();
  const stale = (await q.claimNext(A))!;
  await q.mutate(stale.owner, (s) => {
    s.tasks.find((t) => t.id === stale.id)!.status = 'cancelled';
  });
  assert.deepEqual([(await row(stale)).lease_owner, (await row(stale)).claim_token], [null, null], 'a cancel ends the claim');
  await q.mutate(stale.owner, (s) => {
    s.tasks.find((t) => t.id === stale.id)!.status = 'queued';
  });
  const current = (await q.claimNext(A))!;
  assert.equal(current.id, stale.id);
  const before = await state(current);

  await everyMutationRefused(A, stale);

  assert.deepEqual(await state(current), before);
  await q.finish(current, { result: 'done' });
});

test('the holder\'s own mutations work, and each ending clears the claim', async () => {
  const q = storage.taskQueue;
  await queued();
  const job = (await q.claimNext(A))!;
  await db.query(`UPDATE melchizedek_tasks SET lease_until = now() + interval '1 second' WHERE owner = $1 AND id = $2`, [job.owner, job.id]);
  const short = (await state(job)).lease_until as Date;
  assert.equal(await q.renew(A, job), true);
  assert.ok(((await state(job)).lease_until as Date) > short, 'renew extends the lease');
  assert.equal(await q.saveCheckpoint(A, job, { step: 1 }), true);
  assert.equal(await capped.saveCheckpoint(A, job, { step: 'over the cap, and still the holder' }), true);
  assert.deepEqual((await state(job)).checkpoint, { step: 1 });

  // A requeue keeps the checkpoint and ends the claim.
  assert.equal(await q.requeueInterrupted(job), 'requeued');
  let r = await state(job);
  assert.deepEqual([r.status, r.lease_owner, r.lease_until, r.claim_token, r.checkpoint], ['queued', null, null, null, { step: 1 }]);

  // Recovery keeps it too, and clears the claim in the same statement that requeues.
  const second = (await q.claimNext(A))!;
  assert.equal(second.attempts, 2);
  await expire(second);
  await q.recover();
  r = await state(job);
  assert.equal(r.status, 'failed', 'two interruptions: not retried');
  assert.deepEqual([r.lease_owner, r.lease_until, r.claim_token, r.checkpoint], [null, null, null, null]);
});

test('the finish / recover race: whichever order they land in, a job ends one way', async () => {
  const q = storage.taskQueue;

  // The reaper first: the worker's finish then writes nothing.
  await queued();
  const reaped = (await q.claimNext(A))!;
  await expire(reaped);
  await q.recover();
  assert.equal(await q.finish(reaped, { result: 'too late' }), 'lost');
  let r = await state(reaped);
  assert.equal(r.status, 'queued');
  assert.equal(r.record.result, undefined);
  await q.mutate(reaped.owner, (s) => { s.tasks = []; });

  // A live lease: the reaper leaves it, the finish lands.
  await queued();
  const live = (await q.claimNext(A))!;
  const [finished, recovered] = await Promise.all([q.finish(live, { result: 'in time' }), q.recover()]);
  assert.equal(finished, 'accepted');
  assert.deepEqual(recovered.requeued, []);
  r = await state(live);
  assert.deepEqual([r.status, r.record.result, r.claim_token], ['done', 'in time', null]);

  // Expired, both at once: the finish cannot land, whichever runs first.
  await queued();
  const expired = (await q.claimNext(A))!;
  await expire(expired);
  const [lateFinish] = await Promise.all([q.finish(expired, { result: 'stale' }), q.recover()]);
  assert.equal(lateFinish, 'lost');
  r = await state(expired);
  assert.equal(r.status, 'queued');
  assert.equal(r.record.result, undefined, 'the stale result is not stored');
  await q.mutate(expired.owner, (s) => { s.tasks = []; });
});

// ── 3. The completion result ─────────────────────────────────────────────────

test('Postgres: the holder\'s finish is accepted, and clears the claim and the checkpoint; a second finish is lost', async () => {
  const q = storage.taskQueue;
  await queued();
  const job = (await q.claimNext(A))!;
  await q.saveCheckpoint(A, job, { step: 1 });
  assert.equal(await q.finish(job, { result: 'the answer' }), 'accepted');
  const r = await state(job);
  assert.deepEqual([r.status, r.record.result, r.lease_owner, r.claim_token, r.checkpoint], ['done', 'the answer', null, null, null]);
  assert.equal(await q.finish(job, { error: 'again' }), 'lost');
  assert.equal((await state(job)).record.result, 'the answer');
});

test('Postgres: a lost finish keeps the new claim\'s checkpoint', async () => {
  const q = storage.taskQueue;
  await queued();
  const stale = (await q.claimNext(A))!;
  const current = await reclaim(stale, B);
  assert.equal(await q.saveCheckpoint(B, current, { step: 7 }), true);
  assert.equal(await q.finish(stale, { result: 'stale' }), 'lost');
  assert.deepEqual((await state(current)).checkpoint, { step: 7 }, 'B\'s checkpoint survives');
  assert.equal((await state(current)).record.result, undefined);
});

function fileWithTwoClaims() {
  const q = fileTaskBackendWith();
  return { q, queue: () => executeContract(taskQueueContract, { title: 'One', instruction: 'Do the first thing.' }) };
}

test('file store: a stale claim is lost on every mutation and changes nothing', async () => {
  const { q, queue } = fileWithTwoClaims();
  await queue();
  const stale = (await q.claimNext(A))!;
  assert.equal(await q.saveCheckpoint(A, stale, { step: 1 }), true);
  assert.equal(await q.requeueInterrupted(stale), 'requeued');
  const current = (await q.claimNext(A))!;
  assert.equal(current.id, stale.id);
  assert.equal(await q.saveCheckpoint(A, current, { step: 2 }), true);
  const before = readFileSync(process.env.MELCHIZEDEK_TASKS_FILE!, 'utf8');

  assert.equal(await q.renew(A, stale), false);
  assert.equal(await q.saveCheckpoint(A, stale, { step: 'stale' }), false);
  assert.equal(await q.finish(stale, { result: 'stale' }), 'lost');
  assert.equal(await q.requeueInterrupted(stale), 'lost');

  assert.equal(readFileSync(process.env.MELCHIZEDEK_TASKS_FILE!, 'utf8'), before, 'nothing written');
  assert.deepEqual(await q.loadCheckpoint(current), { step: 2 }, 'the current claim keeps its checkpoint');
  assert.equal(await q.renew(B, current), false, 'another worker id does not hold it either');
  assert.equal(await q.renew(A, current), true);
  assert.equal(await q.finish(current, { result: 'the answer' }), 'accepted');
  assert.equal(await q.loadCheckpoint(current), null);
  assert.equal(await q.finish(current, { result: 'again' }), 'lost');
});

test('file store: a job carrying no claim, or one whose record left running, is lost', async () => {
  const { q, queue } = fileWithTwoClaims();
  await queue();
  const job = (await q.claimNext(A))!;
  const { claim: _claim, ...bare } = job;
  assert.equal(await q.finish(bare, { result: 'no claim' }), 'lost');
  assert.equal(await q.renew(A, bare), false);
  assert.equal(await q.saveCheckpoint(A, bare, { step: 1 }), false);
  await q.mutate('', (s) => {
    s.tasks.find((t) => t.id === job.id)!.status = 'cancelled';
  });
  assert.equal(await q.finish(job, { result: 'late' }), 'lost');
  assert.doesNotMatch(String(await executeContract(taskGetContract, { id: job.id })), /late/);
});

// ── 4. A worker whose job was taken ──────────────────────────────────────────

test('a run whose job another worker reclaimed while it ran records nothing, and B keeps the job', async () => {
  const q = storage.taskQueue;
  await queued();
  const claimedAt = performance.now();
  const stale = (await q.claimNext(A))!;
  let current: OwnedTask | undefined;
  const lines: string[] = [];
  const end = await runClaimedJob({
    backend: q,
    lease: A,
    job: stale,
    claimedAt,
    controller: new AbortController(),
    log: (l) => lines.push(l),
    turn: async () => {
      current = await reclaim(stale, B);
      return { status: 'completed', text: 'the stale answer', lostClaim: false, resumedFromStep: 0 };
    },
  });
  assert.equal(end, 'lost');
  const r = await state(current!);
  assert.deepEqual([r.status, r.record.result, r.lease_owner, r.claim_token], ['running', undefined, B.workerId, current!.claim!.token]);
  assert.doesNotMatch(lines.join('\n'), /done in/);
  assert.ok(!lines.join('\n').includes(stale.claim!.token), 'the token is not logged');
  assert.equal(await q.finish(current!, { result: 'the real answer' }), 'accepted');
});

// ── 5. The checkpoint sink carries the claim ─────────────────────────────────

registerTool(
  'fence_lookup',
  defineTool({ name: 'fence_lookup', description: 'Look a key up.', schema: z.object({ key: z.string() }), execute: async ({ key }) => `value of ${key}` }),
  { override: true },
);

const toolResults = (req: ModelRequest): number => req.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts).length;

/** Looks up a, b and c, then answers; `third` stands in for the third step when given. */
function lookupModel(third?: (signal?: AbortSignal) => ReturnType<typeof untilAborted>) {
  return new ScriptedModel('scripted/worker', (req, _n, signal) => {
    const done = toolResults(req);
    if (done < 3) {
      if (done === 2 && third) return third(signal);
      return toolCall('fence_lookup', { key: 'abc'[done] }, `call-${done}`);
    }
    return answer(`done: ${lastToolResult(req)?.result}`);
  });
}

function attempt(job: OwnedTask, sink: CheckpointSink, model: ScriptedModel, signal?: AbortSignal) {
  resetCircuits();
  return runDurableTurn({
    config: {
      syndicate_name: 'Worker',
      orchestrator: { name: 'Worker', model: 'scripted/worker', instruction: 'Look things up.', tools: ['fence_lookup'] },
      subagents: [],
    } as any as SyndicateYamlConfig,
    parts: [{ text: job.instruction ?? job.title }],
    appName: 'assistant-worker',
    userId: 'local-user',
    runId: `${job.owner}:${job.id}`,
    checkpoints: sink,
    compile: { resolveModel: shimResolver({ worker: model }), log: () => {} },
    trace: false,
    ...(signal ? { signal } : {}),
  });
}

test('a stale sink\'s save is refused, the run stops as lost, and the current claim\'s checkpoint stands', async () => {
  const q = storage.taskQueue;
  await queued();
  const stale = (await q.claimNext(A))!;
  const staleSink = claimCheckpoints(q, A, stale);
  const current = await reclaim(stale, B);
  assert.equal(await q.saveCheckpoint(B, current, { step: 'current' }), true);

  assert.equal(await staleSink.save({ step: 'stale' } as any), false);
  assert.deepEqual((await state(current)).checkpoint, { step: 'current' });

  // The whole run, on the stale sink: stopped at its first step boundary.
  const model = lookupModel();
  const result = await attempt(stale, staleSink, model);
  assert.equal(result.lostClaim, true);
  assert.equal(model.calls, 1);
  assert.deepEqual((await state(current)).checkpoint, { step: 'current' });
});

test('a restart resumes from a checkpoint no claim wrote: the format is unchanged and carries no token', async () => {
  const q = storage.taskQueue;
  await queued();
  const first = (await q.claimNext(A))!;
  const kill = new AbortController();
  const killed = lookupModel((signal) => {
    kill.abort();
    return untilAborted(signal);
  });
  const killedRun = await attempt(first, claimCheckpoints(q, A, first), killed, kill.signal);
  assert.notEqual(killedRun.status, 'completed');

  const stored = (await state(first)).checkpoint;
  assert.deepEqual(Object.keys(stored).sort(), ['openingHash', 'runId', 'savedAt', 'sessionId', 'sessions', 'steps', 'version'], 'the v1 format');
  assert.ok(!JSON.stringify(stored).includes(first.claim!.token), 'a checkpoint knows nothing of its claim');

  // As a release before claim tokens left it: queued, the checkpoint kept, no claim on the row.
  await db.query(`UPDATE melchizedek_tasks SET status = 'queued', record = record || '{"status":"queued"}', lease_owner = NULL, lease_until = NULL, claim_token = NULL WHERE owner = $1 AND id = $2`, [first.owner, first.id]);
  const second = (await q.claimNext(B))!;
  assert.notEqual(second.claim!.token, first.claim!.token);
  const resumedModel = lookupModel();
  const resumed = await attempt(second, claimCheckpoints(q, B, second), resumedModel);
  assert.equal(resumed.status, 'completed', resumed.error?.message);
  assert.equal(resumed.resumedFromStep, 2);
  assert.equal(resumedModel.calls, 2, 'the third lookup and the answer');
  assert.equal(await q.finish(second, { result: resumed.text }), 'accepted');
});

// ── 6. The public surface and the upgrade ────────────────────────────────────

test('a backend written against the earlier TaskBackend still type-checks, and the built-in worker refuses it', () => {
  // The whole 1.15 shape: no claim, finish resolving void, no fenced members.
  const earlier: TaskBackend = {
    read: async () => ({ version: 1, next_id: 1, tasks: [] }),
    mutate: async (_owner, change) => change({ version: 1, next_id: 1, tasks: [] }),
    claimNext: async () => null,
    renew: async (): Promise<void> => {},
    finish: async (): Promise<void> => {},
    recover: async () => ({ requeued: [], failed: [] }),
  };
  assert.throws(() => requireFencedBackend(earlier), /fenced/);
  assert.equal(requireFencedBackend(fileTaskBackend), fileTaskBackend);
  assert.equal(requireFencedBackend(storage.taskQueue), storage.taskQueue);
});

test('a job an earlier worker holds during an upgrade has no token: left alone while its lease lives, recovered after', async () => {
  const q = storage.taskQueue;
  const owner = await queued();
  await db.query(`UPDATE melchizedek_tasks SET status = 'running', lease_owner = 'old-worker', lease_until = now() + interval '1 minute', claim_token = NULL, record = record || '{"status":"running","attempts":1}' WHERE owner = $1`, [owner]);
  const job = { id: 't1', owner } as OwnedTask;
  assert.deepEqual((await q.recover()).requeued, [], 'a live lease is left alone');
  assert.equal(await q.claimNext(A), null, 'a running job is never claimed');

  await expire(job);
  assert.deepEqual((await q.recover()).requeued, [`${owner}:t1`]);
  const next = (await q.claimNext(A))!;
  assert.equal(next.id, 't1');
  assert.ok(next.claim!.token, 'from here it is fenced');
  assert.equal(await q.finish(next, { result: 'done' }), 'accepted');
});
