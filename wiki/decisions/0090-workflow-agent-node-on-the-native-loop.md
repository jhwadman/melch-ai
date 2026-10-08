---
type: decision
title: "ADR 0090: A workflow agent node runs on the native loop with a stamp hook, the route step stores ADK's event, and route derivation is one function"
description: "lib/workflow/agentNode.ts runs an agent node as ADK's runLlmAgentAsNode does: the input stored as the node's user turn, includeContents none unless the agent set it, task mode through the loop's taskNode, and each event stamped with its output, node path and outputFor by a nodeStamp hook the loop calls before it stores the event. agentNodeRuntime gives the scheduler a runNode that chains onto other runners, and stores ADK's route-step event on the scheduler's node_end. routeOf moves to lib/workflow/route.ts, which both runtimes call; JSON text without an output schema routes as text, as on ADK. Stamping events after the loop stores them, rewriting stored events, leaving route steps unstored, and parsing JSON text for routing were rejected."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/route.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/workflowConfig.ts
  - resource: tests/workflowAgentNode.test.ts
---

# ADR 0090: A workflow agent node runs on the native loop with a stamp hook

## Context

The workflow scheduler ([ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md)) hands agent nodes and map items to a runner the caller passes. WS4-3 supplies it for agents. ADK 2.2 runs an `LlmAgent` node in two layers: `runLlmAgentAsNode` (the input appended as a user event, `includeContents` forced to `none` unless set explicitly, task mode through `runTaskMode`, `maybeSetOutput` on each model event), and the node runner's `enrichEvent` (path, `outputFor`, branch) before the Runner stores each event. [ADR 0081](/decisions/0081-native-task-mode-ends-a-node-on-finish-task.md) left open that the node runner sets `taskNode` and writes `nodeInfo.path` and `outputFor`.

Running ADR 0030's routing cases on ADK showed what a session holds: the user's message, the node's input as a user event without a node path, the node's model event with `output`, `messageAsOutput`, `path` and `outputFor`, and an event for the hidden route step (`Planner__route`, the output and the route, no content). It also showed that an agent without an output schema that writes JSON keeps it as text, so its route is the whole text.

## Decision

1. **The node is a run of the native loop with a stamp hook.** `AgentLoopContext.nodeStamp` is called on each event before it is stored, after the outputKey and task hooks, the order ADK applies them in. `runAgentNode` passes a stamp that sets the output (outside task mode), then the node's path, `outputFor` and branch through `enrichNodeEvent` (lib/workflow/toolNode.ts, [ADR 0091](/decisions/0091-workflow-tool-node-writes-adks-event.md)), the one port of ADK's `enrichEvent`. The change to `agentLoop.ts` is the option and one call.
2. **The node rules are ADK's.** The input is stored as a user turn (ADK's `toUserContent`), except in task mode. An agent that does not set `includeContents` runs a copy with `none`. A task-mode agent runs with `taskNode`. An error event with no output fails the node with ADK's `NodeReportedError` message.
3. **The runtime chains.** `agentNodeRuntime` returns a `runNode` that runs agent nodes and map items and hands every other run to `next`, the pattern of `toolNodeRunner(context, next)`, so the tool and ask_user runners join one chain. Its `onEvent` takes the scheduler's events and stores ADK's route-step event on a route step's `node_end`. Node inputs, route events and the events another runner of the chain hands to `store` (a tool node's) are stored through one queue, in walk order.
4. **Route derivation is one function.** `routeOf` lives in `lib/workflow/route.ts`, re-exported by `lib/workflowConfig.ts`, so the ADK path and the scheduler call the same code. A string is routed as text, JSON included: only an output schema makes an agent's output an object, on both runtimes.

## Alternatives considered

- **Stamp events after the loop stores them.** The loop stores each event before yielding it, and the store keeps its own copy; a stamp after the fact would leave the stored session without the path and output ADK stores. ADR 0081 rejected the same for task mode.
- **Rewrite the stored events at the node's end.** A session service appends; it has no update, and a reader during the run would see the unstamped events.
- **Leave route steps unstored on native.** The scheduler runs them without a runner, so storing nothing was the easy path, but a session written on one runtime must be one the other continues, and ADK's resume reads node outputs from the stored events.
- **Parse JSON text for routing when there is no output schema.** It reads as what an author means by "the route_key of a JSON output", but ADK does not do it, and the two runtimes would route the same answer differently. Setting `outputSchema` is the documented way.

## Consequences

- `tests/workflowAgentNode.test.ts` holds the native node to ADK's stored events, requests, routes, output and progress lines on ADR 0030's routing cases, a task-mode node and an explicit `includeContents`.
- Open: workflow placeholders in an instruction (`{input.field}`, `<field from Node>`) are not filled by the native request; the events ADK stores for a join or a map node itself are not stored by the native walk yet; a pause inside an agent node is WS4-4a.
- The modules are internal: not in the `exports` map or the `lib/index.ts` barrel.
