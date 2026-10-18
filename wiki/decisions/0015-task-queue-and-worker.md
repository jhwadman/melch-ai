---
type: decision
title: "ADR 0015: Background work is a queue tools write and a worker drains"
description: "`task_queue` only writes a record; a separate worker process claims it, runs it through one YAML-declared agent and writes the result back."
tags:
  - decision
  - tools
  - starter-pack
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/taskTools.ts
  - resource: scripts/assistant_worker.ts
  - resource: config/agents/examples/assistant.yaml
---

# ADR 0015: Background work is a queue tools write and a worker drains

**Decided (2026-09-25):** Long work is a queued record with a self-contained instruction; `melchizedek-worker` claims it, runs one fresh turn through a YAML-declared agent, and writes the result for `task_get`.

**Instead of:** a tool that runs a subagent asynchronously, an in-process job runner inside the server
**Superseded by:** [ADR 0021](/decisions/0021-postgres-first-storage.md) (on Postgres the queue is per-caller with locked claims); [ADR 0113](/decisions/0113-durable-runs-checkpoint-the-sessions-beside-the-job.md) (jobs checkpoint and resume)
**Open:** the default JSON-file store is single-user and one-worker, stated but not enforced in code

How it works: [Task tools](/tools/task-tools.md)
