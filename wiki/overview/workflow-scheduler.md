---
type: subsystem
title: Workflow scheduler
description: "The engine's own walk of a workflow graph (lib/workflow/scheduler.ts): runWorkflowGraph runs a WorkflowGraph as ADK's Workflow loop runs one. A node runs when a predecessor's completion triggers it, fan-out gives each target its own branch, a join waits for every predecessor, a map runs its agent per item under max_parallel, and outputs flow as inputs. Routes are matched in ADK's spelling of the key. Every attempt runs under the node's retry and timeout as ADK's node runner runs it, node errors are emitted and collected, the turn's cancel or deadline stops the walk, and a walk starts at most 20 × max_steps node runs (NODE_RUN_LIMIT). Agent, tool and ask_user nodes and map items run through a runner the caller passes in; toolNodeRunner (lib/workflow/toolNode.ts) is the runner for tool nodes and writes the event ADK's ToolNode writes. askUserNodeRunner (lib/workflow/pause.ts) is the runner for ask_user nodes: it writes ADK's adk_request_input event and returns the interrupt, the node waits, and the walk ends paused with every open interrupt id. workflowResume (lib/workflow/resume.ts) rebuilds every node's state from the stored events as ADK's rehydration does, and a walk given it completes finished nodes from their stored output and reruns the paused node with the answer. runNativeWorkflow (lib/workflow/turn.ts) is a workflow turn: the message stored, the walk with every runner chained under the turn's signal, its events yielded to the turn runner's reader, node and workflow spans for the ledger. No ADK import."
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
  - resource: lib/workflow/pause.ts
  - resource: lib/workflow/resume.ts
  - resource: lib/workflow/turn.ts
  - resource: lib/runtime/native/telemetry.ts
  - resource: tests/workflowScheduler.test.ts
  - resource: tests/helpers/virtualClock.ts
  - resource: tests/workflowToolNode.test.ts
  - resource: tests/workflowPause.test.ts
  - resource: tests/workflowResume.test.ts
  - resource: tests/workflow.test.ts
  - resource: tests/nativeLedger.test.ts
---

# Workflow scheduler

