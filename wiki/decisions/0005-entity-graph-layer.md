---
type: decision
title: "ADR 0005: An entity graph inside the bundle: extracted and asserted tiers"
description: "Typed entities and relations live inside the bundle as an extracted tier rebuilt by the build and an asserted tier written through a gate, rather than a parallel graph store."
tags:
  - decision
  - graph
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/wiki/entities.ts
  - resource: lib/wiki/extract.ts
---

# ADR 0005: An entity graph inside the bundle: extracted and asserted tiers

**Decided (2026-08-19):** One graph inside the bundle: relations read literally from repo truth are rebuilt by `wiki:build` every run, and judgment relations are asserted one at a time with evidence through `wiki_relate`; the two tiers never mix.

**Instead of:** a parallel LLM-extracted graph store, LLM inference of literal facts

How it works: [The knowledge graph](/meta/knowledge-graph.md)
