#!/usr/bin/env node
/**
 * scripts/assistant_worker.ts — runs the jobs the Assistant queues.
 *
 * WHY this file exists:
 *   The Assistant (config/agents/examples/assistant.yaml) hands long work
 *   off with `task_queue`, which only writes a record to the task store
 *   (lib/tools/taskTools.ts). Something has to run those records, and it
 *   must not be a tool: a tool that runs agents is what the tool-contract
 *   doctrine refuses. So the runner is a plain process, like a cron job or
 *   a queue consumer. It claims one queued job at a time, runs the job's
 *   instruction as a fresh single turn through ONE agent declared in YAML,
 *   and writes the result (or the error) back to the store, where
 *   `task_get` reads it in a later conversation.
 *
 *   A job runs through lib/runtime/syndicateTurn.ts (the engine's own
 *   loop, the only runtime since 1.0.0), the same runtime the
 *   A2A server, the REPL and the observatory use, so it runs the exact agent
 *   the conversation would have called directly — with the same step cap —
 *   and the job timeout ABORTS the run (the model call in flight included)
 *   instead of abandoning it while it keeps spending. Any syndicate and any
 *   subagent in it can serve as the worker.
 *
 *   A run is durable (ADR 0113): runDurableTurn (lib/runtime/native/
 *   checkpoint.ts) checkpoints the run's sessions at every step boundary
 *   beside the job (TaskBackend.saveCheckpoint), and a job claimed again
 *   after its worker stopped resumes from its last checkpoint instead of
 *   starting over. SIGTERM aborts the step in flight and puts the job back
 *   in the queue with its checkpoint; the next worker finishes it. A job
 *   cancelled while it runs (task_update) loses its claim: the next lease
 *   renewal or checkpoint save sees it, and the run is aborted without
 *   writing a result over the cancellation.
 *
 *   Every write the worker makes is bound to one claim, and a claim whose
 *   lease it cannot confirm is over (ADR 0157, lib/runtime/claimedJob.ts):
 *   the run stops, and the job is left to whoever holds it now.
 *
 * Usage:
 *   npm run assistant:worker                      poll every 30 s until Ctrl-C
 *   npm run assistant:worker -- --once            drain the queue, then exit (cron)
 *   npm run assistant:worker -- --interval 10     poll every 10 s
 *   npm run assistant:worker -- --syndicate assistant --agent Worker   (the defaults)
 *
 *   --agent names a subagent of the syndicate, or its orchestrator.
 *   MELCHIZEDEK_TASKS_FILE moves the store (default: outputs/tasks.json),
 *   and must match the chat process's value. Run ONE worker per store.
 *   MELCHIZEDEK_CHECKPOINT_MAX_BYTES caps a stored checkpoint (bytes of
 *   JSON, default 5 MiB); a larger one is skipped and the previous kept.
 */

import { randomUUID } from 'node:crypto';

import { loadEnv } from '../lib/loadEnv.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { Interrupted, runClaimedJob, systemClock } from '../lib/runtime/claimedJob.ts';
import { runDurableTurn } from '../lib/runtime/native/checkpoint.ts';
import type { CheckpointSink } from '../lib/runtime/native/checkpoint.ts';
import { runtimeSetting } from '../lib/runtime/runtimeFlag.ts';
import { refuseChatGptSignInOnServedSurface } from '../lib/chatgpt/state.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';
import {
  PROVIDERS,
  providerForModel,
  providerKeyPresent,
} from '../lib/models/registry.ts';
import {
  CHECKPOINT_MAX_BYTES_ENV,
  checkpointMaxBytesSetting,
  fileTaskBackendWith,
  setTaskBackend,
  taskStorePath,
} from '../lib/tools/taskTools.ts';
import type { OwnedTask, WorkerLease } from '../lib/tools/taskTools.ts';
import { postgresStorage } from '../lib/storage/postgres/index.ts';
import { dbSchema } from '../lib/storage/schema.ts';
import { hostname } from 'node:os';

loadEnv(import.meta.url);
setLogLevel('warn');
// MELCHIZEDEK_RUNTIME=adk (removed in 1.0.0) stops the worker here, naming the release.
runtimeSetting();
// Sign in with ChatGPT is local only (ADR 0126): the worker runs jobs unattended, so it never runs on it.
try {
  refuseChatGptSignInOnServedSurface('melchizedek-worker');
} catch (err: unknown) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const syndicateArg = flag('syndicate') ?? 'assistant';
const syndicateFile = syndicateArg.endsWith('.yaml') ? syndicateArg : `${syndicateArg}.yaml`;
const agentName = flag('agent') ?? 'Worker';
const once = argv.includes('--once');
const intervalSeconds = Math.max(5, Number(flag('interval') ?? 30) || 30);
/** A job still running after this long is recorded as failed. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
/** Set by Ctrl-C: finish the job in hand, claim no more. */
let stopping = false;

// ── The worker agent ─────────────────────────────────────────────────────────
const config = loadSyndicate(syndicateFile);
const sub = config.subagents.find((s) => s.name === agentName);
const isOrchestrator = config.orchestrator.name === agentName;
if (!sub && !isOrchestrator) {
  const names = [config.orchestrator.name, ...config.subagents.map((s) => s.name)].join(', ');
  console.error(`✗ ${syndicateFile} has no agent named "${agentName}". Agents: ${names}.`);
  process.exit(1);
}

// Fail fast with the missing variable's NAME, as the chat CLI does.
const model = sub ? sub.model : config.orchestrator.model;
const provider = providerForModel(model ?? '');
if (!providerKeyPresent(provider)) {
  console.error(`✗ ${PROVIDERS[provider].label} requires ${PROVIDERS[provider].keyEnv}, which is not set.`);
  process.exit(1);
}

