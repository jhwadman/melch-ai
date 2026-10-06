---
type: decision
title: 'ADR 0038: A graceful stop fails readiness first, inside the grace budget'
description: On SIGTERM the server fails /readyz and keeps serving for A2A_SHUTDOWN_DELAY_MS before closing its listener and draining; the delay counts inside A2A_SHUTDOWN_GRACE_MS so a stop still fits Kubernetes' default 30 s; /readyz also fails while durable storage does not answer.
tags:
  - decision
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-06
sources:
  - resource: scripts/a2a_server.ts
  - resource: lib/a2a/app.ts
  - resource: lib/loadEnv.ts
  - resource: tests/serverShutdown.test.ts
  - resource: tests/readiness.test.ts
---

# ADR 0038: A graceful stop fails readiness first, inside the grace budget

## Context

On SIGTERM the server called `server.close()` at once and then drained
running tasks. A load balancer keeps sending requests to an instance for a
few seconds after the orchestrator signals it, until its readiness checks
fail and the endpoint is removed, so every rolling deploy refused the
connections that arrived in that window. `/readyz` reported only the
draining flag, so an instance whose database had gone away still reported
ready. An enterprise readiness audit (6 October 2026) found both (OPS-01).

## Decision

- **Readiness first.** `A2AApp.markUnready()` makes `/readyz` answer 503
  while every other route keeps serving. On SIGTERM the bin calls it, waits
  `A2A_SHUTDOWN_DELAY_MS` (default 5 s), then closes the listener and drains.
- **One budget.** The delay counts inside `A2A_SHUTDOWN_GRACE_MS` (default
  25 s): the drain gets what is left. Running tasks keep running through the
  delay, so they still get the whole grace period, and a stop takes no
  longer than before, inside Kubernetes' default 30 s termination period.
- **Storage in readiness.** `/readyz` reads the schema version (the storage's
  existing `schemaVersion()`) with a 2 s limit and answers 503
  `{ status: 'unavailable', reason: 'storage' }` when it fails, logging the
  cause once per change of state and naming no host in the answer. The
  route is unauthenticated, so the answer is cached for 2 s and concurrent
  probes share one read: flooding `/readyz` cannot turn into a query flood.
- **`MELCHIZEDEK_DOTENV=off`** makes `loadEnv` read no `.env` file. The
  end-to-end test starts the real bin from this clone, whose `.env` holds
  live keys and a live database; it must run on a minimal environment.

## Alternatives

- **A delay added on top of the grace period.** Simpler arithmetic, but a
  default stop of 30 s plus flushing meets Kubernetes' SIGKILL at 30 s.
- **No delay; tell operators to add a `preStop` sleep.** That works on
  Kubernetes only, and every deployment has to know to do it.
- **A dedicated storage ping in the storage interface.** `schemaVersion()`
  already reads the database on both storage paths; a new member would grow
  the public interface for the same query.

## Consequences

- A rolling deploy behind a load balancer that probes `/readyz` stops
  routing to an instance before it closes, so no request is refused.
- A probe now costs one small query; a database outage takes instances out
  of rotation instead of letting them fail turns.
