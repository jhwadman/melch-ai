---
type: decision
title: "ADR 0024: The engine owns the turn seam; A2A is the wire, not the runtime"
description: "Turns run only through the framework-owned runSyndicateTurn with turn-wide controls and a tested boundary, and A2A 1.0 (with 0.3 compatibility) is spoken as server and client; ADK stayed the runtime behind it at the time."
tags:
  - decision
  - protocols
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/turnControl.ts
  - resource: lib/a2a/app.ts
  - resource: lib/a2a/remoteAgent.ts
  - resource: tests/syndicateTurn.test.ts
---

# ADR 0024: The engine owns the turn seam; A2A is the wire, not the runtime

**Decided (2026-10-01):** `runSyndicateTurn` is the only place a turn runs and owns turn-wide controls (`max_steps`, abort); the boundary is tested with scripted models; A2A is the wire in both directions, with in-process composition the default. ADK stayed the runtime behind the seam.

**Instead of:** "strictly A2A" with every agent its own server, owning the loop then (later done), another runtime, staying on ADK 1.x
**Superseded by:** [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) (the engine builds its own runtime behind the seam); [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (ADK removed at 1.0.0)

How it works: [Architecture](/overview/architecture.md)
