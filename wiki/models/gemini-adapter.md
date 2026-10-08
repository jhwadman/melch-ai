---
type: model-provider
title: Gemini adapter
description: "GeminiAdapter (lib/models/geminiAdapter.ts): Gemini behind the engine's model contract on @google/genai directly, with no ADK in the path. How it reaches the Gemini API or Vertex AI, the choices it makes inside the contract's Gemini mapping, grounding, code execution and server-side invocations, thought signatures, failures, and what only a live run can confirm."
tags:
  - models
  - gemini
  - runtime
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/models/geminiAdapter.ts
  - resource: tests/geminiAdapter.test.ts
  - resource: lib/models/contract.ts
  - resource: lib/models/geminiState.ts
  - resource: lib/runtime/native/request.ts
  - resource: tests/geminiNativeTools.test.ts
---

# Gemini adapter

`GeminiAdapter` in `lib/models/geminiAdapter.ts` is Gemini as a contract `ModelAdapter` ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)). It calls `@google/genai` itself: `models.generateContent`, or `models.generateContentStream` when the request streams. ADK's `Gemini` class plays no part in it. It is the native runtime's Gemini ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)).

On the ADK runtime every Gemini id is served by `TracedGemini`, ADK's `Gemini` wrapped in `lib/models/tracedGemini.ts`, as [provider routing](/models/provider-routing.md) describes. On the contract, the registry's `resolveAdapter` returns this adapter only when `GEMINI_ADAPTER=engine` or the option `{ gemini: 'engine' }` asks for it ([ADR 0060](/decisions/0060-engine-owned-registry.md)). Until it passes the live run at gate G3, Gemini on the registry's contract path is [the wrapper over ADK's Gemini](/models/adk-gemini-adapter.md) by default. The ADK-free entry `melchizedek-agents/model` has no wrapper, so its `resolveAdapter` returns this adapter for every Gemini id ([ADR 0068](/decisions/0068-model-entry-without-adk.md)).

The field-by-field mapping is the Gemini table of the [model contract](/models/model-contract.md). This page records how the adapter reaches Gemini, the choices it makes inside that table, and what the offline tests cannot confirm.

## Construction and the endpoint

```ts
new GeminiAdapter({ model, apiKey?, endpoint?, clientFactory?, placeholderSignatures? })
```

- **`endpoint`** is the platform ([ADR 0023](/decisions/0023-bring-your-own-endpoint.md)). It defaults to `endpointFromEnv('gemini')` from `lib/models/endpoints.ts`, read on the first call, and the client is built once.
- **The Gemini API.** The key is the first of: `apiKey`, the endpoint's `apiKey`, then `GOOGLE_GENAI_API_KEY`, `GOOGLE_API_KEY` and `GEMINI_API_KEY`, in ADK's order. The client is built with `vertexai: false`, so the SDK's own `GOOGLE_GENAI_USE_VERTEXAI` cannot override a platform the endpoint has chosen.
- **Vertex AI.** The client is built with `vertexai: true` and the endpoint's `project` and `location`, and it authenticates with Google Application Default Credentials. No AI Studio key is sent, a caller's included, as with `TracedGemini`.
- **The wire model** is `platformModel(endpoint, model)`, so `GEMINI_MODEL_MAP` applies.
- **`clientFactory`** builds the client from the derived `GoogleGenAIOptions`. The default is `new GoogleGenAI(options)`, and tests inject a fake.
- **`placeholderSignatures`** turns on Gemini's placeholder thought signature (see [Thought signatures](#thought-signatures)). The default is `PLACEHOLDER_SIGNATURES_BY_DEFAULT`, which is false.

Setup failures are finals, not throws:

- `MISSING_API_KEY` when there is no key on the Gemini API.
- `ENDPOINT_MISCONFIGURED` when Vertex AI lacks a project or a location, the platform is neither `direct` nor `vertex`, the environment's endpoint is invalid, or the client fails to build.

The adapter calls `generateContent` and `generateContentStream` only. Gemini's Interactions API is not used: the contract's history is the conversation, and the Interactions API keeps it on Google's side.

## The request

The contract's Gemini table holds, with these choices inside it:

