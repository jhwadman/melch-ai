---
type: decision
title: "ADR 0160: Gemini 4 reads earlier turns as text; the placeholder signs its current turn"
description: "On Gemini 4 and later the Gemini adapter sends earlier turns' tool calls and results as text records, not call parts, puts the placeholder signature on an unsigned current-turn call, sends none as LOW and xhigh as XHIGH where taken, and the engine's defaults move to gemini-4-hydrogen."
tags:
  - decision
  - models
  - gemini
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-11-19
sources:
  - resource: lib/models/geminiAdapter.ts
  - resource: lib/models/geminiState.ts
  - resource: lib/models/reasoning.ts
  - resource: lib/models/genaiMapping.ts
  - resource: lib/runtime/native/selfCorrection.ts
  - resource: lib/runtime/native/compaction.ts
  - resource: lib/config.ts
  - resource: db/migrations/0027_gemini_4_pricing.sql
  - resource: scripts/gemini_engine_check.ts
  - resource: tests/gemini4.test.ts
---

# ADR 0160: Gemini 4 reads earlier turns as text; the placeholder signs its current turn

**Decided (2026-11-19):** On a Gemini model of major version 4 or later, the adapter sends messages before the current turn with no function call or function response part: each earlier call goes as a text record in the model's message, and each earlier result as a delimited text record in a user message, marked as data, so what an earlier tool returned stays in context. An unsigned call in the current turn gets Gemini's placeholder signature by default, and self-correction signs its reflection call with it on Gemini 3 and later, and on Gemini 4 also retries Gemini's `MALFORMED_RESPONSE` with a reflection call, as ADK retries `MALFORMED_FUNCTION_CALL`. `reasoning: none` (and a budget of 0) goes as `LOW`, marked weakened; `xhigh` goes as `XHIGH` on gemini-4-hydrogen and gemini-4-neon. The engine's defaults and shipped syndicates move from gemini-3.8-flash to gemini-4-hydrogen, each flipped agent with an explicit `reasoning:`, and the engine's own calls ask a model that thinks high by default for `low`. Gemini 3 and older are unchanged.

**Instead of:** leaving earlier turns' calls and results out (built first; the melch-obs `follow_up` suite, where turn 2 is answerable only from turn 1's tool result, measured it at 0 of 12 against gemini-3.8-flash's 12 of 12: Hydrogen re-fetched every time, doubling tool calls, which is unsafe for a tool with side effects); replaying real signatures on every turn (works only on same-model, in-process, untrimmed history; the Supabase store keeps the placeholder alone); the placeholder on earlier turns' calls (Gemini 4 answers `MALFORMED_RESPONSE`, 0 of 3); text-only history for every Gemini (changes Gemini 3 for no failure); sending `thinkingBudget: 0` for `none` (accepted live, but documented as unable to stop thinking); a level for every internal call on every model (changes Gemini 3 and enables thinking on Claude).

**Supersedes:** amends [ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md) and [ADR 0065](/decisions/0065-gemini-carried-parts-and-server-side-invocations.md) for Gemini 4 (earlier turns' calls and results go as text records, not parts; the placeholder is on by default there), [ADR 0100](/decisions/0100-gemini-row-asserted-on-the-engine-adapter.md) (the live check gains Gemini 4's cases), [ADR 0103](/decisions/0103-workflow-retry-spelling-and-signed-reflection-call.md) (the placeholder signs reflection calls on Gemini 3 and later)

**Open:** a tool result now reaches the model as user-role text rather than a function response: it is delimited and marked as data, not instructions, and a record never goes in the model's answer (the live check fails a turn whose text holds one), but a result that imitates the person is a wider injection surface than it was; signed replay of earlier turns, which needs the model binding to survive storage and a store that keeps signatures (Postgres does, Supabase does not), only if the follow-up-question eval shows the text-only loss matters; the placeholder by default on Gemini 3; another agent's context retold mid-turn as user text moves the turn boundary, so on Gemini 4 the orchestrator's own calls before it go unsent.

How it works: [Gemini adapter](/models/gemini-adapter.md)
