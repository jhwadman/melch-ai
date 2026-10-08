---
type: decision
title: "ADR 0083: The skills harness is the engine's own: a parser, a loader, a local executor and four own Tools in a Toolset, held to the ADK harness's words"
description: "WS3-3 moves the skills harness (ADR 0029) off ADK's SkillToolset. lib/tools/skills/ holds a frontmatter parser on the engine's YAML parser with bounded input and no backtracking pattern, a loader that walks the same layout to the same objects, a port of ADK's local executor with its limits unchanged, and list_skills, load_skill, load_skill_resource and run_skill_script as own Tools in a SkillToolset, a new own Toolset shape that the native loop expands and lib/tools/adkTool.ts wraps for ADK. A Tool gains a contents hook so a binary resource reaches the request on both runtimes. A capture of the ADK harness holds the declarations, results and error texts. js-yaml, a zod mirror of ADK's schema, defineTool, a fixed tool list gated at call time, and dropping the binary injection were rejected."
tags:
  - decision
  - tools
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
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

# ADR 0083: The skills harness is the engine's own, held to the ADK harness's words

## Context

[ADR 0029](/decisions/0029-skills-read-like-a-harness.md) built the `skills:` harness on ADK's skill toolset: `loadAllSkillsInDir` and `validateSkillDir` to load a shelf, a `SkillToolset` subclass whose activation state unlocked a skill's tools, ADK's `load_skill_resource`, a `run_skill_script` subclass gated behind the approval pause, and `UnsafeLocalCodeExecutor` to run a script. The native loop ([ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)) ran those ADK objects by shape. [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) has the engine own its runtime in stages, and [ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md) gave tools their own base. The harness was among the last tool families that still needed ADK to exist.

The constraint was the model's view. The names, descriptions, parameter schemas, results and error texts a model reads, and the events a session stores, had to stay as they were, on both runtimes. Five questions had real alternatives.

## Decision

1. **Four modules under `lib/tools/skills/`, none importing ADK.** `frontmatter.ts` reads and checks a SKILL.md, `loader.ts` loads a shelf, `executor.ts` runs a script, and `tools.ts` holds the tools and the `SkillToolset`. `lib/tools/skillToolset.ts` keeps its exports (`buildSkillHarness`, `loadSkillSuite`, `skillSuiteProblems`, `skillsInstruction`, `HarnessSkillToolset`, `LeanLoadSkillTool`, `GatedRunSkillScriptTool`, `SCRIPT_TIMEOUT_SECONDS`, `SkillsConfig`, `LoadedSkill`) on top of them. `lib/skills.ts` reads the suite's frontmatter with the same parser.

2. **The frontmatter is read as ADK read it, by the engine's YAML parser.**
   - The frontmatter is the text between the opening `---` and the next `---`, wherever that falls, and the body is the rest, trimmed. This is ADK's `split('---')`, found with `indexOf`.
   - The mapping is parsed by the `yaml` package the engine already uses, with its default alias cap.
   - The fields are checked by hand-written code that applies ADK's FrontmatterSchema rules, and the result has that schema's key order, because load_skill returns it and a stored event is JSON. The name is checked one character at a time.
   - A SKILL.md over 1 MiB and a frontmatter block over 64 KiB are refused before anything is parsed.
   - A field that fails its check is reported as `Invalid frontmatter: <field>: <rule>`. ADK reported a zod issue dump, whose first line, which the compile log shows, was `Invalid YAML in frontmatter: [`. The structural texts stay ADK's.

3. **The tools are own Tools with ADK's answers.** `list_skills`, `load_skill` (lean, ADR 0029), `load_skill_resource` and `run_skill_script` (gated, ADR 0029) implement `Tool` directly. Their parameters are written as JSON Schema and their arguments are checked in `execute`, so a bad call gets the `{ error, error_code }` (or `errorCode`, as ADK's run_skill_script spells it) it got before. `run_skill_script` asks for confirmation itself, with ADR 0029's hint, payload and texts. It does not set `requiresApproval`, which would write `requireApproval`'s generic texts. The native approval processor accepts a call that asked ([ADR 0077](/decisions/0077-native-approvals-port-the-confirmation-processor.md)).

4. **Activation is a Toolset.** `lib/tools/tool.ts` gains `Toolset`, a `getTools(ctx)` that lists an agent's tools for the next request against a `ToolsetContext` (agent name, invocation id, session state), with `isOwnToolset` and `toolsetOf`.
   - `SkillToolset.getTools` returns the harness tools, then the tools that the activated skills name in `metadata.adk_additional_tools`, in ADK's order and with ADK's duplicate refusal.
   - Activated skills are read from ADK's own state key, `_adk_activated_skill_<agent>`, so a session stored by either runtime reads the same.
   - The unlocked tools are picked only from those the YAML resolved under `skills.tools`.
   - `lib/compile.ts` hands the ADK runtime `toAdkToolset(toolset)`, a `BaseToolset` in `lib/tools/adkTool.ts` whose `getTools` passes ADK's `ReadonlyContext` through and wraps each tool with `toAdkTool`. `compileNative` reads the Toolset back, and the native loop expands it as it expanded ADK's toolset.

