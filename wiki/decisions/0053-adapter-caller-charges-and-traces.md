---
type: decision
title: "ADR 0053: The caller of a model adapter charges the turn and opens its span"
description: "A contract adapter never charges the turn's budget or opens the llm.request span; the code that calls it does, once per leaf adapter."
tags:
  - decision
  - models
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/adkShim.ts
  - resource: tests/adkShim.test.ts
  - resource: tests/syndicateTurn.test.ts
  - resource: lib/observability/tracer.ts
  - resource: lib/runtime/turnControl.ts
---

# ADR 0053: The caller of a model adapter charges the turn and opens its span

**Decided (2026-10-07):** A `ModelAdapter` never charges the turn's step budget or opens the `llm.request` span; it honours `request.signal` and only decorates the open span. Whatever calls it charges and traces, once per leaf adapter, so a fallback is two charges and two spans. Until 1.0.0 that caller was the ADK shim; now it is the native loop's model step.

**Instead of:** each adapter charging and tracing inside `generate()`, migrated adapters keeping their own `traceLlmGeneration` call

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the ADK shim removed)

**Open:** a tracing `ModelAdapter` decorator for callers outside the native loop (deferred)

How it works: [Native loop](/overview/native-loop.md)
