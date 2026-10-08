---
type: subsystem
title: ADK shim
description: "AdkShim (lib/models/adkShim.ts): one ADK BaseLlm that runs any ModelAdapter on the engine's contract, so adapters move onto the contract while ADK still runs every turn. What it maps, the turn charge, abort signal and llm.request span it owns for every adapter behind it, how to construct and register one, and how the boundary suite holds it to the scripted ADK model."
tags:
  - models
  - runtime
  - contracts
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/adkShim.ts
  - resource: tests/adkShim.test.ts
  - resource: tests/syndicateTurn.test.ts
  - resource: tests/helpers/scriptedModel.ts
  - resource: lib/models/genaiMapping.ts
---

# ADK shim

`AdkShim` in `lib/models/adkShim.ts` is an ADK `BaseLlm` that wraps one `ModelAdapter` on the engine's own [model contract](/models/model-contract.md). ADK calls `generateContentAsync(llmRequest, stream, abortSignal)` on it, and the adapter sees only a `ModelRequest`. While ADK runs every turn ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)), an adapter moves onto the contract by being registered behind the shim. ADK sees no change.

Nothing in the registry uses it yet. Every model id is served by its ADK-path adapter as [provider routing](/models/provider-routing.md) describes, until the registry ticket (WS1-3) registers contract adapters behind it.

## One call

1. **Charge and span.** The call goes through `traceLlmGeneration` (`lib/observability/tracer.ts`), as every ADK-path adapter's call does, with the adapter's `provider`, the shim's model id and the `LlmRequest` ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)):
   - A turn that is spent or stopped refuses the call with `STEP_LIMIT`, `DEADLINE_EXCEEDED` or `CANCELED`. The refusal is the same `LlmResponse` `ClaudeLlm`, `GptLlm` and the chat-completions adapters yield, and the adapter is never called.
   - One `llm.request` span covers the call, with the same attributes as on any ADK-path adapter. The adapter adds its own with `setLlmSpanAttribute`, and they land on that span.
   - The final's usage is charged to the turn.
2. **The request.** `llmRequestToModelRequest` maps the `LlmRequest` with:
   - `model`: the shim's id, not the id the request names;
   - `stream`: the flag ADK passed, `false` by default;
   - `signal`: one that aborts when the turn stops (`currentTurnSignal()`), when the signal ADK passed aborts, or when the request config's own `abortSignal` aborts, whichever comes first. With only one of them it is that signal, and with none there is no signal.
3. **The responses.** Each `ModelResponse` the adapter yields goes back through `modelResponseToLlmResponse`, in order. A partial is a `partial: true` response, and the final is `turnComplete: true` with Gemini's usage meanings and finish reason. A failed final carries `errorCode`, and its retry verdict in `customMetadata['error.retryable']`, which `FallbackLlm` reads.

The shim does not repair an adapter that breaks the contract. A throw reaches ADK as a throw, as a Gemini failure does, and every response is mapped as it comes. `connect()` is refused, because live connections are outside the contract.

## Constructing one

```ts
adkShim(adapter, model?)                       // one instance; model defaults to adapter.model
new AdkShim(adapter, { model? })               // the same
adkShimClass(supportedModels, (model) => adapter)  // a class ADK's LLMRegistry can register
```

`adkShimClass` returns a class with the given `supportedModels`. ADK constructs it for a model id with `new Class({ model })`, and the class builds its adapter for that id. Pass the direct adapter's own pattern instances: the registry keys on the pattern object, so the shim then replaces that adapter's entry rather than shadowing it, as `gatewayLlmFor` does.

Put one shim around each leaf adapter. A fallback pair under ADK is `FallbackLlm(adkShim(primary), adkShim(fallback))` ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)), so each call is charged and traced on its own. A `FallbackAdapter` behind one shim would count a redirected call once.

## What changes for an adapter behind it

Mapped through the contract, an adapter's events carry `finishReason` (`STOP` for a normal stop or a tool call) as Gemini's do. The span's `llm.tokens.output` is output less thinking, Gemini's meaning, where the ADK-path GPT and chat-completions adapters include reasoning in it. The stored Event JSON keeps its shape.

## Tests

- `tests/adkShim.test.ts` covers:
  - the mapping both ways and the signal;
  - the refusals, against `ClaudeLlm`, `GptLlm` and `OllamaLlm` under the same stopped turn;
  - the charge, and the span and its attributes;
  - `adkShimClass` through ADK's `LLMRegistry`;
  - `GeminiAdapter` over a fake client, running a delegation turn behind the shim.
- `tests/syndicateTurn.test.ts`, the boundary suite, runs each of its shim cases twice: with the scripted ADK model `ScriptedLlm`, and with `ScriptedModel` (`tests/helpers/scriptedModel.ts`, a scripted `ModelAdapter`) behind the shim. The two turns must give the same result and store the same history, call ids aside. The cases are:
  - a plain answer, and a second turn that sees the first;
  - a tool call and its result (a delegation);
  - streamed partials;
  - a retryable error (`FallbackLlm` answers it from the fallback) and a non-retryable one (passed on);
  - a model error with no fallback;
  - a cancel;
  - a `max_steps` refusal;
  - an approval pause that resumes.
