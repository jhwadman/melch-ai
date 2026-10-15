---
type: decision
title: "ADR 0131: The telemetry ledger writes to any Postgres through the storage's own pool, with the Supabase sink's rows, policy and redaction"
description: "postgresStorage({ ledger: true }) attaches the ledger exporter to its pool: the same adk_turns, adk_telemetry and adk_payloads rows the Supabase sink writes, one parameterised INSERT … SELECT FROM jsonb_populate_recordset per batch, naming only the ledger tables and the columns the row builders produce. attachLedger(client) is the run-time hook behind it, always registered and inert until attached. The A2A bin turns it on with TELEMETRY_POSTGRES=true beside DATABASE_URL. A second exporter class, per-column type mapping and an env-only switch were rejected."
tags:
  - decision
  - operations
  - memory
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-15
sources:
  - resource: lib/observability/supabaseSpanExporter.ts
  - resource: lib/observability/tracer.ts
  - resource: lib/storage/postgres/index.ts
  - resource: scripts/a2a_server.ts
  - resource: tests/postgresLedger.test.ts
---

# ADR 0131: The telemetry ledger writes to any Postgres through the storage's own pool, with the Supabase sink's rows, policy and redaction

## Context

The ledger (`adk_turns`, `adk_telemetry`, `adk_payloads`, from `db/telemetry.sql`) was written only by the Supabase sink, enabled by `TELEMETRY_SUPABASE=true` with Supabase API credentials. A deployment on `DATABASE_URL` (ADR 0021) kept sessions, memory and tasks in its own Postgres but could not keep its ledger there, and an application embedding the engine on PGlite (ADR 0130) had no ledger at all. The sink was also fixed at `initializeTracing()`: an embedding application that opens its database after the first span could not add one.

## Decision

1. **One exporter, two clients.** `SupabaseSpanExporter` already wrote through a narrow client (`from(table).insert(rows)`), now exported as `LedgerClient`. `postgresLedgerClient(pool)` implements it over a pg pool, so the row builders, the payload policy (`TELEMETRY_PAYLOADS`), the deferred payload decision, redaction (`TELEMETRY_REDACT`) and the dead-letter spool are the same code on both.
2. **One parameterised statement per batch.** The rows go in as a single JSON parameter to `INSERT INTO t (cols) SELECT cols FROM jsonb_populate_recordset(NULL::t, $1::jsonb)`. Postgres gives each value its column's type (JSONB, TEXT[], TIMESTAMPTZ), so the client maps nothing per column. Only the columns the rows carry are named, so identity and defaults stay the table's. The table must be one of `LEDGER_TABLES`, and column names come from the row builders, never from span content; both are quoted.
3. **Attached at run time.** `attachLedger(client)` sets the exporter behind a processor that `initializeTracing()` always registers and that does nothing until a ledger is attached. One ledger at a time; attaching warns when `TELEMETRY_SUPABASE=true` would double every row. It returns a detach that flushes first.
4. **The storage switch.** `postgresStorage({ ledger: true | { policy, deadLetterFile } })` attaches it on the storage's pool, and `close()` flushes and detaches it. The A2A bin passes `ledger: true` when `TELEMETRY_POSTGRES=true` and `DATABASE_URL` is set, and warns when the variable is set without a database.

## Alternatives rejected

- **A second exporter class for Postgres.** It would copy the payload buffering and policy, and the two would drift.
- **Mapping columns in TypeScript** (arrays to Postgres array literals, objects to JSON). pg's own parameter conversion turns a JS array into a Postgres array, which is wrong for JSONB columns; letting `jsonb_populate_recordset` read the table's types is exact and needs no list to maintain.
- **An environment variable alone.** An embedding application holds a pool, not a URL, and may open it after tracing starts; the variable stays for the bin.

## Consequences

- The ledger readers (Ymir's views, `scripts/telemetry_admin.ts`, melch-obs ingest) read the same tables wherever the rows were written.
- The ledger shares the storage pool; on a busy server, `DATABASE_POOL_MAX` covers the batched inserts too.
