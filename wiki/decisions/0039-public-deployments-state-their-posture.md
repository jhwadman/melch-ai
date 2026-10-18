---
type: decision
title: "ADR 0039: A public deployment states its posture; turns and users have default caps"
description: "With PUBLIC_URL set the server refuses to start until A2A_AUTH, A2A_SERVED_AGENTS and A2A_TRUST_PROXY are explicit; trust proxy defaults off, a turn stops at 50 model calls, one end user runs at most 4 tasks at once."
tags:
  - decision
  - security
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: scripts/a2a_server.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/a2a/app.ts
  - resource: lib/config.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: tests/publicPosture.test.ts
  - resource: tests/taskLimiter.test.ts
---

# ADR 0039: A public deployment states its posture; turns and users have default caps

**Decided (2026-10-06):** With `PUBLIC_URL` set, the server refuses to start until `A2A_AUTH`, `A2A_SERVED_AGENTS` and `A2A_TRUST_PROXY` are set explicitly. Trust proxy defaults to off everywhere else, a turn stops at 50 model calls unless `max_steps` says otherwise, and one end-user scope runs at most 4 tasks at once.

**Instead of:** `callers` as the default auth on a public URL, changing each default silently, a per-caller concurrency default, budgets in currency
**Supersedes:** [ADR 0025](/decisions/0025-built-in-authenticators.md) (the shared secret as the implicit default on a public URL)

How it works: [Setup](/operations/setup.md)
