---
type: decision
title: "ADR 0136: The ledger records cost at write time from model_pricing"
description: "A database trigger prices each ledger row at write time from a model_pricing table, using per-model usage the tracer puts on the root span."
tags:
  - decision
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: db/migrations/0015_model_pricing.sql
  - resource: db/telemetry.sql
  - resource: db/hardening.sql
  - resource: lib/observability/tracer.ts
  - resource: tests/postgresLedger.test.ts
---

# ADR 0136: The ledger records cost at write time from model_pricing

**Decided (2026-10-15):** The database prices each ledger row as it is written: a `BEFORE INSERT` trigger reads the `model_pricing` table (migration 0015) and fills `cost_usd`, a turn from the per-model usage the tracer records on its root span, NULL when any model is unpriced. The rate recorded is the rate at write time.

**Instead of:** pricing in the exporter, pricing at read time in a view, summing a turn's telemetry rows, a partial sum when a model is unpriced

How it works: [Schema](/memory/schema.md)
