---
type: decision
title: "ADR 0068: melchizedek-agents/model exports the model layer with no ADK"
description: "A package entry, melchizedek-agents/model, exports the contract, every adapter and resolveAdapter with no ADK in its import graph, giving Gemini the engine's adapter."
tags:
  - decision
  - models
  - package
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/model.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/models/registry.ts
  - resource: lib/tools/xaiSearchParams.ts
  - resource: tests/packageSurface.test.ts
  - resource: package.json
---

# ADR 0068: melchizedek-agents/model exports the model layer with no ADK

**Decided (2026-10-08):** A package entry, `melchizedek-agents/model` (`lib/model.ts`), exports the contract's types, every contract adapter, `resolveAdapter`, `resolveAdapterWithFallback`, `FallbackAdapter` and the circuit breaker, with no ADK in its runtime import graph; through it a Gemini id gets `GeminiAdapter` and asking for `adk` throws. The routing moved to an ADK-free `adapterResolver.ts`, proven by a package-surface test.

**Instead of:** loading ADK lazily for `adk`, a silent fallback to `GeminiAdapter`, making `./models/registry` ADK-free (then), exporting the adapters from the main barrel

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the whole package is ADK-free and `adk` is refused everywhere)

How it works: [Provider routing](/models/provider-routing.md)
