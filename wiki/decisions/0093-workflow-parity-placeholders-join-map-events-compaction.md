---
type: decision
title: "ADR 0093: Native workflow nodes match ADK's placeholders, join and map events, and compaction stamp"
description: "A native workflow node fills ADK's workflow placeholders with hand scanners, the agent node runtime stores ADK's join and map events, a node's input turn is queued ahead of concurrent yields, and a node's compaction is stamped through nodeStamp only."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/native/request.ts
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/nodeEvents.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: tests/workflowParity.test.ts
---

# ADR 0093: Native workflow nodes match ADK's placeholders, join and map events, and compaction stamp

**Decided (2026-10-08):** Close the four remaining parity gaps before native workflows go live: fill `{x.field}` and `<x.field from Node>` with linear hand scanners ported from ADK, build join and map events beside the route step's in the agent node runtime, queue a node's input turn as it starts (ahead of another runner's event), and pass a node's compaction event through `nodeStamp` alone.

**Instead of:** ADK's regular expressions (ReDoS risk), filling placeholders at compile time, emitting join and map events from the scheduler, stamping the compaction through the whole beforeStore hook, pinning same-instant races, storing a node's input only after the queue drains
**Supersedes:** [ADR 0090](/decisions/0090-workflow-agent-node-on-the-native-loop.md) (storing a node's input only after the queue drains)

How it works: [Workflow agent node](/overview/workflow-agent-node.md)
