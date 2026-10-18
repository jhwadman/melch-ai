---
type: decision
title: "ADR 0018: Agent files are the source of truth; the registry is opt-in"
description: "A bare agent id resolves to a YAML file; the registry is used only for an explicit registry:<id> or a listed id, is append-only and versioned, and validates at publish."
tags:
  - decision
  - agents
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/loadSyndicate.ts
  - resource: lib/a2a/app.ts
  - resource: scripts/a2a_server.ts
---

# ADR 0018: Agent files are the source of truth; the registry is opt-in

**Decided (2026-10-01):** A bare id resolves to a file in the deployment's agents directory; the registry answers only `registry:<id>` or ids in `A2A_REGISTRY_AGENTS`, with no silent fallback, append-only versions, validation at publish and load, and syndicates versioned as a unit.

**Instead of:** the registry as single source of truth, both with implicit precedence

How it works: [A2A](/protocols/a2a.md)
