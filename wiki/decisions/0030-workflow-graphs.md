---
type: decision
title: "ADR 0030: A syndicate can be a graph: the workflow: block"
description: "A workflow: block is the third orchestration method: agents are nodes, edges give the order, with fan-out, fan-in, routing on output, per-node retries and timeouts, and pauses for the person."
tags:
  - decision
  - agents
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow.ts
  - resource: lib/workflowConfig.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: config/agents/examples/pipeline.yaml
  - resource: tests/workflow.test.ts
---

# ADR 0030: A syndicate can be a graph: the workflow: block

**Decided (2026-10-02):** A `workflow:` block is the third orchestration method, beside delegate and plan-dispatch. A syndicate's agents become the nodes of a graph whose `edges` give their order, with fan-out and fan-in, routing on an agent's output, per-node retry and timeout, and `ask_user` pauses that hand on both the reply and what was asked about. YAML names are the node names everywhere.

**Instead of:** ADK's Sequential, Parallel and Loop agents, routing in the output schema, fast-forwarding the pause, projecting the session for nodes
**Superseded by:** [ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md) and [ADR 0095](/decisions/0095-native-workflow-turn-drains-through-the-adk-reader.md) (the engine's own scheduler replaces ADK's Workflow), [ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md) (a workflow syndicate as a subagent; approvals on nodes), [ADR 0106](/decisions/0106-nested-workflow-routes-nodes-and-node-skill-scripts.md) and [ADR 0119](/decisions/0119-workflow-routes-and-nodes-pause-the-turn.md) (nested workflows as routes and nodes, and their pauses)
**Open:** remote (`a2a_agent_url`) agents as workflow nodes; `context: fork`-style isolation scopes

How it works: [Workflow graph](/overview/workflow-graph.md)
