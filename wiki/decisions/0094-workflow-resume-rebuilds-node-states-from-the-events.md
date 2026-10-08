---
type: decision
title: "ADR 0094: A paused workflow resumes on the scheduler by rebuilding every node's state from the stored events, as ADK's rehydration does"
description: "lib/workflow/resume.ts ports ADK 2.2's rehydration with no ADK import: the run's events (the current invocation and the paused runs just before it), the answers (a plain-text message to the one open interrupt, or a function response by id, unwrapped and checked against the stored response_schema), each direct child's prior runs, and the message's text as the walk's input. The scheduler takes them as RunWorkflowOptions.resume: a node with a stored output and no open interrupt completes without running (node_resumed, no event), a paused node reruns on its recorded input with the answers in NodeRun.resumeInputs, and the walk goes on. An ask_user node rerun with an answer outputs { reply, input }. A pause raised inside an agent node or a map item is refused by name. Keeping walk state between turns, resuming from the paused node instead of from START, reading only the newest message, and re-running a nested pause from its input were rejected."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/resume.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflow/pause.ts
  - resource: lib/runtime/questions.ts
  - resource: tests/workflowResume.test.ts
---

# ADR 0094: A paused workflow resumes on the scheduler by rebuilding every node's state from the stored events

## Context

[ADR 0092](/decisions/0092-workflow-pause-returns-interrupts-to-the-walk.md) made an `ask_user` node pause the scheduler's walk and store ADK's events for it: the `adk_request_input` request with the node's input in `agentState`, and the workflow's own record. The next message answers the question. Gate G4 of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) needs that answer to resume the walk without ADK, and its stop rule needs every ADK-written session to resume under `native`: the WS0-6 fixture `05-workflow-ask-user` is one.

ADK 2.2 keeps nothing between the two turns. On the next message it walks the graph again from `START` and rebuilds each node's state from the session (`workflow/utils/rehydration_utils.js`, `Workflow.orchestrate` and `startNodeTask`, `runNodeAsInvocation`):

- **The run's events.** The events of the current invocation, extended back over each run just before it that raised an interrupt (`eventsForCurrentRun`). Only ADK's own request calls count as raised: `adk_request_input`, `adk_request_credential` and `adk_request_confirmation`.
- **The answers.** A message of text parts only answers the single open interrupt (`resumeInputsFromPlainText`). A function response with an interrupt id answers that one. `{ result: x }` is unwrapped to x, and an object reply is checked against the request's `response_schema` (`resolvedInterruptResponses`). In the newest message, a reply to an unknown or already-answered interrupt, or one the schema refuses, throws with ADK's message.
- **The node states.** For each direct child of the workflow, ADK keeps its runs: the output, route and branch an event carried, the interrupts the run raised and their answers, and `agentState.input` (`reconstructNodeRuns`).
- **The walk.** Each node's first activation takes its next prior run. A run with an output or a route and no open interrupt completes at once with them, and nothing is written. A paused node that reruns on resume (an agent, the ask_user FunctionNode, a map) runs again on its recorded input with the answers in `ctx.resumeInputs`. A paused node that does not rerun (a tool node, a join, a route step) completes with its answers. The walk's own input is the new message's text.
- **The ask_user node.** The FunctionNode that `lib/workflow.ts` compiles returns `{ reply, input }` when `ctx.resumeInputs` holds any answer, the last answer being the reply. `ctx.resumeInputs` holds every answer of the walk, so a second ask_user node later in the same resumed walk takes the first answer without asking.

Running ADK's resume of fixture 05 showed what it stores: the message, Confirm's output event (`{ reply: 'yes', input: 'the draft' }` as model text and as output), Publisher's input turn, and Publisher's answer. Triage writes nothing and is not called.

## Decision

