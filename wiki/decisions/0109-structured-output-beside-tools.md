---
type: decision
title: "ADR 0109: An output schema beside tools uses the provider's field where supported"
description: "An orchestrator may hold an output schema beside its tools; the schema travels in the provider's structured-output field where the capability matrix says the model and its fallback take both, and as set_model_response elsewhere."
tags:
  - decision
  - models
  - runtime
  - orchestration
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/capabilities.ts
  - resource: lib/runtime/native/request.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/dispatch.ts
  - resource: tests/capabilityMatrix.test.ts
  - resource: tests/structuredOrchestrator.test.ts
  - resource: tests/fixtures/structured-critic.yaml
---

# ADR 0109: An output schema beside tools uses the provider's field where supported

**Decided (2026-10-09):** Allow an `outputSchema` on an agent that calls tools or delegates. The matrix gains `structured_output_with_tools`, and the request builder sends the schema in the provider's own field beside the tools where that cell is supported for the model and its `fallback_model`, else declares `set_model_response`. Plan-dispatch stays, as a choice.

**Instead of:** refusing the schema on a delegating orchestrator, set_model_response on every path, the native field wherever a provider accepts the request, deciding per adapter at request time
**Open:** xAI, Moonshot and the Gemini API stay degraded until a live check moves their cells

How it works: [Native loop: the request](/overview/native-loop.md#the-request)
