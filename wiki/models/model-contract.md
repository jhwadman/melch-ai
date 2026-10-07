---
type: schema
title: Model contract
description: "The engine's own model contract (lib/models/contract.ts): every field of the message, request, response and adapter types and why it exists, and how each field maps to the wire for Gemini, Anthropic, OpenAI Responses, xAI, Moonshot, Ollama and the gateway."
tags:
  - models
  - contracts
  - runtime
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/contract.ts
  - resource: lib/models/providerState.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/modelContract.test.ts
---

# Model contract

`lib/models/contract.ts` is the format the native runtime speaks to every model ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md), [ADR 0048](/decisions/0048-engine-owned-model-contract.md)): a message format, one request, one response stream, and the adapter interface each provider implements. It is a leaf of types only. Its one import is `ProviderState` ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md)), and nothing in its import graph names `@google/*`, which `tests/modelContract.test.ts` asserts along with a whole tool loop written in the contract. The loader takes `ReasoningSetting` from it.

Adapters move onto the contract in stages. Until an adapter does, it still translates `@google/genai` `Content` as [provider routing](/models/provider-routing.md) describes. The mappings below are what each adapter implements on the contract.

## The adapter rules

```ts
interface ModelAdapter {
  readonly provider: string;   // providerMap id; a gateway reports the upstream's
  readonly model: string;      // the id as the YAML names it
  generate(request: ModelRequest): AsyncIterable<ModelResponse>;
}
```

1. **Partials carry deltas.** A partial response (`partial: true`) holds text and thinking deltas, nothing else. With `stream: false` an adapter yields no text partials, and may yield the thinking as one partial before the final.
2. **One final, last.** Exactly one final response (`partial: false`) ends every call. It repeats every text part in full, because the runtime stores only finals, and carries every tool call and the usage. It never holds thinking: thinking is display-only and stays out of history.
3. **Errors are responses.** A failure is a final response with `error` set, never a throw and never a rejected iterator: a missing key, an HTTP error, a broken stream, a model that thought without answering ([ADR 0027](/decisions/0027-thinking-without-answer-is-an-error.md)).
4. **The signal stops the call.** `request.signal` aborts the request in flight. The call then ends at once, with the adapter's ordinary failure code and `retryable: false`, so no fallback answers a cancellation. The runtime knows it was aborted from its own signal.
5. **Retries stay inside.** Transient failures are retried inside `generate()` under `lib/models/retry.ts`, and only before the first partial is yielded. A retried call is one logical call, with one usage.

## Messages and parts

| Type | Fields | Why |
|---|---|---|
| `SystemMessage` | `role: 'system'`, text parts | An instruction inside the history (a compaction summary, a turn-scoped note). Providers without a system role in the history get its text appended to the system prompt, after `request.system`, in order. |
| `UserMessage` | `role: 'user'`, text and blob parts | What the person sent. |
| `AssistantMessage` | `role: 'assistant'`, text, toolCall, blob and thinking parts | A model's earlier turn: a final response's parts, plus any thinking stored with them. |
| `ToolMessage` | `role: 'tool'`, toolResult parts | The answers to one assistant message's tool calls, one part per call. Each wire regroups them as it needs. |
| `TextPart` | `type: 'text'`, `text` | Text the model wrote, or the person sent. |
| `ThinkingPart` | `type: 'thinking'`, `text` | The model's reasoning as the provider shows it. Display only: its text is never sent to a model. |
| `ToolCallPart` | `type: 'toolCall'`, `id`, `name`, `args` | A client-side tool call. `id` is always set, made by the adapter when the provider returns none. Arguments that do not parse are kept as `{ raw }`. |
| `ToolResultPart` | `type: 'toolResult'`, `id`, `name`, `result`, `isError?` | The answer to the call with the same `id`. `name` is there because Gemini matches results by name. `result` is JSON-serializable, and `isError` marks a failed tool. |
| `BlobPart` | `type: 'blob'`, `mimeType`, and `data` (base64) or `url` | Images, documents and other binary input, inline or by reference. Exactly one of `data` and `url`. |

