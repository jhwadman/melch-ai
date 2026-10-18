---
type: decision
title: "ADR 0103: Map entries refuse retry and timeout; retry spells exceptions and jitter; Gemini reflection calls signed"
description: "The schema refuses retry and timeout on a workflow map entry, a node's retry spells exceptions and jitter, and native self-correction signs the reflection call it stores in a Gemini model's place."
tags:
  - decision
  - runtime
  - agents
  - gemini
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/syndicateSchema.ts
  - resource: lib/workflow/graph.ts
  - resource: lib/workflowConfig.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/runtime/native/selfCorrection.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/models/geminiState.ts
  - resource: tests/workflowScheduler.test.ts
  - resource: tests/geminiTurnParity.test.ts
---

# ADR 0103: Map entries refuse retry and timeout; retry spells exceptions and jitter; Gemini reflection calls signed

**Decided (2026-10-08):** Refuse `retry` and `timeout` on a `map:` entry (each item runs under its agent's own), let a node's `retry` spell `exceptions` and `jitter`, and on native sign the reflection call stored in a Gemini model's place with the replaced response's signature, or Gemini's placeholder on Gemini 3.

**Instead of:** applying the map entry's modifiers, refusing exceptions and jitter on ADK, replacing ADK's plugin on the ADK runtime, signing every provider's reflection call, a placeholder on every Gemini model
**Open:** a live Gemini 3 run confirming the placeholder and the carried signature on a reflection call

How it works: [Workflow scheduler: controls](/overview/workflow-scheduler.md)
