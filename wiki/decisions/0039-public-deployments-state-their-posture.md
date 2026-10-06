---
type: decision
title: 'ADR 0039: A public deployment states its posture; turns and users have default caps'
description: With PUBLIC_URL set the server refuses to start until A2A_AUTH, A2A_SERVED_AGENTS (a list or *) and A2A_TRUST_PROXY are explicit; trust proxy defaults to false; a turn makes at most 50 model calls unless max_steps says otherwise; one end user runs at most 4 tasks at once.
tags:
  - decision
  - security
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-06
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

## Context

An enterprise readiness audit (6 October 2026) found four defaults that
were each the permissive choice, on the surface a stranger can reach:

- **SEC-02.** `A2A_AUTH` defaulted to `secret`, where any holder of the
  shared secret reads or erases any user's data by naming them in
  `X-User-Id`. [ADR 0025](/decisions/0025-built-in-authenticators.md)
  rejected that model and kept it only as a migration bridge.
- **SEC-03.** Without `A2A_SERVED_AGENTS`, any authenticated caller reached
  every YAML in the agents directory and every `registry:<id>` row.
- **SEC-05.** `trust proxy` defaulted to 1. A server reached directly took
  the client's own `X-Forwarded-For` as its address, which defeats the
  per-IP failed-login and task limiters.
- **SEC-08.** `max_steps` had no default and concurrency had no per-user
  cap, so one runaway tool loop or one user could spend without bound.

## Decision

1. **With `PUBLIC_URL` set, three settings are required.** `A2A_AUTH`,
   `A2A_SERVED_AGENTS` and `A2A_TRUST_PROXY` must be set explicitly, or the
   server stops with one message naming each missing setting and its
   choices. `A2A_AUTH=secret` stays available as a stated choice, and
   `A2A_SERVED_AGENTS=*` as a stated "every agent".
2. **`A2A_TRUST_PROXY` defaults to `false`** everywhere it is not required.
3. **A turn stops at 50 model calls** (`DEFAULT_MAX_STEPS`, subagents
   included) unless its YAML sets `max_steps`. The shipped examples that set
   a cap set 12 to 30.
4. **One scope runs at most 4 tasks at once** (`A2A_MAX_CONCURRENT_PER_SCOPE`,
   `maxConcurrentPerScope`; 0 = unlimited). A per-caller cap exists
   (`A2A_MAX_CONCURRENT_PER_CALLER`) but is off by default. A refusal names
   the cap that was hit.

## Alternatives

- **Make `callers` the default auth on a public URL.** It needs
  `A2A_CALLERS`, which the server cannot invent, so the default could only
  ever fail; requiring a choice says the same thing with a better message.
- **Change each default silently** (auth to callers, served agents to none,
  trust proxy to false). Every existing public deployment would break with
  errors far from their cause; a single refusal at boot that names each
  setting is one restart's work.
- **A per-caller concurrency default.** A backend that proxies many users
  under one caller token is one caller; a low default would throttle it.
  The per-scope cap bounds one end user without touching it.
- **Budget in currency.** Budgets stay token-based (ADR 0026); a price table
  per model is its own change.

## Consequences

- An existing public deployment stops at its next restart until it sets the
  three variables; the boot message names them, and the 0.18.0 CHANGELOG
  leads with it.
- A syndicate that legitimately needs more than 50 model calls in a turn
  sets `max_steps`.
- Local and loopback servers keep working with no new settings.
