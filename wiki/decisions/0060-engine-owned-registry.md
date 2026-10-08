---
type: decision
title: "ADR 0060: The engine resolves its own adapters from the prefix table; Gemini stays on the ADK wrapper until gate G3"
description: "resolveAdapter returns a contract ModelAdapter for any model id from the one prefix table, with the same gateway rule, BYOK scoping and endpoint merge as resolveModel, through one routing step and a table per path. A Gemini id gets AdkGeminiAdapter, and GeminiAdapter only when GEMINI_ADAPTER=engine or an option asks. The ADK path keeps registering the providers' own classes. A shim-derived ADK path, an unscoped BYOK key, and GeminiAdapter by default were rejected."
tags:
  - decision
  - models
  - runtime
  - routing
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/registry.ts
  - resource: lib/models/tracedGemini.ts
  - resource: lib/models/adkGeminiAdapter.ts
  - resource: lib/models/fallbackAdapter.ts
  - resource: tests/resolveAdapter.test.ts
---

# ADR 0060: The engine resolves its own adapters from the prefix table; Gemini stays on the ADK wrapper until gate G3

## Context

The native loop ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)) calls `ModelAdapter`s on the engine's contract ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)), and every provider now has one: `ClaudeAdapter`, `GptAdapter`, `GrokAdapter`, the chat-completions three, and two for Gemini, the engine's own `GeminiAdapter` and the temporary `AdkGeminiAdapter` over ADK's Gemini. Nothing resolved a model id to one of them. The only resolution was ADK's: `registerAvailableProviders()` fills ADK's `LLMRegistry`, and `resolveModel()` builds an ADK `BaseLlm` per request for BYOK and endpoint injection ([ADR 0023](/decisions/0023-bring-your-own-endpoint.md)).

`TracedGemini` lived in `lib/models/registry.ts`, and `AdkGeminiAdapter` imports it, so the registry could not build that adapter without an import cycle.

## Decision

1. **`resolveAdapter(modelId, options)`** in `lib/models/registry.ts` returns the contract adapter for any id, with no `LLMRegistry`. It and `resolveModel` share one routing step (`routeFor`: the provider from `lib/models/providerMap.ts`, the caller's endpoint merged over the environment's, the transport from `planTransport`), and each has one table keyed by provider. So a key and an endpoint reach the same place on both paths, and a gateway stands in only when the direct key is absent and no caller key or endpoint is given.
2. **BYOK stays scoped to the key's provider.** `apiKey` authenticates `keyProvider`'s models only, defaulting to the model's own provider. `resolveAdapterWithFallback` keeps the key with the primary's provider, so a fallback on another provider resolves from server env.
3. **Gemini: `AdkGeminiAdapter` by default until gate G3.** `GeminiAdapter` is selected by `GEMINI_ADAPTER=engine` or by the option `{ gemini: 'engine' }`, which wins over the variable. `GEMINI_ADAPTER` takes `adk` or `engine`; anything else fails a Gemini id's resolution only.
4. **The ADK path is unchanged.** `registerAvailableProviders()` registers the providers' own exported classes under their own patterns, and `resolveModel()` builds them. The compiler's fallback pair stays `FallbackLlm(shim(primary), shim(fallback))` ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)). `resolveAdapterWithFallback` builds the contract's `FallbackAdapter` for the native path, and nothing calls it yet.
5. **`TracedGemini` moves to `lib/models/tracedGemini.ts`.** `registry.ts` re-exports it.

## Alternatives considered

- **Derive the ADK path from `resolveAdapter`** by registering `adkShimClass(patterns, resolveAdapter)` for each provider. One table instead of two, but a bare shim maps responses in Gemini's usage meaning: `GptLlm` and the chat-completions shims override `toLlmResponse` (and `ClaudeLlm` and the chat shims `toModelRequest`) to keep what the ledger and the agents' older spelling rely on ([ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md), [ADR 0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md)). The ledger's output counts would drop by the reasoning.
- **An unscoped key** (`apiKey` sent to whatever provider the id names). Simpler, but a caller's key for one vendor would be sent to another, overriding the server's key and handing the secret to a third party. `resolveModel` already refuses this; the contract path keeps the same rule.
- **`GeminiAdapter` by default now.** It has not passed its live parity run (gate G3). `AdkGeminiAdapter` is ADK's Gemini, which serves every Gemini id today, so the native loop starts on proven behaviour and changes one thing at a time.
- **Only an option, no environment variable**, for selecting `GeminiAdapter`. The live parity run at G3 drives whole syndicates through entrypoints that do not pass resolver options; a variable reaches them without code changes.

## Consequences

- WS2-5's native loop gets any provider's adapter by id, with the same funding, gateway and BYOK behaviour as the ADK runtime.
- Two tables, one per path, list the same providers. Both are typed `Record<ProviderId, …>`, so a provider missing from either fails the type check, and `tests/resolveAdapter.test.ts` asserts both for every prefix.
- At gate G3 the Gemini default flips to `engine`, and `AdkGeminiAdapter` and the `adk` value are removed in a later change.
