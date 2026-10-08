---
type: subsystem
title: Native loop
description: "The native runtime's agent loop (lib/runtime/native/): runAgentLoop repeats one model step, runs the answer's tool calls and stores their results as ADK stores them, until the answer is final, a subagent tool running the subagent as its own child loop. Each step builds the request the ADK runtime would send for the same agent and session, calls the adapter under the turn's controls inside one llm.request span, and stores the answer as the event ADK would store. What the request holds, how the history is projected, how calls run, how a subagent runs, what a stopped or paused run records, and what the loop returns. runSyndicateTurn runs a turn on it under MELCHIZEDEK_RUNTIME=native or the turn's runtime option, with agents compileNative builds from the same AgentSpec as ADK's, and refuses what it does not run yet before any model call."
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
  - resource: lib/runtime/native/tempState.ts
  - resource: lib/runtime/nativeTurn.ts
  - resource: lib/runtime/runtimeFlag.ts
  - resource: lib/compileNative.ts
  - resource: lib/runtime/native/delegate.ts
  - resource: lib/runtime/native/selfCorrection.ts
  - resource: tests/nativeStep.test.ts
  - resource: tests/nativeLoop.test.ts
  - resource: tests/nativeTurn.test.ts
  - resource: tests/nativeDelegate.test.ts
  - resource: lib/runtime/native/telemetry.ts
  - resource: tests/nativeLedger.test.ts
---

# Native loop

