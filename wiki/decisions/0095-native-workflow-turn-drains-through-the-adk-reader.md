---
type: decision
title: "ADR 0095: A native workflow turn drains the walk's stored events through the shared reader"
description: "A workflow turn on the native runtime yields the walk's stored events to the same reader and root span ADK's Runner stream fed, rehydrates on every message, and fails an unsupported resume as RESUME_UNSUPPORTED."
tags:
  - decision
  - runtime
  - agents
  - observability
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow/turn.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/nativeTurn.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/toolNode.ts
  - resource: lib/runtime/native/telemetry.ts
  - resource: lib/compileNative.ts
  - resource: tests/workflow.test.ts
  - resource: tests/workflowParity.test.ts
  - resource: tests/nativeLedger.test.ts
  - resource: tests/sessionFixtures.test.ts
---

# ADR 0095: A native workflow turn drains the walk's stored events through the shared reader

**Decided (2026-10-08):** Run workflow syndicates on native as a generator of the walk's stored events, drained and traced by the same `traceAgentRun` / `drainAgentStream` path as any turn, so text, progress, node errors and ledger rows come from one reader. Every message rehydrates; a resume the walk cannot pick up fails the turn `RESUME_UNSUPPORTED`; a node's reported error is returned, not thrown; node spans open through a `traceNode` hook under the engine's names.

**Instead of:** building the result from the walk's return value, rehydrating only when a question is pending, walking afresh on an unsupported pause, throwing the unsupported resume out of the turn, ADK's span names, spans from scheduler events, lifting the ask_user tool refusal on ADK alone
**Superseded by:** [ADR 0128](/decisions/0128-oauth-consent-inside-workflow-nodes.md) (a node agent now gets the OAuth consent step)
**Open:** an `ask_user` tool on a workflow node's agent (refused; use an ask_user node)

How it works: [Workflow scheduler: the native turn](/overview/workflow-scheduler.md#the-native-turn)
