---
type: decision
title: "ADR 0038: A graceful stop fails readiness first, inside the grace budget"
description: "On SIGTERM the server fails /readyz and keeps serving for a delay counted inside the shutdown grace budget before it closes and drains; /readyz also fails while storage does not answer."
tags:
  - decision
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: scripts/a2a_server.ts
  - resource: lib/a2a/app.ts
  - resource: lib/loadEnv.ts
  - resource: tests/serverShutdown.test.ts
  - resource: tests/readiness.test.ts
---

# ADR 0038: A graceful stop fails readiness first, inside the grace budget

**Decided (2026-10-06):** On SIGTERM the server fails `/readyz` first and keeps serving for a delay that counts inside the shutdown grace budget, then closes its listener and drains. `/readyz` also fails while durable storage does not answer.

**Instead of:** a delay added on top of the grace period, a `preStop` sleep left to operators, a dedicated storage ping in the storage interface

How it works: [Setup](/operations/setup.md)
