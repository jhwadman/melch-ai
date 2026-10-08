---
type: subsystem
title: Workflow scheduler
description: "The engine's own walk of a workflow graph (lib/workflow/scheduler.ts): runWorkflowGraph runs a WorkflowGraph with ADK's Workflow loop. A node runs when a predecessor's completion triggers it, fan-out gives each target its own branch, a join waits for every predecessor, a map runs its agent per item under max_parallel, and outputs flow as inputs. Routes are matched in ADK's spelling of the key. Every attempt runs under the node's retry and timeout as ADK's node runner runs it, node errors are emitted and collected, and the turn's cancel or deadline stops the walk. Agent, tool and ask_user nodes and map items run through a runner the caller passes in; toolNodeRunner (lib/workflow/toolNode.ts) is the runner for tool nodes and writes the event ADK's ToolNode writes. No ADK import. The native runtime does not call it yet."
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
  - resource: lib/runtime/turnControl.ts
  - resource: lib/workflow/toolNode.ts
  - resource: tests/workflowScheduler.test.ts
  - resource: tests/workflowToolNode.test.ts
---

# Workflow scheduler

`lib/workflow/scheduler.ts` runs the [workflow graph](/overview/workflow-graph.md) that `buildWorkflowGraph` builds, without ADK. It walks the graph the way ADK 2.2's `Workflow` does, so a workflow completes in the order ADK records for it. Why it copies ADK's loop, and matches routes in ADK's spelling, is [ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md). Why its retries, timeouts, node errors and abort follow ADK's node runner is [ADR 0089](/decisions/0089-workflow-scheduler-controls-follow-adks-node-runner.md). The native runtime still refuses a workflow syndicate ([ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)). Agent nodes and map items run on it through `agentNodeRuntime` ([Workflow agent node](/overview/workflow-agent-node.md)), and the runner for tool nodes is in place (below); the scheduler is the walk the native runtime will use once ask_user nodes run on it too (WS4-4a) and the turn runner calls it (WS4-6).

## The interface

`runWorkflowGraph(graph, options)` resolves with `{ output, outputs, order, nodeErrors }`:

- `output` is the terminal node's output.
- `outputs` holds every node's latest output.
- `order` lists the node names in the order they completed.
- `nodeErrors` lists every node error the walk emitted, as `{ node, code, message }`: the shape `runSyndicateTurn` collects in `answer.nodeErrors`.

It rejects with the error of the node that gave up, unchanged, or with `InvocationAbortedError` when its signal stopped it.

| option | is |
|---|---|
| `input` | the workflow's input, which every node after `START` receives |
| `runNode(run)` | runs one attempt of an agent, tool or ask_user node, or of one map item, and returns `{ output?, route?, error? }` |
| `signal` | stops the walk and aborts every run in flight; default: the current turn's signal (`turnControl`), so a cancel or the turn's deadline stops it |
| `onEvent(event)` | `node_start`, `node_end`, `item_start`, `item_end` and `node_error`, synchronously, in order |
| `nodePath`, `branch` | the workflow's own path (default: the graph's name) and branch (default: none) |

`streamWorkflowGraph(graph, options)` is the same walk as an async generator. It yields each event, then returns the run. The walk does not wait for the reader.

A `NodeRun` carries the `target`: the graph node, or `{ kind: 'map_item', agent, map, index }`. It also carries the `input`, the `runId` (the node's run counter, or the item's index), ADK's node `path` (`<workflow>.<node>`, or `<workflow>.<map>.<agent>@<index>`), ADK's `branch`, the `attempt` (from 1), and the attempt's `AbortSignal`. A runner settles promptly once the signal aborts.

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

