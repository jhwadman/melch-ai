/**
 * The checkpoint size cap (ADR 0113, lib/tools/taskTools.ts): a save whose
 * serialized JSON is above the backend's cap is not stored, the job keeps
 * its previous checkpoint, and one log line names the job id and the sizes,
 * never the checkpoint's content. A run whose later checkpoints are over the
 * cap resumes from the last one that fitted. The worker's variable
 * (MELCHIZEDEK_CHECKPOINT_MAX_BYTES) falls back to the default when it is
 * not a positive whole number. File store in a temp directory, the Postgres
 * backend on a recording fake pool, scripted models; no network.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

import { runDurableTurn } from '../lib/runtime/native/checkpoint.ts';
import type { RunCheckpoint } from '../lib/runtime/native/checkpoint.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool, executeContract } from '../lib/tools/toolContract.ts';
import {
  CHECKPOINT_MAX_BYTES_ENV,
  DEFAULT_CHECKPOINT_MAX_BYTES,
  applyInterrupted,
  checkpointJson,
  checkpointMaxBytesSetting,
  fileTaskBackendWith,
  taskQueueContract,
} from '../lib/tools/taskTools.ts';
import type { OwnedTask, TaskBackend, WorkerLease } from '../lib/tools/taskTools.ts';
import { postgresTaskBackend } from '../lib/storage/postgres/taskQueue.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall, untilAborted } from './helpers/scriptedModel.ts';

const dir = mkdtempSync(join(tmpdir(), 'melch-ckpt-cap-'));
let n = 0;
beforeEach(() => {
  process.env.MELCHIZEDEK_TASKS_FILE = join(dir, `tasks-${n++}.json`);
});
after(() => {
  delete process.env.MELCHIZEDEK_TASKS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

const W: WorkerLease = { workerId: 'w', leaseMs: 60_000 };
/** Text a log line must never carry: it stands in for the user's words and tool results. */
const PRIVATE = 'the-users-private-words';

const queue = () => executeContract(taskQueueContract, { title: 'Lookups', instruction: 'Look up a, b and c and report the last value.' });
const bytesOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

async function claimed(backend: TaskBackend): Promise<OwnedTask> {
  await queue();
  return (await backend.claimNext(W))!;
}

test('a save over the cap keeps the earlier checkpoint and logs only the job id and the sizes', async () => {
  const lines: string[] = [];
  const backend = fileTaskBackendWith({ checkpointMaxBytes: 1_000, log: (l) => lines.push(l) });
  const job = await claimed(backend);
  const small = { step: 1, note: PRIVATE };
  assert.equal(await backend.saveCheckpoint!(W, job, small), true);
  assert.deepEqual(await backend.loadCheckpoint!(job), small);
  assert.equal(lines.length, 0, 'a save under the cap logs nothing');

  const big = { step: 2, note: PRIVATE.repeat(100) };
  const size = bytesOf(big);
  assert.equal(await backend.saveCheckpoint!(W, job, big), true, 'the claim still holds');
  assert.deepEqual(await backend.loadCheckpoint!(job), small, 'the earlier checkpoint is kept');
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `checkpoint for job ${job.id} not saved: ${size} bytes is over the 1000-byte cap; the previous checkpoint is kept`);
  assert.doesNotMatch(lines[0]!, new RegExp(PRIVATE));

  // A later save that fits replaces it again.
  const next = { step: 3 };
  assert.equal(await backend.saveCheckpoint!(W, job, next), true);
  assert.deepEqual(await backend.loadCheckpoint!(job), next);
});

test('a save under the cap stores the checkpoint as before, beside other jobs', async () => {
  const backend = fileTaskBackendWith();
  const first = await claimed(backend);
  const second = await claimed(backend);
  const a = { step: 1, text: 'naïve — ünïcödé' };
  const b = { step: 4, nested: { list: [1, 2, 3] } };
  assert.equal(await backend.saveCheckpoint!(W, first, a), true);
  assert.equal(await backend.saveCheckpoint!(W, second, b), true);
  assert.deepEqual(await backend.loadCheckpoint!(first), a);
  assert.deepEqual(await backend.loadCheckpoint!(second), b);
  const a2 = { step: 2 };
  assert.equal(await backend.saveCheckpoint!(W, first, a2), true);
  assert.deepEqual(await backend.loadCheckpoint!(first), a2);
  assert.deepEqual(await backend.loadCheckpoint!(second), b);
});

