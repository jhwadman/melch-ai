---
type: subsystem
title: ADK shim
description: "AdkShim (lib/models/adkShim.ts): one ADK BaseLlm that runs any ModelAdapter on the engine's contract, so the contract adapters run on the optional adk runtime, which 1.0.0 removes. What it maps, the turn charge, abort signal and llm.request span it owns for every adapter behind it, how to construct and register one, the two seams a subclass overrides, and how the boundary suite holds it to the scripted ADK model."
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
  - resource: tests/helpers/scriptedLlm.ts
  - resource: tests/shimBodies.test.ts
  - resource: tests/llmRequestBoundary.test.ts
  - resource: lib/models/genaiMapping.ts
  - resource: lib/models/claudeLlm.ts
  - resource: lib/models/gptLlm.ts
  - resource: lib/models/openAiCompatibleLlm.ts
---

# ADK shim

`AdkShim` in `lib/models/adkShim.ts` is an ADK `BaseLlm` that wraps one `ModelAdapter` on the engine's own [model contract](/models/model-contract.md). ADK calls `generateContentAsync(llmRequest, stream, abortSignal)` on it, and the adapter sees only a `ModelRequest`. It serves the optional adk runtime only (`MELCHIZEDEK_RUNTIME=adk` or a turn's `runtime: 'adk'`, with `@google/adk` installed, [ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md)): there an adapter runs by being registered behind the shim, and ADK sees an ordinary `BaseLlm`. On the default native runtime the loop calls each adapter directly, with no shim. The adk runtime, and this shim with it, is removed in 1.0.0 ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)).

Three families of ADK classes run behind it. `ClaudeLlm` (`lib/models/claudeLlm.ts`) is the shim around the [Claude adapter](/models/claude-adapter.md), so every `claude-*` id the adk runtime's registry serves runs through it. `GptLlm` and `GrokLlm` are subclasses of `AdkShim` around `GptAdapter` and `GrokAdapter` ([Responses adapters](/models/responses-adapters.md)). `OllamaLlm`, `KimiLlm` and `GatewayLlm` are shims around the [chat-completions adapters](/models/chat-completions-adapters.md), through `OpenAiCompatibleLlm`. The registry registers them under their own names. A Gemini id is served on the adk runtime by `TracedGemini`, ADK's own Gemini class with the engine's span, as [provider routing](/models/provider-routing.md) describes.

## One call

1. **The request.** `toModelRequest`, which is `llmRequestToModelRequest` unless a subclass extends it, maps the `LlmRequest` with:
   - `model`: the shim's id, not the id the request names;
   - `stream`: the flag ADK passed, `false` by default;
   - `signal`: one that aborts when the turn stops (`currentTurnSignal()`), when the signal ADK passed aborts, or when the request config's own `abortSignal` aborts, whichever comes first. With only one of them it is that signal, and with none there is no signal.

   A provider's ADK class may override the protected `toModelRequest(llmRequest, options)` to add what its adapter reads on the ADK path only: an agent setting the contract leaves out. It never removes or rewrites a contract field. `ClaudeLlm` adds `claudeReasoning`, the agent's older reasoning spelling read as ADR 0049 reads it ([ADR 0055](/decisions/0055-claude-adapter-keeps-the-adk-request.md)).
2. **Charge and span.** The call goes through `traceLlmGeneration` (`lib/observability/tracer.ts`), as every ADK-path adapter's call does, with the adapter's `provider`, the shim's model id and that `ModelRequest`, which a failed call records as `llm.payload.request` without its signal ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)):
   - A turn that is spent or stopped refuses the call with `STEP_LIMIT`, `DEADLINE_EXCEEDED` or `CANCELED`. The refusal is the same `LlmResponse` `GptLlm` and the chat-completions adapters yield, and the adapter is never called.
   - One `llm.request` span covers the call, with the same attributes as on any ADK-path adapter. The adapter adds its own with `setLlmSpanAttribute`, and they land on that span.
   - The final's usage is charged to the turn.

   The [native loop](/overview/native-loop.md)'s model step is the other caller, and makes the same `traceLlmGeneration` call with the same arguments, so a call is charged and traced alike on both runtimes ([ADR 0066](/decisions/0066-native-step-sends-the-adk-request.md)).
3. **The responses.** Each `ModelResponse` the adapter yields goes back through `toLlmResponse`, in order, inside the span, so the tracer reads what it returns. By default it is `modelResponseToLlmResponse`: a partial is a `partial: true` response, and the final is `turnComplete: true` with Gemini's usage meanings and finish reason. A failed final carries `errorCode`, and its retry verdict in `customMetadata['error.retryable']`, which `FallbackLlm` reads. A subclass that stands in for an ADK-path adapter overrides `toLlmResponse` to keep what that adapter wrote beyond the contract.

The shim does not repair an adapter that breaks the contract. A throw reaches ADK as a throw, as a Gemini failure does, and every response is mapped as it comes. `connect()` is refused, because live connections are outside the contract.

## Constructing one

```ts
adkShim(adapter, model?)                       // one instance; model defaults to adapter.model
new AdkShim(adapter, { model? })               // the same
adkShimClass(supportedModels, (model) => adapter)  // a class ADK's LLMRegistry can register
class ClaudeLlm extends AdkShim { … }          // a provider's own class, keeping its name and options
```

