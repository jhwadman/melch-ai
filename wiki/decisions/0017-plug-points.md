---
type: decision
title: "ADR 0017: The engine is a library with plug points the adopter fills"
description: "Identity, credentials, storage, memory, policy and registrations are options of the server factory with sensible defaults; the framework never models users or tenants."
tags:
  - decision
  - protocols
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/a2a/app.ts
  - resource: scripts/a2a_server.ts
  - resource: lib/persistence/supabaseProvider.ts
---

# ADR 0017: The engine is a library with plug points the adopter fills

**Decided (2026-10-01):** The engine exports `runSyndicateTurn` and `createA2AApp(options)`; each infrastructure decision is a factory option, the scope key is opaque and supplied (never derived from a credential), and bring-your-own-key is a mode rather than the default.

**Instead of:** a built-in user and tenant model, a monolithic server tuned by env vars, key-hash identity as the default

How it works: [A2A](/protocols/a2a.md)
