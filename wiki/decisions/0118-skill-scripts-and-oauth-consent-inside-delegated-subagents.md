---
type: decision
title: "ADR 0118: Skill scripts and OAuth consent inside a delegated subagent pause the turn through the open call"
description: "The last two pauses a delegated subagent could not raise. A skill script run (skills.scripts: local) asks for approval through the same adk_request_confirmation call a gated tool stores, so ADR 0110's walk and resume carry it unchanged; the schema stops refusing it on a delegated subagent (a map node's agent stays refused). An OAuth consent request (adk_request_credential) for an authorization_code grant: runSubagent hands the child its caller's consent step with every flow bound to the caller's app (consentPinnedTo), so the callback stores the grant where the run's pinned credentials read it; delegatedPauses reports the child's open request as a pause with the agent path (PendingConsent.path, and path on the A2A consent_request part); once the grant is stored, the next message becomes the grant's answer in the conversation's session, resumedDelegations carries it down the open call, and the child's grantedCalls runs its paused call again, with ADR 0114's host checks at compile and call time unchanged. Running consent for every subagent before the turn, binding the flow to the child's session, resuming the child from the callback, copying the request into the caller's session, pinning in the turn runner, and an opt-in key for delegated scripts were rejected."
tags:
  - decision
  - runtime
  - tools
  - security
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/credentials.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/syndicateSchema.ts
  - resource: config/agents/templates/systems_operator.yaml
  - resource: tests/delegatedScriptsConsent.test.ts
---

# ADR 0118: Skill scripts and OAuth consent inside a delegated subagent pause the turn through the open call

## Context

[ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md) carries an approval request or an `ask_user` question from a delegated subagent's child loop to the turn, and the answer back down; [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md) carries them through nested syndicates. Two pauses stayed refused on a delegated subagent:

- **Skill scripts.** `run_skill_script` ([ADR 0029](/decisions/0029-skills-read-like-a-harness.md), [ADR 0083](/decisions/0083-skills-harness-on-the-own-tool-base.md)) asks for approval through `ctx.requestConfirmation`, the same `adk_request_confirmation` call a `require_approval` gate stores. The schema still refused `skills.scripts: local` on a delegated subagent.
- **OAuth consent.** An `authorization_code` grant ([ADR 0112](/decisions/0112-oauth-grants-declared-beside-the-tool.md)) reads the user's token through `ctx.accessToken`, and the consent pause ([ADR 0085](/decisions/0085-oauth-consent-pauses-on-adks-credential-request.md)) asks for a missing grant. `runSubagent` gave the child its caller's credentials but no consent step, so a subagent's call answered `not_connected` and could never ask. The systems_operator template's comment sent authorization-code users to a dispatch route instead.

Two facts shape consent below the top. A consent flow is bound to the app, user and session of the run that began it, and the callback stores the grant under that app. A child session is filed under its agent path (`<app>/<caller>/<subagent>`), while the run's credentials are pinned to the turn's app (`pinnedCredentialStore`, [ADR 0072](/decisions/0072-tool-credentials-sealed-per-user.md)). A flow begun with the child's app name would store a grant nobody reads.

The stored Event JSON, the interrupt names, the A2A surface (beyond an additive field) and the `runSyndicateTurn` signature do not change.

## Decision

