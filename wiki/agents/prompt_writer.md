---
type: syndicate
title: Prompt Writer
description: The Prompt Writer syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-24
sources:
  - resource: config/agents/templates/prompt_writer.yaml
---

# Prompt Writer

<!-- wiki:fill slot="charter" -->
Prompt Writer is the template that writes production prompts. A person describes an agent or a syndicate, or pastes a prompt that failed with the output it gave, and the reply is every agent's system prompt in the block anatomy the Lyceum course teaches, with the syndicate YAML when they ask for it. Its own prompts were written by `gemini-4-argon` from the course's lessons, and every agent runs on that model.

The Editor runs the work and writes nothing itself. The Architect turns the request into a design sheet: the mode (a new design, a repair or an iteration), a diagnosis by variable for a repair, the topology and why a simpler one fails, each agent's one job and capabilities, the trust boundary (injection surfaces, reads against writes, `require_approval` on every write tool, the checks code must make) and the missing facts. The Writer writes every prompt from the sheet. The Auditor checks the package against `prompt_checklist`, ten rules taken from the course, and any YAML against `yaml_shape`, a skeleton that loads. Its reply begins APPROVED or REVISE, every Auditor call opens with "Round n of N", and the cap is `max_rounds` (2 as shipped) in the Editor's prompt and `max_steps: 16` in code. A missing fact becomes one `[NEEDS: …]` placeholder; in YAML each is its own variable.

The skeleton writes a variable as `[[name]]` and tells the Writer to restore the braces, because a word in curly braces inside an instruction is read as a session-state key at run time, and a missing key fails the call. The same rule is passed on to every prompt it writes. Memory is `session-only`, so a design can be refined across turns. To make it yours, add your house rules to `prompt_checklist`, which the Writer and the Auditor share. [Draft Review](/agents/draft_review.md) is the same bounded loop over one piece of prose, with no design stage.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/prompt_writer.yaml" -->
- memory: `session-only` · max_steps: 16
- orchestrator: **Editor** (`gemini-4-argon`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Architect | `gemini-4-argon` | — | — |
| Writer | `gemini-4-argon` | — | — |
| Auditor | `gemini-4-argon` | — | — |
<!-- /wiki:generated -->
