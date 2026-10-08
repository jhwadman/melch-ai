---
type: schema
title: Model contract
description: "The engine's own model contract (lib/models/contract.ts): every field of the message, request, response and adapter types and why it exists, how each field maps to the wire for Gemini, Anthropic, OpenAI Responses, xAI, Moonshot, Ollama and the gateway, and how it maps to and from @google/genai Content and the LlmRequest and LlmResponse shapes the stored events and the loop's requests keep, in both directions (lib/models/genaiMapping.ts)."
tags:
  - models
  - contracts
  - runtime
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/models/contract.ts
  - resource: lib/runtime/valueDepth.ts
  - resource: lib/models/providerState.ts
  - resource: lib/models/claudeModels.ts
  - resource: lib/models/capabilities.ts
  - resource: lib/models/schemaNormalize.ts
  - resource: lib/tools/tool.ts
  - resource: tests/modelContract.test.ts
  - resource: tests/contractToolDeclarations.test.ts
  - resource: lib/models/genaiMapping.ts
  - resource: lib/models/geminiState.ts
  - resource: tests/genaiMapping.test.ts
  - resource: lib/models/claudeAdapter.ts
  - resource: lib/models/gptAdapter.ts
  - resource: lib/models/grokAdapter.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: tests/chatCompletionsAdapter.test.ts
---

# Model contract

`lib/models/contract.ts` is the format the native runtime speaks to every model ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md), [ADR 0048](/decisions/0048-engine-owned-model-contract.md)): a message format, one request, one response stream, and the adapter interface each provider implements. It is a leaf of types only. Its one import is `ProviderState` ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md)), and nothing in its import graph names `@google/*`, which `tests/modelContract.test.ts` asserts along with a whole tool loop written in the contract. The loader takes `ReasoningSetting` from it. A consumer imports the types from `melchizedek-agents/models/contract`, or with every adapter and `resolveAdapter` from `melchizedek-agents/model` ([ADR 0068](/decisions/0068-model-entry-without-adk.md)).

Every adapter the engine ships implements the contract, and the native runtime, the engine's only one ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)), calls it directly. The mappings below are what each adapter implements on the contract. `lib/models/genaiMapping.ts` converts between genai `Content` and the contract both ways ([From genai Content](#from-genai-content)), so the native runtime reads stored sessions, which keep ADK's event shape, and the Gemini adapter speaks genai.

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

### Building declarations

`lib/models/schemaNormalize.ts` builds both from the tools the registry resolves, so neither an adapter nor the runtime reads a tool's private fields ([ADR 0019](/decisions/0019-multi-model-parity-matrix.md)) or keeps its own dialect converter:

- **`contractToolDeclaration(tool, { strict? })`** returns a `ToolDeclaration`, or undefined for a tool that declares nothing.
  - An own Tool ([tool contracts](/tools/tool-contracts.md), `lib/tools/tool.ts`) is declared by its own `declaration()`. A `defineTool` contract builds that from its zod schema through `zodToolParameters`, from the same `zodInputJsonSchema` step the MCP surface uses and never through Gemini's dialect: the schema's input side (`io: 'input'`), so a field with a default is optional, without the `default` keyword or an `additionalProperties` that is only `true` or `false`, and with a record's value schema kept. `toGeminiSchema` (Gemini's dialect, which the MCP parameters pass through) makes the same choices, walking by keyword as this path does.
  - A tool object that is not an own Tool but has a `_getDeclaration()` (a declaration-only entry in an `LlmRequest`'s `toolsDict`, ADK's tool shape) is read from it: its `parameters`, or else its `parametersJsonSchema`. Gemini's dialect is converted once, here: types are lowercased, and the int64 bounds Gemini spells as strings (`minLength: '2'`) become integers. OpenAPI's `nullable: true` becomes a schema that admits null. A plain typed node gains `null` in its type (`['number', 'null']`) and in any `enum`. A bare `anyOf` gains a `{ type: 'null' }` branch. A node built otherwise (`$ref`, `allOf`, `oneOf`, `const`) moves into an `anyOf` beside `{ type: 'null' }`, with its description staying on the node.
  - The walk follows only the keywords that hold schemas (`properties`, `items`, `prefixItems`, `anyOf`, `oneOf`, `allOf`, `$defs`, and the rest), so a parameter named `type`, `enum` or `default` is converted like any other, and `enum`, `const` and `examples` stay data.
  - With `strict`, every object node that has properties, at any depth, lists all of them as `required` and sets `additionalProperties: false`, and the declaration carries `strict: true`. An optional property becomes required as it is, not widened to null, because the contract's zod schema would refuse a null. An object without properties (a map) is left open, so a strict provider refuses it rather than receive a field the model can never fill. `toContractJsonSchema(schema, { strict? })` is the same conversion for any schema, such as an `outputSchema`.
- **`nativeToolOf(tool)`** returns the `NativeTool` a tool object stands for, by marker rather than by class or shape, and every marker lives in the global symbol registry, so a second copy of a module still matches ([ADR 0062](/decisions/0062-server-side-tools-as-markers.md)). The engine's own marker (`melchizedek.nativeTool`) names it on a NativeToolMarker. The markers ADK sets on its built-in code executor and on its `GOOGLE_SEARCH` and `URL_CONTEXT` read as `code_execution`, `google_search` and `url_context`. A client-side tool registered under one of those names carries no marker and stays client-side, as does a tool that merely declares nothing.

Every tool the registry resolves is one or the other, except `preload_memory`, which writes memory into the instruction and declares nothing (`tests/contractToolDeclarations.test.ts`). `toLowercaseJsonSchema` and `toStrictJsonSchema` are the lower-level steps the adapters share.

