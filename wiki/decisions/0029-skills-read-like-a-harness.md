---
type: decision
title: "ADR 0029: An agent holds Agent Skills the way a coding harness does"
description: "A skills: block puts every skill's frontmatter in the instruction, lets the agent read one skill on demand, unlocks only the tools the YAML permits, and runs a skill's own scripts only after approval."
tags:
  - decision
  - tools
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/tools/skillToolset.ts
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: config/agents/examples/harness.yaml
  - resource: tests/skillHarness.test.ts
---

# ADR 0029: An agent holds Agent Skills the way a coding harness does

**Decided (2026-10-02):** An agent's `skills:` block holds a directory of SKILL.md skills by progressive disclosure. The skills' index is appended to the instruction at compile time, one skill is read on demand (file names, not contents), and a skill's `allowed-tools` unlocks only tools the YAML permits under `skills.tools`. A skill's own scripts run only after a person approves each call, and the model's own code is never run.

**Instead of:** two hand-written registry tools (`skill_list`, `skill_read`), ADK's SkillToolset as it ships
**Superseded by:** [ADR 0083](/decisions/0083-skills-harness-on-the-own-tool-base.md) (the engine's own parser, loader, executor and tools replace ADK's toolset), [ADR 0106](/decisions/0106-nested-workflow-routes-nodes-and-node-skill-scripts.md) and [ADR 0118](/decisions/0118-skill-scripts-and-oauth-consent-inside-delegated-subagents.md) (script approvals on workflow nodes and in delegated subagents)

How it works: [Skill harness](/tools/skill-harness.md)
