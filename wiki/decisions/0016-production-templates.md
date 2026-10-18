---
type: decision
title: "ADR 0016: Production templates live in templates/, beside the starter pack"
description: "Job-shaped production syndicates go in config/agents/templates/ under their own contract, rather than rewriting the starter-pack examples the course teaches."
tags:
  - decision
  - starter-pack
  - templates
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: config/agents/templates/README.md
  - resource: lib/loadSyndicate.ts
  - resource: tests/agents.test.ts
---

# ADR 0016: Production templates live in templates/, beside the starter pack

**Decided (2026-09-27):** Ten job-shaped templates live in `config/agents/templates/`, held to a header, memory and loadability contract enforced by `tests/agents.test.ts`; the loader reaches them after the root and `examples/`.

**Instead of:** upgrading the starter-pack examples in place

How it works: [Architecture](/overview/architecture.md)
