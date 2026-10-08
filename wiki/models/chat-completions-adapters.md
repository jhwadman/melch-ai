---
type: model-provider
title: Chat-completions adapters
description: "ChatCompletionsAdapter (lib/models/chatCompletionsAdapter.ts) and the Ollama, Kimi and gateway adapters on it: the OpenAI chat-completions wire behind the engine's model contract. What each provider supplies, the think-block splitter, reasoning_content replay, the retry without thinking, tool choice, failures, and the ADK shims (OllamaLlm, KimiLlm, GatewayLlm) that keep the ADK path's shape and the ledger's counts. Two questions only a live run answers."
tags:
  - models
  - runtime
  - contracts
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/ollamaAdapter.ts
  - resource: lib/models/kimiAdapter.ts
  - resource: lib/models/gatewayAdapter.ts
  - resource: lib/models/openAiCompatibleLlm.ts
  - resource: lib/models/ollamaLlm.ts
  - resource: lib/models/kimiLlm.ts
  - resource: lib/models/gatewayLlm.ts
  - resource: tests/chatCompletionsAdapter.test.ts
---

# Chat-completions adapters

Moonshot (Kimi), Ollama and the hosted gateways speak OpenAI chat completions, so one base serves all three. `ChatCompletionsAdapter` in `lib/models/chatCompletionsAdapter.ts` implements the contract's `ModelAdapter` ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)): it reads a `ModelRequest`, posts one chat-completions body, and yields thinking and text partials and one final. Nothing in it imports ADK. The field-by-field mapping is the chat-completions table of the [model contract](/models/model-contract.md).

| Adapter | Module | `provider` | Endpoint | Forced tool choice |
|---|---|---|---|---|
| `OllamaAdapter` | `lib/models/ollamaAdapter.ts` | `ollama` | `OLLAMA_BASE_URL`, default `http://localhost:11434/v1`, keyless | weakened to auto |
| `KimiAdapter` | `lib/models/kimiAdapter.ts` | `moonshot` | `MOONSHOT_BASE_URL`, default `https://api.moonshot.ai/v1`, `MOONSHOT_API_KEY` or a caller's key | per model (below) |
| `GatewayAdapter` | `lib/models/gatewayAdapter.ts` | the upstream's (`providerForModel`) | `MODEL_GATEWAY`'s base, `MODEL_GATEWAY_API_KEY` | sent as asked |

## What a provider supplies

A subclass gives the endpoint and headers, the wire model name (`ollama/` stripped, the gateway's mapped id), its reasoning fields, the tool choices it honours (`toolChoiceModes(model, reasoning)`, since a provider may refuse forcing only while the model thinks; a named tool it does not honour goes as `required` where that holds, else auto), and its error wording: `missingRequirement`, `httpError`, `unreachable` and `noAnswerError`, each a code and a message. Two switches turn on shared behaviour: `replaysReasoningContent(model)` (Kimi) and `retriesWithoutThinking()` (Ollama). `transport()` is `direct`, or `gateway:<id>` for the gateway.

The reasoning field comes from the request's `reasoning`, mapped with `reasoningConfig` ([ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md)) for the request's model, so a fallback model gets its own mapping:

- **Ollama and the gateway:** `reasoning_effort` as that model's word. Through a gateway it is the upstream's word, `minimal` for `none` on the first GPT-5 generation.
- **Kimi K3:** `reasoning_effort`, `none` sent as `low`, `medium` as `high`, a budget as the level that covers it, and `DEFAULT_KIMI_REASONING_EFFORT` when the request has none.
- **Kimi K2.x:** `thinking: { type: 'disabled' }` for `none`, and nothing otherwise; K2.7 Code (and its highspeed variant) sends nothing for `none` too, since it cannot switch thinking off and Moonshot refuses `disabled` for it.

Structured output is `response_format`: a schema goes as strict `json_schema` on Kimi and the gateway and as `json_object` on Ollama, whose endpoint takes no schema. `outputFormat: 'json'` without a schema is JSON mode, `json_object`, on all three ([ADR 0061](/decisions/0061-json-mode-on-the-contract.md)). The retry without thinking keeps it.

## The response

- **The scratchpad.** `<think>` blocks in the content, and `reasoning_content` or `reasoning` fields, become thinking: one partial before the final on the JSON path, deltas on the SSE path. `ThinkStreamSplitter` holds back any tail of a delta that could still grow into a tag, so a tag split across deltas never reaches the reply. A block that never closed is thinking too. The final never carries thinking.
- **`reasoning_content` on a tool loop (Kimi, [ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md)).** The response's `reasoning_content` is written as `providerState` (`kind: 'reasoning_content'`, with the model) on the final's first part, and sent back as that assistant message's `reasoning_content` on the current turn's later steps, for the same provider and model. Earlier turns' is not sent. `<think>` blocks and Ollama's `reasoning` field are never carried.
- **No answer after thinking ([ADR 0027](/decisions/0027-thinking-without-answer-is-an-error.md)).** A completion with reasoning, or with `finish_reason: "length"`, and neither text nor a tool call is an error final, `<ID>_MAX_TOKENS` or `<ID>_EMPTY_RESPONSE`, with its usage. The hint names `reasoning: none`, and the older spelling too. A bare empty completion is a final with no parts and no error. A reply cut short keeps its text, as `max_tokens`.
- **The retry without thinking (Ollama).** Such an error is held back and the request is sent once more with `reasoning: none`. Only the second attempt's final is yielded, with both attempts' usage summed. A request that already asks for none is not retried, and `OLLAMA_RETRY_WITHOUT_THINKING=false` turns the retry off.
- **Tool calls.** Arguments that do not parse to an object are kept as `{ raw }`. A call the provider returned without an id gets `adk-<conversation length>-<index>-<name>`. On the ADK path ADK leaves `adk-` ids out of the next request, as it does its own, so the stored history reads as before.
- **Usage** is in the contract's meaning: `completion_tokens` is the output, the reasoning included, and `reasoning_tokens` the thinking part of it.

## Failures

Every failure is a final with `error` set, never a throw: a missing key or gateway before any request, a non-2xx status with `status` and `retryable` from the status, and an unreachable endpoint with `retryable` from the error (a reset is, a refused connection is not). Transient statuses are retried on the request, before any byte is read (`lib/models/retry.ts`), with `llm.retries` on the span. The request's signal, or the turn's when it carries none, aborts the fetch and the SSE read. An aborted call ends at once with the adapter's unreachable code and is never retryable, even when its last status was a 503. Messages pass the key scrubber.

## Under ADK: the shims

`OllamaLlm`, `KimiLlm` and `GatewayLlm` are the ADK classes the registry constructs and registers, with the constructors they always had. Each is a subclass of `OpenAiCompatibleLlm`, which is an [ADK shim](/models/adk-shim.md) around its adapter, so the shim charges the turn and opens the `llm.request` span ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)). `OpenAiCompatibleLlm` overrides the shim's two seams, the response hook `GptLlm` also overrides ([ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md)) and the request seam ([ADR 0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md)):

