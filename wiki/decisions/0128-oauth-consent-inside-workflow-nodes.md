---
type: decision
title: "ADR 0128: An OAuth consent pause inside a workflow node is an interrupt of the walk, raised again from below under the request's own id, and resumed by the grant's answer"
description: "ADR 0118's and ADR 0120's open item. A workflow node's loop gets the turn's consent step, its flows bound to the turn's app. An agent node's own adk_request_credential call is its interrupt, as an approval request is; a request that waits below a node (a delegated subagent's, a nested walk's, a nested dispatch syndicate's) is raised again on the walk as a copy under the same id. The turn finds the open requests through the walk's pause record (walkConsents), followed down to the agent that asked, and ends input-required with result.consent and the path. A message before every grant is stored repeats the first missing request and stores nothing; after, it becomes the grants' answers, and the walk reruns each waiting node on its input, which continues its run (grantedCalls, or the delegation resume) without re-running completed nodes. grantedCalls reads the latest user event unless the agent has written since. Parallel branches each pause, and one message resumes them all; a map item runs without the consent step and the schema refuses an authorization_code grant on an agent a map runs. A durable run checkpoints at the pause and a restored run stands at the same request. Refusing consent in nodes, asking for every grant before the walk, a marker of its own for a raised request, reading plain text as a grant, and pausing a map item were rejected."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-11
sources:
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/turn.ts
  - resource: lib/workflow/resume.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/credentials.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/compileNative.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/workflowNodeConsent.test.ts
  - resource: tests/workflowResume.test.ts
---

# ADR 0128: An OAuth consent pause inside a workflow node is an interrupt of the walk, raised again from below under the request's own id, and resumed by the grant's answer

## Context

The consent pause ([ADR 0085](/decisions/0085-oauth-consent-pauses-on-adks-credential-request.md)) stops a call whose `authorization_code` grant ([ADR 0112](/decisions/0112-oauth-grants-declared-beside-the-tool.md)) the person has not given: the loop stores ADK's `adk_request_credential` call, the turn ends `input-required` with `result.consent`, the server's callback stores the grant, and the person's next message runs the paused call again. [ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md) carried it through delegated subagents and [ADR 0120](/decisions/0120-nested-dispatch-syndicates-route-as-at-the-top.md) through nested dispatch syndicates. [ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md) made approvals and questions pause inside workflow routes and nodes. Consent inside a workflow node stayed open:

- the walk gave its node agents no consent step, so a node's call answered `not_connected` and could never ask;
- `runAgentNode` refused any pause but an approval, so a subagent under a node that asked failed the node;
- `workflowResume` refused a credential request inside an agent node (`UnsupportedWorkflowResumeError`);
- a node that is a nested dispatch syndicate failed on its routes' consent pause (ADR 0120 decision 3), since no request call stood for it on the walk.

The walk already pauses and resumes on its own interrupts (ADR 0094, ADR 0098): a node that returns interrupt ids waits, the walk stores its pause record naming them, and the next message's resume reruns the node with the answers it carries, by id. ADR 0119 raises a nested walk's open requests again on the caller's walk, under their own ids, so every level waits on the same id. The stored Event JSON, the interrupt names, the A2A surface and the `runSyndicateTurn` signature do not change.

## Decision

