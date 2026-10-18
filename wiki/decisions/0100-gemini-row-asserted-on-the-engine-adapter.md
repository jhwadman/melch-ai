---
type: decision
title: "ADR 0100: The Gemini matrix row is asserted on the engine's GeminiAdapter, which keeps JSON Schema"
description: "The capability matrix's Gemini row is asserted on the engine's own GeminiAdapter, which keeps JSON Schema; native stores no turnComplete for Gemini; code execution parts are stored as Gemini sent them; GeminiAdapter becomes the default."
tags:
  - decision
  - models
  - gemini
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/capabilities.ts
  - resource: lib/models/geminiAdapter.ts
  - resource: lib/models/adkGeminiAdapter.ts
  - resource: lib/models/genaiMapping.ts
  - resource: lib/models/geminiState.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/runtime/native/selfCorrection.ts
  - resource: tests/capabilityMatrix.test.ts
  - resource: tests/helpers/capabilityInputs.ts
  - resource: tests/geminiTurnParity.test.ts
  - resource: scripts/gemini_engine_check.ts
---

# ADR 0100: The Gemini matrix row is asserted on the engine's GeminiAdapter, which keeps JSON Schema

**Decided (2026-10-08):** Assert every Gemini cell (evidence `test`) on the engine's `GeminiAdapter`, which keeps JSON Schema (`parametersJsonSchema`, `responseJsonSchema`). Native stores no `turnComplete` for a Gemini adapter, code execution parts are stored as Gemini sent them, and `GeminiAdapter` becomes the default for Gemini ids, retiring `AdkGeminiAdapter`.

**Instead of:** converting to Gemini's Schema, writing turnComplete on the ADK path, keeping the wrapper as the default, moving the ADK runtime off TracedGemini, code parts as contract parts of their own, replaying earlier turns' code parts, evidence from the wrapper
**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the wrapper and GEMINI_ADAPTER=adk are removed)
**Open:** live Gemini 3 confirmation of the items the Gemini adapter page lists as confirmed only against documentation

How it works: [Gemini adapter](/models/gemini-adapter.md)
