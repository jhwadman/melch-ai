---
type: decision
title: "ADR 0147: A memory store records its embedding model and refuses another; the doctor says what embeds, with OpenRouter's answer"
description: "Migration 0023 records the provider, model and dimension a memory store's vectors come from on the first write, and the memory service refuses a different model at start; the doctor gains a memory line from a pure embedder plan, naming the fix when nothing embeds, including the documented OpenRouter default (MEMORY_EMBEDDING_PROVIDER=openai, text-embedding-3-small at 768) with the re-embed caveat."
tags:
  - decision
  - memory
  - operations
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-23
sources:
  - resource: db/migrations/0023_memory_embedder.sql
  - resource: lib/memory/store.ts
  - resource: lib/memory/supabaseMemoryService.ts
  - resource: lib/memory/providers.ts
  - resource: lib/doctor.ts
  - resource: tests/memoryIngestion.test.ts
  - resource: tests/memoryProviders.test.ts
  - resource: tests/doctor.test.ts
---

# ADR 0147: A memory store records its embedding model and refuses another; the doctor says what embeds, with OpenRouter's answer

**Decided (2026-10-23):** Every vector in a memory store comes from one model, and a different model at the same dimension passes the size check (migration 0007) while quietly degrading recall, so the store now says which model it holds. Migration 0023 adds a one-row table the memory service fills on its first successful write (provider, model, dimension) and reads at start: an embedder whose model differs is refused with the recorded model named and the two ways out (set the embedder back, or re-embed every fact), never mixed. A gateway's spelling of the same model is the same model (the last path segment is compared), so a store embedded directly and then through Vercel agrees with itself. A store with no record (older migrations, or nothing written yet) is not refused; the first write records it. The doctor gains a `memory` line from `embedderPlan`, a pure reading of the environment that builds no client: what would embed, on which path, or what to set when nothing does. The OpenRouter case gets its documented default there and in the setup guide: OpenRouter carries no Gemini embedding model, so `MEMORY_EMBEDDING_PROVIDER=openai` embeds `text-embedding-3-small` at 768 through it (both gateways carry it and honour the dimension; it costs a tenth of Gemini's), with the caveat that a store already embedded with Gemini must be re-embedded if the model changes.

**Instead of:** a different automatic embedding default on OpenRouter (a silent switch of model behind a store); a setting with no record in the store (the caveat stays a caveat); recording the model at start rather than on the first write (an empty store would then be pinned to a model it never used); comparing exact ids (the gateway's `google/` prefix would refuse the same model); failing `--check` on a missing embedder (a deployment without memory syndicates is fine; the line is a warning when none is long-term)
**Supersedes:** none ([ADR 0020](/decisions/0020-memory-contract.md) item 5's dimension check stays; this adds the model beside it)
**Superseded by:** [ADR 0148](/decisions/0148-search-budget-and-reembed.md) (the re-embed command, `npm run memory -- reembed`)
**Open:** recording per namespace should a deployment ever embed namespaces with different models

How it works: [Memory architecture](/memory/architecture.md)
