---
type: decision
title: "ADR 0105: a native workflow walk starts at most 20 × max_steps node runs"
description: "max_steps counts model calls, so a routed workflow cycle through nodes that make none (tool nodes, route steps) was bounded only by the turn's deadline (native-loop-security R4). The native scheduler now starts at most maxNodeRuns node runs per walk; inside a turn the default is nodeRunCeiling(max_steps), 20 runs per step and at least 100 (1,000 at the default of 50). The run that would pass it fails its node with NodeRunLimitError (code NODE_RUN_LIMIT, attempt count 0), reported once as the workflow's node-error event, and the turn fails NODE_RUN_LIMIT with a progress line. ADK's Workflow has no ceiling, so the adk runtime keeps the deadline as its bound: a native-only difference. A YAML key max_node_runs, a fixed constant, counting attempts or map items, and stopping the turn through turnControl were rejected."
tags:
  - decision
  - runtime
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/scheduler.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/turnControl.ts
  - resource: tests/workflowNodeRunLimit.test.ts
---

# ADR 0105: a native workflow walk starts at most 20 × max_steps node runs

## Context

[ADR 0082](/decisions/0082-workflow-graph-mirrors-the-adk-compile.md) refuses an unconditional cycle at compile and allows a routed one: a node may route back to itself or an earlier node, and the loop ends when its output stops naming that route. `max_steps` bounds a turn's model calls (`turnControl`), so a routed cycle with an agent node in it ends when the budget does. A routed cycle through nodes that make no model call, a tool node and its route step looping on each other, charges nothing. The security gate recorded it as R4 ([ADR 0101](/decisions/0101-native-loop-security-gate.md)): such a walk is bounded only by the turn's deadline (15 minutes over A2A), and a library caller with no `deadlineMs` loops until it stops the turn. Each iteration is a few milliseconds, so a deadline-bounded loop is hundreds of thousands of node runs and stored events.

ADK 2.2's `Workflow` has no ceiling on node runs (its loop counts only `maxConcurrency`), and its `RunConfig.maxLlmCalls` counts model calls as `max_steps` does.

## Decision

1. **The walk counts node runs.** `runWorkflowGraph` counts every run it starts of an agent, tool, ask_user, route, join or map node, once per run however many attempts the run makes. A map's items are not counted (R6: each calls a model, and `max_parallel` bounds them), nor is a node a resumed walk completes from its stored run.
2. **The ceiling is `maxNodeRuns`, from max_steps by default.** A caller passes `maxNodeRuns`; inside a turn the default is `nodeRunCeiling(control.maxLlmCalls)`: `max(20 × max_steps, 100)`, with `DEFAULT_MAX_STEPS` when the turn has no model-call ceiling. That is 1,000 at the default of 50. Outside a turn the scheduler sets none, as it takes no signal outside one.
3. **The run that would pass the ceiling fails its node.** It is not started (no `node_start`, no attempt): the node fails with `NodeRunLimitError`, whose `code` is `NODE_RUN_LIMIT`, and nothing more starts. The walk reports it as it reports any node that gave up: `node_error` with source `workflow`, error type `NodeRunLimitError` and attempt count 0, which the native turn stores as the workflow's node-error event (`nodeErrorEvent`). It is never retried. The runs in flight are aborted and settle, and the error is rethrown.
4. **The turn fails `NODE_RUN_LIMIT`.** `runSyndicateTurn` maps the error to its own code (not `NODE_FAILED`), keeps its message (the workflow, the limit, the node, and that max_steps raises it), and publishes the progress line `Stopped: the workflow reached its limit of <n> node runs`.
5. **Native only.** The adk runtime keeps ADK's behaviour: no ceiling, the deadline as the bound. The difference is recorded here and in the runbook, and a test runs a 60-iteration loop that completes on adk and fails on native under `max_steps: 2`.

## Alternatives considered

- **A YAML key, `workflow.max_node_runs`.** It would let an author size the ceiling to the graph, but the adk runtime could not honour it and would have to refuse it by name, and a second budget beside `max_steps` is one more knob to get wrong. `max_steps` already says how much work a turn may do; an author whose long tool pipeline needs more raises it. Deferred: it is a schema addition once a real graph needs it.
- **A fixed constant.** One number for every syndicate ignores the author's own budget: a desk that allows 200 model calls would be cut where one that allows 5 is not.
- **10 × max_steps.** 500 at the default, the figure ADK uses for model calls. The runbook's recommendation was 20 ×, and a bounded tool loop between agent steps (a poll, a pagination) is the legitimate case to leave room for. Either ends a model-free cycle in well under a second.
- **Count attempts, or map items.** A node's retries are bounded by its own `max_attempts`, and a map's items by its list and `max_parallel`; counting them would cut a legitimate graph for work the cycle does not repeat.
- **Stop the turn through `turnControl`** (a new stop reason beside `step_limit`). That aborts every run and ends the turn quietly, with no node-error event, so the session would not say which node the walk was on, and a nested workflow (a subagent) would stop its caller's turn instead of failing its call.
- **Match ADK and leave the deadline as the bound.** A loop that writes an event per run until the deadline is a storage and ledger cost the person never asked for; the gate recorded it as a finding.

## Consequences

- A routed cycle through model-free nodes ends in milliseconds on native, with an event that names the node and the turn's code. A legitimate loop under the ceiling runs as before (`tests/workflowNodeRunLimit.test.ts`, which also stores the same events on both runtimes for a bounded tool loop).
- Native departs from ADK in one more place, for a walk past the ceiling only; no event ADK stores for a walk under it changes, and the parity suites run unchanged.
- `NodeRunLimitError`, `NODE_RUN_LIMIT`, `nodeRunCeiling`, `NODE_RUNS_PER_STEP`, `MIN_NODE_RUNS` and `RunWorkflowOptions.maxNodeRuns` are new in `lib/workflow/scheduler.ts`, which stays internal: not in the `exports` map or the barrel. The turn's `NODE_RUN_LIMIT` error code is new on `SyndicateTurnResult.error`.
- Native-loop-security R4 moves from recorded to fixed.
