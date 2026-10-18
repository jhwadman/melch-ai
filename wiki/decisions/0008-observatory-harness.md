---
type: decision
title: "ADR 0008: Evals drive the production compiler and runner; judges are agents"
description: "Evaluation runs the served graph through the engine's own compiler and turn runner, and LLM judges are structured-output agents rather than a separate client."
tags:
  - decision
  - evals
  - observability
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/compile.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/observability/tracer.ts
---

# ADR 0008: Evals drive the production compiler and runner; judges are agents

**Decided (2026-08-22):** The A2A server's compiler became `lib/compile.ts` so evals measure the served graph; inference runs in the engine, judges are structured-output agents, and variants are in-memory overrides on the production YAML.

**Instead of:** a Python reimplementation of the compiler, driving the A2A server as a black box, a separate judge client
**Superseded by:** [ADR 0022](/decisions/0022-public-source-of-truth.md) (the harness lives in its own repository); [ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md) (it drives `runSyndicateTurn` instead of a mirrored turn loop)
