---
type: decision
title: "ADR 0121: Oversized checkpoints are skipped; durable dispatch runs resume inside routes"
description: "A checkpoint above a size cap is skipped and the previous one kept, and a durable dispatch run resumes from inside an agent route."
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
  - resource: lib/tools/taskTools.ts
  - resource: lib/storage/postgres/taskQueue.ts
  - resource: lib/storage/postgres/index.ts
  - resource: scripts/assistant_worker.ts
  - resource: lib/runtime/native/checkpoint.ts
  - resource: lib/session/transcript.ts
  - resource: tests/checkpointCap.test.ts
  - resource: tests/checkpoint.test.ts
  - resource: tests/taskTools.test.ts
---

# ADR 0121: Oversized checkpoints are skipped; durable dispatch runs resume inside routes

**Decided (2026-10-09):** A task backend stores a checkpoint only up to a cap (default 5 MiB); above it the previous checkpoint is kept and the job runs on. A durable dispatch run killed inside an agent route resumes from its checkpoint instead of starting over.

**Instead of:** failing the job, compressing, trimming old events, checkpoints in the conversation tables, a resumable `runSyndicateTurn` option, re-reading the projection on every get
**Supersedes:** [ADR 0113](/decisions/0113-durable-runs-checkpoint-the-sessions-beside-the-job.md) (setting aside a checkpoint taken inside an agent route)
**Open:** a resumed dispatch run pays for its classifier calls again

How it works: [Task tools](/tools/task-tools.md)
