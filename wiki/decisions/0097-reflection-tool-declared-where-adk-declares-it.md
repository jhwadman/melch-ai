---
type: decision
title: "ADR 0097: The native step declares the reflection tool only where ADK's model class declares it, and never to a Gemini model ADK's own Gemini would serve"
description: "ADK's reflect-and-retry model plugin adds adk_handle_model_error to the request's toolsDict and never to its config. The ADK shim and the engine's ADK classes declare the toolsDict, so a shimmed model is told of the tool; ADK's own Gemini (and TracedGemini) sends the config alone, so a Gemini model on ADK never is. The native step declared the tool on every request, so a Gemini 3 workflow node called it on native, self-correction replaced the call with ADK's unsigned reflection call, and the next request failed with Gemini's missing thought_signature 400. declaresReflectionTool decides per adapter: a Gemini adapter is not told of the tool unless a caller handed it over behind the ADK shim. The tool still runs when a model calls it. Thought signatures were already stored and replayed as ADK does. Declaring the tool everywhere and fixing the signature instead, never declaring it on native, and deciding by model id were rejected."
tags:
  - decision
  - runtime
  - models
  - gemini
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/selfCorrection.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/compileNative.ts
  - resource: tests/geminiTurnParity.test.ts
---

# ADR 0097: The native step declares the reflection tool only where ADK's model class declares it

## Context

Gate G4 of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) needs `config/agents/examples/pipeline.yaml` to run live on the native runtime. The live run after [ADR 0095](/decisions/0095-native-workflow-turn-drains-through-the-adk-reader.md) failed on native and passed on ADK, twice. On native the Planner (`gemini-3.8-flash`) answered its first request with a call to `adk_handle_model_error`, though nothing had failed. Self-correction replaced it with ADK's reflection call, which carries no `thoughtSignature`, and the next request failed with Gemini's 400: "Function call is missing a thought_signature in functionCall parts". The node failed, and the turn ended `NODE_FAILED`. On ADK the Planner answered with its route.

Two questions followed.

1. **Thought signatures.** Did the native path drop a Gemini 3 call's signature when it stored the event, or when it built the next request? A scripted Gemini response over a stubbed fetch, through ADK's own Gemini and the real SDK, says no. The signature rides through the adapter as `providerState`, is stored on the call's part as `thoughtSignature`, and goes back on that part in the next request, exactly as on ADK, with `AdkGeminiAdapter` and with `GeminiAdapter`. The unsigned call in the live run was the reflection call self-correction put in place of the model's. ADK's plugin builds the same unsigned call ([ADR 0075](/decisions/0075-native-self-correction-ports-adk-plugins.md)).
2. **The reflection tool.** Why did the model call a tool it was never meant to see? ADK 2.2.0's `ReflectAndRetryModelPlugin.beforeModelCallback` adds the tool to `llmRequest.toolsDict` and to nothing else. What reaches the model depends on the model class:
   - the ADK shim and the engine's ADK classes (`ClaudeLlm`, `GptLlm`, the chat-completions classes, `GatewayLlm`) build their tool list from the toolsDict, so the model is told of the tool;
   - ADK's own `Gemini`, and `TracedGemini` over it, sends `llmRequest.config` alone. The config's tools are written when each agent tool runs its `processLlmRequest`, and the plugin never writes there. A Gemini model on ADK is never told of the tool.

   A workflow changes nothing: `runLlmAgentAsNode` runs the node agent under the workflow's invocation context, whose plugin manager is the Runner's, so a node agent gets the plugins and the same toolsDict entry as any agent. Neither runtime declares the tool later, after an error: it is in the toolsDict on every request, and in the config on none.

   ADR 0075 described the shim's behaviour as ADK's, and the native step declared the tool on every request. Its parity suites script their models behind the shim, so they agreed. A Gemini model on native was told of a tool ADK never shows it, and Gemini 3 called it.

## Decision

1. **The step declares the reflection tool where ADK's model class would.** `declaresReflectionTool(adapter)` (`lib/runtime/native/selfCorrection.ts`) is false for an adapter whose provider is `gemini`, since such an adapter stands for ADK's Gemini: the registry's `AdkGeminiAdapter` or `GeminiAdapter` for a Gemini id, and the adapter `nativeAdapterFor` builds for a `TracedGemini` or ADK `Gemini` a resolver returns. It is true for every other provider, and for a Gemini adapter a caller handed over behind `adkShim`, which `nativeAdapterFor` marks with `servedThroughShim`, because on ADK the shim declares the toolsDict. The step asks it of the adapter it calls, so a fallback on another provider is told of the tool as `FallbackLlm` hands its fallback the same toolsDict.
2. **The tool still runs.** When the step does not declare it, the reflection tool is still one of the step's tools, as it is in ADK's toolsDict. A call to it, from the model or from self-correction's own retry of a `MALFORMED_FUNCTION_CALL`, is replaced and answered with reflection guidance, the same events as on ADK.
3. **Nothing changes for signatures.** The native path already stores and replays them as ADK does. `tests/geminiTurnParity.test.ts` holds both runtimes to it.

## Alternatives considered

- **Keep declaring the tool, and give the reflection call the model's signature.** It would avoid the 400, but native would still show Gemini a tool ADK never shows it, and store a call ADK never stores. The reflection call's missing signature is the same on both runtimes; a fix belongs on both at once (ADR 0075).
- **Never declare the tool on native.** Simpler, but every shimmed model on ADK is told of it, and the parity suites hold those requests equal.
- **Decide by the model id.** A Gemini id behind a caller's shim is declared on ADK, and a Gemini id routed through the gateway is a gateway model on both runtimes. The adapter the step calls says which class ADK would have called.

## Consequences

- A Gemini agent on native, a workflow node included, sends Gemini the same tools as on ADK. `tests/geminiTurnParity.test.ts` runs a plain agent and a workflow node on both runtimes through ADK's Gemini and the SDK over a stubbed fetch, with retries at their defaults, and holds the requests and the stored events equal; it also covers the reserved call answered without a declaration and `declaresReflectionTool` through `nativeAdapterFor`.
- The parity suites that script models behind the shim are unchanged: those models are still told of the tool on both runtimes.
- Still open, on both runtimes:
  - A Gemini 3 model that calls `adk_handle_model_error` on its own, or a `MALFORMED_FUNCTION_CALL` retry, stores an unsigned call, and the next request fails with Gemini's 400. Carrying the model's signature onto the reflection call would need ADK's plugin replaced on the ADK runtime too.
  - The wire encoding differs where the contract is the same: ADK's Gemini sends a tool's parameters and the output schema as Gemini's `Schema` (`parameters`, `responseSchema`), the native step's mapping as JSON Schema (`parametersJsonSchema`, `responseJsonSchema`).
  - The native step stores `turnComplete: true` on a Gemini final, as the shim's mapping writes it; ADK's Gemini writes none.
