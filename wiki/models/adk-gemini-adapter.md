---
type: model-provider
title: Gemini wrapper over ADK
description: "AdkGeminiAdapter (lib/models/adkGeminiAdapter.ts): a temporary contract ModelAdapter that serves Gemini through ADK's own Gemini (TracedGemini) and the genai mapping, until GeminiAdapter passes its live parity run at gate G3. How the request is shaped, the span recorded around it, how ADK's responses fold into the contract's stream, its failures, and where it differs from GeminiAdapter."
tags:
  - models
  - gemini
  - runtime
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/adkGeminiAdapter.ts
  - resource: lib/models/genaiMapping.ts
  - resource: lib/models/tracedGemini.ts
  - resource: lib/models/registry.ts
  - resource: lib/models/adkShim.ts
  - resource: lib/observability/tracer.ts
  - resource: tests/adkGeminiAdapter.test.ts
  - resource: tests/telemetryLedger.test.ts
---

# Gemini wrapper over ADK

`AdkGeminiAdapter` in `lib/models/adkGeminiAdapter.ts` is Gemini as a contract `ModelAdapter` ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)) built on ADK's own `Gemini`: it maps the request to an `LlmRequest`, runs it through `TracedGemini` (`lib/models/tracedGemini.ts`), and maps each `LlmResponse` back.

It is temporary. The native loop ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)) calls only `ModelAdapter`s, and the engine's own [Gemini adapter](/models/gemini-adapter.md) waits for its live run at gate G3. Until then Gemini on the native runtime goes through ADK's Gemini, which serves every Gemini id today, so every provider has a contract adapter before gate G1. Once G3 is signed and `GeminiAdapter` serves the Gemini ids, this module is deleted. `resolveAdapter` (`lib/models/registry.ts`) returns it for every Gemini id unless `GEMINI_ADAPTER=engine` or the option `{ gemini: 'engine' }` asks for `GeminiAdapter` ([provider routing](/models/provider-routing.md), [ADR 0060](/decisions/0060-engine-owned-registry.md)).

```ts
new AdkGeminiAdapter({ model, apiKey?, endpoint? })
```

The key and the endpoint resolve as `GeminiAdapter`'s do: `apiKey`, then the endpoint's key, then `GOOGLE_GENAI_API_KEY`, `GOOGLE_API_KEY` and `GEMINI_API_KEY`. The endpoint defaults to `endpointFromEnv('gemini')`, read on the first call. `TracedGemini` applies the platform ([ADR 0023](/decisions/0023-bring-your-own-endpoint.md)), so on Vertex AI no AI Studio key is sent.

## The request

