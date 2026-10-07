---
type: model-provider
title: Provider routing
description: "How a model string in YAML reaches the right provider adapter: one prefix table, six providers, availability by API key."
tags:
  - models
  - routing
generated:
  by: process:wiki-build
  at: 2026-10-07
sources:
  - resource: lib/models/providerMap.ts
  - resource: lib/models/registry.ts
  - resource: lib/models/capabilities.ts
---

# Provider routing

<!-- wiki:fill slot="overview" -->
Model string routing relies on a single prefix table in `lib/models/providerMap.ts` across two distinct resolution paths. Standard entrypoints passing model names as strings rely on `registerAvailableProviders()`, which registers adapter classes into the ADK `LLMRegistry` to match string patterns such as `claude-*`, `gpt-*`, or `ollama/<model>`. In contrast, per-request paths like the [A2A server](/protocols/a2a.md) use `resolveModel()`, an instance factory that injects custom header credentials directly into new adapter instances. `runSyndicateTurn` calls `registerAvailableProviders()` itself whenever its caller passes no `compile.resolveModel`, so a string id never reaches ADK's own Gemini class, which would bypass the turn's step cap and cancellation.

All provider registration must occur before constructing agents. The `LLMRegistry` maintains an internal cache for model-to-class resolutions, meaning late registration can lead to stale cache hits that fail to resolve newly available providers.

The chat-completions adapters (Ollama and the gateways, both over `lib/models/openAiCompatibleLlm.ts`) read `finish_reason`. A turn that ends with reasoning but neither reply text nor a tool call is an error, never an empty reply: `<PROVIDER>_MAX_TOKENS` when the provider reports `length`, `<PROVIDER>_EMPTY_RESPONSE` when the model stopped after thinking ([ADR 0027](/decisions/0027-thinking-without-answer-is-an-error.md)). On Ollama, `length` almost always means the 4,096-token default context window, which the `/v1` path cannot raise; [failure modes](/operations/failure-modes.md) lists the remedies. The Ollama adapter first retries such a turn once with `reasoning_effort: "none"` (thinking off), counting both attempts' tokens, so the error reaches the caller only when the retry fails too; `OLLAMA_RETRY_WITHOUT_THINKING=false` turns that off.
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

The table above is the whole routing decision; the *transport* is a second, separate decision made in `lib/models/gateway.ts` and applied by the registry. A model id is served by its provider's own adapter whenever that provider's key is present. When the key is absent and `MODEL_GATEWAY` (`vercel` or `openrouter`) plus `MODEL_GATEWAY_API_KEY` are set, the id is served instead by `lib/models/gatewayLlm.ts` through the gateway's OpenAI-compatible chat-completions endpoint — a subclass of the same base the Ollama adapter uses. Ollama needs no key, is reached at `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`) and never routes through a gateway, and an [A2A](/protocols/a2a.md) caller's `X-API-Key` funds its own provider directly and never selects the gateway. The gateway is not a provider: `llm.provider` on the telemetry ledger (`db/telemetry.sql`) stays `anthropic`, `openai`, `gemini` or `xai`, and the path is recorded separately as `llm.transport = gateway:<id>`.

What a gateway cannot do is enable any upstream native search, so every server-side tool sentinel — `web_search`, `google_search`, `x_search`, `collections_search` — is dropped on that path. `lib/models/capabilities.ts` states this per agent on the resolved path; the compiler logs one `capability ·` line per affected agent at startup, the span carries `llm.capability.dropped`, and the doctor below shows it. Wire names follow a rule (`claude-sonnet-4-6` → `anthropic/claude-sonnet-4.6`; `grok-4.7` → `xai/…` on Vercel, `x-ai/…` on OpenRouter) with `MODEL_GATEWAY_MODEL_MAP` for exceptions and `MODEL_GATEWAY_BASE_URL` for a self-hosted proxy. Rationale: [ADR 0012](/decisions/0012-direct-adapters-canonical.md).

## Platforms: Vertex AI, Bedrock, Azure OpenAI and proxies

