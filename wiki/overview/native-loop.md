---
type: subsystem
title: Native loop
description: "The native runtime's agent loop (lib/runtime/native/): runAgentLoop repeats one model step, runs the answer's tool calls and stores their results as ADK stores them, until the answer is final. Each step builds the request the ADK runtime would send for the same agent and session, calls the adapter under the turn's controls inside one llm.request span, and stores the answer as the event ADK would store. What the request holds, how the history is projected, how calls run, what a stopped or paused run records, what the loop returns, and the spans that make a native run's ledger rows match an ADK run's."
tags:
  - runtime
  - models
  - overview
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/request.ts
  - resource: lib/runtime/native/history.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/runtime/native/agentLoop.ts
  - resource: lib/runtime/native/telemetry.ts
  - resource: tests/nativeStep.test.ts
  - resource: tests/nativeLoop.test.ts
  - resource: tests/nativeLedger.test.ts
---

# Native loop

The native runtime runs an agent's turn without ADK ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)). It lives in `lib/runtime/native/`, and `runSyndicateTurn` does not select it yet (the runtime flag is WS2-10). For one agent, `runAgentLoop` in `lib/runtime/native/agentLoop.ts` runs a **model step** (`runModelStep`, `lib/runtime/native/step.ts`: build the request, call the adapter, record the answer), runs the answer's tool calls, stores their results, and steps again until the answer is final.

Every piece matches the ADK runtime, so a session either runtime wrote is one the other continues ([ADR 0066](/decisions/0066-native-step-sends-the-adk-request.md), [ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md)). Two suites hold it there, each running syndicates on ADK with a scripted adapter behind the [ADK shim](/models/adk-shim.md):

- `tests/nativeStep.test.ts` rebuilds each call on the native step from the session as it stood before the call. The adapter must be handed an equal request, and the store must hold an equal event.
- `tests/nativeLoop.test.ts` runs the same conversation through `runAgentLoop`: every single-agent case of the boundary suite (`tests/syndicateTurn.test.ts`) and the loop's own cases. The store must hold the same events, ids and times aside, and `onTextDelta` must get the same deltas.
- `tests/nativeLedger.test.ts` runs the same conversation both ways with tracing on and hands each run's spans to the ledger exporter. `adk_turns`, `adk_telemetry` and `adk_payloads` must hold the same rows (see [the spans](#the-spans)).

## The agent

`NativeAgent` (`lib/runtime/native/request.ts`) is what a compiled agent gives a model request, in the YAML's spelling: name, description, model id, instruction, `globalInstruction`, tools in list order, output schema, `generateContentConfig` (with `reasoning:` mapped in, as `withReasoning` maps it), `includeContents`, `codeExecution` and the transfer flags. A tool may be:

- an own Tool or a `defineTool` contract;
- an InstructionTool (few-shot examples, `preload_memory`);
- a NativeToolMarker ([server-side tools](/tools/tool-contracts.md));
- an ADK tool or toolset an agent still lists (an AgentTool, MCP and OpenAPI tools, the skills toolset), read by its declaration and its `getTools`.

An ADK tool that carries an own Tool is read as that Tool. `mode: task` is refused until WS3-5.

## The request

`buildModelRequest(agent, ctx)` builds the `ModelRequest` in ADK's order:

1. **Config.** The agent's `generateContentConfig`. The output schema joins it when the agent lists no tools, or when the model takes a schema beside tools (Gemini 2 and later on Vertex AI). A config holding `tools`, `systemInstruction` or `responseSchema` is refused, as `LlmAgent` refuses it.
2. **System prompt.** Each piece is joined to the last by a blank line:
   - the identity lines, unless the agent may transfer to no one (an output schema rules transfer out);
   - the root agent's global instruction, then the agent's instruction. A string has its `{key}` placeholders filled from session state: `{key?}` is optional, a placeholder naming no state key stays as written, and a required key that is absent fails the request;
   - the `set_model_response` line, when an output schema sits beside tools on a model that cannot take both;
   - each tool's `instruction(ctx)` text, in the agent's tool order: the examples block, `preload_memory`'s facts, `load_memory`'s note. The skills index is already part of the instruction.
3. **History.** `projectHistory` (`lib/runtime/native/history.ts`) projects the session's events as ADK's content processor does, then the [genai mapping](/models/model-contract.md) turns them into messages:
   - `includeContents: default` keeps the conversation. `none` keeps the current turn, from the latest message by the person or by another agent.
   - It skips events on another branch or in another isolation scope, empty ones, and ADK's confirmation, credential and input-request calls.
   - It retells another agent's turns to this one as a user message ("For context:", "[name] said: …").
   - A compaction summary stands in for the events it covers.
   - It moves tool answers next to their calls, and strips ADK's own `adk-` call ids.

   With `code_execution: gemini`, code parts are read as fenced text, as ADK's code-execution processor reads them.
