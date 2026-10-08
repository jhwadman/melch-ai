---
type: model-provider
title: Provider routing
description: "How a model string in YAML reaches the right provider adapter: one prefix table, six providers, availability by API key."
tags:
  - models
  - routing
generated:
  by: process:wiki-build
  at: 2026-10-08
sources:
  - resource: lib/models/providerMap.ts
  - resource: lib/models/registry.ts
  - resource: lib/models/capabilities.ts
---

# Provider routing

<!-- wiki:fill slot="overview" -->
Model string routing relies on a single prefix table in `lib/models/providerMap.ts` across three resolution paths. Standard entrypoints passing model names as strings rely on `registerAvailableProviders()`, which registers adapter classes into the ADK `LLMRegistry` to match string patterns such as `claude-*`, `gpt-*`, or `ollama/<model>`. In contrast, per-request paths like the [A2A server](/protocols/a2a.md) use `resolveModel()`, an instance factory that injects custom header credentials directly into new adapter instances. The native runtime ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)) uses `resolveAdapter()`, which returns the engine's own `ModelAdapter` with no `LLMRegistry` ([ADR 0060](/decisions/0060-engine-owned-registry.md)). `runSyndicateTurn` calls `registerAvailableProviders()` itself whenever its caller passes no `compile.resolveModel`, so a string id never reaches ADK's own Gemini class, which would bypass the turn's step cap and cancellation.

All provider registration must occur before constructing agents. The `LLMRegistry` maintains an internal cache for model-to-class resolutions, meaning late registration can lead to stale cache hits that fail to resolve newly available providers.

The chat-completions adapters (Ollama, Kimi and the gateways, all over `lib/models/chatCompletionsAdapter.ts`, the [chat-completions adapters](/models/chat-completions-adapters.md)) read `finish_reason`. A turn that ends with reasoning but neither reply text nor a tool call is an error, never an empty reply: `<PROVIDER>_MAX_TOKENS` when the provider reports `length`, `<PROVIDER>_EMPTY_RESPONSE` when the model stopped after thinking ([ADR 0027](/decisions/0027-thinking-without-answer-is-an-error.md)). On Ollama, `length` almost always means the 4,096-token default context window, which the `/v1` path cannot raise; [failure modes](/operations/failure-modes.md) lists the remedies. The Ollama adapter first retries such a turn once with `reasoning: none`, sent as `reasoning_effort: "none"` (thinking off), counting both attempts' tokens, so the error reaches the caller only when the retry fails too; `OLLAMA_RETRY_WITHOUT_THINKING=false` turns that off.
<!-- /wiki:fill -->

