---
type: decision
title: "ADR 0107: 1.0.0 removes Google ADK, soak waived; the turn runner takes engine interfaces"
description: "Release 1.0.0 deletes the ADK runtime and peer with ADR 0045's soak waived, runSyndicateTurn takes the engine's SessionService and MemoryService, leftover adk settings are errors, and ledger output tokens exclude thinking on every provider."
tags:
  - decision
  - runtime
  - release
  - package
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/runtimeFlag.ts
  - resource: lib/runtime/sessions.ts
  - resource: lib/runtime/memoryService.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/models/registry.ts
  - resource: lib/toolRegistry.ts
  - resource: lib/runtime/native/step.ts
  - resource: tests/nativeLedgerCounts.test.ts
  - resource: lib/index.ts
  - resource: package.json
  - resource: tests/importGraph.test.ts
  - resource: tests/sessionFixtures.test.ts
  - resource: tests/packageSurface.test.ts
  - resource: scripts/ci/consumer_turn.mjs
  - resource: .github/workflows/ci.yml
  - resource: CHANGELOG.md
---

# ADR 0107: 1.0.0 removes Google ADK, soak waived; the turn runner takes engine interfaces

**Decided (2026-10-08):** The owner waived ADR 0045's two-week soak and 1.0.0 deletes the ADK runtime, peer and every module that existed for it. `runSyndicateTurn`'s `sessionService` and `memoryService` take the engine's interfaces (the one fixed-shape change); `MELCHIZEDEK_RUNTIME=adk` and `GEMINI_ADAPTER=adk` are errors; the ledger keeps one output meaning, thinking excluded, for every provider.

**Instead of:** keeping the soak, ADK method names as deprecated store aliases, registerAvailableProviders as a no-op, ignoring or warning on a leftover adk setting, ADK as a test-only dependency, restoring each provider's own usage meaning
**Supersedes:** [ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md), [ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md) (ledger clause), [ADR 0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md) (ledger clause), [ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md) (tracking ADK's current major), [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) (the soak stop rule)

How it works: [Native loop: the runtime flag](/overview/native-loop.md#the-runtime-flag)
