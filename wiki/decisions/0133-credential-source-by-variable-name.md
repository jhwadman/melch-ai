---
type: decision
title: "ADR 0133: Embedders supply credentials through one source, by variable name"
description: "setCredentialSource sets a process-wide source the engine asks for a credential by its environment variable name at each use, before process.env."
tags:
  - decision
  - models
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/credentialSource.ts
  - resource: lib/models/providerMap.ts
  - resource: lib/index.ts
  - resource: tests/credentialSource.test.ts
---

# ADR 0133: Embedders supply credentials through one source, by variable name

**Decided (2026-10-15):** An embedding application sets one process-wide credential source (`setCredentialSource`), asked by environment variable name at each use, uncached, before `process.env`, and every key read in the engine goes through it.

**Instead of:** copying keys into `process.env`, a provider-keyed source, threading keys through every call

How it works: [Provider routing](/models/provider-routing.md)
