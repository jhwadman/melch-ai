---
type: decision
title: "ADR 0128: OAuth consent inside a workflow node is an interrupt of the walk"
description: "An OAuth consent pause inside a workflow node is an interrupt of the walk, raised again from below under the request's own id and resumed by the grant's answer."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/turn.ts
  - resource: lib/workflow/resume.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/credentials.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/compileNative.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/workflowNodeConsent.test.ts
  - resource: tests/workflowResume.test.ts
---

# ADR 0128: OAuth consent inside a workflow node is an interrupt of the walk

**Decided (2026-10-11):** Workflow node agents get the turn's consent step pinned to the turn's app; a node's consent request, or one from below raised again under its own id, pauses the walk, and once every grant is stored the next message resumes each waiting node without rerunning completed ones. Map items get no consent step, and an `authorization_code` grant on an agent a map runs is refused at load.

**Instead of:** refusing consent in nodes, asking for every grant before the walk, a marker of its own for a raised request, reading plain text as a grant, pausing one map item, answering only the first open request
**Open:** an approval or question inside a workflow node's own delegation; a tool node that needs a grant; resuming a durable run with a grant

How it works: [Workflow scheduler](/overview/workflow-scheduler.md)
