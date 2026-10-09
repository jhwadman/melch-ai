---
type: decision
title: "ADR 0106: A workflow syndicate runs its whole graph as a dispatch route or a workflow node, on its own child session, and skill scripts pause a workflow node on native"
description: "ADR 0098's open questions. A yaml_reference to a workflow syndicate runs its whole graph wherever it appears (compileEntrySpec), on the child session filed under the entry's name, as a delegated nested workflow does. As a plan-dispatch route it runs on both runtimes (ADK's Runner with the assembled Workflow, or the native walk), drained by the workflow reader; the conversation stores the message and one answer event authored by the route. As a workflow node it runs on the native walk (runWorkflowNode), which stores one node event carrying the output; ADK, which would run a nested Workflow inline in the caller's session, refuses it by name before the session is touched. A map over one, and a nested ask_user node, are refused by name. Each nested walk keeps its own node-run ceiling (ADR 0105). Skill scripts (skills.scripts: local) are allowed on a workflow node and pause it on the same approval as require_approval; ADK refuses them by name; a map's agent may not carry them. Running the nested graph inline as ADK does, storing it in the conversation, a FunctionNode wrapper on ADK, keeping the orchestrator alone, and one shared node-run ceiling were rejected."
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
  - resource: lib/compileNative.ts
  - resource: lib/workflow.ts
  - resource: lib/workflow/turn.ts
  - resource: lib/workflow/agentNode.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/workflow/graph.ts
  - resource: tests/workflowNested.test.ts
  - resource: tests/workflowSkillScripts.test.ts
---

# ADR 0106: A workflow syndicate runs its whole graph as a dispatch route or a workflow node, on its own child session, and skill scripts pause a workflow node on native

## Context

[ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md) made a delegated `yaml_reference` to a workflow syndicate run the whole graph, on the child session ADK's `AgentTool` opens, and made an approval gate pause a workflow node on the native walk. It left open: a workflow syndicate as a plan-dispatch route or as a workflow node still compiled its orchestrator alone (silently a different syndicate from the one the file describes), and skill scripts stayed refused inside a workflow.

Reading ADK 2.2 showed:

- **ADK's `Workflow` is a `BaseNode`.** A `Workflow` placed in another's edges runs inline: its nodes' events land in the caller's session under paths `<caller>.<node>.<child>`, its output is its terminal node's, and the caller's rehydration reads it back from those paths. The native walk does not mirror nested paths, and porting that rehydration is the work of carrying a pause out of a nested workflow (WS6-2).
- **ADK's `Runner` runs a `Workflow` as its root** on any session, as the root workflow turn already does on the adk runtime.
- **`run_skill_script` raises `adk_request_confirmation`** through the engine's own tool, the same request `require_approval` raises, and ADR 0098's node resume reads any approval request.

## Decision

