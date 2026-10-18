---
type: decision
title: "ADR 0120: Nested dispatch syndicates route as at the top, as their own turn"
description: "A nested dispatch syndicate classifies and routes as a turn of its own under the caller's turn control, and route and node child-session keys carry their kind."
tags:
  - decision
  - runtime
  - protocols
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/compile.ts
  - resource: lib/compileNative.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/turnControl.ts
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: lib/workflow/turn.ts
  - resource: lib/a2a/executor.ts
  - resource: tests/nestedDispatch.test.ts
  - resource: tests/delegatedScriptsConsent.test.ts
  - resource: tests/workflowChildPauses.test.ts
  - resource: tests/workflowNested.test.ts
---

# ADR 0120: Nested dispatch syndicates route as at the top, as their own turn

**Decided (2026-10-09):** A `yaml_reference` to a dispatch syndicate runs as a turn of its own under the caller's turn control (one step budget, deadline and signal), so its caller gets the route's answer, never the classifier's JSON, and its routes' pauses reach the turn with the path. Route and node child sessions are keyed `<app>/route:<route>` and `<app>/node:<node>`.

**Instead of:** a synthesized workflow graph, recursing through the public `runSyndicateTurn`, a stored marker for the walker, a kind segment of its own (`route/X`), prefixing delegation keys, migrating stored rows
**Supersedes:** [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md) (decision 2, a nested dispatch syndicate as its classifier alone, and the refusal of gates on its routes); [ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md) (decision 2's `<app>/<entry>` key)
**Open:** an approval or question inside a workflow node's own delegation; a remote route inside a nested dispatch syndicate shares its remote conversation id with a same-named remote route at the top

How it works: [Native loop](/overview/native-loop.md)
