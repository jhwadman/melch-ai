---
type: syndicate
title: Harness
description: The Harness syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-03
sources:
  - resource: config/agents/examples/harness.yaml
---

# Harness

<!-- wiki:fill slot="charter" -->
The Harness is a generic agent that works from a directory of Agent Skills the way a coding harness does ([skill harness](/tools/skill-harness.md), [ADR 0029](/decisions/0029-skills-read-like-a-harness.md)). Every installed skill's name and description is in its instruction, so it chooses without a listing call; a message beginning with a slash and a skill's name (`/release-notes 2.1`) forces that skill. Its mandate is six steps: choose the skills whose description matches (at most three), read each with `load_skill` before acting on it, follow the procedure as written and open a file it ships with `load_skill_resource` only when the procedure reaches it, run a script with `run_skill_script` where `skills.scripts: local` allows it (each run waits for the user's approval; a refusal is reported and worked around), send a deliverable to the Checker, a tool-free leaf, with the rules quoted from the skill and fix what it reports once, and end with a `Followed:` line naming the skills used. When no description matches it says so and answers from general knowledge, marked as such; when a procedure asks for something it cannot do here, it hands the user the exact command or file. `variables.skills_dir` defaults to this repository's own [suite](/operations/agent-skills.md), so `npm run syndicate:harness` answers how to run, author, serve and remember with the framework; `-- --bind skills_dir=.claude/skills` points it at a project's shelf, and a copy of the file in a project sets `dir` and `scripts` directly. Skills are trusted procedure and still only text: they unlock no tool the YAML did not list under `skills.tools`, and no script runs without a person's yes.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/harness.yaml" -->
Run: `npm run syndicate:harness`

- memory: `internal-only`
- orchestrator: **Harness** (`gemini-3.8-flash`) · skills: `{{skills_dir}}`

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Checker | `gemini-3.5-flash-lite` | — | — |
<!-- /wiki:generated -->