The provider is the id's; the *platform* is configuration (`lib/models/endpoints.ts`, [ADR 0023](/decisions/0023-bring-your-own-endpoint.md)). `GEMINI_PLATFORM=vertex` (or genai's own `GOOGLE_GENAI_USE_VERTEXAI`) sends Gemini through Vertex AI with Application Default Credentials for `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`; `ANTHROPIC_PLATFORM=bedrock` (with `AWS_REGION`) or `=vertex` (with `ANTHROPIC_VERTEX_PROJECT_ID`/`CLOUD_ML_REGION`) sends Claude through Anthropic's Bedrock or Vertex SDK client, optional peers loaded on first use; `OPENAI_PLATFORM=azure` with `AZURE_OPENAI_ENDPOINT` sends GPT to Azure OpenAI's v1 API with `AZURE_OPENAI_API_KEY` or an Entra ID token (`@azure/identity`). `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` put a proxy in front of the vendor API. `<PROVIDER>_MODEL_MAP` translates ids a platform names differently (a Bedrock inference profile, an Azure deployment). A configured cloud platform funds its provider without a vendor key and is not covered by the gateway. The A2A `credentials` plug point may return a key or a partial endpoint per request, and memory embeddings follow the Gemini platform. Native search is kept on Gemini-on-Vertex and not sent on the other three platforms; the capability report says so per agent, and the doctor prints one `endpoint` line per configured platform. These paths are tested against mocked clients, not the live clouds.

## Which keys do I need? The doctor

`npm run doctor` (`lib/doctor.ts`; the `melchizedek-doctor` bin in the package) reads every syndicate the loader can see — the agents directory's root, `examples/` and `templates/` — resolves each agent's model under the current environment through these same modules, and prints one table: agent, model, provider, the declared server-side tools the path keeps (✓) or drops (✗), and whether the path is funded (direct key, gateway, or local). One verdict per syndicate, then the variables that would unlock the most and where to get each. It is read-only and never prints a key value. Every starter-pack file opens with a `# tier:` header (`keyless`, a single provider such as `gemini`, or `multi-provider`) that the doctor checks against the models. The live counterpart that actually sends a prompt per provider is `npm run demo:models`.

Wiki agent operations default to `gemini-3.8-flash` (WIKI_AGENT_MODEL in lib/config.ts). Schema-dialect bridging between Gemini-uppercase and standard JSON Schema is covered in [tool contracts](/tools/tool-contracts.md).

<!-- wiki:generated section="capabilities" source="lib/models/capabilities.ts" -->
| Capability | Google Gemini | Anthropic Claude | OpenAI GPT | xAI Grok | Moonshot Kimi | Ollama (local) | Gateway (any id) |
|---|---|---|---|---|---|---|---|
| delegation (subagents as tools) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| memory tools (load_memory) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| structured output (outputSchema) | ✓ | ✓1 | ✓ | ✓ | ✓2 | ◐3 | ✓4 |
| thinking with tool use | ✓ | ✓5 | ◐6 | ◐7 | ◐8 | ◐9 | ◐10 |
| token streaming | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| image input | ✓ | ✗11 | ✓12 | ✓13 | ✓14 | ✓15 | ✓16 |
| native web search | ✓ | ✓ | ✓ | ✓ | ✗17 | ✗18 | ✗19 |

✓ supported · ◐ degraded · ✗ unsupported. Gemini cells are ADK's own adapter; every other cell is asserted against the request the adapter sends.

