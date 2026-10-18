---
type: decision
title: "ADR 0072: Tool credentials sealed per app, user and provider"
description: "Third-party OAuth tokens are sealed in-process per app, end user and provider, reached only through the tool context for the run's own user, and erased with the user."
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: db/migrations/0013_tool_credentials.sql
  - resource: lib/tools/auth.ts
  - resource: lib/tools/credentialStore.ts
  - resource: lib/tools/credentialCipher.ts
  - resource: lib/storage/postgres/credentialStore.ts
  - resource: lib/tools/tool.ts
  - resource: tests/toolCredentials.test.ts
  - resource: tests/postgresStorage.test.ts
---

# ADR 0072: Tool credentials sealed per app, user and provider

**Decided (2026-10-08):** Per-user third-party tokens live in one table, one row per app (the pinned memory namespace), user and provider, sealed in the process through a `CredentialCipher` plug point (AES-256-GCM by default, the row identity as authenticated data). A tool reaches a token only via `ctx.accessToken(provider)` for its own run's user, and the user erase removes the tokens.

**Instead of:** database-side encryption (pgcrypto, Vault), plaintext rows behind RLS, a per-user derived key, keying by syndicate or ADK app name, tokens shared across syndicates, a supabase-js twin, a row lock during refresh, a ToolContext member that names a user

**Open:** credential key rotation (no re-encryption job, no second key)

How it works: [Tool contracts](/tools/tool-contracts.md)
