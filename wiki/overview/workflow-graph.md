---
type: subsystem
title: Workflow graph
description: "The engine-owned model of a workflow: block (lib/workflow/graph.ts): buildWorkflowGraph turns the YAML chains into typed nodes (start, agent, join, map, tool, ask_user, and the hidden route step), edges that fire always, on a route key or on the default route, and max_concurrency, with no ADK import. It is the graph compileWorkflow hands ADK's Workflow, node for node and edge for edge, and it raises the schema's messages for the block's rules and ADK's messages for the graph's. The engine's own scheduler (lib/workflow/scheduler.ts) runs it."
tags:
  - runtime
  - agents
  - overview
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/graph.ts
  - resource: lib/workflow.ts
  - resource: lib/workflowConfig.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/workflowGraph.test.ts
---

# Workflow graph

A `workflow:` block ([ADR 0030](/decisions/0030-workflow-graphs.md)) writes a graph as chains of names. `lib/workflow/graph.ts` turns those chains into the graph a scheduler runs, without ADK: `buildWorkflowGraph(config)` returns a `WorkflowGraph`. The ADK runtime still compiles the block with `compileWorkflow` (`lib/workflow.ts`) and runs ADK's `Workflow`; the [workflow scheduler](/overview/workflow-scheduler.md) runs this graph without ADK, which is how the native runtime runs a workflow syndicate ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md), [ADR 0095](/decisions/0095-native-workflow-turn-drains-through-the-adk-reader.md)). Why the model mirrors the ADK compile, and where it does not, is [ADR 0082](/decisions/0082-workflow-graph-mirrors-the-adk-compile.md).

## The model

| field | holds |
|---|---|
| `name` | the syndicate's name, which names the workflow |
| `nodes` | every node by name, in order of first appearance in `edges`, the start node first |
| `edges` | `{ from, to, route }`, chain by chain and element pair by element pair |
| `maxConcurrency` | `max_concurrency`, when the block sets it |
| `terminals` | the nodes with no outgoing edge, whose output is the workflow's |
| `agents` | every agent the syndicate declares, orchestrator first, including one reached only through a map |

A node is one of seven kinds:

| kind | from | carries |
|---|---|---|
| `start` | `START` in a chain | its name, `__START__` (`START_NODE`), as the ADK compile names it |
| `agent` | the orchestrator or a subagent | `settings`: `retry` and `timeout` from its node entry |
| `join` | `join: true` | `settings` |
| `map` | `map: <agent>` | the agent run per item (not itself a graph node), `maxParallel`, `settings` (always empty: the schema refuses `retry` and `timeout` on a map entry, [ADR 0103](/decisions/0103-workflow-retry-spelling-and-signed-reflection-call.md)), and `agentSettings`, the mapped agent's own `retry` and `timeout`, which apply to each item |
| `tool` | `tool: <name>` | the registry tool's name, `settings` |
| `ask_user` | `ask_user: <question>` | the question, the reply's `schema`, `settings` |
| `route` | a routing map after a node | `<node>__route`, the `source` node, and the `routeKey` it reads (`route_key`, default `route`) |

An edge's `route` is `{ kind: 'always' }`, `{ kind: 'key', key }` with the routing map's key as written, or `{ kind: 'default' }` for the `default` key. A routing map compiles to an unconditional edge from the node to its route step, then one routed edge from the step to each target; one route step serves every map after the same node. A list is fan-out after one node and fan-in before one, so a chain element pair adds the cross product of its names.

## Validation

`buildWorkflowGraph` validates in two passes, each with the message today's path raises:

1. **The block's rules** (`workflowConfigProblems`), the same paths, messages and order as `validateSyndicateConfig` reports for a `workflow:` block: every name an agent or a declared node (with a did-you-mean), `START` opening a chain and nothing else, a routing map following the agent or tool node it routes and ending its chain, a declared node exactly one kind, an agent's entry carrying only `route_key`, `retry` and `timeout`, `schema` on `ask_user` only and `max_parallel` on `map` only, no `retry` or `timeout` on a `map` entry (the message names the mapped agent's entry, where they belong), a map's agent not also in an edge, every declared node used, `START` and the `__route` suffix reserved, no `dispatch` beside `workflow`, no approval gate on an agent a map runs, and no skill script or remote agent in a workflow yet. Every problem is reported at once in a `WorkflowGraphError`, whose message reads as the schema's does without a file.
2. **The graph's rules**, on the built edges, with the message ADK's graph validation throws from `compileWorkflow`, first problem only: no empty routing map, the start node present, without routed edges and without incoming edges, every node reachable from it, no duplicate edge, at most one `default` edge from a node, and no cycle of unconditional edges.

The schema's type checks (a chain of at least two elements, non-empty names) are not repeated, and whether a tool node's tool is registered is a compile-time question.

Some graphs pass the schema and fail the second pass, on either runtime: a node unreachable from `START`, a cycle with no routed edge, the same edge written twice, `default` mapped to a list (two `default` edges), and one node followed by routing maps in two chains (the shared route step's edge is written twice).

## Parity with the ADK compile

`tests/workflowGraph.test.ts` holds the two together. For every workflow block in `tests/workflow.test.ts`, every shipped syndicate with a `workflow:` block (`config/agents/examples/pipeline.yaml`), and shapes that suite does not exercise (a routed tool node, integer and boolean route keys, fan-out on a route, fan-in to fan-out, a routed loop back), the graph's node names and edges, in order with their routes, equal the `Graph` inside the `Workflow` that `compileWorkflow` builds. Every case of the schema's workflow rules and every graph rule above raises the same message from both. The test also walks the module's imports and finds no ADK value import.

ADK stores a routing-map key that spells an integer as a number, and `true` or `false` as a boolean, and compares routes as strings. So `01` and `1` are the same route on the ADK runtime. The model keeps the key as written; the duplicate-edge rule and its message use ADK's spelling (`adkRouteString`), so the same graphs are refused, and the scheduler matches an emitted route in the same spelling ([ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md)).
