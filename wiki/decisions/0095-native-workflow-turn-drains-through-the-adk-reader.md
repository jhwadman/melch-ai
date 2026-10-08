---
type: decision
title: "ADR 0095: A workflow turn on the native runtime is a stream of the walk's stored events, drained and traced as ADK's Runner stream is"
description: "runSyndicateTurn runs a workflow syndicate on native through lib/workflow/turn.ts: the message stored first, workflowResume on every message with the message's text as the walk's input, the scheduler with the ask_user, tool and agent runners chained under the turn's signal, ADK's node-error event and the workflow's pause record stored on the walk's queue, and every stored event but a node's input turn (and every partial) yielded to the same traceAgentRun and drainAgentStream ADK's Runner feeds. A resume only ADK can pick up fails the turn RESUME_UNSUPPORTED; an aborted walk ends quietly with the turn's stop reason; an agent node returns its reported error so the scheduler writes no second node-error event; a long-running or unregistered tool node and an ask_user tool on a node agent are refused before any model call. The walk opens workflow.invoke, node.execute and tool.execute spans through a traceNode hook, so each model call is attributed to its node's agent. Building the result outside the reader, resuming only when a question is pending, walking afresh on an unsupported pause, throwing it out of the turn, ADK's span names, spans from scheduler events, and lifting the schema's ask_user refusal were rejected."
tags:
  - decision
  - runtime
  - agents
  - observability
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/turn.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/nativeTurn.ts
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflow/agentNode.ts
  - resource: lib/workflow/toolNode.ts
  - resource: lib/runtime/native/telemetry.ts
  - resource: lib/compileNative.ts
  - resource: tests/workflow.test.ts
  - resource: tests/workflowParity.test.ts
  - resource: tests/nativeLedger.test.ts
  - resource: tests/sessionFixtures.test.ts
---

# ADR 0095: A workflow turn on the native runtime is a stream of the walk's stored events, drained and traced as ADK's Runner stream is

## Context

The WS4 tickets gave the engine every part of a workflow without ADK: the graph ([ADR 0082](/decisions/0082-workflow-graph-mirrors-the-adk-compile.md)), the walk and its controls ([ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md), [ADR 0089](/decisions/0089-workflow-scheduler-controls-follow-adks-node-runner.md)), agent, tool and ask_user nodes ([ADR 0090](/decisions/0090-workflow-agent-node-on-the-native-loop.md), [ADR 0091](/decisions/0091-workflow-tool-node-writes-adks-event.md), [ADR 0092](/decisions/0092-workflow-pause-returns-interrupts-to-the-walk.md)), the parity gaps ([ADR 0093](/decisions/0093-workflow-parity-placeholders-join-map-events-compaction.md)) and the resume ([ADR 0094](/decisions/0094-workflow-resume-rebuilds-node-states-from-the-events.md)). `runSyndicateTurn` still refused a workflow syndicate on native ([ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)). Gate G4 of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) needs `tests/workflow.test.ts` to pass under native, and its stop rule needs the ADK-written fixture `05-workflow-ask-user` to resume under native.

On ADK the turn hands the compiled `Workflow` to the Runner and drains what the Runner yields through `drainAgentStream`, under the root span `traceAgentRun` opens. Everything a surface sees comes from that reader: the text, the progress lines and `onProgress`, `answer.nodeErrors` (the error events, under the `collect` policy), `result.input` (the `adk_request_input` event), the text deltas, and the root span's ledger row. Running the same turns on ADK with tracing on showed what the Runner yields and what the ledger reads:

- **The Runner yields every stored event but a node's input turn**, which `runLlmAgentAsNode` appends straight to the session. The root span's `output` concatenates the yielded events' text, so a yielded input turn changes the `adk_turns` row.
- **A node that reported its own error** (its model returned one) writes that event and no node-error event of the workflow's. A node that threw writes one.
- **The spans nest** `invoke_workflow <name>` → `execute_node <name>` → `invoke_agent <agent>` → `call_llm` → `llm.request`, a map item's `execute_node` under its map's, and `execute_tool <tool>` under a tool node's `execute_node`. The ledger reads only `invoke_agent` (the `agent` column), `call_llm` (the payload row) and `execute_tool` (`tool_ms`).
- **An aborted run ends without an error**; the turn reads the stop reason from its control.
- **ADK's compile refuses** a tool node whose tool is unregistered or long-running, before its Runner runs.