1. Anthropic Claude · structured output (outputSchema): sent as a forced tool call; with a thinking budget the tool is offered under tool_choice auto.
2. Moonshot Kimi · structured output (outputSchema): strict json_schema; kimi-k2.6 is documented as unstable on complex schemas ($ref, oneOf).
3. Ollama (local) · structured output (outputSchema): JSON mode only (json_object): the output is JSON but the schema is not enforced.
4. Gateway (any id) · structured output (outputSchema): strict json_schema; upstream support varies by model.
5. Anthropic Claude · thinking with tool use: signed thinking blocks are replayed verbatim within the turn's tool loop (ADR 0046); a step answering another model's tool call runs without thinking.
6. OpenAI GPT · thinking with tool use: reasoning is requested, but reasoning items are not carried across tool calls, so the model re-reasons each step.
7. xAI Grok · thinking with tool use: reasoning is requested, but reasoning items are not carried across tool calls, so the model re-reasons each step.
8. Moonshot Kimi · thinking with tool use: reasoning_content is not replayed across tool calls, which Moonshot asks for on kimi-k3, so the model re-reasons each step; effort travels as reasoning_effort (K3) or a thinking switch (K2.x).
9. Ollama (local) · thinking with tool use: thinkingConfig budgets are ignored on chat-completions; generateContentConfig.reasoningEffort is the lever.
10. Gateway (any id) · thinking with tool use: thinkingConfig budgets are ignored on chat-completions; generateContentConfig.reasoningEffort is the lever.
11. Anthropic Claude · image input: image parts are dropped from the request; route image work to a Gemini, GPT or vision Ollama agent.
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
| Anthropic Claude on Bedrock | native web search: ✗ not sent on Bedrock; the web_search sentinel is dropped (use web_extract) |
| Anthropic Claude on Vertex AI | native web search: ✗ not sent on Vertex AI; the web_search sentinel is dropped (use web_extract) |
| OpenAI GPT on Azure OpenAI | native web search: ✗ not sent on Azure OpenAI; the web_search sentinel is dropped (use web_extract) |
<!-- /wiki:generated -->

## Reasoning state across tool steps

Some providers want state back on the next request of a tool loop that only they can read: Anthropic's signed `thinking` and `redacted_thinking` blocks, OpenAI's and xAI's reasoning items, Moonshot's `reasoning_content`. Every adapter carries it the same way, as one field on a content part ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md), `lib/models/providerState.ts`):

```ts
{ functionCall: { … }, providerState: { provider: 'anthropic', kind: 'thinking_blocks', model: 'claude-sonnet-4-6', payload: [ … ] } }
```

- **Write.** The adapter that produced the response sets `providerState` on a part the model produced (a `functionCall` or `text` part), with `provider` set to its id from `lib/models/providerMap.ts` (`anthropic`, `openai`, `xai`, `moonshot`), a `kind` of its own naming, a JSON-serializable `payload`, and `model` when the provider binds the state to the model that produced it. `withProviderState(part, state)` returns the copy. Never a part of its own: `@google/genai` serializes parts field by field, so a state-only part reaches Gemini as an empty part.
- **Replay.** Only an adapter of the same provider reads it, through `providerStateOf(part, provider, kind, model?)`, which also skips another model's state when `model` is set, and sends the payload back verbatim. Every other adapter ignores the field, so a model switch between steps (a fallback model, a test that alternates models) drops the state instead of misreading it.
- **Keep.** ADK deep-clones `event.content` into the next `LlmRequest.contents`, so the field reaches the next step unchanged. The session services store it with the event, and `trimEventForStorage` keeps it whole; the plan-dispatch projection (`lib/session/transcript.ts`) drops it with the rest of a past turn.

Claude uses `kind: 'thinking_blocks'` and sets `model`, since signed thinking is bound to the model that produced it. It writes the state on the streamed and the non-streamed path alike: each run of signed blocks rides on the part that follows it in the response and is replayed immediately before that part, within the current turn's tool loop only (the assistant messages after the last user message that is not purely tool results). Display-only `{ text, thought: true }` parts are never sent back. With a thinking budget, a step whose pending tool call carries no signed block, because another provider or another Claude model made it, is sent without thinking (`llm.thinking.omitted` on the span), since Anthropic rejects a thinking request whose tool loop does not open with one.

An agent may name a `fallback_model` (`lib/models/fallback.ts`, [ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)). Its model is then wrapped: a provider-side failure (what `lib/models/retry.ts` classifies retryable, after the adapter's own retries) is answered by the fallback if nothing was produced yet, and a per-provider circuit opens after `MODEL_BREAKER_THRESHOLD` consecutive failures (default 5) so those agents skip the provider for `MODEL_BREAKER_COOLDOWN_MS` (default 30 s). A 4xx, a cancellation, and a stream that already yielded text are thrown as they are. Agents without a fallback are not wrapped.
