---
type: decision
title: "ADR 0146: A gateway runs its own web search for web_search, and embeds for memory when it carries the same model"
description: "On the gateway path web_search is no longer dropped: Vercel AI Gateway's server search tool or OpenRouter's web plugin runs it, OpenRouter's citations are kept as grounding, and MODEL_GATEWAY_SEARCH names the engine or turns it off; long-term memory embeds through the gateway's /embeddings when the gateway carries the configured embedding model and the provider's key is absent or the gateway is preferred."
tags:
  - decision
  - models
  - memory
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-23
sources:
  - resource: lib/models/gateway.ts
  - resource: lib/models/gatewayAdapter.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/capabilities.ts
  - resource: lib/memory/providers.ts
  - resource: tests/gateway.test.ts
  - resource: tests/memoryProviders.test.ts
---

# ADR 0146: A gateway runs its own web search for web_search, and embeds for memory when it carries the same model

**Decided (2026-10-23):** Two things the gateway path used to lose are given back where the gateway itself offers them. An agent's `web_search` (and `google_search`) runs as the gateway's own search on any model: Vercel AI Gateway's server tool (`vercel:exa_search` by default, appended to the function tools; the gateway searches, folds the results into the context and answers in one response; no citations come back) or OpenRouter's web plugin (`plugins: [{ id: 'web' }]`, the provider's native search where the model has one and Exa elsewhere; its `url_citation` annotations are kept as the final's `grounding.citations`). `MODEL_GATEWAY_SEARCH` names the engine or turns the search off, and an engine the gateway lacks is named by the doctor. `x_search` and `collections_search` have no gateway form and are still dropped. The gateway's matrix row reads `native_search` as degraded with that note, and the capability report says which search ran (`gatewaySearch`). Long-term memory's embedder follows the transport rule: with no key for its provider, or under `MODEL_GATEWAY_PREFER=gateway`, it embeds through the gateway's `/embeddings` when the gateway carries the same model (`GatewayInfo.embeddings`: Vercel carries `google/gemini-embedding-001` and `openai/text-embedding-3-small` and honours `dimensions`, checked live at 768; OpenRouter carries OpenAI's), so a store embedded directly and one embedded through the gateway hold the same model's vectors. A gateway that lacks the model changes nothing: the direct path stays and fails loudly for want of a key, never a different model behind the store's back. An explicit `MEMORY_EMBEDDING_BASE_URL` is the operator's choice and is not overridden.

**Instead of:** leaving search dropped on the gateway path (the loss was the one reason left to prefer direct keys for a search agent); mapping `web_search` to the upstream's native switch through the gateway (no chat-completions gateway exposes one uniformly); a gateway embedder that falls back to whatever embedding model the gateway has (a store's vectors must come from one model; a silent switch degrades recall); a separate `MEMORY_EMBEDDING_GATEWAY` variable (the transport rule already says when the gateway serves a provider)
**Supersedes:** [ADR 0144](/decisions/0144-typesafe-jev-decision-provider.md) (the "native search tools are dropped on the gateway path" that the setup copy carried from ADR 0012; the drop now applies to x_search and Collections only)
**Open:** Vercel's search engines were run live (exa, perplexity: answers in about one and two seconds, about $0.007 and $0.01 a call on top of the tokens); OpenRouter's plugin, its citations and its embeddings were not run live; whether to surface Vercel's `gatewayToolCalls` count as `grounding.searchQueries` once the gateway returns the queries; a per-agent engine choice should one syndicate want Perplexity and another Exa

How it works: [Provider routing](/models/provider-routing.md#transport-direct-by-default-a-gateway-only-for-what-is-absent)
