---
type: model-provider
title: Responses adapters
description: "GptAdapter and GrokAdapter (lib/models/gptAdapter.ts, lib/models/grokAdapter.ts): GPT and Grok on the engine's model contract over OpenAI's Responses API, with GptLlm and GrokLlm as the ADK shim around them. The choices made inside the contract's OpenAI and xAI tables, reasoning replay, failures and their retry verdicts, what the ADK path keeps, and what only a live run can confirm."
tags:
  - models
  - openai
  - xai
  - runtime
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/gptAdapter.ts
  - resource: lib/models/grokAdapter.ts
  - resource: lib/models/gptLlm.ts
  - resource: lib/models/grokLlm.ts
  - resource: lib/models/adkShim.ts
  - resource: tests/responsesAdapter.test.ts
  - resource: tests/responsesReasoningState.test.ts
---

# Responses adapters

`GptAdapter` in `lib/models/gptAdapter.ts` is GPT as a contract `ModelAdapter` ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)) on OpenAI's Responses API, through the `openai` SDK. `GrokAdapter` in `lib/models/grokAdapter.ts` extends it for xAI, whose Agent Tools API speaks the same wire at `https://api.x.ai/v1`. `GptAdapter` loads nothing from ADK at runtime, so the native runtime ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)) can call it. `GrokAdapter` reads its tool configuration through the env readers in `lib/tools/*Tool.ts`, which load ADK.

`GptLlm` and `GrokLlm` (`lib/models/gptLlm.ts`, `lib/models/grokLlm.ts`) are what the adk runtime's registry registers for `gpt-*`, `o<digit>*` and `grok-*`. Each is an [ADK shim](/models/adk-shim.md) subclass around its adapter, constructed with `{ model, apiKey?, endpoint? }`, so every GPT and Grok call runs on the contract on both runtimes.

The field-by-field mapping is the OpenAI Responses and xAI tables of the [model contract](/models/model-contract.md). This page records the choices made inside them.

## Construction

```ts
new GptAdapter({ model, apiKey?, endpoint? })
new GrokAdapter({ model, apiKey? })
```

- **GPT's endpoint** is the platform ([ADR 0023](/decisions/0023-bring-your-own-endpoint.md)): `endpoint`, else `endpointFromEnv('openai')`, read on each call. OpenAI's API and a proxy at `OPENAI_BASE_URL` take a key: `apiKey`, the endpoint's, then `OPENAI_API_KEY`. Azure OpenAI takes `AZURE_OPENAI_API_KEY` or the plug point's key or token, else an Entra ID token. The wire model is `platformModel(endpoint, model)`, so `OPENAI_MODEL_MAP` applies.
- **Grok** goes to `https://api.x.ai/v1` with `apiKey` or `XAI_API_KEY`, and a per-attempt timeout of `XAI_TIMEOUT_MS` (default ten minutes, at least two).
- **The vendor hooks** are what `GrokAdapter` overrides: the provider id, endpoint, base URL, key and its message, client options, `reasoningParam`, `replaysReasoning`, whether sampling is sent, and `nativeToolPlan`.

Setup failures are finals: `MISSING_API_KEY` without a key on a direct endpoint, `ENDPOINT_MISCONFIGURED` for an incomplete Azure endpoint or a client that failed to build, `SDK_NOT_INSTALLED` when the `openai` package is absent.

## The request

- **History.** System messages join `request.system` in `instructions`, separated by a blank line. A thinking part is never sent. An assistant message puts its `function_call` items before its text, as the ADK path always built it, unless it replays reasoning (below), when it keeps the model's order.
- **Tool results** go as `function_call_output` whose text is genai's `functionResponse.response` for the result: `{ error: result }` for a failed tool, the result when it is an object, else `{ result }`. So a conversation the ADK path stored reaches the vendor byte for byte as before.
- **Blobs** go in user turns only: images as `input_image` (inline as a data URL, or an https URL), a PDF as `input_file`. A blob typed `application/octet-stream`, which the genai mapping gives a part with no type, goes as `image/png`. A URL that is not https is not sent, and the span carries `llm.image.dropped`.
- **Tools.** Each declaration goes as given, `strict: false` unless it is strict, when its parameters take the strict form. `toolChoice` is sent only beside tools.
- **Native tools.** GPT sends `web_search` bare on OpenAI's API and a direct proxy, and drops it on Azure OpenAI, with `llm.web_search.omitted` and a one-time warning. Grok sends `web_search` with the `XAI_WEB_SEARCH_*` domain filters, `x_search` with the `XAI_X_SEARCH_*` bounds, and `collections_search` as `file_search` over `XAI_COLLECTION_IDS`, which is left out with a warning while that is empty. Each is bare when nothing is configured. Every other native tool is dropped and named in `llm.capability.dropped`.
- **Reasoning** ([ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md)) maps through `reasoningConfig` for the request's model:
  - GPT's reasoning ids (`o*`, `gpt-5*`) send `{ summary: 'auto' }` plus the effort in the model's own word: `none` is `minimal` on the first GPT-5 generation, `none` after, `low` on the o-series. Other GPT ids send nothing.
  - `grok-4.5`, `grok-4.6` and `grok-4.7` send `{ effort }`: `none` as `low`, and `DEFAULT_GROK_REASONING_EFFORT` (`medium`) when the request sets none. Other grok ids send nothing.
