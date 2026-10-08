---
type: decision
title: "ADR 0072: Tool credentials are sealed per app, user and provider, reached through the tool context, and erased with the user"
description: "Third-party OAuth tokens for tools live in melchizedek_tool_credentials (migration 0013), one row per app, end user and provider, sealed by a CredentialCipher plug point (AES-256-GCM under MELCHIZEDEK_CREDENTIAL_KEY by default) with the row's identity as authenticated data. One store over pluggable row backends refreshes an expired token through the provider's hook, writes over the version it read, fails closed on a wrong key and audits every step without a value. A tool reaches a token through ToolContext.accessToken(provider), bound to the run's own app and user. melchizedek_erase_scope removes the tokens. Database-side encryption, plaintext rows behind RLS, a per-user key, a per-syndicate app key, a Supabase-js twin and a row lock during refresh were rejected."
tags:
  - decision
  - tools
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
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

# ADR 0072: Tool credentials are sealed per app, user and provider, reached through the tool context, and erased with the user

## Context

A long-running agent that acts for a person (reads their calendar, opens a pull request in their repository) needs that person's delegated access to the third-party API, not the server's own key. OpenAPI and MCP tools authenticate with a server-wide secret named in the YAML ([ADR 0041](/decisions/0041-tool-vendors-get-least-privilege.md)), which is one identity for every user. The engine had no place to hold a token per end user.

Such a token is a bearer credential to someone else's account. Held badly it is the worst thing the database can leak, worse than the conversations: a dump, a backup or a read replica would hand over every connected account. It must also leave with the user's other data ([ADR 0020](/decisions/0020-memory-contract.md) item 7), and every use must be accountable ([ADR 0042](/decisions/0042-append-only-audit-trail.md)) without the audit trail becoming a second copy of the tokens.

This decision covers the store. The consent step and callback route (WS6-3b) and the YAML that lets an agent use a provider (WS6-3c) come later, and no tool uses the store yet.

## Decision

1. **One table, one row per app, end user and provider:** `melchizedek_tool_credentials` (`db/migrations/0013_tool_credentials.sql`). It holds the granted scopes, the sealed access and refresh tokens, the id of the key that sealed them, the expiry, timestamps and a version. A CHECK refuses any token column that is not in the engine's envelope, so a plaintext token cannot be written by mistake. RLS is on and the API roles have no grant, as `db/hardening.sql` repeats; the server's role reads and writes.
2. **The app is the one the run pins:** the root syndicate's memory namespace, as memory pins it. `pinnedCredentialStore(store, appName)` replaces the app of every key, as `namespacedMemoryService` does, so a delegated subagent that ADK runs under its own app name reads the root's tokens. Two syndicates share a user's tokens only by sharing a namespace.
3. **Sealing is a plug point.** `CredentialCipher` (`keyId`, `encrypt`, `decrypt`, all async so a KMS can implement it). The built-in `aesGcmCipher` is AES-256-GCM with a fresh 96-bit IV per value and a 32-byte key from `MELCHIZEDEK_CREDENTIAL_KEY` (`credentialCipherFromEnv`: base64 or hex; unset means no store; malformed throws at boot). The envelope is `mzc1.<key id>.<iv>.<tag>.<ciphertext>`:
   - the key id (a labelled SHA-256 prefix of the key) lets a wrong key be refused by name, before decryption;
   - the row's app, user, provider and field are GCM's authenticated data, so a ciphertext copied onto another user's row, or from the refresh field to the access field, does not open.
4. **One store over pluggable row backends** (`lib/tools/credentialStore.ts`): `put`, `get` with refresh, `revoke` and `eraseUser`. A backend (`CredentialRows`) keeps ciphertext rows only: `memoryCredentialRows()` in process, `postgresCredentialRows(pool)` on Postgres, and `postgresStorage({ credentials: { cipher, providers } })` builds `storage.credentials` with the storage's audit sink.
   - **Refresh.** A token within 60 seconds of its expiry is refreshed through the provider's `refresh(refreshToken, { scopes })` hook before it is returned. One refresh runs at a time per key in a process. The result is written only over the version that was read; when another instance wrote first, its token is read back and used. A provider that does not rotate its refresh token keeps the stored one.
   - **Fail closed.** A row sealed with another key, altered, or moved is `unreadable`: it is never refreshed, overwritten or returned. An expired token with no refresh token or no refresh hook is `expired`. A refused refresh is `refresh_failed` and writes nothing.
   - **Revoke** deletes the row, then calls the provider's `revoke` hook as best effort.
   - **No value leaves.** A token reaches no log line, span, error message or audit row. A provider's own error is reported by kind, never by its message, since a provider may echo the token it refused. Every error is a `ToolCredentialError` whose message names the provider and what to do.
   - **Audit.** `credential.put`, `credential.refresh`, `credential.revoke` and `credential.erase` rows carry the provider, the app, a scope hash of the user and counts, never a token or the user id. A `credential.refresh` span carries the provider and the outcome.
