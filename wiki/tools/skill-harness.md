---
type: tool
title: Skill harness
description: "The `skills:` agent key: a directory of Agent Skills held the way a coding harness holds them — the frontmatter index injected into the instruction, one SKILL.md and one file read on demand, `allowed-tools` honoured under the YAML's permit, and a skill's scripts run only after a person approves each run. Built on the engine's own tool base, the same on both runtimes."
tags:
  - tools
  - skills
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/tools/skillToolset.ts
  - resource: lib/tools/skills/frontmatter.ts
  - resource: lib/tools/skills/loader.ts
  - resource: lib/tools/skills/executor.ts
  - resource: lib/tools/skills/env.ts
  - resource: lib/tools/skills/tools.ts
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: config/agents/examples/harness.yaml
  - resource: tests/skillHarness.test.ts
  - resource: tests/skillHarnessParity.test.ts
  - resource: tests/skillScriptEnv.test.ts
---

# Skill harness

An agent whose YAML carries a `skills:` block holds a directory of Agent Skills (the open SKILL.md standard: one subdirectory per skill, named as its frontmatter names it, holding `SKILL.md` and optionally `references/`, `assets/` and `scripts/`) the way Claude Code, Codex or Gemini CLI hold theirs ([ADR 0029](/decisions/0029-skills-read-like-a-harness.md)). The harness is the engine's own: its parser, loader, executor and tools import nothing from ADK, the native loop runs them directly, and the optional adk runtime runs them through the one tool adapter ([ADR 0083](/decisions/0083-skills-harness-on-the-own-tool-base.md)).

```yaml
orchestrator:
  skills:
    dir: ".claude/skills"      # relative to the working directory; {{variables}} allowed
    scripts: "none"            # or "local": run a skill's scripts/ here, each after approval
    tools: ["web_extract"]     # registry tools a skill's allowed-tools may unlock once loaded
    env: ["MY_TOOL_HOME"]      # with scripts: local, variable NAMES a script gets
    secret_env: ["MY_API_TOKEN"]  # a secret-shaped name, passed deliberately
```

## What the agent gets

| Where | What |
|---|---|
| its instruction | `<available_skills>` — every skill's name and description, appended at compile time, so no turn is spent discovering skills; plus one statement of the tools below |
| `load_skill(name)` | one SKILL.md in full, its frontmatter, and the *names* of the files it ships, never their contents. Loading activates the skill, which is what unlocks its `allowed-tools`. |
| `load_skill_resource(skill_name, path)` | one file: `references/x.md`, `assets/x.yaml`, `scripts/x.sh`. A binary file is answered with a notice, and the next request carries the file as inline data after the history (never stored). |
| `run_skill_script(skill_name, script_path, args)` | only with `scripts: local`: runs a script from the skill's `scripts/` on the local executor (JavaScript, Python, shell by extension; 120 s), with the skill's files staged beside it, **after a person approves the exact call** |
| the tools in `skills.tools` | callable only once a loaded skill names them in its `allowed-tools` frontmatter (a space- or comma-separated list). A name already in the agent's `tools:` is a validation error: it is always on. |

`list_skills` exists (`ListSkillsTool`) and is left out of the harness: the index is in the instruction. The names, descriptions, parameters, results and error answers (`{ error, error_code }`) are word for word those of ADK's skill tools, with the lean `load_skill` and the gated `run_skill_script` of ADR 0029; `tests/skillHarnessParity.test.ts` holds them to a capture of the ADK-based harness (`tests/fixtures/skillHarness.adk.json`).

## Modules

