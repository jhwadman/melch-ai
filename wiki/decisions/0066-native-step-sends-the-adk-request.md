---
type: decision
title: "ADR 0066: The native step sends the ADK runtime's request and stores ADK's event"
description: "One native model step builds the request ADK's LlmAgent built, charges and traces as the shim did, stores the event ADK stored, and records nothing for a stopped turn."
tags:
  - decision
  - runtime
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/request.ts
  - resource: lib/runtime/native/history.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/models/genaiMapping.ts
  - resource: tests/nativeStep.test.ts
---

# ADR 0066: The native step sends the ADK runtime's request and stores ADK's event

**Decided (2026-10-08):** One native model step builds the exact request the ADK runtime sent (identity lines, placeholders, tool instructions, ADK's history projection, `set_model_response`, server-side tools where ADK sent them), charges and traces through the existing tracer, and stores the event ADK stored. A stopped turn makes no call and no event. The agent keeps the YAML's `generateContentConfig` spelling.

**Instead of:** a request built from the contract's ideal, a contract-native tracer, an event built from the `ModelResponse` directly, a stored refusal event, contract-shaped settings on the agent

**Superseded by:** [ADR 0109](/decisions/0109-structured-output-beside-tools.md) (a schema beside tools goes in the provider's field where supported)

How it works: [Native loop](/overview/native-loop.md)
