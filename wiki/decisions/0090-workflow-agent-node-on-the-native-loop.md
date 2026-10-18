---
type: decision
title: "ADR 0090: A workflow agent node runs on the native loop with a stamp hook"
description: "A workflow agent node is a native loop run whose events a nodeStamp hook stamps before storage, the route step stores ADK's event, and route derivation is one shared function."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/route.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/workflowConfig.ts
  - resource: tests/workflowAgentNode.test.ts
---

# ADR 0090: A workflow agent node runs on the native loop with a stamp hook

**Decided (2026-10-08):** `lib/workflow/agentNode.ts` runs an agent node as ADK's `runLlmAgentAsNode` did, and a `nodeStamp` loop hook writes output, node path and `outputFor` onto each event before it is stored. The route step's event is stored as ADK stored it, runners compose in a chain, and `routeOf` (`lib/workflow/route.ts`) routes JSON text without an output schema as text.

**Instead of:** stamping after storage, rewriting stored events, leaving route steps unstored, parsing JSON text for routing

**Superseded by:** [ADR 0093](/decisions/0093-workflow-parity-placeholders-join-map-events-compaction.md) (placeholders, join and map events), [ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md) (approval pauses in an agent node)

**Open:** an `ask_user` tool call inside an agent node

How it works: [Workflow agent node](/overview/workflow-agent-node.md)