- **Schemas go as written.** Tool parameters go in `functionDeclarations[].parametersJsonSchema`, and `outputSchema` goes in `responseJsonSchema` with `responseMimeType: 'application/json'`. Both are lowercase JSON Schema. Nothing converts them to Gemini's uppercase `Schema` dialect, and `parameters` and `responseSchema` are never set. `outputFormat: 'json'` without a schema sends `responseMimeType: 'application/json'` alone, Gemini's JSON mode ([ADR 0061](/decisions/0061-json-mode-on-the-contract.md)).
- **Native tools.** `web_search` and `google_search` become one `googleSearch` tool. `url_context` becomes `urlContext`, and `code_execution` becomes `codeExecution`. `x_search` and `collections_search` are dropped: the span carries `llm.capability.dropped`, and the adapter warns once per tool. `llm.web_search.native` marks a grounded request.
- **Server-side invocations.** When native tools sit beside function declarations, `toolConfig.includeServerSideToolInvocations: true` is sent, as the ADK path sends it (`lib/compile.ts`), and Gemini returns its server-side `toolCall` and `toolResponse` parts. It goes on the Gemini API only: `@google/genai` throws before any request when a Vertex AI client is given it ([ADR 0065](/decisions/0065-gemini-carried-parts-and-server-side-invocations.md)). With function declarations alone, or native tools alone, it is not sent.
- **Tool choice** is sent only when function declarations are present. `auto`, `none`, `required` and `{ name }` become `AUTO`, `NONE`, `ANY`, and `ANY` with `allowedFunctionNames`. Any `strict` declaration makes the mode `VALIDATED` when the choice is `auto` or absent. With no choice, no strict tool and no server-side invocations, no `toolConfig` is sent, which leaves the provider default.
- **Reasoning** maps through `reasoningConfig` in `lib/compile.ts` ([ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md)) for the request's model id, as the YAML names it. Gemini 3 gets a `thinkingLevel`, and Gemini 1.x and 2.x a `thinkingBudget`, as does any `budget_tokens` above 0. `includeThoughts: true` is added unless the setting is `none` (or a budget of 0). The effort word that `reasoningConfig` also returns is never sent.
- **Sampling** maps to `temperature`, `topP`, `maxOutputTokens` and `stopSequences`, as given. `maxOutputTokens` is not raised for thinking.
- **History.**
  - System messages are appended to `systemInstruction` after `system`.
  - A thinking part is never sent.
  - An empty text part is sent only to carry a signature.
  - A content left with no parts is not sent, because Vertex AI rejects the whole request for one.
  - `providerState` itself never reaches the wire.
