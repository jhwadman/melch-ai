---
type: decision
title: "ADR 0111: Pauses inside nested syndicates reach the turn, and a subagent's session is filed under its agent path"
description: "ADR 0110's propagation, carried through yaml_reference. A nested delegate syndicate's gates and questions pause the turn wherever they are; a nested dispatch syndicate runs its classifier alone, so the classifier may gate and a gate on a route (which never runs nested) is refused by name; a nested workflow delegated to as a subagent pauses on its ask_user nodes and gated agent nodes, the call staying open (SubagentPause), the walk found by its pause record and resumed on the answer by its own resume (resumeWorkflowSubagent). As a dispatch route or a workflow node a nested workflow's pauses stay refused. A delegated subagent's child session is filed under its agent path (childAppName: <app>/<caller>/<subagent>, then /<inner>), so same-named subagents of two syndicates on one conversation no longer share it; a session under the old key (the subagent's name) is still continued when the caller called it before or a pause waits there (legacyChild). Carrying a nested workflow's pause as a route or a node, a pause marker in the caller's session, keying by the subagent's name with the syndicate's prefix, and migrating old sessions were rejected."
tags:
  - decision
  - runtime
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/nestedPauses.test.ts
  - resource: tests/delegatedPauses.test.ts
  - resource: tests/nativeDelegate.test.ts
---

# ADR 0111: Pauses inside nested syndicates reach the turn, and a subagent's session is filed under its agent path

## Context

[ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md) carries an approval request or an `ask_user` question from a delegated subagent's child loop to the turn, and the answer back down. It left two refusals in `loadNestedSyndicate` (gates in a nested workflow or a nested dispatch syndicate), the `ask_user` node refusal in a nested workflow (`compileWorkflowSpec`), and one flaw it found: a subagent's child session was filed under the subagent's name alone, ADK's `AgentTool` key, so two syndicates with a same-named subagent on one conversation shared it.

Two facts set what can be lifted. A nested dispatch syndicate compiles to its classifier alone (`compileSpec` lists no route on a dispatch orchestrator), so its routes never run nested. A workflow's walk already pauses on an `ask_user` node or a gated agent node and resumes from its session on the next message ([ADR 0094](/decisions/0094-workflow-resume-rebuilds-node-states-from-the-events.md), [ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md)); a delegated nested workflow walks on its own child session, so a second walk there with the answer is a resume.

## Decision

1. **Nested delegate syndicates:** any gate or question in them pauses the turn (ADR 0110), the nested orchestrator's own included.
2. **Nested dispatch syndicates:** the classifier may gate or ask, and pauses the turn as any delegated agent does. A gate (or skill scripts) on one of its routes is refused at load by name: it would never run.
3. **Nested workflows, delegated:** a walk that ends paused resolves the call to a `SubagentPause` with the walk's open interrupts, and the call stays open. `delegatedPauses` finds the walk by the workflow's own pause record (the last event of the child session, authored by the workflow at its own path, naming the open interrupts) and reports the agent node's approval request or the `ask_user` node's question with the path `[caller, workflow, node]`. The answer resumes the call through `resumeWorkflowSubagent`, which walks the graph again on it: an approval decision as it came, an `ask_user` answer as ADK's explicit reply to its `adk_request_input` call. The walk's own resume binds it. `compileEntrySpec` and `compileWorkflowSpec` take `delegated`, set only for a DELEGATE subagent.
4. **Nested workflows as a dispatch route or a workflow node:** gates and `ask_user` nodes stay refused, by name. The route walk and `runWorkflowNode` have no open call to carry the pause through, and the turn runner's resume does not reach those child sessions.
5. **A subagent's session is filed under its agent path:** `childAppName` gives `<app>/<caller>/<subagent>` below a top-level agent and `<parent app>/<subagent>` below a delegated one (the loop marks a child run `delegated`). Agent names are identifiers, so `/` never occurs in one. The walk derives the same keys from the session it walks.
6. **Old sessions still resume:** when no session exists under the path, the one under the subagent's name is continued if the caller called the subagent before in its own session, or a pause waits there (`legacyChild`). A syndicate that never called it, another syndicate's caller included, starts its own.

## Alternatives considered

- **Carry a nested workflow's pause as a route or a node too.** The route would need the turn runner to find and resume a child walk outside any call, and the node a pause inside one walk carried to another; both are larger than this ticket, and both are refused with a message that says so.
- **Key by `<syndicate>/<subagent>`.** The root's app name is the memory namespace, shared across syndicates by default, and a nested syndicate has no session of its own to prefix; the caller's name is what the stored call already carries.
- **Migrate old sessions to the new key.** It would rewrite stored rows on read; reading the old key in place changes nothing stored.

## Consequences

- `tests/nestedPauses.test.ts` covers approve, reject and `ask_user` on a nested orchestrator, a nested dispatch classifier's gate and the route refusal, a nested workflow's `ask_user` node and gated node (approve, reject, a mismatched decision), the route and node refusals, separate sessions for same-named subagents, an old-key approval resuming, an old-key session continuing, and both pauses over A2A. The parity suites read each subagent's session under its path and still hold ADK's events.
- Code that read a subagent's session by its name alone reads it under the path now; the stored events do not change. A conversation stored under the old key keeps sharing that session across syndicates whose callers share a name.
- Still open: a pause inside a nested workflow run as a route or a node, a pause inside a workflow node's own delegation, and child sessions of workflow routes and nodes, which stay filed under the entry's name.