Several WS4 records left their open questions to this ticket: the walk's input (ADR 0092), where the node-error and pause events are stored (ADR 0089, ADR 0092), what an unsupported resume does to the turn (ADR 0094), and an `ask_user` tool inside an agent node (ADR 0091, ADR 0094).

## Decision

1. **The native workflow turn is a generator the turn runner drains as it drains ADK's Runner.** `runNativeWorkflow` (`lib/workflow/turn.ts`) stores the message as the user's event under a new `e-` invocation id, walks the graph, and yields every event the walk stores, in the order stored. `runSyndicateTurn` compiles the syndicate for it (`compileNativeWorkflow`: the graph, every agent compiled for native from the same specs `compileWorkflow` uses, one `nativeAdapterFor` that learns every spec's models, the registry's tool lookup) and passes the generator through `traceAgentRun` and `drainAgentStream` with the `workflow` stage and the `collect` policy. The workflow branch of the turn is shared from there on.
2. **The walk's input is the message's text, and every message rehydrates.** `workflowResume` runs on every native workflow turn, as ADK's rehydration does: with nothing paused every node runs fresh, and with a paused walk the finished nodes complete from their stored output and the paused node reruns with the answer. Its `input` (`workflowNodeInput`, the text) is the walk's input and the input the workflow's pause record keeps (ADR 0092's open question).
3. **The workflow's own events are stored on the walk's queue.** On the scheduler's `node_error` with source `workflow`, `nodeErrorEvent` is handed to `agentNodeRuntime.store`, so it lands in walk order. A paused walk's `workflowPauseEvent` is stored after every node's event. The generator ends only once every handed-over event is stored and yielded.
4. **A reported error is returned, not thrown.** `runAgentNode` returns `{ error }` for a run that ended on an error with no output. The scheduler fails the attempt with its own `NodeReportedError` (the same message), which it knows the node reported, so it writes no node-error event of its own, as ADK writes none. `agentNode.ts` re-exports the scheduler's class.
5. **A node's input turn is stored and not yielded; a partial is yielded and not stored.** The generator skips user-authored events, as the Runner never yields a node's input turn. A node agent's partial events reach the stream through `AgentNodeContext.onPartial`, so `onTextDelta` streams a node's text on both runtimes.
6. **The stops.** An `InvocationAbortedError`, or any failure once the turn's signal fired, ends the stream quietly and the turn fails with its stop reason, as on ADK. A node that gave up rethrows its error after its events, and the turn fails `NODE_FAILED` with the error's message, as on ADK. `UnsupportedWorkflowResumeError` (a pause raised inside an agent node or a map item) fails the turn `RESUME_UNSUPPORTED` with its message, after the message is stored, without walking (ADR 0094's open question).
7. **What ADK refuses at compile time, native refuses before any model call, with ADK's message.** `refuseUnrunnableNodes` resolves every tool node through `resolveToolNode` (an unregistered tool, a long-running one) when the turn compiles.
8. **An `ask_user` tool on a workflow node stays refused on both runtimes.** The schema refuses it (`ask_user is not supported on a workflow node yet`). `refuseOnNative` also refuses it by name for a config that skipped validation, before the session is touched. `runAgentNode` still refuses any pause during a node run, and a node agent gets no OAuth consent step.
9. **The walk opens ADK's three workflow spans under the engine's names.** `workflow.invoke <name>`, `node.execute <name>` and `tool.execute <name>`, in scope `melchizedek.runtime`, with ADK's `adk.node.*` attributes (`lib/runtime/native/telemetry.ts`). The scheduler takes a `traceNode` hook that wraps each node run and each map item's run, and the tool node runner a `traceCall` hook that wraps its call. Neither module imports a tracer. An agent node's `agent.invoke` opens inside its `node.execute`, so every `llm.request` row names the node's agent, and the tool node's call counts in `tool_ms`.

## Alternatives considered

- **Build the turn's result from the walk's return value** (`WorkflowRun.output`, `nodeErrors`, `interruptIds`) instead of draining the events. It reads more directly, but it is a second source for the text, the progress lines, `result.input` and the root span's row, beside the reader ADK's path uses. Draining the stored events keeps them identical by construction, as ADR 0091 chose for a tool node's progress.
- **Rehydrate only when `pendingWorkflowInput` finds an open question.** It saves a scan of the session on a fresh turn, but ADK rehydrates on every message, and the resume's rules (the run's events, a function-response answer, a reply refused with ADK's message) apply whether or not a plain-text question is open.
- **Walk afresh on a pause only ADK can resume.** The person would be asked again by a node that already asked, and the stored session would differ from ADK's. ADR 0094 refused it by name; the turn keeps that.
- **Throw the unsupported resume out of `runSyndicateTurn`** as `UnsupportedOnRuntimeError`, before the session is touched. A surface treats a throw as an internal error, but this is the conversation's state, not a programming error, and detecting it before storing the message would need a second rehydration of the session. A failed turn with a code names it to the surface, and the same conversation resumes on ADK.
- **Keep the scheduler's node-error event for a node that reported its own error,** and drop it in the turn. The turn would have to know which errors a runner reported. Returning the error is the scheduler's own contract (ADR 0089 decision 2).
- **Name the spans as ADK does** (`invoke_workflow`, `execute_node`), or open none. ADR 0076 rejected ADK's names for the loop's spans; the same holds. Without node spans the ledger rows would still match except `tool_ms`, which counts a tool node's call on ADK, and a trace viewer would lose the node level.
- **Open the node spans from the scheduler's events** (`node_start`, `node_end`). An event callback cannot make a span the active context of the run that follows, so an agent's `agent.invoke` would not nest under it. The hook is one option and one call site per run kind.
- **Mirror ADK's `execute_node_attempt` and `invocation` spans.** No ledger row reads them. The node span records the attempts the run made.
- **Lift the schema's `ask_user` refusal for workflow nodes on ADK alone.** ADK would end the node's run on the unanswered call, and its rehydration does not treat an `ask_user` call as a pause, so the next message would walk afresh: a question asked, then forgotten. It stays refused on both runtimes until a ticket makes an agent node pause and resume on both.

## Consequences

- `tests/workflow.test.ts` runs every turn-level case on both runtimes: chains, routes, fan-out and join, a map, a tool node, the ask_user pause and its resume, a retry, a node that gives up, streaming, a deadline, and the long-running refusal; and on native the `ask_user` tool refusal and an unsupported resume. `tests/sessionFixtures.test.ts` resumes fixture 05 under native through `runSyndicateTurn`, and `tests/execution.test.ts` runs a `mode: task` workflow node under both.
- `tests/helpers/workflowParity.ts` runs every parity case three ways (ADK, the native modules by hand, and the native turn) and holds both native sides to ADK's stored events, requests, routes, output and progress, and the turn's status and error to ADK's. `tests/workflowAgentNode.test.ts` uses it. `tests/workflowParity.test.ts` adds a node that gives up on a thrown error (ADK's node-error event stored) and one that reports errors until it gives up (none stored).
- `tests/nativeLedger.test.ts` runs a graph with every node kind through `runSyndicateTurn` on both runtimes: `adk_turns`, `adk_telemetry` and `adk_payloads` hold the same rows, and each model call's row names its node's agent. It also pins the span nesting.
- No `notOn` case is left in the dual-runtime suites. `MELCHIZEDEK_RUNTIME=native npm test` runs every workflow suite on native.
- A node agent gets no OAuth consent step on native: a tool that needs a grant runs without a token, as with no consent configured. It joins the pause inside an agent node, still to come.
- The modules stay internal: nothing is added to the `exports` map or the `lib/index.ts` barrel. `nativeAdapterFor` takes a list of specs as well as one.
