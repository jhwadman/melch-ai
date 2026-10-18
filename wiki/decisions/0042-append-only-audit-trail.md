---
type: decision
title: "ADR 0042: An append-only audit trail of who did what, from where"
description: "Failed authentications, task outcomes and erasures are recorded in melchizedek_audit without content; a trigger refuses UPDATE and DELETE, and a SECURITY DEFINER prune is the only retention path."
tags:
  - decision
  - security
  - observability
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: db/migrations/0012_audit_log.sql
  - resource: lib/observability/audit.ts
  - resource: lib/a2a/app.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/auditTrail.test.ts
---

# ADR 0042: An append-only audit trail of who did what, from where

**Decided (2026-10-06):** A separate append-only table, `melchizedek_audit`, records who did what and from where: caller, source address and ids, never content. A trigger refuses UPDATE and DELETE, a SECURITY DEFINER prune function is the only way rows leave, and the sink never blocks a request.

**Instead of:** extending the telemetry ledger, logs only, hashing the source address
**Open:** a dedicated approval event naming the approver

How it works: [Setup](/operations/setup.md)
