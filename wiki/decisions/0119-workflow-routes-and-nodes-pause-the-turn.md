---
type: decision
title: "ADR 0119: A nested workflow run as a dispatch route or a workflow node pauses the turn, and its child session is filed under the agent path"
description: "ADR 0111's open items. A nested workflow's ask_user nodes and gated agent nodes are no longer refused as a dispatch route or a workflow node. A route's walk that ends paused stores the route's pause record in the conversation in place of its answer (authored by the route at its own path, no content, the walk's open interrupts); while that record is the conversation's last event, the turn reports the request or question with the path from the route down, a decision or a plain-text answer resumes the route without classifying, and the walk reads the answer as its explicit reply. A node's walk that ends paused raises the walk's open requests again on the caller's walk as one event of the node's, so the caller's walk pauses on the same ids and its own resume reruns the node, which walks its graph again on the answers; deepestPause follows such a request down by id to the node that asked. The child session is filed under entryAppName (<app>/<route>, <walk's app>/<node>); one 1.1.0 filed under the entry's name alone is continued when the entry ran there before. A marker-free route pause, a pause marker for the node, nesting the walk's events inline, keying a route under the classifier's name, and migrating old sessions were rejected."
tags:
  - decision
  - runtime
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/workflow/turn.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/approvals.ts
  - resource: lib/compile.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/workflowChildPauses.test.ts
  - resource: tests/workflowNested.test.ts
  - resource: tests/nestedPauses.test.ts
---

# ADR 0119: A nested workflow run as a dispatch route or a workflow node pauses the turn, and its child session is filed under the agent path

## Context

[ADR 0106](/decisions/0106-nested-workflow-routes-nodes-and-node-skill-scripts.md) runs a `yaml_reference` to a workflow syndicate as its whole graph wherever it appears, on a child session filed under the entry's name. [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md) carried a pause inside a *delegated* nested workflow to the turn through the call its caller leaves open, and filed a delegated subagent's child session under its agent path. It left three things open: a nested workflow's `ask_user` nodes and gates stayed refused at load as a dispatch route or a workflow node, because neither has an open call to carry a pause; `runWorkflowNode` refused a walk that ended paused; and those child sessions stayed filed under the entry's name alone, so a route and a same-named entry of another syndicate on one conversation shared a row.

Two facts set the shape. The walk already pauses and resumes from its own session (ADR 0094, ADR 0098): a node that returns interrupt ids waits, the walk stores its pause record, and the next message's resume (`workflowResume`) reruns the waiting node with the answers, provided the paused run raised an interrupt that carries an input or approval request call (`raisedInterrupt`, `assertResumable`). And a route answers in the conversation itself, outside any walk, so its pause needs a mark the turn can find there.

## Decision

