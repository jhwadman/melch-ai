---
type: model-provider
title: Gemini adapter
description: "GeminiAdapter (lib/models/geminiAdapter.ts): Gemini behind the engine's model contract on @google/genai directly, with no ADK in the path. How it reaches the Gemini API or Vertex AI, the choices it makes inside the contract's Gemini mapping, thought signatures, failures, and what only a live run can confirm."
tags:
  - models
  - gemini
  - runtime
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/geminiAdapter.ts
  - resource: tests/geminiAdapter.test.ts
  - resource: lib/models/contract.ts
  - resource: lib/models/geminiState.ts
---

# Gemini adapter

`GeminiAdapter` in `lib/models/geminiAdapter.ts` is Gemini as a contract `ModelAdapter` ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)). It calls `@google/genai` itself: `models.generateContent`, or `models.generateContentStream` when the request streams. ADK's `Gemini` class plays no part in it. It is the native runtime's Gemini ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)).

On the ADK runtime every Gemini id is served by `TracedGemini`, ADK's `Gemini` wrapped in `lib/models/tracedGemini.ts`, as [provider routing](/models/provider-routing.md) describes. On the contract, `resolveAdapter` returns this adapter only when `GEMINI_ADAPTER=engine` or the option `{ gemini: 'engine' }` asks for it ([ADR 0060](/decisions/0060-engine-owned-registry.md)). Until it passes the live run at gate G3, Gemini on the contract is [the wrapper over ADK's Gemini](/models/adk-gemini-adapter.md) by default.

The field-by-field mapping is the Gemini table of the [model contract](/models/model-contract.md). This page records how the adapter reaches Gemini, the choices it makes inside that table, and what the offline tests cannot confirm.

## Construction and the endpoint

```ts
new GeminiAdapter({ model, apiKey?, endpoint?, clientFactory? })
```

- **`endpoint`** is the platform ([ADR 0023](/decisions/0023-bring-your-own-endpoint.md)). It defaults to `endpointFromEnv('gemini')` from `lib/models/endpoints.ts`, read on the first call, and the client is built once.
- **The Gemini API.** The key is the first of: `apiKey`, the endpoint's `apiKey`, then `GOOGLE_GENAI_API_KEY`, `GOOGLE_API_KEY` and `GEMINI_API_KEY`, in ADK's order. The client is built with `vertexai: false`, so the SDK's own `GOOGLE_GENAI_USE_VERTEXAI` cannot override a platform the endpoint has chosen.
- **Vertex AI.** The client is built with `vertexai: true` and the endpoint's `project` and `location`, and it authenticates with Google Application Default Credentials. No AI Studio key is sent, a caller's included, as with `TracedGemini`.
- **The wire model** is `platformModel(endpoint, model)`, so `GEMINI_MODEL_MAP` applies.
- **`clientFactory`** builds the client from the derived `GoogleGenAIOptions`. The default is `new GoogleGenAI(options)`, and tests inject a fake.

Setup failures are finals, not throws:

- `MISSING_API_KEY` when there is no key on the Gemini API.
- `ENDPOINT_MISCONFIGURED` when Vertex AI lacks a project or a location, the platform is neither `direct` nor `vertex`, the environment's endpoint is invalid, or the client fails to build.

## The request

The contract's Gemini table holds, with these choices inside it:

