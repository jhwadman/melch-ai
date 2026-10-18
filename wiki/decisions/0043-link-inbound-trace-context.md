---
type: decision
title: "ADR 0043: A caller's trace context is linked, never adopted"
description: "An inbound W3C traceparent becomes a span link and a caller.trace_id attribute; the turn keeps a fresh trace id because ledger attribution and erasure key on it."
tags:
  - decision
  - observability
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/observability/tracer.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/traceCorrelation.test.ts
---

# ADR 0043: A caller's trace context is linked, never adopted

**Decided (2026-10-06):** An inbound W3C `traceparent` becomes a span link and a `caller.trace_id` attribute on the turn's root span. The turn always keeps a fresh trace id, because ledger attribution, in-process turn state and erasure key on it.

**Instead of:** adopting the caller's trace as parent, adopting it only for trusted callers

How it works: [Setup](/operations/setup.md)
