---
type: decision
title: "ADR 0089: Workflow retries, timeouts, node errors and abort follow ADK's node runner"
description: "Every workflow node attempt runs through one loop ported from ADK's node runner: per-attempt timeout, retry with backoff and jitter, errors reported once, the walk stopped by the turn's signal."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflow/graph.ts
  - resource: lib/runtime/turnControl.ts
  - resource: tests/workflowScheduler.test.ts
---

# ADR 0089: Workflow retries, timeouts, node errors and abort follow ADK's node runner

**Decided (2026-10-08):** One loop (`withControls`) ports ADK's `runChildNode` around every node and map item: a per-attempt timeout, retries per `max_attempts` and `exceptions` with ADK's backoff, never retrying an abort or a map item's failure. A node error is reported once when the node gives up; the walk stops on the turn's signal; a map item runs under its agent's modifiers; a null output is no output.

**Instead of:** racing every attempt against the abort, reporting every failed attempt, applying the map entry's own modifiers, resolving an aborted walk with partial outputs

**Superseded by:** [ADR 0103](/decisions/0103-workflow-retry-spelling-and-signed-reflection-call.md) (the schema refuses retry and timeout on a map entry, and spells `exceptions` and jitter)

How it works: [Workflow scheduler](/overview/workflow-scheduler.md)