5. **A Tool may add to the request's history.** ADK's `load_skill_resource` answers a binary file with a notice. In its `processLlmRequest` it then appends the file as inline data to the next request. `Tool` gains an optional `contents(contents, ctx)` hook:
   - The native request builder runs it after the tools, in their order.
   - On the ADK runtime, the adapter's `FunctionTool` subclass runs it in `processLlmRequest`.
   - What it adds is never stored.

   The notice's text therefore stays true on both runtimes.

6. **The executor is ported with its limits unchanged.**
   - The working directory is a fresh private temp directory, with the skill's files staged in it.
   - The interpreters and wrappers are ADK's, and the arguments are passed as `--key value` argv pairs.
   - The timeout is 120 s, ending in SIGKILL.
   - The environment is inherited.
   - stdout and stderr are collected whole.
   - Output files are copied without overwriting.

   Only names change: the temp directories are `melchizedek_skill_script_*` and `melchizedek_skill_output_*`. ADK's per-run warning banner is not logged. The compile log already says that scripts run after approval.

7. **The loader adds bounds ADK's did not have.** A resource over 8 MiB is skipped and reported, at most 1000 files per skill are read, and walks stop at 12 levels. A skill name, a resource path or a script name a model sends is looked up as an own key of the loaded maps, never on a prototype.

## Differences a model or an operator can see

These are recorded here and noted on ADR 0029:

- **YAML.** Timestamps in frontmatter stay strings, where js-yaml made `Date`s, and `<<` merge keys are not merged (YAML 1.2). A YAML syntax error is described in the `yaml` package's words.
- **Problems in the compile log.** A field that fails its check is named in readable words (item 2).
- **Prototype keys.** `load_skill` with `constructor`, or a path such as `references/constructor`, answers not found. ADK returned whatever `Object.prototype` held.
- **Paths.** Temp directory names differ (item 6). They appear in `outputDirectory`, and in a stack trace a script prints, and were random already.
- **Size limits.** A shelf over a limit loses that file or skill, with a compile-log line (items 2 and 7).

Nothing else changes. `tests/skillHarnessParity.test.ts` compares the engine's harness with `tests/fixtures/skillHarness.adk.json`, captured from the ADK-based harness. The capture covers the loaded skills (frontmatter JSON byte for byte), the problems, the instruction, the declarations in ADK's dialect and the contract's, activation, and the result of each call in a table of 31 argument sets, with each approval answer for a script run. The test also reads ADK's loader live against the engine's on an edge-case shelf. `tests/skillHarness.test.ts` runs each conversation on both runtimes and requires the same results, model requests and stored events; it also runs `harness.yaml` on native and walks the harness files' import graph.

## Alternatives considered

- **js-yaml for exact YAML parity.** ADK uses it, but the engine does not depend on it. Adding a second YAML parser to `dependencies` for timestamp and merge-key parity on skill frontmatter, which is name and description text, costs more than it gives.
- **A zod schema mirroring ADK's FrontmatterSchema.** This would make the validator one declaration. But the name rule as a regular expression is the nested-quantifier shape CodeQL's `js/polynomial-redos` flags, and zod's issue dump is what made the old log line unreadable.
- **Splitting on a `---` line rather than the next `---`.** This is more correct for a description that contains `---`, but it changes which SKILL.md files load and where a body starts. Parity came first. A later change can tighten it with its own record.
- **`defineTool` contracts.** This is the house pattern (tool-contract skill). But defineTool answers a bad call with its own readable string, which would change every error result ADK's tools return.
- **A fixed tool list, with an unlocked tool refusing until its skill is loaded.** No Toolset shape would be needed, but the declarations a model receives would change: every permitted tool would be declared from the first request.
- **Dropping the binary injection, or keeping it on ADK only.** The first loses a capability and makes the notice untrue, unless its text changes. The second makes the runtimes differ on one tool.
- **Scrubbing the script environment or capping its output.** The brief keeps the executor's limits unchanged, so it is listed as an open question instead.

## Consequences

- The harness files import nothing from `@google/*`, not even a type. `tests/skillHarness.test.ts` walks their runtime import graph to hold it.
- `HarnessSkillToolset` is an own Toolset, no longer an ADK `SkillToolset`. `LeanLoadSkillTool` and `GatedRunSkillScriptTool` are the own tool classes under their old names. Code that put the toolset straight into an `LlmAgent` must wrap it with `toAdkToolset`. The `exports` map is unchanged; the new modules are reachable under `melchizedek-agents/tools/*`.
- A Tool can now add to a request's history. Only `load_skill_resource` does.
- A script still runs with the server's environment. The approval and the operator's choice of shelf remain the controls.