1. **The refusals are lifted.** `loadNestedSyndicate` no longer refuses a nested workflow's gates, and `compileWorkflowSpec` no longer refuses its `ask_user` nodes, wherever it runs. `compileEntrySpec` and `compileWorkflowSpec` keep their `delegated` argument, which no longer changes what compiles.
2. **A child session is filed under the agent path.** A nested workflow run as a route or a node walks on `entryAppName(<app of the session that runs it>, <entry>)`: `<app>/<route>`, `<walk's app>/<node>`, `app/Writer/Inner` two levels down (`lib/runtime/native/delegate.ts`). `entrySession` opens it from the caller's state, `temp:` keys dropped, the first time and keeps it.
3. **Old sessions still resume.** When no session exists under the path, the one filed under the entry's name alone is continued if the entry ran in the caller's session before (an event it authored there) or a pause was found below it; otherwise a new one starts. Nothing stored is rewritten.
4. **A route's pause is a record in the conversation.** A route walk that ends paused stores, in place of the route's answer, the route's pause record: `workflowPauseEvent` authored by the route at its own path, no content, the walk's open interrupt ids in `longRunningToolIds`, the walk's state writes so far. `routePause` (`lib/runtime/native/interrupts.ts`) finds it only while it is the conversation's last event, only for a declared route, and only under an id the route's own walk's pause record names. The turn ends `input-required` with the request or question, its `path` from the route down to the node that asked. While it waits, a decision naming the request, or a plain-text message when it waits on a question, resumes the route without the classifier (`decidedBy: approval | answer`); the conversation stores the message, and the walk reads it as its explicit reply (`adk_request_input` with `{ result }` for a question). Any other message while an approval waits repeats the request and stores and runs nothing, as a workflow turn answers it (ADR 0098).
5. **A node's pause is the node's own.** `runWorkflowNode` (`lib/workflow/turn.ts`) answers a walk that ended paused by raising the walk's open requests again on the caller's walk, as one event of the node's: a copy of each request call, the node's path, the ids in `longRunningToolIds`, the node's input in `agentState`, the walk's state writes so far, as `waitAgain` does for an agent node. The node waits on those ids, the caller's walk ends paused, and its resume reruns the node with the answers: with none of its ids answered (an approval needs a decision) it raises them again without walking; once an earlier resume finished it, its stored output is the node's; otherwise it walks its graph again on the answered ids, each as its explicit reply, which the nested walk's own resume reads.
6. **The turn reports the deepest request.** In a workflow's own session the raised request is found as any is (`pendingApproval`, the drained input requests), and `deepestPause` follows it down by id through each child session to the node that asked, so `result.approval` and `result.input` name that node and carry the path. `delegatedPauses` follows a delegated nested workflow's node the same way. The A2A executor reads a paused route and a raised request the same way, so `approve` and `reject` work and the repeated request carries the path.

## Alternatives considered

- **No record for a route: read every workflow route's child session for a paused walk.** It finds the walk without writing anything, but a turn that routed elsewhere since cannot tell a pause the person moved past from one still waiting, and the A2A executor would load every route's file to know which routes are workflows. The record names the route, and the conversation's order says whether it is still open.
- **A contentless marker for a node too.** `workflowResume` extends a run back over the runs before it only when they raised an interrupt carrying a request call, and refuses an interrupt at a direct child that carries none. Raising the requests again on the node's event satisfies both rules unchanged, and is the shape `waitAgain` already stores for an agent node.
- **Run the nested graph inline, its events in the caller's session (ADK's form).** Rejected by ADR 0106 for the same reasons: the native walk would need ADK's nested-path rehydration.
- **Key a route's walk under the classifier's name (`<app>/<classifier>/<route>`), as a delegated subagent's caller.** A route answers in the conversation itself, not inside the classifier's run, and its paths start at the route, so the route is the first segment after the app.
- **Migrate old rows to the new key.** As in ADR 0111: reading the old key in place changes nothing stored.

## Consequences

- `tests/workflowChildPauses.test.ts` covers, as a route and as a node: the `ask_user` question with its path and the answer completing the walk without reclassifying, approve (once, a non-decision repeating the request, a wrong id failing `NO_PENDING_APPROVAL`) and reject; a gate two levels down below a route, and a question two levels down below a delegated workflow; a 1.1.0 session under the entry's name continuing, and a foreign one under that name left alone; and both pauses over A2A, with `approve`. `tests/workflowNested.test.ts` reads the walks under the agent path, and its ADK parity case still holds the route's sessions and requests equal.
- A paused route's conversation ends on a contentless event authored by the route; the classifier's digest and the route projections skip it, and `pendingApproval` reads it as a pause record whose requests are elsewhere.
- Code that read a route's or node's walk at `{ appName: '<entry>' }` reads it at the path now. A conversation that ran a delegate syndicate whose orchestrator is named as a route, with a subagent named as one of the route's nodes, files both under one key (`<app>/<name>/<inner>`); the old key shared far more.
- Still open: a pause inside a workflow node's own delegation, and an OAuth consent inside a nested walk.
