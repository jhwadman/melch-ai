---
type: decision
title: "ADR 0087: The workflow scheduler walks the graph as ADK's Workflow did"
description: "The engine's workflow scheduler reproduces ADK's Workflow loop step for step, matches routes in ADK's spelling, and leaves node execution to an injected runner."
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
  - resource: lib/workflow.ts
  - resource: tests/workflowScheduler.test.ts
---

# ADR 0087: The workflow scheduler walks the graph as ADK's Workflow did

**Decided (2026-10-08):** `lib/workflow/scheduler.ts` is ADK's `Workflow` loop with no ADK import (triggers buffered per node, `Promise.race` in start order, only a join waits for all predecessors). A keyed edge matches the emitted route in ADK's string spelling. The scheduler runs start, join, route and map itself and hands agent, tool and ask_user nodes to a runner the caller passes.

**Instead of:** a topological-batch scheduler, a settle-order queue, matching keys as written, a join-like wait for every multi-predecessor node

**Supersedes:** [ADR 0082](/decisions/0082-workflow-graph-mirrors-the-adk-compile.md) (its expectation that routes match the key as written)

How it works: [Workflow scheduler](/overview/workflow-scheduler.md)
