---
type: decision
title: "ADR 0045: Own the runtime behind the seam, with ADK removed at 1.0"
description: "The engine owns its agent loop, model contract, tools, sessions and workflow engine behind runSyndicateTurn, built in gated stages beside ADK and with ADK removed at 1.0.0; four stored or wire shapes change only by ADR."
tags:
  - decision
  - models
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/syndicateTurn.test.ts
  - resource: package.json
---

# ADR 0045: Own the runtime behind the seam, with ADK removed at 1.0

**Decided (2026-10-07):** The engine owns its runtime (agent loop, model contract, tools, sessions, workflow engine) behind the `runSyndicateTurn` seam. It was built in gated stages beside ADK under a runtime flag, with ADK removed at 1.0.0. The stored Event JSON, the interrupt names, the A2A surface and the `runSyndicateTurn` signature change only by ADR.

**Instead of:** keeping ADK and fixing the gaps inside it, stripping ADK in one move, adopting another runtime (Vercel AI SDK, Mastra, OpenAI Agents SDK)
**Supersedes:** [ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md) (ADK as the agent runtime; its seam, boundary suite and A2A stance stand)
**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the two-week soak waived; ADK removed in 1.0.0, and `runSyndicateTurn` takes the engine's session and memory services)

How it works: [Architecture](/overview/architecture.md)
