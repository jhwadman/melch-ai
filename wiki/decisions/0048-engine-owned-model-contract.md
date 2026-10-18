---
type: decision
title: "ADR 0048: The engine owns its model message format, not genai Content"
description: "Every model adapter implements one engine-owned, dependency-free contract of messages, parts, requests and responses; genai Content survives only as a mapping for stored sessions."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/contract.ts
  - resource: lib/loadSyndicate.ts
  - resource: tests/modelContract.test.ts
---

# ADR 0048: The engine owns its model message format, not genai Content

**Decided (2026-10-07):** Every model adapter implements one engine-owned contract (`lib/models/contract.ts`): a types-only leaf with no `@google/*` in its import graph, lowercase JSON Schema as its one schema dialect, server-side tools by name, failures as responses, and the reasoning key mapped by each adapter. `@google/genai` `Content` remains only as a one-to-one mapping for the stored sessions.

**Instead of:** keeping genai `Content` as the internal format, the Vercel AI SDK's provider types, one vendor's SDK types, LangChain's message classes, a free-form `providerOptions` bag

**Superseded by:** [ADR 0061](/decisions/0061-json-mode-on-the-contract.md) (JSON mode joins the contract); [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the ADK path that also kept `Content` is gone)

How it works: [Model contract](/models/model-contract.md)