<!-- wiki:generated section="providers" source="lib/models/providerMap.ts" -->
| Provider | Label | Key env | Model prefix | Default |
|---|---|---|---|---|
| gemini | Google Gemini | `GOOGLE_GENAI_API_KEY` | `gemini-*` | `gemini-3.5-flash-lite` |
| anthropic | Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-*` | `claude-sonnet-4-6` |
| openai | OpenAI GPT | `OPENAI_API_KEY` | `gpt-*`, `o<digit>*` | `gpt-5-mini` |
| xai | xAI Grok | `XAI_API_KEY` | `grok-*` | `grok-4.7` |
| moonshot | Moonshot Kimi | `MOONSHOT_API_KEY` | `kimi-*` | `kimi-k3` |
| ollama | Ollama (local) | (keyless, local) | `ollama/<model>` | `ollama/qwen3:8b` |
<!-- /wiki:generated -->

## Transport: direct by default, a gateway only for what is absent

The table above is the whole routing decision; the *transport* is a second, separate decision made in `lib/models/gateway.ts` and applied by the registry. A model id is served by its provider's own adapter whenever that provider's key is present. When the key is absent and `MODEL_GATEWAY` (`vercel` or `openrouter`) plus `MODEL_GATEWAY_API_KEY` are set, the id is served instead by `lib/models/gatewayLlm.ts` through the gateway's OpenAI-compatible chat-completions endpoint — the shim around `GatewayAdapter`, on the same base the Ollama adapter uses. Ollama needs no key, is reached at `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`) and never routes through a gateway, and an [A2A](/protocols/a2a.md) caller's `X-API-Key` funds its own provider directly and never selects the gateway. The gateway is not a provider: `llm.provider` on the telemetry ledger (`db/telemetry.sql`) stays `anthropic`, `openai`, `gemini` or `xai`, and the path is recorded separately as `llm.transport = gateway:<id>`.

What a gateway cannot do is enable any upstream native search, so every server-side tool sentinel — `web_search`, `google_search`, `x_search`, `collections_search` — is dropped on that path. `lib/models/capabilities.ts` states this per agent on the resolved path; the compiler logs one `capability ·` line per affected agent at startup, the span carries `llm.capability.dropped`, and the doctor below shows it. Wire names follow a rule (`claude-sonnet-4-6` → `anthropic/claude-sonnet-4.6`; `grok-4.7` → `xai/…` on Vercel, `x-ai/…` on OpenRouter) with `MODEL_GATEWAY_MODEL_MAP` for exceptions and `MODEL_GATEWAY_BASE_URL` for a self-hosted proxy. Rationale: [ADR 0012](/decisions/0012-direct-adapters-canonical.md).

## Reasoning: one key, each provider's field

An agent says how hard it reasons with `reasoning:` — `none`, `low`, `medium`, `high`, or `{ budget_tokens: <int> }` — and `lib/compile.ts` (`reasoningConfig`) writes the field its provider reads ([ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md)). Gemini 3 gets `thinkingConfig.thinkingLevel` (`none` is `MINIMAL`); Gemini 2.x and Claude get `thinkingConfig.thinkingBudget` from one table (0, 2,048, 8,192, 16,384); GPT, Grok, Kimi, Ollama and the gateway get an effort word in `generateContentConfig.reasoningEffort`, the provider's nearest setting at or above the level where it lacks one (`none` is `minimal` on the first GPT-5 generation and `low` on o-series and Grok; Kimi K3's `medium` is `high`). The effort word is written for every provider, so an id the gateway serves keeps its level; the genai SDK drops it from a Gemini request. A budget becomes the smallest level that covers it wherever only a level travels. The Responses adapters read it back as a level (`minimal` as `none`) and send `reasoning.effort` in the model's own word, and Grok's pinned effort applies only when the agent sets none; the older spelling's `xhigh` and `max`, which have no level, do not reach GPT or Grok. `generateContentConfig.thinkingConfig` and `reasoningEffort` are the older spelling and still load, but not beside `reasoning` on one agent. An agent that sets neither gets each adapter's own default.

### Claude: one request shape per model generation

Claude's request surface differs by model generation, so the adapter reads a table keyed by the model id (`lib/models/claudeModels.ts`, [ADR 0049](/decisions/0049-claude-requests-by-model-generation.md)); an id the table does not know gets the newest row. The adapter is `ClaudeAdapter` (`lib/models/claudeAdapter.ts`) on the engine's [model contract](/models/model-contract.md), and `ClaudeLlm`, which the registry serves every `claude-*` id with, is that adapter behind the [ADK shim](/models/adk-shim.md) ([Claude adapter](/models/claude-adapter.md)). On the ADK path `ClaudeLlm` reads the agent's `thinkingConfig` and `reasoningEffort` as below and hands the adapter that reading ([ADR 0055](/decisions/0055-claude-adapter-keeps-the-adk-request.md)); on the contract the adapter maps `reasoning` itself, a level to ADR 0047's budget on the budget rows and to its effort on the adaptive rows.

- **Claude 4.6 and earlier** (Opus 4.6, Sonnet 4.6, Haiku 4.5 and older) take the thinking budget: `thinking: { type: 'enabled', budget_tokens }` from `thinkingBudget` (a budget under 1,024 is raised to 1,024, the least Anthropic takes), with `max_tokens` at least the budget plus 2,048. `none` sends no `thinking` field.
- **Later models** take adaptive thinking: the effort word becomes `output_config.effort` (`low`, `medium`, `high`; the older spelling's `xhigh` and `max` pass through), thinking asks for a `summarized` display, and `max_tokens` keeps the same floor as the budget would set. `none` is the model's off switch at `low` effort: `disabled` on Opus 4.7 and 4.8, Sonnet 5 and Haiku 5.5, `between_tools` on Sonnet 5.5. Opus 5, Opus 5.5, Fable and Mythos stay on adaptive thinking at `low`: they have no off switch, or, on Opus 5, one with a documented failure where a tool call is written as text and never runs. An agent that sets no reasoning gets the model's default, made readable where the model thinks by default, with `max_tokens` at least 18,432 there, since that thinking counts toward it.
- **The non-streaming ceiling.** The Anthropic SDK refuses a non-streaming request whose `max_tokens` passes about 21,333 unless the client sets a timeout, and the adapter sets none. No level raises `max_tokens` past 18,432 on any generation; a `budget_tokens` above about 19,000, or a `maxOutputTokens` above the limit, fails a non-streaming turn.
- **Structured output** is `output_config.format` (a strict JSON schema, through the Anthropic SDK's own transform) on Opus 4.8 and later, Sonnet 5 and later, Haiku 5.5, Fable and Mythos, read back from the reply text. Claude 4.6 and earlier and Opus 4.7 get a tool whose input schema is the output schema, forced with `tool_choice` unless thinking is on or another tool is sent (which ADK never does beside a schema). `llm.structured_output` on the span names which.
- **No sampling parameter** (`temperature`, `top_p`, `top_k`) is sent to any Claude model.

## Platforms: Vertex AI, Bedrock, Azure OpenAI and proxies

The provider is the id's; the *platform* is configuration (`lib/models/endpoints.ts`, [ADR 0023](/decisions/0023-bring-your-own-endpoint.md)). `GEMINI_PLATFORM=vertex` (or genai's own `GOOGLE_GENAI_USE_VERTEXAI`) sends Gemini through Vertex AI with Application Default Credentials for `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`; `ANTHROPIC_PLATFORM=bedrock` (with `AWS_REGION`) or `=vertex` (with `ANTHROPIC_VERTEX_PROJECT_ID`/`CLOUD_ML_REGION`) sends Claude through Anthropic's Bedrock or Vertex SDK client, optional peers loaded on first use; `OPENAI_PLATFORM=azure` with `AZURE_OPENAI_ENDPOINT` sends GPT to Azure OpenAI's v1 API with `AZURE_OPENAI_API_KEY` or an Entra ID token (`@azure/identity`). `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` put a proxy in front of the vendor API. `<PROVIDER>_MODEL_MAP` translates ids a platform names differently (a Bedrock inference profile, an Azure deployment). A configured cloud platform funds its provider without a vendor key and is not covered by the gateway. The A2A `credentials` plug point may return a key or a partial endpoint per request, and memory embeddings follow the Gemini platform. Native search is kept on Gemini-on-Vertex and not sent on the other three platforms; Claude on Bedrock and on Vertex AI takes images inline only, so an image given by URL is dropped there. The capability report says so per agent, and the doctor prints one `endpoint` line per configured platform. These paths are tested against mocked clients, not the live clouds.

## Which keys do I need? The doctor

`npm run doctor` (`lib/doctor.ts`; the `melchizedek-doctor` bin in the package) reads every syndicate the loader can see — the agents directory's root, `examples/` and `templates/` — resolves each agent's model under the current environment through these same modules, and prints one table: agent, model, provider, the declared server-side tools the path keeps (✓) or drops (✗), and whether the path is funded (direct key, gateway, or local). One verdict per syndicate, then the variables that would unlock the most and where to get each. It is read-only and never prints a key value. Every starter-pack file opens with a `# tier:` header (`keyless`, a single provider such as `gemini`, or `multi-provider`) that the doctor checks against the models. The live counterpart that actually sends a prompt per provider is `npm run demo:models`. `npm run parity` goes further: on every provider the doctor's logic calls funded, it checks that delegation, a client-side tool, structured output, streaming, a second turn and token usage work end to end through the turn runner ([parity harness](/operations/parity-harness.md)).

