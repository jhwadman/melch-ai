---
type: decision
title: 'ADR 0029: An agent holds Agent Skills the way a coding harness does: the index injected, one skill read on demand, scripts run only after approval'
description: A `skills:` block on an agent loads a directory of SKILL.md skills through ADK's SkillToolset; the engine appends every skill's frontmatter to the instruction at compile time, replaces ADK's load_skill with one that returns file names rather than file contents, honours `allowed-tools` through the YAML's own permit list, and gates every script run behind the ADR 0028 approval pause. The model's own code never runs.
tags:
  - decision
  - tools
  - agents
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

# ADR 0029: An agent holds Agent Skills the way a coding harness does

## Context

The framework ships a suite of Agent Skills for coding agents ([ADR 0014](/decisions/0014-agent-skills-suite.md)): a directory per skill, a SKILL.md with `name` and `description` frontmatter, and optionally `references/`, `assets/` and `scripts/`. A coding harness uses such a shelf by progressive disclosure. Every skill's frontmatter sits in its system prompt; a request that matches a description makes it read that SKILL.md in full; a file the skill names is opened only when the procedure reaches it; a script the skill ships is run; a person can force a skill by name. A syndicate agent had none of this.

ADK 2.2 carries most of the mechanism: `loadAllSkillsInDir`, a `SkillToolset` with `list_skills`, `load_skill`, `load_skill_resource` and `run_skill_script`, a frontmatter schema that knows `allowed-tools`, an activation state that unlocks a skill's tools once it is loaded, and pluggable code executors. Read closely, four things stood between it and the harness shape:

- The TypeScript port never calls the toolset's own request hook, so the `<available_skills>` index reaches the model only through a `list_skills` call: one round trip per request, and a mandate the model has to remember to follow.
- `load_skill` returns every resource's full content beside the instructions, which spends the tokens progressive disclosure exists to save.
- `run_skill_script` runs when called. Nothing asks a person.
- `allowed-tools` is parsed but acts on nothing; the toolset reads its own `metadata.adk_additional_tools` instead.

Three shapes were considered. **Two hand-written registry tools** (`skill_list`, `skill_read`) with the order of use in the prompt: built first, worked in live runs, and was discarded because it re-implemented a weaker version of what the runtime already had and still paid the listing round trip. **ADK's toolset as is**, exposed by a YAML key: cheapest, but ships the four gaps above. **ADK's toolset behind the engine's seam**, with the engine supplying what the port leaves out.

## Decision

The third shape.

1. **One agent key, `skills: { dir, scripts?, tools? }`** (`lib/syndicateSchema.ts`). The directory is declared in the YAML like `mcp_server_url`, since which shelf an agent works from is part of what the agent is; it is relative to the working directory and may be a `{{variable}}`, so one file serves many shelves (`--bind skills_dir=.claude/skills`).
2. **The index is injected at compile time.** `lib/compile.ts` loads the suite, renders `<available_skills>` and a short statement of the reading tools, and appends it to the agent's instruction. No turn lists skills; the YAML's mandate says how to use them.
3. **Reading stays progressive.** `HarnessSkillToolset` (`lib/tools/skillToolset.ts`) replaces ADK's `load_skill` with one returning the procedure, the frontmatter and the *names* of the files the skill ships; `load_skill_resource` reads one. `list_skills` is dropped.
4. **`allowed-tools` is honoured, under the YAML's permit.** The standard field becomes ADK's activation list, and the registry tools the YAML lists under `skills.tools` are the only ones a skill can unlock. Exposure stays two deliberate acts: the skill names a tool, the YAML permits it. A name already in the agent's `tools:` is a validation error.
5. **Scripts run only after a person approves, and only a skill's own.** `scripts: local` hands ADK's local executor to the toolset, never to the agent, so the model's code blocks stay inert; `GatedRunSkillScriptTool` raises the same confirmation interrupt `require_approval` uses, so the turn runner pauses `input-required`, the A2A task carries the request, and `melchizedek-chat` asks `[y/N]`. The schema allows `local` only where that pause can reach the caller (the orchestrator, or a plan-dispatch route), as [ADR 0028](/decisions/0028-approval-gates.md) requires. ADK's container executor cannot stage a skill's files yet, so it is not offered.
6. **The suite follows the standard's layout.** `melchizedek-author` and `melchizedek-scribe` ship their files under `assets/`, where any harness finds them.
7. **The Harness is the specimen** (`config/agents/examples/harness.yaml`): a generic agent whose mandate is choose, read, follow, run when allowed, check, cite; `/name` forces a skill; a tool-free Checker holds a deliverable to the rules the skill states.

## Consequences

- No new tool contracts and no registry entries: the capability is one toolset built per compile, and an agent without `skills:` is unchanged.
- The index costs prompt tokens on every request in proportion to the shelf (two lines per skill) and nothing else; a skill's body costs tokens only when loaded. Skills are re-read at each compile, so a skill added to the directory is seen on the next turn without a restart.
- The mandate's order (read before following, cite, hand the user what cannot run) is prompt, not code, as with every other syndicate. In live runs on `gemini-3.8-flash` the Harness loaded before following on every matched request, honoured a `/name` invocation, and declined a request no skill covered.
- A deployment that enables `scripts: local` runs operator-installed scripts on its host with the server's permissions, one approval each. The approval binds to the exact call (skill, script, arguments); a hostile skill is still a hostile program once approved, so the directory is a trust decision the YAML makes visible.
- Not honoured: `disable-model-invocation` (every installed skill is in the index) and `context: fork` (a skill runs in the agent that loaded it). Both are harness UI concepts; a skill that must run apart is a subagent here.
- Skills installed from an earlier release keep `templates/` until reinstalled with `--force`; the SKILL.md text names the new path.
