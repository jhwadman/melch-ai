---
type: decision
title: "ADR 0110: A pause inside a delegated subagent reaches the turn through the open call, and the answer travels back down"
description: "An approval request or an ask_user question raised in a delegated subagent's child loop no longer ends the call with ''. The child run ends paused, the caller stores no response to the subagent call and ends paused too, and runSyndicateTurn finds the pause by walking down the open calls into the child sessions (lib/runtime/native/interrupts.ts delegatedPauses). The turn ends input-required with the same pending record, plus the agent path. The answer is stored in the caller's session as the usual message; before each step, the caller's loop resumes the open call whose pause it answers, storing the same parts as the child's next message, and the child resumes as a top-level agent does. Two levels deep, two pauses in one step and dispatch routes that delegate work the same way. The stored events and interrupt names do not change. Mirroring the request into the caller's session, a pause marker event, and swallowing the pause as before were rejected."
tags:
  - decision
  - runtime
  - protocols
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/runtime/approvals.ts
  - resource: lib/workflowConfig.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/compile.ts
  - resource: tests/delegatedPauses.test.ts
  - resource: tests/nativeDelegate.test.ts
  - resource: tests/sessionFixtures.test.ts
---

# ADR 0110: A pause inside a delegated subagent reaches the turn through the open call, and the answer travels back down

## Context

[ADR 0028](/decisions/0028-approval-gates.md) allowed an approval gate only where a pause could reach the caller: the orchestrator and a plan-dispatch route. Under ADK, a confirmation raised inside an `AgentTool` was swallowed, and the schema refused a gate (and later `ask_user`) on a delegated subagent. [ADR 0074](/decisions/0074-native-delegation-runs-a-child-loop-as-agent-tool-does.md) kept that on the native loop: a child run that ended paused answered the call `''`, and the gated tool never ran.

With ADK gone ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)), the engine owns the child loop and can carry the pause out. Three things were fixed in advance: the interrupt names (`adk_request_confirmation`, `ask_user`) and the stored Event JSON keep their shapes; sessions written before this change resume; the A2A surface keeps its data parts.

A subagent runs in its own session, `{ <subagent>, userId, sessionId }`. Its request or question is stored there, by the subagent, as at the top. The turn runner and the A2A server read only the conversation's session.

## Decision

1. **The child's pause leaves the call open.** `runSubagent` reads how the child's loop ended. A run that ended `paused` resolves the call to a `SubagentPause`. The caller's `runCall` stores no response for that call, as for a long-running call that answered nothing, and adds the call id to the step's paused calls. The step's other responses are stored. The run ends `paused` with the open call ids among its pending ids.
2. **The turn finds the pause by walking down.** `delegatedPauses` (`lib/runtime/native/interrupts.ts`) takes a session's events and the store. Each call an agent left open (no later response, no user text since, not a framework call, not in a user-authored event) leads to the child session under the call's name. That child's own open request (`pendingApproval`) or question (`pendingQuestion`), authored by the child, is the pause. Otherwise the walk follows the child's own open calls, at most 16 levels deep and never into a name already on the path.
3. **The pending record gains a path.** `PendingApproval` and `PendingInput` take an optional `path`: the agents from the turn's own agent down to the one that asked. It is set only for a pause inside a delegated call, so every record the engine already produced is unchanged. The A2A data parts (`approval_request`, `input_request`) carry `path` beside their existing fields when it is set. Nothing else on the A2A surface changes.
4. **The answer is stored where it always was.** The approval decision (a function response to `adk_request_confirmation`) or the question's answer (`questionAnswerPart`, a function response to `ask_user`) is the user event in the conversation's session, as for a pause at the top. A decision must name the pause the walk finds, or the turn fails `NO_PENDING_APPROVAL`, as before.
5. **The answer travels down before a step.** After the approval resume, `resumeDelegations` in the loop asks `resumedDelegations` which open subagent calls the latest user message answers, by interrupt id. Each is resumed with `resumeSubagent`: the answering parts are stored as the child's next user message under a fresh invocation id, and the child's loop runs on. The child reads the answer from its own session as a top-level agent does: `approvedCalls` binds the decision to the pinned call (every `IntentMismatchError` check applies), and a question's answer is its call's response. One level further down, the child's own loop does the same. The child's answer is the open call's response; its state writes land on that response.
6. **A call still waiting pauses again.** A child that pauses again leaves the call open again. When the message answers one of several open calls, the caller stores that call's response and ends paused on the rest without a model step, so the next turn raises the next request. The caller steps once every open call has a response.
7. **The turn runner reports it.** After the orchestrator's run (or a dispatch route's), `runSyndicateTurn` looks below that agent's open calls and ends the turn `input-required` with `result.approval` or `result.input`. A dispatch resume picks the route that made the outermost open call and replays its turn raw from that call's turn. The A2A server reads a pending approval below the conversation's open calls for any syndicate that delegates, so a message that is not the decision repeats the request without a model call.
8. **The schema lifts the refusals.** `require_approval` and `ask_user` are allowed on a delegated subagent. A nested delegate syndicate may declare gates. Still refused: gates in a nested workflow or nested dispatch syndicate, an `ask_user` node in a nested workflow, `ask_user` as a tool on a workflow node, skill scripts on a delegated subagent, and a gate on an agent a map runs.

## Alternatives considered

- **Copy the request into the caller's session.** The turn runner and the A2A server would find it with the readers they have. But the copy is a request the caller never made: `approvedCalls` would refuse or skip it, the history would carry a second framework call, and the two copies could disagree. The walk reads the one stored request.
- **Store a pause record in the caller's session** (an empty event listing the open call in `longRunningToolIds`, as a workflow's pause record does). It would mark the open call explicitly. But it adds an event kind to every delegating session, and the open call is already explicit: a call with no response, before any new user text, whose child holds a request.
- **Keep the pause swallowed.** A gated tool on a subagent would stay a load error, and an enterprise would keep writing tools that need approval only on orchestrators.
- **Answer the child directly from the turn runner,** bypassing the caller's loop. The caller would then need a second step to pick the child's answer up, and the child's answer would never become the call's response in the order the caller's history expects.

## Consequences

- `tests/delegatedPauses.test.ts` covers approve and reject in a child, a mismatched decision, `ask_user` in a child, a message that moves on, two levels deep (an approval and a question), two pauses in one step, a dispatch route that delegates, the schema, and the A2A surface (the data part's fields, the repeated request, `approve`). `tests/nativeDelegate.test.ts` shows the loop leaves the call open and pauses the caller. `tests/sessionFixtures.test.ts` shows sessions written before this change hold no pause and resume. The two ADK references for the swallowed pause are removed: no case reads them.
- The answer message stays in the caller's session. The caller's history drops it: an answer to a call the caller never made is merged away once the open call's response follows, which the loop stores before its next step.
- A subagent with `includeContents: none` reads, on resume, the history from its question onward, as an orchestrator with `none` does at the top.
- Each turn of a delegating syndicate reads the conversation's session once more after the run, and a child session per call left open. A completed turn leaves no call open, so it reads no child session.
- `PendingApproval.path` and `PendingInput.path` are additive fields on exported types. No exports map or barrel entry changes; the CHANGELOG records the change under Unreleased.
- Open: a pause inside a nested workflow (WS6-2b), an OAuth consent inside a subagent, skill scripts on a delegated subagent, and remote (A2A) subagents' own input-required.
