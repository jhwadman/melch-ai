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

import { inProcessTurnLock, postgresStorage } from '../lib/storage/postgres/index.ts';
import type { PostgresStorage } from '../lib/storage/postgres/index.ts';
import { postgresTaskBackend } from '../lib/storage/postgres/taskQueue.ts';
import { executeContract } from '../lib/tools/toolContract.ts';
import { fileTaskBackendWith, setTaskBackend, fileTaskBackend, taskGetContract, taskQueueContract } from '../lib/tools/taskTools.ts';
import type { OwnedTask, WorkerLease } from '../lib/tools/taskTools.ts';

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

beforeEach(() => {
  process.env.MELCHIZEDEK_TASKS_FILE = join(dir, `tasks-${n++}.json`);
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
  await q.finish(job, { result: 'stale result' });
  await q.finish(job, { error: 'stale error' });
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
  await q.finish(reaped, { result: 'too late' });
  let r = await state(reaped);
  assert.equal(r.status, 'queued');
  assert.equal(r.record.result, undefined);
  await q.mutate(reaped.owner, (s) => { s.tasks = []; });

  // A live lease: the reaper leaves it, the finish lands.
  await queued();
  const live = (await q.claimNext(A))!;
  const [, recovered] = await Promise.all([q.finish(live, { result: 'in time' }), q.recover()]);
  assert.deepEqual(recovered.requeued, []);
  r = await state(live);
  assert.deepEqual([r.status, r.record.result, r.claim_token], ['done', 'in time', null]);

  // Expired, both at once: the finish cannot land, whichever runs first.
  await queued();
  const expired = (await q.claimNext(A))!;
  await expire(expired);
  await Promise.all([q.finish(expired, { result: 'stale' }), q.recover()]);
  r = await state(expired);
  assert.equal(r.status, 'queued');
  assert.equal(r.record.result, undefined, 'the stale result is not stored');
  await q.mutate(expired.owner, (s) => { s.tasks = []; });
});
