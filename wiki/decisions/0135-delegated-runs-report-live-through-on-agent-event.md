---
type: decision
title: "ADR 0135: Delegated runs report live through events.onAgentEvent, carried on the turn's control, and stream only when someone listens"
description: "runSyndicateTurn's onEvent and onTextDelta carry the answering agent only, so a delegated subagent's thinking, text and tool calls were visible only after the run, through its model.call span. A new optional callback, events.onAgentEvent(event, branch), receives every event a delegated run yields as it yields it, with the agent, the delegation path from the caller at the top and the id of the call that started it. The turn runner sets it on TurnControl, where runChild and walkChild read it; with it set, each delegated run streams, so its thinking and text arrive as partials. Forwarding through onEvent with a branch field, threading a callback through every loop context, and always streaming children were rejected."
tags:
  - decision
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-15
sources:
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/turnControl.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: tests/agentEvents.test.ts
---

# ADR 0135: Delegated runs report live through events.onAgentEvent, carried on the turn's control, and stream only when someone listens

## Context

A surface that shows a turn as it happens (a desktop app's orchestration tree, a REPL) gets the answering agent's events through `events.onEvent` and its reply through `events.onTextDelta`. A delegated subagent runs as its own child loop (`runChild`, `lib/runtime/native/delegate.ts`, [ADR 0074](/decisions/0074-native-delegation-runs-a-child-loop-as-agent-tool-does.md)) whose events `runChild` consumes to build the call's answer and never passes on. The caller's own events show the call and, once the child is done, its response, so a surface could fill a subagent's row only when the subagent finished; its thinking, its text and its own tool calls were readable only after the fact from its `model.call` span payload. The child also ran with `stream: false`, so it produced no partials to pass on.

## Decision

1. **One new optional callback.** `TurnEvents.onAgentEvent(event, branch)` receives every event a delegated run yields, in the order it yields it: partials (thinking and text) while the model writes them, then each event it stores (its tool calls, their results, its answer). `branch` is an `AgentBranch` (exported from the barrel and `melchizedek-agents/runtime`): `agent`, `path` (the agents from the caller at the top of the delegation down to this one, itself last) and `callId` (the id of the call, in the caller's event, that started the run). It fires at any depth, and calls running at once (ADR 0116) interleave, told apart by `callId` and `path`. `onEvent` and `onTextDelta` keep their meaning: the answering agent only.
2. **Carried on the turn's control.** `runSyndicateTurn` sets `TurnControl.agentEvents` when the callback is given, as it sets `nestedDispatch` ([ADR 0120](/decisions/0120-nested-dispatch-syndicates-route-as-at-the-top.md)): `runChild` and `walkChild` sit below the turn runner and read it through `currentTurnControl()`. A delegated loop's context carries its `agentPath`, which its own delegations extend.
3. **Streams only when someone listens.** With the callback set, each delegated run's requests ask for streaming, so an adapter yields its thinking and text as partials. Partials are stored nowhere, and `runChild` skips them when it records state and reads the answer, so the sessions hold the same events with or without the callback (the suite compares them). Without it, a delegated run is exactly what it was: `stream: false`, no partials.
4. **A nested workflow's walk** reports its events under the workflow's name and the call's id. A delegation made by an agent node inside that walk reports with a path that starts again at the node's agent, because the walk's node loops do not carry the caller's path.
5. **Guards do not silence it.** A guard reads and may rewrite the answer before anything leaves, which is why a guarded syndicate never fires `onTextDelta`. A delegated run's text is not that answer; it reaches the caller as a tool result the guards already read. So the callback fires for a guarded syndicate too.
6. **An observer that throws is ignored**; the turn goes on.

## Alternatives rejected

- **Forwarding delegated events through `onEvent` with a `branch` field.** Every consumer that reads `onEvent` as the answering agent's stream (the REPL's printer, `drainAgentStream`-shaped readers) would start printing subagent text as the reply. An opt-in keeps the meaning of the existing callbacks.
- **Threading a callback through every loop context** (`runNativeAgent`, the workflow walk, dispatch routes, nested dispatch turns). The turn's control already follows every call the turn makes, including each child loop; the callback belongs on it, as the step budget and `nestedDispatch` do.
- **Always streaming delegated runs.** It changes the requests every subagent sends for every consumer, including the parity suites that compare them with ADK's recorded requests, to serve a display only some surfaces have.