test('the configured cap is honoured to the byte, counting UTF-8 bytes', async () => {
  const cp = { text: 'é'.repeat(400) }; // 800 bytes of text in 400 UTF-16 units
  const size = bytesOf(cp);
  assert.ok(size > JSON.stringify(cp).length);
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  assert.equal(checkpointJson({ id: 't1' }, cp, { checkpointMaxBytes: size, log }), JSON.stringify(cp));
  assert.equal(checkpointJson({ id: 't1' }, cp, { checkpointMaxBytes: size - 1, log }), null);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`job t1 .*${size} bytes .*${size - 1}-byte cap`));
  // An option that is not a positive whole number is the default cap.
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(checkpointJson({ id: 't1' }, cp, { checkpointMaxBytes: bad, log }), JSON.stringify(cp));
  assert.equal(lines.length, 1);
});

test('the worker variable: a positive whole number of bytes sets the cap; anything else is the default', () => {
  assert.equal(CHECKPOINT_MAX_BYTES_ENV, 'MELCHIZEDEK_CHECKPOINT_MAX_BYTES');
  assert.equal(DEFAULT_CHECKPOINT_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(checkpointMaxBytesSetting('1024'), 1024);
  assert.equal(checkpointMaxBytesSetting(' 2048 '), 2048);
  for (const bad of [undefined, '', '  ', 'abc', '0', '-5', '1.5', '1e6', '5MB', '99999999999999999999']) {
    assert.equal(checkpointMaxBytesSetting(bad), DEFAULT_CHECKPOINT_MAX_BYTES, String(bad));
  }
});

test('Postgres: a save over the cap writes nothing, reports the claim and logs the sizes; one under it is written once, as serialized', async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  let held = true;
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rowCount: held ? 1 : 0, rows: held ? [{ '?column?': 1 }] : [] };
    },
  };
  const lines: string[] = [];
  const backend = postgresTaskBackend(pool as any, { checkpointMaxBytes: 200, log: (l) => lines.push(l) });
  const job = { id: 't7', owner: 'owner-1' } as OwnedTask;

  const small = { step: 1 };
  assert.equal(await backend.saveCheckpoint!(W, job, small), true);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /UPDATE melchizedek_tasks SET checkpoint = \$4::jsonb/);
  assert.equal(queries[0]!.params[3], JSON.stringify(small));

  const big = { step: 2, note: PRIVATE.repeat(20) };
  assert.equal(await backend.saveCheckpoint!(W, job, big), true);
  assert.equal(queries.length, 2);
  assert.match(queries[1]!.sql, /^SELECT 1 FROM melchizedek_tasks/);
  assert.doesNotMatch(queries[1]!.sql, /UPDATE/);
  assert.deepEqual(queries[1]!.params, ['owner-1', 't7', 'w']);
  assert.deepEqual(lines, [`checkpoint for job t7 not saved: ${bytesOf(big)} bytes is over the 200-byte cap; the previous checkpoint is kept`]);

  // Over the cap after the claim is gone: the run still learns it must stop.
  held = false;
  assert.equal(await backend.saveCheckpoint!(W, job, big), false);
});

// ── A run whose later checkpoints are over the cap ───────────────────────────

registerTool(
  'cap_lookup',
  defineTool({
    name: 'cap_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }) => `value of ${key}`,
  }),
  { override: true },
);

const config = (): SyndicateYamlConfig =>
  ({ syndicate_name: 'Worker', orchestrator: { name: 'Worker', model: 'scripted/worker', instruction: 'Look things up.', tools: ['cap_lookup'] }, subagents: [] }) as any;

