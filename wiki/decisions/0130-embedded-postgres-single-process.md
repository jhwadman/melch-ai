---
type: decision
title: "ADR 0130: Embedded Postgres (PGlite) runs the same schema and adapter"
description: "PGlite runs the same schema and postgresStorage; the hardening skips absent API roles and a single-process embed passes its own turn lock."
tags:
  - decision
  - memory
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: db/hardening.sql
  - resource: lib/storage/postgres/index.ts
  - resource: tests/embeddedPostgres.test.ts
---

# ADR 0130: Embedded Postgres (PGlite) runs the same schema and adapter

**Decided (2026-10-15):** An embedding application uses PGlite (over pglite-socket) with the same migrations and `postgresStorage`; `hardening.sql` revokes only from the API roles that exist, and an embed passes `turnLock: inProcessTurnLock()` because the socket shares one session. PGlite stays a dev dependency.

**Instead of:** creating the Supabase roles in `hardening.sql`, a SQLite storage, detecting PGlite automatically

How it works: [Setup](/operations/setup.md)
