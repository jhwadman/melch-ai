---
type: decision
title: "ADR 0026: Governance on the policy plug point: budgets, task records, metrics, ledger redaction"
description: "Daily budgets per caller and per scope are checked at admission and charged at task end; every task yields one content-free record and Prometheus metrics labelled by caller; the ledger is redacted before it is written."
tags:
  - decision
  - protocols
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/a2a/policy.ts
  - resource: lib/observability/metrics.ts
  - resource: lib/observability/redact.ts
  - resource: lib/a2a/executor.ts
  - resource: db/migrations/0004_usage.sql
  - resource: tests/governance.test.ts
---

# ADR 0026: Governance on the policy plug point: budgets, task records, metrics, ledger redaction

**Decided (2026-10-01):** Governance runs on the `policy` plug point. The built-in policy counts tasks, model calls and tokens per UTC day, per caller and per scope, checked when a task is admitted and charged when it ends, failing closed when its store cannot be read. Every task produces one content-free record and Prometheus metrics labelled by caller, never by scope. The telemetry ledger is redacted before it is written (credentials by default), while sessions and memory are not.

**Instead of:** reserving an estimated budget at admission, budgets in currency, OpenTelemetry metrics, a `prom-client` dependency, redacting sessions and memory

How it works: [A2A](/protocols/a2a.md)