const toolResults = (req: ModelRequest): number => req.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts).length;

function workerModel(third?: (signal?: AbortSignal) => ReturnType<typeof untilAborted>) {
  return new ScriptedModel('scripted/worker', (req, _n, signal) => {
    const done = toolResults(req);
    if (done < 3) {
      if (done === 2 && third) return third(signal);
      return toolCall('cap_lookup', { key: 'abc'[done] }, `call-${done}`);
    }
    return answer(`done: ${lastToolResult(req)?.result}`);
  });
}

async function attempt(backend: TaskBackend, job: OwnedTask, model: ScriptedModel, signal?: AbortSignal) {
  resetCircuits();
  const sessions = new InProcessSessionService();
  const saved: RunCheckpoint[] = [];
  const result = await runDurableTurn({
    config: config(),
    parts: [{ text: job.instruction ?? job.title }],
    appName: 'assistant-worker',
    userId: 'local-user',
    runId: `${job.owner}:${job.id}`,
    checkpoints: {
      load: async () => ((await backend.loadCheckpoint?.(job)) ?? null) as RunCheckpoint | null,
      save: async (cp) => {
        saved.push(cp);
        return backend.saveCheckpoint!(W, job, cp);
      },
    },
    sessions,
    compile: { resolveModel: shimResolver({ worker: model }), log: () => {} },
    trace: false,
    ...(signal ? { signal } : {}),
  });
  const session = await sessions.get({ appName: 'assistant-worker', userId: 'local-user', sessionId: result.sessionId });
  const history = (session?.events ?? []).map((e: TurnEvent) => ({ author: e.author, content: e.content, stateDelta: e.actions?.stateDelta ?? {} }));
  return { result, history, saved };
}

test('a run whose later checkpoints are over the cap resumes from the last one that fitted, to the same history', async () => {
  // The uninterrupted reference, uncapped: its checkpoint sizes place the cap between the first and the second.
  const reference = fileTaskBackendWith();
  const refJob = await claimed(reference);
  const ref = await attempt(reference, refJob, workerModel());
  assert.equal(ref.result.status, 'completed');
  assert.equal(ref.saved.length, 3);
  const [s1, s2] = ref.saved.map(bytesOf) as [number, number];
  assert.ok(s1 < s2);

  process.env.MELCHIZEDEK_TASKS_FILE = join(dir, `tasks-${n++}.json`);
  const lines: string[] = [];
  const backend = fileTaskBackendWith({ checkpointMaxBytes: s1 + Math.floor((s2 - s1) / 2), log: (l) => lines.push(l) });
  const job1 = await claimed(backend);
  const kill = new AbortController();
  const first = workerModel((signal) => {
    kill.abort();
    return untilAborted(signal);
  });
  const killed = await attempt(backend, job1, first, kill.signal);
  assert.notEqual(killed.result.status, 'completed');
  assert.equal(killed.result.lostClaim, false, 'a skipped save does not end the run');
  assert.equal(first.calls, 3);
  assert.equal(((await backend.loadCheckpoint!(job1)) as RunCheckpoint).steps, 1, 'the second step was over the cap');
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`^checkpoint for job ${job1.id} not saved: \\d+ bytes is over the \\d+-byte cap`));
  assert.doesNotMatch(lines[0]!, /Look up|value of/);

  assert.equal(await backend.mutate(job1.owner, (s) => applyInterrupted(s.tasks.find((t) => t.id === job1.id)!)), 'requeued');
  const job2 = (await backend.claimNext(W))!;
  const second = workerModel();
  const resumed = await attempt(backend, job2, second);
  assert.equal(resumed.result.status, 'completed', resumed.result.error?.message);
  assert.equal(resumed.result.resumedFromStep, 1, 'from the older boundary');
  assert.equal(second.calls, 3, 'the lookups of b and c, and the answer');
  assert.equal(resumed.result.text, ref.result.text);
  assert.deepStrictEqual(resumed.history, ref.history);
});
