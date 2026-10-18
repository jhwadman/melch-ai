---
type: decision
title: "ADR 0046: Provider reasoning state rides on the content part it belongs before"
description: "Provider-opaque reasoning state travels as a providerState field on the part the model produced after it, replayed within the turn only by an adapter of the same provider and, where bound, the same model."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/providerState.ts
  - resource: lib/models/claudeLlm.ts
  - resource: lib/session/transcript.ts
  - resource: tests/reasoningState.test.ts
---

# ADR 0046: Provider reasoning state rides on the content part it belongs before

**Decided (2026-10-07):** Provider-opaque reasoning state rides as a `providerState` field on the content part the model produced after it. Only an adapter of the same provider replays it, and only for the same model where the provider binds it, within the current turn's tool loop. Claude uses it to replay signed thinking blocks.

**Instead of:** a part of its own, event `customMetadata`, an in-process cache keyed by tool call id, replaying every turn's blocks, scoping Claude's state to the provider alone, all blocks at the start of the message

How it works: [Provider routing](/models/provider-routing.md)
