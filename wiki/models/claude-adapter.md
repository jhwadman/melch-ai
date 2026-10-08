---
type: model-provider
title: Claude adapter
description: "ClaudeAdapter (lib/models/claudeAdapter.ts): Claude on the engine's model contract, reading a ModelRequest and yielding ModelResponses on the Messages API, with ClaudeLlm as its ADK shim. How it reaches Anthropic, Bedrock or Vertex AI, the choices it makes inside the contract's Anthropic mapping, what ClaudeLlm adds on the ADK path, failures, telemetry, and what only a live run can confirm."
tags:
  - models
  - anthropic
  - runtime
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/claudeAdapter.ts
  - resource: lib/models/claudeLlm.ts
  - resource: lib/models/claudeModels.ts
  - resource: lib/models/adkShim.ts
  - resource: tests/claudeAdapter.test.ts
  - resource: tests/claudeCurrentApi.test.ts
  - resource: tests/claudeVision.test.ts
  - resource: tests/reasoningState.test.ts
---

# Claude adapter

`ClaudeAdapter` in `lib/models/claudeAdapter.ts` is Claude as a contract `ModelAdapter` ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)). It reads a `ModelRequest`, calls the Messages API through the Anthropic SDK, and yields `ModelResponse`s. No ADK type is in its path, so the native runtime ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)) calls it as it is.

`ClaudeLlm` in `lib/models/claudeLlm.ts` is the same adapter behind the [ADK shim](/models/adk-shim.md): a subclass of `AdkShim` that keeps its name, its constructor options, its static `supportedModels` and `registerClaudeLlm()`. The registry constructs it for every `claude-*` id as [provider routing](/models/provider-routing.md) describes, so every Claude call on the ADK path goes through this adapter.

The field-by-field mapping is the Anthropic table of the [model contract](/models/model-contract.md). The request surface per model generation is [ADR 0049](/decisions/0049-claude-requests-by-model-generation.md)'s table (`lib/models/claudeModels.ts`). This page records how the adapter reaches Anthropic, the choices it makes inside the mapping, and what the ADK path adds.

## Construction and the endpoint

```ts
new ClaudeAdapter({ model, apiKey?, endpoint? })
new ClaudeLlm({ model, apiKey?, endpoint? })   // the same options, handed to the adapter
```

- **`endpoint`** is the platform ([ADR 0023](/decisions/0023-bring-your-own-endpoint.md)): Anthropic's API (or a proxy at `ANTHROPIC_BASE_URL`), Bedrock or Vertex AI. It defaults to `endpointFromEnv('anthropic')`, read on every call.
- **The key** is the first of `apiKey`, the endpoint's key and `ANTHROPIC_API_KEY`. Bedrock and Vertex AI use their cloud credentials instead.
- **The client** comes from `claudeClientSpec` and `instantiateClient` (`lib/models/endpoints.ts`), which load `@anthropic-ai/sdk`, or its Bedrock or Vertex AI client, on first use. A client is built per call, so a changed environment takes effect on the next call.
- **The wire model** is `platformModel(endpoint, model)`, so `ANTHROPIC_MODEL_MAP` applies.

## The request

The contract's Anthropic table holds, with these choices inside it:

