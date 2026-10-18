---
type: decision
title: "ADR 0113: Durable runs checkpoint their sessions beside the job at each step boundary"
description: "The worker runs each background job through runDurableTurn, checkpointing every session the run wrote at each step boundary beside the job, so a re-claimed job resumes from the last checkpoint; running jobs and A2A tasks on other replicas can be cancelled."
tags:
  - decision
  - runtime
  - tools
  - storage
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
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

# ADR 0113: Durable runs checkpoint their sessions beside the job at each step boundary

**Decided (2026-10-09):** Make long runs durable by snapshotting the run's sessions at every step boundary and storing the snapshot beside the job; a re-claimed job restores it and takes the next step, with `runSyndicateTurn` unchanged. SIGTERM re-queues with the checkpoint, a running job can be cancelled, and an A2A cancel reaching another replica is recorded on the task row for the lease holder.

**Instead of:** a resumable runSyndicateTurn, a durable session store per job, per-event logging with replay
**Superseded by:** [ADR 0121](/decisions/0121-checkpoint-cap-and-dispatch-route-resume.md) (checkpoint size cap; resume inside a dispatch agent route)
**Open:** a resumed dispatch run classifies its route again (the classifier call is not checkpointed)

How it works: [Task tools](/tools/task-tools.md)