- **Schemas go as written.** Tool parameters go in `functionDeclarations[].parametersJsonSchema`, and `outputSchema` goes in `responseJsonSchema` with `responseMimeType: 'application/json'`. Both are lowercase JSON Schema. Nothing converts them to Gemini's uppercase `Schema` dialect, and `parameters` and `responseSchema` are never set.
- **Native tools.** `web_search` and `google_search` become one `googleSearch` tool. `url_context` becomes `urlContext`, and `code_execution` becomes `codeExecution`. `x_search` and `collections_search` are dropped: the span carries `llm.capability.dropped`, and the adapter warns once per tool. `llm.web_search.native` marks a grounded request.
- **Tool choice** is sent only when function declarations are present. `auto`, `none`, `required` and `{ name }` become `AUTO`, `NONE`, `ANY`, and `ANY` with `allowedFunctionNames`. Any `strict` declaration makes the mode `VALIDATED` when the choice is `auto` or absent. With no choice and no strict tool, no `toolConfig` is sent, which leaves the provider default.
- **Reasoning** maps through `reasoningConfig` in `lib/compile.ts` ([ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md)) for the request's model id, as the YAML names it. Gemini 3 gets a `thinkingLevel`, and Gemini 1.x and 2.x a `thinkingBudget`, as does any `budget_tokens` above 0. `includeThoughts: true` is added unless the setting is `none` (or a budget of 0). The effort word that `reasoningConfig` also returns is never sent.
- **Sampling** maps to `temperature`, `topP`, `maxOutputTokens` and `stopSequences`, as given. `maxOutputTokens` is not raised for thinking.
- **History.**
  - System messages are appended to `systemInstruction` after `system`.
  - A thinking part is never sent.
  - An empty text part is sent only to carry a signature.
  - A content left with no parts is not sent, because Vertex AI rejects the whole request for one.
  - `providerState` itself never reaches the wire.
- **The signal** goes in `config.abortSignal`. Without `request.signal` the adapter uses the turn's signal (`currentTurnSignal`, `lib/runtime/turnControl.ts`).

## The response

- **Streaming.** Each chunk's thought parts become thinking partials and its text becomes text partials. Then exactly one final follows, holding the whole text, every tool call and the usage, and never thinking. Streamed text joins into one text part until a signature closes it.
- **Non-streaming.** The adapter yields one thinking partial (when the model thought) before the final, and no text partials.
- **Tool calls.** `functionCall` becomes a `toolCall`. A call that comes without an id gets `adk-<conversation length>-<call index>-<name>`, so the same response always gets the same ids. An id that starts with `adk-` is the engine's own (ADK's ids share the prefix) and is left off the wire, on the call and on its `functionResponse`.
- **Blobs.** `inlineData` and `fileData` parts become blob parts.
- **Usage.** Input is `promptTokenCount` plus `toolUsePromptTokenCount`, and output is `candidatesTokenCount` plus `thoughtsTokenCount`. Thinking is `thoughtsTokenCount` and cache read is `cachedContentTokenCount`, each when reported. The usage is that of the last chunk that carried it.
- **Grounding.** `groundingMetadata.groundingChunks[].web` becomes one citation per page (URL and title), and `webSearchQueries` becomes search queries. The queries are attributed to `web_search`, or to `google_search` when the request named only that. Citation spans are not mapped.
- **Not carried.** Code execution parts (`executableCode`, `codeExecutionResult`) and server-side tool invocations (`toolCall`, `toolResponse`) are not carried in the final.

## Thought signatures

The adapter writes a part's `thoughtSignature` as `providerState: { provider: 'gemini', kind: 'thought_signature', model, payload }` ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md)), on the output part it arrived on. `model` is the request's model id. The provider and kind are defined once, in `lib/models/geminiState.ts`, which the genai mapping reads too; this module still exports both.

- **A signature on a part the final does not carry moves forward.** On a thought part, a code-execution part or a server-side invocation, it goes to the next output part. A trailing signature with no part after it stays with the last part, if that part has none of its own.
- **An empty text part carrying a signature** closes the text before it. That is how a streamed answer's signature usually arrives.
- **On replay**, a signature goes back on the same part, and only on assistant messages of the current turn: those after the last user message (`currentTurnStart`). Earlier turns' signatures are left out.
- **Model-bound.** Only this model's signatures, or ones that name no model, are replayed. Another provider's state, or another Gemini model's signature, is ignored.
- **A signature stored on a thinking part** goes on the next part sent from that message.

## Failures

Every call ends with exactly one final, and a failure is that final with `error` set, never a throw.

