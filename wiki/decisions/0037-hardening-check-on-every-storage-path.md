---
type: decision
title: "ADR 0037: The hardening check runs on every storage path"
description: "The boot-time RLS hardening check runs for DATABASE_URL as well as supabase-js, judged by what could expose the tables."
tags:
  - decision
  - operations
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/storage/rlsStatus.ts
  - resource: lib/storage/postgres/index.ts
  - resource: lib/a2a/app.ts
  - resource: tests/rlsStatus.test.ts
---

# ADR 0037: The hardening check runs on every storage path

**Decided (2026-10-06):** The boot-time hardening (RLS) check runs on both storage paths, `DATABASE_URL` included, with one set of rules. A direct connection passes when no `anon` or `authenticated` role exists or when the tables live outside `public`.

**Instead of:** requiring RLS whenever `PUBLIC_URL` is set, calling `melchizedek_rls_status()` over the pool

How it works: [Setup](/operations/setup.md)
