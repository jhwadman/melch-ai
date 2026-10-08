---
type: decision
title: "ADR 0108: ADK's side of every parity case is recorded by the parity suites themselves, and the suites compare native against the recording"
description: "WS5-2a freezes ADK's reference behaviour before 1.0.0 removes ADK. tests/helpers/adkReference.ts wraps each parity case's ADK side: with ADK_REFERENCE unset the value is read from tests/fixtures/adk-reference/<suite>/<case>.json and ADK never runs; with ADK_REFERENCE=live the ADK side runs as before; with ADK_REFERENCE=record it runs and writes the file. The value passes through one canonical JSON form (UUIDs, stored-event ids and event times renumbered) in every mode. scripts/ci/record_adk_references.ts runs the suites in record mode, and with --check records into a scratch directory and fails on drift; CI runs the check. A separate recorder that re-implements each case's ADK side, a snapshot of whole objects, and keeping ADK as a test-only dependency after 1.0.0 were rejected."
tags:
  - decision
  - runtime
  - testing
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: tests/helpers/adkReference.ts
  - resource: scripts/ci/record_adk_references.ts
  - resource: tests/helpers/workflowParity.ts
  - resource: tests/nativeStep.test.ts
  - resource: tests/workflowParity.test.ts
  - resource: .github/workflows/ci.yml
  - resource: package.json
---

# ADR 0108: ADK's side of every parity case is recorded by the parity suites themselves, and the suites compare native against the recording

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) removes `@google/adk` at 1.0.0. Until then the parity suites prove the native runtime does what ADK does by running both: a case runs ADK's side (the adk runtime through `runSyndicateTurn`, ADK's `Workflow`, or one of ADK's own functions) with scripted models, runs the native side with the same scripts, and holds them equal after normalising ids and times. [ADR 0084](/decisions/0084-dual-runtime-suites-in-every-test-run.md) put the turn-level suites on both runtimes, and [ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md) made native the default and ADK an optional peer. The WS0-6 session fixtures (`tests/fixtures/sessions`) already freeze what ADK stores; nothing froze what ADK sends a model, the order its workflow stores events in, the progress lines, or the errors it fails with. Deleting ADK would delete every one of those guarantees.

## Decision

1. **A parity case names its ADK side.** `adkReferences(suite)` in `tests/helpers/adkReference.ts` returns `reference(case, live)`. `live` is the case's ADK side as the test runs it, returning exactly what the test compares (requests without their signal, call counts, stored events, routes, progress, outputs, error messages). The native side and every assertion are unchanged.
2. **Three modes, by `ADK_REFERENCE`.** Unset (or `fixture`): `live` never runs and the value is read from `tests/fixtures/adk-reference/<suite>/<case>.json`; a parity suite in this mode does not need ADK. `live`: `live` runs against the installed ADK. `record`: it runs and the file is written (under `ADK_REFERENCE_DIR` when set).
3. **One canonical form in every mode.** The value is passed through JSON, every UUID (in a value or a key) becomes a fixed one in order of first appearance, every stored event's id becomes `ev000001`, … wherever that string appears, and its `timestamp` 2026-01-01 plus one second per event in order; any other time field holding an event's original time takes that event's new time. `live` returns the same canonical value `record` writes, so a green live run proves the recording's shape is enough for the test. The scripted models' default call ids are a per-process counter, not random.
4. **The suites record themselves.** `scripts/ci/record_adk_references.ts` (`npm run fixtures:adk:record`, optionally naming suites) runs every suite that reads a reference with `ADK_REFERENCE=record`, one file at a time, so the ADK side runs with the same scripted models, stubs and virtual clock as the test, and the test's own assertions hold the native side to the value being written. A failing suite fails the recording.
5. **A drift check.** `npm run fixtures:adk:check` records into a scratch directory and fails on any byte that differs from the committed files, a missing file, or a file no longer recorded. Two runs in a row write the same bytes. CI's test job runs it after `fixtures:sessions:check`.
6. **The pin.** A live ADK side that goes through `runSyndicateTurn` passes `runtime: 'adk'`: since 0.20.0 an unpinned side follows `MELCHIZEDEK_RUNTIME`, which defaults to native.
7. **What is not recorded.** Tests whose subject is ADK itself (the adk runtime's own cases, including a `forEachRuntime` case's `[adk]` variant and an `acrossRuntimes` direction written on adk, the shim, the session bridges, `compileAdk`, `TracedGemini`, `AdkGeminiAdapter`, ADK-only refusals) keep running ADK. 1.0.0 (WS5-2b) deletes them with the code, together with `live`, `record`, the recorder, the check and the CI step; the fixture branch stays.

> **Note (2026-10-08):** With ADK removed in 1.0.0 ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)), `tests/helpers/adkReference.ts` keeps only the fixture branch: `reference(case)` reads the recording. The `live` and `record` modes, `scripts/ci/record_adk_references.ts`, the `fixtures:adk:*` scripts and their CI steps are retired, and the recordings are data.

## Alternatives considered

- **A separate recorder that re-implements each case's ADK side.** It is what the brief first sketches, and it keeps the tests free of any recording code. Every case would be written twice, once in the test and once in the recorder, and the two would drift: the recording would no longer be "the ADK side exactly as the test runs it". Running the tests in record mode makes the test the recorder, and the test's assertions check the recording as it is written.
- **Snapshot whole objects** (sessions, model instances, every event field). Simpler to write, but the files grow with fields no test reads, and a field that varies per run (a span id, a duration) would fail the drift check for no reason. The recording holds what the test compares.
- **Keep `@google/adk` as a dev dependency after 1.0.0, only for the tests.** The package would stop depending on ADK, but every `npm test` would still run it, and the next ADK release would move the reference under the engine's feet. The reference is ADK 2.2.0's behaviour, frozen: the version is in each file.
- **Normalise per suite only.** Each suite already normalises what it compares, but the ids it ignores (invocation ids, event ids, times) still reach the file and make it differ per run. One canonical form in the helper handles them once.

## Consequences

- With `ADK_REFERENCE` unset, a converted parity suite reads its references and runs native only; `npm test` and `MELCHIZEDEK_RUNTIME=adk npm test` both use the recordings.
- `ADK_REFERENCE=live npm test` runs every parity suite against live ADK, as before.
- An ADK bump that changes behaviour shows as drift in `fixtures:adk:check`: read the diff before re-recording.
- A new parity case needs ADK installed once, to record it, until 1.0.0; after that a case is written against the recordings or not at all.
- `tests/fixtures/adk-reference` holds one JSON file per case; PR WS5-2a reports its size.
