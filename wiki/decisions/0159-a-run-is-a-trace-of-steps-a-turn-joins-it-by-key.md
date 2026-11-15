---
type: decision
title: "ADR 0159: A run is a trace of steps; a turn joins it by key"
description: "A program's run is a trace of its own holding step spans and the model calls made directly under them; every turn is always the root of its own trace and names its run and step by attribute, which the ledger keeps in run_id and run_step_span_id."
tags:
  - decision
  - observability
  - operations
status: stable
generated:
  by: claude-code/claude-fable-5-2
  at: 2026-11-15
sources:
  - resource: lib/observability/run.ts
  - resource: lib/observability/runContext.ts
  - resource: lib/observability/tracer.ts
  - resource: lib/observability/lineage.ts
  - resource: lib/observability/supabaseSpanExporter.ts
  - resource: db/migrations/0026_run_key.sql
  - resource: db/telemetry.sql
  - resource: tests/runKey.test.ts
  - resource: tests/postgresLedger.test.ts
---

# ADR 0159: A run is a trace of steps; a turn joins it by key

**Decided (2026-11-15):** A program's run is a trace of its own that holds only its steps and the model calls made directly under them. A turn is always the root of a new trace, whatever span the calling code has active, and is tied to the run that started it by key: the run's id and name and the active step's span id on the turn's root span, kept in `adk_turns.run_id` and `run_step_span_id` (migration 0026). A step records its name, timing, failure and labels, and no argument, result or error message.

**Instead of:** a turn joining its caller's trace (what an active caller span caused by accident before this: two turns shared one trace id, so stats, price, payload policy and erasure crossed between them); the old behaviour kept behind an option; the run key as an unindexed attribute, as `script.run` is read; a run table of its own; a step storing bounded arguments and results as a tool span does; a retention rule for runs.

**Supersedes:** extends [ADR 0139](/decisions/0139-the-ledger-keeps-the-span-tree.md) (a `step` kind) and [ADR 0043](/decisions/0043-link-inbound-trace-context.md) (a turn's trace id is never a caller's, for an in-process span as for a `traceparent`)

**Open:** script runs and test runs keep their own keys (`script.run`, `eval_run`) and are not runs here; a model call made outside a turn is in its run's rows and in no turn's totals; a failed direct call keeps no payload, since payloads are decided by a turn's outcome; a run that spans days ages out of a pruned ledger row by row.

How it works: [Runs and steps](/overview/runs.md)
