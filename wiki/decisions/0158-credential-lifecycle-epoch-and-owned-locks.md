---
type: decision
title: "ADR 0158: A credential lifecycle epoch and owned locks make sign-out win"
description: "The ChatGPT credential file carries a lifecycle epoch that every commit compares under a short lock, refresh keeps its single flight on a separate lease, and a lock can be released only by its owner."
tags:
  - decision
  - models
  - openai
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-11-08
sources:
  - resource: lib/chatgpt/oauth.ts
  - resource: lib/chatgpt/store.ts
  - resource: lib/chatgpt/state.ts
  - resource: tests/chatgptSignIn.test.ts
---

# ADR 0158: A credential lifecycle epoch and owned locks make sign-out win

**Decided (2026-11-08):** The credential file carries a persisted lifecycle epoch. A sign-in or refresh commits only if the epoch it started under still stands, checked under a short lock that is never held across the browser or the network, and a sign-out advances the epoch and clears the tokens before it revokes. Refresh keeps its cross-process single flight on a separate lease. A lock file names its owner and is released only by that owner. A refresh takes no cancel signal, because dropping an answer after the issuer has rotated the token would end the session.

**Instead of:** one lock held across the network (a sign-out would wait on it); no lease for refresh (rotating tokens would be reused across processes); a timestamp or in-process generation (neither survives a process boundary or a clock change); advancing the epoch on refresh (a person's sign-in would lose to a routine rotation); revoking every lost token (an issuer may revoke per client and account, which would end the session that won); a state-machine library or an OS file-lock dependency.

**Open:** a credential file deleted by hand restarts its epoch at zero, so work older than the deletion could match a later epoch of the same number. An engine older than this one refreshing the same file at the same moment does not honor the lease.

How it works: [Sign in with ChatGPT](/models/chatgpt-signin.md)