Wiki agent operations default to `gemini-3.8-flash` (WIKI_AGENT_MODEL in lib/config.ts). Schema-dialect bridging between Gemini-uppercase and standard JSON Schema is covered in [tool contracts](/tools/tool-contracts.md).

<!-- wiki:generated section="capabilities" source="lib/models/capabilities.ts" -->
| Capability | Google Gemini | Anthropic Claude | OpenAI GPT | xAI Grok | Moonshot Kimi | Ollama (local) | Gateway (any id) |
|---|---|---|---|---|---|---|---|
| delegation (subagents as tools) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| memory tools (load_memory) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| structured output (outputSchema) | ✓ | ✓1 | ✓ | ✓ | ✓2 | ◐3 | ✓4 |
| thinking with tool use | ✓ | ✓5 | ✓6 | ✓7 | ✓8 | ◐9 | ◐10 |
| token streaming | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| image input | ✓ | ✓11 | ✓12 | ✓13 | ✓14 | ✓15 | ✓16 |
| native web search | ✓ | ✓ | ✓ | ✓ | ✗17 | ✗18 | ✗19 |

✓ supported · ◐ degraded · ✗ unsupported. Gemini cells are ADK's own adapter; every other cell is asserted against the request the adapter sends.

1. Anthropic Claude · structured output (outputSchema): output_config.format (json_schema) from Opus 4.8, Sonnet 5 and Haiku 5.5 on; a forced tool call on Claude 4.6 and earlier and Opus 4.7, offered under tool_choice auto when thinking is on (ADR 0049).
2. Moonshot Kimi · structured output (outputSchema): strict json_schema; kimi-k2.6 is documented as unstable on complex schemas ($ref, oneOf).
3. Ollama (local) · structured output (outputSchema): JSON mode only (json_object): the output is JSON but the schema is not enforced.
4. Gateway (any id) · structured output (outputSchema): strict json_schema; upstream support varies by model.
5. Anthropic Claude · thinking with tool use: a thinking budget on Claude 4.6 and earlier, adaptive thinking with output_config.effort after (ADR 0049); signed thinking blocks are replayed verbatim within the turn's tool loop (ADR 0046), and where the model binds them to the conversation (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5) under drop_block, so a block whose history changed is dropped rather than rejected; with a budget, a step answering another model's tool call runs without thinking.
6. OpenAI GPT · thinking with tool use: encrypted reasoning items are replayed verbatim within the turn's tool loop, with store: false (ADR 0050); reasoning ids only (o-series, gpt-5*).
7. xAI Grok · thinking with tool use: encrypted reasoning items are replayed verbatim within the turn's tool loop, with store: false (ADR 0050); grok-4.5, grok-4.6 and grok-4.7; other grok ids re-reason each step.
8. Moonshot Kimi · thinking with tool use: reasoning_content is sent back on the turn's tool-loop assistant messages for the same model (ADR 0046) on kimi-k3, kimi-k2.6 and kimi-k2.7-code; earlier turns' reasoning is not, which K3 and K2.7 Code also ask for; effort travels as reasoning_effort (K3) or a thinking switch (K2.x).
9. Ollama (local) · thinking with tool use: reasoning: is the lever, sent as reasoning_effort in the model's word, a thinking budget as the level that covers it (ADR 0047); the reasoning is not carried between tool steps, so the model re-reasons each step.
10. Gateway (any id) · thinking with tool use: reasoning: is the lever, sent as reasoning_effort in the model's word, a thinking budget as the level that covers it (ADR 0047); the reasoning is not carried between tool steps, so the model re-reasons each step.
11. Anthropic Claude · image input: user-turn images only.
12. OpenAI GPT · image input: user-turn images only.
13. xAI Grok · image input: user-turn images only.
14. Moonshot Kimi · image input: user-turn images only, sent as base64 (Moonshot takes no public image URLs).
15. Ollama (local) · image input: needs a vision model, e.g. ollama/qwen3-vl:8b.
16. Gateway (any id) · image input: upstream model must accept images.
17. Moonshot Kimi · native web search: Moonshot's model-side $web_search retires 2026-10-20 and its successor is a REST call, not a request field; the web_search sentinel is dropped (use web_extract).
18. Ollama (local) · native web search: no native search on this path; the web_search sentinel is dropped (use web_extract).
19. Gateway (any id) · native web search: a gateway cannot enable upstream native search; the web_search sentinel is dropped.