**`ToolChoice`** is `'auto' | 'none' | 'required' | { name }`, default `auto`. It is a preference. An adapter sends it as asked where the provider allows, and weakens `required` or a named tool where the provider rejects forcing: Anthropic's Fable 5.1, Opus 5.5 and Sonnet 5.5 reject a forced tool choice, as do Claude models with thinking on. A weakened `required` becomes `auto`; a weakened named tool becomes `required` where the provider forces that (Kimi K3, which refuses a named tool while it thinks), else `auto`. A weakened choice is marked on the span as `llm.tool_choice.weakened`. `none` is always honoured, by sending no tools if need be.

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
| `outputFormat` | `'json'`: the answer is one JSON object, with no schema to hold it to, the provider's JSON mode ([ADR 0061](/decisions/0061-json-mode-on-the-contract.md)). It arrives as the final response's text. `outputSchema` says more and wins when both are set. A provider with no JSON mode sends nothing for it (Anthropic). Absent means plain text. |
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

The codes keep the spelling ADK's model classes used, so a caller matching on a code, or a stored event carrying one, keeps working (`KnownModelErrorCode`). An adapter the engine does not ship may report its own codes. The engine's own adapters use only these, and adding one changes this page.

| Code | Emitted by | When |
|---|---|---|
| `STEP_LIMIT`, `DEADLINE_EXCEEDED`, `CANCELED` | every adapter's caller | The turn's controls (`lib/runtime/turnControl.ts`) refuse the call at the shared choke point, before it reaches the adapter: the step budget is spent, or the turn has stopped. An adapter on the contract never emits them; the code that calls it does ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)), the loop's model step (`lib/runtime/native/step.ts`). |
| `MISSING_API_KEY` | Claude, GPT, Grok, Gemini | No key on a provider's own API. |
| `ENDPOINT_MISCONFIGURED` | Claude, GPT, Grok, Gemini | A platform (ADR 0023) that is not fully configured, or its client failed to build. |
| `SDK_NOT_INSTALLED` | Claude, GPT, Grok | The vendor SDK (or a platform's optional peer) is absent. |
| `ANTHROPIC_ERROR` | Claude | The Messages API call failed. |
| `OPENAI_ERROR`, `XAI_ERROR` | GPT, Grok | The Responses call failed, an SSE frame named `error` included (the SDK throws it, with no HTTP status). |
| `OPENAI_STREAM_ERROR`, `XAI_STREAM_ERROR` | GPT, Grok | The stream reported `response.failed` or an `error` event. `retryable` when the event names a status `lib/models/retry.ts` retries, or the code or type `server_error`, `rate_limit_exceeded` or `vector_store_timeout`, which also decide a thrown `error` frame. |
| `MOONSHOT_MISSING_KEY` | Kimi | No `MOONSHOT_API_KEY`. |
| `MOONSHOT_HTTP_ERROR`, `OLLAMA_HTTP_ERROR`, `GATEWAY_HTTP_ERROR` | Kimi, Ollama, gateway | A non-2xx status, with `status` set. |
| `<ID>_UNREACHABLE` | Kimi, Ollama, gateway | The endpoint could not be reached. `<ID>` is `MOONSHOT`, `OLLAMA`, or the gateway's upstream provider (`GEMINI`, `ANTHROPIC`, `OPENAI`, `XAI`, `MOONSHOT`). |
| `<ID>_MAX_TOKENS` | Kimi, Ollama, gateway | Out of tokens before any reply or tool call (ADR 0027). |
| `<ID>_EMPTY_RESPONSE` | Kimi, Ollama, gateway | Stopped after thinking with nothing to say (ADR 0027). |
| `GATEWAY_NOT_CONFIGURED`, `GATEWAY_KEY_MISSING` | gateway | `MODEL_GATEWAY` unknown, or its key absent. |
| `MAX_TOKENS`, `SAFETY`, `RECITATION`, `LANGUAGE`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `MALFORMED_FUNCTION_CALL`, `IMAGE_SAFETY`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `IMAGE_PROHIBITED_CONTENT`, `NO_IMAGE`, `IMAGE_RECITATION`, `IMAGE_OTHER` | Gemini | A candidate with no parts: its finish reason is the code, as ADK reports it. |
| `SAFETY`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY`, `MODEL_ARMOR`, `JAILBREAK` | Gemini | The prompt was blocked: its block reason is the code. |
| `UNKNOWN_ERROR` | Gemini | A response with neither candidates nor prompt feedback. |
| `GEMINI_ERROR` | Gemini | The call failed. The contract never throws, so the failure is this code. |

ADK's Gemini reported `STOP` as a code for an empty candidate that ended normally, which a stored event may carry and the turn runner ignores. On the contract that is a final with no parts and `finishReason: 'stop'`, not an error.

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
| `ToolCallPart` | `{ functionCall: { id, name, args } }`. Ids the adapter made start with `adk-`, as ADK's do, so stored history reads the same, and are left off the wire, as are the ids the genai mapping minted (`genai-noid-`). |
| `ToolResultPart` | `{ functionResponse: { id, name, response } }`. `response` is the result when it is an object, else `{ result }`; with `isError`, `{ error: result }`. |
| `BlobPart` | `{ inlineData: { mimeType, data } }`, or `{ fileData: { mimeType, fileUri } }` for a URL |
| `providerState` | `{ provider: 'gemini', kind: 'thought_signature', model, payload }` ↔ the part's `thoughtSignature`, on the same part, replayed within the current turn. A signature on a thought part moves to the next output part, since a final holds no thinking, and is replayed on that part. `{ provider: 'gemini', kind: 'carried_parts', model, payload: { before, signature? } }` ↔ the `executableCode`, `codeExecutionResult` and server-side `toolCall` and `toolResponse` parts before the part, whole, and the part's own signature; replayed before it within the current turn ([ADR 0065](/decisions/0065-gemini-carried-parts-and-server-side-invocations.md)). The genai mapping (`partsToGenai`) writes such a part out as the carried parts, verbatim, then the part with its own signature, so a stored event holds what Gemini sent; read back, each is `genai_part` state, which the Gemini adapter replays as the part itself within the current turn ([ADR 0100](/decisions/0100-gemini-row-asserted-on-the-engine-adapter.md)). |
| `tools` | `tools: [{ functionDeclarations: [{ name, description, parametersJsonSchema }] }]`. The lowercase schema goes as written. `strict` sets `functionCallingConfig.mode: VALIDATED` under `auto`. |
| `nativeTools` | `web_search`, `google_search` → `{ googleSearch: {} }`; `url_context` → `{ urlContext: {} }`; `code_execution` → `{ codeExecution: {} }`. `x_search`, `collections_search` dropped. |
| `toolChoice` | `toolConfig.functionCallingConfig.mode`: `AUTO`, `NONE`, `ANY`; `{ name }` is `ANY` with `allowedFunctionNames: [name]`. Native tools beside function declarations add `toolConfig.includeServerSideToolInvocations: true` on the Gemini API; the SDK refuses it for Vertex AI. |
| `outputSchema` | `responseMimeType: 'application/json'` and `responseJsonSchema` |
| `outputFormat` | `'json'` without a schema: `responseMimeType: 'application/json'` alone |
| `reasoning` | ADR 0047's table: `thinkingConfig.thinkingLevel` (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`) on Gemini 3 and later, `thinkingBudget` on 1.x and 2.x and for any `budget_tokens`; `includeThoughts: true` unless the setting is `none` |
| `sampling` | `temperature`, `topP`, `maxOutputTokens`, `stopSequences` |
| `signal` | `config.abortSignal`; the adapter reads no other signal |
| `usage` | input `promptTokenCount` + `toolUsePromptTokenCount`; output `candidatesTokenCount` + `thoughtsTokenCount`; thinking `thoughtsTokenCount`; cache read `cachedContentTokenCount` |
| `finishReason` | `STOP` → `stop`; `MAX_TOKENS` → `max_tokens`; `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII` and the `IMAGE_*` reasons → `content_filter`; the rest → `other` |
| `grounding` | `groundingMetadata.webSearchQueries` → `searchQueries`; `groundingChunks[].web` `{ uri, title }` with `groundingSupports[].segment` → `citations`, the segment's UTF-8 byte offsets converted to UTF-16; `urlContextMetadata.urlMetadata[]` retrieved → `citations` without a span |
| errors | the Gemini rows of the code table |

