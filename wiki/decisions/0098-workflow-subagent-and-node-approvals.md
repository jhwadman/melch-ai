---
type: decision
title: "ADR 0098: Nested workflows run whole as subagent tools; approval gates pause workflow nodes"
description: "A delegated yaml_reference to a workflow syndicate runs its whole graph as one subagent tool on a child session, and require_approval on a workflow node's agent pauses the node and the walk until the decision resumes the node's own run."
tags:
  - decision
  - runtime
  - agents
  - security
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/compile.ts
  - resource: lib/compileAdk.ts
  - resource: lib/compileNative.ts
  - resource: lib/workflow.ts
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflow/resume.ts
  - resource: lib/runtime/approvals.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/workflow/graph.ts
  - resource: tests/workflowSubagent.test.ts
  - resource: tests/workflowApprovals.test.ts
---

# ADR 0098: Nested workflows run whole as subagent tools; approval gates pause workflow nodes

**Decided (2026-10-08):** A delegated workflow syndicate is one subagent tool that walks its whole graph on the child session. An approval gate on a workflow node's agent pauses the node and the walk; the decision resumes that node's own run, which runs or refuses the pinned call once, and any other message repeats the request.

**Instead of:** wrapping the Workflow in an engine tool on ADK, keeping the nested orchestrator alone, resuming ADK's way (node afresh, pinned call lost), lifting the gate on both runtimes, refusing or walking on with a non-decision message
**Superseded by:** [ADR 0106](/decisions/0106-nested-workflow-routes-nodes-and-node-skill-scripts.md) (routes, nodes and skill scripts), [ADR 0111](/decisions/0111-pauses-inside-nested-syndicates.md) (pauses inside a delegated nested workflow), [ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md) (pauses inside nested routes and nodes)
**Open:** an approval gate on an agent a map node runs (refused)

How it works: [Workflow scheduler](/overview/workflow-scheduler.md)