| Case | `error.code` | `finishReason` | `retryable` |
|---|---|---|---|
| The call threw (genai's `ApiError`, a network error) | `GEMINI_ERROR`, with `status` when it had one | `error` | `lib/models/retry.ts`'s classification |
| The signal aborted, before or during the call | `GEMINI_ERROR` | `error` | false |
| No candidate, the prompt blocked | the block reason (`SAFETY`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY`, `MODEL_ARMOR`, `JAILBREAK`; an unspecified one is `OTHER`) | `content_filter` | false |
| No candidate, no feedback | `UNKNOWN_ERROR` | `error` | false |
| Finish `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII` or `IMAGE_*`, with or without text before it | the finish reason | `content_filter` | false |
| No output part, any other finish but `STOP` | the finish reason (`MAX_TOKENS` for thinking cut short) | `max_tokens` or `other` | false |

- **Messages.** A message never carries the key in use or anything shaped like a Google API key.
- **Kept parts.** A failure keeps the parts that arrived before it.
- **Not errors.** An empty `STOP` is a final with no parts and `finishReason: 'stop'`. A reply cut short by `MAX_TOKENS` keeps its text with `finishReason: 'max_tokens'`.
- **Retries.** Transient failures are retried under the shared policy, only before the first chunk arrives. A stream that breaks after a chunk is reported, never replayed.
- **The abort** also ends the iteration at once, so a stalled stream or a backoff sleep never holds the caller.

## Telemetry

The adapter sets attributes on the active span: `llm.retries`, `llm.http_status`, `llm.finish_reason`, `llm.web_search.native` and `llm.capability.dropped`. It opens no span of its own and does not charge the turn's step budget. Both stay with the caller ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)): on the ADK path, the [ADK shim](/models/adk-shim.md), through `traceLlmGeneration`. The [wrapper over ADK's Gemini](/models/adk-gemini-adapter.md) keeps the same rule.

## What the offline tests assert

`tests/geminiAdapter.test.ts` runs against a fake client injected through `clientFactory`. It asserts the request object for every mapping above, both response paths, the id made for a call without one, a signature carried across two steps of a tool loop, abort, and every failure row.

Three of its tests run the real `GoogleGenAI` client over a stubbed `fetch`. They assert the JSON body that would reach the Gemini API:

- the signature on the `functionCall` part, with no engine-made id;
- `parametersJsonSchema`, `VALIDATED`, `thinkingConfig` and `responseJsonSchema` where Gemini reads them;
- no `providerState`, effort word or abort signal in the body;
- the key in the `x-goog-api-key` header and never in the URL.

They also cover the SSE stream, genai's `ApiError` status, and the SDK's fetch seeing the abort.

## Confirmed only against documentation

These need the live Gemini run at [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)'s gate G3:

- **Signature validation.** Gemini 3 accepts the replayed signatures on function calls as sent. It rejects a current-turn call that lacks one (a fallback from another provider or model mid-turn). Signatures are bound to the model that wrote them.
- **Where signatures arrive.** In streams they come on a trailing empty text part, and on parallel calls only on the first call.
- **Native tools beside function declarations.** `googleSearch`, `urlContext` and `codeExecution` work next to function declarations on Gemini 3 without `toolConfig.includeServerSideToolInvocations`. The ADK path always sends that flag (`lib/compile.ts`), and this adapter does not.
- **`outputSchema` beside tools.** It is accepted on Gemini 3. Gemini 2.x is documented to reject JSON mode alongside function calling.
- **Function-calling modes.** `VALIDATED` mode exists on both the Gemini API and Vertex AI.
- **Thinking.** `thinkingLevel` holds on Gemini 3 ids, and `MINIMAL` is accepted. `includeThoughts` returns `thought: true` parts. Whether thinking counts against `maxOutputTokens` is unconfirmed.
- **Call ids.** It is unconfirmed which platforms return `functionCall.id`, and whether a `functionResponse.id` echo is required where they do.
- **Usage.** `candidatesTokenCount` excludes thoughts, and `promptTokenCount` includes cached tokens.
- **Vertex AI.** Client construction with Application Default Credentials has been run only against a fake.
- **Blocks and grounding.** A blocked stream reports `promptFeedback` in its first chunk. The URLs in `groundingChunks[].web` are what a citation should show.