## Anthropic

The Messages API, on Anthropic's API or through Bedrock or Vertex AI (ADR 0023). `ClaudeAdapter` (`lib/models/claudeAdapter.ts`) implements it; the [Claude adapter](/models/claude-adapter.md) page records its choices.

| Contract | Wire |
|---|---|
| `system`, system messages | `system`, system messages appended in order |
| user / assistant message | `role: 'user'` / `'assistant'` |
| tool message | one `role: 'user'` message holding every `tool_result` of the assistant message before it |
| `TextPart` | `{ type: 'text', text }` |
| `ThinkingPart` | not sent. Received from `thinking` blocks (summaries when `display: 'summarized'`). |
| `ToolCallPart` | `{ type: 'tool_use', id, name, input: args }` |
| `ToolResultPart` | `{ type: 'tool_result', tool_use_id: id, content, is_error: true }`, `is_error` only on a failure. `content` is the JSON text of the result in the shape a stored event holds it: the result when it is an object, else `{ result }`, and `{ error: result }` for a failure ([ADR 0055](/decisions/0055-claude-adapter-keeps-the-adk-request.md)). |
| `BlobPart` | user turns: `{ type: 'image', source }` for JPEG, PNG, GIF and WebP, where `source` is `{ type: 'base64', media_type, data }` or, for an https URL, `{ type: 'url', url }`. A blob typed `application/octet-stream` (the genai mapping's type for a part that names none) is untyped: inline data is sent as `image/png`, and a URL is typed by its extension. Any other type, or a non-https URL, is dropped with `llm.image.dropped` on the span; so is a URL on Bedrock and Vertex AI, which take base64 only. |
| `providerState` | `{ provider: 'anthropic', kind: 'thinking_blocks', model, payload }`: the signed `thinking` and `redacted_thinking` blocks, emitted verbatim immediately before the part, on the current turn's assistant messages only (ADR 0046) |
| `tools` | `{ name, description, input_schema: parameters }`; a `strict` declaration sends the strict form of its schema (`toContractJsonSchema(parameters, { strict: true })`) and `strict: true` |
| `nativeTools` | `web_search` → `{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }` on every model; on Anthropic's own API only, never on Bedrock or Vertex AI (`nativeSearchOn`, `lib/models/endpoints.ts`). The rest dropped, named in `llm.capability.dropped`. |
| `toolChoice` | `auto` sends no `tool_choice` (the API's default); `none` → `{ type: 'none' }`; `required` → `{ type: 'any' }`; `{ name }` → `{ type: 'tool', name }`. Only when a tool is sent. A forced choice is weakened to `auto` on Fable 5.1, Opus 5.5 and Sonnet 5.5, and whenever the setting thinks, and the span carries `llm.tool_choice.weakened` (`required` or `named`). |
| `outputSchema` | `output_config.format: { type: 'json_schema', schema }` on Opus 4.8 and later, Sonnet 5 and later, Haiku 5.5, Fable and Mythos; the answer arrives as text. Claude 4.6 and earlier, Opus 4.7, and a schema the SDK's transform refuses: a `structured_output` tool whose input schema is the schema, forced where the model takes forcing, the setting does not think and no other tool is sent, else offered under `auto`; its call comes back as the answer's text ([ADR 0049](/decisions/0049-claude-requests-by-model-generation.md)). |
| `outputFormat` | nothing: the Messages API has no JSON mode without a schema. The prompt asks for the JSON. |
| `reasoning` | By model generation (`lib/models/claudeModels.ts`, [ADR 0049](/decisions/0049-claude-requests-by-model-generation.md)). Claude 4.6 and earlier (Opus 4.6, Sonnet 4.6, Haiku 4.5 and older): `thinking: { type: 'enabled', budget_tokens }` from ADR 0047's table, at least 1,024, with `max_tokens` at least the budget plus 2,048; `none` sends no `thinking`. Later models: `thinking: { type: 'adaptive', display: 'summarized' }` with `output_config.effort` (`low`, `medium`, `high`; a budget becomes the level covering it), with `max_tokens` at least the level's budget, or the budget given, plus 2,048. `none` is the model's off switch at `effort: 'low'`: `{ type: 'disabled' }` on Opus 4.7 and 4.8, Sonnet 5 and Haiku 5.5, `{ type: 'between_tools' }` on Sonnet 5.5; adaptive thinking at `low` on Opus 5, Opus 5.5, Fable and Mythos. Absent: the model's default, which thinks on every later model but Opus 4.7 and 4.8. |
| `sampling` | `max_tokens` from `maxOutputTokens` (default 4,096), raised to fit thinking. No `temperature`, `top_p`, `top_k` or `stop_sequences` is sent on any generation ([ADR 0049](/decisions/0049-claude-requests-by-model-generation.md)). |
| `stream` | `messages.stream`: `text_delta` → text partial, `thinking_delta` → thinking partial; `finalMessage()` → the final |
| `signal` | the SDK request option `signal`; the adapter also ends the call at once when it aborts |
| `usage` | input `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`; output `output_tokens`; cache read and write the two cache fields, when above 0; thinking not reported. The adapter sends no `cache_control`, so Anthropic caches nothing and both are 0. |
| `finishReason` | `tool_call` whenever the final carries a tool call; else `end_turn`, `stop_sequence` and a `tool_use` that was the structured-output answer → `stop`; `max_tokens`, `model_context_window_exceeded` → `max_tokens`; `refusal` → `content_filter`; `pause_turn` → `other`, with the paused turn's content so far, which the adapter does not continue. None of these is an error. |
| `grounding` | `web_search_result_location` citations on text blocks → `citations` (`url`, `title`, `cited_text`, the block's span in the final's text); `server_tool_use` inputs → `searchQueries` |
| errors | `MISSING_API_KEY`, `ENDPOINT_MISCONFIGURED`, `SDK_NOT_INSTALLED`, `ANTHROPIC_ERROR` |

## OpenAI Responses

The Responses API, on OpenAI's API or Azure OpenAI (ADR 0023).

| Contract | Wire |
|---|---|
| `system`, system messages | `instructions`, system messages appended in order |
| user / assistant text | `{ role, content: [{ type: 'input_text' \| 'output_text', text }] }` |
| `ThinkingPart` | not sent. Received from `reasoning` items' `summary`. |
| `ToolCallPart` | `{ type: 'function_call', call_id: id, name, arguments: <JSON text> }` |
| `ToolResultPart` | `{ type: 'function_call_output', call_id: id, output: <JSON text> }`, the text being genai's `functionResponse.response`: `{ error: result }` with `isError`, the result when it is an object, else `{ result }` |
| `BlobPart` | user turns: `{ type: 'input_image', image_url }`, a data URL (a blob typed `application/octet-stream`, which is how the genai mapping types an untyped part, as `image/png`) or an https URL; `application/pdf` as `{ type: 'input_file' }` with `filename` and `file_data` (a data URL), or `file_url`. A URL that is not https is not sent, and the span carries `llm.image.dropped`. |
| `providerState` | `{ provider: 'openai', kind: 'reasoning_items', model, payload }`: the `reasoning` items (with `encrypted_content`, asked for by `include: ['reasoning.encrypted_content']`) that preceded the part, replayed as input items before it |
| `tools` | `{ type: 'function', name, description, parameters, strict }`; strict sends the strict form of the schema (`toContractJsonSchema(parameters, { strict: true })`) |
| `nativeTools` | `web_search` → `{ type: 'web_search' }`, not sent on Azure. The rest dropped. |
| `toolChoice` | `'auto'`, `'none'`, `'required'`, `{ type: 'function', name }`, sent only beside tools |
| `outputSchema` | `text.format: { type: 'json_schema', name: 'response', strict: true, schema }`, the schema in its strict form |
| `outputFormat` | `'json'` without a schema: `text.format: { type: 'json_object' }` |
| `reasoning` | reasoning ids (`o*`, `gpt-5*`): `reasoning: { effort, summary: 'auto' }`, the effort from ADR 0047's table. Other ids: nothing. A 400 on the param is retried once without it. |
| `sampling` | `max_output_tokens`; `temperature`, `top_p` on non-reasoning ids; `stop` has no field and is dropped |
| `stream` | `response.output_text.delta` → text partial, `response.reasoning_summary_text.delta` → thinking partial, `response.completed` → the final. A stream that ends without `response.completed` ends with a final holding the streamed text. |
| `usage` | input `input_tokens`; cache read `input_tokens_details.cached_tokens`; output `output_tokens`; thinking `output_tokens_details.reasoning_tokens` |
| `finishReason` | `completed` → `stop` or `tool_call`; `incomplete` with `max_output_tokens` → `max_tokens`, with `content_filter` → `content_filter` |
| `grounding` | `url_citation` annotations on `output_text` → `citations`, the API's character offsets converted to UTF-16 and shifted into the final's text; `web_search_call` actions' `queries` (or the older `query`) → `searchQueries` |
| errors | `MISSING_API_KEY`, `ENDPOINT_MISCONFIGURED`, `SDK_NOT_INSTALLED`, `OPENAI_ERROR`, `OPENAI_STREAM_ERROR` |

## xAI

xAI's Responses API at `https://api.x.ai/v1`: the OpenAI mapping, except as listed.

| Contract | Wire |
|---|---|
| `providerState` | `provider: 'xai'`, the same `reasoning_items` kind |
| `nativeTools` | `web_search` → `{ type: 'web_search' }` plus `XAI_WEB_SEARCH_*` filters; `x_search` → `{ type: 'x_search' }` plus `XAI_X_SEARCH_*` bounds; `collections_search` → `{ type: 'file_search', vector_store_ids, max_num_results }` from `XAI_COLLECTION_IDS`, omitted while that is empty. The rest dropped. |
| `reasoning` | `grok-4.5`, `grok-4.6` and `grok-4.7` only: `reasoning.effort`, `none` sent as `low`, `medium` when the request has none. Other ids: nothing. The same ids replay their reasoning items. |
| `sampling` | `temperature` and `top_p` on every id |
| `grounding` | also `custom_tool_call` items (`x_keyword_search`, `x_semantic_search`) → `searchQueries` with tool `x_search` |
| errors | `MISSING_API_KEY`, `ENDPOINT_MISCONFIGURED`, `SDK_NOT_INSTALLED`, `XAI_ERROR`, `XAI_STREAM_ERROR` |

The per-attempt timeout (`XAI_TIMEOUT_MS`) and the server-side tool counters on the span stay the adapter's own. Both tables are `GptAdapter` and `GrokAdapter` ([Responses adapters](/models/responses-adapters.md)).

## Chat completions: Moonshot, Ollama and the gateway

The three share one base, `ChatCompletionsAdapter` (`lib/models/chatCompletionsAdapter.ts`), so they share one mapping; [chat-completions adapters](/models/chat-completions-adapters.md) describes the adapters.

| Contract | Wire |
|---|---|
| `system`, system messages | one `{ role: 'system' }` message first, `system` and then the system messages' text, joined by blank lines |
| user message | `{ role: 'user', content }`: a string, or text and `{ type: 'image_url', image_url: { url: <data URI> } }` parts. A URL blob is not sent. |
| assistant message | `{ role: 'assistant', content: <text> \| null, tool_calls: [{ id, type: 'function', function: { name, arguments } }] }`; blobs are not sent |
| tool message | one `{ role: 'tool', tool_call_id: id, content: <JSON text> }` per result. The JSON is the genai envelope: the result when it is an object, else `{ result }`, and `{ error: result }` with `isError`. |
| `ThinkingPart` | not sent. Received from `reasoning_content` or `reasoning` fields and `<think>` blocks (an unclosed block is thinking too), as one thinking partial on the JSON path and as deltas on the SSE path. |
| `ToolCallPart` received | the provider's `id`, else `adk-<messages>-<index>-<name>`; arguments that do not parse to an object are `{ raw }` |
| `tools` | `{ type: 'function', function: { name, description, parameters } }`; with `strict`, the strict form of the schema (`toStrictJsonSchema`) and `strict: true` |
| `nativeTools` | all dropped, `llm.capability.dropped` on the span (and `llm.web_search.omitted` for `web_search`), one warning per tool |
| `toolChoice` | `auto`: nothing sent. `none`: no tools sent. `required` → `tool_choice: 'required'` and `{ name }` → `{ type: 'function', function: { name } }` where honoured (below, per model and the request's reasoning), else weakened with `llm.tool_choice.weakened` (`required` or `named`) on the span: a named tool to `tool_choice: 'required'` where that is honoured, anything else to auto |
| `outputSchema` | `response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: <strict form> } }` |
| `outputFormat` | `'json'` without a schema: `response_format: { type: 'json_object' }`, on all three |
| `reasoning` | per provider (below); the gateway and Ollama send `reasoning_effort` as the word ADR 0047 gives the model (`reasoningConfig`, `lib/models/reasoning.ts`) |
| `sampling` | `temperature`, `top_p`, `max_tokens`, `stop` |
| `stream` | `stream: true` with `stream_options.include_usage`; tool-call fragments assembled by index |
| `signal` | the `fetch` signal and the SSE read; with none, the turn's (`currentTurnSignal`) |
| `usage` | input `prompt_tokens`; output `completion_tokens` (the reasoning is in it); thinking `completion_tokens_details.reasoning_tokens`; cache read `prompt_tokens_details.cached_tokens` where reported. A retry without thinking sums both attempts. |
| `finishReason` | a tool call → `tool_call`; `stop` or none → `stop`; `length` → `max_tokens`; `content_filter` → `content_filter`; anything else → `other`. `length` or thinking with no reply and no tool call is `<ID>_MAX_TOKENS` (`max_tokens`) or `<ID>_EMPTY_RESPONSE` (`stop`), ADR 0027, with the usage and `retryable: false`. |
| errors | the adapter's codes below; an HTTP failure with `status` and `retryable` from the status, an unreachable endpoint with `retryable` from the error (a reset is, a refused connection is not), and an aborted call never retryable |

The chat-completions adapters take the contract's `ModelRequest` alone; an effort word that is no level (`max`, `xhigh`) is not sent ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)).

**Moonshot** (`https://api.moonshot.ai/v1`, or `MOONSHOT_BASE_URL`). `reasoning`: on K3 `reasoning_effort` (`none` → `low`, `medium` → `high`, a budget → the level that covers it, the pinned default when absent; an older-spelling `max` as written); on K2.6 `thinking: { type: 'disabled' }` for `none`, nothing otherwise; on K2.7 Code (and its highspeed variant), which cannot switch thinking off and whose `disabled` Moonshot refuses, nothing at all. `providerState`: `{ provider: 'moonshot', kind: 'reasoning_content', model, payload }` on the final's first part, sent back as that assistant message's `reasoning_content` within the current turn's tool loop, for the same model, on `kimi-k3`, `kimi-k2.6` and `kimi-k2.7-code` (Moonshot asks for it on a tool loop). Earlier turns' is not sent. Blobs are base64 only, because Moonshot takes no public image URLs: a URL blob is dropped. `toolChoice` (checked live on 2026-10-08): on `kimi-k3`, `required` as asked and a named tool as `required`, since K3 always thinks and Moonshot refuses a named tool while it does; on `kimi-k2.6`, `required` and a named tool as asked when `reasoning` is `none` (so thinking is disabled), else weakened to auto, since Moonshot refuses both while it thinks; on other ids, auto and none only. Errors: `MOONSHOT_MISSING_KEY`, `MOONSHOT_HTTP_ERROR`, `MOONSHOT_UNREACHABLE`, `MOONSHOT_MAX_TOKENS`, `MOONSHOT_EMPTY_RESPONSE`.

**Ollama** (`OLLAMA_BASE_URL`, default `http://localhost:11434/v1`, keyless; `ollama/` stripped from the id). `outputSchema` goes as strict `json_schema`, as on the other two, and Ollama 0.5.0 and later enforce it with grammar-constrained decoding; a server older than 0.5.0 ignores it and answers in free text, and Ollama Cloud accepts it without enforcing it ([ADR 0096](/decisions/0096-ollama-structured-output-sends-json-schema.md)). `reasoning`: `reasoning_effort` as the level word. Only `none` changes anything on Ollama, and a reply that thought without answering is retried once with `none` unless the request already asks for none (`OLLAMA_RETRY_WITHOUT_THINKING=false` turns it off); the first error is held back and the usage is summed. `toolChoice`: `auto` and `none`. A vision model takes blobs as data URIs. Writes no `providerState`. Errors: `OLLAMA_HTTP_ERROR`, `OLLAMA_UNREACHABLE`, `OLLAMA_MAX_TOKENS`, `OLLAMA_EMPTY_RESPONSE`.

**The gateway** (`MODEL_GATEWAY`, Vercel AI Gateway or OpenRouter). The wire id comes from `gatewayWireModel` and `MODEL_GATEWAY_MODEL_MAP`. `provider` is the upstream's, for attribution, and `llm.transport` names the gateway. Because its provider id is the upstream's, the gateway adapter reads no `providerState`: a chat-completions wire has no place for Claude's signed blocks or OpenAI's reasoning items. `reasoning`: `reasoning_effort` in the upstream model's word (`minimal` for `none` on the first GPT-5 generation), the one field every gateway reads. `toolChoice`: as asked, and upstream support varies. No retry without thinking. Errors: `GATEWAY_NOT_CONFIGURED`, `GATEWAY_KEY_MISSING`, `GATEWAY_HTTP_ERROR`, and `<UPSTREAM>_UNREACHABLE`, `<UPSTREAM>_MAX_TOKENS`, `<UPSTREAM>_EMPTY_RESPONSE`.

## From genai Content

Stored sessions, in ADK's event shape, hold `@google/genai` `Content`, and the native loop builds each step's request as an `LlmRequest` (the engine's own type for the request ADK would build, defined in `lib/models/genaiMapping.ts`) before it reaches an adapter as a `ModelRequest`. `lib/models/genaiMapping.ts` converts between genai and the contract both ways, as pure functions that never mutate their input:

- `contentsToMessages(contents, systemInstruction?)` and its inverse `messagesToContents({ system, messages })`, for a history;
- `contentToMessage` and `messageToContent`, for one content;
- `llmRequestToModelRequest(llmRequest, { model?, stream?, signal? })`, for the request the loop, compaction and memory ingestion build;
- `modelResponseToLlmResponse(response)`, for the event the loop stores;
- `modelRequestToLlmRequest(request)` and `llmResponseToModelResponse(response, { model?, index?, searchTool? })`, the [reverse directions](#the-reverse-directions), which the scripted test models use.

The module may import `@google/genai`; the contract stays a leaf. `tests/genaiMapping.test.ts` runs every stored session fixture through it both ways.

The Gemini ids, `GEMINI_PROVIDER` (`gemini`), `THOUGHT_SIGNATURE_KIND` (`thought_signature`) and `MINTED_CALL_ID_PREFIX` (`genai-noid-`), are defined once, in `lib/models/geminiState.ts`, and the mapping and the Gemini adapter take them from there.

### Contents and messages

Content → contract → Content gives back the same JSON for every content ADK and the adapters store, keys aside: both event tables are jsonb, which keeps no key order. That holds for each content alone and for a whole history, in the stored form and in the form an `LlmRequest` carries.

| genai | Contract |
|---|---|
| `role: 'model'` | assistant |
| `role: 'system'` | system |
| `role: 'user'` holding only `functionResponse` parts | tool |
| `role: 'user'` holding anything else, or no role | user. User and tool messages both come back as `user`. A user content that mixes results with other parts is a user message, its results described as text (below), since a tool message holds only results; the calls they answer are then unanswered on the contract side. The engine's surfaces send an approval or an answer as a content of its own. |
| `{ text }` | `TextPart` |
| `{ text, thought: true }` | `ThinkingPart` |
| `{ functionCall: { name, args, id } }` | `ToolCallPart` |
| `{ functionResponse: { id, name, response } }` | `ToolResultPart` (tool results, below) |
| `{ inlineData: { mimeType, data } }` | `BlobPart` with `data` |
| `{ fileData: { mimeType, fileUri } }` | `BlobPart` with `url` |
| a part's `thoughtSignature` | `providerState: { provider: 'gemini', kind: 'thought_signature', payload: <signature> }` on the same part, with no `model`: genai records none |
| a part's `providerState` | the same `providerState`, on every part kind |
| the system instruction: a string, a part, parts or a content | `system`, its text with parts joined by newlines; none when the text is empty. It comes back as a string. |

**Parts carried whole.** A part the contract cannot hold exactly, or that its message cannot hold, keeps the original genai part in `providerState: { provider: 'gemini', kind: 'genai_part', payload: <the part> }`, and that state comes back as the part, verbatim. The contract part that carries it is the nearest one its message allows:

- **Gemini code execution.** `executableCode` is a text part holding the code in a fenced block. `codeExecutionResult` is a text part holding its output, and the outcome when it failed. A signature on either stays inside the carried part.
- **ADK's confirmation and credential requests.** ADK writes `adk_request_confirmation` and `adk_request_credential` as a `functionCall` in a `user` content. Each is a text part describing the call, in a user message. ADK leaves these events out of every model request.
- **A field the contract has no place for.** `videoMetadata`, a blob's `displayName`, a call's `willContinue`, a call with no `args`, `thought: false`. The part keeps its own contract kind, and the carried part supplies the rest.
- **Two states on one part.** A signature beside another adapter's state, or a stored state of one of the mapping's own two kinds.
- **A part with no data the contract knows.** A signature alone, or a Gemini server-side `toolCall`, is an empty text part.

Only the Gemini adapter (provider `gemini`) replays a carried part. Every other adapter sees only the contract part.

**Tool results.** `response` is the result when it is an object. A response of exactly `{ result: <not an object> }` is that value, and a response of exactly `{ error: <not null or false> }` is that value with `isError: true`, the shape in which ADK reports a tool that threw. They come back as the Gemini table above writes them: `{ error: result }` for an error, the result when it is an object, else `{ result }`. A tool's successful object result shaped `{ error }` therefore reads back as a failure: the genai bytes cannot tell the two apart.

**Ids.** A call without an id gets `genai-noid-<content>-<part>`, from its position. Gemini returns calls without ids, and ADK strips its own `adk-` ids from every request it builds. A result without an id takes the id of the latest open minted call of the same name, earliest first among parallel calls, else an id of its own. A minted id is left off on the way back, so the round trip restores its absence. Stored events keep the ids ADK assigned, which pass through unchanged.

### The request

| LlmRequest | ModelRequest |
|---|---|
| the `model` option, else `model` | `model` |
| `config.systemInstruction` | `system`, as text |
| `contents` | `messages`, as above |
| `toolsDict`, each through `contractToolDeclaration` ([building declarations](#building-declarations)) | `tools`, Gemini's dialect converted once. The server-side tools declare nothing and are skipped. |
| the `toolsDict` entries `nativeToolOf` names by marker (the `web_search`, `x_search` and `collections_search` sentinels); the `config.tools` entries `googleSearch` and `googleSearchRetrieval`, `urlContext` and `codeExecution` | `nativeTools`. Gemini receives both `web_search` and `google_search` as `googleSearch`, so it reads as `web_search`. |
| `toolConfig.functionCallingConfig.mode` | `toolChoice`: `NONE` is `none`; `ANY` is `{ name }` with one allowed name, else `required`; `VALIDATED` makes every tool `strict`; `AUTO` is absent, the default |
| `responseJsonSchema`, else `responseSchema` | `outputSchema`, through `toContractJsonSchema` |
| `responseMimeType: 'application/json'` with neither | `outputFormat: 'json'` |
| `thinkingConfig.thinkingLevel` | `reasoning`: `MINIMAL` is `none` (its Gemini 3 rendering, ADR 0047), and `LOW`, `MEDIUM` and `HIGH` their levels |
| else `thinkingConfig.thinkingBudget`, n ≥ 0 | `{ budget_tokens: n }` |
| else `reasoningEffort` | the level it names; `minimal` is `none` (its rendering on the first GPT-5 generation) |
| `temperature`, `topP`, `maxOutputTokens`, `stopSequences` | `sampling` |
| the `stream` option | `stream` |
| the `signal` option, else `config.abortSignal` | `signal` |

The compiler writes the effort word beside `thinkingConfig` from one setting, so preferring `thinkingConfig` loses nothing it wrote; only the older spelling can set the two to different things. Not mapped: a thinking budget of -1 (Gemini's dynamic thinking, which is the provider's default anyway), the effort words `xhigh` and `max`, options inside a `config.tools` entry, any other `config.tools` entry, and the fields the next section lists.

### The response

| ModelResponse | LlmResponse |
|---|---|
| a partial's parts | `content` with `role: 'model'`, and `partial: true` |
| the final's parts | `content`, absent when there are none, and `turnComplete: true` |
| `usage` | `usageMetadata` in Gemini's meanings: `promptTokenCount` is input, `candidatesTokenCount` output less thinking, `thoughtsTokenCount` thinking, `cachedContentTokenCount` cache reads, `totalTokenCount` input plus output |
| `error` | `errorCode`, and `errorMessage` with key-shaped text scrubbed; `retryable` as `customMetadata['error.retryable']` and `status`, when there is one, as `customMetadata['error.status']` (`withRetryVerdict`, `lib/models/errorResponse.ts`), so the stored event keeps the verdict the fallback rules read ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)). |
| `finishReason` | an error whose code is one of Gemini's finish reasons (`MALFORMED_FUNCTION_CALL`, `RECITATION`, …; not `STOP`) gets that reason, as ADK's Gemini reported both, so self-correction (`lib/runtime/native/selfCorrection.ts`, from the YAML's `retries:`) retries a malformed call ([ADR 0088](/decisions/0088-native-parity-followups.md)); otherwise `stop` and `tool_call` are `STOP`, `max_tokens` is `MAX_TOKENS`, `content_filter` is `SAFETY`, `other` is `OTHER`, and `error` sets none |
| `grounding` | `groundingMetadata`: `webSearchQueries` holds every query, and `groundingChunks[].web` each cited URL once with its title, which is what `lib/grounding.ts` reads |

Before any of this, `contractModelResponse` holds the response to the contract, so an adapter that breaks it never has its parts stored as they came ([ADR 0101](/decisions/0101-native-loop-security-gate.md)). The native step calls it on every answer before storing it:

- a part that is not an object, of no known kind, or a `toolResult` (an answer holds none) is dropped, and so is a text or thinking part whose text is not a string, a blob without a string `mimeType` and a string `data` or `url`, and a Gemini part carried whole that is not an object;
- a `toolCall`'s name and id that are not strings become `''` (the runtime then mints the id); its arguments become `{}` when absent or null, `{ raw: <value> }` when they are not an object or an array, and `{ raw: TOO_DEEP_ARGUMENTS }` when they nest deeper than `MAX_VALUE_DEPTH` (64) levels (`lib/runtime/valueDepth.ts`), since every later reader of the session recurses through them.

A response every part of which the contract allows is returned as it is.

An LlmResponse has no field for `cacheWriteTokens`, a citation's span and cited text, or the native tool that ran a query, so these are not carried. `usageFromMetadata` reads `usageMetadata` back into `Usage` under the meanings of the Gemini table. Events that ADK's GPT, Grok and chat-completions model classes stored before 1.0.0 carry `candidatesTokenCount` with reasoning included ([ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md), [ADR 0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md)), so on such an event it counts that reasoning twice in `outputTokens`.

The stored Event JSON keeps its shape ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)). The engine types a stored event as `TurnEvent` ([sessions and events](/memory/sessions.md)), whose content is this genai shape.

### The reverse directions

`modelRequestToLlmRequest` builds the LlmRequest ADK would build for a Gemini model:

| ModelRequest | LlmRequest |
|---|---|
| `model` | `model` |
| `system` | `config.systemInstruction`, a string; none when empty |
| `messages` | `contents`, as above. A system message stays a `system` content, which Gemini refuses, so a Gemini caller folds it into the system prompt. |
| `tools` | `config.tools[].functionDeclarations`, the lowercase schema in `parametersJsonSchema`; and one declaration-only `toolsDict` entry per tool, whose `_getDeclaration()` gives the schema as `parameters`, where `llmRequestToModelRequest` reads it. It is never run. |
| `nativeTools` | Gemini's tool objects, in the request's order: `web_search` and `google_search` as one `googleSearch`, `url_context`, `code_execution`. `x_search` and `collections_search` are left out, since they are xAI's; `nativeToolsWithoutGeminiTool` names them. |
| `toolChoice`, `strict` | `toolConfig.functionCallingConfig`, only beside declarations: `AUTO`, `NONE`, `ANY`, `ANY` with `allowedFunctionNames`, and `VALIDATED` for a strict tool under `auto` or no choice |
| `outputSchema` | `responseMimeType: 'application/json'` and `responseJsonSchema` |
| `outputFormat` | `'json'` without a schema: `responseMimeType: 'application/json'` alone |
| `reasoning` | `reasoningConfig` (`lib/models/reasoning.ts`) for the model, as the compiler writes it: a thinking level or budget on Gemini, and the effort word every other adapter reads |
| `sampling` | `temperature`, `topP`, `maxOutputTokens`, `stopSequences` |
| `signal` | `config.abortSignal` |

Through `llmRequestToModelRequest` a request comes back the same, except: `google_search` reads as `web_search`; `x_search` and `collections_search` are gone; `auto` reads as absent, and a choice without tools is not sent; one strict tool makes every tool strict, and strict is lost beside a forced choice; a level a model renders as a budget or another word (Gemini 2.x, o-series) reads back as that rendering; `outputFormat` beside a schema reads back as the schema alone; `stream` is not an LlmRequest field. An LlmRequest comes back the same in every field the forward table maps. `tests/genaiMapping.test.ts` round-trips every fixture history, stored and as an LlmRequest carries it.

`llmResponseToModelResponse` reads one LlmResponse:

| LlmResponse | ModelResponse |
|---|---|
| `partial: true` | a partial: its non-empty text parts as text and thinking deltas. Other parts wait for the final. |
| any other | a final. `content.parts` map as an assistant message's (above), with ids minted from `index`, the answer's place in its conversation. Thinking is left out, and a signature on it moves to the next part that has no state of its own, or stays with the last part when no part follows. `model`, when given, is set on every `thought_signature` state. |
| `errorCode` | `error`: the code; `errorMessage` with key-shaped text scrubbed, or `The model call ended with <code>.`; `retryable` and `status` from `customMetadata['error.retryable']` and `['error.status']`, so a verdict an adapter stamped reads back. ADK's `STOP` is no error. |
| `finishReason` | the Gemini table's: `tool_call` whenever a call is there. With no finish reason, an error is `content_filter` for a policy reason (a blocked prompt), else `error`; no error is `stop`. |
| `usageMetadata` | `usage`, through `usageFromMetadata` |
| `groundingMetadata` | `grounding`: each `groundingChunks[].web` page once, with its title, and `webSearchQueries` attributed to `searchTool` (default `web_search`) |

Not read: citation spans and cited text, and the thought text of a final, which is display only; a caller folding a stream keeps it as a partial. Every model event of every stored session fixture maps to a final whose output parts, usage and finish reason come back byte-equal, and a ModelResponse comes back the same through an LlmResponse but for `cacheWriteTokens` and a citation's span.

## What the contract leaves out

These `generateContentConfig` fields have no contract field: `topK`, `seed`, `presencePenalty`, `frequencyPenalty`, `candidateCount`, `safetySettings`, `includeThoughts`, and the effort words `xhigh` and `max`. The older spelling's `thinkingBudget` maps to `{ budget_tokens }`, its effort words that are levels map to the level, and `minimal` maps to `none`, and `responseMimeType: 'application/json'` without a schema maps to `outputFormat: 'json'`. An agent that sets any of the rest does not have it sent. Live bidirectional connections are outside the contract.
