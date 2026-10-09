---
type: decision
title: "ADR 0120: A nested dispatch syndicate classifies and routes as at the top, as a turn of its own, and a child session's key carries its kind"
description: "A yaml_reference to a plan-dispatch syndicate no longer compiles to its classifier alone. compileEntrySpec returns a DispatchSpec, and the turn runner runs it as a turn of its own on its own conversation (runNestedDispatch, reached below the runner through TurnControl.nestedDispatch), under the turn's controls, unstreamed, with no guards of its own and grants under the root's app. Its caller sees the route's final text, never the classifier's JSON, whether it runs as a delegated call, a dispatch route or a workflow node. Approvals, ask_user questions and OAuth consent on its routes, and inside a route's own delegation, reach the turn with the path; the pause walk finds them in its conversation as the turn finds them at the top (conversationPause). ADR 0111's refusal of gates on a nested dispatch syndicate's routes is lifted. A route's or a node's child session is filed under <app>/route:<route> and <walk's app>/node:<node>, so it never shares a key with a delegated call's (<app>/<caller>/<sub>); the ADR 0119 key and the 1.1.0 key are still continued. A synthesized workflow graph, recursion through the public runSyndicateTurn, a stored marker for the walker, a kind segment of its own, prefixed delegation keys and migrating rows were rejected."
tags:
  - decision
  - runtime
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/compile.ts
  - resource: lib/compileNative.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/turnControl.ts
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/workflow/turn.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/nestedDispatch.test.ts
  - resource: tests/delegatedScriptsConsent.test.ts
  - resource: tests/workflowChildPauses.test.ts
  - resource: tests/workflowNested.test.ts
---

# ADR 0120: A nested dispatch syndicate classifies and routes as at the top, as a turn of its own, and a child session's key carries its kind

## Context

A `yaml_reference` to a plan-dispatch syndicate compiled to its classifier alone: `compileSpec` lists no route on a dispatch orchestrator, so the nested syndicate answered its caller with the classifier's routing JSON and its routes never ran. [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md) recorded that as decision 2 and refused a gate or skill scripts on such a route at load, since it would never run. A team that nests a triage syndicate under a delegate orchestrator, behind another dispatch syndicate's route, or as a workflow node, gets the verdict instead of the specialist's answer.

A dispatch turn at the top is more than one agent: the classifier runs in a throwaway lane over a transcript digest, `route_overrides` and `default_route` resolve the route, the route answers on the shared conversation through the projection, and a pause on a route is resumed without classifying. That logic lives in the turn runner (`lib/runtime/syndicateTurn.ts`), above the code that runs a delegated call, a route or a node, which cannot import it.

[ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md) filed a route's or a node's child session under `<app>/<entry>`. A delegated call's is filed under `<app>/<caller>/<sub>` (ADR 0111). Both are names joined by `/`, so a delegate orchestrator `X` calling `Y` and a route `X` whose nested workflow has a node `Y` both filed at `app/X/Y`.

## Decision

1. **A nested dispatch syndicate compiles to a `DispatchSpec`.** `compileEntrySpec` (`lib/compile.ts`) returns `{ kind: 'dispatch', dispatch }`: the entry's name and description, the loaded file, its `ref`, and the compile options its routes load with, its nesting chain extended. `SpecTool` and `EntrySpec` gain the variant, `WorkflowSpec` lists such nodes in `dispatches`, and `compileSubagentSpec` refuses a dispatch reference by name. Its routes compile when its turn routes to one, as at the top. When the entry compiles, the references below it are followed (loaded, not compiled: no tool is resolved, no MCP server is reached), so a cycle or a chain past 16 levels is refused by name before any model call; a route carrying the entry's own name is refused, since the pause walk tells the entry from its routes by name. A `map` node may not run one.
2. **It runs as a turn of its own.** `runNestedDispatch` (`lib/runtime/syndicateTurn.ts`) calls the turn runner's inner function with the nested config on the child session the caller opened (its key as the app name), the turn's store, memory, credentials and log, and the turn's `TurnControl`: one step budget, one signal, one deadline. It is never streamed and runs no guards (the turn at the top lists a nested syndicate's guards through `collectGuards`). Grants are read and stored under the root's app, the consent step pinned there with `consentPinnedTo`, as [ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md) does for a subagent. The runner sets `control.nestedDispatch` (`lib/runtime/turnControl.ts`, `NestedDispatchRun`, `NestedDispatchEnd`), which the code below it reads; `nestedDispatchWalk` (`lib/runtime/native/delegate.ts`) wraps it as a walk that yields one unstored event with the answer's text and the state writes, or ends with the interrupt id and, for a workflow node, the request call to raise again. `dispatchSubagentOf` (`lib/compileNative.ts`) makes it a `WorkflowSubagent` for a delegated call and a `NestedRun` for a workflow node.
3. **Its caller sees the route's answer.** Wherever it runs, the caller reads the nested turn's final text, as a delegated subagent returns its final text, and its state writes are recorded on the caller's call response, route event or node event. The classifier's JSON never enters a conversation: it runs in its throwaway lane, as at the top.
   - **Delegated**, the child session is the delegation key `<app>/<caller>/<entry>`; a pause leaves the call open (`SubagentPause`) and `resumeWorkflowSubagent` runs the nested turn again on the answer.
   - **As a dispatch route** (`runDispatchRoute`), the child session is `<app>/route:<route>` (`entrySession`). The conversation stores the user message and either the route's answer event or, when the nested turn pauses, the route's pause record (`workflowPauseEvent`, as for a workflow route under ADR 0119) naming the one interrupt. The next message resumes it without classifying: a decision as `decidedBy: approval`, a plain-text answer as `answer`, any message once the grant is stored as `consent`. A message before the grant repeats the consent request and stores nothing; a non-decision while an approval waits repeats it.
   - **As a workflow node**, the node raises the request again on the caller's walk (`raiseAgain`), from a reconstructed approval request or `adk_request_input` call, since the real request may sit in a delegation below the nested conversation. A consent request cannot be raised by a walk, and fails the node with a message.