**`providerState`** may sit on every part kind: the provider-opaque state of [ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md), as `{ provider, kind, model?, payload }`. The adapter that produced a response writes it on the text, toolCall or blob part it belongs before, or on the part the provider attached it to. Only an adapter of the same provider replays it (`providerStateOf`), and only the `kind` it wrote. Every part kind carries the field so a mapping from stored history never loses it. A final response never holds a thinking part, so state is never written on one; a thinking part from stored history keeps its state, which the same rule governs.

A final response's parts are `OutputPart`s: text, toolCall and blob.

## Tools

**`ToolDeclaration`** is `{ name, description, parameters, strict? }`. `parameters` is lowercase JSON Schema (`JsonSchema`), the dialect every provider but Gemini's own requires, so no adapter converts from Gemini's uppercase one. `strict` asks the provider to enforce the schema on the arguments it generates. Where the provider has no such switch, the declaration goes without it.

**`NativeTool`** names a tool the provider runs on its own side: `web_search`, `google_search`, `url_context`, `x_search`, `collections_search`, `code_execution`. A request names them, so no sentinel tool object rides in the tool list. The adapter adds its provider's own tool object, or drops the tool when its path cannot run it. Every drop is stated in advance by `lib/models/capabilities.ts` and marked on the span (`llm.capability.dropped`). Tool options stay deployment configuration that the adapter reads (xAI's domain filters and `XAI_COLLECTION_IDS`), never request fields.

**`ToolChoice`** is `'auto' | 'none' | 'required' | { name }`, default `auto`. It is a preference. An adapter sends it as asked where the provider allows, and weakens `required` or a named tool to `auto` where the provider rejects forcing: Anthropic's Fable 5.1, Opus 5.5 and Sonnet 5.5 reject a forced tool choice, as do Claude models with thinking on. A weakened choice is marked on the span as `llm.tool_choice.weakened`. `none` is always honoured, by sending no tools if need be.

## The request

| Field | Why |
|---|---|
| `model` | The id as the YAML names it. It equals the adapter's own `model`; a fallback wrapper ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)) rewrites it when it hands the request on. The adapter maps it to the wire name (a platform's model map, a gateway's id, `ollama/` stripped). |
| `system` | The system prompt. One string: every provider has one place for it. |
| `messages` | The conversation, oldest first. |
| `tools` | Client-side tools. |
| `nativeTools` | Provider-side tools, by name. |
| `toolChoice` | See above. |
| `outputSchema` | The answer must be one JSON object matching this lowercase JSON Schema. It arrives as the final response's text, and may sit beside tools: the model calls tools, then answers in the schema. |
| `reasoning` | `ReasoningSetting` ([ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md)): `none`, `low`, `medium`, `high`, or `{ budget_tokens }`. Each adapter maps it to its own provider's field, so a fallback model gets its own mapping, never the primary's. Absent means the provider's or the adapter's default. |
| `sampling` | `temperature`, `topP`, `maxOutputTokens`, `stop`. Sent where the model accepts them, dropped where it rejects them (current Claude models refuse sampling fields). Where thinking counts against `maxOutputTokens`, the adapter raises the ceiling to fit. |
| `stream` | Stream deltas as partial responses. |
| `signal` | The turn's `AbortSignal` (`lib/runtime/turnControl.ts`). |

## The response

