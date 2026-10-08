---
type: decision
title: "ADR 0092: A workflow ask_user node returns its interrupt to the walk, which waits as ADK's Workflow waits, and the caller stores the workflow's own record"
description: "lib/workflow/pause.ts runs an ask_user node on the engine's own runtime: ADK's adk_request_input event key for key (a random interrupt id, the node input as payload and as agentState.input, the schema through a port of ADK's genaiSchemaToJsonSchema), and a run result that carries the id in interruptIds. The scheduler holds such a node waiting (no output, no successor, not restarted in the walk), lets the rest of the graph run, and resolves with every open id and no output. workflowPauseEvent is ADK's recordInputForResume for the workflow node, stored by the caller after the walk. Throwing an interrupt error, a sentinel output, a deterministic interrupt id, the scheduler writing events, and writing the YAML schema as given were rejected."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/pause.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflowConfig.ts
  - resource: tests/workflowPause.test.ts
---

# ADR 0092: A workflow ask_user node returns its interrupt to the walk, which waits as ADK's Workflow waits, and the caller stores the workflow's own record

## Context

[ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md) left agent, tool and ask_user nodes to a runner the caller passes the scheduler, and left interrupts to WS4-4a. An `ask_user` node ([ADR 0030](/decisions/0030-workflow-graphs.md)) pauses the workflow on a person: the turn ends `input-required` with the question in `result.input`, and the next message answers it. On ADK it is a `FunctionNode` that returns a `RequestInput` (lib/workflow.ts). Gate G4 of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) needs the same pause without ADK, and the stored events are what the resume (WS4-4b) rebuilds the node states from, as ADK's rehydration does.

Running ADK's workflow with stub agents showed what ADK 2.2 stores for the pause case of `tests/workflow.test.ts` (`START → Triage → Confirm → Publisher`):

- **The request.** One event from the node: a `model` content with one function call, `adk_request_input`, whose id is a random UUID and whose args are `{ interruptId, payload, message, response_schema }`. The payload is the node's input, and each absent field is `null`. `longRunningToolIds` holds the id. The node runner stamps it (author, `nodeInfo.path`, branch) and, because it carries long-running ids, writes the node's input into `actions.agentState.input`.
- **The schema.** ADK writes `toJsonSchema(schema)`, which for a schema that is not zod is `genaiSchemaToJsonSchema`. That reads genai's upper-case type names. A lower-case JSON Schema `type` is dropped.
- **The wait.** The node's run ends with the id in its interrupts. `handleCompletion` marks it WAITING: no output, no successor. `scheduleReadyNodes` skips a waiting node, so a second trigger stays buffered. The rest of the graph runs on, and `finalize` ends the workflow with every open id and no output, without the terminal-output check.
- **The workflow's record.** The workflow node itself is a node whose run ended on interrupts without recording its input, so the node runner adds `recordInputForResume`: an event authored by the workflow, at its path, with the open ids and its input (`go`, the message's text) in `agentState`.

The turn runner reads `result.input` from the request event (`inputRequestFrom` in `drainAgentStream`), so matching the event matches `result.input`.

## Decision

1. **`runAskUserNode` writes ADK's request event, with no ADK import.** `requestInputEvent` is `createRequestInputEvent`, key for key. `enrichNodeEvent` (ADR 0091) stamps it. `agentState.input` is the node's input. The interrupt id is a random UUID, as ADK's `RequestInput` draws it; the context can pass `newInterruptId`. The event goes to `context.onEvent` before the run returns.
2. **The schema goes through a port of ADK's `genaiSchemaToJsonSchema`**, so `response_schema` is the JSON ADK stores, a dropped lower-case `type` included.
3. **The interrupt is a field of the run's result.** `NodeResult.interruptIds` holds the ids. The scheduler marks the node `waiting`, emits `node_waiting` (not `node_end`), triggers nothing, records no output, and does not start the node again in the walk. A reported error with an interrupt is not the node's failure (ADK's `failIfNodeReportedError`). `WorkflowRun.interruptIds` lists every open id in the order the nodes paused, and a paused walk has no output.
4. **The workflow's record is the caller's to store.** `workflowPauseEvent` builds ADK's `recordInputForResume` event for the workflow node. The caller stores it after the walk, where it stores `nodeErrorEvent`'s, because the scheduler hands back results, not events (ADR 0087 decision 4).
5. **`askUserNodeRunner(context, next)` composes** with `toolNodeRunner` and `agentNodeRuntime`, as ADR 0091 decision 5 set out.

## Alternatives considered

- **Throw an interrupt error from the runner** (ADK has `NodeInterruptedError`). A throw reaches the walk through the failure path, which aborts the other runs and reports a node error. Every control (retry, the failure report, the shutdown) would need an exception for it. ADK's own ask_user path does not throw: the run ends normally with interrupts on its context.
- **A sentinel output.** The output is what successors receive and what the terminal check reads. A sentinel would have to be filtered out in each of those places, and a runner could produce it by accident.
- **A deterministic interrupt id** (`<node path>:<run id>`, like a tool node's call id). That would make tests simpler, but ADK stores a UUID, and the resume reads the id from the event in either case. `newInterruptId` gives tests a fixed id without changing what is stored.
- **The scheduler writes the request and the workflow's record.** That would put events in the scheduler's result type, which ADR 0087 kept out of it and which WS4-6a is also changing. The node's event belongs to its runner, as with tool and agent nodes, and the workflow's record follows `nodeErrorEvent`.
- **Write the YAML schema as given.** The YAML documents `schema` as JSON Schema, and writing it unchanged would keep its lower-case types. But the stored event would differ from ADK's, a session written on one runtime would carry a different schema on the other, and ADK's resume checks a reply against the stored schema. Parity holds until a later record changes both runtimes together.

## Consequences

- `tests/workflowPause.test.ts` runs the pause case of `tests/workflow.test.ts` on ADK (the real `compileWorkflow` with stub agents, run by ADK's Runner) and on the scheduler with `askUserNodeRunner`. It also runs three schemas, no input, an object payload with options, a pause on one branch of a fan-out, and a waiting node triggered twice. Each case compares every event as stored (event id, time and invocation id aside, interrupt ids by order of appearance), every node's output, path and branch, the open interrupts, and what `drainAgentStream` reads: the log lines, the progress and the input requests `result.input` is taken from. The suite also runs the case through `runSyndicateTurn` on ADK and compares its `result.input`, and checks `genaiSchemaToJsonSchema` against ADK's own function.
- The resume (WS4-4b) reruns the node on `agentState.input` and outputs `{ reply, input }`, as the ADK FunctionNode does with `rerunOnResume`. A pause inside an agent node (an `ask_user` tool call, an approval) is still refused by `runAgentNode`, and a map item's interrupts are not carried.
- The native runtime still refuses a workflow syndicate. Lifting the refusal, and storing the events of a native walk, is WS4-6. The module is internal: it is not in the `exports` map or the barrel.
