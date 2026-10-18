---
type: decision
title: "ADR 0085: OAuth consent pauses on ADK's credential request; a server callback completes it"
description: "An ungranted provider pauses the turn on ADK's own adk_request_credential shape without secrets, and a server-side callback route completes the PKCE flow into the sealed store."
tags:
  - decision
  - tools
  - security
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/oauthConsent.ts
  - resource: lib/runtime/credentials.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/app.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/tools/tool.ts
  - resource: tests/oauthConsent.test.ts
---

# ADR 0085: OAuth consent pauses on ADK's credential request; a server callback completes it

**Decided (2026-10-08):** A call whose provider the user has not granted pauses on ADK's `adk_request_credential` event, its AuthConfig stripped of client secret and PKCE verifier. A callback route on the A2A server completes the authorization-code flow with PKCE S256 server-side (single-use, expiring, user-bound state; caller identity required by default) into the sealed credential store, and the next message resumes the paused call once.

**Instead of:** a new interrupt name, ADK's in-message code exchange with secrets in the event, the client carrying the code back, a consent tool the model calls, a durable pending-flow table now, resuming on callback without a message

**Superseded by:** [ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md) (consent inside delegated subagents), [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the ADK-runtime refusal, removed with ADK)

**Open:** shared `ConsentStates` (multi-instance needs sticky routing); a code-via-client flow for browsers without identity

How it works: [Tool contracts](/tools/tool-contracts.md)