- **Call ids.** An id that starts with `adk-` (the engine's, and ADK's) or `genai-noid-` (minted by the [genai mapping](/models/model-contract.md#the-reverse-directions); `MINTED_CALL_ID_PREFIX` in `lib/models/geminiState.ts`) is left off the wire, on the call and on its `functionResponse`. Gemini's own ids go back.
- **The signal** is `request.signal` alone, sent in `config.abortSignal`. The adapter reads no turn state: its caller passes the turn's signal ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)), the [ADK shim](/models/adk-shim.md) today and the native loop after it.

## The response

- **Streaming.** Each chunk's thought parts become thinking partials and its text becomes text partials. Then exactly one final follows, holding the whole text, every tool call and the usage, and never thinking. Streamed text joins into one text part until a signature or a carried part closes it.
- **Non-streaming.** The adapter yields one thinking partial (when the model thought) before the final, and no text partials.
- **Tool calls.** `functionCall` becomes a `toolCall`. A call that comes without an id gets `adk-<conversation length>-<call index>-<name>`, so the same response always gets the same ids.
- **Blobs.** `inlineData` and `fileData` parts become blob parts.
- **Carried parts.** `executableCode`, `codeExecutionResult` and server-side `toolCall` and `toolResponse` parts have no contract type. Each is kept whole, as Gemini sent it, and the run of them rides on the next output part as `providerState` of kind `carried_parts` ([ADR 0065](/decisions/0065-gemini-carried-parts-and-server-side-invocations.md)). They are not streamed, and the final's text does not show them. A run with no output part after it rides on an empty text part of its own.
- **Usage.** Input is `promptTokenCount` plus `toolUsePromptTokenCount`, and output is `candidatesTokenCount` plus `thoughtsTokenCount`. Thinking is `thoughtsTokenCount` and cache read is `cachedContentTokenCount`, each when reported. The usage is that of the last chunk that carried it.
- **Grounding.** The final's `grounding` holds:
  - **Search queries.** `webSearchQueries`, attributed to `web_search`, or to `google_search` when the request named only that.
  - **Spanned citations.** For each `groundingSupports[]` entry, one citation per web chunk it names (URL and title), with `start` and `end`: the segment's UTF-8 byte offsets converted to UTF-16 offsets into the final's joined text. When the offsets do not land on the segment's `text` (they may be relative to one part), the text's first place in the answer is the span. A segment not found in the answer cites nothing.
  - **Other searched pages**, once each and without a span.
  - **URL context.** Each page `urlContextMetadata` reports as retrieved (`URL_RETRIEVAL_STATUS_SUCCESS`), once and without a span. A page that failed, was paywalled or was unsafe is not cited.

## Thought signatures

The adapter writes a part's `thoughtSignature` as `providerState: { provider: 'gemini', kind: 'thought_signature', model, payload }` ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md)), on the output part it arrived on. `model` is the request's model id. The provider and kind are defined once, in `lib/models/geminiState.ts`, which the genai mapping reads too; this module still exports both. A part that also holds carried parts writes its signature inside the `carried_parts` payload, as `signature`, since a part holds one `providerState`.

- **A signature on a thought part moves forward** to the next part Gemini sent, an output part or a carried part. When that part has a signature of its own, its own wins. A trailing signature with no part after it stays with the last part, if that part has none of its own.
- **An empty text part carrying a signature** closes the text before it. That is how a streamed answer's signature usually arrives.
- **On replay**, a signature goes back on the same part, and carried parts go back immediately before the part that holds them, with their own signatures. Both happen only on assistant messages of the current turn: those after the last user message (`currentTurnStart`). Earlier turns' signatures and carried parts are left out.
- **Model-bound.** Only this model's signatures, or ones that name no model, are replayed. Another provider's state, or another Gemini model's signature, is ignored. Another Gemini model's carried parts go back without their signatures.
- **A signature stored on a thinking part** goes on the next part sent from that message.
- **The placeholder.** Gemini 3 rejects a current-turn step whose first function call has no signature, as after a mid-turn fallback from another provider or model. With `placeholderSignatures: true`, that call gets `PLACEHOLDER_THOUGHT_SIGNATURE` (`skip_thought_signature_validator`, Gemini's documented value). It is off by default until the G3 live run.

## Failures

Every call ends with exactly one final, and a failure is that final with `error` set, never a throw.

| Case | `error.code` | `finishReason` | `retryable` |
|---|---|---|---|
| The call threw (genai's `ApiError`, a network error) | `GEMINI_ERROR`, with `status` when it had one | `error` | `lib/models/retry.ts`'s classification |
| The signal aborted, before or during the call | `GEMINI_ERROR` | `error` | false |
| No candidate, the prompt blocked | the block reason (`SAFETY`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY`, `MODEL_ARMOR`, `JAILBREAK`; an unspecified one is `OTHER`) | `content_filter` | false |
| No candidate, no feedback | `UNKNOWN_ERROR` | `error` | false |
| Finish `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII` or `IMAGE_*`, with or without text before it | the finish reason | `content_filter` | false |
| No answer (no output part, or only carried parts), any other finish but `STOP` | the finish reason (`MAX_TOKENS` for thinking cut short) | `max_tokens` or `other` | false |

- **Messages.** A message never carries the key in use or anything shaped like a Google API key.
- **Kept parts.** A failure keeps the parts that arrived before it.
- **Not errors.** An empty `STOP` is a final with no parts and `finishReason: 'stop'`. A reply cut short by `MAX_TOKENS` keeps its text with `finishReason: 'max_tokens'`.
- **Retries.** Transient failures are retried under the shared policy, only before the first chunk arrives. A stream that breaks after a chunk is reported, never replayed.
- **The abort** also ends the iteration at once, so a stalled stream or a backoff sleep never holds the caller.

## Telemetry

The adapter sets attributes on the active span: `llm.retries`, `llm.http_status`, `llm.finish_reason`, `llm.web_search.native` and `llm.capability.dropped`. It opens no span of its own and does not charge the turn's step budget. Both stay with the caller ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)): on the ADK path, the [ADK shim](/models/adk-shim.md), through `traceLlmGeneration`. The [wrapper over ADK's Gemini](/models/adk-gemini-adapter.md) keeps the same rule.

## From the native step

On the native runtime the adapter receives the request the [native step](/overview/native-loop.md) builds (`buildModelRequest`, `lib/runtime/native/request.ts`). The step reads each tool by marker ([ADR 0062](/decisions/0062-server-side-tools-as-markers.md)):

- **Server-side tools are request flags.** On a Gemini model, `web_search` and `google_search` reach the adapter as the `nativeTools` entry `web_search`, and `url_context` as `url_context`. None is declared as a function, and none is handed to the loop to run. The adapter sends them as `{ googleSearch: {} }` and `{ urlContext: {} }`. On another model, `url_context` adds no flag, and `google_search` is refused as the ADK runtime refuses it. The registry still hands the ADK runtime its own objects: the shared `WEB_SEARCH` and `URL_CONTEXT` sentinels, and ADK's `GOOGLE_SEARCH`.
- **Memory tools** ([ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md)). `load_memory` is a function declaration whose `parametersJsonSchema` is its lowercase schema as written. While the run has memory, its note and `preload_memory`'s `<PAST_CONVERSATIONS>` block go in `systemInstruction`, in the agent's tool order. Without memory, neither writes anything. The model's `load_memory` call goes back to Gemini as a `functionCall`, and the tool's result as the matching `functionResponse`, with the engine's minted call id kept off the wire.

`tests/geminiNativeTools.test.ts` asserts all of this on the real `GoogleGenAI` client over a stubbed `fetch`. It runs a two-step session in which Gemini calls `load_memory` and answers from the result; the tool runs by hand there until the loop runs tools (WS2-5b). It also compiles the model zoo, the research example and Ares, builds each Gemini agent's native request from the compiled agent, and asserts the tools on the wire: the Zookeeper's six explainers, research's evidence tools and Triage's schema with no tools, Ares's `WarScribe` and `load_memory` with the preloaded facts, and `WarScribe`'s `googleSearch` alone. Running those syndicates end to end on the native runtime waits for the compile split (WS2-10) and the boundary suite on native (WS2-12).

## What the offline tests assert

`tests/geminiAdapter.test.ts` runs against a fake client injected through `clientFactory`. It asserts the request object for every mapping above, both response paths, the id made for a call without one, a signature carried across two steps of a tool loop, abort, and every failure row. Against the fake it also asserts streamed text split around carried parts, server-side invocations carried, a trailing run of carried parts, another Gemini model's carried parts sent unsigned, and the flag never sent to Vertex AI.

The tests named "on the wire" run the real `GoogleGenAI` client over a stubbed `fetch`. They assert the JSON body that would reach the Gemini API, and the response the adapter makes of Gemini's JSON:

- the signature on the `functionCall` part, with no engine-made id;
- `parametersJsonSchema`, `VALIDATED`, `thinkingConfig` and `responseJsonSchema` where Gemini reads them;
- no `providerState`, effort word or abort signal in the body;
- the key in the `x-goog-api-key` header and never in the URL;
- grounding as spanned citations over a multibyte answer, a segment whose offsets miss its text, a segment not in the answer, and urlContext's retrieved and failed pages;
- `includeServerSideToolInvocations` beside function declarations only, and the SDK refusing it on a Vertex AI client before any fetch;
- code execution over two steps and a next turn: the code, its result and two signatures replayed on the second step, none of it on the next turn;
- `adk-` and `genai-noid-` ids off the wire, Gemini's own ids on it;
- a turn stopped around a request with no signal does not stop it, and the request's own aborted signal does;
- placeholder signatures off by default, and on: the first unsigned call of a current-turn step only.

They also cover the SSE stream, genai's `ApiError` status, and the SDK's fetch seeing the abort.

## Confirmed only against documentation

These need the live Gemini run at [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)'s gate G3:

- **Signature validation.** Gemini 3 accepts the replayed signatures on function calls as sent. It rejects a current-turn call that lacks one (a fallback from another provider or model mid-turn). Signatures are bound to the model that wrote them.
- **The placeholder.** `skip_thought_signature_validator` is accepted in place of a missing signature on Gemini 3, so `placeholderSignatures` can be turned on.
- **Where signatures arrive.** In streams they come on a trailing empty text part, and on parallel calls only on the first call.
- **Carried parts.** Gemini 3 accepts `executableCode`, `codeExecutionResult` and server-side `toolCall` and `toolResponse` parts back, with their signatures, in the order they arrived. Code execution parts carry signatures at all.
- **Native tools beside function declarations.** `googleSearch`, `urlContext` and `codeExecution` work next to function declarations on Gemini 3 with `includeServerSideToolInvocations`, and the response then holds `toolCall` and `toolResponse` parts. On Vertex AI the same combination works without the flag, which the SDK refuses there.
- **`outputSchema` beside tools.** It is accepted on Gemini 3. Gemini 2.x is documented to reject JSON mode alongside function calling.
- **Function-calling modes.** `VALIDATED` mode exists on both the Gemini API and Vertex AI.
- **Thinking.** `thinkingLevel` holds on Gemini 3 ids, and `MINIMAL` is accepted. `includeThoughts` returns `thought: true` parts. Whether thinking counts against `maxOutputTokens` is unconfirmed.
- **Call ids.** It is unconfirmed which platforms return `functionCall.id`, and whether a `functionResponse.id` echo is required where they do.
- **Usage.** `candidatesTokenCount` excludes thoughts, and `promptTokenCount` includes cached tokens.
- **Vertex AI.** Client construction with Application Default Credentials has been run only against a fake.
- **Blocks and grounding.** A blocked stream reports `promptFeedback` in its first chunk. The URLs in `groundingChunks[].web` are what a citation should show. `groundingSupports[].segment` offsets are UTF-8 bytes into the whole answer, also when it streamed; `urlContextMetadata` arrives on the candidate.