A fan-out gives each target its own branch (`Writer@1`). A successor keeps its predecessor's branch, and a join takes the common prefix of its predecessors' branches. A map item's branch is `<map's branch>.<agent>@<index>`. A map runs `min(max_parallel ?? 8, items)` workers, and each worker takes the next item. A non-list input is one item, and an empty list outputs `[]`. A map whose signal aborted outputs nothing, as ADK's `ParallelWorker` yields nothing then. The events ADK stores for a join and a map are stored by the agent node runtime on their `node_end` ([Workflow agent node](/overview/workflow-agent-node.md#join-and-map-events)). A node whose output is undefined passes `undefined` on and is left out of `outputs`, as in ADK. Two terminal nodes with output fail the run with ADK's message.

## Retries, timeouts and node errors

Every attempt of a node, and of a map item, goes through one loop that copies ADK's `runChildNode`:

- **Timeout.** A node with `timeout` races each attempt against a timer. When it fires, the attempt's signal aborts and the attempt fails with `NodeTimeoutError` without waiting for the runner.
- **Retry.** A failed attempt runs again while the node's `retry` allows it: fewer than `max_attempts` attempts so far (default 5), and the error's name in `exceptions` when a list is given. The wait is ADK's exponential backoff with its jitter (`retryDelaySeconds`). An abort and a map item's failure are never retried, and an abort cuts a backoff short.
- **A reported error.** A runner that returns `error: { code, message }` has it emitted as `node_error` (source `node`). With no output and no route, the attempt fails with `NodeReportedError`, which may be retried. This is ADR 0030's failed attempt that is recorded, not fatal.
- **A node that gives up** fails the walk. The walk emits `node_error` (source `workflow`, with the error's type and the attempts made) once, unless the node reported the error itself or the walk was stopped. `nodeErrorEvent(event, invocationId)` turns that report into the `isNodeError` event ADK stores for it, for every node kind. The walk then aborts the other runs and waits for them. A run that still finishes ends with its `node_end` and triggers nothing. The error is rethrown unchanged.
- **Abort and deadline.** Once the walk's signal fires, no node starts. An attempt with a timeout ends at once with `InvocationAbortedError`. An attempt without one is awaited, as ADK awaits it.
- **`max_concurrency`** counts every pending run, a retrying one included.

A map item runs under its agent's own `retry` and `timeout` (`nodes.<agent>`, kept on the model as `MapNode.agentSettings`). An item that gives up fails the map with `DynamicNodeFailError`, reported under the map's name. The map entry's own `retry` and `timeout` are not applied, because ADK's compile does not apply them. A `null` output is no output, as on ADK: nothing is recorded and the successor runs on `undefined`.

## Tool nodes

`lib/workflow/toolNode.ts` runs a `tool:` node as ADK 2.2's `ToolNode` does, with no ADK import. Why it writes its own event and takes the registry from its caller is [ADR 0091](/decisions/0091-workflow-tool-node-writes-adks-event.md).

`toolNodeRunner(context, next)` is a `runNode` that runs tool nodes and hands every other run to `next`. `runToolNode(node, run, context)` runs one. The context carries:

| field | is |
|---|---|
| `invocationId` | written on the event |
| `resolveTool(name)` | the registry entry for the node's tool; the turn runner passes the registry's lookup |
| `appName`, `userId`, `sessionId`, `userContent`, `memory`, `credentials` | what the tool's `ToolContext` reports, as in the agent loop |
| `state()` | the session state the call reads when it runs |
| `onEvent(event)` | receives the node's event before the run resolves |

A run does four things:

1. **Arguments from the input** (`coerceToolArgs`). A content's text, or a string, is parsed as JSON when it parses. A blank string or nothing is `{}`. A list, a number, or text that is not JSON throws ADK's `TypeError`, which fails the node.
2. **One call**, id `<node path>:<run id>` (`Graph.Lookup:1`). An own Tool runs its approval gate, then `execute`, and a throw is named for the tool (`Error in tool 'lookup': …`). Another registered tool runs through `runAsync`. A throw answers `{ error }`, a result that is not an object answers `{ result }`, and a list answers `{ results }`. A long-running tool is refused.
3. **One event**, the JSON ADK stores: a `user` content with the function response, the call's actions (its state writes, and an approval it asked for), the run's branch, `author` the node's name, `output` the response, and `nodeInfo { path, outputFor }` (`enrichNodeEvent`, ADK's node-runner enrichment).
4. **The output** is the response object: the next node receives `{ result: 'found needle' }`.

The progress lines come from that event. The turn runner's reader (`drainAgentStream`) prints `⇢ Node: Lookup` and `← Result: lookup — 25 chars`, and sends `Running node: Lookup` to `onProgress`, as it does for ADK's event.

`tests/workflowToolNode.test.ts` runs the tool-node case of `tests/workflow.test.ts` on both sides. It also runs input mapping, a tool that throws, an own Tool on a branch of its own, a gated tool, and the refusals. Each case compares every event as stored (apart from its id, time and invocation id), every node's output, path and branch, the output, and the drained log and progress lines.

## What it does not do yet

Later tickets add interrupts (ask_user's pause, WS4-4a) and resuming from stored events. A task-mode agent node needs nothing of the scheduler: its run ends inside `runNode` on `finish_task`'s answer ([Workflow agent node](/overview/workflow-agent-node.md)). The native workflow path (WS4-6) writes `nodeErrorEvent` where ADK writes its node-error event.

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
- two terminal outputs;
- null outputs in a chain, at a terminal, into a join and from a map item;
- ADR 0030's retry and timeout cases: a thrown error and a reported error recovered, a node giving up on reported and on thrown errors, a timeout recovered and one that fails the walk;
- map items that retry and that give up;
- `max_concurrency` with a retrying node and with a failure.

For the error cases the test also compares every node error (path, branch, author, code, message, and for a node that gave up its error type and attempts), the stored node-error event against `nodeErrorEvent`'s, and the error the walk failed with. The retry rule and the backoff are checked against ADK's own `retry_utils` functions. An abort during a backoff, the turn's deadline, and an abort during a timed attempt are checked on the scheduler alone. The test also checks that the module reaches ADK through no value import.
