---
type: decision
title: "ADR 0130: Embedded Postgres (PGlite) runs the same schema and adapter; the hardening skips absent API roles, and a single-process embed passes its own turn lock"
description: "PGlite with pgvector runs every migration, telemetry.sql and hardening.sql, and postgresStorage works unchanged over pglite-socket. hardening.sql revokes from anon and authenticated only where those roles exist, through two pg_temp helpers, so it applies on plain or embedded Postgres without creating roles. postgresStorage takes a turnLock option, because pglite-socket runs every connection in one session where an advisory lock is re-entrant; an embed passes inProcessTurnLock(), now exported beside it. Creating the Supabase roles in hardening.sql, a separate SQLite storage, and detecting PGlite were rejected."
tags:
  - decision
  - memory
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-15
sources:
  - resource: db/hardening.sql
  - resource: lib/storage/postgres/index.ts
  - resource: tests/embeddedPostgres.test.ts
---

# ADR 0130: Embedded Postgres (PGlite) runs the same schema and adapter; the hardening skips absent API roles, and a single-process embed passes its own turn lock

## Context

A desktop application that embeds the engine needs durable sessions, long-term memory and the ledger on the user's own machine, with no database server to install. PGlite (Postgres compiled to WebAssembly, with the pgvector extension as `@electric-sql/pglite-pgvector`) can hold them, and `@electric-sql/pglite-socket` serves it on a local TCP port so the `pg` driver connects to it like any Postgres. Tried against 1.4.0, every migration and `db/telemetry.sql` applied and `postgresStorage` ran sessions, memory and turns unchanged. Two things did not hold:

1. `db/hardening.sql` revoked privileges from `anon` and `authenticated` by name, and failed with `role "anon" does not exist` on any Postgres without Supabase's API roles. CI worked around it by creating the roles before `apply`.
2. The turn lock is a session-level advisory lock on a connection of its own. pglite-socket multiplexes every client onto PGlite's one backend session, where an advisory lock is re-entrant: a second turn on the same conversation took the lock while the first held it.

## Decision

1. **The hardening revokes from the API roles that exist.** Two helpers in `pg_temp` (`melchizedek_api_roles`, `melchizedek_revoke_api`) list whichever of `anon` and `authenticated` exist and revoke from those; with neither present the role revokes are skipped. RLS, the `PUBLIC` function revokes and the `service_role` grants (already conditional) are unchanged. The helpers live in the session's temporary schema and leave nothing behind on a server. Supabase, where the roles exist, gets exactly the revokes it got before.
2. **`postgresStorage({ turnLock })`.** When given, the storage uses it and opens no turn-lock pool; the advisory lock stays the default. `inProcessTurnLock` (and the `TurnLock` type) are exported from `melchizedek-agents/storage/postgres` so an embed passes `turnLock: inProcessTurnLock()`. One process owning the database is what makes that lock correct.
3. **PGlite is a dev dependency only.** `tests/embeddedPostgres.test.ts` installs the schema twice on PGlite with no API roles, checks the revokes where the roles do exist, runs turns through `postgresStorage` over pglite-socket, and pins both lock behaviours. The package does not depend on PGlite; an embedding application brings it.

## Alternatives rejected

- **Create `anon`, `authenticated` and `service_role` at the top of `hardening.sql`.** It needs `CREATEROLE`, which a managed Postgres user may lack, and leaves roles on a database that never had a REST API. Skipping the revokes is the accurate statement: there is nothing to revoke from.
- **A SQLite `SessionService` and `MemoryService`.** A second storage implementation to keep in step with the first, without the ledger's SQL (views, `match_turns`) or pgvector. PGlite runs the one schema.
- **Detect PGlite and switch the lock automatically.** The server cannot tell a multiplexing proxy from a database by the connection; the embedder knows, so it decides.

## Consequences

- `npx melchizedek-db apply` works on plain Postgres without the CI role step; the step stays in CI so the Supabase-shaped path is still exercised.
- An application that embeds PGlite must pass `turnLock: inProcessTurnLock()` and run one engine process against the data directory. Two processes on one PGlite data directory are not supported.
