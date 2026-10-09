/**
 * The worker's durable-job lifecycle end to end on the default JSON store
 * (ADR 0113, ADR 0015): a job is queued with task_queue, claimed, run with
 * runDurableTurn wired to the backend's checkpoints exactly as
 * scripts/assistant_worker.ts wires them, killed mid-step (its worker
 * aborted between steps), re-queued by the interrupted-job rule, claimed by
 * a NEW worker, resumed from its checkpoint and finished. The stored result
 * and the run's history equal an uninterrupted job's, and the checkpoint is
 * gone once the job is done. A job cancelled while it runs stops at its next
 * checkpoint and keeps no result. Scripted models, no network.
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
import { applyInterrupted, fileTaskBackend, taskGetContract, taskQueueContract, taskUpdateContract } from '../lib/tools/taskTools.ts';
import type { OwnedTask, WorkerLease } from '../lib/tools/taskTools.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall, untilAborted } from './helpers/scriptedModel.ts';

const dir = mkdtempSync(join(tmpdir(), 'melch-durable-'));
let n = 0;
beforeEach(() => {
  process.env.MELCHIZEDEK_TASKS_FILE = join(dir, `tasks-${n++}.json`);
});
after(() => {
  delete process.env.MELCHIZEDEK_TASKS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

registerTool(
  'durable_lookup',
  defineTool({
    name: 'durable_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }) => `value of ${key}`,
  }),
  { override: true },
);

const config = (): SyndicateYamlConfig =>
  ({ syndicate_name: 'Worker', orchestrator: { name: 'Worker', model: 'scripted/worker', instruction: 'Look things up.', tools: ['durable_lookup'] }, subagents: [] }) as any;

const toolResults = (req: ModelRequest): number => req.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts).length;

/** Looks up a, b and c, then answers; `third` stands in for the third step when given. */
function workerModel(third?: (signal?: AbortSignal) => ReturnType<typeof untilAborted>) {
  return new ScriptedModel('scripted/worker', (req, _n, signal) => {
    const done = toolResults(req);
    if (done < 3) {
      if (done === 2 && third) return third(signal);
      return toolCall('durable_lookup', { key: 'abc'[done] }, `call-${done}`);
    }
    return answer(`done: ${lastToolResult(req)?.result}`);
  });
}

/** One attempt at a job, wired as scripts/assistant_worker.ts wires it. */
async function attempt(job: OwnedTask, lease: WorkerLease, model: ScriptedModel, signal?: AbortSignal) {
  resetCircuits();
  const sessions = new InProcessSessionService();
  const backend = fileTaskBackend;
  const result = await runDurableTurn({
    config: config(),
    parts: [{ text: job.instruction ?? job.title }],
    appName: 'assistant-worker',
    userId: 'local-user',
    runId: `${job.owner}:${job.id}`,
    checkpoints: {
      load: async () => ((await backend.loadCheckpoint?.(job)) ?? null) as RunCheckpoint | null,
      save: async (cp) => (backend.saveCheckpoint ? backend.saveCheckpoint(lease, job, cp) : true),
    },
    sessions,
    compile: { resolveModel: shimResolver({ worker: model }), log: () => {} },
    trace: false,
    ...(signal ? { signal } : {}),
  });
  const session = await sessions.get({ appName: 'assistant-worker', userId: 'local-user', sessionId: result.sessionId });
  const history = (session?.events ?? []).map((e: TurnEvent) => ({ author: e.author, content: e.content, stateDelta: e.actions?.stateDelta ?? {} }));
  return { result, history };
}

const queue = () => executeContract(taskQueueContract, { title: 'Lookups', instruction: 'Look up a, b and c and report the last value.' });
const get = async (id: string) => String(await executeContract(taskGetContract, { id }));

test('a job killed mid-step resumes on a new worker from its checkpoint and stores what an uninterrupted job stores', async () => {
  // The uninterrupted reference.
  await queue();
  const refJob = (await fileTaskBackend.claimNext({ workerId: 'ref', leaseMs: 60_000 }))!;
  const reference = await attempt(refJob, { workerId: 'ref', leaseMs: 60_000 }, workerModel());
  assert.equal(reference.result.status, 'completed');
  await fileTaskBackend.finish(refJob, { result: reference.result.text });

  process.env.MELCHIZEDEK_TASKS_FILE = join(dir, `tasks-${n++}.json`);
  await queue();
  // Worker 1 claims the job and is killed while its third model step is in flight.
  const w1: WorkerLease = { workerId: 'w1', leaseMs: 60_000 };
  const job1 = (await fileTaskBackend.claimNext(w1))!;
  const kill = new AbortController();
  const first = workerModel((signal) => {
    kill.abort();
    return untilAborted(signal);
  });
  const killed = await attempt(job1, w1, first, kill.signal);
  assert.notEqual(killed.result.status, 'completed');
  assert.equal(first.calls, 3);
  assert.ok(await fileTaskBackend.loadCheckpoint!(job1), 'the two finished steps are checkpointed');
  // The worker stopped: the interrupted-job rule puts the job back in the queue, checkpoint kept.
  const outcome = await fileTaskBackend.mutate(job1.owner, (s) => applyInterrupted(s.tasks.find((t) => t.id === job1.id)!));
  assert.equal(outcome, 'requeued');

  // Worker 2 claims it again and resumes: one model call (the third step), not four.
  const w2: WorkerLease = { workerId: 'w2', leaseMs: 60_000 };
  const job2 = (await fileTaskBackend.claimNext(w2))!;
  assert.equal(job2.id, job1.id);
  const second = workerModel();
  const resumed = await attempt(job2, w2, second);
  assert.equal(resumed.result.status, 'completed', resumed.result.error?.message);
  assert.equal(resumed.result.resumedFromStep, 2);
  assert.equal(second.calls, 2, 'the third lookup step and the answer');
  assert.equal(resumed.result.text, reference.result.text);
  assert.deepStrictEqual(resumed.history, reference.history);
  await fileTaskBackend.finish(job2, { result: resumed.result.text });

  assert.match(await get(job1.id), /done: value of c/);
  assert.equal(await fileTaskBackend.loadCheckpoint!(job2), null, 'a finished job keeps no checkpoint');
});

test('a job cancelled while it runs stops at its next checkpoint and keeps no result', async () => {
  await queue();
  const w: WorkerLease = { workerId: 'w', leaseMs: 60_000 };
  const job = (await fileTaskBackend.claimNext(w))!;
  let cancelled = false;
  const model = new ScriptedModel('scripted/worker', async (req) => {
    const done = toolResults(req);
    if (done === 1 && !cancelled) {
      cancelled = true;
      assert.doesNotMatch(String(await executeContract(taskUpdateContract, { id: job.id, status: 'cancelled' })), /^Error/);
    }
    return done < 3 ? toolCall('durable_lookup', { key: 'abc'[done] }, `call-${done}`) : answer('done');
  });
  const { result } = await attempt(job, w, model);
  assert.equal(result.lostClaim, true);
  assert.equal(model.calls, 2, 'the run stops at the checkpoint after the cancel');
  assert.equal(await fileTaskBackend.renew(w, job), false);
  const record = await get(job.id);
  assert.match(record, /cancelled/);
  assert.doesNotMatch(record, /done/);
});
