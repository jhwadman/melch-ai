---
type: decision
title: 'ADR 0037: The hardening check runs on every storage path, judged by what could expose the tables'
description: The boot-time RLS check moves out of the supabase-js path into lib/storage/rlsStatus.ts and runs for DATABASE_URL too; on a direct connection it passes when no anon/authenticated role exists or the tables live outside public, and otherwise applies the same rules.
tags:
  - decision
  - operations
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-06
sources:
  - resource: lib/storage/rlsStatus.ts
  - resource: lib/storage/postgres/index.ts
  - resource: lib/a2a/app.ts
  - resource: tests/rlsStatus.test.ts
---

# ADR 0037: The hardening check runs on every storage path, judged by what could expose the tables

## Context

`db/hardening.sql` closes the Supabase REST API's anon and authenticated
paths to the transcripts, memory facts and agent registry. The server
checked it at boot and refused a public deployment without it, but only
inside the supabase-js branch of `createA2AApp`.
[ADR 0021](/decisions/0021-postgres-first-storage.md) made `DATABASE_URL`
the recommended path and deprecated supabase-js, so the deployments that
followed the documentation were never checked. An enterprise readiness
audit (6 October 2026) found it.

`DATABASE_URL` reaches more kinds of database than supabase-js does: a
Supabase project, a managed Postgres with no REST layer, a local container,
and any of them with the tables in a private schema
(`MELCHIZEDEK_DB_SCHEMA`). `melchizedek_rls_status()` looks only in
`public`.

## Decision

The rules live once, in `lib/storage/rlsStatus.ts` (`evaluateRlsRows`), and
both paths use them. `postgresStorage` supplies `rlsHardening()`, which
reads the roles, the current schema and the RLS flags in one query, and the
server treats its answer exactly as the supabase-js answer: fatal with
`requireHardenedDb` (a `PUBLIC_URL` without `ALLOW_UNHARDENED_DB=true`), a
warning otherwise.

On a direct connection the check passes on its own in two cases: the
database has no `anon` or `authenticated` role (nothing serves the tables
over HTTP), or the tables live in a schema other than `public` (the
Supabase API does not expose it unless an operator adds it).

## Alternatives

- **Require RLS whenever `PUBLIC_URL` is set.** Plain Postgres has no API
  roles, and `hardening.sql` revokes from roles that would not exist there;
  every such deployment would stop starting for a risk it does not have.
- **Call `melchizedek_rls_status()` over the pool.** It reads only `public`,
  so a private-schema deployment would be refused as unhardened.

## Consequences

- A Supabase deployment on `DATABASE_URL` that never ran `hardening.sql`
  stops at boot once it upgrades; `melchizedek-db apply` runs the file, and
  `ALLOW_UNHARDENED_DB=true` remains the explicit opt-out.
- Custom storage passed to `createA2AApp` can supply `rlsHardening` and get
  the same gate.
