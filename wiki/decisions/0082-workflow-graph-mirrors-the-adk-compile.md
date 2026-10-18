---
type: decision
title: "ADR 0082: The workflow graph is the engine's own model, mirroring ADK's compile"
description: "A workflow block builds into the engine's own WorkflowGraph, named and ordered as ADK's compile did, validated by its own copy of the schema's and ADK's graph rules."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow/graph.ts
  - resource: lib/workflow.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/workflowGraph.test.ts
---

# ADR 0082: The workflow graph is the engine's own model, mirroring ADK's compile

**Decided (2026-10-08):** `lib/workflow/graph.ts` builds the graph with no ADK import, mirroring ADK's compile (`__START__`, `<node>__route`, node and edge order) so ADK-written node paths still resolve. Routing-map keys stay as written, and validation is the module's own copy of the schema's and ADK's graph rules, held to them by a parity test.

**Instead of:** moving the schema's rules into the module, naming the start node START, normalizing route keys, deriving the model from ADK's Graph

**Superseded by:** [ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md) (routes match in ADK's spelling, not as written)

**Open:** workflow rules kept in two copies (schema and graph.ts); graph pass runs at compile time, not load time

How it works: [Workflow graph](/overview/workflow-graph.md)
