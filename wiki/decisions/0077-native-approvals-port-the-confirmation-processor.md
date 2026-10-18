---
type: decision
title: "ADR 0077: The native loop resumes an approval before every step, refusals throw"
description: "An answered approval is resumed by a port of ADK's request-confirmation processor that runs before every model step, and an answer that does not bind throws."
tags:
  - decision
  - runtime
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/approvals.ts
  - resource: tests/nativeApprovals.test.ts
  - resource: tests/nativeTurn.test.ts
  - resource: lib/runtime/syndicateTurn.ts
---

# ADR 0077: The native loop resumes an approval before every step, refusals throw

**Decided (2026-10-08):** `lib/runtime/native/interrupts.ts` ports ADK's request-confirmation processor and runs it before every step: answers in the latest user event bind to the pinned call by id, tool, name and arguments, and the bound calls run through the loop's normal call path. An answer that does not bind throws ADK's `IntentMismatchError` text and stores nothing.

**Instead of:** resuming once at the start of the run, resuming in the turn runner, storing a refusal as an error event

How it works: [Native loop](/overview/native-loop.md)