4. **Its pauses reach the turn.** An approval, an `ask_user` question or an OAuth consent on one of its routes, or inside a route's own delegation, ends the turn `input-required` with the path from the turn's agent down, e.g. `['Boss', 'Team', 'Ops']`, `['Boss', 'Team', 'Ops', 'Mailer']`, or `['Team', 'Ops']` when it is a route. `conversationPause` (`lib/runtime/native/interrupts.ts`) finds what a nested dispatch conversation waits on as the turn finds it at the top: a route's pause record (`routePause`, followed down), a route's open approval, question or consent request, else a pause inside a call a route left open, filed `<conversation>/<route>/<sub>`. `pauseBelow` falls to it when a subagent's own checks find nothing (the delegated recursion follows only the subagent's own calls), and `nestedWorkflowPause` falls to it when the child session is not a walk. `NestedWorkflowPause` carries `consent`. The A2A executor uses the same walker, so `approve` and `reject` work over A2A.
5. **A route's or a node's key carries its kind.** `entryAppName(parent, name, kind)` gives `<app>/route:<route>` and `<walk's app>/node:<node>`. Delegation keys stay names only: `<app>/<caller>/<sub>`, and `<parent>/<sub>` below a delegated one (`childAppName` no longer calls `entryAppName`). Agent names are identifiers, without `:`, so a delegation key never equals a route's or a node's: `X` calling `Y` files `app/X/Y`, a route `X` with a nested node `Y` files `app/route:X/node:Y`.
6. **Old sessions still resume.** When no session exists under the kind key, `legacyEntry` continues the ADR 0119 key `<app>/<entry>`, then the 1.1.0 key (the entry's name alone), when the entry ran in the caller's session before or a pause was found below it: the rule of ADR 0111 and ADR 0119. Nothing stored is rewritten.

## Alternatives considered

- **Compile the nested dispatch syndicate into a synthesized workflow graph** (a classifier node routing to agent nodes). The walk already pauses and resumes, but its routing is not dispatch's: `route_overrides`, the `default_route` fallback on bad JSON and the transcript digest would all need reimplementing on the graph, and the result would inherit the walk's open gaps (no pause inside a node's own delegation, no consent).
- **Recurse through the public `runSyndicateTurn`.** It creates a new `TurnControl`, so a nested turn would get a step budget of its own, its own guards and trace, and its own memory pins. Calling the inner function under the same control keeps one budget, one deadline and one set of guards.
- **A stored marker in the nested conversation for the walker.** It would let the walker find a pause without re-reading the nested turn's rules, but the nested turn's own resume reads the conversation's last event, and a marker there would stop it finding the request it waits on.
- **A kind segment of its own, `<app>/route/X`.** `route` and `node` are valid agent names, so `app/route/X` can be a delegate orchestrator `route` calling `X`. A `:` cannot occur in a name.
- **Prefix delegation keys too.** Unnecessary once routes and nodes carry a kind, and it would orphan every session filed under the ADR 0111 and 1.1.0 delegation keys.
- **Migrate stored rows to the new keys.** Rejected as in ADR 0111 and ADR 0119: reading the old key in place changes nothing stored.

## Consequences

- A nested dispatch syndicate's answer is its route's text, not the classifier's JSON: a consumer whose prompts or parsing relied on the verdict sees a different answer.
- `tests/nestedDispatch.test.ts` covers delegated (completes and continues its conversation; a gate approved, a wrong id, rejected; `ask_user`; a gate inside a route's delegation, filed `app/Boss/Team/Ops/Mailer`), as a route (completes; a gate approved and repeated; `ask_user`), as a node (completes; a gate; `ask_user`), the load refusals, the keys, and a gate approved over A2A. `tests/delegatedScriptsConsent.test.ts` covers consent inside a nested dispatch syndicate delegated to and as a route, the grant stored under the root's app. `tests/workflowChildPauses.test.ts` and `tests/workflowNested.test.ts` read the kind keys, and the former continues sessions filed under the ADR 0119 key.
- Code that read a route's or node's walk at `<app>/<entry>` reads it at `<app>/route:<entry>` or `<app>/node:<entry>`.
- Still open: a consent pause inside a nested walk (a workflow node that is a nested dispatch syndicate fails on one), and a pause inside a workflow node's own delegation. A remote (`a2a_agent_url`) route inside a nested dispatch syndicate uses the remote conversation id derived from the session id and the route's name, which it shares with a same-named remote route at the top.
