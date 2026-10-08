---
type: subsystem
title: Workflow agent node
description: "An agent as a workflow node on the native runtime (lib/workflow/agentNode.ts) and the route a node's output takes (lib/workflow/route.ts). The previous node's output is stored as the node's user turn, an agent that does not set includeContents sees only it, a task-mode agent ends on finish_task's answer, each stored event (a compaction included) carries the node's output, path and outputFor as ADK writes them, the instruction's workflow placeholders are filled from the node's input and the stored outputs, and a route step, a join and a map store ADK's events (lib/workflow/nodeEvents.ts). agentNodeRuntime gives the scheduler its runNode and onEvent. No ADK import."
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
  - resource: lib/workflow/nodeEvents.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/request.ts
  - resource: tests/workflowAgentNode.test.ts
  - resource: tests/workflowParity.test.ts
---

# Workflow agent node

`lib/workflow/agentNode.ts` runs an agent of a `workflow:` syndicate as a node of the [workflow scheduler](/overview/workflow-scheduler.md), on the [native loop](/overview/native-loop.md). It is ADK 2.2's `runLlmAgentAsNode` and the part of its node runner that stamps events, rule for rule, so a session the native walk writes holds the events ADK's holds. `lib/workflow/route.ts` holds the route rule both runtimes use. Why the node is a loop hook, and why the route step stores an event, is [ADR 0090](/decisions/0090-workflow-agent-node-on-the-native-loop.md). How the instruction placeholders, the join and map events and a node's compaction match ADK is [ADR 0093](/decisions/0093-workflow-parity-placeholders-join-map-events-compaction.md). On the native runtime the turn runner chains it with the tool and ask_user runners for every workflow turn ([the native turn](/overview/workflow-scheduler.md#the-native-turn), [ADR 0095](/decisions/0095-native-workflow-turn-drains-through-the-adk-reader.md)).

## One node

`runAgentNode(agent, run, context)` runs one node run and resolves with `{ output }`, `{ error }` when it ended on a reported error with no output, or `{ interruptIds }` when it waits on approvals:

