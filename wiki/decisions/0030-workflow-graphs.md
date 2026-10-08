---
type: decision
title: 'ADR 0030: A syndicate can be a graph: the `workflow:` block, on ADK''s Workflow, is the third orchestration method'
description: A `workflow:` block makes a syndicate's agents the nodes of a graph and its `edges` the order they run in, with fan-out, fan-in, routing on an agent's output, per-node retries and timeouts, and a pause that waits for the person; the engine supplies the routing step ADK's TypeScript port lacks, keeps YAML names on every node, and makes a pause hand on both the reply and what was asked about.
tags:
  - decision
  - agents
  - runtime
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-02
sources:
  - resource: lib/workflow.ts
  - resource: lib/workflowConfig.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: config/agents/examples/pipeline.yaml
  - resource: tests/workflow.test.ts
---

# ADR 0030: A syndicate can be a graph

## Context

Two orchestration methods existed. DELEGATE: an orchestrator calls its subagents as tools and relays the answer. PLAN-DISPATCH ([lib/dispatch.ts](/agents/index.md)): a tool-less classifier names one subagent, and code runs it. Neither can state "run these two at once, join what they produce, edit it, ask the person, then publish". The owner's audit of what ADK 2.2 ships and the framework does not use put a graph first: it is the feature that makes "a whole agent system is one readable YAML file" true for a pipeline, and ADK has deprecated its `SequentialAgent`, `ParallelAgent` and `LoopAgent` in favour of its new `Workflow` module (edges, routing, `JoinNode`, `ParallelWorker`, `ToolNode`, per-node `RetryConfig` and `timeout`, `RequestInput` pauses, resumption from session events).

Three facts, found by running ADK rather than reading it, shaped the design:

- **An `LlmAgent` is already a node** (`LlmAgent extends BaseNode`), takes `retryConfig` and `timeout` at construction, receives the previous node's output as a user turn, and unless `includeContents` was set explicitly sees nothing else of the session.
- **The TypeScript port never derives a route from an agent's output.** A routing map in a graph fires only on `event.route`, which no agent event carries. Only a `FunctionNode` can emit one.
- **A pause resumes on the next plain-text message.** `Runner.runAsync` with a `Workflow` root rehydrates the paused run from the session's events; a text message resolves the single pending `adk_request_input`; a node that does not re-run on resume outputs the bare reply.

## Decision

1. **One root key, `workflow:`**, with `edges` (chains of names: `START`, agents, declared nodes, lists for fan-out and fan-in, a map `{ route: target, default: target }` to end a chain), `nodes` (what is not an agent, exactly one of `join`, `map`, `tool`, `ask_user`; or modifiers on an agent: `route_key`, `retry`, `timeout`) and `max_concurrency`. The orchestrator is a node like any other. The block cannot be combined with `dispatch`.
2. **Every agent compiles as it does in any mode** (`compileSubagent`: its tools, skills, MCP server), with its node modifiers passed at construction through a new `CompileOptions.nodeConfig`. `compileGraph` refuses a workflow syndicate; `compileWorkflow` ([lib/workflow.ts](/overview/architecture.md)) builds the `Workflow`.
3. **Routing is a hidden step.** A map after a node compiles to a `FunctionNode` named `<Node>__route` that re-emits the output with `route` set to the `route_key` property of a JSON output, else the trimmed text. `default` maps to ADK's `DEFAULT_ROUTE`. The suffix is reserved.
4. **YAML names are the node names everywhere**, including a `map` node, which ADK names after the agent it wraps; the engine renames the worker. Progress lines name declared nodes only, never the root or a route step.
5. **The pause carries its context.** `ask_user` is a `FunctionNode` with `rerunOnResume`: first run, it raises `RequestInput` with the question and the input as payload; on resume it outputs `{ reply, input }`, so the next agent sees both the answer and the draft it concerns. The turn ends `input-required` with `result.input`; the A2A server publishes an `input_request` data part; the chat prints the question and takes the next line.
6. **A node's error is not the turn's.** The drain gains an error policy: in a workflow, an event carrying an error is recorded (`answer.nodeErrors`) and reading continues, because a node with `retry` emits its failed attempt and tries again; a node that gives up ends the stream, and the turn fails `NODE_FAILED` naming it.
7. **Pauses the graph cannot carry yet are refused by the schema**: `require_approval`, `skills.scripts: local` and remote `a2a_agent_url` subagents inside a workflow. A gated call would pause a node through ADK's interrupt path, whose resume is not the one [ADR 0028](/decisions/0028-approval-gates.md) built; a remote agent is reachable only as a tool. A `yaml_reference` to a workflow syndicate compiles its orchestrator alone, since ADK cannot yet make a `Workflow` a subagent.

## Alternatives considered

- **Sequential, Parallel and Loop agents.** ADK marks all three deprecated in favour of `Workflow`. Building on them would have shipped a surface its runtime is removing.
- **Routing in the agent's output schema** (an `outputSchema` whose `route` field ADK reads). ADK's TypeScript port does not do this; a route step the engine owns works with any output, text included.
- **Fast-forward the pause** (ADK's default, no rerun). The next agent would receive only "yes", never the draft; a workflow that asks about something must hand on the something.
- **Project the session for nodes** (as plan-dispatch does with `ProjectedSessionService`). Unneeded: a node agent reads only its input by default, and an author who sets `includeContents` asked for the raw history.

## Consequences

- A pipeline is one readable file: `config/agents/examples/pipeline.yaml` routes on a JSON field, fans out to a writer and a checker, joins, edits with a retry, asks the person, and publishes. Live on Gemini: the fan-out runs concurrently; the article path spends four model calls to the pause and one after it.
- The session accumulates node inputs as user turns, so `memory_system: long-term` would ingest them; `internal-only` is the sensible default for a workflow.
- One `ask_user` pause at a time per turn: a text reply resolves the single pending request, and the rerun node reads the latest resolved answer.
- ADK logs `Class Workflow is experimental` once per process. The surface used is the public index (`Workflow`, `FunctionNode`, `JoinNode`, `ParallelWorker`, `ToolNode`, `RequestInput`, `createEvent`); the TypeScript port is explicitly phased upstream, so `tests/workflow.test.ts` is the boundary suite an ADK upgrade is held to.
- Open for a later record: approvals and skill scripts inside a workflow (an interrupt-based resume), remote agents as nodes (a `ToolNode` over the remote tool), a workflow as another syndicate's subagent when ADK allows it, and `context: fork`-style isolation scopes.

> **Note (2026-10-08):** Both refusals in Decision 7's last sentences are lifted. A delegated `yaml_reference` to a workflow syndicate runs its whole graph as the subagent tool, on ADK inside ADK's own `AgentTool`, which does run a `Workflow`. An approval gate on a workflow node's agent pauses the node, and the native walk resumes it on the person's decision. ADK cannot resume it, so a gated workflow is refused on ADK. See [ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md).
