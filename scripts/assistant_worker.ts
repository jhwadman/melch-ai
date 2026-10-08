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
 *   A job runs through lib/runtime/syndicateTurn.ts (on the runtime
 *   MELCHIZEDEK_RUNTIME names, ADK by default), the same runtime the
 *   A2A server, the REPL and the observatory use, so it runs the exact agent
 *   the conversation would have called directly — with the same step cap —
 *   and the job timeout ABORTS the run (the model call in flight included)
 *   instead of abandoning it while it keeps spending. Any syndicate and any
 *   subagent in it can serve as the worker.
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
 */

import { randomUUID } from 'node:crypto';

import { loadEnv } from '../lib/loadEnv.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { asAdkSessionService } from '../lib/runtime/adkSessionBridge.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import {
  PROVIDERS,
  providerForModel,
  providerKeyPresent,
  registerAvailableProviders,
} from '../lib/models/registry.ts';
import { getTaskBackend, setTaskBackend, taskStorePath } from '../lib/tools/taskTools.ts';
import type { OwnedTask, TaskRecord, WorkerLease } from '../lib/tools/taskTools.ts';
import { postgresStorage } from '../lib/storage/postgres/index.ts';
import { dbSchema } from '../lib/storage/schema.ts';
import { hostname } from 'node:os';

loadEnv(import.meta.url);
setLogLevel('warn');
registerAvailableProviders();

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
const databaseUrl = process.env.DATABASE_URL?.trim();
const pg = databaseUrl ? postgresStorage({ connectionString: databaseUrl, schema: dbSchema() }) : undefined;
if (pg) setTaskBackend(pg.taskQueue);
const backend = getTaskBackend();
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

// ── One job = one fresh single-turn session ─────────────────────────────────
async function runJob(job: TaskRecord): Promise<string> {
  current = new AbortController();
  try {
    const result = await runSyndicateTurn({
      config: workerConfig,
      parts: [{ text: job.instruction ?? job.title }],
      appName: 'assistant-worker',
      userId: 'local-user',
      sessionId: randomUUID(),
      // A fresh in-process store per job, as the turn runner's signature
      // names it (ADR 0080). The runtime follows MELCHIZEDEK_RUNTIME.
      sessionService: asAdkSessionService(new InProcessSessionService()),
      compile: { log, onUnknownTool: (n) => log(`unknown tool '${n}' skipped`) },
      signal: current.signal,
      deadlineMs: JOB_TIMEOUT_MS,
      events: { warn: (m) => log(`⚠ ${m}`) },
    });
    if (result.status !== 'completed') {
      throw new Error(`${result.error?.code ?? 'ERROR'}: ${result.error?.message ?? ''}`.trim());
    }
    if (!result.text.trim()) throw new Error('the agent returned no text');
    return result.text.trim();
  } finally {
    current = undefined;
  }
}

/** Runs queued jobs until none is left. Returns how many it ran. */
async function drain(): Promise<number> {
  let ran = 0;
  for (let job = await backend.claimNext(lease); job; job = stopping ? null : await backend.claimNext(lease)) {
    ran += 1;
    const started = Date.now();
    const label = job.owner ? `${job.id} (${job.owner})` : job.id;
    log(`${label} started: ${job.title}`);
    // Renew the lease while the job runs, so no other worker takes it back.
    const held: OwnedTask = job;
    const heartbeat = setInterval(() => {
      backend.renew(lease, held).catch((e: unknown) => log(`lease renewal failed: ${e instanceof Error ? e.message : e}`));
    }, Math.floor(lease.leaseMs / 3));
    try {
      const result = await runJob(job);
      await backend.finish(job, { result });
      log(`${label} done in ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (error: any) {
      await backend.finish(job, { error: String(error?.message ?? error) });
      log(`${label} failed: ${error?.message ?? error}`);
    } finally {
      clearInterval(heartbeat);
    }
  }
  return ran;
}

// ── Main ─────────────────────────────────────────────────────────────────────
log(`agent ${agentName} (${model ?? 'ADK default'}) from ${syndicateFile}`);
log(pg ? 'store Postgres (DATABASE_URL)' : `store ${taskStorePath()}`);
const { requeued, failed } = await backend.recover();
if (requeued.length) log(`re-queued interrupted jobs: ${requeued.join(', ')}`);
if (failed.length) log(`gave up on repeatedly interrupted jobs: ${failed.join(', ')}`);

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
// A container stop: cancel the job in hand (it is recorded as failed and the
// store stays consistent), then exit.
process.on('SIGTERM', () => {
  stopping = true;
  log('SIGTERM — canceling the current job');
  current?.abort();
});
while (!stopping) {
  await drain();
  for (let waited = 0; waited < intervalSeconds && !stopping; waited += 1) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
process.exit(0);
