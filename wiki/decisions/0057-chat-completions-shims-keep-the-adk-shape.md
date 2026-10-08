---
type: decision
title: "ADR 0057: The chat-completions adapters move onto the contract; their ADK shims keep the shape ADK saw and carry the older spelling"
description: "Ollama, Kimi and the gateway become ModelAdapters on one ChatCompletionsAdapter base. OllamaLlm, KimiLlm and GatewayLlm stay as ADK shims around them. They override AdkShim's response hook (ADR 0056) and a request seam this ADR adds: the request carries the older generateContentConfig spelling the contract leaves out (Kimi K3's max, JSON mode), and the response keeps the shape the ADK path yielded, with usage counting the reasoning, so the ledger's counts do not change. The plain shim's Gemini meaning, a contract field for provider effort words, and a second translation kept beside the adapter were rejected."
tags:
  - decision
  - models
  - runtime
  - contracts
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/ollamaAdapter.ts
  - resource: lib/models/kimiAdapter.ts
  - resource: lib/models/gatewayAdapter.ts
  - resource: lib/models/openAiCompatibleLlm.ts
  - resource: lib/models/adkShim.ts
  - resource: tests/chatCompletionsAdapter.test.ts
---

# ADR 0057: The chat-completions adapters move onto the contract; their ADK shims keep the shape ADK saw and carry the older spelling

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) moves every model adapter onto the engine's own contract ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)) while ADK still runs every turn. Each adapter then runs under ADK behind the [ADK shim](/models/adk-shim.md), which charges the turn and opens the span ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)) and maps the request and responses through the genai mapping.

Moonshot (Kimi), Ollama and the hosted gateways share one chat-completions translation, `OpenAiCompatibleLlm`, an ADK `BaseLlm`. Putting the translation behind the plain shim changes three things the ADK path relies on:

- **The ledger's counts.** The shim writes usage in Gemini's meaning, where `candidatesTokenCount` excludes the thinking. These adapters have always written the provider's `completion_tokens`, which includes the reasoning, as `candidatesTokenCount`. The tracer reads that field as `llm.tokens.output`, the turn's charge and the ledger's `output_tokens`, so every reasoning model's output count would drop by its thinking.
- **What the old classes yield.** A normal stop carried no `finishReason`, an empty final kept `content` with no parts, and an HTTP failure carried `status` and `retryable` at the top level. Tests and callers read these.
- **What the contract leaves out.** The older spelling `generateContentConfig.reasoningEffort` reached the wire as written, and ADR 0047 tells an agent that needs Kimi K3's `max` to write it that way. `max` is no `ReasoningSetting` level, so `llmRequestToModelRequest` drops it. JSON mode without a schema is dropped too. The [model contract](/models/model-contract.md) says an agent keeps such fields on the ADK runtime.

## Decision

1. **One adapter base, three providers.** `ChatCompletionsAdapter` (`lib/models/chatCompletionsAdapter.ts`) implements `ModelAdapter`: it reads a `ModelRequest` and yields the contract's partials and one final, with failures as finals. `OllamaAdapter`, `KimiAdapter` and `GatewayAdapter` supply the endpoint, headers, wire name, reasoning field, the tool choices the provider honours and the error wording. Usage is in the contract's meaning. Nothing in them imports ADK.
2. **Two protected seams on `AdkShim`, the genai mapping by default.** `toLlmResponse(response)` is [ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md)'s one response hook, through which `GptLlm` keeps the Responses usage meaning: a subclass keeps the response shape its ADK-path class yielded. This ADR adds `toModelRequest(llmRequest, options)` on the request side: a subclass extends the request with what its adapter reads beside the contract. The span records the request it returns.
3. **`OpenAiCompatibleLlm` is the chat shim.** It extends `AdkShim`. `OllamaLlm`, `KimiLlm` and `GatewayLlm` extend it and keep their constructors, so the registry and every caller are unchanged. Its `toModelRequest` adds `olderSpelling` (`ChatCompletionsRequest`): an effort word that is not a contract level, and JSON mode without a schema. Its `toLlmResponse` writes `candidatesTokenCount` as the contract's `outputTokens` (reasoning included), sets `finishReason` only for a reply cut short, keeps an empty final's `content`, and keeps `status` and `retryable` at the top level of an HTTP failure.
4. **The older spelling is carried only where the contract cannot say it.** A word that is a level (`none`, `minimal`, `low`, `medium`, `high`) rides in `reasoning` and is mapped as the compiler maps `reasoning:` (ADR 0047). Only `max`, `xhigh` and other words with no level are sent as written. The native runtime never sets `olderSpelling`.

## Alternatives considered

- **The plain shim, with Gemini's meaning.** This was ADR 0053's expectation, and it is what the contract's usage mapping gives. ADR 0056 rejected it for GPT and Grok on the same grounds. It changes `llm.tokens.output`, the turn's output charge and the ledger rows for every reasoning model on these paths, and breaks the shapes above. The native runtime will charge usage in the contract's meaning, which already includes the reasoning, so the chat shims' count is the one that carries over.
- **A contract field for provider effort words.** `max` and `xhigh` are one provider's vocabulary each. A field would put them into every adapter's mapping. A field joins the contract when an agent needs it on the native runtime (the WS1-1 review), and none does yet.
- **Keep the ADK-path translation beside the adapter.** Two translations of one wire drift apart, and the existing tests would stop proving the adapter.
- **Override `generateContentAsync` in the chat shim**, or pass the older spelling to the adapter through a per-call `AsyncLocalStorage` instead of a request seam. The first repeats the shim's signal handling and mapping, which the shim exists to do once. The second hides a request field in a side channel the native runtime would never fill.

## Consequences

- The chat adapters are ready for the registry (WS1-3) and the native runtime, and their ADK path is unchanged except where the contract maps a field the old classes ignored or passed as written: `stopSequences` go as `stop`, a function-calling mode is honoured (`NONE` sends no tools, the gateway forces as asked, Kimi and Ollama weaken a forced choice), an older-spelling budget or word follows ADR 0047's mapping, and a stored call without an id is sent with one, matched to its result.
- Every error a chat shim yields carries its retry verdict and `turnComplete`, as every shimmed adapter's does. A call cut off by a cancelled turn is never retryable.
- `OpenAiCompatibleLlm`'s protected hooks move to `ChatCompletionsAdapter`, on contract types. A consumer's own chat-completions subclass moves with them (CHANGELOG, Breaking).
- The request seam serves any shim whose provider reads an older-spelling field the contract drops, such as GPT's `xhigh`.
- The registry ticket (WS1-3) registers `OllamaLlm`, `KimiLlm` and `GatewayLlm`, not a bare `adkShimClass` around their adapters, or the ledger's output counts drop by the reasoning and the older spelling is lost.
