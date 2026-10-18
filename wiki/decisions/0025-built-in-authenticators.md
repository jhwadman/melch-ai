---
type: decision
title: "ADR 0025: Built-in authenticators; a caller's scope never derives from a model key"
description: "The A2A server ships four authenticators (shared secret, caller tokens, JWT, gateway header); under all but the shared secret a scope is independent of any model key, and billing stays a separate setting."
tags:
  - decision
  - protocols
  - memory
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/a2a/identity.ts
  - resource: lib/a2a/app.ts
  - resource: scripts/a2a_server.ts
  - resource: tests/identity.test.ts
---

# ADR 0025: Built-in authenticators; a caller's scope never derives from a model key

**Decided (2026-10-01):** The A2A server ships four authenticators on the `resolveRequest` plug point: shared secret, per-caller tokens, JWT and a trusted gateway header. Under the last three a caller's data scope never derives from a model credential, so rotating a provider key changes only who pays. An existing key-hash silo is kept by mapping callers onto its scope, not by moving data, and billing (`A2A_KEY_MODE`) is decided apart from identity.

**Instead of:** one `MEMORY_SILO_ID` replacing the key hash, scope on `X-User-Id` alone, a key-alias table, re-keying production data, a hand-written JWT verifier
**Superseded by:** [ADR 0039](/decisions/0039-public-deployments-state-their-posture.md) (the shared secret is no longer an implicit default on a public URL)

How it works: [A2A](/protocols/a2a.md)
