---
type: decision
title: "ADR 0053: The caller of a contract adapter charges the turn and opens its llm.request span; on the ADK path that caller is the shim"
description: A ModelAdapter on the engine's contract never charges the turn's step budget or opens the llm.request span. The code that calls it does, once per leaf adapter. Under ADK that is AdkShim (lib/models/adkShim.ts), through the same traceLlmGeneration call every ADK-path adapter makes, so refusals, token charges and span attributes stay identical. Opening the span in each adapter, and leaving it with migrated adapters, were rejected.
tags:
  - decision
  - models
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/adkShim.ts
  - resource: tests/adkShim.test.ts
  - resource: tests/syndicateTurn.test.ts
  - resource: lib/observability/tracer.ts
  - resource: lib/runtime/turnControl.ts
---

# ADR 0053: The caller of a contract adapter charges the turn and opens its llm.request span; on the ADK path that caller is the shim

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) moves every model adapter onto the engine's own contract ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)) while ADK still runs every turn until 1.0. ADK calls `BaseLlm.generateContentAsync`, so each adapter on the contract runs behind one `BaseLlm` subclass, the ADK shim (`lib/models/adkShim.ts`).

Today each ADK-path adapter (`ClaudeLlm`, `GptLlm`, the chat-completions base, `TracedGemini`) wraps its own call in `traceLlmGeneration` (`lib/observability/tracer.ts`). That one wrapper does three things:

- It charges the call against the turn's budget (`chargeLlmCall`, `lib/runtime/turnControl.ts`). A spent or stopped turn gets a refusal (`STEP_LIMIT`, `DEADLINE_EXCEEDED`, `CANCELED`) as an `LlmResponse`, and the provider is never called.
- It opens the `llm.request` span: provider, model, the turn's identity, token counts, a thinking preview, and on an error the request and the response as payload.
- It charges the call's tokens to the turn.

Each adapter also reads the turn's abort signal at its own provider call. An adapter on the contract has none of this unless something does it, and someone has to decide what.

## Decision

1. **An adapter on the contract never charges the turn and never opens `llm.request`.** It honours `request.signal`, and it decorates the span that is open around it with `setLlmSpanAttribute`. `GeminiAdapter` already works this way.
2. **The caller does it, once per leaf adapter.** On the ADK path the caller is `AdkShim`, which calls `traceLlmGeneration` exactly as the adapters above do, with the adapter's `provider`, the shim's model id and the `LlmRequest`. A refusal is therefore the same `LlmResponse`, the tokens are charged the same way, and the span carries the same attributes.
3. **The request's signal aborts when the turn stops or when ADK's signal aborts**, whichever comes first.
4. **One shim per leaf adapter.** A fallback pair on the ADK path is `FallbackLlm(shim(primary), shim(fallback))` ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)), so a redirected call is two charges and two spans, as it is today. A `FallbackAdapter` behind one shim would make it one of each, attributed to the primary.
5. **The shim repairs nothing.** A throw reaches ADK as a throw, as Gemini's does today. `connect()` is refused, because live sessions are outside the contract.

## Alternatives considered

- **Each adapter charges and opens its span inside `generate()`.** Rejected. It repeats the same lines in every adapter, test doubles included, as the ADK path does today, and an adapter that forgets the charge escapes the turn's `max_steps`, and is called again after the turn has stopped. It also puts the turn's budget, which is no provider's concern, inside the provider mapping. And it would need a `ModelRequest` form of `traceLlmGeneration` now, which WS1-8 is building in parallel.
- **Migrated adapters keep their own `traceLlmGeneration` call during the migration.** Rejected. The tracer takes an `LlmRequest` and a stream of `LlmResponse`s, so the adapter would keep ADK's types, which moving onto the contract removes.
- **A tracing `ModelAdapter` decorator, applied where adapters are resolved and used by both runtimes.** Deferred, not rejected. It is the same rule (the caller charges, once per leaf adapter) in the native runtime's terms, and it needs `traceLlmGeneration` over a `ModelRequest` (WS1-8). The shim may then call that decorator, provided the refusals, the charges and the span attributes stay identical on the ADK path.

## Consequences

- An adapter moves onto the contract (WS1-4 to WS1-6) by deleting its `traceLlmGeneration` call, its `providerRequestOptions()` or `currentTurnSignal()` reads and its `BaseLlm` subclass, and by taking `request.signal`. Registered behind the shim (WS1-3), it keeps its budget, cancellation and telemetry.
- The native runtime (WS2) charges and traces at its own model-call site, around each leaf adapter, never around a whole `FallbackAdapter`. Its refusals must read as the ADK path's do.
- The span's `llm.tokens.output` for a shimmed adapter is output less thinking, in Gemini's meaning (`usageToMetadata`, [model contract](/models/model-contract.md)), where the ADK-path GPT and chat-completions adapters report it with reasoning included. The adapters that move onto the contract align with Gemini's meaning.
- An event a shimmed adapter produces carries `finishReason` (`STOP`, `MAX_TOKENS`, `SAFETY` or `OTHER`), as a Gemini event does. The stored Event JSON keeps its shape: the field is ADK's, and Gemini's events already hold it.
- The boundary suite (`tests/syndicateTurn.test.ts`) runs each shim case twice, with the scripted ADK model and with a scripted contract adapter behind the shim, and requires the same result and the same stored history.
