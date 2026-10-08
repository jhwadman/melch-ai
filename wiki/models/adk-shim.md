---
type: subsystem
title: ADK shim
description: "Retired: AdkShim (lib/models/adkShim.ts) and the ADK model classes behind it (ClaudeLlm, GptLlm, GrokLlm, KimiLlm, OllamaLlm, GatewayLlm, OpenAiCompatibleLlm, FallbackLlm) were removed in 1.0.0 with the adk runtime they served (ADR 0107). Every model adapter is called directly by the native loop on the engine's model contract."
tags:
  - models
  - runtime
  - contracts
status: deprecated
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/models/contract.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/compileNative.ts
---

# ADK shim

`AdkShim` (`lib/models/adkShim.ts`), the ADK `BaseLlm` that ran a contract `ModelAdapter` on the adk runtime, was removed in melchizedek-agents 1.0.0 together with that runtime and the ADK model classes built on it: `ClaudeLlm`, `GptLlm`, `GrokLlm`, `KimiLlm`, `OllamaLlm`, `GatewayLlm`, `OpenAiCompatibleLlm` and `FallbackLlm` ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)). The `melchizedek-agents/models/*` subpaths for those files are gone.

## What serves the same role

- The [native loop](/overview/native-loop.md)'s model step calls each adapter directly with a `ModelRequest` on the engine's [model contract](/models/model-contract.md), and charges and traces the call through `traceLlmGeneration` (`lib/observability/tracer.ts`) under one `llm.request` span ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)).
- A fallback pair is a `FallbackAdapter` (`lib/models/fallbackAdapter.ts`, [ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)).
- The adapters themselves: [Claude](/models/claude-adapter.md), [Gemini](/models/gemini-adapter.md), [GPT and Grok](/models/responses-adapters.md) and the [chat-completions adapters](/models/chat-completions-adapters.md) (Ollama, Kimi, the gateways).
- A caller's `resolveModel` returns a model id or a `ModelAdapter` (`melchizedek-agents/model`). An ADK model class returned from it is refused before any model call with `UnsupportedOnRuntimeError` ([failure modes](/operations/failure-modes.md)).