`lib/workflow/scheduler.ts` runs the [workflow graph](/overview/workflow-graph.md) that `buildWorkflowGraph` builds, without ADK. It walks the graph the way ADK 2.2's `Workflow` does, so a workflow completes in the order ADK records for it. Why it copies ADK's loop, and matches routes in ADK's spelling, is [ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md). Why its retries, timeouts, node errors and abort follow ADK's node runner is [ADR 0089](/decisions/0089-workflow-scheduler-controls-follow-adks-node-runner.md). Agent nodes and map items run on it through `agentNodeRuntime` ([Workflow agent node](/overview/workflow-agent-node.md)), tool nodes and ask_user nodes through their runners (below), and a paused walk resumes from the stored events (below). `runSyndicateTurn` runs every workflow syndicate on it through `runNativeWorkflow` ([the native turn](#the-native-turn), [ADR 0095](/decisions/0095-native-workflow-turn-drains-through-the-adk-reader.md)); ADK's `Workflow` is not a dependency ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)).

## The interface

`runWorkflowGraph(graph, options)` resolves with `{ output, outputs, order, nodeErrors, interruptIds }`:

- `output` is the terminal node's output, or undefined when the walk ended paused.
- `outputs` holds every node's latest output.
- `order` lists the node names in the order they completed.
- `nodeErrors` lists every node error the walk emitted, as `{ node, code, message }`: the shape `runSyndicateTurn` collects in `answer.nodeErrors`.
- `interruptIds` lists the input requests the walk ended waiting on, in the order their nodes paused. It is empty unless the walk is paused.

It rejects with the error of the node that gave up, unchanged, with `NodeRunLimitError` when the walk reached its node-run ceiling, or with `InvocationAbortedError` when its signal stopped it.

| option | is |
|---|---|
| `input` | the workflow's input, which every node after `START` receives |
| `runNode(run)` | runs one attempt of an agent, tool or ask_user node, or of one map item, and returns `{ output?, route?, error?, interruptIds? }` |
| `signal` | stops the walk and aborts every run in flight; default: the current turn's signal (`turnControl`), so a cancel or the turn's deadline stops it |
| `maxNodeRuns` | the most node runs the walk starts (below); default: inside a turn, `nodeRunCeiling` of the turn's `max_steps`; outside one, none |
| `onEvent(event)` | `node_start`, `node_end`, `node_waiting`, `node_resumed`, `item_start`, `item_end` and `node_error`, synchronously, in order |
| `nodePath`, `branch` | the workflow's own path (default: the graph's name) and branch (default: none) |
| `resume` | a paused walk's prior node runs and answers, from `workflowResume` (below); the walk consumes it |
| `traceNode(node, run)` | wraps each node run (every attempt and backoff inside it) and each map item's, as ADK opens `execute_node` around them; `node` carries the name, kind, path, run id and the attempt counter. A node completed from its stored run on a resume is not wrapped. Default: none |

`streamWorkflowGraph(graph, options)` is the same walk as an async generator. It yields each event, then returns the run. The walk does not wait for the reader.

A `NodeRun` carries the `target`: the graph node, or `{ kind: 'map_item', agent, map, index }`. It also carries the `input`, the `runId` (the node's run counter, or the item's index), ADK's node `path` (`<workflow>.<node>`, or `<workflow>.<map>.<agent>@<index>`), ADK's `branch`, the `attempt` (from 1), the attempt's `AbortSignal`, and on a resumed walk the answers by interrupt id (`resumeInputs`). A runner settles promptly once the signal aborts.

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
- **Retry.** A failed attempt runs again while the node's `retry` allows it: fewer than `max_attempts` attempts so far (default 5), and the error's name in `exceptions` when a list is given. The wait is ADK's exponential backoff with its `jitter` (`retryDelaySeconds`). The YAML spells both (`retry.exceptions`, `retry.jitter`), in the meaning of ADK's `retryConfig` ([ADR 0103](/decisions/0103-workflow-retry-spelling-and-signed-reflection-call.md)). An abort and a map item's failure are never retried, and an abort cuts a backoff short.
- **A reported error.** A runner that returns `error: { code, message }` has it emitted as `node_error` (source `node`). With no output and no route, the attempt fails with `NodeReportedError`, which may be retried. This is ADR 0030's failed attempt that is recorded, not fatal.
- **A node that gives up** fails the walk. The walk emits `node_error` (source `workflow`, with the error's type and the attempts made) once, unless the node reported the error itself or the walk was stopped. `nodeErrorEvent(event, invocationId)` turns that report into the `isNodeError` event ADK stores for it, for every node kind. The walk then aborts the other runs and waits for them. A run that still finishes ends with its `node_end` and triggers nothing. The error is rethrown unchanged.
- **Abort and deadline.** Once the walk's signal fires, no node starts. An attempt with a timeout ends at once with `InvocationAbortedError`. An attempt without one is awaited, as ADK awaits it.
- **`max_concurrency`** counts every pending run, a retrying one included.
- **The node-run ceiling** ([ADR 0105](/decisions/0105-workflow-node-run-ceiling.md)). `max_steps` counts model calls, so a routed cycle through nodes that make none (a tool node and its route step) would otherwise run until the deadline. The walk counts every run it starts of an agent, tool, ask_user, route, join or map node, once however many attempts it makes; a map's items and a node completed from its stored run on a resume do not count. Inside a turn the ceiling is `nodeRunCeiling(max_steps)`: `max(20 × max_steps, 100)`, 1,000 at the default of 50. The run that would pass it is not started: its node fails with `NodeRunLimitError` (code `NODE_RUN_LIMIT`), reported once with source `workflow` and attempt count 0, never retried, and nothing more starts. The native turn stores it as the workflow's node-error event, and the turn fails `NODE_RUN_LIMIT` with the progress line `Stopped: the workflow reached its limit of <n> node runs`. ADK's `Workflow` had no such ceiling; the engine adds it.

A map item runs under its agent's own `retry` and `timeout` (`nodes.<agent>`, kept on the model as `MapNode.agentSettings`). An item that gives up fails the map with `DynamicNodeFailError`, reported under the map's name. The map entry cannot carry `retry` or `timeout`: ADK's compile applied neither, so the schema refuses them and names the mapped agent's entry instead ([ADR 0103](/decisions/0103-workflow-retry-spelling-and-signed-reflection-call.md)). A `null` output is no output, as on ADK: nothing is recorded and the successor runs on `undefined`.

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

`tests/workflowToolNode.test.ts` runs the tool-node case of `tests/workflow.test.ts` on the scheduler and holds it to ADK's recorded run. It also runs input mapping, a tool that throws, an own Tool on a branch of its own, a gated tool, and the refusals. Each case compares every event as stored (apart from its id, time and invocation id), every node's output, path and branch, the output, and the drained log and progress lines.

## Ask_user nodes: the pause

`lib/workflow/pause.ts` runs an `ask_user` node as ADK 2.2 ran the `FunctionNode` that returns a `RequestInput`, with no ADK import. Why the interrupt is a field of the run's result, and why the caller stores the workflow's own record, is [ADR 0092](/decisions/0092-workflow-pause-returns-interrupts-to-the-walk.md).

`askUserNodeRunner(context, next)` runs ask_user nodes and hands every other run to `next`, so it chains with `toolNodeRunner` and `agentNodeRuntime`. `runAskUserNode(node, run, context)` runs one. The context carries the `invocationId`, `onEvent(event)`, and `newInterruptId()` (default: a random UUID, as ADK draws it).

A run writes one event and returns `{ interruptIds: [id] }`:

| field | value |
|---|---|
| `content` | a `model` content with one function call, `adk_request_input`, id the interrupt id |
| its `args` | `{ interruptId, payload, message, response_schema }`: the node's input, the YAML question, and the node's `schema` as ADK writes it; `null` for each one absent |
| `longRunningToolIds` | the interrupt id |
| `author`, `nodeInfo.path`, `branch` | the node's name, its path and the run's branch (`enrichNodeEvent`) |
| `actions.agentState.input` | the node's input, which the resume reruns the node on |

`response_schema` goes through `genaiSchemaToJsonSchema`, a port of ADK's: genai's upper-case type names become JSON Schema's, `nullable` a type list, and the numeric-string bounds numbers. A lower-case `type` is dropped, as ADK drops it.

The scheduler then holds the node **waiting**, as ADK's `handleCompletion` does. It emits `node_waiting` with the ids instead of `node_end`, records no output, triggers no successor, and does not start the node again in the same walk; a second trigger stays buffered. The rest of the graph runs on. A reported error with an interrupt is not the node's failure. The walk resolves with every open id in `interruptIds` and no output, without the terminal-output check.

`workflowPauseEvent({ name, invocationId, input, interruptIds })` is the event ADK stores after the last node's when a workflow ends paused: authored by the workflow, at its path, with the open ids in `longRunningToolIds` and the workflow's input in `agentState`. The caller stores it after the walk, as it stores `nodeErrorEvent`'s.

The turn runner's reader reads the question from the request event (`inputRequestFrom` in `drainAgentStream`), so `result.input` is `{ id, node, message, payload, schema? }`, and the log prints `⏸ Confirm asks: Publish?`.

`tests/workflowPause.test.ts` runs the pause case of `tests/workflow.test.ts` on the scheduler and holds it to ADK's recorded run, with three schemas, no input, an object payload, a pause on one branch of a fan-out, and a waiting node triggered twice. Each case compares every event as stored (event id, time and invocation id aside, interrupt ids by order of appearance), every node's output, path and branch, the open interrupts, and the drained log lines, progress and input requests. It also runs the case through `runSyndicateTurn` and compares `result.input` with ADK's.

## Ask_user nodes: the resume

`lib/workflow/resume.ts` resumes a paused walk as ADK 2.2 did, with no ADK import, so a walk ADK paused before 1.0.0 resumes too. Nothing is kept between the two turns: the walk starts again from `START` and rebuilds each node's state from the session. Why the scheduler does the same, and what it refuses, is [ADR 0094](/decisions/0094-workflow-resume-rebuilds-node-states-from-the-events.md).

`workflowResume({ events, invocationId, userContent, workflowPath })` takes the session's events, with the new message already stored, and returns `{ input, resume }`:

| step | function | reads |
|---|---|---|
| the run's events | `eventsForCurrentRun` | the current invocation, and each run just before it that raised one of ADK's requests (`adk_request_input`, `adk_request_credential`, `adk_request_confirmation`) |
| the answers | `resumeInputsFromPlainText`, `resolvedInterruptResponses` | a text-only message answers the one open interrupt; a function response answers the interrupt whose id it carries, `{ result: x }` unwrapped and an object checked against the stored `response_schema`. A reply in the newest message to an interrupt that is not open, or one the schema refuses, throws ADK's message |
| the node states | `reconstructNodeRuns` | per direct child of the workflow, its runs: output, route and branch, the interrupts raised and their answers, and `agentState.input` |
| the walk's input | `workflowNodeInput` | the message's text, else the message itself |

The scheduler takes `resume` and changes only how a node's first activation starts (ADK's `startNodeTask`):

- A prior run with an output or a route and no open interrupt is done. The node completes at once with them and emits `node_resumed` (`from: 'stored'`), not `node_start` and `node_end`. Nothing that stores events on `node_end` stores anything for it, as ADK writes nothing.
- A paused prior run of a node that does not rerun on resume (`rerunsOnResume`: a tool node, a join, a route step) completes with its answers (`from: 'answers'`).
- Any other node runs. A paused one runs on the input it recorded, not on the trigger's, with every answer in `run.resumeInputs` and the interrupts its prior run paused on in `run.resumedInterruptIds`. A repeat activation in the same walk gets neither. Neither shortcut counts as a run, so run ids and branches are ADK's.

An ask_user node rerun with an answer does not ask again. `runAskUserNode` writes the FunctionNode's output event and returns `{ reply, input }`: the last answer, and the input it asked about. The next node sees both. As on ADK, every answer reaches every ask_user node of the resumed walk, so a second one in a row takes the first answer.

An approval request raised by an agent node resumes too: the node continues its own run on the decision ([Workflow agent node](/overview/workflow-agent-node.md#approvals), [ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md)). Any other pause raised inside an agent node (an OAuth consent), or one inside a map item, is refused with `UnsupportedWorkflowResumeError`, which names its path. The agent node pauses only on an approval. An `ask_user` tool call inside an agent is not a pause to the rehydration, as it was not to ADK's, so the walk starts afresh.

`pendingWorkflowInput(events)` (`lib/runtime/questions.ts`, beside `pendingQuestion`) is the workflow question still open in a session. A text message, or a function response with its id, closes it, and a request in an event the user wrote is none.

`tests/workflowResume.test.ts` resumes the WS0-6 fixture `05-workflow-ask-user`, written by ADK, on the scheduler with real agent nodes. The events stored after the reply match ADK's resume of the same session, Triage is not called, and Publisher's request carries the reply and the draft. A pause the scheduler opens stores the fixture's events. After a resume, an agent node's workflow placeholders fill as ADK's do: the outputs of the current invocation only. Stub graphs (a chain, an answer by function response, a fan-out, a join, a map on the finished branch, two ask_user nodes in a row, a session with nothing paused, a reply to an unknown interrupt) resume from ADK's stored events and from the scheduler's own, and write ADK's events. Each ported function is checked against ADK's own on the same events. ADK's side of every comparison in these suites (its resumes, its walks, its functions' outputs) is read from `tests/fixtures/adk-reference` ([ADR 0108](/decisions/0108-adk-reference-recorded-by-the-parity-suites.md)).

## The native turn

`lib/workflow/turn.ts` is one turn of a workflow syndicate. `runSyndicateTurn` hands its generator, `runNativeWorkflow(params)`, to `traceAgentRun` and `drainAgentStream`, the reader that once read ADK's Runner, so the result, the progress lines, `onProgress`, `answer.nodeErrors`, `result.input` and the ledger rows come out as ADK's did. Why the turn drains through ADK's reader, and what it refuses, is [ADR 0095](/decisions/0095-native-workflow-turn-drains-through-the-adk-reader.md).

| step | does | as ADK |
|---|---|---|
| the message | stored as the user's event under a new `e-` invocation id, before the walk; nothing is stored when the signal fired first | the Runner stores it |
| the start | `workflowResume` on the session, every turn: the message's text as the walk's input, every node's prior runs, the answers. With nothing paused every node runs fresh | the rehydration runs on every message |
| the walk | `runWorkflowGraph` with `askUserNodeRunner`, `toolNodeRunner` and `agentNodeRuntime` chained, under the turn's signal; every event through the agent node runtime's queue | the Workflow's node runners |
| a node that gave up | `nodeErrorEvent` stored on the walk's `node_error` (source `workflow`), on the same queue; the walk's error rethrown once every event is stored and yielded, and the turn fails `NODE_FAILED` (`NODE_RUN_LIMIT` for the node-run ceiling, which ADK did not have) | the workflow's node-error event, then the Runner throws |
| a paused walk | `workflowPauseEvent` stored after every node's event, with the text as the recorded input; the turn ends `input-required` with `result.approval` when a gated call waits (`pendingApproval`, which trusts the pause record over node turns stored after the request), else with `result.input` read from the request event | `recordInputForResume` |
| a stopped walk | `InvocationAbortedError`, or any failure once the signal fired, ends the stream quietly; the turn fails with its stop reason | the Runner ends an aborted run without an error |

The generator yields every stored event in the order stored, but a node's input turn: ADK appends that turn straight to the session and its Runner never yields it, and the root span's output is read from what is yielded. A node agent's partial events (with `streaming: true`) are yielded as its loop yields them, never stored (`AgentNodeContext.onPartial`), so `onTextDelta` streams a node's text.

What the turn refuses:

- a tool node with an unregistered or long-running tool, before any model call, with ADK's compile-time message (`refuseUnrunnableNodes`, through `resolveToolNode`);
- an `ask_user` tool on a workflow node's agent, by name, before any model call (`refuseOnNative`; the schema refuses it first);
- a session paused inside an agent node on anything but an approval, or inside a map item: `workflowResume` throws `UnsupportedWorkflowResumeError` after the message is stored, and the turn fails `RESUME_UNSUPPORTED` without walking afresh;
- a pause raised inside an agent node during the walk other than an approval, by `runAgentNode` (an `ask_user` tool is refused by the schema first; a node agent gets no OAuth consent step).

While a gated call waits, a message that is not its decision repeats the request: nothing is stored and nothing runs ([ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md)). A skill script (`skills.scripts: local`) on a node's agent pauses the same way, each `run_skill_script` call on its own approval ([ADR 0106](/decisions/0106-nested-workflow-routes-nodes-and-node-skill-scripts.md)).

### As a subagent

A DELEGATE syndicate's `yaml_reference` to a workflow syndicate is the whole graph as one subagent tool, named and described as the entry ([ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md)). `compileSpec` builds its `WorkflowSpec` (`compileWorkflowSpec`, `lib/compile.ts`), the same spec a root workflow gets. `compileNative` lists a `workflowSubagentTool` (`lib/runtime/native/delegate.ts`) whose call opens the child session ADK's `AgentTool` opened and runs `runNativeWorkflow` on it with the call's request as the message. The answer is the last yielded event's text, and each event's state writes reach the caller's response. A node that gave up fails the call. A nested workflow with an `ask_user` node is refused by name: a pause inside a tool call cannot reach the caller. `tests/workflowSubagent.test.ts` holds the caller and child sessions and requests equal to ADK's recorded ones.

### As a route or a node

A `yaml_reference` to a workflow syndicate is its whole graph wherever it appears ([ADR 0106](/decisions/0106-nested-workflow-routes-nodes-and-node-skill-scripts.md)): `compileEntrySpec` (`lib/compile.ts`) compiles an entry as one agent or as a `WorkflowSpec`, and `compileSubagentSpec` refuses a workflow reference by name.

- **A plan-dispatch route**: `runSyndicateTurn` walks the graph on the child session `{ <route>, userId, sessionId }` (created from the conversation's state, `temp:` keys dropped, and kept) with `runNativeWorkflow`, and drains it through the workflow reader at the `dispatch` stage. The conversation stores the message and one event authored by the route with the answer and the walk's state writes. A node that gave up fails the turn `NODE_FAILED`, the ceiling `NODE_RUN_LIMIT`.
- **A workflow node**: `agentNodeRuntime` hands the node to `runWorkflowNode` (`lib/workflow/turn.ts`), which walks the nested graph on `{ <node>, userId, sessionId }` with the node's input as its message, and stores one event for the node in the caller's walk carrying the last yielded text as its output and the walk's state writes, so a resumed walk completes the node from it.

Each walk keeps its own node-run ceiling ([ADR 0105](/decisions/0105-workflow-node-run-ceiling.md)): the root's, a route's and each nested node's are separate `runWorkflowGraph` calls, while every model call counts once against the turn's `max_steps`. A `map` over a nested workflow is refused by name, as is an `ask_user` node inside one. `tests/workflowNested.test.ts` holds the route's sessions and requests equal to ADK's recorded ones.

### The spans

The native walk opens ADK's three workflow spans under the engine's names, in scope `melchizedek.runtime` (`lib/runtime/native/telemetry.ts`):

| the walk's span | ADK's | covers | attributes |
|---|---|---|---|
| `workflow.invoke <name>` | `invoke_workflow <name>` | the walk, under the turn's root span | `adk.workflow.name`, `adk.node.path`, the conversation and invocation ids |
| `node.execute <name>` | `execute_node <name>` | one node run, every attempt inside it (the scheduler's `traceNode`); a map item's under its map's | `adk.node.path`, `run_id`, `attempt`, `status` (`completed`, `waiting`, `failed`), `interrupt_count`, and `adk.node.kind` |
| `tool.execute <name>` | `execute_tool <name>` | a tool node's call (`ToolNodeContext.traceCall`) | the tool's name and description, the call id |

An agent node's own `agent.invoke` opens inside its `node.execute`, so the tracer attributes every `llm.request` to the node's agent, and the tool node's span counts in `tool_ms`. `tests/nativeLedger.test.ts` runs a graph with every node kind through `runSyndicateTurn`: `adk_turns`, `adk_telemetry` and `adk_payloads` hold the rows ADK's recorded run wrote (ids, times and the invocation id aside; a model step's own payload columns as ADR 0076 sets out), and each `llm.request` row names its node's agent.

ADK also opened `execute_node_attempt` per attempt of a node with a retry config, and an `invocation` and `execute_node` span for the workflow itself. The walk opens neither: no ledger row reads them.

## What it does not do yet

A pause inside an agent node other than an approval (an OAuth consent) is refused by `runAgentNode`, a map item's interrupts are not carried, and a session paused on either is refused by `workflowResume`. A pause inside a nested workflow is not carried to its caller. A task-mode agent node needs nothing of the scheduler: its run ends inside `runNode` on `finish_task`'s answer ([Workflow agent node](/overview/workflow-agent-node.md)).

## Parity with ADK

`tests/workflowScheduler.test.ts` builds each case's graph with `buildWorkflowGraph`, runs it on the scheduler with every agent replaced by a stub, and holds it to ADK's `Runner` on the same graph and stubs, as recorded in `tests/fixtures/adk-reference/` ([ADR 0108](/decisions/0108-adk-reference-recorded-by-the-parity-suites.md)). The test compares the agent calls with their inputs, every node's output, path and branch in completion order, and the workflow's output.

A stub's delay is on a virtual clock (`tests/helpers/virtualClock.ts`). The clock moves only once the process has settled (every microtask drained, no immediate or file read pending), then ends the earliest wait, ties in the order they began. Whatever a finish sets off happens before the next wait ends, so a case's completion order is its delays' timeline however loaded the machine is, as it was when ADK's side was recorded. A stub that races a real timer (a node's timeout, a retry's backoff) waits on real time, with its finish 100 ms or more from the timer's.

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

For the error cases the test also compares every node error (path, branch, author, code, message, and for a node that gave up its error type and attempts), the stored node-error event against `nodeErrorEvent`'s, and the error the walk failed with. The retry rule and the backoff are checked against ADK's own `retry_utils` functions, recorded over the same inputs. An abort during a backoff, the turn's deadline, and an abort during a timed attempt are checked on the scheduler alone. The test also checks that the module reaches ADK through no value import.

`tests/workflowNodeRunLimit.test.ts` holds the node-run ceiling: a model-free route-step loop trips it on the scheduler, a bounded loop under it completes, and the turn's control sets the default. Through `runSyndicateTurn`, a tool node looping on its route step fails the turn `NODE_RUN_LIMIT` with the node-error event and the progress line, a bounded tool loop stores the events ADK's recorded run stored, and a loop longer than the ceiling fails where ADK's completed.
