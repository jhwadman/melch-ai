---
type: decision
title: "ADR 0001: Adopt OKF v0.2 plus a thin local profile as the bundle format"
description: "The knowledge vault is an Open Knowledge Format v0.2 bundle with a small local profile, not a bespoke wiki format."
tags:
  - decision
  - okf
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: https://github.com/GoogleCloudPlatform/knowledge-catalog
    title: OKF v0.2 specification
  - resource: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
    title: Karpathy's LLM-wiki pattern
---

# ADR 0001: Adopt OKF v0.2 plus a thin local profile as the bundle format

**Decided (2026-07-26):** The bundle conforms to OKF v0.2 (markdown, YAML frontmatter needing only `type`, standard links as the graph), with a local profile adding a type vocabulary, the trust family, a machine-parseable `log.md` and per-directory indexes, enforced by lint.

**Instead of:** a bespoke wiki format, a heavier document standard, `[[wikilinks]]`

How it works: [How this knowledge bundle works](/meta/wiki-system.md)