1. **A node's loop gets the consent step.** `runSyndicateTurn` passes it to every walk (`NativeWorkflowParams.consent`), pinned to the app the turn reads grants under (`consentPinnedTo`), whichever session the walk writes (a route's walk is filed under `<app>/route:<route>`). A nested walk gets it pinned to the app of the walk that runs it, a delegated nested workflow to its caller's (`WorkflowSubagentRun.consent`), and a delegated subagent under a node to its node's (ADR 0118's pin), so every flow below the turn stores its grant under the turn's app.
2. **An agent node's own request is its interrupt.** The loop stores the `adk_request_credential` call as the node's event (stamped, its id in `longRunningToolIds`, the node's input recorded) and ends paused on it. `runAgentNode` returns that id, as it returns an approval request's, and the walk's pause record names it.
3. **A request from below is raised again under its own id.** When the node's agent left a delegated call open and its child waits for a grant, `runAgentNode` finds the request below the open call (`delegatedPauses`) and stores a copy of it on one event of the node's (`credentialRequestCall`, the shape `consentFrom` reads, nothing more than the stored request carries). A node that is a nested workflow raises its walk's request again (`raiseAgain`, `RAISED` now holds the credential request); a node that is a nested dispatch syndicate raises one rebuilt from its turn's `result.consent` (`requestCallOf`). An approval or a question inside a node's own delegation is still refused by name.
4. **The turn finds it through the pause record.** `walkConsents` (`lib/runtime/native/interrupts.ts`) reads the credential requests among the ids the walk's pause record names and follows each down to the agent that asked: a node's own request comes back with no `path` (as a node's own approval does), one raised from below with the path from the node down (`consentBelow`: the node's child session, then the calls it left open). `workflowPause` reads a credential request as it reads an approval or a question, so a walk nested below a route, a node or a delegated call is followed the same way, and `routePause`, `pauseBelow` and `nestedWorkflowPause` carry `consent`. The turn ends `input-required` with `result.consent`.
5. **Before the grant, nothing; after, the grants' answers.** While a walk waits, `runSyndicateTurn` checks each open request's grant in the store before anything runs. Until every one is stored, the message repeats the first missing request and stores nothing. Once they are, the message becomes their answers (`credentialResponsePart`, `{ credentialKey, granted: true }`), and the walk's resume reruns each waiting node on its recorded input. A workflow route waiting below its pause record resumes without classifying (`decidedBy: consent`), its walk reading the grant's answer.
6. **The rerun continues, never restarts.** A node whose answer is a grant's (`isGrantAnswer`; plain text never is) continues its own run with no input turn: the loop's auth preprocessor (`grantedCalls`) runs the paused call again with the token, or the delegation resume (`resumedDelegations`) carries the answer down the open call, or the nested walk or nested turn reads it as its message. Without one it waits again, its request raised again (`waitAgain`). Completed nodes complete from their stored output. `workflowResume` accepts a credential request at an agent node when the engine can read it (a paused call's id and an auth config).
7. **The answer is found among other nodes' events.** `grantedCalls` reads the latest user event unless the agent has stored anything with content since. At the top that is the last event with content, as before; in a walk, another node's events (a parallel branch waiting again) may be stored between the answer and the node's resume.
8. **Parallel branches pause; map items do not.** Each branch's node pauses on its own request and the others run on; the join waits. One message after the grant answers every open request, so two branches waiting on one provider resume together. A map item runs without the consent step (`agentNodeRuntime`), so a missing grant is its tool's error; the schema refuses an `authorization_code` grant (`mcp_auth`, `mcp_servers[].auth`, `openapi[].auth`) on an agent a map node runs, by name, as it refuses gates and skill scripts there.
9. **Durable runs.** A durable run ([ADR 0113](/decisions/0113-durable-runs-checkpoint-the-sessions-beside-the-job.md), [ADR 0121](/decisions/0121-checkpoint-cap-and-dispatch-route-resume.md)) checkpoints at the pause: the consent call's response is a step boundary. A run restored from that checkpoint reruns the waiting node on its job message, which is no grant's answer, so the node waits again on the same request and the run ends at the same pause without a model call or a new flow.

## Alternatives considered

- **Keep refusing consent in a node.** The person whose node needs their own token has no way through but moving the agent to a route or a subagent, which changes the team's shape for a runtime gap.
- **Ask for every grant a walk's nodes declare before the walk starts.** It asks for grants the walk may never use (a route step may skip the node), and a tool that picks its provider at run time would still be missed.
- **A marker of the walk's own for a raised request, read by the turn.** `workflowResume` extends a run back over the runs before it only when they raised an interrupt carrying a request call, and refuses an interrupt that carries none. A copy of the request satisfies both rules unchanged, and is the shape ADR 0119 already stores for approvals and questions.
- **Read a plain-text message as the grant once the store holds one, inside the node.** The node would have to read the credential store itself and build an answer the loop's preprocessor binds to, moving the turn's decision (has the person granted?) into the walk. The turn already checks the store before anything runs, and a grant's answer is the one thing the walk resumes on, so a message that is not one never moves the walk.
- **Pause one map item.** A map's items run as one node; the walk resumes a paused node, not an item of it (ADR 0094). Refusing the grant at load says so before any model call.
- **Answer only the first open request per message.** Two parallel branches waiting on one provider would need a message each after a single grant. Answering every open request once all are stored costs one store read per request.

## Consequences

- `tests/workflowNodeConsent.test.ts` covers, over `runSyndicateTurn` with a mock OAuth provider and MCP server on a local port: an agent node (the pause, the request in the walk's session, a message before the grant storing nothing, the grant stored under the turn's app, the resumed call with the user's own token, completed nodes not run again, no value in a session or a log line), a subagent under a node (`['Team', 'Ops']`), a nested dispatch node (no reclassification), a nested workflow node, parallel branches (one and two waiting), a delegated nested workflow (`['Boss', 'Writer', 'Ops']`), a workflow route (`decidedBy: consent`), the map refusal, and a durable run restored at the pause. `tests/workflowResume.test.ts` resumes a readable credential request at an agent node and still refuses one inside a map item; `tests/workflow.test.ts` still refuses an unreadable one.
- A session ADK or an earlier version stored with an unreadable credential request inside an agent node is still refused `RESUME_UNSUPPORTED`; a readable one now resumes.
- No exported type, exports-map entry or barrel entry changes; `credentialRequestCall` and `isGrantAnswer` are internal to `lib/runtime/credentials.ts`. `WorkflowSubagentRun.consent` and `NativeWorkflowParams.consent` are additive optional fields on internal interfaces.
- Still open: an approval or a question inside a workflow node's own delegation; a tool node that needs a grant (tool nodes get no consent step, and fail as a call without a grant fails); a durable run cannot be resumed by a grant, since a job runs on its one message.
