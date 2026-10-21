---
type: decision
title: "ADR 0139: The ledger keeps the span tree"
description: "adk_telemetry keeps a row for every span of a turn's tree (agent runs, model steps, tool calls, script and workflow spans) with its ledger parent, kind and error flag; tool spans carry bounded, redacted arguments and results; cache tokens are counted and priced at their own rates."
tags:
  - decision
  - observability
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-20
sources:
  - resource: db/migrations/0016_span_tree.sql
  - resource: db/migrations/0017_cache_pricing.sql
  - resource: db/telemetry.sql
  - resource: lib/observability/lineage.ts
  - resource: lib/observability/tracer.ts
  - resource: lib/observability/supabaseSpanExporter.ts
  - resource: lib/runtime/native/telemetry.ts
  - resource: tests/spanTree.test.ts
  - resource: tests/postgresLedger.test.ts
---

# ADR 0139: The ledger keeps the span tree

**Decided (2026-10-20):** `adk_telemetry` keeps a row for every span of a turn's tree, not only the root and each `llm.request`: agent runs, model steps, tool calls, script runs and calls, workflow walks and node runs, each with `parent_span_id` (the nearest ancestor the ledger keeps, which the tracer reads from its span lineage when the span starts), `kind` and `error` (migration 0016). A tool span carries its arguments and the first 8 KB of its result, redacted before the cut. Each call's cache reads and writes are counted on the span and the turn, and priced at their own `model_pricing` rates, NULL meaning the input rate (migration 0017); seeded rates are the ones checked against the vendor's list.

**Instead of:** rebuilding the tree at read time from `adk_payloads` (sampled, expiring) or from the root's tool events (no nesting); the direct OTel parent alone (a span the ledger skips would orphan its children); full tool results on the span (the root's `ToolResponse` events already hold them); a separate span table; tokens on `model.call` rows as well (a trace's rows would count each call twice); cache tokens priced as input, or rates carried over unchecked

**Supersedes:** [ADR 0076](/decisions/0076-native-loop-spans-feed-the-same-ledger.md) (only that tool spans carry no arguments or results); extends [ADR 0136](/decisions/0136-ledger-cost-at-write-time-from-model-pricing.md)

**Open:** Gemini, Grok and Kimi cache rates (their cache tokens price as input until checked); prompt-length price tiers (`claude-haiku-5-5`, `gpt-5.5` and `gpt-5.4` past 272K), which a flat row cannot price; OpenAI cache writes, which the adapter does not report

How it works: [Setup: the ledger](/operations/setup.md), [Native loop: the spans](/overview/native-loop.md#the-spans)
