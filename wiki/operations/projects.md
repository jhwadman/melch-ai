---
type: subsystem
title: Projects and melchizedek.json
description: "A project is a folder, usually a git repository, with a melchizedek.json at its root naming its agents folder, the exact engine version it is written for, an ignore list, a tests folder, the env variable names it needs and how each syndicate ships. lib/project.ts finds it by walking up to the repository root, and resolveAgentsDir makes it one step of the agents-directory chain every loader and bin uses; melchizedek-doctor reports the pin and what is stale."
tags:
  - operations
  - setup
  - configuration
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/project.ts
  - resource: lib/loadSyndicate.ts
  - resource: lib/doctor.ts
  - resource: scripts/doctor.ts
  - resource: scripts/a2a_server.ts
  - resource: scripts/mcp_server.ts
  - resource: tests/project.test.ts
---

# Projects and melchizedek.json

A **project** is a folder with a `melchizedek.json` at its root ([ADR 0138](/decisions/0138-project-manifest-melchizedek-json.md)). The manifest records what the engine cannot infer from the files: where the syndicates are, which engine version the project is written for, and how each file ships. It holds names, never values.

```json
{
  "manifest": 1,
  "engine": "1.7.0",
  "agents": "agents",
  "ignore": ["agents/retired/**"],
  "tests": "tests/agents",
  "env": ["GOOGLE_GENAI_API_KEY", "XAI_API_KEY"],
  "syndicates": {
    "risk_critic.yaml": { "deliverable": "service", "publish": { "kind": "registry", "id": "risk_critic" } }
  }
}
```

| Key | Meaning |
|---|---|
| `manifest` | Schema version, `1`. A higher number is refused with a message to upgrade the engine. |
| `engine` | The exact `melchizedek-agents` version the project is written for. A pin, not a range. |
| `agents` | The syndicate folder, relative to the root. A path that leaves the root is refused. |
| `ignore` | Glob patterns (`*`, `**`, `?`) on paths relative to the root; matching files are left out of listings. |
| `tests` | The suite folder, default `tests/agents`. |
| `env` | Environment variable names the project needs. A value in this list fails validation, and errors name the field, never its content. |
| `syndicates` | Per file: `deliverable` (`service`, `library`, `mcp`) and `publish: { kind: "registry", id }`. The registry owns versions; the manifest records only the id. |
| `registry`, `production`, `tools` | Where registry targets publish and the restart they need, a read-only ledger connection's env name, and tools served remotely by an MCP URL's env name. Read by the desktop app; the engine validates their shape only. |

Unknown keys are kept by the parser, so a newer writer's fields survive an older reader.

## Finding it

`findProjectRoot(from)` walks up from a directory to the nearest `melchizedek.json` and stops at the repository root (the first directory holding `.git`) or the home directory, so a manifest outside the repository never steers it. `loadProject(root)` parses and validates it with `projectManifestSchema` (zod) and resolves `agents` and `tests` under the root; `findProject()` does both.

## The agents-directory chain

`resolveAgentsDir(explicit?)` is the one chain every loader and bin uses (`readSyndicateFile`, `runDoctor`, `melchizedek-serve`, `melchizedek-mcp`, `melchizedek-doctor`):

1. the explicit option (`agentsDir`, `--agents-dir`);
2. `MELCHIZEDEK_AGENTS_DIR`;
3. the nearest manifest's `agents`;
4. `<cwd>/config/agents`.

A deployed server sets the variable, so the manifest changes only what a bare command run inside a project finds. The lookup is cached per working directory because an A2A route reads a syndicate per request; `clearProjectCache()` forgets it. A broken manifest is treated as absent on this path and reported by the doctor instead, so a typo never fails a request.

## What the doctor reports

When the working directory is inside a project, `runDoctor()` adds `project` to its result (`checkProject`) and applies `ignore` to the syndicate list:

- **Problems** (fail `--check`): the pin differs from the running engine; the agents folder, or a declared tests folder, does not exist; the manifest does not parse or validate.
- **Warnings**: an `ignore` pattern matches nothing; an `env` name is not set (its value is never read); a `syndicates` key names a file that is not in the agents folder.

`listProjectSyndicates(project)` lists the YAML directly in the agents folder minus `ignore`, for embedders such as the desktop app.