**Cloud platforms** (ADR 0023): the same adapter and request as the provider's own API, except as listed. These paths are tested against mocks, not against the live clouds.

| Path | Differs from the provider row |
|---|---|
| Google Gemini on Vertex AI | nothing |
| Anthropic Claude on Bedrock | image input: ◐ user-turn images inline (base64) only; an image given by URL is dropped, since Bedrock takes no URL image source; native web search: ✗ not sent on Bedrock; the web_search sentinel is dropped (use web_extract) |
| Anthropic Claude on Vertex AI | image input: ◐ user-turn images inline (base64) only; an image given by URL is dropped, since Vertex AI takes no URL image source; native web search: ✗ not sent on Vertex AI; the web_search sentinel is dropped (use web_extract) |
| OpenAI GPT on Azure OpenAI | native web search: ✗ not sent on Azure OpenAI; the web_search sentinel is dropped (use web_extract) |
<!-- /wiki:generated -->

## Images

An image reaches a model as a part of the user's message (`inlineData` with base64 bytes, or `fileData` with a URI; the [A2A server](/protocols/a2a.md) refuses file parts, so images come from library callers of `runSyndicateTurn`). Each adapter sends user-turn images only; an image inside a tool result travels as that result's JSON, never as image input. Claude's adapter sends `inlineData` as a base64 `image` block (`image/png` when the part names no type) and an `https` `fileData` URI as a URL `image` block that Anthropic fetches, in the parts' order. A `fileData` part that names no type is typed by its URL's extension; a URL with no extension the adapter knows is sent, and Anthropic reads the type from the bytes. Anthropic takes JPEG, PNG, GIF and WebP: any other type, or a URI that is not `https`, is dropped with `llm.image.dropped` (the media type or the URL scheme, never the URL) on the `llm.request` span and one warning per type. On Bedrock and Vertex AI, which take base64 images only, a URL image is dropped the same way (`URL source`, one warning naming the platform). Gemini takes both shapes natively (ADK's own adapter). GPT and Grok send `inlineData` as an `input_image` data URI (`image/png` when the part names no type) and an `https` `fileData` URI as an `input_image` URL, with a PDF as an `input_file` instead; a URI that is not `https` is dropped with `llm.image.dropped` (`URL scheme`). The chat-completions adapters send `inlineData` as an `image_url` data URI and do not read `fileData`.

