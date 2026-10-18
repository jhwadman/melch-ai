---
type: decision
title: "ADR 0079: A question resumes on the native loop through its history"
description: "An answered ask_user call resumes on the native loop through the history projection, with no request processor, as on ADK."
tags:
  - decision
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/questions.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/history.ts
  - resource: tests/questions.test.ts
  - resource: tests/questionsA2a.test.ts
  - resource: tests/nativeQuestions.test.ts
  - resource: tests/nativeTurn.test.ts
---

# ADR 0079: A question resumes on the native loop through its history

**Decided (2026-10-08):** An answered `ask_user` call needs no resume hook: the turn runner stores the person's answer as the call's function response, and the next step's history puts call and answer side by side. `runSyndicateTurn` stopped refusing a question's answer on native.

**Instead of:** porting ADK's request-input processor, a loop hook that writes or re-runs the answer

How it works: [Native loop](/overview/native-loop.md)
