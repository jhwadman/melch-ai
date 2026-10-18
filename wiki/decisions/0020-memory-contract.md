---
type: decision
title: "ADR 0020: Memory keyed by stored namespace and supplied scope, erased at once"
description: "Facts are filed under a stored memory_namespace and a supplied scope key, computed by a configured provider, ingested at least once, and erased with every store in one operation."
tags:
  - decision
  - memory
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/memory/supabaseMemoryService.ts
  - resource: lib/session/supabaseSessionService.ts
  - resource: lib/a2a/app.ts
---

# ADR 0020: Memory keyed by stored namespace and supplied scope, erased at once

**Decided (2026-10-01):** Memory is keyed `<memory_namespace>/<scopeKey>` with the namespace written once and never recomputed; extraction and embeddings run on configured providers; ingestion is at-least-once; and one `eraseScope` removes every store holding the user's words.

**Instead of:** the syndicate name as namespace, a namespace from path or config hash, Google-only memory
**Open:** a long-term syndicate without `memory_namespace` still falls back to `melchizedek-a2a`; making it a validation error waits on re-keying live deployments

How it works: [Memory architecture](/memory/architecture.md)
