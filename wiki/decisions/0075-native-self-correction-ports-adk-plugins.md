---
type: decision
title: "ADR 0075: Native self-correction ports ADK's reflect-and-retry plugins, quirks kept"
description: "The native loop's self-correction is an own-module port of ADK's reflect-and-retry plugins, keeping their quirks and counting a step's parallel calls in call order."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/selfCorrection.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/runtime/native/request.ts
  - resource: tests/nativeLoop.test.ts
  - resource: tests/nativeStep.test.ts
  - resource: tests/selfCorrection.test.ts
---

# ADR 0075: Native self-correction ports ADK's reflect-and-retry plugins, quirks kept

**Decided (2026-10-08):** `lib/runtime/native/selfCorrection.ts` ports ADK's reflect-and-retry model and tool plugins with their texts, ids and counts, keeping their quirks ("attempt 1", a partial resetting the count) so both runtimes store the same events. A step's parallel calls are counted in call order.

**Instead of:** running ADK's plugin classes natively, fixing the quirks on one runtime, counting in completion order, sequential calls when retries are on

**Superseded by:** [ADR 0088](/decisions/0088-native-parity-followups.md) (malformed calls retried through the contract), [ADR 0097](/decisions/0097-reflection-tool-declared-where-adk-declares-it.md) (where the reflection tool is declared), [ADR 0103](/decisions/0103-workflow-retry-spelling-and-signed-reflection-call.md) (signed reflection call on Gemini)

How it works: [Native loop](/overview/native-loop.md)