1. **Skill scripts on a delegated subagent are allowed.** The schema's refusal goes. A script run in a child stores its request in the child session as a gated tool's does; the walk (`delegatedPauses`) finds it, the turn ends `input-required` with `result.approval` and its `path`, and the decision travels down the open call, where the child's `approvedCalls` binds it to the pinned `run_skill_script` call and runs the script once, or refuses it. The script's environment is ADR 0086's, unchanged. Still refused: skill scripts on an agent a map node runs, and on a route of a nested dispatch syndicate or inside a nested workflow run as a route or a node (ADR 0111's refusals, which name gates and scripts together).
2. **A child gets its caller's consent step, bound to the caller's app.** `runChild` passes `consent` with `begin` pinned to the caller's app name (`consentPinnedTo`, `lib/runtime/native/delegate.ts`). A grandchild pins its caller's pinned step again; the first pin is applied last, so every flow below the turn is bound to the turn's app, its user and its session id (the child sessions share the conversation's session id), and `functionCallId` names the child's own paused call.
3. **The child pauses as at the top.** Its call answers `CONSENT_TEXTS.pending`, its `adk_request_credential` call is stored in the child session before the response, and the child run ends paused. Its caller leaves the delegated call open (`SubagentPause`), as for any child pause.
4. **The walk reports it.** `delegatedPauses` takes a child's own open consent request (`pendingConsent`, authored by the subagent) as a pause, with the path. `PendingConsent` gains an optional `path`, set only below the top. `runSyndicateTurn` ends the turn `input-required` with `result.consent`; the A2A `consent_request` data part carries `path` beside its fields when it is set.
5. **The grant's answer travels down.** On the next message, `runSyndicateTurn` looks for the conversation's own open consent, then for one below the open calls. Until the grant is stored, the message repeats the request and runs nothing. Once it is, the message becomes `credentialResponsePart(id, provider)` in the conversation's session; the caller's `grantedCalls` finds no request of its own and runs nothing; `resumedDelegations` matches the answer to the open call by the request's id and `resumeSubagent` stores it as the child's next message; the child's `grantedCalls` binds it (same provider, the child's own request, not bound before) and runs the paused call again, which now reads the grant. A dispatch route that delegates is resumed without classifying, its interrupted turn replayed raw from the open call.
6. **ADR 0114's host checks stay where they were.** A served syndicate's grants are checked at load (subagents and nested files included), its tools at compile, and each call before it sends a token; a resumed child call is a call like any other.

## Alternatives considered

- **Ask for every subagent's grants before the turn runs.** The turn runner would read the subagents' declared providers and pause for each missing grant first. It asks for grants the turn may never use, and a tool that calls `requestCredential` for a provider it picks at run time would still be swallowed.
- **Bind the flow to the child's session and app.** The callback would store the grant under `<app>/<caller>/<subagent>`, which the pinned credential store never reads, and a second subagent of the same provider would ask again.
- **Resume the child from the callback.** The callback is a browser's redirect, not a turn: it has no turn controls, no stream and no caller loop to read the child's answer as the call's response. The person's next message stays the resume, as at the top.
- **Copy the request into the caller's session** so the existing readers find it. The caller's `grantedCalls` would then try to rerun a call it never made; ADR 0110 rejected the same copy for approvals.
- **Pin the consent's app in the turn runner,** as `pinnedCredentialStore` is pinned. It would leave a delegating run that an embedder starts with `runNativeAgent` binding flows to the child's app. Pinning where the child's context is built covers every way a child runs, and a top-level run is bound exactly as before.
- **An opt-in key for delegated skill scripts.** The script run is already behind a per-run approval with the agent path in the request; a second switch adds a place to forget, not a protection.

## Consequences

- `tests/delegatedScriptsConsent.test.ts` covers a script run in a child (approve, reject, two levels deep, over A2A), consent in a child (the pause with its path, a message before the grant repeating it, the grant stored under the turn's app, the resumed call reaching the mock MCP server with the user's own token, no value in any session or log), two levels deep, a dispatch route that delegates, the host check refusing a resumed child call off the allowlist, a stored conversation from before this change continuing, and the A2A `consent_request` part's `path` with the callback route. The schema tests that refused delegated scripts now accept them.
- Conversations stored before this change hold no consent pause below an open call (a child answered `not_connected` instead), so they continue as they were; the walk reads the same child sessions as ADR 0111.
- The systems_operator template's comment says an authorization-code grant works on Systems.
- `PendingConsent.path` is an additive field on an exported type, and `path` an additive field of the `consent_request` part. No exports map or barrel entry changes; the CHANGELOG records it under Unreleased.
- Still open: consent inside a workflow node or a nested workflow (`runAgentNode` refuses it), remote (A2A) subagents' own input-required, and a pause inside a nested workflow run as a route or a node.
