---
type: decision
title: "ADR 0131: The telemetry ledger writes to any Postgres through the storage's pool"
description: "postgresStorage({ ledger: true }) writes the Supabase sink's ledger rows to any Postgres through the storage's own pool."
tags:
  - decision
  - operations
  - memory
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/observability/supabaseSpanExporter.ts
  - resource: lib/observability/tracer.ts
  - resource: lib/storage/postgres/index.ts
  - resource: scripts/a2a_server.ts
  - resource: tests/postgresLedger.test.ts
---

# ADR 0131: The telemetry ledger writes to any Postgres through the storage's pool

**Decided (2026-10-15):** The ledger can be written to any Postgres, embedded included, through the storage's own pool, reusing the Supabase sink's exporter, rows, payload policy and redaction, and attached at run time (`postgresStorage({ ledger: true })`; `TELEMETRY_POSTGRES=true` for the server).

**Instead of:** a second exporter class, per-column type mapping in TypeScript, an environment variable alone

How it works: [Setup](/operations/setup.md)
