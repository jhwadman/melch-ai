---
type: decision
title: "ADR 0089: The workflow scheduler's retries, timeouts, node errors and abort follow ADK's node runner"
description: "lib/workflow/scheduler.ts runs every node attempt through one loop copied from ADK 2.2's runChildNode: a per-attempt timeout that abandons the attempt, a retry while max_attempts and an exceptions list allow, ADK's backoff with jitter, and never a retry of an abort or a map item's failure. A runner reports an error by returning `error`; the walk emits it and, when the attempt produced nothing, fails it with NodeReportedError. A node that gives up is reported once, unless it reported the error itself or the walk was stopped. The walk's signal defaults to the turn's (turnControl); after it fires no node starts and the walk rejects with InvocationAbortedError, and an attempt without a timeout is awaited as ADK awaits it. Map items run under their agent's modifiers and fail the map with DynamicNodeFailError; the map entry's own modifiers are not applied, as on ADK. A null output is no output. Racing every attempt against the abort, reporting every thrown attempt, and applying a map's own modifiers were rejected."
tags:
  - decision
  - runtime
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/workflow/scheduler.ts
  - resource: lib/workflow/graph.ts
  - resource: lib/runtime/turnControl.ts
  - resource: tests/workflowScheduler.test.ts
---

# ADR 0089: The workflow scheduler's controls follow ADK's node runner

## Context

[ADR 0087](/decisions/0087-workflow-scheduler-walks-the-graph-as-adk-does.md) gave the engine a scheduler that walks a workflow graph as ADK's `Workflow` does, and left one seam, `executeNode`, for the controls [ADR 0030](/decisions/0030-workflow-graphs.md) gives a node: `retry`, `timeout`, and the rule that a node's error is recorded and not the turn's until the node gives up. WS4-2b fills it. ADK 2.2 implements these in `workflow/node_runner.js` (`runChildNode`, `runOnce`), `utils/retry_utils.js` and `Workflow.reportNodeError`. Running ADK with stub nodes showed what a port has to keep:

- **A thrown error is silent until the node gives up.** A node that throws and then succeeds on retry leaves no event. A node that gives up gets one node-error event from the workflow (`isNodeError`, `errorType`, `attemptCount`), with code `UNKNOWN_ERROR` unless the error carries a `code`.
- **A reported error is written on every attempt.** A node whose event carries an `errorCode` (an agent whose model returned an error) writes that event. With no output and no route the attempt fails with `NodeReportedError`, which may be retried, and which the workflow does not report a second time. This is ADR 0030's "the attempt is recorded, not fatal".
- **A timeout races each attempt.** The attempt's signal aborts and the attempt fails with `NodeTimeoutError` without waiting for the node. A timeout is retried like any error. Without a timeout ADK awaits the node.
- **A map item runs as a dynamic node.** It runs under the inner agent's own `retryConfig` and `timeout`, and an item that gives up fails the map with `DynamicNodeFailError` (`Dynamic node <agent> failed: <message>`), which the workflow reports under the map's name. ADK's compile hands the map entry's own modifiers to nothing.
- **A null output is no output.** No event is written, nothing is recorded, and the successor runs on `undefined`.
- **A run that finishes while a failure shuts the walk down still writes its output**, because the node writes its own event.

## Decision

1. **One loop, `withControls`, around every node and every map item.** Each attempt runs under the node's `timeout` (seconds; the attempt's own signal aborts and the attempt fails with `NodeTimeoutError` when it fires). A failed attempt is retried while `shouldRetry` allows: fewer than `max_attempts` attempts so far (default 5), and the error's class or `name` in `exceptions` when a list is given. The wait is ADK's `getRetryDelaySeconds`, jitter included. `InvocationAbortedError` and `DynamicNodeFailError` are never retried, and an abort cuts a backoff short. The error classes carry ADK's names, so `errorType` reads the same on both runtimes.
2. **A runner reports an error by returning it.** `NodeResult.error` (`{ code, message }`) is emitted as a `node_error` event with source `node`. When the result has no output and no route, the attempt fails with `NodeReportedError` and is marked as already reported. A node that gives up is reported once, as source `workflow` with its `errorType` and attempt count, unless it reported the error itself, the error is an abort, or the walk was stopped from outside. Every `node_error` is collected in `WorkflowRun.nodeErrors` as `{ node, code, message }`, the shape `runSyndicateTurn`'s drain collects ADK's error events in.
3. **The walk stops on the turn's signal.** `signal` defaults to `currentTurnSignal()`, so a cancel or a turn deadline from `turnControl` reaches every runner. Once the signal fires, no node starts. When nothing is left running the walk rejects with `InvocationAbortedError` (its `cause` is the signal's reason). An attempt with a timeout ends at once on the abort. An attempt without one is awaited, as ADK awaits it: the runner gets the signal and must settle.
4. **A map item runs under its agent's modifiers.** The graph model's `MapNode` carries `agentSettings`, the mapped agent's own `nodes.<agent>` entry. An item that gives up fails the map with `DynamicNodeFailError`. The map entry's own `retry` and `timeout` stay in the model as written and are not applied.
5. **A null output is no output**, for every node kind and every map item.
6. **A run that settles during a failure's shutdown ends with its `node_end`**, in settle order, and triggers nothing.

## Alternatives considered

- **Race every attempt against the abort**, so the walk never waits for a runner that ignores its signal. A runner abandoned this way could still write session events after the turn has ended, and ADK waits for a node without a timeout. A node that must not hang gets a `timeout`; the runners the native path injects (WS4-3, WS4-5) pass the signal to the provider or tool call.
- **Report every failed attempt, thrown or not.** It would show more, but `answer.nodeErrors` would then differ between the runtimes for the same run: ADK writes nothing for a thrown attempt that is retried.
- **Apply the map entry's own `retry` and `timeout`.** That is what a reader of the YAML might expect, but ADK applies neither. Changing it belongs in a record that changes the compile and the scheduler together, or makes the schema refuse the keys.
- **Resolve an aborted walk with the outputs it has.** A partial graph's output could be read as an answer. The turn fails with its stop reason on both runtimes.

## Consequences

- `tests/workflowScheduler.test.ts` runs ADR 0030's retry and timeout cases on ADK and on the scheduler with the same stubs, and requires the same calls, completions, node errors (path, branch, author, code, message, and for a node that gave up its error type and attempt count) and outcome. The cases are a thrown error recovered, a reported error recovered, a node giving up after one and after three reported errors, a node that keeps throwing, a timeout recovered and one that fails the walk, map items that retry and that give up, `max_concurrency` with a retrying node and with a failure, and null outputs. The retry rule and the backoff are checked against ADK's own `retry_utils` functions. The abort, the deadline and an abort during a timed attempt are checked on the scheduler alone, because ADK's `Runner` ends an aborted run without an error.
- The YAML cannot spell `exceptions` or `jitter` yet. The scheduler honours them when a retry carries them, so adding them to the schema is a schema change only.
- Nothing in the turn runner calls the scheduler yet. The native workflow path (WS4-6) turns `node_error` events into the events ADK writes and `nodeErrors` into `answer.nodeErrors`.
- The module stays internal: not in the `exports` map or the `lib/index.ts` barrel.
