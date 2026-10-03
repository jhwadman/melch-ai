---
type: tool
title: Skill harness
description: "The `skills:` agent key: a directory of Agent Skills held the way a coding harness holds them — the frontmatter index injected into the instruction, one SKILL.md and one file read on demand, `allowed-tools` honoured under the YAML's permit, and a skill's scripts run only after a person approves each run."
tags:
  - tools
  - skills
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-02
sources:
  - resource: lib/tools/skillToolset.ts
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: config/agents/examples/harness.yaml
  - resource: tests/skillHarness.test.ts
---

# Skill harness

An agent whose YAML carries a `skills:` block holds a directory of Agent Skills (the open SKILL.md standard: one subdirectory per skill, named as its frontmatter names it, holding `SKILL.md` and optionally `references/`, `assets/` and `scripts/`) the way Claude Code, Codex or Gemini CLI hold theirs. The engine builds it on ADK's `SkillToolset` and supplies what the port leaves out ([ADR 0029](/decisions/0029-skills-read-like-a-harness.md)).

```yaml
orchestrator:
  skills:
    dir: ".claude/skills"      # relative to the working directory; {{variables}} allowed
    scripts: "none"            # or "local": run a skill's scripts/ here, each after approval
    tools: ["web_extract"]     # registry tools a skill's allowed-tools may unlock once loaded
```

## What the agent gets

| Where | What |
|---|---|
| its instruction | `<available_skills>` — every skill's name and description, appended at compile time, so no turn is spent discovering skills; plus one statement of the tools below |
| `load_skill(name)` | one SKILL.md in full, its frontmatter, and the *names* of the files it ships (ADK's own `load_skill` dumps their contents; the engine's `LeanLoadSkillTool` does not). Loading activates the skill, which is what unlocks its `allowed-tools`. |
| `load_skill_resource(skill_name, path)` | one file: `references/x.md`, `assets/x.yaml`, `scripts/x.sh` |
| `run_skill_script(skill_name, script_path, args)` | only with `scripts: local`: runs a script from the skill's `scripts/` through ADK's local executor (JavaScript, Python, shell by extension; 120 s), with the skill's files staged beside it, **after a person approves the exact call** |
| the tools in `skills.tools` | callable only once a loaded skill names them in its `allowed-tools` frontmatter (a space- or comma-separated list). A name already in the agent's `tools:` is a validation error: it is always on. |

Skills are loaded at each compile (every turn in the chat and the server), so a skill added to the directory is seen on the next turn. A directory that does not exist fails the compile: an agent running without the skills it was declared with would be a silent defect. An invalid skill (name not matching its directory, no description) is skipped with ADK's warning.

## Scripts and approval

A script run raises the same confirmation interrupt `require_approval` does ([ADR 0028](/decisions/0028-approval-gates.md)): the turn ends `input-required` with the pending call (skill, script, arguments), the A2A task carries it to the client, and `melchizedek-chat` asks `Approve …? [y/N]` at its next prompt; a one-shot run reports the stop and exits 2. An approval binds to that exact call. The schema allows `scripts: local` only on the orchestrator or a plan-dispatch route, where the pause can reach the caller. The executor is handed to the toolset, never to the agent, so ADK's execution of model-written code blocks stays off: the only code that runs is a file the operator installed. ADK's Docker executor cannot stage a skill's files yet and is not offered.

## The Harness

[`harness.yaml`](/agents/harness.md) is the specimen: a generic agent whose mandate is choose (a `/name` prefix forces a skill), read before following, follow as written, run when allowed, check a deliverable through a tool-free Checker against the rules the skill states, and cite the skills followed. `variables.skills_dir` defaults to this repository's own [suite](/operations/agent-skills.md), so `npm run syndicate:harness` answers how to run, author, serve and remember with the framework; `-- --bind skills_dir=.claude/skills` points it at a project's shelf.

## Exposure

The skills directory is a trust decision the YAML makes visible: a skill is operator-installed procedure, which is why the agent follows it, and it is still text that grants no tool the YAML did not list and runs no script a person did not approve. Point `dir` only at skills you would let a person follow; enable `scripts: local` only on a machine where you would run them, since they run with the server's permissions. A skill's text and a script's output reach the model as data, and the Harness's instruction says so.

Not honoured: `disable-model-invocation` and `context: fork`. Tests: `tests/skillHarness.test.ts`, offline against `tests/fixtures/skills/`.
