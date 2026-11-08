---
type: decision
title: "ADR 0157: Job mutations are fenced by a per-claim token, and an expired lease is not owned"
description: "Every worker write on a background job matches a token new with each claim, a lease still in the future and running status; a finish answers accepted or lost; the additive FencedTaskBackend capability is what the built-in worker requires."
tags:
  - decision
  - tools
  - tasks
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-11-08
sources:
  - resource: lib/tools/taskTools.ts
  - resource: lib/storage/postgres/taskQueue.ts
  - resource: lib/runtime/claimedJob.ts
  - resource: scripts/assistant_worker.ts
  - resource: db/migrations/0025_task_claim_token.sql
---

# ADR 0157: Job mutations are fenced by a per-claim token, and an expired lease is not owned

**Decided (2026-11-08):** A job's claim has its own token, and every worker write matches it, the worker id, `running` and an unexpired lease, so a stale claim changes nothing even before a reaper runs. A worker stops as soon as it cannot confirm its lease, and the workers reap expired leases between polls so a job that stopped this way is not stranded. Fencing reaches consumers as an additive capability, `FencedTaskBackend`, which the built-in worker requires; `finish` widens to answer `accepted` or `lost`, and a job carrying no claim is `lost`, never an unfenced write.

**Instead of:** a monotonic generation (it adds nothing a unique token lacks, and needs a read of the last value to bump); matching the worker id alone (a process can claim a job twice); letting a late renewal revive an expired lease, as before (a reclaim that races it has no loser); a required new `finish` parameter (breaks every custom backend for a guarantee the token on the job already gives); a database trigger rejecting older workers' writes (a rolling-upgrade mechanism that outlives the upgrade).

**Open:** Making `job.claim` and a `finish` result required on `TaskBackend` is a breaking change, left for a major version. Reaping happens between a worker's polls, so a fleet with no running worker reaps nothing, as before.

How it works: [Task tools](/tools/task-tools.md)