## Reasoning state across tool steps

Some providers want state back on the next request of a tool loop that only they can read: Anthropic's signed `thinking` and `redacted_thinking` blocks, OpenAI's and xAI's reasoning items, Moonshot's `reasoning_content`. Every adapter carries it the same way, as one field on a content part ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md), `lib/models/providerState.ts`):

```ts
{ functionCall: { … }, providerState: { provider: 'anthropic', kind: 'thinking_blocks', model: 'claude-sonnet-4-6', payload: [ … ] } }
```

- **Write.** The adapter that produced the response sets `providerState` on a part the model produced (a `functionCall` or `text` part), with `provider` set to its id from `lib/models/providerMap.ts` (`anthropic`, `openai`, `xai`, `moonshot`), a `kind` of its own naming, a JSON-serializable `payload`, and `model` when the provider binds the state to the model that produced it. `withProviderState(part, state)` returns the copy. Never a part of its own: `@google/genai` serializes parts field by field, so a state-only part reaches Gemini as an empty part.
- **Replay.** Only an adapter of the same provider reads it, through `providerStateOf(part, provider, kind, model?)`, which also skips another model's state when `model` is set, and sends the payload back verbatim. Every other adapter ignores the field, so a model switch between steps (a fallback model, a test that alternates models) drops the state instead of misreading it.
- **Keep.** ADK deep-clones `event.content` into the next `LlmRequest.contents`, so the field reaches the next step unchanged. The session services store it with the event, and `trimEventForStorage` keeps it whole; the plan-dispatch projection (`lib/session/transcript.ts`) drops it with the rest of a past turn.

