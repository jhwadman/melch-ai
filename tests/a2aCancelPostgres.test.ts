/**
 * tests/a2aCancelPostgres.test.ts — cancel across replicas on a REAL
 * Postgres (migration 0014, ADR 0113): PostgresTaskStore.requestCancel is
 * scoped like load(), cancelRequestedTasks lists only the leasing
 * instance's requests, a request is cleared when the task leaves running,
 * and the SDK's own cancel on an instance not running the task is recorded
 * as a request while the row stays `canceled` against later saves.
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres server where the
 * connecting role may create databases (as tests/postgresStorage.test.ts).
 * Creates its own database, applies db/migrations/ in order, and drops it.
 * Without the variable every test skips.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { DefaultRequestHandler, ServerCallContext } from '@a2a-js/sdk/server';
import type { AgentExecutor } from '@a2a-js/sdk/server';

import { PostgresTaskStore, cancelRequestedTasks, reapExpiredTasks } from '../lib/storage/postgres/taskStore.ts';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const skip = ADMIN_URL ? false : 'set TEST_DATABASE_URL to run the Postgres integration suite';
const DB = `melchizedek_cancel_${process.pid}_${Date.now()}`;

const SUBMITTED = 1;
const WORKING = 2;
const COMPLETED = 3;
const CANCELED = 5;

let admin: pg.Client;
let pool: pg.Pool;

function urlFor(db: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${db}`;
  return u.toString();
}

const MIGRATIONS = readdirSync('db/migrations')
  .filter((f) => /^\d{4}_/.test(f) && f.endsWith('.sql'))
  .sort();

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  pool = new pg.Pool({ connectionString: urlFor(DB), max: 4 });
  for (const f of MIGRATIONS) await pool.query(readFileSync(`db/migrations/${f}`, 'utf-8'));
});

after(async () => {
  if (skip) return;
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

const as = (userName: string) => new ServerCallContext({ user: { isAuthenticated: true, userName } } as any);
const task = (id: string, state: number, note = '') =>
  ({ id, contextId: `ctx-${id}`, status: { state, timestamp: new Date().toISOString() }, artifacts: [], history: [], metadata: note ? { note } : undefined }) as any;
const row = async (agent: string, id: string) =>
  (
    await pool.query(
      `SELECT state, lease_owner, cancel_requested_at, task FROM adk_a2a_tasks WHERE agent_id = $1 AND id = $2`,
      [agent, id],
    )
  ).rows[0];

// Two replicas on one database: X runs the tasks, Y receives the cancels.
const leaseX = { instanceId: 'replica-x', ttlMs: 60_000 };
const leaseY = { instanceId: 'replica-y', ttlMs: 60_000 };

test('requestCancel: only the owner of a running task can request it, and only the leasing instance sees it', { skip }, async () => {
  const x = new PostgresTaskStore(pool, 'cancel-desk', { lease: leaseX });
  const y = new PostgresTaskStore(pool, 'cancel-desk', { lease: leaseY });
  const id = randomUUID();
  await x.save(task(id, WORKING), as('alice'));

  assert.equal(await y.requestCancel(id, as('bob')), false, 'another owner cannot');
  assert.equal(await new PostgresTaskStore(pool, 'other-desk', { lease: leaseY }).requestCancel(id, as('alice')), false, 'nor another agent');
  assert.equal((await row('cancel-desk', id)).cancel_requested_at, null);

  assert.equal(await y.requestCancel(id, as('alice')), true, 'the owner can, through any instance');
  assert.deepEqual(await cancelRequestedTasks(pool, leaseX), [id], 'the leasing instance sees the request');
  assert.deepEqual(await cancelRequestedTasks(pool, leaseY), [], 'another instance does not');
  assert.equal((await row('cancel-desk', id)).state, WORKING, 'a request does not change the task');

  // Finished tasks cannot be requested.
  const done = randomUUID();
  await x.save(task(done, SUBMITTED), as('alice'));
  await x.save(task(done, COMPLETED), as('alice'));
  assert.equal(await y.requestCancel(done, as('alice')), false);
});

test('a request survives saves while the task runs and is cleared when it leaves running', { skip }, async () => {
  const x = new PostgresTaskStore(pool, 'cancel-desk', { lease: leaseX });
  const id = randomUUID();
  await x.save(task(id, WORKING), as('alice'));
  assert.equal(await x.requestCancel(id, as('alice')), true);

  await x.save(task(id, WORKING, 'progress'), as('alice'));
  let r = await row('cancel-desk', id);
  assert.notEqual(r.cancel_requested_at, null, 'a working save keeps the request');
  assert.equal(r.lease_owner, 'replica-x');
  assert.ok((await cancelRequestedTasks(pool, leaseX)).includes(id));

  // The run aborted and ended canceled on the running instance.
  await x.save(task(id, CANCELED), as('alice'));
  r = await row('cancel-desk', id);
  assert.equal(r.state, CANCELED);
  assert.equal(r.cancel_requested_at, null, 'cleared when the task leaves running');
  assert.equal(r.lease_owner, null);
  assert.ok(!(await cancelRequestedTasks(pool, leaseX)).includes(id));
});

test("the SDK's cancel on an instance not running the task is recorded, and the task stays canceled", { skip }, async () => {
  const x = new PostgresTaskStore(pool, 'cancel-desk', { lease: leaseX });
  const y = new PostgresTaskStore(pool, 'cancel-desk', { lease: leaseY });
  const id = randomUUID();
  await x.save(task(id, WORKING), as('carol'));

  // Replica Y has no event bus for the task, so the SDK writes `canceled` itself.
  let executorCalled = false;
  const executor: AgentExecutor = {
    execute: async () => {},
    cancelTask: async () => {
      executorCalled = true;
    },
  };
  const handlerY = new DefaultRequestHandler({ capabilities: {} } as any, y, executor);
  const result = await handlerY.cancelTask({ id } as any, as('carol'));
  assert.equal((result as any).status.state, CANCELED, 'the caller is told canceled');
  assert.equal(executorCalled, false, 'no bus here: the SDK does not reach the executor');

  let r = await row('cancel-desk', id);
  assert.equal(r.state, CANCELED);
  assert.notEqual(r.cancel_requested_at, null, 'recorded as a request');
  assert.equal(r.lease_owner, 'replica-x', 'the lease stays with the instance running the task');
  assert.deepEqual(await cancelRequestedTasks(pool, leaseX), [id]);
  assert.deepEqual(await cancelRequestedTasks(pool, leaseY), []);

  // Replica X saves progress before its heartbeat sees the request: the row stays canceled.
  await x.save(task(id, WORKING, 'late progress'), as('carol'));
  r = await row('cancel-desk', id);
  assert.equal(r.state, CANCELED);
  assert.equal(r.task.status.state, CANCELED, 'the stored task is not overwritten');
  assert.equal(r.lease_owner, 'replica-x');

  // Even a run that finished before seeing the request does not turn it completed.
  await x.save(task(id, COMPLETED, 'raced'), as('carol'));
  r = await row('cancel-desk', id);
  assert.equal(r.state, CANCELED);
  assert.equal(r.task.status.state, CANCELED);
  assert.equal(r.lease_owner, null, 'the lease is released when the run stops');
  assert.equal(r.cancel_requested_at, null);
  assert.equal((await y.load(id, as('carol')))?.status?.state, CANCELED);
});

test('a cancel on an expired lease is a plain cancel; the reaper keeps a reported cancel', { skip }, async () => {
  const shortX = { instanceId: 'replica-x-short', ttlMs: 200 };
  const x = new PostgresTaskStore(pool, 'cancel-desk', { lease: shortX });
  const y = new PostgresTaskStore(pool, 'cancel-desk', { lease: leaseY });

  // The instance running it died: nothing to ask, the cancel is written as is.
  const dead = randomUUID();
  await x.save(task(dead, WORKING), as('dave'));
  await new Promise((res) => setTimeout(res, 300));
  await y.save(task(dead, CANCELED), as('dave'));
  let r = await row('cancel-desk', dead);
  assert.equal(r.state, CANCELED);
  assert.equal(r.lease_owner, null);
  assert.equal(r.cancel_requested_at, null);

  // Reported canceled, then the running instance dies: the reaper only frees the lease.
  const orphan = randomUUID();
  await x.save(task(orphan, WORKING), as('dave'));
  await y.save(task(orphan, CANCELED), as('dave'));
  assert.equal((await row('cancel-desk', orphan)).lease_owner, 'replica-x-short');
  await new Promise((res) => setTimeout(res, 300));
  await reapExpiredTasks(pool);
  r = await row('cancel-desk', orphan);
  assert.equal(r.state, CANCELED, 'not overwritten as failed');
  assert.equal(r.lease_owner, null);
  assert.equal(r.cancel_requested_at, null);
});
