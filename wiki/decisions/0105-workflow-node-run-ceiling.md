---
type: decision
title: "ADR 0105: A native workflow walk starts at most 20 × max_steps node runs"
description: "A native workflow walk starts at most max(20 × max_steps, 100) node runs, so a routed cycle through model-free nodes fails NODE_RUN_LIMIT instead of running until the deadline."
tags:
  - decision
  - runtime
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow/scheduler.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/turnControl.ts
  - resource: tests/workflowNodeRunLimit.test.ts
---

# ADR 0105: A native workflow walk starts at most 20 × max_steps node runs

**Decided (2026-10-08):** Bound every walk by node runs derived from the author's own budget: `max(20 × max_steps, 100)`. The run that would pass it fails its node with `NodeRunLimitError`, and the turn fails `NODE_RUN_LIMIT`.

**Instead of:** a YAML key max_node_runs (deferred), a fixed constant, 10 × max_steps, counting attempts or map items, stopping the turn through turnControl, the deadline as the only bound
**Open:** a `workflow.max_node_runs` key, once a real graph needs it

How it works: [Workflow scheduler: the node-run ceiling](/overview/workflow-scheduler.md)
