---
type: decision
title: "ADR 0087: The workflow scheduler walks the graph as ADK's Workflow does, matches routes in ADK's spelling, and leaves node execution to an injected runner"
description: "lib/workflow/scheduler.ts runs a WorkflowGraph with ADK 2.2's own loop: triggers buffered per node, Promise.race over the pending runs in start order, a join triggered only when every predecessor has completed, a plain node run once per trigger, ADK's branches and node paths, and ADK's terminal-output rule. A routed edge matches when its key, spelled as ADK stores it, equals the emitted route as a string, which replaces ADR 0082's expectation that the scheduler compare the key as written. The scheduler runs start, join, route and map itself and hands agent, tool and ask_user nodes and map items to a runner the caller passes in. A topological-batch scheduler, a settle-order queue, matching keys as written, and a join-like wait for every node with several predecessors were rejected."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflow/graph.ts
  - resource: lib/workflow.ts
  - resource: tests/workflowScheduler.test.ts
---

# ADR 0087: The workflow scheduler walks the graph as ADK's Workflow does

## Context

[ADR 0082](/decisions/0082-workflow-graph-mirrors-the-adk-compile.md) gave the engine its own model of a `workflow:` block, `WorkflowGraph`, built by `buildWorkflowGraph` with no ADK import. Gate G4 of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) needs the workflow suite to pass under `native`. The first piece of that is a scheduler that walks the graph (WS4-2a). Node execution comes in later tickets: agent nodes (WS4-3), ask_user (WS4-4a), tool nodes (WS4-5), and retries, timeouts, abort and the node-error policy (WS4-2b).

ADK's `Workflow` (ADK 2.2, `workflow/workflow.js`) is the behaviour to match. Running it with stub nodes showed four things a scheduler could easily get different:

- **Ties.** ADK picks the next completion with `Promise.race` over its pending runs, in the order they started. Of two runs that have both settled, the one that started first is handled first, even if the other settled earlier.
- **Fan-in.** Only a `JoinNode` waits for every predecessor. A plain node with two predecessors runs twice, once per trigger. A trigger that arrives while the node is running is buffered and runs after it.
- **Branches.** Each run carries a branch (`Planner@1`, `Writer@1`, `Fan.Worker@0` style paths) that ADK writes on its events. A fan-out gives each target a sub-branch, a successor inherits its predecessor's branch, and a join takes the common prefix of its predecessors' branches.
- **Route matching.** ADK stores a routing-map key that spells an integer as a number (`01` becomes `1`), and `true` or `false` as a boolean. It then compares the emitted route with the stored key as strings. An emitted `1` takes the edge written `01`, and an emitted `01` does not.

## Decision

1. **`lib/workflow/scheduler.ts` is ADK's loop, step for step, with no ADK import.** `runWorkflowGraph(graph, { input, runNode, signal, onEvent })` seeds one trigger per `START` edge. Each pass starts every buffered node that is not already running, in buffer order, up to `max_concurrency`. It then waits on `Promise.race` over the pending runs and handles the winner. A completed node triggers the successors its route selects. A join is triggered only when every predecessor's last run has completed, with `{ <predecessor>: <output> }` keyed in edge order. Branches, run ids and node paths are computed as ADK computes them. The workflow's output is the one terminal node's output, and two terminal outputs fail the run with ADK's message. `streamWorkflowGraph` is the same walk as an async generator, and a slow reader does not change the order.
2. **A route matches in ADK's spelling.** A keyed edge fires when `adkRouteString(key)` equals the emitted route, or one of the emitted routes, compared as strings. The `default` edge fires when no keyed edge matched. The model still keeps the key as written (ADR 0082 decision 3). This record replaces ADR 0082's expectation, under "Alternatives considered", that the native scheduler would compare the route with the key as written.
3. **The scheduler runs the graph's own mechanics; a runner the caller passes runs everything else.** `start` seeds the walk. `join` outputs its input, and `route` outputs its input with `routeOf(input, routeKey)` as the route. `map` is ADK's `ParallelWorker` pool: `min(max_parallel ?? 8, items)` workers, results by index, a non-list input as one item, and `[]` for an empty list. Agent, tool and ask_user nodes, and each map item, go to `runNode(run)`, which receives the target, input, run id, path, branch and an `AbortSignal`.
4. **The seams for WS4-2b are fixed now.** Every node runs through one function, `executeNode`, which is where a retry or a timeout will wrap. Every run gets the workflow's signal, chained to the caller's. A node that throws stops the walk as ADK's does: the workflow aborts, the pending runs settle, and the error is rethrown unchanged. A node result carries an output and a route only. Interrupts, task-mode nodes that wait for their output, and resuming from stored events are added by the tickets that need them.

## Alternatives considered

- **A topological-batch scheduler**: run each layer of the graph, then the next. This is simpler to reason about, but a fast branch would wait for a slow one in the same layer. The completion order would also differ from what ADK records. That would break G4's requirement that a workflow behaves the same on both runtimes, and make it harder for a run paused under `adk` to resume under `native`.
- **A settle-order queue**: each run pushes itself on a queue when it settles. This is deterministic in a stricter sense than `Promise.race`. But when two runs have both settled by the time the loop looks, it handles them in settle order, where ADK handles them in start order. The fixture's "same timer" profile would differ.
- **Compare a route with the key as written**, as ADR 0082 expected. Then `01` and `1`, `-0` and `0`, and integers past 2^53 would route differently on the two runtimes. The model keeping the key as written costs nothing. Matching is where the outcome changes, so matching follows ADK.
- **Make every node with several predecessors wait for all of them.** That is what a reader might expect from `[[A, B], Editor]`, but ADK runs `Editor` twice. The YAML has `join: true` for waiting. Changing the semantics belongs to its own record, applied to both runtimes at once.

## Consequences

- `tests/workflowScheduler.test.ts` runs every case on both sides. One side is the real `compileWorkflow` with every agent replaced by a stub `FunctionNode` and run by ADK's `Runner`. The other is the scheduler with the same stubs. The test compares the agent calls and their inputs, every node's output, path and branch, in order, and the workflow's output. The six-node fan-out-and-join fixture's completion orders are also pinned as literals for four timing profiles, so an ADK upgrade that changes them fails by name.
- The native runtime still refuses a workflow syndicate ([ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)). Nothing in the turn runner calls the scheduler yet.
- The module is internal: not in the `exports` map or the `lib/index.ts` barrel.