| rule | what happens |
|---|---|
| the input is the user turn | the previous node's output is stored as a `user` event on the node's branch: a Content as it is (role `user`), a string as one text part, anything else as its JSON; nothing for an undefined or null input. The event carries no node path, as ADK appends it straight to the session. |
| includeContents | an agent whose YAML does not set `includeContents` runs with `none`, so it sees its input and nothing else of the session. The node runs a copy (`asNodeAgent`); the compiled agent is unchanged. |
| task mode | a `mode: task` agent gets no user turn and keeps its `includeContents`; the loop runs it with `taskNode`, and it ends on `finish_task`'s successful answer ([ADR 0081](/decisions/0081-native-task-mode-ends-a-node-on-finish-task.md)). |
| the output | outside task mode, each stored model event with content and no function call carries `output`: its text without thought parts, parsed as JSON only when the agent has an output schema and the text parses; and `nodeInfo.messageAsOutput` (`eventOutput`, ADK's `maybeSetOutput`). The node's output is the last one an event carried. |
| the stamp | every stored event gets `nodeInfo.path`, `nodeInfo.outputFor` when it carries an output, and the node's branch when it has none: ADK's `enrichEvent`, through `enrichNodeEvent`, the one port of it ([tool node](/overview/workflow-scheduler.md#tool-nodes)). The loop applies it through `nodeStamp`, after the outputKey and task hooks, and to a compaction event the node's agent stores before a step, which therefore carries the summary as its output outside task mode, as ADK's `maybeSetOutput` gives it. |
| the instruction | the run carries ADK's workflow instruction scope (`workflowScope`): the node's input, and `predecessorOutputs`, the output each event of the invocation stored before the node ran, by node name (ADK's `collectPredecessorOutputs`). See [The instruction](#the-instruction). |
| failure | an event with an error code is the node's reported error. A run that ends with one and no output returns it as `{ error: { code, message } }`; the scheduler fails the attempt with `NodeReportedError`, ADK's message, retries it as the node's `retry` allows, and, because the node's own event reported it, writes no node-error event of the workflow's, as ADK writes none. A run the turn stopped throws `NodeStoppedError`. A run that pauses on an `ask_user` tool call throws. An `ask_user` node is another runner's ([the pause](/overview/workflow-scheduler.md#ask_user-nodes-the-pause)). |
| approvals | a run that pauses on approval requests (a tool in the agent's `require_approval`) resolves with their ids as `interruptIds`: the node waits and the walk ends paused. The stamp records the node's input in `actions.agentState` on the request, as ADK's node runner does. See [Approvals](#approvals). |

The node's path is `<workflow>.<node>`, or `<workflow>.<map>.<agent>@<index>` for a map item, as the scheduler computes it.

## The runner the scheduler takes

`agentNodeRuntime({ agents, session, sessions, invocationId, userContent, loop, onEvent, onPartial, next })` returns:

- `runNode`: runs agent nodes and map items; every other run goes to `next`, so it chains with `toolNodeRunner(context, next)` and `askUserNodeRunner(context, next)`;
- `onEvent`: the scheduler's event hook; on the `node_end` of a route step, a join or a map it stores the event ADK stores for that node;
- `store(event)`: stores another runner's event on the same queue; the tool node runner's `onEvent` passes its event here;
- `settled()`: resolves once every queued event is stored.

A node's user turn and the events of route steps, joins and maps are stored through one queue, in the order the walk reaches them, so each lands before its successor's input, as on ADK. A node's user turn is queued as the node starts, as ADK's `runLlmAgentAsNode` appends it straight to the session; an event another runner hands to `store` (a tool node's, an ask_user request) is queued a microtask later, as ADK's Runner stores what a node yields behind the turns of nodes started in the same pass, and still before the walk starts that node's successors. Under concurrent fan-out the events of the branches land in ADK's order whenever their finish times are apart; finishes in the same instant race on both runtimes. `onEvent` (the option) receives every stored event in order; fed through `drainAgentStream`, they print the progress lines ADK's do, which name declared nodes only, never the root or a route step. `onPartial` receives each partial event a node agent's loop yields with streaming on; it is never stored.

## Route derivation

`routeOf(output, routeKey = 'route')` is the one rule; `lib/workflowConfig.ts` re-exports it for the ADK path:

- an object output: its `routeKey` property, trimmed; `''` when absent or null;
- a string: the text, trimmed. JSON an agent writes without an output schema is text, as ADK keeps it, so it routes on the whole text and usually takes the `default` edge;
- anything else: its string form, trimmed; `''` for undefined or null.

The scheduler matches the route against the keys in ADK's spelling and takes the `default` edge when no key matched. `routeStepEvent` is the event ADK stores for the step: authored `<Node>__route`, the output and the route, `nodeInfo { path, outputFor }`, no content.

## The instruction

A node agent's string instruction (and the root's global instruction) is filled by `injectSessionState` (`lib/runtime/native/request.ts`) with the run's workflow scope, as ADK 2.2's `injectSessionState` fills it with its `workflowInstructionScope`:

| placeholder | filled with |
|---|---|
| `{key}`, `{key?}` | session state, as on every run |
| `{x.field}` (any identifier, a dot, an identifier) | the input's `field` when the input is an object holding it; `''` when written `{x.field?}`; else left as written, in the key's first spelling |
| `<x.field from Node>` | `field` of the output `Node` stored, when that output is an object holding it; else left as written |

Outside a workflow node neither form is a placeholder. A string input, or a node whose output is text, fills nothing. Both scans are linear, with no pattern run on the instruction text.

## Join and map events

The scheduler runs joins and maps itself; `lib/workflow/nodeEvents.ts` builds the events ADK stores for them, and `agentNodeRuntime.onEvent` stores them on the node's `node_end`:

- a join: ADK's `JoinNode` event, authored by the node, on its branch, its output the joined object, no content;
- a map: the event ADK's `BaseNode.toEvent` makes of its `ParallelWorker`'s result list, with the list as its output and `nodeOutputContent(list)` as its content: one model part per item when every item is a string or a Part, else one text part holding the list's JSON (an empty list included). A map stopped from outside has no output and stores nothing. Items have no event of their own beyond their agent's.

Both are stamped through `enrichNodeEvent`.

## Approvals

A gate on a workflow node's agent ([ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md)) pauses the node on ADK's `adk_request_confirmation` request, and the turn ends `input-required` with `result.approval`. The resumed walk reruns the node with `run.resumedInterruptIds`, the requests its prior run paused on:

- every request has a decision among `run.resumeInputs` (a `{ confirmed }` answer, or the same as JSON under `response`; never plain text): the node stores no input turn and its run continues. The person's answer is still the latest user event, so the loop's approval resume ([native loop](/overview/native-loop.md#approvals)) runs or refuses the pinned call before the next model step, whose history starts at the node's input;
- an earlier resume already continued the node (another node's approval was the one answered since): the output its run stored after the requests is the node's (`outputAfter`), and nothing runs;
- some request has no decision: the node raises the open requests again on one event of the new run (`waitAgain`) and waits, so the next message's resume still finds the walk paused.

ADK's `runLlmAgentAsNode` stores the input again on the rerun and starts the agent afresh, so the pinned call never runs there. `runSyndicateTurn` refuses a gated workflow on ADK.

A skill script is the same pause: `run_skill_script` on a node agent with `skills.scripts: local` raises its `adk_request_confirmation` request, the node waits, and the decision runs the script once or refuses it, with ADR 0086's minimal environment ([ADR 0106](/decisions/0106-nested-workflow-routes-nodes-and-node-skill-scripts.md)). The adk runtime refuses it by name, and the schema refuses it on an agent a map runs. `tests/workflowSkillScripts.test.ts` runs a real script on a node.

An agent node that names a nested workflow syndicate is not an agent run: `agentNodeRuntime` hands it to `runWorkflowNode` ([Workflow scheduler](/overview/workflow-scheduler.md#as-a-route-or-a-node)).

## Not here yet

- An `ask_user` tool call inside a node, and a pause inside a map item.

## Parity with ADK

`tests/workflowAgentNode.test.ts` takes each case's ADK side (`runSyndicateTurn`, runtime `adk`) from its recording ([ADR 0108](/decisions/0108-adk-reference-recorded-by-the-parity-suites.md); live under `ADK_REFERENCE=live`) and runs it on the scheduler with `agentNodeRuntime`, with the same scripted models. It compares the stored events (ids and times aside), every model's requests, the routes, the workflow's output and the progress lines. The cases: a text route, a route no key names (the default), a JSON route on `route_key` with an output schema, JSON text without one, a task-mode node routing on its `finish_task` output, an agent with `includeContents: default`, a chain through `toolNodeRunner` (an agent routes to a tool node whose result the next agent reads), and a node whose model fails.

`tests/workflowParity.test.ts` holds the same comparison, through the shared harness `tests/helpers/workflowParity.ts`, for:

- the instruction: ADK's own `injectSessionState`, recorded, against the port on a corpus of templates, with and without a scope and for inputs of every kind, a chain whose agents read `{input.field}` and `<input.field from Node>`, and a task-mode node; hostile templates scan in linear time;
- joins and maps: a fan-out and join, a join after a route step, a map under `max_parallel` 1, 2 and the default, an empty list, a non-list input and object items; `nodeOutputContent` against ADK's `toContent`;
- concurrent fan-out: three branches at once (an agent that calls a tool and routes on, a tool node, a map) joined, under three delay profiles that keep any two finish times 20 ms apart, and a node two branches trigger;
- compaction: a plain and a task-mode node that compact before their step.

The scripted models and the slow tool in these cases, and the slow scripts of `tests/workflowApprovals.test.ts` and `tests/workflowSubagent.test.ts`, wait on the virtual clock of `tests/helpers/virtualClock.ts`, as the scheduler suite's stubs do ([Workflow scheduler](/overview/workflow-scheduler.md#parity-with-adk)): a finish order is the profile's timeline on every runtime, never a race of real timers.
