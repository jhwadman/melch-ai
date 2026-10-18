---
type: decision
title: "ADR 0097: The native step declares the reflection tool only where ADK's model class did"
description: "The native step tells a model of the reflection tool only where ADK's model class would have, so a Gemini adapter standing for ADK's Gemini never sees it, while the tool still runs when called."
tags:
  - decision
  - runtime
  - models
  - gemini
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/selfCorrection.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/compileNative.ts
  - resource: tests/geminiTurnParity.test.ts
---

# ADR 0097: The native step declares the reflection tool only where ADK's model class did

**Decided (2026-10-08):** `declaresReflectionTool(adapter)` decides per adapter: a Gemini adapter is not told of `adk_handle_model_error` unless a caller handed it over behind the shim; every other provider is. The tool still runs when a model calls it.

**Instead of:** declaring the tool everywhere and signing the reflection call instead, never declaring it on native, deciding by model id

How it works: [Native loop: self-correction](/overview/native-loop.md#self-correction)
