---
type: decision
title: "ADR 0093: A native workflow node fills ADK's workflow placeholders, joins and maps store ADK's events, and a node's compaction is stamped"
description: "Four parity gaps close before native workflows go live. injectSessionState takes ADK 2.2's workflow instruction scope (the node's input and the outputs stored so far) and fills {x.field} and <x.field from Node> as ADK does, with linear hand scanners in place of ADK's patterns. lib/workflow/nodeEvents.ts builds ADK's JoinNode event and the event BaseNode.toEvent makes of a map's list, stored by agentNodeRuntime on the scheduler's node_end; an aborted map outputs nothing. Concurrent fan-out already stores in ADK's order and is pinned with delays 20 ms apart. A node agent's compaction event passes through nodeStamp. Running ADK's regular expressions, filling placeholders in compileNative, emitting join and map events from the scheduler, stamping the compaction through the whole beforeStore hook, and pinning same-instant races were rejected."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/request.ts
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/nodeEvents.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: tests/workflowParity.test.ts
---

# ADR 0093: A native workflow node fills ADK's workflow placeholders, joins and maps store ADK's events, and a node's compaction is stamped

## Context

[ADR 0090](/decisions/0090-workflow-agent-node-on-the-native-loop.md) put agent nodes on the native loop and left four differences from ADK open. [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)'s gate G4 needs the workflow suite on native, and a session one runtime writes must be one the other continues, so they close before WS4-6 lifts the native refusal. Running each case on ADK 2.2 with the same scripted models showed what ADK does:

1. **Placeholders.** `runLlmAgentAsNode` clones the invocation context with a `workflowInstructionScope`: the node's input, and `collectPredecessorOutputs`, the output of every event of the invocation keyed by the last segment of its node path without the run suffix. `injectSessionState` then fills `{x.field}` (any identifier, a dot, an identifier) from the input when it is an object holding the field, `''` when optional, else leaves the key's first spelling; and `<x.field from Node>` from that node's object output, else leaves it.
2. **Join and map events.** A `JoinNode` stores one event with the joined object as its output and no content. A `ParallelWorker` yields its result list as a plain value, which `BaseNode.toEvent` turns into an event whose content is `toContent(list)`: genai's `createModelContent` of the list, or one text part of its JSON when that throws. No item has a wrapper event. An aborted worker yields nothing.
3. **Order.** With join and map events stored, branches running at once land in ADK's order whenever their finish times are apart. Finishes in the same instant land in an order set by how many awaits each runtime's pipeline takes.
4. **Compaction.** ADK's compactor yields its event through the agent's run, so the node runner stamps it and `maybeSetOutput` gives it the summary as output, outside task mode.

## Decision

1. **The scope is a request option, filled by a port of ADK's function.** `RequestContext.workflowScope` (and `ModelStepOptions.workflowScope`, so the loop passes it) carries `{ input, outputsByNode }`. `runAgentNode` builds it once, after storing the node's input, with `predecessorOutputs`, the port of `collectPredecessorOutputs`. `injectSessionState(template, state, scope?)` resolves keys in ADK's order (artifact, state, workflow field) and merges both kinds of placeholder in template order as ADK does. The `<x.field from Node>` scanner is a hand parser: each token of ADK's pattern is set by the next character, so it takes the same matches, and an attempt from a `<` cannot pass the next `<`, so the scan is linear. A delegated subagent's loop gets no scope, as an `AgentTool` run has none on ADK.
2. **Join and map events are built beside the route step's.** `lib/workflow/nodeEvents.ts` holds `joinNodeEvent`, `mapNodeEvent` and `nodeOutputContent` (ADK's `toContent` with genai's `_toParts`), stamped through `enrichNodeEvent`. `agentNodeRuntime.onEvent` stores them on the node's `node_end`, on the queue that keeps them before the successor's input. The scheduler changes in one place: `runMap` returns no output once its signal aborted.
3. **Order is pinned where it is defined.** The parity suite runs three branches at once (an agent calling a tool and routing on, a tool node, a map) under three delay profiles whose finish times are at least 20 ms apart, and a node two branches trigger. No code changes for it.
4. **The compaction event passes through `nodeStamp` only.** The loop calls `ctx.nodeStamp` on it before it stores it. The outputKey, task and temp-state hooks do not see it, as ADK's `LlmAgent` output saving skips an event another author wrote.

## Alternatives considered

- **Run ADK's regular expressions.** The port would be shorter, but CodeQL's js/polynomial-redos has fired twice on this plan, and the instruction can be long. The hand scanners are compared with ADK's function on a corpus of templates in the test suite, so they cannot drift unseen.
- **Fill workflow placeholders at compile time (`compileNative`).** The input and the outputs exist only when the node runs, and the same agent runs as several nodes and map items.
- **Emit join and map events from the scheduler.** The scheduler hands back outputs, not events (ADR 0087), and the route step's event is already stored by the agent node runtime. One place builds every event of a node the scheduler runs itself.
- **Stamp the compaction through the loop's whole `beforeStore`.** That would also hand it to the outputKey, task and temp-state hooks. Each ignores it today (it is authored `system` and carries no call or state), but on ADK only the node runner and `maybeSetOutput` see it, and the loop keeps to that.
- **Pin same-instant races.** Matching ADK there means matching its await depth, which neither runtime promises. A real model call does not finish in the same instant as another.

## Consequences

- `tests/workflowParity.test.ts` holds the four cases against ADK, through the harness `tests/helpers/workflowParity.ts`, which drops a compaction's span from the comparison after checking it covers stored events.
- A summary becomes a node's output until the node's answer replaces it, on both runtimes: a node whose step fails after a compaction ends with the summary as its output.
- The modules are internal: not in the `exports` map or the `lib/index.ts` barrel. The native refusal stays until WS4-6.
