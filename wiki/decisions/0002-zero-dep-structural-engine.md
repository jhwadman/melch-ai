---
type: decision
title: "ADR 0002: Zero-dependency structural markdown engine with marker splices"
description: "Documents are parsed and built by a purpose-built structural engine that edits by marker splices and never reserializes prose."
tags:
  - decision
  - markdown
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/wiki/markdown.ts
---

# ADR 0002: Zero-dependency structural markdown engine with marker splices

**Decided (2026-07-26):** `lib/wiki/markdown.ts` is a small structural parser and builder with no new dependency; machine-owned regions are spliced by marker line-range and prose outside markers is never reserialized.

**Instead of:** remark/unified, parse-mutate-reserialize of whole documents

How it works: [How this knowledge bundle works](/meta/wiki-system.md)
