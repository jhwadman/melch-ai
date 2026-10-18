---
type: decision
title: "ADR 0044: An agent may name a fallback model; a failing provider is skipped for a cooldown"
description: "fallback_model answers a provider-side failure that happens before any output, and a per-provider circuit breaker sends wrapped agents straight to their fallback during an outage; opt-in per agent."
tags:
  - decision
  - models
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/fallback.ts
  - resource: lib/compile.ts
  - resource: tests/fallback.test.ts
---

# ADR 0044: An agent may name a fallback model; a failing provider is skipped for a cooldown

**Decided (2026-10-06):** An agent may name a `fallback_model` that answers a provider-side failure occurring before any output. A per-provider circuit breaker sends such agents straight to their fallback for a cooldown during an outage. Both are opt-in per agent.

**Instead of:** wrapping every agent's model, a fallback inside each adapter, falling back mid-stream

How it works: [Provider routing](/models/provider-routing.md)
