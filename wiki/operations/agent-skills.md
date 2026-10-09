---
type: runbook
title: The agent-skills suite
description: Eleven Agent Skills (skills/, the open SKILL.md standard) that teach a coding agent where the syndicates are, how to onboard a person by the credentials they have, and how to run, author, serve, remember and write with them — how they install (including the AGENTS.md pointer), where each platform reads them, and how their prose is made.
tags:
  - operations
  - skills
  - packaging
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: skills/README.md
  - resource: lib/skills.ts
  - resource: scripts/skills_install.ts
  - resource: lib/onboarding.ts
  - resource: AGENTS.md
  - resource: config/agents/examples/scribe.yaml
---

# The agent-skills suite

`skills/` is how a coding agent — Claude Code, Codex, Cursor, OpenCode, Gemini CLI — learns this framework. It holds eleven Agent Skills in the open SKILL.md standard (one directory per skill, `name` + `description` frontmatter, optional `references/`, `assets/` and `scripts/`), shipped in the npm package (`files` in `package.json`). They are the consumer-facing counterpart of the contributor skills in `.claude/skills/`, which govern changes to this repository.

| Skill | Teaches |
|---|---|
| `melchizedek` | the entry point: where syndicate files are found (project root, `examples/`, the package), what each starter-pack file does and costs, `melchizedek-doctor`, running one interactively or one shot, and delegating a user's task to a syndicate from inside a coding agent |
| `melchizedek-author` | the syndicate YAML: layout, keys (`reasoning:` among them), instruction anatomy, tools by name, the two constraints that break a file, offline validation; ships `assets/minimal.yaml` |
| `melchizedek-serve` | the [A2A server](/protocols/a2a.md), securing and calling it, [MCP](/protocols/mcp.md) tools for a subagent, serving your own tools over MCP |
| `melchizedek-memory` | [long-term memory](/memory/architecture.md): modes, the [schema](/memory/schema.md), tools, extraction rules, inspection, erasure |
| `melchizedek-models` | [provider routing](/models/provider-routing.md), keys, keyless Ollama, the gateway fallback, per-agent settings (what `reasoning:` becomes on each provider and each Claude model generation, `sampling:`, `tool_choice:` and `model_overrides:`, and `generateContentConfig` as their deprecated spelling; [ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md), [ADR 0049](/decisions/0049-claude-requests-by-model-generation.md), [ADR 0115](/decisions/0115-yaml-schema-v2-provider-neutral-keys.md), [ADR 0117](/decisions/0117-tool-choice-and-effort-above-high-in-v2.md)), the errors |
| `melchizedek-scribe` | writing documents from a brief with [the Scribe](/agents/scribe.md); ships `assets/brief.md` |
| `melchizedek-onboard` | onboarding triage: asks what the person has, routes to one of the nine [authentication levels](/operations/setup.md) and the skill below that owns it, and sets the rules (no key in chat, no value printed, the person types `.env`) |
| `melchizedek-onboard-local` | level 1: Ollama, the keyless files, the context-length and reachability errors |
| `melchizedek-onboard-keys` | levels 2–4 and 9: one provider's key, several, a gateway key, and the honest answer for a ChatGPT / Codex, Claude.ai or Gemini CLI sign-in |
| `melchizedek-onboard-cloud` | level 5: Gemini and Claude on Vertex AI, Claude on Bedrock, GPT on Azure OpenAI, the model maps |
| `melchizedek-onboard-serve` | levels 6–8: BYOK, `A2A_AUTH` caller identities and minting a caller token into a file, OAuth tool grants |

## Installing

`npx melchizedek-skills install` (`npm run skills:install` in a clone; engine `lib/skills.ts`, bin `scripts/skills_install.ts`) copies the suite into the directories agents read. The default writes two: `.claude/skills/` (Claude Code; OpenCode reads it too) and `.agents/skills/` (Codex, Cursor, OpenCode and Gemini CLI all read it), which between them reach every listed agent. `--for claude,codex,cursor,opencode,gemini,agents,all` selects platform-specific locations (`.cursor/skills`, `.opencode/skills` with global `~/.config/opencode/skills`, `.gemini/skills`, Codex's global `~/.codex/skills`); `--global` writes the home-directory locations; `--dir` one explicit directory; `--only` a subset; `--dry-run` prints. `list` and `paths` subcommands describe the suite and the locations. `npx skills add jhwadman/melch-ai` (the skills CLI) installs from the public repo without the package. `--agents-md` also writes a pointer into the project's `AGENTS.md` (the instructions file Codex and other agents read): it creates the file when absent, appends a block delimited by `<!-- melchizedek-skills:begin -->` / `end` markers when the file has none, and afterwards rewrites only that block. It is opt-in because `AGENTS.md` is the user's own file; the skills themselves are discovered from the skills directories without it.

This repository commits its own `.agents/skills/` copy of the five onboarding skills (written by the installer) and a root `AGENTS.md` for contributors that points at `CLAUDE.md`, `.claude/skills/` and the onboarding skills and carries the installer's block; `tests/onboarding.test.ts` holds the copy byte-equal to `skills/` and installs the onboarding skills into every target, project and global ([ADR 0123](/decisions/0123-onboarding-levels-from-one-generator.md)).

The installer copies only from the package's own `skills/` directory (found by walking up from the module, so it works from source and from `dist/`), follows no symlinks, refuses to write outside a skill's own destination directory, and leaves a file that exists with different content alone unless `--force` is given. `tests/skills.test.ts` covers it offline.

## How the prose is made

The five onboarding skills are the exception: they are short procedures written by hand that print their facts from `melchizedek-setup --level <id>` rather than restating them, so a variable or a command changes in `lib/onboarding.ts` alone ([ADR 0123](/decisions/0123-onboarding-levels-from-one-generator.md)). Every other SKILL.md body and `skills/README.md` were written by [the Scribe](/agents/scribe.md) from one brief each, kept beside the prose in `skills/briefs/`: `_shared.md` (the facts every skill agrees on, and the global limits for a skill file) is prepended to each skill's brief; the brief carries the facts, identifiers and required structure; the Scribe carries the voice; a person reviews the result. A skill changes by changing its brief and rerunning (`CHAT_STREAMING=false npm run syndicate:scribe -- "$(cat brief)"`, the document is everything after the last `Scribe › ` line), never by patching prose with the brief left stale — the `melchizedek-scribe` skill is that procedure. Every skill file and brief ships in the package (`files` in `package.json`); a new skill is a deliberate publication. Rationale: [ADR 0014](/decisions/0014-agent-skills-suite.md).
