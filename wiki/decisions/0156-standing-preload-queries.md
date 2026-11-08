---
type: decision
title: "ADR 0156: Standing preload queries put a syndicate's core memory into every request"
description: "A syndicate's memory_preload_queries run beside the message's own preload search, each adding up to 2 records not already recalled, so what every answer needs reaches the agent however the question is worded; load_memory is unchanged."
tags:
  - decision
  - memory
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-11-07
sources:
  - resource: lib/runtime/nativeTurn.ts
  - resource: lib/tools/memoryTools.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/patientProfileMemory.test.ts
---

# ADR 0156: Standing preload queries put a syndicate's core memory into every request

**Decided (2026-11-07):** A syndicate may declare `memory_preload_queries`, standing queries that `preload_memory` runs beside the message's own search; each adds up to 2 records the message did not already recall, after the message's own. A patient's allergies or a client's stated preferences then reach the agent on a question whose wording is nowhere near them. The search request carries `purpose: 'preload'` so the turn's memory adapter knows to add them; `load_memory` searches the query alone.

**Instead of:** a stored profile summary record (the extractor would rewrite it every session, and the dedup and supersession rules are built for atomic records); reserving recall slots per tag or key in the store's re-rank (needs a vocabulary the engine does not own); telling the agent to call `load_memory` for the core domains (costs model steps and depends on the model remembering).

**Open:** standing records carry no relevance floor, so a silo with nothing in a domain fills that query's 2 slots with its nearest records.

How it works: [Memory architecture](/memory/architecture.md).
