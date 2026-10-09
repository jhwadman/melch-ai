---
type: decision
title: 'ADR 0113: A long run is durable by checkpointing its sessions beside the job at every step boundary, and a re-claimed job resumes from the last one'
description: The worker runs each background job through runDurableTurn (lib/runtime/native/checkpoint.ts), which snapshots every session the run has written at each step boundary and stores the snapshot beside the job (migration 0014); a job claimed again after its worker stopped is restored from that snapshot and continues with the next step. SIGTERM re-queues the job with its checkpoint, cancelling a running job stops it at the next renewal or save, and an A2A cancel that reaches a replica not running the task is recorded on the task row and honoured by the replica that holds it. A resumable runSyndicateTurn, a durable session store per job, and per-event logging with replay were rejected.
tags:
  - decision
  - runtime
  - tools
  - storage
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/runtime/native/checkpoint.ts
  - resource: scripts/assistant_worker.ts
  - resource: lib/tools/taskTools.ts
  - resource: lib/storage/postgres/taskQueue.ts
  - resource: lib/storage/postgres/taskStore.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/a2a/app.ts
  - resource: db/migrations/0014_durable_runs.sql
---

# ADR 0113: A long run is durable by checkpointing its sessions beside the job at every step boundary, and a re-claimed job resumes from the last one

## Context

[ADR 0015](/decisions/0015-task-queue-and-worker.md) runs background work as a queue the tools write and a worker drains. A job ran as one fresh turn on an in-process session store, so a worker that stopped mid-job lost everything the job had done: the job went back to the queue and started again from its first model call, paying again for every step, or failed after two interruptions. A container stop failed the job outright. A job could be cancelled only before it ran. Over A2A, a cancel stopped a task only when it reached the instance running it; with several replicas behind a load balancer, most cancels reached one that was not.

Three shapes were considered for resuming a run:

1. **A resumable `runSyndicateTurn`**: a new option that says "continue this turn, do not store the message again". It changes the turn runner's signature, which every surface and the boundary suite pin ([ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md)), for the one caller that needs it.
2. **A durable session store per job**: run the job on the Postgres session store under a job-derived id. The opening message is still stored a second time on resume, the file-store worker has no durable session store, and the job's working sessions would live in the conversation tables and outlast the job.
3. **A checkpoint of the run's sessions beside the job**, taken at step boundaries by a session-store wrapper, restored into a fresh in-process store on the next claim.

## Decision

The third. `lib/runtime/native/checkpoint.ts` wraps the in-process store a job runs on. After each stored event it checks for a **step boundary**: the event carries function responses and, across every session the run has written, every call has its response (calls that wait on a person aside), so a parent waiting on a delegated subagent is never a boundary and a final answer is never one (a resumed run redoes the last step). At a boundary it hands the sink a snapshot of every session, with the state each was created with. `runDurableTurn` loads the job's checkpoint, restores it when it belongs to the same run and the same message, and calls `runSyndicateTurn` unchanged: subagent sessions are restored at once; the run's own opening sessions are held back until the runner opens them, and the runner's opening message is answered with the stored events instead of being stored twice. The agent loop then reads the same history it would have read and takes the next step.

The checkpoint is stored beside the job, not in it: `melchizedek_tasks.checkpoint` on Postgres (migration `0014_durable_runs.sql`), a sidecar file next to the JSON store. `TaskBackend.saveCheckpoint` is guarded by the worker's claim and resolves false once the job is no longer its running job; `renew` reports the same. A checkpoint lives only while the job is running or queued.

- **SIGTERM** aborts the step in flight and re-queues the job with its checkpoint (the interrupted-job rule, so a job interrupted `MAX_ATTEMPTS` times still fails); the next worker resumes it.
- **Cancelling a running job** (`task_update` → `cancelled`) ends the claim; the worker sees it at its next renewal or checkpoint save, aborts the run, and writes nothing over the cancellation.
- **A2A cancel across replicas**: the A2A SDK answers a `tasks/cancel` that reaches an instance with no event bus for the task by saving the task `canceled` itself, without calling the executor. The Postgres task store turns that save into a request when another live instance holds the task's lease: the row stores the canceled task, keeps the lease with the running instance and sets `adk_a2a_tasks.cancel_requested_at`; later saves from the running instance only renew or clear the lease, so the reported cancel is never overwritten by `completed`. The running instance reads the request on its lease heartbeat (`leases.cancelRequested`, every third of the lease) and aborts the run, as a local cancel does. `PostgresTaskStore.requestCancel` records a request directly. A cancel on an expired lease is a plain cancel, and the reaper keeps a reported cancel instead of failing the task. A task aborted while it waits for its conversation's turn lock ends `canceled`, not `rejected`. Working updates keep streaming as `working` status updates while the run goes on.

> **Note (2026-10-09):** [ADR 0121](/decisions/0121-checkpoint-cap-and-dispatch-route-resume.md) caps a stored checkpoint (default 5 MiB of JSON; a save above it keeps the previous checkpoint) and resumes a dispatch run from inside an agent route: the consequence below that such a run is not resumed, and that `runDurableTurn` sets its checkpoint aside, no longer holds.

## Consequences

- A resumed run's stored history equals an uninterrupted run's, up to ids and times of the steps run after the resume; `tests/checkpoint.test.ts` holds a run killed mid-step to that.
- The route classifier's model call is not checkpointed: it runs in a throwaway store, so a resumed dispatch run classifies again, and may pay for that call twice.
- A dispatch run is not resumed from inside an agent route: the route reads the conversation through a projection (`lib/session/transcript.ts`) copied when the route opens it, which restored events cannot reach, so `runDurableTurn` sets such a checkpoint aside and the job runs from the start. A dispatch checkpoint holding only the opening message (as a workflow route leaves it) is restored. The worker's default agent is a single agent, which resumes.
- Each resumed attempt has its own step budget (`max_steps`, the loop's call ceiling); attempts are still bounded by `MAX_ATTEMPTS`. `temp:` state, which is never stored, does not survive a resume.
- A workflow route resumes through the workflow's own rules ([ADR 0094](/decisions/0094-workflow-resume-rebuilds-node-states-from-the-events.md)); its checkpoint is the session it walks.
- A2A turns stay non-resumable: a turn is request-scoped, and the reaper still fails a task whose instance died. Durable long runs go through the queue and the worker. The reaper never touches a background job: a queued job, or a running one whose lease is live, keeps its checkpoint.
- A checkpoint holds the run's sessions, so it carries the job's instruction, model output and tool results: the same disclosure as the session tables, filed under the job's owner, never shown by `task_get`, and deleted with the job or when it finishes.
- `TaskBackend` gains two optional members and `renew` may resolve false; a consumer's own backend type-checks unchanged and simply does not checkpoint.
