---
type: decision
title: "ADR 0050: Responses adapters replay encrypted reasoning and store nothing with the vendor"
description: "GPT and Grok reasoning ids send store false, ask for encrypted reasoning items, and replay them within the turn's tool loop for the same provider and model."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/gptLlm.ts
  - resource: lib/models/grokLlm.ts
  - resource: lib/models/providerState.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/responsesReasoningState.test.ts
---

# ADR 0050: Responses adapters replay encrypted reasoning and store nothing with the vendor

**Decided (2026-10-07):** For reasoning ids, GPT and Grok requests send `store: false` with `include: ['reasoning.encrypted_content']`, carry each run of reasoning items on the part after it, and replay them before that part within the current turn's tool loop for the same provider and model only; a 400 is retried once without the reasoning additions, keeping `store: false`.

**Instead of:** `previous_response_id` with `store: true`, default storage with items sent by id, replaying server-side tool call items, leaving Grok degraded

How it works: [Responses adapters](/models/responses-adapters.md)
