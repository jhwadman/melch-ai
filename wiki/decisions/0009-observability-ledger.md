---
type: decision
title: "ADR 0009: One ledger for turns, spans and payloads, apart from sessions"
description: "Every turn is a first-class ledger row with identity and provenance, full payloads go to a policy-sampled expiring table, and sessions stay runtime state."
tags:
  - decision
  - observability
  - telemetry
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: db/telemetry.sql
  - resource: lib/observability/supabaseSpanExporter.ts
  - resource: lib/observability/lineage.ts
  - resource: lib/observability/tracer.ts
---

# ADR 0009: One ledger for turns, spans and payloads, apart from sessions

**Decided (2026-08-22):** `adk_turns` records each turn as the unit of record, `adk_telemetry` keeps raw spans, and `adk_payloads` keeps full model payloads under a sampling policy and expiry; nothing observability-related is added to sessions, which the ledger joins by id.

**Instead of:** full payloads in the session log, traces matched to sessions by timestamp

How it works: [Setup paths](/operations/setup.md)
