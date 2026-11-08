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

import { inProcessTurnLock, postgresStorage } from '../lib/storage/postgres/index.ts';
import type { PostgresStorage } from '../lib/storage/postgres/index.ts';
import { executeContract } from '../lib/tools/toolContract.ts';
import { fileTaskBackendWith, setTaskBackend, fileTaskBackend, taskGetContract, taskQueueContract } from '../lib/tools/taskTools.ts';
import type { OwnedTask, WorkerLease } from '../lib/tools/taskTools.ts';

const INSTALL = [...readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => `db/migrations/${f}`), 'db/hardening.sql'];

const dir = mkdtempSync(join(tmpdir(), 'melch-fencing-'));
let n = 0;
let db: PGlite;
let server: PGLiteSocketServer;
let storage: PostgresStorage;

before(async () => {
  db = await PGlite.create({ extensions: { vector } });
  for (const f of INSTALL) await db.exec(readFileSync(f, 'utf-8'));
  server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 16 });
  await server.start();
  const { port } = (server as unknown as { server: { address(): { port: number } } }).server.address();
  storage = postgresStorage({
    connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
    poolConfig: { max: 2 },
    turnLock: inProcessTurnLock(),
  });
});

after(async () => {
  await storage?.close();
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

void B;