- **Sampling.** `max_output_tokens` always; `temperature` and `top_p` except on OpenAI's reasoning ids, which refuse them; Grok takes them on every id. `stop` has no field.
- **Structured output** is `text.format` with the schema in its strict form. `outputFormat: 'json'` without a schema is JSON mode, `text.format: { type: 'json_object' }`, on both vendors ([ADR 0061](/decisions/0061-json-mode-on-the-contract.md)).
- **The signal** goes to the SDK as the request option, and also ends the call at once: an aborted request, or a stream that stalls, never holds the caller.

## Reasoning across a tool loop

The ids that reason (OpenAI's `o*` and `gpt-5*`; `grok-4.5`, `grok-4.6`, `grok-4.7`) send `store: false` and `include: ['reasoning.encrypted_content']` ([ADR 0050](/decisions/0050-responses-reasoning-replay-without-storage.md)).

- **Write.** Each run of reasoning items that carry encrypted content rides, verbatim, as `providerState { provider, kind: 'reasoning_items', model, payload }` on the part made from the output item after it: a function call, or the first text of a message. A run that anything else follows is dropped.
- **Replay.** On the assistant messages after the current turn's start (`currentTurnStart`), for this provider and model only, the items go back immediately before their part's item.
- **The guarded retry.** A 400 on a request that carries reasoning additions is retried once without the reasoning field, the `include` and the replayed items. `store: false` stays, and the span carries `llm.retry_without_reasoning`.

## The response

- **Non-streaming.** One thinking partial (the reasoning summaries, joined by a blank line) when the model reasoned, then the final.
- **Streaming.** `response.output_text.delta` and `response.reasoning_summary_text.delta` become text and thinking partials. The reply in `response.completed` becomes the final, with the same parts as the non-streamed one. A stream that ends without `response.completed` ends with a final holding the streamed text.
- **Parts.** A second message item starts on a new paragraph, so narration between server-side searches never runs into the answer. A function call with arguments that do not parse to an object keeps them as `{ raw }`.
- **Usage.** Both vendors count reasoning inside `output_tokens` and cached input inside `input_tokens`, so the counts are the contract's as they come. A live `grok-4.7` usage shows it: 56,765 in and 1,247 out make the 58,012 total, and 943 of the output was reasoning.
- **Grounding.** `url_citation` annotations become citations, their character offsets converted to UTF-16 and shifted into the final's text. The queries of `web_search_call` items, and of xAI's `x_keyword_search` and `x_semantic_search` calls, become search queries.
- **Finish reason.** `tool_call` when the final holds a call; `incomplete` with `max_output_tokens` is `max_tokens`, with `content_filter` is `content_filter`, otherwise `other`; else `stop`.
- **Server-side tools.** The calls the vendor ran and xAI's counters have no contract field. `responsesServerTools(final)` returns them for a final the adapter yielded. The counters also go on the span as `llm.server_tools.*`, and xAI's cost as `llm.cost.vendor_usd_ticks`.

## Failures

Every call ends with exactly one final, and a failure is that final with `error` set, never a throw.

| Case | `error.code` | `retryable` |
|---|---|---|
| The call failed, after the SDK's two retries | `OPENAI_ERROR` or `XAI_ERROR`, with `status` | `lib/models/retry.ts`'s classification |
| An SSE frame named `error`, which the SDK throws with no status | `OPENAI_ERROR` or `XAI_ERROR` | when its code or type is `server_error`, `rate_limit_exceeded` or `vector_store_timeout` |
| A `response.failed` or `error` event in the stream | `OPENAI_STREAM_ERROR` or `XAI_STREAM_ERROR`, with `status` when the event has one | when the event names a status the policy retries, or one of those codes or types (`streamErrorDecision`) |
| The signal aborted, before or during the call | `OPENAI_ERROR` or `XAI_ERROR` | false |

- **Messages** keep the SDK's or the event's wording, with key-shaped text and the key in use removed.
- **No half answer.** A stream failure's final holds no parts, so the stored event never keeps a reply cut off mid-stream.
- **An event that names nothing** is not retryable, so the fallback model ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)) passes it on.