4. **Tools.** These follow the agent's order, a toolset expanded through `getTools` against the session's state (so a loaded skill's tools appear):
   - client-side declarations go through `contractToolDeclaration`, one per name, the later object winning;
   - server-side tools go where the ADK runtime sends them: `web_search` on every provider, `url_context` and `google_search` on Gemini, `x_search` and `collections_search` on xAI, and `code_execution` first among Gemini's own;
   - `set_model_response` is added when step 2 asked for it.
5. **The rest.** Tool choice, the output schema or JSON mode, reasoning and sampling, each read by the shim mapping's own reader. `stream` is `false` unless the caller streams, and `signal` is the turn's.

Not done by the step: resuming an approval or an input request (WS2-7), self-correction's reflection tool (WS2-8), compaction (WS2-9), `transfer_to_agent` (compiled syndicates delegate through tools, WS2-6), task mode (WS3-5), and an ADK tool's own request edits beyond its declaration.

## The call

The step is the adapter's caller, so it charges and traces ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)). The call goes through `traceLlmGeneration` with the adapter's provider, the agent's model id and the request, exactly as on the shim, so the step budget, the token charge and the `llm.request` span's attributes are the same on both runtimes. The adapter defaults to `resolveAdapter(agent.model)`, and a caller may hand it one leaf adapter.

A stopped turn makes no call and no event. When the run's signal has aborted before the call, aborts during it, or the turn refuses the call (`STEP_LIMIT`), the step returns `stopped` with the turn's code and message (`CANCELED`, `DEADLINE_EXCEEDED`, `STEP_LIMIT`). The ADK runtime likewise drops the response of an aborted run.

## The event

Each response becomes ADK's event for it. The base event is created before the call with the run's id, the agent as author and the branch. Each response, mapped as the shim maps it, is merged into it, with a fresh id after the first. Then:

- a tool call with no id gets `adk-<uuid>`;
- a call to a long-running tool (`ask_user`) is listed in `longRunningToolIds`;
- a `set_model_response` call becomes its arguments as JSON text, with `skipSummarization`;
- an answer with no parts, no error and no usage makes no event.

A partial event goes to the caller's `onPartial` and is never stored. The caller's `beforeAppend` sees the final event just before it is stored through `SessionService.append`, which applies the store's rules ([sessions](/memory/sessions.md)).

## What a step returns

`ModelStepResult` holds:

- the request sent;
- the stored event and the adapter's final response;
- the answer's text and the thinking the partials showed (a final never holds thinking);
- the tool calls with their ids as stored, and the long-running ids among them;
- the error of a failed call (stored on the event as ADK stores it);
- `stopped`, for a turn that stopped;
- the client-side tools the request declared, by name;
- `redirected`, for a failure the caller's `redirect` hook took (a fallback answers it; nothing was stored).

A caller may also send the request under another model id (`model`): a fallback model answers the request built for the agent's own model.

## The loop

`runAgentLoop(agent, ctx)` is an async generator. `ctx` is what the step takes besides the agent and its adapter (session, store, run id, user content, branch, memory, `stream`, signal), plus `adapterFor`, the leaf adapter for a model id (default `resolveAdapter`), and `log` for the fallback's notice. The session already holds the run's user event. The loop yields each partial as it arrives, never stored, then each event as the store returned it, so `drainAgentStream` reads it as it reads ADK's stream: streamed text reaches `onTextDelta`, and narration before a tool call is withdrawn with `onTextReset`.

Each step:

1. **The model step.** With `fallback_model`, the step runs once per leaf adapter, by FallbackLlm's rules ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)). A retryable failure counts against the primary's circuit. When nothing was produced before it, the failure is not stored, and the fallback answers the same request under its own model id. An open circuit goes straight to the fallback.
2. **The calls.** The answer's calls run in parallel, each with its own state delta and actions, and their results are kept in call order:
   - a result that is not an object is wrapped `{ result }`, an array `{ results }`;
   - a call naming no declared tool answers `Function <name> is not found in the toolsDict.`;
   - a tool that throws answers `Error in tool '<name>': <message>`;
   - a tool that requires approval asks for it: `requestedToolConfirmations` under the call's id, `skipSummarization`, and the pending notice as its answer;
   - a long-running call (`ask_user`) with no result answers nothing; its actions, when it set any, make an event with no content.

   An own Tool runs through `execute`. An ADK tool an agent still lists (a registry FunctionTool, the skills toolset's tools) runs through its `runAsync`, with a context shaped like ADK's. One call's response is its own event; several are merged into one, parts in call order, actions merged. Each call reads the state as the step left it, not the writes of another call in the same step.
3. **An approval request ends the run.** In place of the response, the loop stores ADK's `adk_request_confirmation` call: the original call and the confirmation as its arguments, an `adk-` id listed in `longRunningToolIds`, and the response's actions.
4. **`outputKey`.** Each final event of the agent carries its text in `stateDelta` under the agent's `outputKey`, written before it is stored. With an output schema, the text is parsed and validated (`z.fromJSONSchema`), kept as text when it does not parse, and saved as parsed when it does not validate.
5. **Go on or stop.** The loop steps again unless the step's last event is final (ADK's `isFinalResponse`, unless it is an empty metadata event after tool calls), the turn stopped the step, or the step stored nothing. ADK's own ceiling of 500 model calls applies when no turn control is lower.

The generator returns an `AgentLoopEnd`:

| `reason` | when | also |
|---|---|---|
| `final` | the last event is a final answer: text, a `set_model_response` answer, a response that skips summarization | `lastEvent` |
| `paused` | a call waits on a person: an `ask_user` call with no response, or an approval request | `pending`, the waiting call ids |
| `error` | the last event carries a failed call's error, among them a model that thinks but never answers ([ADR 0027](/decisions/0027-thinking-without-answer-is-an-error.md)) | `lastEvent` |
| `stopped` | the turn stopped a step (cancel, deadline, `max_steps`); nothing was stored for it | `stop`, the turn's code and message |
| `empty` | the model answered nothing | |

Not done by the loop: delegation and transfer (WS2-6), resuming an approval or a question (WS2-7a, WS2-7b), ADK's reflect-and-retry plugins (WS2-8; a throwing tool answers its error at once, as ADK does with `retries.tool_errors: 0`), compaction (WS2-9), and an auth request a tool raises. A `temp:` key a tool writes is not visible to the next step's instruction placeholders.

## The spans

A native run writes the same ledger rows as an ADK run ([ADR 0076](/decisions/0076-native-loop-spans-feed-the-same-ledger.md)). The ledger reads a turn's spans, and ADK opens three that it depends on, so the loop opens the same three under its own names, in scope `melchizedek.runtime` (`lib/runtime/native/telemetry.ts`):

| the loop's span | ADK's | covers | the ledger reads |
|---|---|---|---|
| `agent.invoke <name>` | `invoke_agent <name>` | the agent's run, opened when the run starts | the agent of every `llm.request` below it (`adk_telemetry.agent`) |
| `model.call` | `call_llm` | one step, with its `llm.request` (two when a fallback answers) | the step's payload row in `adk_payloads` |
| `tool.execute <name>` | `execute_tool <name>` | one tool call, under the agent span | its duration, in `adk_turns.tool_ms` |

`agentLoop.ts` opens them through three hooks: `traceAgentInvocation` around the run, `traceModelCall` around each step and `traceToolCall` around each call. The tracer's lineage and the exporter read both naming schemes through `lib/observability/lineage.ts`. Like ADK's, the loop's spans reach the in-process listeners and the ledger, and are printed only with `OTEL_CONSOLE_ALL_SPANS=true`.

What they carry:

- **ADK's `gen_ai.*` attributes**: operation, agent name and description, conversation id, tool name and call id, usage and finish reason. `gen_ai.request.model` is the agent's model, as on `call_llm`; `gen_ai.system` is the provider of the adapter that answered.
- **A step's payload.** A `model.call` whose call did not fail carries `llm.payload.request` (the `ModelRequest`, its signal left out) and `llm.payload.response` (the adapter's final response). A failed step carries none: its `llm.request` carries the failed call's payload, as on ADK, where a failed `call_llm` never ends. With `TELEMETRY_PAYLOADS=off` nothing is recorded.
- **No tool arguments or results.** The root span's `ToolCall` and `ToolResponse` events hold them. A tool span records `tool.error` for an error response and `tool.pending` for a long-running call that answered nothing.
- **How the run ended** on the agent span: `agent.end_reason`, `agent.steps`, and `agent.stop_code` for a stopped run.

The rows differ from ADK's in two places. A step's own payload row holds the engine's request and response shapes, and its `provider` column names the provider where ADK's says `gcp.vertex.agent`. And a step's calls run side by side, so `tool_ms` sums their durations where ADK's sum is wall time. The root span is the turn runner's: WS2-10 wraps the native stream in `traceAgentRun` as `runSyndicateTurn` wraps ADK's.
