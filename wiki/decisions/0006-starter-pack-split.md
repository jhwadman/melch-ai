---
type: decision
title: "ADR 0006: Starter pack split from live syndicates, with loader fallback"
description: "config/agents/ root holds the deployment's live syndicates and examples/ holds the shipped starter pack, with the loader falling back from root to examples/."
tags:
  - decision
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/loadSyndicate.ts
  - resource: config/agents/README.md
---

# ADR 0006: Starter pack split from live syndicates, with loader fallback

**Decided (2026-08-19):** The root of `config/agents/` is the deployment's own syndicates and schema; shipped teaching syndicates live in `examples/`, and the loader resolves a bare name at the root first, then the shipped directories, inside the same jail.

**Instead of:** one flat directory, extracting the engine into a package (deferred, then done in ADR 0007)
**Superseded by:** [ADR 0018](/decisions/0018-files-are-the-source-of-truth.md) (on the A2A server the shipped directories answer only listed ids)

How it works: [Architecture](/overview/architecture.md)
