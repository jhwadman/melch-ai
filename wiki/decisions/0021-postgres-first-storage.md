---
type: decision
title: "ADR 0021: One Postgres connection holds every durable store; Redis optional"
description: "All durable state goes through one pg-driver storage adapter with versioned migrations; in-memory is the single-instance default; Redis is an optional limiter; supabase-js is deprecated."
tags:
  - decision
  - memory
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/persistence/supabaseProvider.ts
  - resource: lib/session/supabaseSessionService.ts
  - resource: db/hardening.sql
  - resource: lib/a2a/app.ts
---

# ADR 0021: One Postgres connection holds every durable store; Redis optional

**Decided (2026-10-01):** `postgresStorage(DATABASE_URL)` holds sessions, memory, A2A tasks, the job queue, turn locks, counters and the registry on any Postgres, with numbered migrations and a schema-version check; multiple instances are supported exactly when it is plugged in.

**Instead of:** Redis beside Postgres as a requirement, keeping supabase-js with a configurable schema, ADK's `DatabaseSessionService`
**Open:** remove the deprecated supabase-js storage after its transition period

How it works: [Setup paths](/operations/setup.md)
