---
type: decision
title: "ADR 0031: An agent asks the person through ask_user"
description: "One registry tool, ask_user(question, options?), ends the turn input-required with the question; the next plain-text message becomes the call's answer."
tags:
  - decision
  - tools
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/questions.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/questions.test.ts
  - resource: tests/questionsA2a.test.ts
---

# ADR 0031: An agent asks the person through ask_user

**Decided (2026-10-02):** An agent asks the person through one registry tool, `ask_user(question, options?)`. The turn ends `input-required` with the same `input_request` data part a workflow's `ask_user` node uses, and the next plain-text message becomes the call's answer, with no special reply format.

**Instead of:** ADK's `requestInputTool` and `getUserChoiceTool`, a required structured reply, treating a message as an answer only when it looks like one
**Superseded by:** [ADR 0079](/decisions/0079-native-questions-resume-through-the-history.md) (the native loop resumes the question), [ADR 0110](/decisions/0110-pauses-inside-delegated-subagents-reach-the-turn.md) (questions inside delegated subagents)
**Open:** the `ask_user` tool on a workflow node's agent (refused; an `ask_user` node asks instead)

How it works: [ask_user](/tools/ask-user.md)
