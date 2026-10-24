---
type: decision
title: "ADR 0148: A gateway's search is bounded by a result count, and a memory store can be re-embedded"
description: "MODEL_GATEWAY_SEARCH_RESULTS (default 3) is passed as each gateway search engine's count, Exa on its instant type and Perplexity under a token cap, since the results are billed as prompt tokens and an unbounded Exa search folded 20,000 of them into one prompt; `npm run memory -- reembed` re-embeds every stored fact with the environment's embedder in id-ordered pages and records it last, under an advisory lock on Postgres, so a refused model switch (ADR 0147) has a way through."
tags:
  - decision
  - models
  - memory
  - operations
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-23
sources:
  - resource: lib/models/gateway.ts
  - resource: lib/memory/reembed.ts
  - resource: lib/memory/store.ts
  - resource: scripts/memory_admin.ts
  - resource: db/migrations/0023_memory_embedder.sql
  - resource: tests/memoryReembed.test.ts
  - resource: tests/gateway.test.ts
---

# ADR 0148: A gateway's search is bounded by a result count, and a memory store can be re-embedded

**Decided (2026-10-23):** Two closings of what ADR 0146 and ADR 0147 left open. First, a gateway's search is bounded. The gateway folds its results into the model's prompt, where they are billed as input tokens: measured live, Vercel's Exa search at its default carried about 20,000 prompt tokens for a one-line question, and a single Exa page runs anywhere from 2,000 to 10,000. `MODEL_GATEWAY_SEARCH_RESULTS` (default 3, 1 to 10) is the operator's one number, passed as each engine's count: Exa gets `type: instant` and `num_results`; Perplexity gets `max_results` with `max_tokens` of 2,000 a result and `max_tokens_per_page` 2,000; Parallel gets `mode: agentic`, `max_results` and `excerpts.max_chars_total` of 8,000 characters a result; OpenRouter's plugin gets `max_results`. Vercel reads the config as developer defaults, so the model's query is never set. The span carries `llm.web_search.results`. For Exa the count bounds pages, not tokens: three instant results measured 7,000, 15,600 and 17,600 prompt tokens across three live runs, against 13,000 to 20,000 unbounded, because pages differ in size; Perplexity at three results under its cap measured 6,200 and 6,300 twice, so `MODEL_GATEWAY_SEARCH=perplexity` is the engine whose bill is actually bounded, at a slightly higher search fee. The posture the setup note and the app's gateway card now state is the honest one: a gateway is for billing and breadth, not for grounding, so a search-heavy agent keeps the searching provider on its own key and the gateway serves the rest, which a direct key beside the gateway key does by default and `MODEL_GATEWAY_EXCEPT` keeps under `prefer=gateway`. Second, a store can be re-embedded. `npm run memory -- reembed` (a dry run; `--yes` writes) builds the embedder from the environment, refuses a dimension the column does not hold, walks the facts in id order one page at a time, writes each page's vectors back, and only then overwrites the record (`melchizedek_memory_set_embedder`, migration 0023), so an interrupted run leaves the old record and the service keeps refusing the new model until the run completes. On `DATABASE_URL` it holds an advisory lock so two runs never interleave; on the Supabase API it cannot, and says so. It prints counts, models and sizes, never a fact. `MemoryStore` gains `listFacts`, `updateEmbeddings` and `setEmbedder`.

**Instead of:** a token budget as the operator's knob (one more derived number to explain; the count is what every engine takes, and the caps ride beside it); a smaller default engine (Parallel was cheapest but slow, and Perplexity failed once in four live calls); leaving the switch to hand-written SQL (an operator would have to know the vector literal, the lock and the record); re-embedding inside the server at start (a long write on every boot that saw a new model, and a store half-written while turns arrive); recording the new model first (a crash would leave a store that says the new model and holds the old vectors)
**Supersedes:** [ADR 0147](/decisions/0147-memory-embedder-recorded-and-doctored.md) (the open item: a re-embed command now exists)
**Open:** a per-agent result count (today one number per deployment); re-embedding a column of a new size (a migration, then this command); the app offering the re-embed from its Long-term memory setting (melch-app)

How it works: [Provider routing](/models/provider-routing.md#transport-direct-by-default-a-gateway-only-for-what-is-absent), [Memory architecture](/memory/architecture.md)
