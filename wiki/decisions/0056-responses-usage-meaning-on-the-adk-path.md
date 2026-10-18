---
type: decision
title: "ADR 0056: GptLlm and GrokLlm kept the Responses usage meaning on the ADK path"
description: "On the ADK path, the GPT and Grok shims kept output tokens with reasoning included and the server-side tool record; removed with ADK."
tags:
  - decision
  - models
  - telemetry
status: deprecated
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/gptLlm.ts
  - resource: lib/models/gptAdapter.ts
  - resource: lib/models/adkShim.ts
  - resource: lib/observability/tracer.ts
  - resource: tests/responsesAdapter.test.ts
---

# ADR 0056: GptLlm and GrokLlm kept the Responses usage meaning on the ADK path

**Decided (2026-10-07):** On the ADK path the GPT and Grok shims kept `output_tokens` with reasoning included, the server-side tool calls on `customMetadata`, and (until the owner turned sources on for every provider) no `groundingMetadata`.

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)