5. **A tool reaches a token through its context, for the run's own user only.** `ToolContext.accessToken(provider)` (`lib/tools/auth.ts`, bound in `createToolContext` from the run's `credentials`) returns a valid access token from the context's own app and user. A tool chooses the provider, never whose token, as `searchMemory` chooses the query and never the silo ([ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md)). The member is present only when the run has a store, and refuses a context that does not know its app and user. `lib/tools/auth.ts` loads nothing at runtime, so `tool.ts` stays a leaf.
6. **One erase covers the tokens.** Migration 0013 replaces `melchizedek_erase_scope` with 0011's function plus a `credentials` store: an erase without a namespace removes every app's tokens of the scope (and of nested scopes with `includeNested`), and a namespace erase removes that namespace's own. `DELETE /memory` therefore removes them and reports the count.

## Alternatives considered

- **Encrypt in the database** (pgcrypto, or Supabase Vault). Rejected. The key would live in, or pass through, the database, so a dump plus a SQL session could open every token, and statement logs could record the key. Sealing in the process keeps the key out of the database and its backups.
- **Plaintext rows protected by RLS and grants only.** Rejected. A backup, a replica or an operator's query sees the tokens, and the service role bypasses RLS.
- **A key per user, derived from a master key.** Rejected for now. With one master key it adds no protection against whoever holds the master key, and the AAD binding already stops a row being replayed onto another user. A KMS implementation of the plug point can add envelope keys per row.
- **Key the app by the syndicate name or the ADK app name.** Rejected. A rename would orphan the tokens, a subagent runs under its own app name, and a namespace erase could not find them. The memory namespace is stored, never recomputed, and already defines a syndicate's data boundary.
- **Tokens shared by every syndicate of a user (no app column).** Rejected. A user who connects an account for one syndicate would grant it to every syndicate on the deployment. Least privilege is per app, and sharing stays a deliberate shared namespace.
- **A supabase-js twin of the store, as sessions and memory have.** Rejected. Supabase-js storage is deprecated ([ADR 0021](/decisions/0021-postgres-first-storage.md) item 6) and would put the table on the REST path that `db/hardening.sql` exists to close; a Supabase deployment uses its connection string with `postgresStorage`.
- **Hold a row lock (`SELECT … FOR UPDATE`) during refresh.** Rejected. It holds a database connection open across a provider's HTTP call. A version check costs one extra read in the rare race and never blocks.
- **A ToolContext member that takes a user or returns the whole store.** Rejected for the reason ADR 0059 rejected the whole memory service: a model-chosen argument could then name another user's token.

## Consequences

- The migration must be applied to the live database before any release that uses the store (`npm run --silent db -- print` into the Supabase SQL editor, or `npm run db -- apply`). Until a deployment passes `credentials` to `postgresStorage`, the table stays empty and nothing reads it.
- Changing `MELCHIZEDEK_CREDENTIAL_KEY` makes every stored token unreadable: each user connects again. There is no re-encryption job and no second, older key yet.
- `EraseCounts` gains `credentials`, and the audit event names gain the four `credential.*` events. A consumer that builds an `EraseCounts` itself (a custom `storage.erase`) adds the field.
- The ADK runtime's tool context has no `accessToken` yet; WS6-3c wires the store into runs on both runtimes together with the YAML that names a provider.
- Consumers see additions under the existing `exports` map: `tools/auth`, `tools/credentialStore` and `tools/credentialCipher` through `./tools/*`, and `postgresCredentialRows`, `postgresCredentialStore`, the `credentials` option and `storage.credentials` from `storage/postgres`.
