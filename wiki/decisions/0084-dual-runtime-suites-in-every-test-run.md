---
type: decision
title: "ADR 0084: Turn-level suites ran every case once per runtime"
description: "During the dual-runtime period every turn-level test case ran on both runtimes and CI ran the offline suite again with native as the default."
tags:
  - decision
  - runtime
  - operations
status: deprecated
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: tests/helpers/runtime.ts
  - resource: tests/syndicateTurn.test.ts
  - resource: tests/postgresStorage.test.ts
  - resource: tests/remoteAgent.test.ts
  - resource: .github/workflows/ci.yml
  - resource: lib/compileNative.ts
  - resource: lib/runtime/native/step.ts
---

# ADR 0084: Turn-level suites ran every case once per runtime

**Decided (2026-10-08):** Every turn-level case ran on both ADK and native (and across runtimes), and CI ran the offline suite a second time with native as the default, until ADK was removed.

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (dual-runtime helpers deleted; suites run once) and [ADR 0108](/decisions/0108-adk-reference-recorded-by-the-parity-suites.md) (compare against ADK's recorded side)
