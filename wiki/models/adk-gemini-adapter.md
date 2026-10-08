---
type: model-provider
title: Gemini wrapper over ADK
description: "Retired: AdkGeminiAdapter (lib/models/adkGeminiAdapter.ts) and TracedGemini (lib/models/tracedGemini.ts), the Gemini path through ADK's own Gemini class, were removed in 1.0.0 (ADR 0107). Every Gemini id runs on the engine's GeminiAdapter; GEMINI_ADAPTER=adk is an error naming the release."
tags:
  - models
  - gemini
  - runtime
status: deprecated
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/models/geminiAdapter.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/models/registry.ts
---

# Gemini wrapper over ADK

`AdkGeminiAdapter` (`lib/models/adkGeminiAdapter.ts`), the contract `ModelAdapter` that served Gemini through ADK's own `Gemini` class, was removed in melchizedek-agents 1.0.0, together with `TracedGemini` (`lib/models/tracedGemini.ts`) and the `melchizedek-agents/models/adkGeminiAdapter` and `models/tracedGemini` subpaths ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)).

Every Gemini id runs on the engine's own [Gemini adapter](/models/gemini-adapter.md) (`lib/models/geminiAdapter.ts`) on `@google/genai`. `GEMINI_ADAPTER=engine`, or the `{ gemini: 'engine' }` option, is accepted and changes nothing; `GEMINI_ADAPTER=adk` (or `{ gemini: 'adk' }`) throws at model resolution with an error naming 1.0.0 and the fix: unset it, or set it to `engine` (`lib/models/adapterResolver.ts`, [provider routing](/models/provider-routing.md), [failure modes](/operations/failure-modes.md)).