- **Scope.** `currentTurnStart(contents)` in the same module marks where the current turn starts: the last user content that is not purely tool results, or -1 when there is none, so that every content is then the current turn's. An adapter replays state only on the model contents after it, the current turn's tool loop, and leaves out earlier turns' state.

Claude uses `kind: 'thinking_blocks'` and sets `model`, since signed thinking is bound to the model that produced it. It writes the state on the streamed and the non-streamed path alike: each run of signed blocks rides on the part that follows it in the response and is replayed immediately before that part, within the current turn's tool loop only (the assistant messages after the last user message that is not purely tool results). Display-only `{ text, thought: true }` parts are never sent back. With a thinking budget, a step whose pending tool call carries no signed block, because another provider or another Claude model made it, is sent without thinking (`llm.thinking.omitted` on the span), since Anthropic rejects a thinking request whose tool loop does not open with one.

Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind a thinking block to the conversation before it: a block replayed after any change to the `system` prompt, the `tools` or an earlier message is rejected on accounts created on or after 31 August 2026. A turn resumed after an approval or an `ask_user` pause is rebuilt from stored events, and those differ from what the model saw: a tool result over 2,000 characters is elided, and `JSONB` does not keep object key order. So on those models every request with thinking on sets `thinking.block_binding.prefix_mismatch_behavior: 'drop_block'` under the `thinking-binding-controls-2026-08-01` beta. The API drops a changed block and every later one for that request instead of failing it, and the adapter puts the reason on the span as `llm.thinking.dropped` ([ADR 0049](/decisions/0049-claude-requests-by-model-generation.md)). With thinking off (`between_tools`, `disabled`) the field cannot be sent, so those requests replay no signed block.

GPT and Grok (the [Responses adapters](/models/responses-adapters.md), `lib/models/gptAdapter.ts` and its `GrokAdapter` subclass) carry reasoning items under `provider: 'openai'` or `'xai'`, `kind: 'reasoning_items'`, with `model` set ([ADR 0050](/decisions/0050-responses-reasoning-replay-without-storage.md)). This applies to the ids that reason: OpenAI's o-series and `gpt-5*`, and `grok-4.5`, `grok-4.6` and `grok-4.7` (`replaysReasoning()`). Their requests send `store: false`, so the vendor keeps no copy of the response, and `include: ['reasoning.encrypted_content']`, so each reasoning item comes back with its encrypted content. Each run of reasoning items rides, verbatim, on the part made from the output item right after it: a function call, or the first text of a message. A run that a server-side tool call (a web or X search) or a message with no text follows is dropped. Within the current turn's tool loop, the adapter replays the items as input items immediately before that part's item. A model content that replays keeps the model's order of message and `function_call`. Another provider's or another model's items are skipped, and so is an item without encrypted content, since `store: false` leaves nothing for its id to point at. Other GPT and Grok ids send neither field and replay nothing. The guarded retry answers a 400 by dropping the reasoning param, the `include` and the replayed items, keeping `store: false`, and trying once more. The span then carries `llm.retry_without_reasoning`.

