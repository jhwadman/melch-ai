---
type: decision
title: "ADR 0150: The agent registry is read and written over DATABASE_URL when it is set"
description: "With DATABASE_URL the server loads registry rows from that database through postgresStorage's registry reader, and lib/registry.ts and melchizedek-registry publish, roll back and retire over a pg pool with the migration's own SQL functions; the Supabase API stays the path without it, so registry agents and their updates work on any Postgres."
tags:
  - decision
  - operations
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-29
sources:
  - resource: lib/registry.ts
  - resource: lib/loadSyndicate.ts
  - resource: lib/storage/postgres/index.ts
  - resource: lib/a2a/app.ts
  - resource: scripts/registry.ts
  - resource: tests/registryPostgres.test.ts
---

# ADR 0150: The agent registry is read and written over DATABASE_URL when it is set

**Decided (2026-10-29):** The registry follows the storage. With `DATABASE_URL`, every durable store is already in that one Postgres (ADR 0021), and now the registry is too: the server loads `registry:<id>` and `A2A_REGISTRY_AGENTS` rows through `postgresStorage`'s `registry` reader, on its pool and its schema, and the publishing library and `melchizedek-registry` write through a pool with the same `melchizedek_registry_publish` and `melchizedek_registry_activate` the Supabase path calls, so versions, authors and notes are recorded the same way. Without `DATABASE_URL` the Supabase API is the path, as before. A deployment on plain Postgres (Neon, a host's own, embedded) can now serve registry agents and update them without a redeploy, which the desktop app's one-click deploy needs.

**Instead of:** keeping the registry on the Supabase API only (a registry agent needed Supabase even when every other store was on `DATABASE_URL`, and a private `MELCHIZEDEK_DB_SCHEMA` registry was unreachable); a separate `REGISTRY_DATABASE_URL` (a second database to name for one table that already lives beside the others); a pg-backed imitation of supabase-js's `from()` builder behind the existing `RegistryClient` type (a query builder to maintain for six statements)
**Open:** a server that re-reads a registry row without a restart (each instance still caches a loaded config for its lifetime); a deployment with both `DATABASE_URL` and Supabase credentials pointing at different databases now reads the registry from `DATABASE_URL`'s

How it works: [A2A](/protocols/a2a.md), [Schema](/memory/schema.md)
