---
type: decision
title: "ADR 0108: Parity suites compare native against ADK's side as they recorded it"
description: "Each parity case's ADK side is recorded by the parity suite itself into tests/fixtures/adk-reference in one canonical JSON form, and the suites compare native against the recording."
tags:
  - decision
  - runtime
  - testing
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: tests/helpers/adkReference.ts
  - resource: scripts/ci/record_adk_references.ts
  - resource: tests/helpers/workflowParity.ts
  - resource: tests/nativeStep.test.ts
  - resource: tests/workflowParity.test.ts
  - resource: .github/workflows/ci.yml
  - resource: package.json
---

# ADR 0108: Parity suites compare native against ADK's side as they recorded it

**Decided (2026-10-08):** Freeze ADK's reference behaviour before its removal by having each parity suite record its own ADK side into `tests/fixtures/adk-reference/` in one canonical JSON form, and compare the native side against that recording.

**Instead of:** a separate recorder re-implementing each case, snapshots of whole objects, ADK as a test-only dependency after 1.0.0, per-suite normalisation only
**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the live and record modes, the recorder and the drift check are retired; the recordings are data)

How it works: [Native loop: ADK's recorded side](/overview/native-loop.md#adks-recorded-side)
