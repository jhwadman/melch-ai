---
type: decision
title: "ADR 0065: Gemini's carried parts, server-side invocations and the placeholder signature"
description: "GeminiAdapter carries parts the contract has no type for as provider state, asks for server-side invocations on the Gemini API only, and keeps the placeholder signature off by default."
tags:
  - decision
  - models
  - gemini
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/models/geminiAdapter.ts
  - resource: lib/models/geminiState.ts
  - resource: lib/models/providerState.ts
  - resource: lib/compile.ts
  - resource: tests/geminiAdapter.test.ts
---

# ADR 0065: Gemini's carried parts, server-side invocations and the placeholder signature

**Decided (2026-10-08):** `GeminiAdapter` carries Gemini parts the contract has no type for (code execution, server-side tool calls and responses) whole as `carried_parts` provider state on the next output part and replays them within the turn. It sends `includeServerSideToolInvocations` only when native tools sit beside function declarations, and only on the Gemini API. Gemini's documented placeholder thought signature is off by default.

**Instead of:** projecting the parts as visible text, a contract part type for code execution, always sending the flag, sending the placeholder by default

**Superseded by:** [ADR 0100](/decisions/0100-gemini-row-asserted-on-the-engine-adapter.md) (carried code execution parts are stored as Gemini sent them)

**Open:** turn on the placeholder signature once a live run confirms it

How it works: [Gemini adapter](/models/gemini-adapter.md)