| Field | Why |
|---|---|
| `partial` | `true` for a delta, `false` for the one final. The two shapes are separate types, so a tool call in a partial or thinking in a final does not type-check. |
| `parts` | Deltas in a partial; the complete answer in the final. |
| `finishReason` | Why the model stopped: `stop`, `tool_call`, `max_tokens`, `content_filter`, `error` or `other`. `tool_call` whenever the final carries a tool call, whatever the provider reported. `content_filter` covers a provider withholding or refusing an answer on policy grounds. With `error` set, it says how the model stopped if it did (`max_tokens` for a reply cut short while thinking), else `error`. |
| `usage` | `inputTokens` counts every input token, cached ones included, and `cacheReadTokens` and `cacheWriteTokens` are parts of it. `outputTokens` counts every generated token, thinking included, and `thinkingTokens` is the part spent thinking. One meaning on every provider, so budgets and the ledger compare across them. A retried call reports the attempts' sum. |
| `grounding` | `citations` (`url`, `title?`, `citedText?`, and `start`/`end` as UTF-16 offsets into the final's concatenated text, end exclusive) and `searchQueries` (`{ tool, query }`, in the order they ran). Provider-neutral and optional. The ledger counts each query as a server-side tool call. |
| `error` | `{ code, message, retryable, status? }`. `retryable` is true when a later attempt or another model may succeed (`lib/models/retry.ts` classifies it); the fallback model answers only retryable failures. `message` is for a person and never carries a key. |

### Error codes

The codes are the ones the adapters emit under ADK, kept verbatim, so a caller matching on a code keeps working (`KnownModelErrorCode`). An adapter the engine does not ship may report its own codes. The engine's own adapters use only these, and adding one changes this page.

| Code | Emitted by | When |
|---|---|---|
| `STEP_LIMIT`, `DEADLINE_EXCEEDED`, `CANCELED` | every adapter | The turn's controls (`lib/runtime/turnControl.ts`) refuse the call at the shared choke point: the step budget is spent, or the turn has stopped. |
| `MISSING_API_KEY` | Claude, GPT, Grok | No key on a provider's own API. |
| `ENDPOINT_MISCONFIGURED` | Claude, GPT | A platform (ADR 0023) that is not fully configured, or its client failed to build. |
| `SDK_NOT_INSTALLED` | Claude, GPT, Grok | The vendor SDK (or a platform's optional peer) is absent. |
| `ANTHROPIC_ERROR` | Claude | The Messages API call failed. |
| `OPENAI_ERROR`, `XAI_ERROR` | GPT, Grok | The Responses call failed. |
| `OPENAI_STREAM_ERROR`, `XAI_STREAM_ERROR` | GPT, Grok | The stream reported `response.failed` or `error`. |
| `MOONSHOT_MISSING_KEY` | Kimi | No `MOONSHOT_API_KEY`. |
| `MOONSHOT_HTTP_ERROR`, `OLLAMA_HTTP_ERROR`, `GATEWAY_HTTP_ERROR` | Kimi, Ollama, gateway | A non-2xx status, with `status` set. |
| `<ID>_UNREACHABLE` | Kimi, Ollama, gateway | The endpoint could not be reached. `<ID>` is `MOONSHOT`, `OLLAMA`, or the gateway's upstream provider (`GEMINI`, `ANTHROPIC`, `OPENAI`, `XAI`, `MOONSHOT`). |
| `<ID>_MAX_TOKENS` | Kimi, Ollama, gateway | Out of tokens before any reply or tool call (ADR 0027). |
| `<ID>_EMPTY_RESPONSE` | Kimi, Ollama, gateway | Stopped after thinking with nothing to say (ADR 0027). |
| `GATEWAY_NOT_CONFIGURED`, `GATEWAY_KEY_MISSING` | gateway | `MODEL_GATEWAY` unknown, or its key absent. |
| `MAX_TOKENS`, `SAFETY`, `RECITATION`, `LANGUAGE`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `MALFORMED_FUNCTION_CALL`, `IMAGE_SAFETY`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `IMAGE_PROHIBITED_CONTENT`, `NO_IMAGE`, `IMAGE_RECITATION`, `IMAGE_OTHER` | Gemini | A candidate with no parts: its finish reason is the code, as ADK reports it. |
| `SAFETY`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY`, `MODEL_ARMOR`, `JAILBREAK` | Gemini | The prompt was blocked: its block reason is the code. |
| `UNKNOWN_ERROR` | Gemini | A response with neither candidates nor prompt feedback. |
| `GEMINI_ERROR` | Gemini | The call failed. ADK throws here. The contract never throws, so this code is the one new one. |

ADK also reports `STOP` as a code for an empty candidate that ended normally, and the turn runner ignores it. On the contract that is a final with no parts and `finishReason: 'stop'`, not an error.

## Capabilities

`ProviderCapabilities` is what an adapter sends for one model on one platform, so the capability matrix (`lib/models/capabilities.ts`, [ADR 0019](/decisions/0019-multi-model-parity-matrix.md)) can be derived from the adapters instead of written beside them. It is per model, because models within one provider differ: Claude 4.6 takes sampling fields that Claude 5.5 rejects. Each field feeds one matrix column:

| Field | Matrix column |
|---|---|
| `tools` | `delegation`, `memory_tools` |
| `outputSchema` | `structured_output` |
| `reasoningState` (providerState replayed across tool steps) | `thinking_with_tools` |
| `streaming` | `streaming` |
| `blobs` (with `mimeTypes`, `urls`, `outsideUserTurns`) | `vision` |
| `nativeTools` (a tool not listed is dropped) | `native_search` (its `web_search`) |
| `toolChoice` (the modes sent as asked) | none: the weakening rule |
| `reasoning` (`level`, `budget`, `effort` or `none`) | none: the ADR 0047 mapping |
| `sampling` (the fields sent) | none |

Each claim is `{ support: 'supported' | 'degraded' | 'unsupported', note? }`, the matrix's own vocabulary.

## Gemini

The Gemini API (`generateContent`, `streamGenerateContent`), on Google AI or Vertex AI. The adapter may call through `@google/genai`; the contract's import graph stays free of it.

| Contract | Wire |
|---|---|
| `system`, system messages | `systemInstruction.parts[].text`, system messages appended in order |
| user / assistant / tool message | `contents[]` with `role: 'user'` / `'model'` / `'user'` |
| `TextPart` | `{ text }` |
| `ThinkingPart` | not sent. Received as `{ text, thought: true }`. |
| `ToolCallPart` | `{ functionCall: { id, name, args } }`. Ids the adapter made start with `adk-`, as ADK's do, so stored history reads the same, and are left off the wire. |
| `ToolResultPart` | `{ functionResponse: { id, name, response } }`. `response` is the result when it is an object, else `{ result }`; with `isError`, `{ error: result }`. |
| `BlobPart` | `{ inlineData: { mimeType, data } }`, or `{ fileData: { mimeType, fileUri } }` for a URL |
| `providerState` | `{ provider: 'gemini', kind: 'thought_signature', model, payload }` ↔ the part's `thoughtSignature`, on the same part, replayed within the current turn. A signature on a thought part moves to the next output part, since a final holds no thinking, and is replayed on that part. |
| `tools` | `tools: [{ functionDeclarations: [{ name, description, parametersJsonSchema }] }]`. The lowercase schema goes as written. `strict` sets `functionCallingConfig.mode: VALIDATED` under `auto`. |
| `nativeTools` | `web_search`, `google_search` → `{ googleSearch: {} }`; `url_context` → `{ urlContext: {} }`; `code_execution` → `{ codeExecution: {} }`. `x_search`, `collections_search` dropped. |
| `toolChoice` | `toolConfig.functionCallingConfig.mode`: `AUTO`, `NONE`, `ANY`; `{ name }` is `ANY` with `allowedFunctionNames: [name]` |
| `outputSchema` | `responseMimeType: 'application/json'` and `responseJsonSchema` |
| `reasoning` | ADR 0047's table: `thinkingConfig.thinkingLevel` (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`) on Gemini 3 and later, `thinkingBudget` on 1.x and 2.x and for any `budget_tokens`; `includeThoughts: true` unless the setting is `none` |
| `sampling` | `temperature`, `topP`, `maxOutputTokens`, `stopSequences` |
| `signal` | `config.abortSignal` |
| `usage` | input `promptTokenCount` + `toolUsePromptTokenCount`; output `candidatesTokenCount` + `thoughtsTokenCount`; thinking `thoughtsTokenCount`; cache read `cachedContentTokenCount` |
| `finishReason` | `STOP` → `stop`; `MAX_TOKENS` → `max_tokens`; `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII` and the `IMAGE_*` reasons → `content_filter`; the rest → `other` |
| `grounding` | `groundingMetadata.webSearchQueries` → `searchQueries`; `groundingChunks[].web` `{ uri, title }` with `groundingSupports[].segment` → `citations`, the segment's UTF-8 byte offsets converted to UTF-16 |
| errors | the Gemini rows of the code table |

## Anthropic

The Messages API, on Anthropic's API or through Bedrock or Vertex AI (ADR 0023).

| Contract | Wire |
|---|---|
| `system`, system messages | `system`, system messages appended in order |
| user / assistant message | `role: 'user'` / `'assistant'` |
| tool message | one `role: 'user'` message holding every `tool_result` of the assistant message before it |
| `TextPart` | `{ type: 'text', text }` |
| `ThinkingPart` | not sent. Received from `thinking` blocks (summaries when `display: 'summarized'`). |
| `ToolCallPart` | `{ type: 'tool_use', id, name, input: args }` |
| `ToolResultPart` | `{ type: 'tool_result', tool_use_id: id, content: <JSON text>, is_error }` |
| `BlobPart` | user turns: `{ type: 'image', source }` for JPEG, PNG, GIF and WebP, where `source` is `{ type: 'base64', media_type, data }` or, for an https URL, `{ type: 'url', url }`. Any other type, or a non-https URL, is dropped with `llm.image.dropped` on the span. |
| `providerState` | `{ provider: 'anthropic', kind: 'thinking_blocks', model, payload }`: the signed `thinking` and `redacted_thinking` blocks, emitted verbatim immediately before the part, on the current turn's assistant messages only (ADR 0046) |
| `tools` | `{ name, description, input_schema: parameters, strict }` |
| `nativeTools` | `web_search` → `{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }` on Claude 4.6 and later, `web_search_20250305` on earlier models; on Anthropic's own API only, never on Bedrock or Vertex AI (`nativeSearchOn`, `lib/models/endpoints.ts`). The rest dropped. |
| `toolChoice` | `{ type: 'auto' }`, `{ type: 'none' }`, `{ type: 'any' }`, `{ type: 'tool', name }`. Weakened to `auto` on Fable 5.1, Opus 5.5 and Sonnet 5.5, and whenever thinking is on. |
| `outputSchema` | `output_config.format: { type: 'json_schema', schema }`; the answer arrives as text |
| `reasoning` | Claude 4.6 and later: `thinking: { type: 'adaptive', display: 'summarized' }` with `output_config.effort` (`low`, `medium`, `high`; a budget becomes the level covering it). `none` is as little as the model allows: thinking omitted where it can be off, `effort: 'low'` where it cannot (Opus 5.5, Fable 5.1), `thinking: { type: 'between_tools' }` on Sonnet 5.5. Earlier models (Haiku 4.5, Sonnet 4.5): `thinking: { type: 'enabled', budget_tokens }` from ADR 0047's table, at least 1,024, with `max_tokens` at least the budget plus 2,048. |
| `sampling` | `max_tokens` (default 4,096); `stop_sequences`; `temperature` and `top_p` only on models that accept them (Claude 4.6 and earlier, thinking off) |
| `stream` | `messages.stream`: `text_delta` → text partial, `thinking_delta` → thinking partial; `finalMessage()` → the final |
| `signal` | the SDK request option `signal` |
| `usage` | input `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`; output `output_tokens`; cache read and write the two cache fields; thinking not reported |
| `finishReason` | `end_turn`, `stop_sequence` → `stop`; `tool_use` → `tool_call`; `max_tokens` → `max_tokens`; `refusal` → `content_filter`. On `pause_turn` the adapter sends the paused turn back and continues inside the same call, summing usage. |
| `grounding` | `web_search_result_location` citations on text blocks → `citations` (`url`, `title`, `cited_text`, the block's span); `server_tool_use` inputs → `searchQueries` |
| errors | `MISSING_API_KEY`, `ENDPOINT_MISCONFIGURED`, `SDK_NOT_INSTALLED`, `ANTHROPIC_ERROR` |

## OpenAI Responses

The Responses API, on OpenAI's API or Azure OpenAI (ADR 0023).

| Contract | Wire |
|---|---|
| `system`, system messages | `instructions`, system messages appended in order |
| user / assistant text | `{ role, content: [{ type: 'input_text' \| 'output_text', text }] }` |
| `ThinkingPart` | not sent. Received from `reasoning` items' `summary`. |
| `ToolCallPart` | `{ type: 'function_call', call_id: id, name, arguments: <JSON text> }` |
| `ToolResultPart` | `{ type: 'function_call_output', call_id: id, output: <JSON text> }`; `isError` has no wire field, so the result says it |
| `BlobPart` | user turns: `{ type: 'input_image', image_url }` (a data URL or the URL), or `{ type: 'input_file' }` for `application/pdf` |
| `providerState` | `{ provider: 'openai', kind: 'reasoning_items', model, payload }`: the `reasoning` items (with `encrypted_content`, asked for by `include: ['reasoning.encrypted_content']`) that preceded the part, replayed as input items before it |
| `tools` | `{ type: 'function', name, description, parameters, strict }`; strict sends the strict form of the schema (`toStrictJsonSchema`) |
| `nativeTools` | `web_search` → `{ type: 'web_search' }`, not sent on Azure. The rest dropped. |
| `toolChoice` | `'auto'`, `'none'`, `'required'`, `{ type: 'function', name }` |
| `outputSchema` | `text.format: { type: 'json_schema', name: 'response', strict: true, schema }` |
| `reasoning` | reasoning ids (`o*`, `gpt-5*`): `reasoning: { effort, summary: 'auto' }`, the effort from ADR 0047's table. Other ids: nothing. A 400 on the param is retried once without it. |
| `sampling` | `max_output_tokens`; `temperature`, `top_p` on non-reasoning ids; `stop` has no field and is dropped |
| `stream` | `response.output_text.delta` → text partial, `response.reasoning_summary_text.delta` → thinking partial, `response.completed` → the final |
| `usage` | input `input_tokens`; cache read `input_tokens_details.cached_tokens`; output `output_tokens`; thinking `output_tokens_details.reasoning_tokens` |
| `finishReason` | `completed` → `stop` or `tool_call`; `incomplete` with `max_output_tokens` → `max_tokens`, with `content_filter` → `content_filter` |
| `grounding` | `url_citation` annotations on `output_text` → `citations`, offsets shifted into the final's text; `web_search_call` actions' `query` → `searchQueries` |
| errors | `MISSING_API_KEY`, `ENDPOINT_MISCONFIGURED`, `SDK_NOT_INSTALLED`, `OPENAI_ERROR`, `OPENAI_STREAM_ERROR` |

## xAI

xAI's Responses API at `https://api.x.ai/v1`: the OpenAI mapping, except as listed.

| Contract | Wire |
|---|---|
| `providerState` | `provider: 'xai'`, the same `reasoning_items` kind |
| `nativeTools` | `web_search` → `{ type: 'web_search' }` plus `XAI_WEB_SEARCH_*` filters; `x_search` → `{ type: 'x_search' }` plus `XAI_X_SEARCH_*` bounds; `collections_search` → `{ type: 'file_search', vector_store_ids, max_num_results }` from `XAI_COLLECTION_IDS`, omitted while that is empty. The rest dropped. |
| `reasoning` | `grok-4.5` and `grok-4.7` only: `reasoning.effort`, `none` sent as `low`, `medium` when the request has none. Other ids: nothing. |
| `grounding` | also `custom_tool_call` items (`x_keyword_search`, `x_semantic_search`) → `searchQueries` with tool `x_search` |
| errors | `MISSING_API_KEY`, `SDK_NOT_INSTALLED`, `XAI_ERROR`, `XAI_STREAM_ERROR` |

The per-attempt timeout (`XAI_TIMEOUT_MS`) and the server-side tool counters on the span stay the adapter's own.

## Chat completions: Moonshot, Ollama and the gateway

The three share `lib/models/openAiCompatibleLlm.ts`, so they share one mapping.

| Contract | Wire |
|---|---|
| `system`, system messages | one `{ role: 'system' }` message first |
| user message | `{ role: 'user', content }`: a string, or text and `{ type: 'image_url', image_url: { url: <data URI> } }` parts |
| assistant message | `{ role: 'assistant', content: <text> \| null, tool_calls: [{ id, type: 'function', function: { name, arguments } }] }` |
| tool message | one `{ role: 'tool', tool_call_id: id, content: <JSON text> }` per result |
| `ThinkingPart` | not sent. Received from `reasoning_content` or `reasoning` fields and `<think>` blocks. |
| `tools` | `{ type: 'function', function: { name, description, parameters, strict } }` |
| `nativeTools` | all dropped |
| `toolChoice` | `tool_choice` where honoured (below); `none` by sending no tools |
| `outputSchema` | `response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } }` |
| `sampling` | `temperature`, `top_p`, `max_tokens`, `stop` |
| `stream` | `stream: true` with `stream_options.include_usage`; tool-call fragments assembled by index |
| `signal` | the `fetch` signal |
| `usage` | input `prompt_tokens`; output `completion_tokens`; thinking `completion_tokens_details.reasoning_tokens`; cache read `prompt_tokens_details.cached_tokens` where reported |
| `finishReason` | `stop` → `stop`; `tool_calls` → `tool_call`; `length` → `max_tokens`; `content_filter` → `content_filter`. `length` or thinking with no reply and no tool call is `<ID>_MAX_TOKENS` or `<ID>_EMPTY_RESPONSE` (ADR 0027). |

**Moonshot** (`https://api.moonshot.ai/v1`, or `MOONSHOT_BASE_URL`). `reasoning`: on K3 `reasoning_effort` (`none` → `low`, `medium` → `high`, the pinned default when absent); on K2.x `thinking: { type: 'disabled' }` for `none`, nothing otherwise. `providerState`: `{ provider: 'moonshot', kind: 'reasoning_content', payload }` on the assistant message's first part, sent back as that message's `reasoning_content` (K3 asks for it on a tool loop). Blobs are base64 only, because Moonshot takes no public image URLs: a URL blob is dropped. `toolChoice`: `auto` and `none` until `required` and a named tool are verified against Moonshot; the others are weakened. Errors: `MOONSHOT_MISSING_KEY`, `MOONSHOT_HTTP_ERROR`, `MOONSHOT_UNREACHABLE`, `MOONSHOT_MAX_TOKENS`, `MOONSHOT_EMPTY_RESPONSE`.

**Ollama** (`OLLAMA_BASE_URL`, default `http://localhost:11434/v1`, keyless; `ollama/` stripped from the id). `outputSchema` goes as `response_format: { type: 'json_object' }`: the schema is not enforced, which is degraded support. `reasoning`: `reasoning_effort` as the level word. Only `none` changes anything on Ollama, and a reply that thought without answering is retried once with `none` (`OLLAMA_RETRY_WITHOUT_THINKING`). `toolChoice`: `auto` and `none`. A vision model takes blobs as data URIs. Writes no `providerState`. Errors: `OLLAMA_HTTP_ERROR`, `OLLAMA_UNREACHABLE`, `OLLAMA_MAX_TOKENS`, `OLLAMA_EMPTY_RESPONSE`.

**The gateway** (`MODEL_GATEWAY`, Vercel AI Gateway or OpenRouter). The wire id comes from `gatewayWireModel` and `MODEL_GATEWAY_MODEL_MAP`. `provider` is the upstream's, for attribution, and `llm.transport` names the gateway. Because its provider id is the upstream's, the gateway adapter reads no `providerState`: a chat-completions wire has no place for Claude's signed blocks or OpenAI's reasoning items. `reasoning`: `reasoning_effort` as the level word, the one field every gateway reads. `toolChoice`: as asked, and upstream support varies. Errors: `GATEWAY_NOT_CONFIGURED`, `GATEWAY_KEY_MISSING`, `GATEWAY_HTTP_ERROR`, and `<UPSTREAM>_UNREACHABLE`, `<UPSTREAM>_MAX_TOKENS`, `<UPSTREAM>_EMPTY_RESPONSE`.

## From genai Content

Stored sessions and the ADK path hold `@google/genai` `Content`. The mapping between them and the contract is one-to-one:

- Roles: `user` → user, `model` → assistant. A `user` content holding only `functionResponse` parts → tool. ADK's `system` contents → system.
- Parts: `text` → text, `{ text, thought: true }` → thinking, `functionCall` → toolCall, `functionResponse` → toolResult, `inlineData` / `fileData` → blob.
- State: `providerState` copied as it is; Gemini's `thoughtSignature` ↔ `providerState` of kind `thought_signature`.
- Usage: `usageMetadata` ↔ `Usage` under the meanings above.
- Errors: `errorCode` / `errorMessage` ↔ `error`.

The stored Event JSON keeps its shape ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)).

## What the contract leaves out

These `generateContentConfig` fields have no contract field: `topK`, `seed`, `presencePenalty`, `frequencyPenalty`, `candidateCount`, `safetySettings`, `responseMimeType` without a schema (JSON mode), `includeThoughts`, and effort words outside the four levels (`minimal`, `xhigh`, `max`). The older spelling's `thinkingBudget` maps to `{ budget_tokens }`, and its effort words that are levels map to the level. An agent that sets any of the rest has it only on the ADK runtime. Live bidirectional connections are outside the contract.
