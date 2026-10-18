---
type: decision
title: "ADR 0060: The engine resolves its own adapters from the prefix table"
description: "resolveAdapter returns a contract adapter for any model id from the one prefix table, with the same gateway rule, endpoint merge and BYOK scoping as the old path."
tags:
  - decision
  - models
  - runtime
  - routing
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/registry.ts
  - resource: lib/models/tracedGemini.ts
  - resource: lib/models/adkGeminiAdapter.ts
  - resource: lib/models/fallbackAdapter.ts
  - resource: tests/resolveAdapter.test.ts
---

# ADR 0060: The engine resolves its own adapters from the prefix table

**Decided (2026-10-07):** `resolveAdapter` returns the contract adapter for any model id from the one prefix table, through one routing step shared with `resolveModel`, so keys, endpoints and the gateway rule land the same everywhere. A caller's key stays scoped to its own provider, including for a fallback on another provider. Gemini stayed on the ADK wrapper by default until gate G3, selectable by `GEMINI_ADAPTER`.

**Instead of:** deriving the ADK path from `resolveAdapter`, an unscoped BYOK key, `GeminiAdapter` by default before G3, an option without an environment variable

**Superseded by:** [ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md) (Gemini defaults to `GeminiAdapter`); [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the ADK path and `GEMINI_ADAPTER=adk` removed)

How it works: [Provider routing](/models/provider-routing.md)
