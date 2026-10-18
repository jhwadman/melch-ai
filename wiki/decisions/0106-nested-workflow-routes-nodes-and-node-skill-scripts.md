---
type: decision
title: "ADR 0106: Nested workflows run whole as routes and nodes; skill scripts pause workflow nodes"
description: "A yaml_reference to a workflow syndicate runs its whole graph wherever it appears, as a dispatch route or a workflow node, on its own child session with its own node-run ceiling, and skill scripts pause a workflow node on the approval."
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
  - resource: lib/compileNative.ts
  - resource: lib/workflow.ts
  - resource: lib/workflow/turn.ts
  - resource: lib/workflow/agentNode.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/workflow/graph.ts
  - resource: tests/workflowNested.test.ts
  - resource: tests/workflowSkillScripts.test.ts
---

# ADR 0106: Nested workflows run whole as routes and nodes; skill scripts pause workflow nodes

**Decided (2026-10-08):** Compile every `yaml_reference` to a workflow syndicate through one path (`compileEntrySpec`) so it runs its whole graph wherever it appears, each as its own walk on its own child session under its own node-run ceiling. Skill scripts are allowed on a workflow node's agent and pause the node on the same approval as `require_approval`.

**Instead of:** running the nested graph inline (ADK's form), a FunctionNode wrapper on ADK, walking a route in the conversation's own session, keeping the orchestrator alone, one shared node-run ceiling, keeping skill scripts refused
**Superseded by:** [ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md) (pauses in nested routes and nodes; child session key), [ADR 0120](/decisions/0120-nested-dispatch-syndicates-route-as-at-the-top.md) (child session key carries its kind)
**Open:** a gate or skill scripts on an agent a map runs; remote (A2A) agents as workflow nodes

How it works: [Workflow scheduler](/overview/workflow-scheduler.md)
