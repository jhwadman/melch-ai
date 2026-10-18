---
type: decision
title: "ADR 0083: The skills harness is the engine's own, held to ADK's words"
description: "The skills harness moved off ADK's SkillToolset to the engine's own parser, loader, executor and four own Tools in a Toolset, keeping every text a model reads."
tags:
  - decision
  - tools
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/skills/frontmatter.ts
  - resource: lib/tools/skills/loader.ts
  - resource: lib/tools/skills/executor.ts
  - resource: lib/tools/skills/tools.ts
  - resource: lib/tools/skillToolset.ts
  - resource: lib/tools/tool.ts
  - resource: lib/tools/adkTool.ts
  - resource: lib/runtime/native/request.ts
  - resource: lib/compileNative.ts
  - resource: lib/skills.ts
  - resource: tests/skillHarness.test.ts
  - resource: tests/skillHarnessParity.test.ts
---

# ADR 0083: The skills harness is the engine's own, held to ADK's words

**Decided (2026-10-08):** `lib/tools/skills/` holds the engine's own frontmatter parser (on the `yaml` package, bounded), loader, local executor and `list_skills`, `load_skill`, `load_skill_resource`, `run_skill_script` as own Tools in an own `Toolset`, with the names, schemas, results and errors ADK's harness gave. A Tool gained a `contents` hook so a binary resource reaches the request; the loader added size, count and depth bounds.

**Instead of:** js-yaml, a zod mirror of ADK's frontmatter schema, splitting on a `---` line, defineTool contracts, a fixed tool list gated at call time, dropping the binary injection

**Superseded by:** [ADR 0086](/decisions/0086-skill-scripts-get-a-minimal-environment.md) (script environment and output cap), [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the ADK toolset wrapper removed)

**Open:** frontmatter ends at the next `---`, not a `---` line

How it works: [Skill harness](/tools/skill-harness.md)
