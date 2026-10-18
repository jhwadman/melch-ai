---
type: decision
title: "ADR 0135: Delegated runs report live through events.onAgentEvent"
description: "An opt-in events.onAgentEvent callback, carried on the turn's control, receives every event a delegated run yields, and delegated runs stream only when it is set."
tags:
  - decision
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/turnControl.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: tests/agentEvents.test.ts
---

# ADR 0135: Delegated runs report live through events.onAgentEvent

**Decided (2026-10-15):** A delegated run's events reach a surface live through an opt-in `events.onAgentEvent(event, branch)`, carried on `TurnControl`; delegated runs stream only while it is set, and `onEvent` and `onTextDelta` keep meaning the answering agent only.

**Instead of:** forwarding delegated events through `onEvent` with a branch field, threading a callback through every loop context, always streaming delegated runs
**Open:** a delegation inside a nested workflow's agent node reports a path that restarts at the node's agent

How it works: [Native loop](/overview/native-loop.md)