1. **`lib/workflow/resume.ts` is ADK's rehydration, function for function, with no ADK import.** `eventsForCurrentRun`, `raisedInterrupt`, `resolvedInterruptResponses` (with `unwrapResponse` and `interruptResponseMismatch`, which validates through zod's `fromJSONSchema` as ADK does), `reconstructNodeRuns`, `reconstructNodeStates`, `isFastForwardable`, `nodeNameFromPath`, `directChildName`, `resumeInputsFromPlainText` and `workflowNodeInput` (ADK's `extractNodeInput`). `rerunsOnResume(node)` is ADK's `rerunOnResume` per node kind, as `lib/workflow.ts` compiles them. `workflowResume({ events, invocationId, userContent, workflowPath })` puts them together and returns `{ input, resume }`.
2. **The scheduler's seam is one option and one field.** `RunWorkflowOptions.resume` (`{ priorRuns, resumeInputs }`) changes only how a node's first activation starts, in one place (`resumeStart`, ADK's `startNodeTask`). A node completed from its stored run emits `node_resumed` (`from: 'stored' | 'answers'`) instead of `node_start` and `node_end`, so a listener that stores events on `node_end` (route steps, joins, maps) stores nothing for it, as ADK writes nothing. Neither shortcut counts as a run, so run ids and branches match ADK's. `NodeRun.resumeInputs` carries the answers: all of them on a first activation, none on a repeat one.
3. **The ask_user runner answers on a resume.** With an answer in `run.resumeInputs`, `runAskUserNode` writes the FunctionNode's output event and returns `{ reply, input }`. It does not ask again.
4. **A pause the native walk cannot pick up is refused by name.** A request raised inside an agent node (an OAuth consent, an approval) or inside a map item is resumed by ADK inside that node. The native agent node does not pause at all (`runAgentNode` refuses), so `workflowResume` throws `UnsupportedWorkflowResumeError` with the node's path. It does not rerun the node from its input, which would ask again. An `ask_user` tool call inside an agent is not a pause to ADK's rehydration, so on both runtimes the walk starts afresh.
5. **`pendingWorkflowInput` moves into the library** beside `pendingQuestion` (`lib/runtime/questions.ts`). As with questions, a request in an event the user wrote opens nothing. The test helper re-exports it.

## Alternatives considered

- **Keep the walk's state between turns** (the waiting node, the outputs, the buffered triggers) in session state or in a side table. A resume would then need no rebuild. But ADK keeps no such state, so a session paused on one runtime could not resume on the other, and the state would be a second record of what the events already hold.
- **Resume from the paused node** instead of walking again from `START`. That is simpler, but it would skip ADK's handling of everything else: a finished branch completing again, so that a join gets its predecessor's stored output; a second trigger buffered for a waiting node; the terminal-output check counting a stored output. The fan-out case shows the difference: a stored output on the other branch makes two terminal outputs, and ADK fails the walk with its message.
- **Read only the newest message** for the answer. A structured answer is a function response with an interrupt id, and ADK refuses a reply to an id that is not open. Reading only the text would accept a reply ADK refuses, and lose the schema check.
- **Rerun a nested pause from the node's input.** A map item or an agent node that paused would run again from scratch and ask again: a different session from ADK's, and a person asked twice. A refusal by name is honest until the native agent node can pause and resume.
- **Give each ask_user node only its own answer.** That reads better: a second ask_user node in a resumed walk would ask its own question. But it would change what ADK does with the same session. The behaviour is recorded here, and changing it belongs to a record that changes both runtimes together.

## Consequences

- `tests/workflowResume.test.ts` resumes fixture 05 on the scheduler, with real agent nodes on the native loop. The events it stores match ADK's resume of the same session (ids, times and invocation ids aside), Triage is not called, and Publisher's request carries both the reply and the draft. A pause the scheduler opens stores the fixture's events and resumes on ADK as well as on the scheduler. Graphs of stub agents (a chain, a function-response answer, a fan-out, a join, two ask_user nodes in a row, a session with nothing paused, a reply to an unknown interrupt) resume on the scheduler from ADK's stored events and from its own, and write ADK's events. Each ported function is checked against ADK's own on the same events.
- The native runtime still refuses a workflow syndicate ([ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)). WS4-6 lifts the refusal and calls `workflowResume` when the session holds a paused walk, storing the message before the walk as ADK's Runner does. Until then, the fixture's native case in `tests/sessionFixtures.test.ts` stays skipped.
- The module is internal: it is not in the `exports` map or the barrel.