The chat-completions base (`lib/models/chatCompletionsAdapter.ts`) carries `reasoning_content` behind one opt-in hook, `replaysReasoningContent(model)`, off by default, so Ollama and the gateway keep the scratchpad display-only. An adapter that turns it on writes the response's `reasoning_content` field, whole, as `{ provider, kind: 'reasoning_content', model, payload }` on the part that follows it (the reply text, or the first tool call when there is none), on the streamed and the non-streamed path alike, and sends it back as that assistant message's `reasoning_content` on the current turn's tool loop, for the same provider and model only, using the same `currentTurnStart`. `<think>` blocks and Ollama's `reasoning` field are not carried. Kimi turns the hook on for the ids Moonshot's thinking-model guide asks it of within a tool loop: `kimi-k3` (where Moonshot calls it required), `kimi-k2.6` and `kimi-k2.7-code` with its highspeed variant (`wantsReasoningReplay` in `lib/models/kimiAdapter.ts`). Earlier turns' reasoning is not sent, though K3 and K2.7 Code also ask for it across turns: a past turn's stored history is not what the model saw, as for Claude. The gateway leaves it off even for a `kimi-*` id, whose provider id there is still `moonshot`. The replayed text is billed again as input on each later step of the loop, mostly at Moonshot's cache-hit price since the prefix does not change, and the stored session keeps it on the part (the display-only thought partial is never stored).

