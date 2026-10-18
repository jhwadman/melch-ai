---
type: decision
title: "ADR 0134: MELCHIZEDEK_DATA_DIR roots the engine's on-disk defaults"
description: "MELCHIZEDEK_DATA_DIR roots the engine's on-disk defaults while each location keeps its own variable, and the engine's version is read from its own package."
tags:
  - decision
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/paths.ts
  - resource: lib/tools/inspectImageTool.ts
  - resource: lib/observability/lineage.ts
  - resource: tests/paths.test.ts
---

# ADR 0134: MELCHIZEDEK_DATA_DIR roots the engine's on-disk defaults

**Decided (2026-10-15):** One variable, `MELCHIZEDEK_DATA_DIR`, roots the defaults for outputs, the task file and the ChatGPT sign-in, while each location's own variable still wins and the historical defaults hold without it. The engine's version and commit are read from the engine's own package, not the working directory.

**Instead of:** a programmatic `setPaths()`, moving the task file with `OUTPUTS_DIR`, new defaults (an XDG data directory)

How it works: [Setup](/operations/setup.md)
