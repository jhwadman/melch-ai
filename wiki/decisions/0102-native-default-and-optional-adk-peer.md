---
type: decision
title: "ADR 0102: 0.20.0 makes native the default and @google/adk an optional peer"
description: "Release 0.20.0 made native the default runtime and @google/adk an optional peer loaded in one module."
tags:
  - decision
  - runtime
  - release
  - package
status: deprecated
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/adkPeer.ts
  - resource: lib/runtime/runtimeFlag.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/compileAdk.ts
  - resource: lib/workflow.ts
  - resource: lib/models/registry.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/doctor.ts
  - resource: lib/toolRegistry.ts
  - resource: package.json
  - resource: .github/workflows/ci.yml
  - resource: scripts/ci/consumer_turn.mjs
  - resource: tests/optionalAdk.test.ts
  - resource: tests/packageSurface.test.ts
  - resource: tests/helpers/withoutAdk.ts
  - resource: tests/sessionFixtures.test.ts
---

# ADR 0102: 0.20.0 makes native the default and @google/adk an optional peer

**Decided (2026-10-08):** 0.20.0 made `native` the default runtime and `GeminiAdapter` the Gemini default, with `@google/adk` an optional peer loaded only through `lib/adkPeer.ts`.

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)
