---
type: decision
title: "ADR 0154: Compaction is on by default from a per-model window table, and a context overflow forces one compaction and retry"
description: "lib/models/contextWindow.ts reads each model's context length from its id (Ollama's from OLLAMA_CONTEXT_LENGTH); without compact_after_tokens an agent compacts past 60% of it; context: applies to any agent and `off` turns masking and compaction off; a provider's overflow refusal (isContextOverflow) is handed back unstored and the loop compacts with half the tail and retries the step once; the fallback never answers it."
tags:
  - decision
  - runtime
  - models
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-11-02
sources:
  - resource: lib/models/contextWindow.ts
  - resource: lib/models/errorResponse.ts
  - resource: lib/models/capabilities.ts
  - resource: lib/runtime/native/compaction.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/compileNative.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/contextWindow.test.ts
  - resource: tests/contextOverflow.test.ts
---

# ADR 0154: Compaction is on by default from a per-model window table, and a context overflow forces one compaction and retry

**Decided (2026-11-02):** No shipped syndicate set `context:`, so no conversation compacted, and nothing in the loop recovered when a prompt outgrew the window. Now `lib/models/contextWindow.ts` reads each model's context length from its id, one row set per provider family with the family's newest row for an id it does not name, and Ollama's from `OLLAMA_CONTEXT_LENGTH` or Ollama's 4,096 default (the one provider that truncates silently instead of refusing, which is why its threshold has to be right); the capability report carries it. `resolveContext` fills `context:`'s defaults from that id: without `compact_after_tokens` an agent compacts past 60% of its window (`compact_after_tokens: 0` never compacts), masking stays at its own default, and `context: off` turns both off. The schema takes `context:` on any agent: the delegate-orchestrator rule is gone, since where the history is bounded the threshold is never reached and nothing happens. A provider's overflow refusal, a 400 or 413 whose message says so in any provider's spelling (`isContextOverflow`), is handed back through the step's `redirect` hook unstored (the same path the fallback uses), and the loop compacts whatever the threshold says with half the tail and runs the step once more; a second overflow is stored and ends the run on its error as before; the fallback adapter never answers it, since it is the request's fault. A compiler that was handed an adapter keeps the YAML's id on the agent (`modelId`) so the table reads the model the person named, not the adapter's own.

**Instead of:** a floor on the default threshold (60% of a 4,096-token Ollama window is right; a 12,000 floor would exceed it); a per-model kind field on the contract's error (the loop classifies the message and status at the one place that acts on it); a retry without compaction (the same prompt would overflow again); more than one retry (a loop that cannot fit after a forced compaction is told so, not spun); keeping compaction off until a syndicate asks (the defaults are safe where history is bounded, and the overflow path is for the case the threshold misses).

How it works: [Native loop](/overview/native-loop.md), [Model contract](/models/model-contract.md). The plan this is the fifth phase of: `plans/context-management.md`.
