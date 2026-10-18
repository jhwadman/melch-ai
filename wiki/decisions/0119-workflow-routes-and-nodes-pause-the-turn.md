---
type: decision
title: "ADR 0119: Nested workflows as a dispatch route or workflow node pause the turn"
description: "A nested workflow run as a dispatch route or a workflow node may pause the turn, and its child session is filed under the agent path."
tags:
  - decision
  - runtime
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow/turn.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/approvals.ts
  - resource: lib/compile.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/workflowChildPauses.test.ts
  - resource: tests/workflowNested.test.ts
  - resource: tests/nestedPauses.test.ts
---

# ADR 0119: Nested workflows as a dispatch route or workflow node pause the turn

**Decided (2026-10-09):** A nested workflow's `ask_user` nodes and gates are allowed as a dispatch route or a workflow node: a route's pause is a pause record stored in the conversation, resumed without classifying; a node's pause raises the walk's requests again on the caller's walk under the same ids. Its child session is filed under the agent path, with old keys still read in place.

**Instead of:** scanning routes' sessions instead of a route pause record, a contentless marker for a node, running the nested graph inline, keying a route under the classifier's name, migrating old sessions
**Supersedes:** [ADR 0106](/decisions/0106-nested-workflow-routes-nodes-and-node-skill-scripts.md) (child session filed under the entry's name alone)
**Superseded by:** [ADR 0120](/decisions/0120-nested-dispatch-syndicates-route-as-at-the-top.md) (session keys gain the kind, `route:` / `node:`)
**Open:** an approval or question inside a workflow node's own delegation

How it works: [Workflow scheduler](/overview/workflow-scheduler.md)
