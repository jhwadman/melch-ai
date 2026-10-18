---
type: decision
title: "ADR 0007: The engine ships as the melchizedek-agents npm package"
description: "lib/ is published as the melchizedek-agents package with an exports map as its semver boundary, rather than restructuring into a workspace monorepo."
tags:
  - decision
  - packaging
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: package.json
  - resource: tsconfig.build.json
  - resource: lib/loadSyndicate.ts
---

# ADR 0007: The engine ships as the melchizedek-agents npm package

**Decided (2026-08-19):** The engine is published as `melchizedek-agents`; it is location-independent, compiled only for the package, proven by a pack-and-consume check, and its exports map is the semver boundary.

**Instead of:** npm workspaces monorepo with `packages/engine`, consumers importing `lib/` by relative path
**Superseded by:** [ADR 0022](/decisions/0022-public-source-of-truth.md) (publishing from the export mirror: this repository is now the source and publishes)

How it works: [Setup paths](/operations/setup.md)
