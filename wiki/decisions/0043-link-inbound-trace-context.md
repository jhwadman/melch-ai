---
type: decision
title: "ADR 0043: A caller's trace context is linked, never adopted"
description: A request's W3C traceparent becomes a span link and a caller.trace_id attribute on the turn's root span; the turn keeps a fresh trace id, because ledger attribution, in-process turn state and erasure key on it.
tags:
  - decision
  - observability
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-06
sources:
  - resource: lib/observability/tracer.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/traceCorrelation.test.ts
---

# ADR 0043: A caller's trace context is linked, never adopted

## Context

An enterprise readiness audit (6 October 2026) found that a request could
not be followed across systems (OPS-04): task records carried no task or
trace id, and an inbound W3C `traceparent` was ignored, so a turn never
appeared in the trace of whatever called it.

The obvious fix, starting the turn's root span as a child of the caller's
span, makes the caller choose the turn's trace id. Here the trace id is
not only a tracing key. `turnContexts` (the ledger's session and user
attribution) and the per-trace stats are keyed on it in process, and
`melchizedek_erase_scope` deletes spans, payloads and verdicts by it. A
caller who reused another user's trace id could have the two turns'
ledger rows mixed, or erase the other user's spans.

## Decision

The turn's root span keeps a fresh trace id and carries a **span link** to
the caller's span, with a `caller.trace_id` attribute. The task record
names both `traceId` (the turn's) and `callerTraceId`. A malformed or
all-zero `traceparent` is ignored. This is the OpenTelemetry guidance for
context arriving at a public endpoint: links instead of parenthood when
the sender is not trusted.

## Alternatives

- **Adopt the caller's trace (parent/child).** One trace in the backend,
  but a caller then chooses the id that attribution and erasure key on.
- **Adopt it only for trusted callers (operators).** Possible later; an
  operator's backend is trusted with data but can still be misconfigured to
  reuse a trace id across users, and the mixing would be silent.

## Consequences

- A tracing backend shows the turn as its own trace, linked from the
  caller's span; most backends navigate links.
- One id still joins everything on this side: the record's `traceId` is
  the spans', the ledger row's and the audit row's.
