---
type: decision
title: 'ADR 0042: An append-only audit trail of who did what, from where'
description: Failed authentications, task outcomes and erasures are recorded in melchizedek_audit with caller, source address, agent and task ids and a scope hash, never content; a trigger refuses UPDATE and DELETE, and a SECURITY DEFINER prune function is the only retention path.
tags:
  - decision
  - security
  - observability
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-06
sources:
  - resource: db/migrations/0012_audit_log.sql
  - resource: lib/observability/audit.ts
  - resource: lib/a2a/app.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/auditTrail.test.ts
---

# ADR 0042: An append-only audit trail of who did what, from where

## Context

An enterprise readiness audit (6 October 2026) found that the telemetry
ledger could not serve as SOC 2 evidence (DATA-01): its rows can be updated
or deleted, it records the scope, surface and task but not the caller, the
auth method or the source address, and authentication events are not
recorded at all. The ledger answers "what did the turn say"; an auditor
asks "who asked, how were they authenticated, from where, and was it
allowed".

## Decision

- **A separate table**, `melchizedek_audit` (migration 0012), one row per
  event: `auth.failure`, `task.end`, `memory.erase`. A row holds the event,
  its outcome, the caller's name, a SHA-256 prefix of the scope, the source
  address, the agent and task ids, and a small content-free `detail`.
- **Append-only.** A trigger refuses UPDATE and DELETE. The API role gets
  SELECT and INSERT only. `melchizedek_prune_audit(days)` (SECURITY DEFINER)
  is the one way rows leave, setting a transaction-local flag the trigger
  honours.
- **Never in the way.** The sink is fire-and-forget; a failed write is
  logged once per outage, and each event is printed to stderr as JSON so it
  is not lost silently.
- **Wiring.** `postgresStorage` supplies `audit`; `createA2AApp` uses it, or
  an `audit` option for any other sink. The source address joins the
  request context for this purpose only; the stdout task record does not
  carry it.

## Alternatives

- **Extend the ledger.** Its rows carry conversation content and are
  erased with a user; audit evidence must outlive an erasure and must not
  hold content.
- **Logs only.** A log line is easy to lose and easy to edit; a table with
  a trigger gives a reviewer a definite answer, and the stderr fallback
  keeps the log path for outages.
- **Hash the source address.** It would defeat the reason to record it
  (tracing an attack to a network); retention is the control instead.

## Consequences

- A deployment schedules the prune for its retention period; nothing
  prunes the table by default.
- A database owner can still drop the trigger. Evidence that must survive
  the database's administrators belongs in an external log store too.
- Approval decisions are visible as task outcomes (`input-required`, then
  the resumed task); a dedicated approval event, with the approver, is
  future work.