## Telemetry

The adapters open no span and charge no turn ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)); their caller does both: the native loop's model step, or the shim on the adk runtime. They set `llm.web_search.native`, `llm.web_search.omitted`, `llm.collections_search.native`, `llm.collections_search.omitted`, `llm.capability.dropped`, `llm.image.dropped`, `llm.retry_without_reasoning`, `llm.server_tools.*` and `llm.cost.vendor_usd_ticks` on the span open around them.

## What the ADK path keeps

`GptLlm` overrides the shim's `toLlmResponse` so ADK's events read as they always have for these providers ([ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md)):

- `usageMetadata.candidatesTokenCount` is `output_tokens`, reasoning included. So `llm.tokens.output`, the turn's output charge, the root span's `syndicate.tokens.output` and the ledger's `output_tokens` count what they counted before.
- The server-side calls ride on the final as `customMetadata['responses.server_tool_calls']`, and xAI's counters as `['responses.server_tool_usage']`. The root span turns them into `ToolCall` events, so `adk_turns.tool_calls` counts a searched answer.
- `groundingMetadata` from the adapter's grounding, so the A2A server lists the answer's web sources, as it does for Gemini (the owner's decision, 2026-10-08).

The events gain `finishReason`, as every shimmed adapter's do. `buildResponsesInput` and `buildResponsesTools` (in `gptLlm.ts`) take an `LlmRequest`, map it to the contract and run the adapter's own builders. On the ADK path these differ from the earlier GPT and Grok adapters, because the contract carries them differently:

- The effort words `xhigh` and `max` are not sent.
- A call without an id gets one minted from its position, and its result the same one.
- `fileData` images reach the model.
- An in-stream failure has a verdict.
- An aborted stream ends in an error, not in the text so far.

## What the offline tests assert

`tests/responsesAdapter.test.ts` drives the adapters with `ModelRequest` inputs through the real `openai` SDK over a stubbed `fetch`. It asserts the request bodies the ADK-path tests assert, and that `GptLlm` and `GptAdapter` post the same body for the same conversation. It also covers:

- a two-step tool loop on `gpt-5-mini` (streamed and not) and `grok-4.6`;
- the replay rules and the guarded retry;
- both response paths, grounding and finish reasons;
- every failure row, and a stalled stream aborted mid-way;
- JSON mode without a schema, from `outputFormat` and, through `GptLlm` and `GrokLlm`, from `responseMimeType` alone;
- the ADK path's usage meaning and server-side tool record.

`tests/responsesReasoningState.test.ts` runs the reasoning replay through a real ADK runner. `tests/models.test.ts`, `tests/capabilityMatrix.test.ts` and `tests/endpoints.test.ts` drive `GptAdapter` and `GrokAdapter` with ModelRequests: the native tools and xAI's filters, the reasoning field, Azure OpenAI and a proxy, the server-side tool record. `tests/reasoningKey.test.ts` drives them with the `reasoning:` a validated YAML declares. `tests/shimBodies.test.ts` holds `GptLlm` and `GrokLlm` to the same bodies. `tests/errorResponse.test.ts` drives the ADK classes with `LlmRequest`s.

## Confirmed only against documentation

These need a funded run (`npm run parity`):

- **grok-4.6** takes `reasoning.effort` and replays encrypted reasoning items as `grok-4.5` and `grok-4.7` do. The id is in the pattern on the word of the review of the reasoning-replay change ([ADR 0050](/decisions/0050-responses-reasoning-replay-without-storage.md)); neither the repository's documentation nor an installed SDK names it.
- **Citation offsets** are counted in characters (code points) with an exclusive end, as the SDK's types describe them.
- **PDFs** as `input_file` with `file_data` or `file_url`, on both vendors.
- **In-stream error events** name their failure with `code` or `type`, or a status, in the shapes `streamErrorDecision` reads; xAI's error event shape is undocumented.
- **`top_p`** is accepted beside `temperature` on OpenAI's non-reasoning ids and on every Grok id.
