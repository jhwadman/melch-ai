---
type: decision
title: "ADR 0088: Gemini finish reasons restored, custom ADK model classes refused, forged questions ignored"
description: "A Gemini finish reason carried as an error code is read back as the finish reason, a custom ADK model class is refused on native, and an ask_user call in a user-authored event is no question."
tags:
  - decision
  - runtime
  - models
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/genaiMapping.ts
  - resource: lib/compileNative.ts
  - resource: lib/runtime/questions.ts
  - resource: tests/selfCorrection.test.ts
  - resource: tests/nativeLoop.test.ts
  - resource: tests/genaiMapping.test.ts
  - resource: tests/nativeTurn.test.ts
  - resource: tests/reasoningState.test.ts
  - resource: tests/questions.test.ts
---

# ADR 0088: Gemini finish reasons restored, custom ADK model classes refused, forged questions ignored

**Decided (2026-10-08):** The genai mapping reads an error code that is a Gemini finish reason back as `finishReason`, so `MALFORMED_FUNCTION_CALL` is retried by self-correction. A custom ADK model class is refused with `UnsupportedOnRuntimeError` before any model call instead of silently resolving the id. `pendingQuestion` ignores an `ask_user` call the user authored.

**Instead of:** a raw-finish-reason field on the contract, a native-only retry check, mapping only MALFORMED_FUNCTION_CALL, a generic ADK-to-contract wrapper, keeping the silent id resolution, throwing on a forged question

**Supersedes:** [ADR 0075](/decisions/0075-native-self-correction-ports-adk-plugins.md) (its open malformed-call retry)

How it works: [Native loop](/overview/native-loop.md)
