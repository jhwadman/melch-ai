/**
 * tests/taskTools.test.ts — offline tests for the task list and job queue.
 *
 * No model, no network: every test points MELCHIZEDEK_TASKS_FILE at a fresh
 * temp file and drives the contracts through executeContract, the same
 * validate-then-run path an agent's call takes, plus the worker-side
 * functions scripts/assistant_worker.ts calls.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeContract } from '../lib/tools/toolContract.ts';
import { resolveTools } from '../lib/toolRegistry.ts';
import {
  TASK_TOOL_CONTRACTS,
  MAX_ATTEMPTS,
  MAX_RESULT_CHARS,
  claimNextJob,
  finishJob,
  recoverInterruptedJobs,
  taskAddContract,
  taskGetContract,
  taskListContract,
  taskQueueContract,
  taskStorePath,
  taskUpdateContract,
} from '../lib/tools/taskTools.ts';

const dir = mkdtempSync(join(tmpdir(), 'melch-tasks-'));
let n = 0;
beforeEach(() => {
  process.env.MELCHIZEDEK_TASKS_FILE = join(dir, `tasks-${n++}.json`);
});
after(() => {
  delete process.env.MELCHIZEDEK_TASKS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

const call = (contract: any, args: unknown) => executeContract(contract, args);
const store = () => JSON.parse(readFileSync(taskStorePath(), 'utf8'));

// This runs against whichever tool registry the checkout has: a task tool missing from
// it would leave assistant.yaml calling tools that do not exist.
test('every task contract is registered by name', () => {
  const unknown: string[] = [];
  const names = TASK_TOOL_CONTRACTS.map((c) => c.name);
  assert.strictEqual(resolveTools(names, (n) => unknown.push(n)).length, names.length);
  assert.deepStrictEqual(unknown, []);
});

test('the store path is deployment config, never an argument', () => {
  assert.strictEqual(taskStorePath(), process.env.MELCHIZEDEK_TASKS_FILE);
  delete process.env.MELCHIZEDEK_TASKS_FILE;
  assert.strictEqual(taskStorePath(), join(process.cwd(), 'outputs', 'tasks.json'));
});

test('a todo is added, listed, completed, and leaves the active list', async () => {
  assert.match(await call(taskAddContract, { title: 'Buy milk', due: 'Friday' }), /^Added t1 \[open\] Buy milk \(due Friday\)/);
  assert.match(await call(taskListContract, {}), /t1 \[open\] Buy milk/);
  assert.match(await call(taskUpdateContract, { id: 't1', status: 'done' }), /t1 \[done\]/);
  assert.match(await call(taskListContract, {}), /^No tasks match/);
  assert.match(await call(taskListContract, { status: 'done' }), /t1 \[done\] Buy milk/);
});

test('ids come from the store and are never reused', async () => {
  await call(taskAddContract, { title: 'a' });
  await call(taskAddContract, { title: 'b' });
  assert.deepStrictEqual(store().tasks.map((t: any) => t.id), ['t1', 't2']);
  assert.strictEqual(store().next_id, 3);
});

test('schemas refuse malformed ids and oversized fields before any write', async () => {
  assert.match(await call(taskGetContract, { id: '../etc/passwd' }), /^Error: invalid arguments/);
  assert.match(await call(taskAddContract, { title: 'x'.repeat(201) }), /^Error: invalid arguments/);
  assert.match(await call(taskQueueContract, { title: 'j', instruction: 'short' }), /^Error: invalid arguments/);
  assert.match(await call(taskGetContract, { id: 't99' }), /^Error: no task t99/);
});

test('a background job runs queued → running → done and task_get shows the result', async () => {
  assert.match(
    await call(taskQueueContract, { title: 'Digest', instruction: 'Summarize https://example.com in three bullets.' }),
    /^Queued t1 \[queued · background\] Digest/,
  );
  assert.match(await call(taskGetContract, { id: 't1' }), /No result yet/);

  const job = claimNextJob();
  assert.strictEqual(job?.id, 't1');
  assert.strictEqual(job?.status, 'running');
  assert.strictEqual(claimNextJob(), null, 'a running job is not claimed twice');
  assert.match(await call(taskUpdateContract, { id: 't1', status: 'queued' }), /only a failed or cancelled job/);

  finishJob('t1', { result: '- one\n- two\n- three' });
  const full = await call(taskGetContract, { id: 't1' });
  assert.match(full, /\[done · background\]/);
  assert.match(full, /result:\n- one/);
  assert.match(await call(taskListContract, { status: 'done' }), /result ready: task_get/);
  assert.match(await call(taskListContract, {}), /t1 \[done · background\]/, 'a fresh result stays on the active list');
});

test('a finished job leaves the active list after a week; a done todo leaves at once', async () => {
  await call(taskQueueContract, { title: 'Old job', instruction: 'Something from last month.' });
  claimNextJob();
  finishJob('t1', { result: 'ok' });
  const s = store();
  s.tasks[0].finished_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(taskStorePath(), JSON.stringify(s));
  assert.match(await call(taskListContract, {}), /^No tasks match/);
  assert.match(await call(taskListContract, { status: 'all' }), /t1 \[done · background\] Old job/);
});

test('long results are cut at the cap with a marker', () => {
  writeFileSync(taskStorePath(), JSON.stringify({ version: 1, next_id: 1, tasks: [] }));
  return call(taskQueueContract, { title: 'Big', instruction: 'Write a very long document.' }).then(() => {
    claimNextJob();
    finishJob('t1', { result: 'x'.repeat(MAX_RESULT_CHARS + 500) });
    const saved = store().tasks[0].result as string;
    assert.ok(saved.length < MAX_RESULT_CHARS + 100);
    assert.match(saved, /cut at 20000 characters\]$/);
  });
});

test('status transitions are refused by kind', async () => {
  await call(taskAddContract, { title: 'todo' });
  await call(taskQueueContract, { title: 'job', instruction: 'Do the thing, completely.' });
  assert.match(await call(taskUpdateContract, { id: 't1', status: 'queued' }), /cannot be set to "queued"/);
  assert.match(await call(taskUpdateContract, { id: 't2', status: 'done' }), /cannot be set to "done"/);
  assert.match(await call(taskUpdateContract, { id: 't2', status: 'queued' }), /only a failed or cancelled job/);
  assert.match(await call(taskUpdateContract, { id: 't2', status: 'cancelled' }), /\[cancelled · background\]/);
  assert.strictEqual(claimNextJob(), null, 'a cancelled job is not claimed');
  assert.match(await call(taskUpdateContract, { id: 't2', status: 'queued' }), /\[queued · background\]/);
  assert.strictEqual(claimNextJob()?.id, 't2');
});

test('a failed job records its error and can be retried', async () => {
  await call(taskQueueContract, { title: 'job', instruction: 'Read an unreachable page.' });
  claimNextJob();
  finishJob('t1', { error: 'OLLAMA_UNREACHABLE: start ollama' });
  assert.match(await call(taskGetContract, { id: 't1' }), /error: OLLAMA_UNREACHABLE/);
  assert.match(await call(taskListContract, {}), /t1 \[failed · background\]/, 'failed jobs stay on the active list');
  await call(taskUpdateContract, { id: 't1', status: 'queued' });
  const retried = store().tasks[0];
  assert.strictEqual(retried.status, 'queued');
  assert.strictEqual(retried.error, undefined);
  assert.strictEqual(retried.attempts, 0);
});

test('an interrupted job is re-queued, then failed after MAX_ATTEMPTS', async () => {
  await call(taskQueueContract, { title: 'job', instruction: 'Something that crashes the worker.' });
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    claimNextJob();
    assert.deepStrictEqual(recoverInterruptedJobs(), { requeued: ['t1'], failed: [] });
  }
  claimNextJob();
  assert.deepStrictEqual(recoverInterruptedJobs(), { requeued: [], failed: ['t1'] });
  assert.strictEqual(store().tasks[0].status, 'failed');
});

test('an unreadable store is an Error string, never a throw', async () => {
  writeFileSync(taskStorePath(), '{ not json');
  assert.match(await call(taskListContract, {}), /^Error: the task store could not be read/);
  writeFileSync(taskStorePath(), JSON.stringify({ something: 'else' }));
  assert.match(await call(taskAddContract, { title: 'x' }), /^Error: the task store could not be read/);
});

// ── Backends and callers ────────────────────────────────────────────────────
test('a tool call carries its caller from the tool context', async () => {
  const { defineTool } = await import('../lib/tools/toolContract.ts');
  const { createToolContext } = await import('../lib/tools/tool.ts');
  const seen: unknown[] = [];
  const tool = defineTool({
    name: 'probe',
    description: 'probe',
    schema: (await import('zod')).z.object({}),
    execute: async (_input, context) => (seen.push({ userId: context?.userId, appName: context?.appName, sessionId: context?.sessionId }), 'ok'),
  });
  await tool.execute({}, createToolContext({ userId: 'scope-b', appName: 'x', sessionId: 'y' }));
  assert.deepEqual(seen, [{ userId: 'scope-b', appName: 'x', sessionId: 'y' }]);
});

test('with a plugged-in backend each caller has their own list', async () => {
  const { setTaskBackend, getTaskBackend, fileTaskBackend, applyFinish } = await import('../lib/tools/taskTools.ts');
  const stores = new Map<string, any>();
  const storeOf = (owner: string) => {
    if (!stores.has(owner)) stores.set(owner, { version: 1, next_id: 1, tasks: [] });
    return stores.get(owner);
  };
  setTaskBackend({
    read: async (owner) => structuredClone(storeOf(owner)),
    mutate: async (owner, change) => change(storeOf(owner)),
    claimNext: async () => null,
    renew: async () => {},
    finish: async (job, outcome) => applyFinish(storeOf(job.owner), job.id, outcome),
    recover: async () => ({ requeued: [], failed: [] }),
  });
  try {
    assert.equal(await taskAddContract.execute({ title: 'alpha task' } as any, { userId: 'alice' }), 'Added t1 [open] alpha task');
    assert.equal(await taskAddContract.execute({ title: 'beta task' } as any, { userId: 'bob' }), 'Added t1 [open] beta task');
    assert.match(await taskListContract.execute({ status: 'all', kind: 'any' } as any, { userId: 'alice' }), /alpha task/);
    assert.doesNotMatch(await taskListContract.execute({ status: 'all', kind: 'any' } as any, { userId: 'alice' }), /beta task/);
  } finally {
    setTaskBackend(fileTaskBackend);
  }
  assert.equal(getTaskBackend(), fileTaskBackend);
});

// ── Durable runs (ADR 0113) ─────────────────────────────────────────────────
const worker = { workerId: 'w-test', leaseMs: 60_000 };

async function runningJob() {
  const { fileTaskBackend } = await import('../lib/tools/taskTools.ts');
  await call(taskQueueContract, { title: 'Long job', instruction: 'Read ten pages and compare them.' });
  const job = await fileTaskBackend.claimNext(worker);
  assert.strictEqual(job?.status, 'running');
  return { backend: fileTaskBackend, job: job! };
}

test('file backend: a checkpoint is saved beside the store and read back, never inside the record', async () => {
  const { taskCheckpointPath } = await import('../lib/tools/taskTools.ts');
  const { backend, job } = await runningJob();
  assert.strictEqual(await backend.loadCheckpoint!(job), null);
  assert.strictEqual(await backend.saveCheckpoint!(worker, job, { step: 1, notes: ['a'] }), true);
  assert.strictEqual(await backend.saveCheckpoint!(worker, job, { step: 2, notes: ['a', 'b'] }), true);
  assert.deepStrictEqual(await backend.loadCheckpoint!(job), { step: 2, notes: ['a', 'b'] });
  assert.ok(!readFileSync(taskStorePath(), 'utf8').includes('step'), 'the task list never carries the checkpoint');
  assert.ok(readFileSync(taskCheckpointPath(), 'utf8').includes('"step": 2'));
  assert.doesNotMatch(await call(taskGetContract, { id: job.id }), /step/);
  assert.strictEqual(await backend.renew(worker, job), true, 'a running job keeps its claim');
});

test('file backend: cancelling a running job is accepted and ends its claim and checkpoint', async () => {
  const { backend, job } = await runningJob();
  await backend.saveCheckpoint!(worker, job, { step: 1 });
  assert.match(await call(taskUpdateContract, { id: job.id, status: 'cancelled' }), /\[cancelled · background\]/);
  assert.strictEqual(await backend.renew(worker, job), false, 'renew reports the claim gone');
  assert.strictEqual(await backend.saveCheckpoint!(worker, job, { step: 2 }), false, 'a cancelled run cannot checkpoint');
  assert.strictEqual(await backend.loadCheckpoint!(job), null, 'cancel dropped the checkpoint');
  await backend.finish(job, { result: 'late result' });
  const t = store().tasks[0];
  assert.strictEqual(t.status, 'cancelled', 'the late outcome leaves the cancelled record alone');
  assert.strictEqual(t.result, undefined);
  // Retried from scratch: no checkpoint comes back.
  await call(taskUpdateContract, { id: job.id, status: 'queued' });
  const again = await backend.claimNext(worker);
  assert.strictEqual(await backend.loadCheckpoint!(again!), null);
});

test('file backend: a checkpoint survives an interrupted run being re-queued, and goes when the job finishes', async () => {
  const { backend, job } = await runningJob();
  await backend.saveCheckpoint!(worker, job, { step: 3 });
  assert.deepStrictEqual(await backend.recover(), { requeued: [job.id], failed: [] });
  assert.deepStrictEqual(await backend.loadCheckpoint!(job), { step: 3 }, 'kept while queued');
  const resumed = await backend.claimNext(worker);
  assert.deepStrictEqual(await backend.loadCheckpoint!(resumed!), { step: 3 }, 'the next claim resumes from it');
  await backend.finish(resumed!, { result: 'ok' });
  assert.strictEqual(await backend.loadCheckpoint!(resumed!), null, 'done drops it');
  assert.strictEqual(await backend.saveCheckpoint!(worker, resumed!, { step: 4 }), false, 'a finished job cannot checkpoint');
  assert.strictEqual(await backend.renew(worker, resumed!), false);
});

test('file backend: a job failed by its outcome or by recover drops its checkpoint', async () => {
  const { taskCheckpointPath } = await import('../lib/tools/taskTools.ts');
  const { backend, job } = await runningJob();
  await backend.saveCheckpoint!(worker, job, { step: 1 });
  await backend.finish(job, { error: 'boom' });
  assert.strictEqual(await backend.loadCheckpoint!(job), null);

  await call(taskQueueContract, { title: 'Crashy', instruction: 'Something that crashes the worker.' });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const j = (await backend.claimNext(worker))!;
    assert.strictEqual(j.id, 't2');
    assert.strictEqual(await backend.saveCheckpoint!(worker, j, { attempt }), true);
    await backend.recover();
  }
  assert.strictEqual(store().tasks[1].status, 'failed');
  assert.strictEqual(await backend.loadCheckpoint!({ ...store().tasks[1], owner: '' }), null);
  assert.deepStrictEqual(JSON.parse(readFileSync(taskCheckpointPath(), 'utf8')), {}, 'the sidecar keeps nothing for finished jobs');
});

test('file backend: an unreadable checkpoint sidecar is an empty one, never a broken store', async () => {
  const { taskCheckpointPath } = await import('../lib/tools/taskTools.ts');
  const { backend, job } = await runningJob();
  writeFileSync(taskCheckpointPath(), '{ not json');
  assert.strictEqual(await backend.loadCheckpoint!(job), null);
  assert.match(await call(taskListContract, {}), /Long job/);
  assert.strictEqual(await backend.saveCheckpoint!(worker, job, { step: 1 }), true);
  assert.deepStrictEqual(await backend.loadCheckpoint!(job), { step: 1 });
});
