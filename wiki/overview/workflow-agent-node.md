---
type: subsystem
title: Workflow agent node
description: "An agent as a workflow node on the native runtime (lib/workflow/agentNode.ts) and the route a node's output takes (lib/workflow/route.ts). The previous node's output is stored as the node's user turn, an agent that does not set includeContents sees only it, a task-mode agent ends on finish_task's answer, each stored event carries the node's output, path and outputFor as ADK writes them, and a route step stores ADK's route event. agentNodeRuntime gives the scheduler its runNode and onEvent. No ADK import."
tags:
  - runtime
  - agents
  - overview
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/route.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: tests/workflowAgentNode.test.ts
---

# Workflow agent node

`lib/workflow/agentNode.ts` runs an agent of a `workflow:` syndicate as a node of the [workflow scheduler](/overview/workflow-scheduler.md), on the [native loop](/overview/native-loop.md). It is ADK 2.2's `runLlmAgentAsNode` and the part of its node runner that stamps events, rule for rule, so a session the native walk writes holds the events ADK's holds. `lib/workflow/route.ts` holds the route rule both runtimes use. Why the node is a loop hook, and why the route step stores an event, is [ADR 0090](/decisions/0090-workflow-agent-node-on-the-native-loop.md). The turn runner does not run a workflow on native yet (WS4-6); the native refusal of [ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md) stands.

## One node

`runAgentNode(agent, run, context)` runs one node run and resolves with `{ output }`:

| rule | what happens |
|---|---|
| the input is the user turn | the previous node's output is stored as a `user` event on the node's branch: a Content as it is (role `user`), a string as one text part, anything else as its JSON; nothing for an undefined or null input. The event carries no node path, as ADK appends it straight to the session. |
| includeContents | an agent whose YAML does not set `includeContents` runs with `none`, so it sees its input and nothing else of the session. The node runs a copy (`asNodeAgent`); the compiled agent is unchanged. |
| task mode | a `mode: task` agent gets no user turn and keeps its `includeContents`; the loop runs it with `taskNode`, and it ends on `finish_task`'s successful answer ([ADR 0081](/decisions/0081-native-task-mode-ends-a-node-on-finish-task.md)). |
| the output | outside task mode, each stored model event with content and no function call carries `output`: its text without thought parts, parsed as JSON only when the agent has an output schema and the text parses; and `nodeInfo.messageAsOutput` (`eventOutput`, ADK's `maybeSetOutput`). The node's output is the last one an event carried. |
| the stamp | every stored event gets `nodeInfo.path`, `nodeInfo.outputFor` when it carries an output, and the node's branch when it has none: ADK's `enrichEvent`, through `enrichNodeEvent`, the one port of it ([tool node](/overview/workflow-scheduler.md#tool-nodes)). The loop applies it through `nodeStamp`, after the outputKey and task hooks. |
| failure | an event with an error code is the node's reported error. A run that ends with one and no output throws `NodeReportedError` with ADK's message. A run the turn stopped throws `NodeStoppedError`. A run that pauses on a person (an `ask_user` tool call, an approval) throws: a pause inside an agent node does not run on the native runtime yet. An `ask_user` node is another runner's ([the pause](/overview/workflow-scheduler.md#ask_user-nodes-the-pause)). |

The node's path is `<workflow>.<node>`, or `<workflow>.<map>.<agent>@<index>` for a map item, as the scheduler computes it.

## The runner the scheduler takes

`agentNodeRuntime({ agents, session, sessions, invocationId, userContent, loop, onEvent, next })` returns:

- `runNode`: runs agent nodes and map items; every other run goes to `next`, so it chains with `toolNodeRunner(context, next)` and, later, the ask_user runner;
- `onEvent`: the scheduler's event hook; on a route step's `node_end` it stores the event ADK's route step stores;
- `store(event)`: stores another runner's event on the same queue; the tool node runner's `onEvent` passes its event here;
- `settled()`: resolves once every queued event is stored.

A node's user turn and a route step's event are stored through one queue, in the order the walk reaches them, so a route event lands before its successor's input, as on ADK. `onEvent` (the option) receives every stored event in order; fed through `drainAgentStream`, they print the progress lines ADK's do, which name declared nodes only, never the root or a route step.

## Route derivation

`routeOf(output, routeKey = 'route')` is the one rule; `lib/workflowConfig.ts` re-exports it for the ADK path:

- an object output: its `routeKey` property, trimmed; `''` when absent or null;
- a string: the text, trimmed. JSON an agent writes without an output schema is text, as ADK keeps it, so it routes on the whole text and usually takes the `default` edge;
- anything else: its string form, trimmed; `''` for undefined or null.

The scheduler matches the route against the keys in ADK's spelling and takes the `default` edge when no key matched. `routeStepEvent` is the event ADK stores for the step: authored `<Node>__route`, the output and the route, `nodeInfo { path, outputFor }`, no content.

## Not here yet

- Workflow placeholders in an instruction (`{input.field}`, `<field from Node>`): the native request leaves them as written.
- The events ADK stores for a join or a map node itself.
- Interrupts inside a node (an `ask_user` tool call, an approval).

## Parity with ADK

`tests/workflowAgentNode.test.ts` runs each case on ADK (`runSyndicateTurn`, runtime `adk`) and on the scheduler with `agentNodeRuntime`, with the same scripted models. It compares the stored events (ids and times aside), every model's requests, the routes, the workflow's output and the progress lines. The cases: a text route, a route no key names (the default), a JSON route on `route_key` with an output schema, JSON text without one, a task-mode node routing on its `finish_task` output, an agent with `includeContents: default`, a chain through `toolNodeRunner` (an agent routes to a tool node whose result the next agent reads), and a node whose model fails.