1. **One compile for an entry.** `compileEntrySpec` (`lib/compile.ts`) compiles a subagent entry as one agent, or a `yaml_reference` to a workflow syndicate as its `WorkflowSpec` under the entry's name and description. The DELEGATE tool list, a dispatch route and a workflow's nodes all compile through it. `compileSubagentSpec` (and so `compileSubagent`) refuses a workflow reference by name instead of compiling its orchestrator alone. `WorkflowSpec.workflows` lists a workflow's nodes that are nested workflows.
2. **A route walks on its own child session, on both runtimes.** `runSyndicateTurn` walks the route's graph on the session `{ <route>, userId, sessionId }` of the turn's session service, created from the conversation's state the first time (`temp:` keys dropped) and kept, as a delegated nested workflow does. On adk the `Runner` runs the assembled `Workflow` there; on native `runNativeWorkflow` does. The stream goes through the workflow reader (`collect` policy, stage `dispatch`), so the route's answer is the last event's text, as the workflow would answer as its own syndicate. Before the walk the conversation stores the message; after it, one model event authored by the route with the answer and the walk's state writes. The classifier digest and the next route read the exchange as any route's. A node that gave up fails the turn `NODE_FAILED` (`NODE_RUN_LIMIT` for the ceiling) at the dispatch stage.
3. **A node walks on its own child session, on native.** `agentNodeRuntime` hands a node that names a nested workflow to `runWorkflowNode` (`lib/workflow/turn.ts`), which walks the nested graph on `{ <node>, userId, sessionId }` with the node's input as its message (as a node input turn is made) and answers with the last yielded event's text. It stores one event in the caller's walk: authored by the node, stamped with its path and `outputFor`, carrying the output and the walk's state writes. A resumed caller walk completes the node from that event and never walks it again. A walk that ends paused is refused by name.
4. **ADK refuses a workflow node that is a workflow syndicate**, by name, before the session is touched (`workflowEntryNames`), and `assembleWorkflow` refuses it too, with `UnsupportedOnRuntimeError`.
5. **What a nested graph cannot carry stays refused.** An `ask_user` node inside it is refused by name as a route and as a node (ADR 0098's message now reads "a workflow nested in another syndicate"). A nested syndicate with approval gates or skill scripts is refused as before (`loadNestedSyndicate`). A `map` over a nested workflow is refused by name: a map runs one agent per item.
6. **Each walk keeps its own node-run ceiling.** The root walk, a route's walk and each nested node's walk are separate `runWorkflowGraph` calls, and each counts its own runs against `nodeRunCeiling(max_steps)` ([ADR 0105](/decisions/0105-workflow-node-run-ceiling.md)). Every model call in any of them still counts once against the turn's `max_steps`, which bounds how many nested walks can start.
7. **Skill scripts pause a workflow node on native.** The schema, and `lib/workflow/graph.ts` with the same message, allow `skills.scripts: local` on a workflow node's agent and refuse it on an agent a `map` runs. Each `run_skill_script` call pauses the node and the walk on its approval; the decision resumes the node's own run, which runs or refuses the script once (ADR 0098 decision 6). The script environment of [ADR 0086](/decisions/0086-skill-scripts-get-a-minimal-environment.md) applies unchanged. `runSyndicateTurn` refuses such a workflow on adk by name ("skill scripts (run_skill_script, an approval pause) on a workflow node (<agent>)") before any model call.

> **Note (2026-10-09):** [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md) lifts the refusal of a nested workflow's `ask_user` node and gates when the workflow is a delegated subagent; as a dispatch route or a workflow node they stay refused.

> **Note (2026-10-09):** [ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md) lifts those refusals too, and files a route's or node's child session under the agent path (`<app>/<entry>`) instead of the entry's name.

## Alternatives considered

- **Run a nested workflow node inline, as ADK's own `Workflow` node does.** ADK is the specification where it runs a case ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)), and inline would keep one session. But the native walk would need ADK's nested-path rehydration, and a pause inside the nested graph would then be a pause of the caller: that is WS6-2, not this record. The child session is the shape ADR 0098 already gives a nested workflow, so one nested workflow behaves one way wherever it appears; the adk runtime refuses the node rather than store a different session.
- **Wrap the nested walk in a `FunctionNode` on ADK.** The node would run on both runtimes, but as an engine construct inside ADK's walk, beside ADK's own inline form, for a runtime 1.0.0 removes. A refusal by name costs nothing on the default runtime.
- **Walk a route's graph in the conversation's own session**, as the root workflow walks. Its node inputs are user-authored events: the classifier digest and the next route's projection would read them as the person's words.
- **Keep the orchestrator alone.** ADR 0098 rejected it for a subagent; it holds the same for a route and a node.
- **One node-run ceiling shared by every walk of the turn.** It would bound the whole turn's node runs, but a caller would need the nested walks' counts threaded through the scheduler's options, and two nested nodes in parallel would share a budget neither can see. `max_steps` already bounds how many walks start, since each runs at least one model call to be useful; each walk's own ceiling bounds the model-free loop inside it, which is what ADR 0105 closes.
- **Keep skill scripts refused in a workflow.** The pause they need is the one ADR 0098 built and tests; refusing them kept a YAML that runs on the orchestrator from running as a node, for no reason left.

## Consequences

- `tests/workflowNested.test.ts` runs the route on both runtimes (the answer, the child session's node paths, the conversation's two events, the next turn's classifier digest, a node that gives up) and holds both runtimes' sessions and requests equal; runs the node on native, with its resume from the stored output; covers the adk, map and `ask_user` refusals and the compile; and shows each nested walk under its own ceiling.
- `tests/workflowSkillScripts.test.ts` runs a real script on a node: the pause, one run after the approval, none after a refusal, a plain-text message repeating the request, the minimal environment, the adk refusal and the schema's map rule.
- **Breaking for a caller of `compileSubagent` or `compileSubagentSpec` with a workflow reference**, which got the orchestrator alone and now gets an error naming `compileEntrySpec`. `melchizedek-agents/compile` gains `compileEntrySpec`, `EntrySpec`, `workflowAgentSpecs`, `workflowEntryNames` and `WorkflowSpec.workflows`. The exports map and the barrel do not change.
- Open: a pause inside a nested workflow (an `ask_user` node, a gate) reaching its caller (WS6-2); a nested workflow node on adk; a gate or skill scripts on a map's agent; remote agents as workflow nodes.
