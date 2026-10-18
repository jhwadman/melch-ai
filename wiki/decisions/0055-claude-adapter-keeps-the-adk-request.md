---
type: decision
title: "ADR 0055: Claude moves onto the contract; tool results keep the stored JSON shape"
description: "ClaudeAdapter implements the model contract, and a tool result is serialized in the shape the stored event holds so both runtimes send the same bytes."
tags:
  - decision
  - models
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/claudeAdapter.ts
  - resource: lib/models/claudeLlm.ts
  - resource: lib/models/claudeModels.ts
  - resource: lib/models/adkShim.ts
  - resource: tests/claudeAdapter.test.ts
  - resource: tests/claudeCurrentApi.test.ts
---

# ADR 0055: Claude moves onto the contract; tool results keep the stored JSON shape

**Decided (2026-10-07):** Claude's translation moved into `ClaudeAdapter` on the model contract, and a `tool_result`'s content is the JSON of the result in the shape the stored event holds (the object, `{ result }`, or `{ error }` with `is_error`), so a bound thinking block sees the same bytes on either runtime. Until 1.0.0 the `ClaudeLlm` shim carried the older `generateContentConfig` reading as `claudeReasoning` through a `toModelRequest` hook.

**Instead of:** reading the contract's `reasoning` on the ADK path, adding `xhigh`/`max` to `ReasoningSetting` (then), a provider-options bag, a second translation in `ClaudeLlm`, serializing the contract's plain value

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (`ClaudeLlm`, the shim hook and `claudeReasoning` removed); [ADR 0117](/decisions/0117-tool-choice-and-effort-above-high-in-v2.md) (`xhigh` and `max` became contract levels)

**Open:** `web_search_20250305` on every model; `pause_turn` ends the call; no `cache_control`

How it works: [Claude adapter](/models/claude-adapter.md)
