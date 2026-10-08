---
type: decision
title: "ADR 0082: The workflow graph is the engine's own model, mirrors the ADK compile, and carries its own copy of the block's rules"
description: "lib/workflow/graph.ts builds a workflow: block into typed nodes and routed edges with no ADK import, as the model the native scheduler will run. It names nodes as the ADK compile does (__START__, <node>__route), orders nodes and edges as ADK's Graph does, keeps routing-map keys as written, and validates with its own copy of the schema's workflow rules and of ADK's graph rules, with their messages, held to both by a parity test. Moving the schema's rules into the module, naming the start node START, and normalizing route keys as ADK does were rejected."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/graph.ts
  - resource: lib/workflow.ts
  - resource: lib/syndicateSchema.ts
  - resource: tests/workflowGraph.test.ts
---

# ADR 0082: The workflow graph is the engine's own model, mirrors the ADK compile, and carries its own copy of the block's rules

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) moves the workflow engine off ADK in stages, and gate G4 requires the workflow suite to pass under `native`. Today a `workflow:` block ([ADR 0030](/decisions/0030-workflow-graphs.md)) has two owners and no model of its own:

- `validateSyndicateConfig` (`lib/syndicateSchema.ts`, `workflowProblems`) checks the block's cross-field rules.
- `compileWorkflow` (`lib/workflow.ts`) turns the chains into ADK node objects and ADK chain syntax. ADK's `Workflow` then parses that into its `Graph` and validates it: reachability, duplicate edges, default routes, unconditional cycles.

The graph a scheduler runs exists only inside ADK's `Workflow`. The native scheduler (WS4-2a) needs that graph without ADK, and it must be the same graph, so that a workflow behaves the same on both runtimes and a workflow paused under `adk` can resume under `native`.

## Decision

1. **`lib/workflow/graph.ts` is the graph, with no ADK import.** `buildWorkflowGraph(config)` returns typed nodes (`start`, `agent`, `join`, `map`, `tool`, `ask_user`, `route`), edges whose `route` is `always`, a `key` or `default`, `maxConcurrency`, the terminal nodes and the syndicate's agents. Nothing runs it yet. The ADK path does not change: `compileWorkflow` keeps building ADK's graph from the YAML.
2. **It mirrors the ADK compile, name for name and in order.** The start node is `__START__` (`START_NODE`) and a route step is `<node>__route`, as ADK names them. One route step serves every routing map after the same node. Nodes are in order of first appearance in the edges, and edges in chain order with the cross product of each list. A node path that ADK wrote into a stored workflow event names the same node in the model.
3. **Routing-map keys stay as written.** ADK stores `1` as a number and `true` as a boolean and compares routes as strings, so `01` and `1` are one route there. The model keeps `{ kind: 'key', key: '01' }`. Only the duplicate-edge rule uses ADK's spelling, so it refuses what ADK refuses, with ADK's message.
4. **Validation is the module's own copy, held to the originals by a test.** `workflowConfigProblems` repeats the schema's workflow rules with their paths, messages and order. The graph pass repeats ADK's `validateGraph` checks, and the empty-routing-map check from ADK's parser, with ADK's messages, first problem only. `tests/workflowGraph.test.ts` asserts that every fixture builds ADK's node and edge set, and that every rule raises the same message from both paths. When a rule changes on either side, the test fails until the other side matches.

## Alternatives considered

- **Move the schema's `workflowProblems` into the module and have the schema call it.** That would leave one copy of the rules, and the schema's output would not change. But the schema would then import the workflow module, and `lib/syndicateSchema.ts` is a file several parallel tickets edit. WS2-7a, for one, works on approvals, and the approval-gate refusal is among these rules. The duplication is bounded by the parity test, and the move can follow once the parallel work has merged.
- **Name the start node `START`, as the YAML writes it.** That reads better, but it would differ from every node path ADK has stored. Resuming an ADK-written workflow under `native` is a stop rule in ADR 0045.
- **Normalize route keys as ADK does.** The model would then carry numbers and booleans for some keys, which is an ADK parser detail. The native scheduler compares the route an output names with the key as written. The duplicate-edge rule keeps the one place where ADK's spelling changes the outcome.
- **Derive the model from ADK's `Graph` after `compileWorkflow`.** The model would match by construction, but it would need ADK to build, which defeats the purpose.

## Consequences

- WS4-2a schedules `WorkflowGraph` directly. The kinds, settings and route steps are the ones ADK runs today, so the semantics the workflow suite pins carry over.
- A change to a workflow rule touches three places: the schema, `lib/workflow/graph.ts` and, for a graph rule, the ADK version the test runs against. The parity test names the case that differs.
- Five graphs pass the schema but fail the graph pass, on both runtimes: an unreachable node, an unconditional cycle, a repeated edge, `default` mapped to a list, and one node followed by routing maps in two chains. They fail at compile time, not at load time. Moving the graph pass into load-time validation is a separate change, since it would make `loadSyndicate` refuse files it accepts today.
- The module is internal. It is not in the `exports` map or the `lib/index.ts` barrel, so the package surface does not change.
