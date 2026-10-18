---
type: decision
title: "ADR 0022: This repository is the public source of truth"
description: "The engine is developed in the open in this fresh-history repository; private deployments consume the published package, evals have their own repository, and the export mirror is retired."
tags:
  - decision
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: README.md
  - resource: package.json
---

# ADR 0022: This repository is the public source of truth

**Decided (2026-10-01):** A fresh-history public repository, assembled by allowlist, is where the engine, tests, wiki and npm publishing live; private syndicates, tools and deployments depend on the package through its plug points, and evals live in their own repository.

**Instead of:** keeping the mirror as "issues only", a monorepo with private packages
**Supersedes:** [ADR 0007](/decisions/0007-engine-as-package.md) (where the package is published from); [ADR 0003](/decisions/0003-path-based-visibility.md) (the private wiki subtree)
