---
type: decision
title: "ADR 0116: A step's subagent calls run concurrently under max_concurrency"
description: "Calls to subagents in one model step run concurrently, capped per step by the root max_concurrency key, and are stored in call order."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/compile.ts
  - resource: tests/parallelDelegation.test.ts
  - resource: tests/nativeDelegate.test.ts
---

# ADR 0116: A step's subagent calls run concurrently under max_concurrency

**Decided (2026-10-09):** Calls to subagents in one model step run at once, at most the root `max_concurrency` (default 4, at most 32) per step, two calls to one subagent one after the other, and the step's responses are stored in call order. Ordinary tool calls stay uncapped.

**Instead of:** ADK's one-after-another order (still available as `max_concurrency: 1`), an uncapped `Promise.all`, a turn-wide cap, the key on the orchestrator block, capping every tool call
**Supersedes:** [ADR 0074](/decisions/0074-native-delegation-runs-a-child-loop-as-agent-tool-does.md) (Decision 2, serial delegation)

How it works: [Native loop](/overview/native-loop.md)