- **Reasoning** goes through one `ClaudeReasoning` (`lib/models/claudeModels.ts`): an effort word and a budget. `claudeReasoningOf` maps the contract's `reasoning` to it: a level is its effort with ADR 0047's budget for it, `{ budget_tokens: n }` is the level covering n with n as the budget, and `none` is `none` with a budget of 0. The budget rows read the budget alone; the adaptive rows read the effort (`adaptiveThinkingFor`), with the budget, when above 0, as the `max_tokens` floor.
- **The ADK path's reasoning.** `ClaudeLlm` overrides the shim's `toModelRequest` and adds `claudeReasoning`, which the adapter reads in place of `reasoning` (`ClaudeModelRequest`, [ADR 0055](/decisions/0055-claude-adapter-keeps-the-adk-request.md)). It is the agent's `generateContentConfig` read as ADR 0049 reads it (`claudeReasoningFromConfig`): the effort word first, with `xhigh` and `max` passed through and `minimal` as `low`, else the thinking budget rounded up to a level; and the thinking budget as given. Wherever the compiler writes both spellings from `reasoning:`, the two readings agree, which `tests/claudeAdapter.test.ts` asserts on every generation. They differ only on the older spelling: an effort word above `high`, `minimal`, a word without a budget on Claude 4.6 and earlier (no thinking there, where `reasoning` would map the level to its budget), and a word and a budget that disagree. The native runtime never sets it.
- **System messages** are appended to the system prompt after `system`, in order, joined by blank lines. A system message's text parts join with newlines.
- **Tool results.** A tool message is one user message of `tool_result` blocks. Each `content` is the JSON text of the result in the shape the ADK path stores it: the result when it is an object, `{ result }` when it is not, `{ error: result }` for a failure, which also sets `is_error: true`. Both runtimes therefore send the same bytes for one history, which a conversation-bound thinking block needs.
- **Images.** Only user messages carry blobs. A blob typed `application/octet-stream`, the genai mapping's type for a part that names none, is untyped: inline data goes as `image/png`, and a URL is typed by its extension, or sent untyped when the extension is unknown. A type Anthropic refuses, a URL that is not `https`, and a URL on Bedrock or Vertex AI are dropped, named on `llm.image.dropped` (never the URL) with one warning per reason per adapter.
- **Tools.** A client tool goes as `{ name, description, input_schema }`. A `strict` one goes with the strict form of its schema and `strict: true`. `web_search` becomes Anthropic's `web_search_20250305` server tool (`max_uses: 5`) on Anthropic's own API; elsewhere it is dropped with `llm.web_search.omitted` and one warning. Every other native tool is dropped without a warning, since `lib/models/capabilities.ts` and the compiler say so in advance. Each drop is named on `llm.capability.dropped`. `anthropicTools(request)` gives the list before the platform is known, and `buildAnthropicTools(llmRequest)` in `claudeLlm.ts` is the same for an LlmRequest.
- **Tool choice.** `auto` sends nothing. `none`, `required` and `{ name }` are sent as `{ type: 'none' }`, `{ type: 'any' }` and `{ type: 'tool', name }` when a tool is sent. A forced choice is weakened to `auto` where the model refuses forcing or the setting thinks, with `llm.tool_choice.weakened` set to `required` or `named`.
- **Structured output.** `output_config.format` where the row takes it. Elsewhere, and for a schema the SDK's transform refuses, a `structured_output` tool carries the schema: forced only when the model takes forcing, the setting does not think and no other tool is sent, else offered under `auto`. `llm.structured_output` names which (`output_format`, `forced_tool`, `tool_auto`).
- **`max_tokens`** is `sampling.maxOutputTokens`, default 4,096, raised to fit thinking. No sampling field is sent.
- **The signal** is `request.signal`, else the turn's (`currentTurnSignal`). It goes to the SDK, which aborts its fetch, and an aborted signal also ends the call at once.

## The response

- **Non-streamed.** The thinking blocks' text, joined, is one thinking partial before the final.
- **Streamed.** Each `text_delta` and `thinking_delta` is a partial. The final comes from `finalMessage()` and repeats the whole text.
- **Signed blocks.** Each run of `thinking` and `redacted_thinking` blocks rides, verbatim, on the part that follows it as `providerState: { provider: 'anthropic', kind: 'thinking_blocks', model, payload }` ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md)). A run with no part after it is dropped. On replay, only this model's blocks on the current turn's assistant messages are sent, immediately before their part, and on a conversation-bound row with thinking off none are.
- **The structured-output tool's call** becomes the answer's text, `JSON.stringify(input)`, only when the request offered that tool.
- **Finish reasons.** `tool_call` whenever a tool call is there. `refusal` is `content_filter`, `max_tokens` and `model_context_window_exceeded` are `max_tokens`, and `pause_turn` is `other`. None of these is an error, and each keeps the text that came.
- **Usage.** Input is `input_tokens` plus both cache counts, output is `output_tokens`, and the cache counts are reported when above 0. Thinking is not reported apart.
- **Grounding.** A `server_tool_use` named `web_search` gives a search query. A `web_search_result_location` citation on a text block gives a citation with its URL, title and cited text, spanning that block in the final's text. Behind the shim these become the event's `groundingMetadata`, which the A2A server reports as web sources.
- **Dropped blocks.** `input_transformations` of type `thinking_dropped` with a known reason set `llm.thinking.dropped` ([ADR 0049](/decisions/0049-claude-requests-by-model-generation.md)).

