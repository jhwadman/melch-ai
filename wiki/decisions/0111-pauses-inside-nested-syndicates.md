---
type: decision
title: "ADR 0111: Pauses inside nested syndicates reach the turn; subagent sessions keyed by agent path"
description: "Gates and questions inside nested syndicates pause the turn, a delegated nested workflow pauses through its open call and resumes by its own resume, and a subagent's child session is filed under its agent path."
tags:
  - decision
  - runtime
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/nestedPauses.test.ts
  - resource: tests/delegatedPauses.test.ts
  - resource: tests/nativeDelegate.test.ts
---

# ADR 0111: Pauses inside nested syndicates reach the turn; subagent sessions keyed by agent path

**Decided (2026-10-09):** Carry ADR 0110's pauses through `yaml_reference`: a nested delegate syndicate's gates and questions, and a delegated nested workflow's ask_user nodes and gated nodes, pause the turn. A subagent's child session is filed under its agent path (`childAppName`); a session under the old key is still continued when the caller used it.

**Instead of:** carrying route and node pauses in the same change, a pause marker in the caller's session, keying by syndicate and subagent name, migrating old sessions
**Superseded by:** [ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md) (decision 4: route and node pauses), [ADR 0120](/decisions/0120-nested-dispatch-syndicates-route-as-at-the-top.md) (decision 2: nested dispatch syndicates)
**Open:** an approval or question inside a workflow node's own delegation

How it works: [Native loop: a pause inside a subagent](/overview/native-loop.md#a-pause-inside-a-subagent)
