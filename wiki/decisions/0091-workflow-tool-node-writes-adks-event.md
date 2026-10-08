---
type: decision
title: "ADR 0091: A workflow tool node runs its tool as ADK's ToolNode does, writes ADK's event itself, and takes the registry from its caller"
description: "lib/workflow/toolNode.ts runs a tool: node on the engine's own runtime: ADK's input coercion, one call with the id <node path>:<run id>, handleFunctionCallList's response rules, and one event built and enriched as ADK's node runner enriches it, handed to the caller before the run resolves, so the turn runner's reader prints the same progress lines. The tool is resolved by a function the caller passes, so nothing in the module's import graph reaches ADK. Importing the registry, stamping node events in the scheduler, a progress callback of its own, and reusing the agent loop's call runner were rejected."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/toolNode.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: tests/workflowToolNode.test.ts
---

# ADR 0091: A workflow tool node runs its tool as ADK's ToolNode does, writes ADK's event itself, and takes the registry from its caller

## Context

[ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md) left agent, tool and ask_user nodes to a runner the caller passes the scheduler. WS4-5 supplies the runner for `tool:` nodes. A tool node ([ADR 0030](/decisions/0030-workflow-graphs.md)) runs a registry tool once, with the previous node's output as its arguments. On the ADK runtime it is ADK 2.2's `ToolNode`. Gate G4 of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) needs the same behaviour without ADK, and the stored event JSON is one of the shapes ADR 0045 fixes.

Running ADK's `ToolNode` with stub agents showed what has to match:

- **The input.** A content's text, a string parsed as JSON when it parses, a blank string or nothing as `{}`. A list, a number or text that is not JSON throws a `TypeError` and fails the node.
- **The call.** Its id is `<node path>:<run id>` (`Graph.Lookup:1`). A throw becomes `{ error: <message> }`, and the walk goes on. A result that is not an object becomes `{ result }`, a list `{ results }`.
- **The event.** One `user` event holding the function response, authored by the node's YAML name, with the call's state writes in its actions, the response as `output`, and `nodeInfo { path, outputFor }` that ADK's node runner adds.
- **The progress.** The turn runner prints a node's progress from the events it drains (`drainAgentStream`): `⇢ Node: Lookup`, then `← Result: <tool> — <n> chars`, with `Running node: Lookup` to `onProgress`. Nothing else prints it.

## Decision

1. **`runToolNode` is ADK's ToolNode for one run, with no ADK import.** `coerceToolArgs` is ADK's coercion, with its message. The call follows `handleFunctionCallList` for a single call. An own Tool runs as `FunctionTool` runs the Tool `toFunctionTool` wraps: its approval gate, then `execute`, with a throw named for the tool. Any other registered tool runs through its `runAsync`. A long-running tool is refused with ADK's message, and an unregistered one with the compile's.
2. **The tool node writes its own event, ADK's, key for key.** It builds the event with `createTurnEvent` as ADK's `createEvent` builds it, then applies `enrichNodeEvent`, a port of ADK's node runner `enrichEvent`. It hands the event to the caller's `onEvent` before the run resolves. Its output is the response object.
3. **The caller resolves the tool.** `ToolNodeContext.resolveTool` maps the YAML name to the registry entry. The registry builds ADK's FunctionTools, so importing it would put ADK in the module's import graph. The turn runner passes the registry's lookup.
4. **Progress comes from the event, not a callback.** The events go through the same reader as ADK's (`drainAgentStream`), so the lines are identical by construction.
5. **`toolNodeRunner(context, next)` composes.** It runs tool nodes and hands every other run to `next`, so the agent and ask_user runners (WS4-3, WS4-4a) chain without one knowing the others.

## Alternatives considered

- **Import the registry in `toolNode.ts`.** That is one less parameter, but `lib/toolRegistry.ts` imports `lib/tools/adkTool.ts`, so the native workflow path would reach ADK. That would break the no-ADK-import test every workflow module carries.
- **Stamp `nodeInfo`, the author and the branch on every event in the scheduler.** ADK does this in its node runner, for every node kind. But the scheduler hands back an output and a route, not events (ADR 0087 decision 4), and changing its result type is WS4-2b's file. `enrichNodeEvent` is exported, so the agent node can call it, and it can move into the scheduler once the parallel tickets have merged.
- **A progress callback on the tool node.** That would be a second source for the lines, which could drift from the one that prints them on ADK.
- **Reuse the agent loop's `runCall`** (`lib/runtime/native/agentLoop.ts`). It does the same normalization, but it needs an agent, the loop's context and the self-correction queue, none of which a workflow node has. Its rules for one call are a dozen lines, held to ADK by the parity test.

## Consequences

- `tests/workflowToolNode.test.ts` runs the tool-node case of `tests/workflow.test.ts` on ADK (the real `compileWorkflow` with stub agents) and on the scheduler with `toolNodeRunner`. It also runs input mapping, a throwing tool, an own Tool on a branch of its own, a gated tool and the refusals. Each case compares every event as stored (apart from its id, time and invocation id), every node's output, path and branch, the workflow's output, and the drained log and progress lines.
- A node-error event for a node that throws (`isNodeError`, ADK's `errorCode` and attempt count), retries and timeouts are the scheduler's (WS4-2b). The tool node throws ADK's error and the scheduler rethrows it.
- The native runtime still refuses a workflow syndicate. Lifting the refusal is WS4-6. The module is internal: it is not in the `exports` map or the barrel.
