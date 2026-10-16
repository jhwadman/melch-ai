---
type: decision
title: "ADR 0136: The ledger records cost at write time, by a database trigger reading model_pricing, from per-model usage the tracer puts on the root span"
description: "adk_turns and adk_telemetry recorded tokens but no dollars, so every reader (ymir, melch-obs, the desktop app) kept its own copy of a price table. Migration 0015 adds model_pricing (USD per million tokens, verified_at per row, seeded from melch-obs's pricing.toml, ollama/* at zero) and two pricing functions; db/telemetry.sql adds cost_usd to both tables, filled by a BEFORE INSERT trigger: a model call from its model and tokens, a turn from syndicate.usage, the per-model usage the tracer sums over the turn's calls. NULL for any unpriced model. Pricing in the exporter, pricing at read time in a view, and summing a turn's telemetry rows were rejected."
tags:
  - decision
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-15
sources:
  - resource: db/migrations/0015_model_pricing.sql
  - resource: db/telemetry.sql
  - resource: db/hardening.sql
  - resource: lib/observability/tracer.ts
  - resource: tests/postgresLedger.test.ts
---

# ADR 0136: The ledger records cost at write time, by a database trigger reading model_pricing, from per-model usage the tracer puts on the root span

## Context

The ledger ([ADR 0009](/decisions/0009-observability-ledger.md), [ADR 0131](/decisions/0131-ledger-over-direct-postgres.md)) records each turn's and each model call's tokens, never what they cost. ymir kept `ymir_model_pricing`, melch-obs `pricing.toml`, and the desktop app a TypeScript copy of the same rows: three tables that drift. A turn row could not even be priced afterwards: its `input_tokens` is the peak prompt across the turn's calls, not their sum, and a turn that used two models records one total for both.

## Decision

1. **`model_pricing`, a migration.** `db/migrations/0015_model_pricing.sql` creates it (USD per million tokens for input, output and, optionally, thinking; `verified_at`, NULL meaning nobody checked the row against a vendor list, as ymir's convention; `source`, `note`) and seeds it from melch-obs's `pricing.toml`: the Anthropic rows dated to the month the file names, Gemini 3.5 Flash-Lite to its check, the carried-over Gemini and Grok rows unverified, and `ollama/*` at zero. A row whose id ends in `/*` prices every id under that prefix. The seed never overwrites a row, so an operator's rates survive a re-run; a rate change ships as a later migration.
2. **Two pricing functions** in the same migration: `melchizedek_cost_usd(model, input, output, thinking)`, NULL for a model with no row, and `melchizedek_usage_cost(usage)`, a turn's cost from `{model: {input, output, thinking}}`, NULL when any model in it has no row and zero when it holds none. Thinking bills at the output rate unless the row says otherwise; the ledger's output tokens exclude thinking, so it is priced on top.
3. **The tracer records per-model usage.** The root span's finally sets `syndicate.usage`: each model's calls and tokens summed over the turn's `llm.request` spans, input summed per call, which is what a provider bills.
4. **A trigger prices each row at write time.** `db/telemetry.sql` adds `cost_usd` to `adk_turns` and `adk_telemetry` and a `BEFORE INSERT` trigger on each: a model-call row from its model and tokens, a root row and a turn row from `syndicate.usage`. A value the writer set is kept; unreadable usage leaves NULL and never fails the insert. The triggers are `SECURITY DEFINER` with a fixed search path, so a writer role that cannot read `model_pricing` still gets the cost; `hardening.sql` closes the table and the functions to the API roles. `adk_kpi_daily` gains `cost_usd`.
5. **The rate recorded is the rate at write time.** A later price change does not rewrite history; re-pricing is a deliberate `UPDATE`.

## Alternatives rejected

- **Pricing in the exporter** (a TypeScript table the exporter reads). It is a fourth copy, a Supabase operator changes a rate by redeploying, and a dead-letter replay or any other writer misses it. In the database the price table is the one source and every writer gets it.
- **Pricing at read time** in a view joining `model_pricing`. Old turns would change cost whenever a rate changed, and a turn row alone cannot be priced (peak input, one total for several models).
- **A turn's cost as the sum of its `adk_telemetry` rows.** The two tables are written by separate fire-and-forget inserts in no fixed order, so a trigger on the turn row could not count on the call rows being there.
- **A partial sum when one model is unpriced.** It reads as the turn's cost; NULL says it is unknown.
