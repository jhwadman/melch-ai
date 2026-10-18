---
type: decision
title: "ADR 0071: The native loop stores ADK's events and runs a step's calls in parallel"
description: "The native agent loop stores exactly the events ADK stored, runs one step's tool calls in parallel, runs a fallback model as a second step, and is an async generator."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/step.ts
  - resource: tests/nativeLoop.test.ts
  - resource: tests/syndicateTurn.test.ts
---

# ADR 0071: The native loop stores ADK's events and runs a step's calls in parallel

**Decided (2026-10-08):** The native agent loop stores exactly the events ADK's LlmAgent stored, so sessions cross runtimes. A step's calls run in parallel, each on the state the step left; a `fallback_model` runs as a second step per leaf adapter, the primary's failure unstored; the loop is an async generator of events returning how it ended.

**Instead of:** sequential calls on shared state, a FallbackAdapter inside one step, refusing ADK tools, a callback surface

**Superseded by:** [ADR 0116](/decisions/0116-a-steps-subagent-calls-run-at-once-under-max-concurrency.md) (subagent calls under max_concurrency), [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the ADK-tool path, removed with ADK)

How it works: [Native loop](/overview/native-loop.md)
