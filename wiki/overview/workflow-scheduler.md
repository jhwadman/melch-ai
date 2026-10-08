---
type: subsystem
title: Workflow scheduler
description: "The engine's own walk of a workflow graph (lib/workflow/scheduler.ts): runWorkflowGraph runs a WorkflowGraph with ADK's Workflow loop. A node runs when a predecessor's completion triggers it, fan-out gives each target its own branch, a join waits for every predecessor, a map runs its agent per item under max_parallel, and outputs flow as inputs. Routes are matched in ADK's spelling of the key. Agent, tool and ask_user nodes and map items run through a runner the caller passes in. No ADK import. The native runtime does not call it yet."
tags:
  - runtime
  - agents
  - overview
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflow/graph.ts
  - resource: tests/workflowScheduler.test.ts
---

# Workflow scheduler

`lib/workflow/scheduler.ts` runs the [workflow graph](/overview/workflow-graph.md) that `buildWorkflowGraph` builds, without ADK. It walks the graph the way ADK 2.2's `Workflow` does, so a workflow completes in the order ADK records for it. Why it copies ADK's loop, and matches routes in ADK's spelling, is [ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md). The native runtime still refuses a workflow syndicate ([ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)). Agent nodes and map items run on it through `agentNodeRuntime` ([Workflow agent node](/overview/workflow-agent-node.md)); the scheduler is the walk the native runtime will use once ask_user and tool nodes run on it too (WS4-4a, WS4-5) and the turn runner calls it (WS4-6).

## The interface

`runWorkflowGraph(graph, options)` resolves with `{ output, outputs, order }`:

- `output` is the terminal node's output.
- `outputs` holds every node's latest output.
- `order` lists the node names in the order they completed.

| option | is |
|---|---|
| `input` | the workflow's input, which every node after `START` receives |
| `runNode(run)` | runs an agent, tool or ask_user node, or one map item, and returns `{ output, route? }` |
| `signal` | aborts every run in flight |
| `onEvent(event)` | `node_start`, `node_end`, `item_start` and `item_end`, synchronously, in order |
| `nodePath`, `branch` | the workflow's own path (default: the graph's name) and branch (default: none) |

`streamWorkflowGraph(graph, options)` is the same walk as an async generator. It yields each event, then returns the run. The walk does not wait for the reader.

A `NodeRun` carries the `target`: the graph node, or `{ kind: 'map_item', agent, map, index }`. It also carries the `input`, the `runId` (the node's run counter, or the item's index), ADK's node `path` (`<workflow>.<node>`, or `<workflow>.<map>.<agent>@<index>`), ADK's `branch`, and an `AbortSignal`.

## The walk

| node kind | run by | output |
|---|---|---|
| `start` | the scheduler: one trigger per `START` edge, with the workflow input | — |
| `agent`, `tool`, `ask_user` | `runNode` | what the runner returns |
| `join` | the scheduler, once every predecessor has completed | `{ <predecessor>: <output> }`, keyed in edge order |
| `route` | the scheduler | its input, with `routeOf(input, routeKey)` as the route ([lib/workflow/route.ts](/overview/workflow-agent-node.md#route-derivation)) |
| `map` | the scheduler's pool, one `runNode` per item | the results, by index |

Each pass starts every triggered node that is not already running, in the order its triggers arrived, until `max_concurrency` nodes are running. It then handles the first run to settle. `Promise.race` takes the pending runs in start order, so of two runs already settled, the one started first goes first. A completed node triggers:

- every `always` edge;
- every keyed edge whose key, spelled as ADK stores it (`01` as `1`, `true` as `true`), equals the emitted route as a string;
- the `default` edge, when no keyed edge matched.

Only a join waits for all its predecessors. A plain node with two predecessors runs once per trigger. A trigger that arrives while the node is running runs after it.

A fan-out gives each target its own branch (`Writer@1`). A successor keeps its predecessor's branch, and a join takes the common prefix of its predecessors' branches. A map item's branch is `<map's branch>.<agent>@<index>`. A map runs `min(max_parallel ?? 8, items)` workers, and each worker takes the next item. A non-list input is one item, and an empty list outputs `[]`. A node whose output is undefined passes `undefined` on and is left out of `outputs`, as in ADK. Two terminal nodes with output fail the run with ADK's message.

## What it does not do yet

These come in WS4-2b:

- **Retries and timeouts.** `executeNode` is the one place every node runs, so this is where they will wrap.
- **The node-error policy.** Today the first error aborts the workflow's signal, waits for the pending runs to settle, and is rethrown unchanged.
- **A deadline.**

Later tickets add interrupts (ask_user's pause, WS4-4a) and resuming from stored events. A task-mode agent node needs nothing of the scheduler: its run ends inside `runNode` on `finish_task`'s answer ([Workflow agent node](/overview/workflow-agent-node.md)).

## Parity with ADK

`tests/workflowScheduler.test.ts` builds each case's graph twice. One copy goes through `buildWorkflowGraph` for the scheduler. The other goes through today's `compileWorkflow`, with every agent replaced by a stub `FunctionNode` and run by ADK's `Runner`. The stubs are the same on both sides. The test compares the agent calls with their inputs, every node's output, path and branch in completion order, and the workflow's output.

The cases are:

- the six-node fan-out-and-join fixture under four timing profiles, with ADK's orders also pinned as literals;
- a three-way join with late predecessors, beside a plain node with two;
- a map under `max_parallel` 1, 2 and the default;
- a non-list input and an empty list to a map;
- a chain;
- routing by key, by a list of targets, by `default`, and by a key spelled `01`;
- `max_concurrency`;
- two terminal outputs.

The test also checks that the module reaches ADK through no value import.
