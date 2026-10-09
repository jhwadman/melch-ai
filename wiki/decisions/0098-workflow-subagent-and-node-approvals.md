---
type: decision
title: "ADR 0098: A nested workflow syndicate runs its whole graph as the subagent tool, and an approval gate pauses a workflow node on the native walk"
description: "A delegated yaml_reference to a workflow syndicate is a WorkflowSpec (lib/compile.ts) whose whole graph is the subagent tool under the entry's name: on ADK its Workflow inside ADK's own AgentTool, on native a workflowSubagentTool whose call walks the graph with runNativeWorkflow on the child session AgentTool would open, the last yielded event's text the answer. A nested workflow with an ask_user node is refused by name. require_approval on a workflow node's agent pauses the node and the walk on adk_request_confirmation; the next message's decision resumes the node's own run on native, which runs or refuses the pinned call through the loop's approval resume and walks on, any other message repeats the request, and a node still waiting raises its requests again. ADK, whose resume starts the node afresh and never runs the pinned call, refuses a gated workflow before any model call. The schema lifts the refusal except on an agent a map runs. Wrapping the Workflow in a custom tool on ADK, keeping the nested orchestrator alone, resuming ADK's way, lifting the gate on both runtimes, refusing a message that is not a decision, and walking on with it were rejected."
tags:
  - decision
  - runtime
  - agents
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/compile.ts
  - resource: lib/compileAdk.ts
  - resource: lib/compileNative.ts
  - resource: lib/workflow.ts
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflow/resume.ts
  - resource: lib/runtime/approvals.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/workflow/graph.ts
  - resource: tests/workflowSubagent.test.ts
  - resource: tests/workflowApprovals.test.ts
---

# ADR 0098: A nested workflow syndicate runs its whole graph as the subagent tool, and an approval gate pauses a workflow node on the native walk

## Context

[ADR 0030](/decisions/0030-workflow-graphs.md) left two refusals open. A `yaml_reference` to a workflow syndicate compiled its orchestrator alone, because ADK was thought unable to make a `Workflow` a subagent. And the schema refused `require_approval` inside a workflow, because a gated call pauses a node through ADK's interrupt path, whose resume is not the one [ADR 0028](/decisions/0028-approval-gates.md) built. With the native walk in place ([ADR 0095](/decisions/0095-native-workflow-turn-drains-through-the-adk-reader.md)) and native approvals resumed by the loop ([ADR 0077](/decisions/0077-native-approvals-port-the-confirmation-processor.md)), both could be lifted. [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) makes ADK the specification wherever ADK runs a case.

Running ADK 2.2 showed:

- **ADK's `AgentTool` runs a `Workflow`.** It takes any node its `Runner` takes. A call opens a `Runner` with the tool's name as the app name, on the session `{ <name>, userId, sessionId }` created from the caller's state, sends the request as the message, and answers with the last yielded event's non-thought text. A `Workflow` has no output schema, so the answer is never parsed, and its declaration is the one string `request`. The node paths are rooted at the `Workflow`'s name.
- **ADK pauses a gated workflow node, and cannot resume it.** The node stores the call and ADK's `adk_request_confirmation` request (with the node's input in `actions.agentState`), and the workflow stores its pause record. On the decision, ADK's rehydration reruns the node: `runLlmAgentAsNode` stores the node's input as a new user turn, and the agent, which sees only its current turn, starts afresh. The request-confirmation processor reads the latest user event, now the input turn, so it binds nothing. The pinned call never runs, and the model is asked the same thing again.

## Decision