`modelRequestToLlmRequest` ([model contract](/models/model-contract.md#the-reverse-directions)) builds the `LlmRequest`. The adapter then does what ADK's path does before its `Gemini` sees one:

- **System messages** join the system prompt, in order, as `systemInstruction.parts`, since Gemini takes no `system` content.
- **`adk-` call ids** come off calls and results, as ADK's flow strips its own ids before every model call. Ids the mapping minted are already off.
- **`includeServerSideToolInvocations`** is set, as the compiler sets it on every Gemini agent (`lib/compile.ts`).
- **`includeThoughts`** is added under any reasoning but `none`, as the contract's Gemini table has it.
- **The wire model** is `platformModel(endpoint, model)`, so `GEMINI_MODEL_MAP` applies.

Parts are copied where ADK writes to them (it clears a blob's display name in place), so the caller's history is never changed. `providerState` and the effort word never reach the wire: the SDK serializes a part and a config field by field.

## The span

The adapter opens no `llm.request` span and never charges the turn's step budget: its caller does both ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)), under ADK the [ADK shim](/models/adk-shim.md), through `traceLlmGeneration` with the `ModelRequest` it hands the adapter. A spent or stopped turn is refused there and never reaches the adapter. The adapter honours `request.signal`, which the shim aborts when the turn stops, and reads no turn state itself.

Inside the open span, `TracedGemini.generateWithRetries` runs ADK's `Gemini` with the shared retries (`lib/models/retry.ts`) and tags it: `llm.web_search.native` for grounding, `llm.retries` and `llm.http_status`. `TracedGemini.generateContentAsync` is the same call inside a span of its own. So behind the shim one exchange records the `llm.request` span `TracedGemini` records today: the same attribute names, and for an answer the same values and events. `tests/telemetryLedger.test.ts` asserts it. A failed call differs in its code: `GEMINI_ERROR` beside `llm.http_status`, as every other adapter's error reads, where the ADK path reads genai's status out of the thrown body (`503`) and records the throw as an `exception` event. The adapter also adds `llm.capability.dropped` for `x_search` and `collections_search`, which Gemini has no tool for, with one warning per tool.

## The response

ADK's `Gemini` yields one `LlmResponse` for a call that does not stream. For a stream, its aggregator yields each chunk as a partial, and a non-partial response with the text so far before each tool call and at the end. The adapter folds them:

- **Partials.** A streamed partial's text and thinking become a contract partial. A call that does not stream yields its thinking as one partial before the final.
- **One final.** Every non-partial response's parts, with the last usage, grounding and finish reason, are mapped once by `llmResponseToModelResponse`. Thinking stays out of the final. Text that arrived in the same chunk as a tool call reaches only the final, as ADK's aggregator flushes it there.
- **Ids.** A call Gemini returns without an id gets `genai-noid-<position>-<part>`, where position is the conversation's length. A streamed call has ADK's own `adk-` id. Neither goes back on the wire.
- **Signatures.** A thought signature becomes `providerState` of kind `thought_signature`, naming the request's model ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md)).
- **Grounding.** `groundingMetadata` becomes the final's `grounding`: each cited page once, with its title, and the search queries, attributed to `web_search` (or `google_search` when the request named only that).
- **Code execution.** `executableCode` and `codeExecutionResult` parts read as the mapping reads them: text, with the part carried whole for Gemini to receive back.

## Failures

Every call ends with exactly one final. A failure is that final with `error` set, never a throw.

| Case | `error.code` | `retryable` |
|---|---|---|
| No key on the Gemini API | `MISSING_API_KEY` | false |
| Vertex AI without a project or a location, a platform Gemini lacks, or ADK's `Gemini` fails to build | `ENDPOINT_MISCONFIGURED` | false |
| ADK's `Gemini` threw (genai's `ApiError`, a network error) | `GEMINI_ERROR`, with `status` when the error had one | `lib/models/retry.ts`'s `classifyError` |
| The signal aborted, before or during the call | `GEMINI_ERROR` | false |
| A code ADK yields: a candidate with no parts (its finish reason), a blocked prompt (its block reason), `UNKNOWN_ERROR`, a stream that ended on a reason other than `STOP` | that code | false |

ADK's `STOP` for an empty candidate is no error: a final with no parts and `finishReason: 'stop'`. A message never carries the key in use or anything shaped like a key. The abort also ends the iteration at once, so a stalled transport never holds the caller, and a signal aborted before the call sends nothing. A failure keeps the parts that arrived before it.

## Where it differs from GeminiAdapter

These are ADK's behaviours, kept, and they are what G3's swap to `GeminiAdapter` changes:

- **Replay.** Every Gemini signature in the history goes back on its part, as ADK sends a stored session's, whichever turn or model wrote it. `GeminiAdapter` replays only the current turn's, for its own model.
- **A withheld answer.** A policy finish (`SAFETY` and the rest) is an error only where ADK makes it one: on a candidate with no parts, or at the end of a stream. A non-streamed answer with text keeps it, with `finishReason: 'content_filter'`. `GeminiAdapter` always reports the error.
- **Messages.** genai does not carry a candidate's `finishMessage`, so an error ADK yields reads `The model call ended with <code>.`
- **`includeServerSideToolInvocations`** is always sent; `GeminiAdapter` sends none.
- **The turn's signal.** This adapter reads only `request.signal`; `GeminiAdapter` falls back to the turn's.
- **Code execution and server-side tool parts** reach the final, carried whole; `GeminiAdapter` leaves them out until WS3-1b.

## What the offline tests assert

`tests/adkGeminiAdapter.test.ts` runs the whole path, from the adapter through ADK's `Gemini` to the real `@google/genai` client, over a stubbed `fetch`. It asserts the JSON that would reach the Gemini API and the responses that come back:

- a non-streamed answer with its thinking partial, and a streamed one;
- a tool call whose thought signature is replayed on the next step, with no minted id on the wire;
- tool choice and strict tools, `adk-` ids and another provider's state kept off the wire, and the caller's history unchanged;
- grounding, with `googleSearch` sent and `x_search` marked dropped;
- a 503 retried and then reported retryable, a 400 reported at once without its key, the error codes ADK yields, and `STOP`;
- an abort before and during the call, and a transport that ignores it;
- the setup failures, and that the adapter alone opens no span;
- behind the ADK shim: one span per call carrying the adapter's tags, one charge, and a spent step budget that never reaches the adapter.

`tests/telemetryLedger.test.ts` runs one exchange through `TracedGemini` and through this adapter behind the shim, and compares the two `llm.request` spans.
