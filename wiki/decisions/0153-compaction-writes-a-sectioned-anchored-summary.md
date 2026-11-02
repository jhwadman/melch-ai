---
type: decision
title: "ADR 0153: Compaction writes a sectioned, anchored summary that includes tool activity, and skips on failure"
description: "The summarizer reads the previous summary and the newly cut span only, under a fixed system prompt that names six sections (Intent, Stated facts, Decisions, Artifacts, Open, Last state), a word budget and a superseded-marking rule; tool calls go in as JSON and results as cut text; a summary with no text, an error or one far past the budget is not stored and the step runs uncompacted. The when and the stored event stay ADK's. Supersedes ADR 0078's rule-for-rule summarizer."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-11-02
sources:
  - resource: lib/runtime/native/compaction.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/history.ts
  - resource: tests/compaction.test.ts
  - resource: tests/compactionProbes.test.ts
---

# ADR 0153: Compaction writes a sectioned, anchored summary that includes tool activity, and skips on failure

**Decided (2026-11-02):** What a compaction keeps decides what the agent still knows, and ADK's summarizer read text parts only (every tool call and result vanished unless the model had repeated it in prose), asked for something "concise" with no shape (so each summary of a summary eroded what the last had kept), and threw, failing the person's turn, when the model answered nothing. The engine's summarizer (`lib/runtime/native/compaction.ts`) now sends a fixed system prompt naming six sections, every one present even when empty: Intent, Stated facts (values with their units, absolute dates), Decisions (and what each replaced), Artifacts (paths, URLs, ids and tool results with their handles), Open, Last state; with the rules to keep every item still true, mark a superseded one with what replaced it, add nothing the events do not say, and stay under 1,200 words. The user message is anchored: the previous summary under `# Previous summary`, then only the events since it under `# New events`, each with its text, its tool calls as JSON and its tool results cut at 2,000 characters. The output is capped at 2,048 tokens. A summary with no text, an error, or one past the budget by half again is not stored: the step runs uncompacted, the reason goes to the log and to the agent span as a `compaction.skipped` event, and the next step tries again. The stored event keeps ADK's shape plus `summaryFormat: 'sections/1'`, so a session ADK compacted reads on and its summary anchors the next. The when (`compact_after_tokens`, `keep_recent_events`, the cut that never splits a call from its answer) is unchanged.

**Instead of:** keeping ADK's summarizer (ADR 0078's reason, a session ADK wrote continuing identically, holds for the stored event and the when, not for the words of a prompt); summarizing the whole history each time (the previous summary is the anchor, so a fact kept once is kept, and the input stays the size of one span); a judge-model eval (the probe test plants facts and checks them by exact match, offline against the summarizer's input and, with `COMPACTION_PROBE_MODEL`, against a real model's summary); failing the turn on a failed summary (housekeeping never costs the person their answer; an overflow, when it comes, is the next phase's to recover from).

**Supersedes:** [ADR 0078](/decisions/0078-native-compaction-ports-adk-compactor.md), for the summary and the failure; its port of the compactor's when and event stands.

How it works: [Native loop](/overview/native-loop.md). The plan this is the third phase of: `plans/context-management.md`.