const log = (message: string) => console.log(`[worker] ${message}`);

// The queue: the JSON file, or Postgres when DATABASE_URL is set, where any
// number of workers may run (each claim is FOR UPDATE SKIP LOCKED).
// A checkpoint above MELCHIZEDEK_CHECKPOINT_MAX_BYTES (bytes of JSON, default
// 5 MiB) is not saved: the job keeps its previous one (ADR 0113).
const rawCap = process.env[CHECKPOINT_MAX_BYTES_ENV];
const checkpointMaxBytes = checkpointMaxBytesSetting(rawCap);
if (rawCap?.trim() && Number(rawCap.trim()) !== checkpointMaxBytes) {
  log(`${CHECKPOINT_MAX_BYTES_ENV} is not a positive whole number of bytes; using ${checkpointMaxBytes}`);
}
const taskQueue = { checkpointMaxBytes, log };
const databaseUrl = process.env.DATABASE_URL?.trim();
const pg = databaseUrl ? postgresStorage({ connectionString: databaseUrl, schema: dbSchema(), taskQueue }) : undefined;
const backend = pg ? pg.taskQueue : fileTaskBackendWith(taskQueue);
setTaskBackend(backend);
/** A claimed job stays this worker's while it renews; the job timeout bounds a turn. */
const lease: WorkerLease = { workerId: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`, leaseMs: 60_000 };

/**
 * The worker as a syndicate the runtime can run. A subagent becomes the
 * orchestrator of a one-agent syndicate; a subagent that mounts another
 * syndicate (`yaml_reference`) runs that syndicate whole.
 */
const workerConfig: SyndicateYamlConfig = !sub
  ? config
  : sub.yaml_reference
    ? loadSyndicate(sub.yaml_reference)
    : ({
        syndicate_name: config.syndicate_name,
        max_steps: config.max_steps,
        orchestrator: sub,
        subagents: [],
      } as unknown as SyndicateYamlConfig);

/** The job in hand, so a signal can cancel it. */
let current: AbortController | undefined;
/** Set by SIGTERM: the job in hand goes back to the queue with its checkpoint. */
let interrupted = false;

// ── One job = one durable single-turn run (ADR 0113) ────────────────────────
// A fresh in-process store per attempt, restored from the job's last
// checkpoint when an earlier attempt left one (ADR 0080, ADR 0113).
const durableTurn = (job: OwnedTask) => (args: { signal: AbortSignal; checkpoints: CheckpointSink }) =>
  runDurableTurn({
    config: workerConfig,
    parts: [{ text: job.instruction ?? job.title }],
    appName: 'assistant-worker',
    userId: 'local-user',
    runId: `${job.owner}:${job.id}`,
    checkpoints: args.checkpoints,
    onSaveError: (e) => log(`checkpoint not saved: ${e instanceof Error ? e.message : String(e)}`),
    compile: { log, onUnknownTool: (n) => log(`unknown tool '${n}' skipped`) },
    signal: args.signal,
    deadlineMs: JOB_TIMEOUT_MS,
    events: { warn: (m) => log(`⚠ ${m}`) },
  });

/** Runs queued jobs until none is left. Returns how many it ran. */
async function drain(): Promise<number> {
  for (let ran = 0; ; ) {
    // Measured before the claim is sent, so the window the worker trusts ends no later than the store's.
    const claimedAt = systemClock.now();
    const job = await backend.claimNext(lease);
    if (!job) return ran;
    ran += 1;
    const label = job.owner ? `${job.id} (${job.owner})` : job.id;
    // The title is the person's words: the log names the job, never its text.
    log(`${label} started (${(job.instruction ?? job.title).length.toLocaleString()} chars)`);
    const controller = new AbortController();
    current = controller;
    // SIGTERM landed while the claim was in flight.
    if (interrupted) controller.abort(new Interrupted('SIGTERM'));
    try {
      await runClaimedJob({ backend, lease, job, claimedAt, controller, turn: durableTurn(job), log });
    } finally {
      current = undefined;
    }
    if (stopping) return ran;
  }
}

/** Puts back jobs whose lease ran out: a dead worker's, or one that stopped because it could no longer confirm its own. */
async function recoverExpired(): Promise<void> {
  const { requeued, failed } = await backend.recover();
  if (requeued.length) log(`re-queued interrupted jobs: ${requeued.join(', ')}`);
  if (failed.length) log(`gave up on repeatedly interrupted jobs: ${failed.join(', ')}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
log(`agent ${agentName} (${model ?? 'default model'}) from ${syndicateFile}`);
log(pg ? 'store Postgres (DATABASE_URL)' : `store ${taskStorePath()}`);
await recoverExpired();

if (once) {
  const ran = await drain();
  log(ran ? `queue empty after ${ran} job(s)` : 'queue empty');
  await pg?.close();
  process.exit(0);
}

log(`polling every ${intervalSeconds} s (Ctrl-C to stop)`);
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  log('stopping after the current job (Ctrl-C again to quit now)');
});
// A container stop: abort the step in flight and put the job back in the
// queue with its checkpoint, so the next worker resumes it (ADR 0113).
process.on('SIGTERM', () => {
  stopping = true;
  interrupted = true;
  log('SIGTERM — stopping the current job; it resumes from its last checkpoint');
  current?.abort(new Interrupted('SIGTERM'));
});
while (!stopping) {
  await drain();
  for (let waited = 0; waited < intervalSeconds && !stopping; waited += 1) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Only on Postgres: the file store's recover takes every running job, and has no leases to expire.
  if (pg && !stopping) await recoverExpired().catch((e: unknown) => log(`recovery failed: ${e instanceof Error ? e.message : String(e)}`));
}
process.exit(0);