## Failures

Every call ends with exactly one final, and a failure is that final with `error` set, `finishReason: 'error'` and no parts, never a throw.

| Case | `error.code` | `retryable` |
|---|---|---|
| The endpoint from the environment does not parse; Bedrock or Vertex AI not fully configured; the client failed to build | `ENDPOINT_MISCONFIGURED` | false |
| No key on Anthropic's own API | `MISSING_API_KEY` | false |
| The SDK, or the platform's optional peer, is not installed | `SDK_NOT_INSTALLED` | false |
| The call failed, after the SDK's own retries | `ANTHROPIC_ERROR`, with `status` when it had one | `lib/models/retry.ts`'s classification |
| The signal aborted, before or during the call | `ANTHROPIC_ERROR` | false |

The message is the SDK's or the platform's, with key-shaped text removed (`errorText`, `lib/models/errorResponse.ts`). Behind the shim the final becomes an `LlmResponse` with `errorCode`, `errorMessage` and the verdict in `customMetadata['error.retryable']` and `['error.status']`, which `FallbackLlm` reads ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)). A setup failure now carries `error.retryable: false` there too, which reads as it did without one.

Retries are the Anthropic SDK's own two, before anything is yielded. A stream that breaks after a delta is reported, never replayed.

## Telemetry

The adapter sets attributes on the active span and opens none: `llm.image.dropped`, `llm.web_search.native`, `llm.web_search.omitted`, `llm.capability.dropped`, `llm.thinking.omitted`, `llm.thinking.dropped`, `llm.structured_output` and `llm.tool_choice.weakened`. The caller opens the `llm.request` span and charges the turn ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)); on the ADK path that is the shim, so `ClaudeLlm`'s spans carry the attributes they always did. Mapped through the shim, a Claude event carries `finishReason` as a Gemini event does, and `groundingMetadata` when Claude searched.

## What the offline tests assert

- `tests/claudeCurrentApi.test.ts`, `tests/claudeVision.test.ts`, `tests/reasoningState.test.ts`, `tests/errorResponse.test.ts`, `tests/capabilityMatrix.test.ts` and `tests/endpoints.test.ts` drive `ClaudeLlm` with LlmRequests against a stubbed `fetch` or a fake platform client, and assert the body the real SDK sends.
- `tests/claudeAdapter.test.ts` drives `ClaudeAdapter` with ModelRequests and asserts the same bodies. On every generation and every reasoning setting, a ModelRequest's body equals the one `ClaudeLlm` sends for the LlmRequest the compiler builds. It also covers tool choice and its weakening, strict tools, dropped native tools, tool results, images, Bedrock, both response paths, finish reasons, grounding, every failure row and the abort, and the older spelling only `ClaudeLlm` reads.

## Confirmed only against documentation

These need a live run (gate G2 of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)):

- **Strict tools.** `strict: true` with the strict schema form is accepted beside thinking, and on every generation.
- **`tool_choice: { type: 'none' }`** with tools present, and `is_error: true` on a failed tool's result.
- **Citations.** A `web_search_result_location` citation covers the whole text block it arrives on, and `server_tool_use.input.query` is the query that ran.
- **`model_context_window_exceeded`** is the stop reason the API returns when the context fills.
- The rows ADR 0049 lists as verified against documentation only.
