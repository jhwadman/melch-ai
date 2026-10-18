---
type: decision
title: "ADR 0003: Path-based visibility enforced by a link-closure lint"
description: "Visibility is a subtree property (/private/), enforced by lint rules rather than per-document flags."
tags:
  - decision
  - visibility
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/wiki/lint.ts
  - resource: scripts/wiki/build.ts
---

# ADR 0003: Path-based visibility enforced by a link-closure lint

**Decided (2026-07-26):** Public versus private is the path: `/private/` is the annex a published copy leaves out, and lint errors on any public link into it and on public mentions of private names.

**Instead of:** per-document `visibility:` frontmatter flags, per-file export allowlist edits
**Superseded by:** [ADR 0022](/decisions/0022-public-source-of-truth.md) (the public repository has no `/private/` subtree or export scan; the closure rule still runs)

How it works: [How this knowledge bundle works](/meta/wiki-system.md)
