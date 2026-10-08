---
type: decision
title: "ADR 0099: 0.19.0 ships the native runtime as an opt-in; the native default moves to 0.20.0"
description: "ADR 0045 planned for release 0.19.0 to make native the default runtime. The owner published 0.19.0 on 2026-10-08 from main at #127, with adk still the default and native selectable through MELCHIZEDEK_RUNTIME or the turn's runtime option. Gates G1, G2 and G4 were signed by then; G3 was open, and #128 (ADR 0097, a native-only Gemini failure) landed after the publish. The native default therefore moves to 0.20.0, behind G3 and the stop rules ADR 0045 sets. Re-publishing 0.19.0 and flipping the default in a 0.19.x patch were rejected."
tags:
  - decision
  - runtime
  - release
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: CHANGELOG.md
  - resource: package.json
  - resource: lib/runtime/runtimeFlag.ts
---

# ADR 0099: 0.19.0 ships the native runtime as an opt-in; the native default moves to 0.20.0

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) item 2 says the default stays `adk` until release 0.19.0, which makes `native` the default. The version in `package.json` reached 0.19.0 earlier, with the `./model` export (WS1-12), before the native runtime was complete.

On 2026-10-08 the owner published `melchizedek-agents@0.19.0` from `main` at the merge of #127 (`gitHead` 1838695). In that build `DEFAULT_RUNTIME` is `adk` (`lib/runtime/runtimeFlag.ts`); `native` runs when a caller sets `MELCHIZEDEK_RUNTIME=native` or passes `runtime: 'native'`. By then gates G1, G2 and G4 of ADR 0045 were signed. G3 (the Gemini row's evidence `test`) was open. #128 ([ADR 0097](/decisions/0097-reflection-tool-declared-where-adk-declares-it.md)), which fixes a native-only failure of Gemini 3 models, landed after the publish and is not in 0.19.0.

## Decision

1. **0.19.0 is the release that ships the native runtime as an opt-in.** Its CHANGELOG section says so, and `adk` stays its default.
2. **The native default moves to 0.20.0.** 0.20.0 makes `native` the default only when G3 is signed and ADR 0045's stop rule holds (every ADK-written session fixture resumes under `native`). Everything else ADR 0045 sets (the gates, the stop rules, 1.0.0 removing ADK, the four fixed shapes) is unchanged.
3. **A native opt-in user on Gemini 3 should take the next patch.** #128 ships in the first release after 0.19.0 (0.19.1, or 0.20.0 if that comes first).

## Alternatives considered

- **Re-publish 0.19.0 with `native` as the default.** Rejected: a published version is immutable on npm, and a consumer who already installed 0.19.0 would run a different default than the CHANGELOG describes.
- **Flip the default in a 0.19.x patch.** Rejected: a default runtime change is not a patch, and G3 is open.

## Consequences

- ADR 0045's text that ties the native default to 0.19.0 is read through this record; ADR 0045 is not edited.
- The G1 entry in ADR 0045's gate log names a live parity run under `adk` as owed before 0.19.0. It had not been run across all six providers when 0.19.0 was published; the run that followed is recorded in the gate log.
- The live server (Heroku `melchizedek-a2a`) pins its version exactly; moving it to 0.19.0 is a deploy the owner makes, and it stays on `adk` unless `MELCHIZEDEK_RUNTIME` is set there.
