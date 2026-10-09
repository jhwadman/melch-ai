---
type: decision
title: "ADR 0121: A checkpoint above a size cap is skipped and the previous one kept, and a durable dispatch run resumes from inside an agent route"
description: "Two follow-ups to ADR 0113. A task backend stores a checkpoint only up to a cap (default 5 MiB of serialized JSON, DEFAULT_CHECKPOINT_MAX_BYTES; TaskBackendOptions.checkpointMaxBytes, PostgresStorageOptions.taskQueue, fileTaskBackendWith, the worker's MELCHIZEDEK_CHECKPOINT_MAX_BYTES): a save above it keeps the previous checkpoint, still answers whether the claim holds, and logs one line with the job id and the sizes. The checkpoint is serialized once (checkpointJson), and the file sidecar is written compact. A dispatch run killed inside an agent route now resumes from its checkpoint: ProjectedSessionService.append takes every event the real session gained, unprojected, when the store answers an append with its own events, so runDurableTurn no longer sets such a checkpoint aside; 1.1.0 checkpoints restore, and a nested dispatch syndicate run as a route resumes the same way. Failing the job, compressing, trimming old events, storing checkpoints in the conversation tables, a resumable runSyndicateTurn and re-reading the projection on every get were rejected."
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

# ADR 0121: A checkpoint above a size cap is skipped and the previous one kept, and a durable dispatch run resumes from inside an agent route

## Context

[ADR 0113](/decisions/0113-durable-runs-checkpoint-the-sessions-beside-the-job.md) checkpoints a background job's sessions beside the job at every step boundary. Two things it left behind:

1. **No bound on a checkpoint's size.** A checkpoint holds every session the run wrote, tool results included, and is written whole at every boundary: to a `jsonb` column on Postgres, to a sidecar file next to the JSON store. A run that reads large documents grows it with every step, and each save rewrites it.
2. **A dispatch run was not resumed from inside an agent route.** The route reads the conversation through the transcript projection (`ProjectedSessionService`, `lib/session/transcript.ts`), which copies the session when the route opens it. On resume the run's opening session is held back until the runner opens it, so the copy is empty, and the store answers the route's append of the message with the stored events; the projection applied only the one event it was given, so the route never saw its restored steps. `runDurableTurn` set such a checkpoint aside (`projectedRouteCheckpoint`) and the job ran from the start, paying again for every step.

## Decision

1. **A cap on a stored checkpoint.** `checkpointJson` (`lib/tools/taskTools.ts`) serializes the checkpoint once and returns the JSON, or `null` when it is above the cap: `TaskBackendOptions.checkpointMaxBytes`, default `DEFAULT_CHECKPOINT_MAX_BYTES` (5 MiB of serialized JSON, counted in UTF-8 bytes); a value that is not a positive integer is the default. Above the cap nothing is written: the job keeps its previous checkpoint, the save still answers whether the worker's claim holds (so a cancel still stops the run), and one line, `TaskBackendOptions.log` (default `console.warn`), records the job id and the sizes, never the checkpoint, which carries the user's text and tool results.
2. **Where the cap is set.** `fileTaskBackendWith(options)` builds the JSON-file backend (`fileTaskBackend` is it with the default); `postgresTaskBackend(pool, options?)` takes the same options, which `postgresStorage` passes from `PostgresStorageOptions.taskQueue`. The worker (`scripts/assistant_worker.ts`) reads `MELCHIZEDEK_CHECKPOINT_MAX_BYTES` (`CHECKPOINT_MAX_BYTES_ENV`) through `checkpointMaxBytesSetting`: digits only and above zero, else the default, with a log line naming the value it uses. The file sidecar is written compact, the saved checkpoint spliced in as serialized; a sidecar written pretty by 1.1.0 reads the same.
3. **The projection takes the store's answer.** When the store answers an append with events of its own (the checkpoint store answering the opening message with the run's stored events, the stored opening in place of the one given), `ProjectedSessionService.append` takes into the projected session, in place of the event it applied, every event the real session gained, unprojected: they are the current turn, which the projection never rewrites. The route's agent loop then reads its restored steps as a single agent reads them on the store's own session.
4. **`runDurableTurn` restores every usable checkpoint.** `projectedRouteCheckpoint` is gone. A checkpoint saved inside an agent route by 1.1.0 (the same format, version 1) restores. A nested dispatch syndicate run as a route ([ADR 0120](/decisions/0120-nested-dispatch-syndicates-route-as-at-the-top.md)) resumes the same way: its conversation's first event is the run's message, so the checkpoint holds it back as an opening session, and its route's append is answered with the stored events. A nested dispatch syndicate delegated to never checkpoints mid-child: a parent waiting on a call is never a step boundary (ADR 0113). The classifiers run again on resume, as before.

## Alternatives considered

- **Fail the job when a checkpoint is too large.** The run itself is healthy; only its insurance is too large to store. Failing it would turn a storage limit into a lost result. Keeping the previous checkpoint costs, at worst, redoing the steps since it.
- **Compress the checkpoint.** It postpones the bound rather than setting one, costs CPU at every boundary, and makes the column unreadable to an operator querying it. The cap is the honest limit; an operator who wants larger checkpoints raises it.
- **Trim old events out of the checkpoint.** A restored run must read the same history it would have read, or it diverges from the uninterrupted run (ADR 0113's guarantee); a trimmed checkpoint is a different conversation.
- **Store checkpoints in the conversation tables.** Rejected in ADR 0113 as a durable session store per job: the job's working sessions would outlast it, and the file-store worker has none.
- **A resumable `runSyndicateTurn` option, so the route never re-opens its projection.** Rejected in ADR 0113: it changes the seam every surface pins, for one caller.
- **Re-read the projection lazily on every `get`.** It would catch restored events too, but rebuilds the projection on every read of every route turn to serve the one append a resume answers differently.

## Consequences

- A job whose checkpoints outgrow the cap resumes from the last one that fitted, to the same history; `tests/checkpointCap.test.ts` covers the skipped save and its log line, a save under the cap beside other jobs, the cap to the byte in UTF-8, the variable's parsing, Postgres, and that resume.
- `tests/checkpoint.test.ts` resumes a dispatch run killed mid-step inside an agent route, classifying again and storing what an uninterrupted run stores; restores a 1.1.0-format checkpoint; and resumes inside a nested dispatch syndicate's route. `tests/taskTools.test.ts` reads the compact sidecar.
- `fileTaskBackendWith`, `checkpointJson`, `checkpointMaxBytesSetting`, `DEFAULT_CHECKPOINT_MAX_BYTES`, `CHECKPOINT_MAX_BYTES_ENV` and `TaskBackendOptions` are exported from `melchizedek-agents/tools/taskTools`; `PostgresStorageOptions.taskQueue` from `melchizedek-agents/storage/postgres`. No exports-map entry changes.
- A resumed dispatch run still pays for its classifier calls again.