The native runtime runs an agent's turn without ADK ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)). It lives in `lib/runtime/native/`, and `runSyndicateTurn` runs a turn on it when `MELCHIZEDEK_RUNTIME=native` or the turn's `runtime: 'native'` option asks ([the runtime flag](#the-runtime-flag), [ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)). For one agent, `runAgentLoop` in `lib/runtime/native/agentLoop.ts` runs a **model step** (`runModelStep`, `lib/runtime/native/step.ts`: build the request, call the adapter, record the answer), runs the answer's tool calls, stores their results, and steps again until the answer is final.

Every piece matches the ADK runtime, so a session either runtime wrote is one the other continues ([ADR 0066](/decisions/0066-native-step-sends-the-adk-request.md), [ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md), [ADR 0074](/decisions/0074-native-delegation-runs-a-child-loop-as-agent-tool-does.md)). Three suites hold it there, each running syndicates on ADK with a scripted adapter behind the [ADK shim](/models/adk-shim.md):

- `tests/nativeStep.test.ts` rebuilds each call on the native step from the session as it stood before the call. The adapter must be handed an equal request, and the store must hold an equal event.
- `tests/nativeLoop.test.ts` runs the same conversation through `runAgentLoop`: every single-agent case of the boundary suite (`tests/syndicateTurn.test.ts`) and the loop's own cases. The store must hold the same events, ids and times aside, and `onTextDelta` must get the same deltas.
- `tests/nativeLedger.test.ts` runs the same conversation both ways with tracing on and hands each run's spans to the ledger exporter. `adk_turns`, `adk_telemetry` and `adk_payloads` must hold the same rows (see [the spans](#the-spans)).
- `tests/nativeDelegate.test.ts` does the same for delegation: the boundary suite's delegation cases, a nested syndicate and the council example. Every session must hold the same events (the caller's, and each subagent's own), and every model must be sent the same requests.

## The agent

`NativeAgent` (`lib/runtime/native/request.ts`) is what a compiled agent gives a model request, in the YAML's spelling: name, description, model id, instruction, `globalInstruction`, tools in list order, output schema, `generateContentConfig` (with `reasoning:` mapped in, as `withReasoning` maps it), `includeContents`, `codeExecution` and the transfer flags. A tool may be:

- an own Tool or a `defineTool` contract;
- a subagent tool (`subagentTool(agent)`, `lib/runtime/native/delegate.ts`), which runs another `NativeAgent`;
- an InstructionTool (few-shot examples, `preload_memory`);
- a NativeToolMarker ([server-side tools](/tools/tool-contracts.md));
- an ADK tool or toolset an agent still lists (MCP and OpenAPI tools, the skills toolset), read by its declaration and its `getTools`.

An ADK tool that carries an own Tool is read as that Tool. An ADK `AgentTool` fails the run when it is called: a subagent reaches the native loop as a subagent tool. `mode: task` is refused until WS3-5.

`compileNative` (`lib/compileNative.ts`) builds it from the same `AgentSpec` that `compileAdk` (`lib/compileAdk.ts`) turns into ADK's `LlmAgent`. `compileSpec` and `compileSubagentSpec` in `lib/compile.ts` make the spec once per agent: tools resolved and gated, the skills index in the instruction, the model resolved once, the `generateContentConfig` built for that model. Each resolved tool reaches the loop as the own Tool or InstructionTool behind it, or as itself. `tests/compile.test.ts` compiles one fixture both ways and requires the same first request. `tests/nativeStep.test.ts`, `tests/nativeLoop.test.ts` and `tests/geminiNativeTools.test.ts` build their agents with it.

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
   - `set_model_response` is added when step 2 asked for it;
   - self-correction's reflection tool, `adk_handle_model_error`, comes last when the step has a `correction` (see [Self-correction](#self-correction)).
5. **The rest.** Tool choice, the output schema or JSON mode, reasoning and sampling, each read by the shim mapping's own reader. `stream` is `false` unless the caller streams, and `signal` is the turn's.

Not done by the step: resuming an approval or an input request (WS2-7), compaction (WS2-9), `transfer_to_agent` (compiled syndicates delegate through tools, WS2-6), task mode (WS3-5), and an ADK tool's own request edits beyond its declaration.

## The call

The step is the adapter's caller, so it charges and traces ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)). The call goes through `traceLlmGeneration` with the adapter's provider, the agent's model id and the request, exactly as on the shim, so the step budget, the token charge and the `llm.request` span's attributes are the same on both runtimes. The adapter defaults to `resolveAdapter(agent.model)`, and a caller may hand it one leaf adapter.

A stopped turn makes no call and no event. When the run's signal has aborted before the call, aborts during it, or the turn refuses the call (`STEP_LIMIT`), the step returns `stopped` with the turn's code and message (`CANCELED`, `DEADLINE_EXCEEDED`, `STEP_LIMIT`). The ADK runtime likewise drops the response of an aborted run.

## The event

Each response becomes ADK's event for it. The base event is created before the call with the run's id, the agent as author and the branch. Each response, mapped as the shim maps it, is merged into it, with a fresh id after the first. Then:

- a tool call with no id gets `adk-<uuid>`;
- a call to a long-running tool (`ask_user`) is listed in `longRunningToolIds`;
- a `set_model_response` call becomes its arguments as JSON text, with `skipSummarization`;
- an answer with no parts, no error and no usage makes no event.

With a `correction`, each response, partials included, passes through self-correction's model side first, after the fallback's redirect check. A retry may stand in its place, or the step may end on an `UNKNOWN_ERROR` event (see [Self-correction](#self-correction)).

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

`runAgentLoop(agent, ctx)` is an async generator. `ctx` is what the step takes besides the agent and its adapter (session, store, run id, user content, branch, memory, `stream`, signal), plus `adapterFor`, the leaf adapter for a model id (default `resolveAdapter`), `log` for the fallback's notice, and `selfCorrection`, the turn's self-correction (default: retries at their defaults). The session already holds the run's user event. The loop yields each partial as it arrives, never stored, then each event as the store returned it, so `drainAgentStream` reads it as it reads ADK's stream: streamed text reaches `onTextDelta`, and narration before a tool call is withdrawn with `onTextReset`.

Each step:

1. **The model step.** With `fallback_model`, the step runs once per leaf adapter, by FallbackLlm's rules ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)). A retryable failure counts against the primary's circuit. When nothing was produced before it, the failure is not stored, and the fallback answers the same request under its own model id. An open circuit goes straight to the fallback.
2. **The calls.** The answer's calls run in parallel, each with its own state delta and actions, and their results are kept in call order:
   - a result that is not an object is wrapped `{ result }`, an array `{ results }`;
   - a call naming no declared tool answers `Function <name> is not found in the toolsDict.`;
   - a tool that throws answers `Error in tool '<name>': <message>`;
   - with tool retries on, those two answer with reflection guidance instead (see [Self-correction](#self-correction));
   - a tool that requires approval asks for it: `requestedToolConfirmations` under the call's id, `skipSummarization`, and the pending notice as its answer;
   - a long-running call (`ask_user`) with no result answers nothing; its actions, when it set any, make an event with no content.

   A subagent tool runs the subagent as its own child loop (see [Delegation](#delegation)). An own Tool runs through `execute`. An ADK tool an agent still lists (a registry FunctionTool, the skills toolset's tools) runs through its `runAsync`, with a context shaped like ADK's. One call's response is its own event; several are merged into one, parts in call order, actions merged. Each call reads the state as the step left it, not the writes of another call in the same step.
   When the turn stopped while the calls ran, nothing is stored for them and the run ends `stopped`, as ADK drops the response.
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

## Self-correction

`lib/runtime/native/selfCorrection.ts` does what ADK's reflect-and-retry plugins do on the ADK runtime ([ADR 0034](/decisions/0034-self-correction.md), [ADR 0075](/decisions/0075-native-self-correction-ports-adk-plugins.md)). The texts, ids and counts are the same, so both runtimes store the same events. A `SelfCorrection` is built from the syndicate's `retries:` and holds one turn's counters, kept per run id.

**The model side** (`retries.model_errors`, default 2; `0` turns it off), through the step's `correction`:

- Every request declares `adk_handle_model_error` ("A tool that triggers reflection. …", no parameters) after the agent's tools.
- Two kinds of response are replaced by ADK's reflection call, with id `adk_handle_model_error_<uuid>` and the arguments `response_type`, `error_type`, `error_details`, `finish_reason` and `retry_count`:
  - a response that calls that tool itself (`RESERVED_TOOL_CALL`);
  - a response whose finish reason is `MALFORMED_FUNCTION_CALL`.
- The loop runs the call like any other, and the tool answers with reflection guidance.
- The count is per agent, and any other response resets it, a streamed partial included.
- Past the limit, the step stores ADK's event for a callback that threw: `UNKNOWN_ERROR`, "Error in plugin 'reflect_retry_model_plugin' during 'afterModelCallback' callback: …". The run ends with `error`.

**The tool side** (`retries.tool_errors`, default 3; `0` turns it off), through each call's `CallCorrection`:

- A tool that throws an Error, and a call naming no tool, answer with reflection guidance: `response_type`, `error_type`, `error_details`, `retry_count` and `reflection_guidance`.
- Past the limit, the guidance says the retry limit is exceeded and not to use the tool again.
- A call that answers resets its tool's count.
- The calls run in parallel, but they are counted in call order, as ADK counts them running one after another.

ADK's quirks are kept on purpose, so both runtimes match:

- the reflection tool's guidance always says "attempt 1";
- a partial resets the model count;
- through the model contract a malformed Gemini call is an error code, not a finish reason, so no adapter's response is retried for it on either runtime.


## Delegation

A DELEGATE syndicate's orchestrator lists each subagent as `subagentTool(agent)`: named for the agent, described by its description, with one string parameter `request`, as ADK's `AgentTool` declares it. A `yaml_reference` subagent is the nested syndicate's orchestrator under the entry's name and description, listing its own subagent tools. `runCall` asks `subagentOf(tool)` before the generic path, and `runSubagent` (`lib/runtime/native/delegate.ts`) runs the call as `AgentTool.runAsync` runs it ([ADR 0074](/decisions/0074-native-delegation-runs-a-child-loop-as-agent-tool-does.md)):

1. **The subagent's own session.** It is `{ appName: <subagent name>, userId, sessionId }` in the caller's store, not a branch of the caller's session. The first call creates it from the caller's state (the session's, then the call's writes, `temp:` keys dropped). Every later call, in this turn or another, continues it, so the subagent sees its earlier requests and answers.
2. **The request as a message.** `{ role: 'user', parts: [{ text: request }] }` is stored as a user event under a fresh `e-<uuid>` invocation id. A turn already stopped answers `''`.
3. **The child loop.** The subagent runs on `runAgentLoop` as its run's root: not streamed, under the turn's controls and signal (its calls count toward `max_steps`), with the caller's memory and adapters. None of its events reach the caller's stream or session.
4. **State out.** Each event the child stores has its state writes, `temp:` keys aside, written into the call's state delta. They land on the caller's response event, an `outputKey` write among them.
5. **The answer.** The result is the last event's non-thought text, joined by newlines, or `''` when it has no parts (a failed model call, a pause). With an output schema it is parsed as JSON, and text that does not parse fails the call with the parser's message. Once the turn has stopped, no further child events are read.

Calls to subagents in one step run one after another, in call order, as ADK runs them. A pause inside a subagent (an `ask_user` call, an approval request) cannot reach the caller ([ADR 0028](/decisions/0028-approval-gates.md)): the child run ends paused, the call answers `''`, and the gated tool never runs. The DELEGATE relay fallback stays in `runSyndicateTurn`, which reads the drained run from either runtime.

Not done by the loop: transfer (`transfer_to_agent`), running subagents concurrently (WS6), a pause inside a subagent reaching the caller (WS6-2a), resuming an approval or a question (WS2-7a, WS2-7b), compaction (WS2-9), and an auth request a tool raises.

A `temp:` key a tool writes is visible to the rest of the run, as ADK's live session state makes it: the next step's instruction placeholders, its toolsets, and the next step's calls read it. The loop reads each event's `temp:` keys just before the store drops them, and lays them over the session's state when it builds a request or a call's context (`lib/runtime/native/tempState.ts`). They are never written into the session object, since a store that saves the whole session would keep them.

## The runtime flag

`lib/runtime/runtimeFlag.ts` names the runtime: the turn's `runtime` option (`adk` or `native`), else `MELCHIZEDEK_RUNTIME`, else `adk`. Any other value is a configuration error. The wiki agent runner (`lib/wiki/agentRun.ts`) follows the same flag, with a `runtime` option of its own.

On `native`, `runSyndicateTurn` keeps its own logic (routing, guards, the relay fallback, approvals and questions read from the stored events) and swaps only what runs one agent. `runNativeAgent` (`lib/runtime/nativeTurn.ts`) does what ADK's `Runner` does before the agent runs:

1. It reads the session, which must exist.
2. It stores the message as the user's event under a new `e-` invocation id.
3. It runs `runAgentLoop`, with the turn's one `SelfCorrection`, built from the syndicate's `retries:` as the ADK path installs its retry plugins.

The turn runner wraps the stream in `traceAgentRun` with the same metadata on either runtime, so the turn's root span sits over the loop's [spans](#the-spans).

The turn runner drains the events through `drainAgentStream`, so the result has the same shape: text, grounding, usage, a pending approval or question, errors. The adapter for each model id is the one behind what `CompileOptions.resolveModel` returns: an ADK shim's own adapter, or, for `TracedGemini`, `resolveAdapter` under the key the instance carries, so a caller's BYOK key pays on either runtime. Anything else gets `resolveAdapter` for the id (`nativeAdapterFor`). A per-request Vertex AI endpoint does not reach a native call yet. Memory search goes to the engine's `MemoryService`, or to an ADK-only service's `searchMemory`. A single agent, a DELEGATE syndicate (each subagent a `subagentTool` holding its own compiled agent, a remote one the A2A tool ADK's runtime runs too) and a plan-dispatch syndicate (the classifier and a local route) run on native. `tests/nativeTurn.test.ts` runs conversations both ways and requires the same results and the same stored events.

What native does not run yet fails before any model call, with an `UnsupportedOnRuntimeError` that names the feature and the runtime:

| Refused | where | until |
|---|---|---|
| `context:` compaction | `compileNative` | WS2-9 |
| `mode: task` | `compileNative` | WS3-5 |
| a `workflow:` syndicate | `refuseOnNative` | the workflow engine (WS4) |
| a caller's `transformAgent` (it transforms ADK agents) | `refuseOnNative` | none planned |
| a message that resumes an approval or answers a question | `runSyndicateTurn` | WS2-7 |

A turn that paused on native (an approval request, an `ask_user` call) stored ADK's own events, so the same conversation resumes on `adk`.
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

The rows differ from ADK's in two places. A step's own payload row holds the engine's request and response shapes, and its `provider` column names the provider where ADK's says `gcp.vertex.agent`. And a step's calls run side by side, so `tool_ms` sums their durations where ADK's sum is wall time. The root span is the turn runner's: `runSyndicateTurn` wraps the native stream in `traceAgentRun` with the same metadata as ADK's ([the runtime flag](#the-runtime-flag)).