- **The request** carries `olderSpelling`, what an agent's older `generateContentConfig` spelling asks that the contract has no field for: an effort word that is no level (Kimi K3's `max`, `xhigh`), sent as written. A word that is a level rides in `reasoning`, and JSON mode without a schema in `outputFormat`, which the genai mapping reads from `responseMimeType`.
- **The response** keeps the shape these classes always yielded. `candidatesTokenCount` is the provider's `completion_tokens`, reasoning included, so `llm.tokens.output`, the turn's output charge and the ledger's `output_tokens` count what they always counted; the shim's default would write Gemini's meaning and drop the thinking from them. A finish reason is set only for a reply cut short (`MAX_TOKENS`), a final with no parts keeps its empty `content`, and an HTTP failure keeps `status` and `retryable` beside the verdict in `customMetadata`.

`buildMessages(llmRequest)` and `buildTools(llmRequest)` on the shim return what the adapter sends for an `LlmRequest`.

## What only a live run can confirm

The offline tests pin the wire for both of these; the answers need Moonshot.

1. **`kimi-k2.7-code` without earlier turns' `reasoning_content`.** Moonshot asks for it across turns on K3 and K2.7 Code ("preserved thinking"). The adapter sends it only within the current turn's tool loop, because a past turn's stored history is not what the model saw. Whether K2.7 Code answers worse on a later turn without it is open.
2. **Forced tool choice on `kimi-k2.7-code`.** The live check of 2026-10-08 covered K3 and K2.6, and `KimiAdapter.toolChoiceModes` follows it: K3 honours `required` with thinking on and refuses a named tool with it on (400 "tool_choice 'specified' is incompatible with thinking enabled"), so a named tool goes as `required`; K2.6 refuses both forced modes with thinking on and honours both with it off, so it forces only under `reasoning: none`. K2.7 Code always thinks and was not checked, so it weakens both to auto.

## Tests

`tests/chatCompletionsAdapter.test.ts` drives each adapter with `ModelRequest`s and asserts the request bodies the ADK-path tests assert for the old classes: the reasoning field per provider and generation, the `reasoning_content` replay and what skips it, tools, history, structured output and JSON mode, streaming, and native tools dropped. It also covers the think-block splitter on both paths, the retry without thinking, tool choice, usage, every failure kind and the abort, and the shims' seams: the older spelling on the wire, the final's shape, and the ledger's counts beside the default shim's. `tests/models.test.ts`, `capabilityMatrix.test.ts`, `gateway.test.ts` and `modelRetry.test.ts` drive the adapters with ModelRequests too, and `tests/shimBodies.test.ts` holds `OllamaLlm`, `KimiLlm` and `GatewayLlm` to their adapters' bodies for every capability-matrix input. The ADK-path suites (`kimiReasoningState.test.ts`, `reasoningKey.test.ts`, `errorResponse.test.ts`) run the shims.