An agent may name a `fallback_model` (`lib/models/fallback.ts`, [ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)). Its model is then wrapped: a provider-side failure (what `lib/models/retry.ts` classifies retryable, after the adapter's own retries) is answered by the fallback if nothing was produced yet, and a per-provider circuit opens after `MODEL_BREAKER_THRESHOLD` consecutive failures (default 5) so those agents skip the provider for `MODEL_BREAKER_COOLDOWN_MS` (default 30 s). A 4xx, a cancellation, and a stream that already yielded text are thrown as they are. Agents without a fallback are not wrapped. An adapter that reports a failure as a yielded error response rather than a throw (Claude, GPT, Grok, Kimi, Ollama, the gateway) marks it with `customMetadata['error.retryable']` and `'error.status'` (`lib/models/errorResponse.ts`), which `FallbackLlm` reads by the same rules: a retryable one before any output is redirected without being yielded, any other is passed on, and only a call that yielded content counts as a success.

On the engine's own [model contract](/models/model-contract.md), the same rules are `FallbackAdapter` (`lib/models/fallbackAdapter.ts`), a `ModelAdapter` around a primary and a fallback adapter. A failure there is a final response with `error` set, never a throw, so the wrapper reads it from that: the fallback answers when `error.retryable` is true and `error.status`, if present, is one `lib/models/retry.ts` retries, and only when the primary yielded no partial and its failed final holds no parts. An aborted request is never redirected or counted, whatever the adapter reported. The fallback receives the caller's request with `model` rewritten to its own id and `reasoning` unchanged, so it maps the setting to its own provider's field ([ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md)). The wrapper reports the primary's `provider` and `model`. Both wrappers keep their circuits in `lib/models/circuitBreaker.ts`, keyed on the provider id (`lib/models/providerMap.ts`), so a provider tripped on the ADK path is skipped on the contract path and the reverse. The breaker keeps one clock for both wrappers, which tests replace with `setBreakerClock`. Nothing constructs a `FallbackAdapter` yet: the compiler wraps an agent's model in `FallbackLlm` until the native runtime runs a turn.

## The engine's own registry: resolveAdapter

`resolveAdapter(modelId, { apiKey?, keyProvider?, endpoint?, gemini? })` in `lib/models/registry.ts` returns the [model contract](/models/model-contract.md)'s adapter for one id, for the native runtime ([ADR 0060](/decisions/0060-engine-owned-registry.md)). It reads the same prefix table and the same transport rule as `resolveModel`, through one routing step (`routeFor`), and each path has one table keyed by provider:

| Prefix | `resolveModel` (ADK) | `resolveAdapter` (contract) |
|---|---|---|
| `claude-*` | `ClaudeLlm` | `ClaudeAdapter` |
| `gpt-*`, `o<digit>*` | `GptLlm` | `GptAdapter` |
| `grok-*` | `GrokLlm` | `GrokAdapter` |
| `kimi-*` | `KimiLlm` | `KimiAdapter` |
| `ollama/<model>` | `OllamaLlm` | `OllamaAdapter` |
| anything else (Gemini) | `TracedGemini` | `AdkGeminiAdapter`, or `GeminiAdapter` when asked |
| any cloud id with no direct key, `MODEL_GATEWAY` set | `GatewayLlm` | `GatewayAdapter` |

- **BYOK.** `apiKey` authenticates `keyProvider`'s models only (default: the model's own provider), and a model of another provider resolves its key from server env, as `resolveModel` scopes a key to the X-Provider header's provider. A caller's key, or a caller's endpoint, makes the route direct, so the gateway never stands in over it.
- **Endpoints** (ADR 0023) are merged over the environment's for the model's provider, as `resolveModel` merges them: Claude and GPT take the whole endpoint, Kimi its base URL, Grok and Ollama none.
- **Gemini.** A Gemini id gets the temporary [wrapper over ADK's Gemini](/models/adk-gemini-adapter.md) (`AdkGeminiAdapter`) until gate G3 of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md). The engine's own [Gemini adapter](/models/gemini-adapter.md) (`GeminiAdapter`) is selected with `GEMINI_ADAPTER=engine` or the option `{ gemini: 'engine' }`, which wins over the variable. `GEMINI_ADAPTER` takes `adk` (the default) or `engine`; any other value fails a Gemini id's resolution and touches no other provider.
- **Fallback.** `resolveAdapterWithFallback(modelId, fallbackId, options)` returns a `FallbackAdapter` around the two resolved adapters, or the primary alone when there is no fallback. The caller's key stays with the primary's provider. Nothing calls it yet: on the ADK path the compiler's pair is `FallbackLlm(shim(primary), shim(fallback))` ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)).
- **The ADK path.** `registerAvailableProviders()` registers the providers' own exported classes (`ClaudeLlm`, `GptLlm`, `GrokLlm`, `KimiLlm`, `OllamaLlm`, `TracedGemini`, and `GatewayLlm` under a direct class's patterns), never a bare `adkShimClass` around an adapter, since `GptLlm` and the chat-completions shims keep the ledger's usage meaning in their `toLlmResponse` ([ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md), [ADR 0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md)). `providerStatuses()` and the doctor read the environment as before.

`TracedGemini` lives in `lib/models/tracedGemini.ts`, which `registry.ts` re-exports: the registry builds `AdkGeminiAdapter`, which runs its calls through `TracedGemini`, so the class in `registry.ts` would be an import cycle.

Gemini has two adapters on the contract. The [Gemini adapter](/models/gemini-adapter.md) (`GeminiAdapter`) calls `@google/genai` with no ADK. Until it passes its live run at gate G3, `resolveAdapter`'s Gemini is the temporary [wrapper over ADK's Gemini](/models/adk-gemini-adapter.md) (`AdkGeminiAdapter`), which runs the request through `TracedGemini`. Behind the [ADK shim](/models/adk-shim.md), which opens its span ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)), it records the `llm.request` span `TracedGemini` records.