| Module | Holds |
|---|---|
| `lib/tools/skills/frontmatter.ts` | `parseSkillMd` splits a SKILL.md at the first two `---` and parses the frontmatter with the engine's YAML parser; `validateFrontmatter` checks `name` (lowercase kebab-case or snake_case, at most 64), `description` (1 to 1024), `license`, `compatibility` (at most 500), `allowed-tools` and `metadata`, and returns them in a fixed key order. |
| `lib/tools/skills/loader.ts` | `loadAllSkillsInDir`, `loadSkillFromDir`, `validateSkillDir`: the walk, the skipped directories and file types, and the limits. |
| `lib/tools/skills/executor.ts` | `LocalScriptExecutor` and the staging around it. |
| `lib/tools/skills/env.ts` | `scriptEnvironment` (the allowlist plus the YAML's names), `isSecretShapedEnvName`, and `CappedText` with `SCRIPT_OUTPUT_CHAR_LIMIT`. |
| `lib/tools/skills/tools.ts` | `SkillToolset` and the four tools. |
| `lib/tools/skillToolset.ts` | what `lib/compile.ts` calls: `buildSkillHarness`, `loadSkillSuite`, `skillSuiteProblems`, `skillsInstruction`, `HarnessSkillToolset`. |

`SkillToolset` is an own **Toolset** (`lib/tools/tool.ts`): its `getTools(ctx)` lists the harness tools, then the permitted tools the agent's loaded skills name, read from the session state key `_adk_activated_skill_<agent>`. `lib/compile.ts` hands the adk runtime its `toAdkToolset` form; `compileNative` reads the Toolset back (`toolsetOf`), and the native loop expands it before every request and when an approval resumes.

## Loading, and what is bounded

Skills are loaded at each compile (every turn in the chat and the server), so a skill added to the directory is seen on the next turn. A directory that does not exist fails the compile: an agent running without the skills it was declared with would be a silent defect. A skill is any directory below `dir` holding a SKILL.md; a directory that is not a skill is searched below. Build and tool directories (`node_modules`, `.git`, `__pycache__`, …), compiled files (`.pyc`, …) and symbolic links are never read. An invalid skill (no frontmatter, a field that fails its check, a name that is not its directory's) is skipped, and the compile log names the reason for each direct subdirectory.

| Limit | Value |
|---|---|
| a SKILL.md | 1 MiB; a larger one is refused before it is read |
| its frontmatter | 64 KiB, refused before YAML parses it |
| one resource file | 8 MiB; a larger one is skipped and reported |
| files one skill ships | 1000 |
| directory depth | 12 levels |

No regular expression runs on file text: the delimiters are found by position, and the name is checked one character at a time.

## Scripts and approval

A script run raises the confirmation interrupt `require_approval` raises ([ADR 0028](/decisions/0028-approval-gates.md)), with its own hint naming the skill, the script and the arguments: the turn ends `input-required`, the A2A task carries the pending call to the client, and `melchizedek-chat` asks `Approve …? [y/N]` at its next prompt; a one-shot run reports the stop and exits 2. An approval binds to that exact call, and one opened on either runtime resumes on the other. The schema allows `scripts: local` only on the orchestrator or a plan-dispatch route, where the pause can reach the caller.

What an approved run is: a fresh private temp directory as its working directory, every file the skill ships staged in it at its path, and a wrapper starting the script under this Node, `python3` or `bash` (PowerShell or cmd on Windows). The arguments are passed as `--key value` argv pairs, never through a shell string. The child runs as the server's user, with network access and that user's file access: nothing sandboxes it. It is killed after 120 seconds. Files it wrote come back as `outputFiles` and are copied into a private output directory without overwriting. The executor belongs to the toolset, never to the agent, so model-written code never runs: the only code that runs is a file the operator installed.

## A script's environment and output

A script never sees the server's environment ([ADR 0086](/decisions/0086-skill-scripts-get-a-minimal-environment.md)). It gets:

| What | Names |
|---|---|
| the base allowlist | `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LANGUAGE`, `TZ`, every `LC_*`; on Windows `USERPROFILE`, `USERNAME`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `PATHEXT`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, the `ProgramFiles` and `CommonProgramFiles` family, `NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE`, `OS` |
| `skills.env` | the names listed, none of which may look like a secret |
| `skills.secret_env` | secret-shaped names, listed deliberately |

A listed name the server does not have is absent. A name looks like a secret when a segment between underscores is one of `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASS`, `PWD`, `CREDENTIAL`, `AUTH`, `BEARER`, `COOKIE`, `SESSION`, `PRIVATE`, `SIGNATURE`, `SALT`, `HEADERS`, `DSN`, `DATABASE`, `REDIS`, `CONNECTION` (and their plurals and short forms), or it contains `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `APIKEY`, `CREDENTIAL` or `PRIVATE` anywhere. The check compares strings and runs no regular expression. Every credential in `.env.example` is secret-shaped. `env` and `secret_env` are validation errors without `scripts: local`. Nothing else in the server's environment crosses: provider keys, `DATABASE_URL`, `A2A_SERVER_SECRET`, `NODE_OPTIONS` and the like stay out unless named.

stdout and stderr are each kept up to 20,000 characters (`SCRIPT_OUTPUT_CHAR_LIMIT`), decoded as UTF-8 across chunk boundaries. The rest is counted, not held, and the stream ends with `[stdout truncated: N more characters not shown (the limit is 20000)]` (or `stderr`). The engine's own lines, a process error and `Code execution timed out after 120 seconds.`, follow the capped stderr, so the model always reads them. The executor is shared, so both runtimes behave the same.

## The Harness

[`harness.yaml`](/agents/harness.md) is the specimen: a generic agent whose mandate is choose (a `/name` prefix forces a skill), read before following, follow as written, run when allowed, check a deliverable through a tool-free Checker against the rules the skill states, and cite the skills followed. `variables.skills_dir` defaults to this repository's own [suite](/operations/agent-skills.md), so `npm run syndicate:harness` answers how to run, author, serve and remember with the framework; `-- --bind skills_dir=.claude/skills` points it at a project's shelf. It runs on `runtime: 'native'` as on ADK, storing the same events.

## Exposure

The skills directory is a trust decision the YAML makes visible: a skill is operator-installed procedure, which is why the agent follows it, and it is still text that grants no tool the YAML did not list and runs no script a person did not approve. Point `dir` only at skills you would let a person follow; enable `scripts: local` only on a machine where you would run them, since they run with the server's permissions. A script reads only the base allowlist and the names the YAML lists; a credential it gets is listed under `secret_env` for a reviewer to see. A skill's text and a script's output reach the model as data, and the Harness's instruction says so. Every name and path a model sends is looked up among the skill's own loaded files, never on a prototype, so no call reads a file the skill did not ship.

Not honoured: `disable-model-invocation` and `context: fork`. Tests: `tests/skillHarness.test.ts` (both runtimes, the example, the import graph), `tests/skillScriptEnv.test.ts` (the environment, the cap, the schema, an approved run on both runtimes) and `tests/skillHarnessParity.test.ts` (the capture, ADK's loader read live, the bounds), offline against `tests/fixtures/skills/` and `tests/fixtures/skills-parity/`.
