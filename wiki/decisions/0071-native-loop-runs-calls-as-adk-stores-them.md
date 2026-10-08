---
type: decision
title: "ADR 0071: The native agent loop stores the events ADK stores, runs a step's calls in parallel, and runs a fallback as a second step"
description: "runAgentLoop (lib/runtime/native/agentLoop.ts) repeats the native model step until the answer is final, and stores each tool response, merged response, approval request and outputKey write exactly as ADK's LlmAgent and handleFunctionCallList do. It runs one step's calls in parallel, each on the state the step left, where ADK runs them in turn on a shared state. With a fallback_model it runs the step once per leaf adapter, the primary's failure handed back unstored. An ADK tool an agent still lists runs through its own runAsync with a context shaped like ADK's. The loop is an async generator of events that returns how it ended. Sequential calls, a FallbackAdapter in one step, refusing ADK tools and a callback surface were rejected."
tags:
  - decision
  - runtime
  - tools
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/step.ts
  - resource: tests/nativeLoop.test.ts
  - resource: tests/syndicateTurn.test.ts
---

# ADR 0071: The native agent loop stores the events ADK stores, runs a step's calls in parallel, and runs a fallback as a second step

## Context

[ADR 0066](/decisions/0066-native-step-sends-the-adk-request.md) gives the native runtime one model step that sends the ADK runtime's request and stores ADK's event. The loop around it is what `LlmAgent.runAsyncImpl` does on ADK: step, run the answer's function calls, store their response, and step again until the last event is a final response. A session either runtime wrote must be one the other continues ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)). So every event the loop stores, beyond the model's own, must be ADK's too:

- the response event, with ADK's wrapping of a result (`{ result }`, `{ results }`), its errors (`Error in tool '<name>': …`, `Function <name> is not found in the toolsDict.`), and several calls merged into one event;
- the actions-only event of a long-running call that set actions (`ask_user`'s `skipSummarization`);
- the approval request (`adk_request_confirmation`) stored in place of the response;
- the agent's `outputKey`, written into each final event's delta before it is stored.

Four choices had real alternatives: how a step's calls run, how a `fallback_model` runs, what happens to an ADK tool an agent still lists, and what surface the loop has.

## Decision

1. **The stored events are ADK's.** The loop ports `handleFunctionCallList`, `mergeParallelFunctionResponseEvents`, `generateRequestConfirmationEvent`, `generateAuthEvent`, `maybeSaveOutputToState` and the stop rule of `runAsyncImpl` (`isFinalResponse`, unless it is an empty metadata event after tool calls), over TurnEvents. An own Tool that requires approval is gated as FunctionTool's gate does it, with `APPROVAL_TEXTS`. An output schema is validated with `z.fromJSONSchema` over the contract's form of the schema, as ADK validates it over its own. `tests/nativeLoop.test.ts` runs each single-agent case of the boundary suite, and the loop's own cases, on ADK and on the loop, and requires the same stored events, ids and times aside.
2. **A step's calls run in parallel, each on the state the step left.** Each call has its own context, state delta and actions. The results are kept in call order and merged as ADK merges them. ADK runs the calls one after another, and its `State.set` writes into the live session, so a later call of the same step reads what an earlier call wrote. On the native loop it does not. The stored events are the same whenever no call reads another's write in the same step.
3. **A `fallback_model` is a second step, once per leaf adapter** ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)). The primary's step takes a `redirect` hook that applies FallbackLlm's rules ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)): a retryable failure counts against the provider's circuit, and when nothing was produced before it, the step hands the failure back unstored. The fallback's step then sends the same request under the fallback's model id (the step's `model` option). An open circuit goes straight to the fallback. Each leaf call is charged and traced by its own step.
4. **An ADK tool an agent still lists runs through its own `runAsync`.** During the dual period an agent may list a registry FunctionTool or the skills toolset's tools, which have no own Tool. The loop calls `runAsync` with a context shaped like ADK's: the same state view, actions, `functionCallId`, `requestConfirmation`, `toolConfirmation`, abort signal and `invocationContext` (run id, agent name, branch, session). A gated FunctionTool therefore raises the same approval request. Delegation (an AgentTool) is WS2-6.
5. **The loop is an async generator.** `runAgentLoop(agent, ctx)` yields every event in order: partials as they arrive (never stored), then each event as the store returned it. It returns an `AgentLoopEnd`: `final`, `paused` (with the pending call ids), `error`, `stopped` (with the turn's code), or `empty`. `drainAgentStream` reads it as it reads ADK's stream, so streaming reaches `onTextDelta` and `onTextReset` unchanged.

## Alternatives considered

- **Run the calls one after another on a shared state, as ADK does.** It would match ADK when a call reads an earlier call's write in the same step. But a step's calls are independent requests from the model, and a slow tool (a search, an API) would hold up the rest. The ticket asks for parallel calls, and the stored events differ only in that unusual case, which this record names.
- **Wrap the pair in a `FallbackAdapter` inside one step.** It is one call site, but one span and one charge for two leaf calls, attributed to the primary, which ADR 0053 rules out. Storing the primary's failure and then running the fallback would leave an error event ADK never stores.
- **Refuse an ADK tool until it becomes an own Tool.** It is simpler, and every ADK tool will move by 1.0. But the skills toolset and a registry FunctionTool gated by `require_approval` would not run natively until then, and the boundary suite's approval case could not run on the loop.
- **Callbacks instead of a generator** (`onEvent`, `onPartial`). It matches the step's own `onPartial`, but every consumer of the ADK runtime already reads an event stream, and the turn runner's drain works on the generator unchanged.

## Consequences

- WS2-10 calls `runAgentLoop` from `runSyndicateTurn` under `MELCHIZEDEK_RUNTIME=native` and drains it with `drainAgentStream`. The compile split builds the `NativeAgent`, now with `outputKey` and `fallbackModel`.
- `runModelStep` takes `model`, `beforeAppend` and `redirect`, and its result carries `tools` (the declared tools by name) and `redirected`.
- A `temp:` state key a tool writes is not visible to the next step's instruction placeholders, where ADK keeps it in the live session for the invocation. Writing it into the session object would reach a store that serializes the whole session.
- ADK's reflect-and-retry plugins are not run: a throwing tool answers its error at once, as ADK does with `retries.tool_errors: 0`. Self-correction is WS2-8.
- No tool spans yet (`execute_tool`): WS2-11.
