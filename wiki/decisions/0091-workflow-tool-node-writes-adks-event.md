---
type: decision
title: "ADR 0091: A workflow tool node writes ADK's event itself, registry from its caller"
description: "A workflow tool node runs its tool as ADK's ToolNode did, builds and hands on ADK's event itself, and resolves the tool through a function its caller passes."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow/toolNode.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: tests/workflowToolNode.test.ts
---

# ADR 0091: A workflow tool node writes ADK's event itself, registry from its caller

**Decided (2026-10-08):** `lib/workflow/toolNode.ts` runs a `tool:` node as ADK's `ToolNode` did (input coercion, call id `<node path>:<run id>`, response rules) and writes ADK's event itself, so progress lines come from the event. The caller passes `resolveTool`, and `toolNodeRunner(context, next)` composes with the other runners.

**Instead of:** importing the registry, stamping node events in the scheduler, a progress callback, reusing the agent loop's call runner

How it works: [Workflow scheduler](/overview/workflow-scheduler.md)
