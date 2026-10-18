---
type: decision
title: "ADR 0078: Native compaction ports ADK's token-based compactor"
description: "`context:` compaction on the native loop is a rule-for-rule port of ADK's token-based compactor, its summary call an llm.request under the agent span, and a failed summary fails the turn."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/compaction.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/history.ts
  - resource: lib/compileNative.ts
  - resource: tests/compaction.test.ts
---

# ADR 0078: Native compaction ports ADK's token-based compactor

**Decided (2026-10-08):** `lib/runtime/native/compaction.ts` ports ADK's `TokenBasedContextCompactor` and `LlmSummarizer` rule for rule and stores the compacted event before the step. The summary call is charged and traced as an `llm.request` under `agent.invoke`, outside any `model.call`, with no fallback model; a failed summary fails the turn.

**Instead of:** running ADK's compactor from the loop, the summary inside model.call, a fallback for the summary model, skipping compaction on a failed summary

How it works: [Native loop](/overview/native-loop.md)
