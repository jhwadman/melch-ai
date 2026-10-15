---
type: decision
title: "ADR 0134: MELCHIZEDEK_DATA_DIR roots the engine's on-disk defaults; each location keeps its own variable, and the engine's version is read from its own package"
description: "lib/paths.ts resolves the three places the engine writes (outputs and the telemetry spool, the task file, the ChatGPT sign-in file): each location's own variable first, then a default under MELCHIZEDEK_DATA_DIR, then the historical default. inspect_image reads generate_image's reported outputs/<file> inside the outputs directory wherever it is, which failed whenever OUTPUTS_DIR pointed elsewhere. engineVersion reads the engine's package.json and git commit from the engine's own root, not the working directory. A programmatic paths setter, moving the task file with OUTPUTS_DIR and changing the defaults were rejected."
tags:
  - decision
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-15
sources:
  - resource: lib/paths.ts
  - resource: lib/tools/inspectImageTool.ts
  - resource: lib/observability/lineage.ts
  - resource: tests/paths.test.ts
---

# ADR 0134: MELCHIZEDEK_DATA_DIR roots the engine's on-disk defaults; each location keeps its own variable, and the engine's version is read from its own package

## Context

An application that embeds the engine runs it from wherever the operating system starts it, so a default relative to the working directory lands in an arbitrary place (an app bundle, `/`). The engine writes to three places, each with its own variable and default: generated images and the telemetry dead-letter spool (`OUTPUTS_DIR`, else `./outputs`), the task tools' file (`MELCHIZEDEK_TASKS_FILE`, else `./outputs/tasks.json`) and the ChatGPT sign-in (`MELCHIZEDEK_CHATGPT_SIGNIN_FILE`, else `~/.melchizedek/`). The defaults were computed in five modules. Two defects showed up:

- `generate_image` reports `outputs/<file>`, but `inspect_image` resolved that against the working directory, so with `OUTPUTS_DIR` elsewhere it refused every image the generator had just written.
- `engineVersion()`, stamped on every ledger row, read `package.json` and ran `git rev-parse` in the working directory, so an installed engine reported the embedding application's version and commit.

## Decision

1. **One module, one root variable.** `lib/paths.ts` (`outputsDir`, `tasksFile`, `chatGptSignInFile`, `dataDir`) is the only place these are resolved, at each call. A location's own variable wins; without it the default is under `MELCHIZEDEK_DATA_DIR` (`<data>/outputs`, `<data>/outputs/tasks.json`, `<data>/chatgpt-signin.json`) when that is set; with neither, the historical default holds. An embedding application sets one variable.
2. **`inspect_image` reads inside the outputs directory.** A relative path is resolved against `outputsDir()`, a leading `outputs/` dropped, so what `generate_image` reports is what `inspect_image` reads. The confinement check is unchanged: a path that resolves outside the directory is refused.
3. **The engine's version is the engine's.** `enginePackageRoot()` finds the `package.json` named `melchizedek-agents` above the module; the version comes from it, and a git commit only from a checkout at that root (an installed package inside an application's repository reports `local`, not the application's commit). `SOURCE_VERSION`, `HEROKU_SLUG_COMMIT` and `GIT_COMMIT` still win.

## Alternatives rejected

- **A programmatic `setPaths()`.** The engine process's environment is already the embedder's to set, and a variable reaches the bins as well as the library.
- **Moving the task file with `OUTPUTS_DIR`.** An existing deployment that sets only `OUTPUTS_DIR` would find its task lists gone; only the new variable moves it.
- **New defaults** (for example an XDG data directory). Every existing CLI user's files would move.