A provider whose ADK class callers already construct keeps that class and makes it a subclass: `ClaudeLlm` keeps its constructor options (`model`, `apiKey`, `endpoint`), its static `supportedModels` and `registerClaudeLlm()`, and hands the options to its adapter.

`adkShimClass` returns a class with the given `supportedModels`. ADK constructs it for a model id with `new Class({ model })`, and the class builds its adapter for that id. Pass the direct adapter's own pattern instances: the registry keys on the pattern object, so the shim then replaces that adapter's entry rather than shadowing it, as `gatewayClassFor` does.

Put one shim around each leaf adapter. A fallback pair under ADK is `FallbackLlm(adkShim(primary), adkShim(fallback))` ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)), so each call is charged and traced on its own. A `FallbackAdapter` behind one shim would count a redirected call once.

## Two seams for a subclass

Both are protected, and the genai mapping by default:

- `toLlmResponse(response)` ([ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md)) keeps the response shape the provider's ADK class yields beyond the contract. It runs inside the span, so the tracer reads what it returns. `GptLlm` and `OpenAiCompatibleLlm` override it.
- `toModelRequest(llmRequest, options)` ([ADR 0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md)) carries what an adapter reads beside the contract. The span records the request it returns. `OpenAiCompatibleLlm` overrides it to carry the older `generateContentConfig` spelling the contract leaves out (Kimi K3's `max`).

## What changes for an adapter behind it

Mapped through the default seams, an adapter's events carry `finishReason` (`STOP` for a normal stop or a tool call) as Gemini's do, and the span's `llm.tokens.output`, the turn's output charge and the ledger's `output_tokens` are output less thinking, Gemini's meaning. The shims that stand in for ADK-path adapters keep reasoning inside the output, as those providers have always been counted: `GptLlm` and `GrokLlm`, which also keep the server-side tool record on `customMetadata` ([ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md)), and the chat-completions shims, which also set a finish reason only for a reply cut short ([ADR 0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md)). The stored Event JSON keeps its shape.

## Tests

- `tests/adkShim.test.ts` covers:
  - the mapping both ways and the signal;
  - the refusals, against `ClaudeLlm` (itself a shim), `GptLlm` and `OllamaLlm` under the same stopped turn;
  - the charge, and the span and its attributes;
  - `adkShimClass` through ADK's `LLMRegistry`;
  - `GeminiAdapter` over a fake client, running a delegation turn behind the shim.
- `tests/chatCompletionsAdapter.test.ts` holds the chat shims to their seams: the older spelling on the wire, the final's shape, and the ledger's counts against the default shim's.
- `tests/claudeAdapter.test.ts` runs `ClaudeAdapter` behind a shim whose `toModelRequest` hands it a fixed `ModelRequest`, so its span attributes land on a real `llm.request` span.
- `tests/shimBodies.test.ts` holds every provider's ADK class to its contract adapter: for each input the capability matrix is checked with, `ClaudeLlm`, `GptLlm`, `GrokLlm`, `KimiLlm`, `OllamaLlm` and `GatewayLlm` send, for the LlmRequest `modelRequestToLlmRequest` makes of the ModelRequest, the body their adapter sends for the ModelRequest itself. `TracedGemini` is held to `AdkGeminiAdapter` the same way. These are the thin ADK-path cases per provider; the model suites themselves (`tests/models.test.ts`, `capabilityMatrix.test.ts`, `endpoints.test.ts`, `gateway.test.ts`, `modelRetry.test.ts`) assert from ModelRequests through the contract adapters, so the native runtime inherits them ([ADR 0064](/decisions/0064-model-tests-on-the-contract.md)).
- `tests/llmRequestBoundary.test.ts` keeps the list of tests that may build an LlmRequest: the shim's own, the per-provider shim cases, the adk runtime's own suites, and the one ADK-path provider suite left (`tracedGeminiVertex.test.ts`, a flag only the ADK path has). The model suites on the contract (`models`, `capabilityMatrix`, `endpoints`, `gateway`, `modelRetry`, `claudeCurrentApi`, `claudeVision`, `reasoningKey`) can never be listed. A test outside the list that names `LlmRequest`, calls `modelRequestToLlmRequest` or writes `toolsDict` or `liveConnectConfig` fails it, and so does a listed file that no longer needs to.
- `ScriptedLlm` (`tests/helpers/scriptedLlm.ts`), the scripted ADK model the runtime tests use, is a subclass of `AdkShim` around a `ScriptedModel` (`tests/helpers/scriptedModel.ts`, a scripted `ModelAdapter`). Its script is written in ADK's terms: it receives the LlmRequest the shim mapped and returns LlmResponses, which reach ADK exactly as written (its `toLlmResponse` returns them unmapped), while the model records the ModelRequests. Every call is charged and traced by the shim, as a production adapter's is.
- `tests/syndicateTurn.test.ts`, the boundary suite, runs each of its shim cases twice: with `ScriptedLlm`, whose responses are written in ADK's shape, and with a `ScriptedModel` scripted in the contract's shape behind the plain shim. The two turns must give the same result and store the same history, call ids aside. The cases are:
  - a plain answer, and a second turn that sees the first;
  - a tool call and its result (a delegation);
  - streamed partials;
  - a retryable error (`FallbackLlm` answers it from the fallback) and a non-retryable one (passed on);
  - a model error with no fallback;
  - a cancel;
  - a `max_steps` refusal;
  - an approval pause that resumes.