1. **A delegated nested workflow is one tool, the whole graph.** `compileSpec` loads a delegated `yaml_reference` once (`loadNestedSyndicate`, which keeps the refusal of gates inside any nested syndicate). A workflow syndicate becomes a `SpecTool` of kind `workflow`, holding a `WorkflowSpec` (`compileWorkflowSpec`): its name and description (the entry's), the syndicate renamed to that name, every agent's spec with its YAML entry, and the registry's tool lookup. `compileWorkflow` builds the same spec at the root, so both paths build their graphs from one place.
2. **On ADK, ADK's own AgentTool wraps the Workflow.** `assembleWorkflow` (`lib/workflow.ts`) builds the `Workflow` from the spec synchronously, under the entry's name and description, and `compileAdk` hands it to `AgentTool`.
3. **On native, the call walks the graph as AgentTool runs it.** `compileNative` lists a `workflowSubagentTool` (`lib/runtime/native/delegate.ts`). Its `WorkflowSubagent` carries the graph (`compileNativeWorkflow`) and a `walk` that runs `runNativeWorkflow` (`workflowSubagentOf`, `lib/compileNative.ts`). The loop calls it where it calls a subagent tool. The call opens the child session as `runSubagent` does, with no self-correction, as ADK's sub-runner has none. The walk stores the message itself. The call records each yielded event's state writes, `temp:` keys aside, and answers with the last yielded event's text. A node that gave up fails the call with its error. `nativeAdapterFor` learns every nested node's model. `delegate.ts` does not import the walk, so it stays below `lib/workflow/` in the import graph.
4. **A pause inside a nested workflow is refused by name.** A nested workflow with an `ask_user` node fails to compile, on both runtimes, naming the node, the entry and the file. A pause inside a tool call cannot reach the caller (ADR 0028), and carrying it there is WS6-2.
5. **An approval gate pauses its workflow node on native.** `runAgentNode` resolves a run that paused on approval requests with their ids as the node's interrupts. The node waits and the walk ends paused, as an `ask_user` node's does. The node's stamp records its input in `actions.agentState` on the request, as ADK's node runner does, so the pausing turn stores what ADK's `Workflow` stores. `runSyndicateTurn` reads the request (`pendingApproval`) and ends the turn `input-required` with `result.approval`. `pendingApproval` trusts the walk's pause record, so a node input stored after the request does not hide it.
6. **The decision resumes the node's own run.** `workflowResume` accepts an approval request raised at a direct child of the workflow. The scheduler hands a rerun node the interrupts its prior run paused on (`NodeRun.resumedInterruptIds`). The agent node, once every one of them has a decision (a confirmation, never plain text), stores no input turn and continues its run. The person's answer is still the latest user event, so the loop's approval resume runs or refuses the pinned call before the next model step, whose history starts at the node's input. If an earlier resume already continued the node, its stored output is the node's, and it does not run again.
7. **One decision per message.** While a gated call waits, a message that is not its decision repeats the request: nothing is stored and nothing runs, as the A2A server already answers it. A node whose requests are not all decided waits again and raises them on one event of the new run, so the next message's resume still finds the walk paused.
8. **ADK refuses a gated workflow.** `runSyndicateTurn` throws `UnsupportedOnRuntimeError` on ADK for a workflow syndicate that declares approvals, before the session is touched.
9. **The schema lifts the refusal, except under a map.** `require_approval` is allowed on a workflow node's agent. It is refused on an agent a `map` node runs, because a map item cannot pause the walk (ADR 0094). `lib/workflow/graph.ts` keeps the same rule and message. Skill scripts stay refused inside a workflow.

> **Note (2026-10-09):** [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md) lifts the refusal of a nested workflow's `ask_user` node and gates when the workflow is a delegated subagent; as a dispatch route or a workflow node they stay refused.

## Alternatives considered

- **Wrap the Workflow in a tool of the engine's own on ADK.** It would let ADK answer with the terminal node's `output` rather than the last event's text. But ADK's `AgentTool` already runs a `Workflow`, and ADK is the specification where it runs. The two answers agree whenever the last event is the terminal node's.
- **Keep the nested orchestrator alone.** That is no longer an ADK limit. It silently runs a different syndicate from the one the file describes.
- **Resume ADK's way on native** (store the input again and start the node afresh). The pinned call would never run, and the person's decision would be lost. A gate that cannot be honoured is worse than a refusal.
- **Lift the gate on both runtimes.** ADK would pause, then run the model again on the decision and drop the call. Refusing on ADK is honest and costs nothing: native is the runtime the plan moves to.
- **Refuse a message that is not a decision, or walk on with it as the answer.** A failure would end a conversation the person can still finish. Walking on would answer the approval with text, which binds nothing. Repeating the request is what the A2A server does for any approval.
- **Leave a still-waiting node with no new event.** ADK's rehydration extends a run back only over invocations that raised an interrupt, so the next decision would start the graph afresh.

## Consequences

- `tests/workflowSubagent.test.ts` runs a nested fan-out, join and edit graph under a DELEGATE orchestrator on both runtimes. Both runtimes store the same caller and child sessions and send the same requests. It also covers the refused `ask_user` node and the compiled tool's name and description.
- `tests/workflowApprovals.test.ts` runs on native: approve, refuse, a plain-text message while waiting, a sibling's input stored after the request, and two gated nodes paused at once. The pausing turn's events equal ADK's. On ADK, the gate is refused before any model call. It also covers the schema.
- A nested workflow is not projected: its child session holds node inputs as user turns, as at the root.
- Open: a workflow syndicate as a dispatch route or a workflow node is still its orchestrator alone. Skill scripts in a workflow, a gate on a map's agent, and a pause carried out of a nested workflow (WS6-2) are still refused.
- No exports map or barrel entry changes. `SpecTool` in `melchizedek-agents/compile` gains the `workflow` kind, and the module exports `compileWorkflowSpec` and `WorkflowSpec`, so the CHANGELOG records them under the unreleased 0.19.0.
