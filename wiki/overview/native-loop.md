---
type: subsystem
title: Native loop
description: "The native runtime's agent loop (lib/runtime/native/): runAgentLoop repeats one model step, runs the answer's tool calls and stores their results as ADK stores them, until the answer is final, a subagent tool running the subagent as its own child loop, and with `context:` compacting the history before a step as ADK does. Each step builds the request the ADK runtime would send for the same agent and session, calls the adapter under the turn's controls inside one llm.request span, and stores the answer as the event ADK would store. What the request holds, how the history is projected, how calls run, how a subagent runs, what a stopped or paused run records, how a granted OAuth consent, an answered approval or a question resumes, and what the loop returns. runSyndicateTurn runs every turn on it by default (native is the default runtime since 0.20.0; MELCHIZEDEK_RUNTIME=adk or the turn's runtime option selects ADK), with agents compileNative builds from the same AgentSpec as ADK's, and refuses what it does not run yet before any model call."
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
  - resource: lib/runtime/credentials.ts
  - resource: tests/oauthConsent.test.ts
  - resource: tests/nativeStep.test.ts
  - resource: tests/nativeLoop.test.ts
  - resource: tests/nativeTurn.test.ts
  - resource: tests/nativeDelegate.test.ts
  - resource: lib/runtime/native/telemetry.ts
  - resource: tests/nativeLedger.test.ts
  - resource: lib/runtime/native/taskMode.ts
  - resource: tests/execution.test.ts
  - resource: lib/runtime/native/interrupts.ts
  - resource: tests/nativeApprovals.test.ts
  - resource: lib/runtime/questions.ts
  - resource: tests/nativeQuestions.test.ts
  - resource: lib/runtime/native/compaction.ts
  - resource: tests/compaction.test.ts
  - resource: lib/runtime/valueDepth.ts
  - resource: lib/compile.ts
  - resource: tests/nativeFuzz.test.ts
---

# Native loop

The native runtime runs an agent's turn without ADK ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)). It lives in `lib/runtime/native/`, and `runSyndicateTurn` runs every turn on it unless `MELCHIZEDEK_RUNTIME=adk` or the turn's `runtime: 'adk'` option asks for ADK ([the runtime flag](#the-runtime-flag), [ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md), [ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md)). For one agent, `runAgentLoop` in `lib/runtime/native/agentLoop.ts` runs a **model step** (`runModelStep`, `lib/runtime/native/step.ts`: build the request, call the adapter, record the answer), runs the answer's tool calls, stores their results, and steps again until the answer is final.

Every piece matches the ADK runtime, so a session either runtime wrote is one the other continues ([ADR 0066](/decisions/0066-native-step-sends-the-adk-request.md), [ADR 0071](/decisions/0071-native-loop-runs-calls-as-adk-stores-them.md), [ADR 0074](/decisions/0074-native-delegation-runs-a-child-loop-as-agent-tool-does.md)). Three suites hold it there, each running syndicates on ADK with a scripted adapter behind the [ADK shim](/models/adk-shim.md):

- `tests/nativeStep.test.ts` rebuilds each call on the native step from the session as it stood before the call. The adapter must be handed an equal request, and the store must hold an equal event.
- `tests/nativeLoop.test.ts` runs the same conversation through `runAgentLoop`: every single-agent case of the boundary suite (`tests/syndicateTurn.test.ts`) and the loop's own cases. The store must hold the same events, ids and times aside, and `onTextDelta` must get the same deltas.
- `tests/nativeLedger.test.ts` runs the same conversation both ways with tracing on and hands each run's spans to the ledger exporter. `adk_turns`, `adk_telemetry` and `adk_payloads` must hold the same rows (see [the spans](#the-spans)).
- `tests/execution.test.ts` does the same for `code_execution: gemini` and `mode: task` ([ADR 0033](/decisions/0033-context-task-code.md)): the same results, stored events and requests on both runtimes, and a task-mode node's events as ADK's workflow stores them.
- `tests/nativeApprovals.test.ts` runs two-turn approval conversations the same way: a gated call opens the approval, the next message answers it. The stores must hold the same events and the gated tool must run as often. It also resumes an approval ADK stored (the session fixtures) on the loop.
- `tests/nativeDelegate.test.ts` does the same for delegation: the boundary suite's delegation cases, a nested syndicate and the council example. Every session must hold the same events (the caller's, and each subagent's own), and every model must be sent the same requests.

What a hostile model, tool, message or store can do to the loop, what stops it and the test that proves it is [native loop security](/operations/native-loop-security.md); `tests/nativeFuzz.test.ts` fuzzes the loop and runs the forged answers through `runSyndicateTurn` on both runtimes.

## The agent

`NativeAgent` (`lib/runtime/native/request.ts`) is what a compiled agent gives a model request, in the YAML's spelling: name, description, model id, instruction, `globalInstruction`, tools in list order, output schema, `generateContentConfig` (with `reasoning:` mapped in, as `withReasoning` maps it), `includeContents`, `codeExecution`, `mode` (see [Task mode](#task-mode)), `context` (compaction, see [Compaction](#compaction)) and the transfer flags. A tool may be:

- an own Tool or a `defineTool` contract;
- a subagent tool (`subagentTool(agent)`, `lib/runtime/native/delegate.ts`), which runs another `NativeAgent`;
- an InstructionTool (few-shot examples, `preload_memory`);
- a NativeToolMarker ([server-side tools](/tools/tool-contracts.md));
- an own Toolset (the [skill harness](/tools/skill-harness.md)), expanded through its `getTools` before every request;
- an ADK tool or toolset an agent still lists (MCP and OpenAPI tools), read by its declaration and its `getTools`.

An ADK tool that carries an own Tool is read as that Tool. An ADK `AgentTool` fails the run when it is called: a subagent reaches the native loop as a subagent tool.

`compileNative` (`lib/compileNative.ts`) builds it from the same `AgentSpec` that `compileAdk` (`lib/compileAdk.ts`) turns into ADK's `LlmAgent`. `compileSpec` and `compileSubagentSpec` in `lib/compile.ts` make the spec once per agent: tools resolved and gated, the skills index in the instruction, the model resolved once, the `generateContentConfig` built for that model. Each resolved tool reaches the loop as the own Tool, InstructionTool or Toolset behind it, or as itself. `tests/compile.test.ts` compiles one fixture both ways and requires the same first request. `tests/nativeStep.test.ts`, `tests/nativeLoop.test.ts` and `tests/geminiNativeTools.test.ts` build their agents with it.

## The request

`buildModelRequest(agent, ctx)` builds the `ModelRequest` in ADK's order:

1. **Config.** The agent's `generateContentConfig`. The output schema joins it when the agent lists no tools, or when the model takes a schema beside tools (Gemini 2 and later on Vertex AI), and never in `mode: task`, where it is `finish_task`'s parameters. A config holding `tools`, `systemInstruction` or `responseSchema` is refused, as `LlmAgent` refuses it.
2. **System prompt.** Each piece is joined to the last by a blank line:
   - the identity lines, unless the agent may transfer to no one (an output schema rules transfer out);
   - the root agent's global instruction, then the agent's instruction. A string has its `{key}` placeholders filled from session state: `{key?}` is optional, a placeholder naming no state key stays as written, and a required key that is absent fails the request. In a workflow node's run, the request's `workflowScope` (the node's input and the outputs stored so far) also fills `{x.field}` and `<x.field from Node>` as ADK's workflow instruction scope does ([Workflow agent node](/overview/workflow-agent-node.md#the-instruction));
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
   - `set_model_response` is added when step 2 asked for it, except in `mode: task`, where `finish_task` takes its place (see [Task mode](#task-mode));
   - self-correction's reflection tool, `adk_handle_model_error`, comes last when the step has a `correction` and ADK's model class would declare it (see [Self-correction](#self-correction)).
   After the tools, each own Tool's `contents` hook adds to the history in the same order: `load_skill_resource` shows a binary file it just answered for as inline data, as ADK's own tool does in its `processLlmRequest`. Nothing it adds is stored.
5. **The rest.** Tool choice, the output schema or JSON mode, reasoning and sampling, each read by the shim mapping's own reader. `stream` is `false` unless the caller streams, and `signal` is the turn's.

Not done by the step: resuming a node tool that paused on an input request (workflows, WS4), `transfer_to_agent` (compiled syndicates delegate through tools, WS2-6), and an ADK tool's own request edits beyond its declaration.

## The call

The step is the adapter's caller, so it charges and traces ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)). The call goes through `traceLlmGeneration` with the adapter's provider, the agent's model id and the request, exactly as on the shim, so the step budget, the token charge and the `llm.request` span's attributes are the same on both runtimes. The adapter defaults to `resolveAdapter(agent.model)`, and a caller may hand it one leaf adapter.

The contract forbids an adapter to throw. A leaf that throws anyway (an ADK-era model class) is read as ADK reads it. With a `redirect` hook (a `fallback_model`), a provider-side failure (`errorDecision`, `lib/models/errorResponse.ts`) is handed to the hook as a retryable failed final, so the fallback answers when nothing was produced yet, as FallbackLlm's catch does. Any other thrown Error ends the step on ADK's error event for it (`LlmAgent.runAndHandleError`): code `UNKNOWN_ERROR`, or the `error.code` of a JSON error body, with the message, key-shaped text scrubbed. The turn then fails with that code instead of throwing. A throw that is not an Error, or one while the turn is stopping, is rethrown.

A stopped turn makes no call and no event. When the run's signal has aborted before the call, aborts during it, or the turn refuses the call (`STEP_LIMIT`), the step returns `stopped` with the turn's code and message (`CANCELED`, `DEADLINE_EXCEEDED`, `STEP_LIMIT`). The ADK runtime likewise drops the response of an aborted run.

## The event

Each response becomes ADK's event for it. The base event is created before the call with the run's id, the agent as author and the branch. Each response is first held to the contract (`contractModelResponse`, [the model contract](/models/model-contract.md#the-response)): a part the contract does not allow is dropped, and a call's name, id and arguments are coerced. Mapped as the shim maps it, it is merged into the base event, with a fresh id after the first. Then:

- a tool call with no id gets `adk-<uuid>`;
- a call to a long-running tool (`ask_user`) is listed in `longRunningToolIds`;
- a `set_model_response` call becomes its arguments as JSON text, with `skipSummarization`;
- an answer with no parts, no error and no usage makes no event;
- a Gemini adapter that stands for ADK's own Gemini (`standsForAdkGemini`, the same test `declaresReflectionTool` reads) gets no `turnComplete` on its events, since ADK's Gemini writes none. The events of both Gemini adapters (`GEMINI_ADAPTER=adk` or `engine`) are then the ADK runtime's, field for field ([ADR 0100](/decisions/0100-gemini-row-asserted-on-the-engine-adapter.md)).

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

`runAgentLoop(agent, ctx)` is an async generator. `ctx` is what the step takes besides the agent and its adapter (session, store, run id, user content, branch, memory, `stream`, signal), plus `adapterFor`, the leaf adapter for a model id (default `resolveAdapter`), `log` for the fallback's notice, `selfCorrection`, the turn's self-correction (default: retries at their defaults), `taskNode`, which marks the run as a `mode: task` workflow node's (see [Task mode](#task-mode)), and `nodeStamp`, which a workflow agent node passes to write its output and node path on each event before it is stored, after the outputKey and task hooks ([Workflow agent node](/overview/workflow-agent-node.md)). The session already holds the run's user event. The loop yields each partial as it arrives, never stored, then each event as the store returned it, so `drainAgentStream` reads it as it reads ADK's stream: streamed text reaches `onTextDelta`, and narration before a tool call is withdrawn with `onTextReset`.

Each step, after any compaction the agent's `context:` calls for (see [Compaction](#compaction)):

0. **A granted consent, then an answered approval.** Before the model step, the loop runs again the paused calls whose credential requests the latest user message answers (see [Consent](#consent)), then the pinned calls it approves or refuses (see [Approvals](#approvals)), and stores their responses.
1. **The model step.** With `fallback_model`, the step runs once per leaf adapter, by FallbackLlm's rules ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)). A retryable failure counts against the primary's circuit. When nothing was produced before it, the failure is not stored, and the fallback answers the same request under its own model id. An open circuit goes straight to the fallback.
2. **The calls.** The answer's calls run in parallel, each with its own state delta and actions, and their results are kept in call order:
   - a result that is not an object is wrapped `{ result }`, an array `{ results }`;
   - a result nested deeper than 64 levels answers `{ error: TOO_DEEP_RESULT }` in its place, since every later reader of the session recurses through it (`lib/runtime/valueDepth.ts`, [ADR 0101](/decisions/0101-native-loop-security-gate.md)); ADK keeps it;
   - a call naming no declared tool answers `Function <name> is not found in the toolsDict.`;
   - a tool that throws answers `Error in tool '<name>': <message>`;
   - with tool retries on, those two answer with reflection guidance instead (see [Self-correction](#self-correction));
   - a tool that requires approval asks for it: `requestedToolConfirmations` under the call's id, `skipSummarization`, and the pending notice as its answer;
   - a long-running call (`ask_user`) with no result answers nothing; its actions, when it set any, make an event with no content;
   - a call that asked for an OAuth grant answers `CONSENT_TEXTS.pending`, whatever it returned or threw, and self-correction does not count it.

   A subagent tool runs the subagent as its own child loop (see [Delegation](#delegation)). An own Tool runs through `execute`. An ADK tool an agent still lists that carries no own Tool runs through its `runAsync`, with a context shaped like ADK's. One call's response is its own event; several are merged into one, parts in call order, actions merged. Each call reads the state as the step left it, not the writes of another call in the same step.
   When the turn stopped while the calls ran, nothing is stored for them and the run ends `stopped`, as ADK drops the response.
3. **A credential request or an approval request ends the run.** A call that asked for a grant (`requestedAuthConfigs`) gets ADK's `adk_request_credential` call stored before the response, as ADK's `generateAuthEvent` writes it, and the run ends `paused` on it after the response is stored. For an approval, in place of the response, the loop stores ADK's `adk_request_confirmation` call: the original call and the confirmation as its arguments, an `adk-` id listed in `longRunningToolIds`, and the response's actions. The response itself is not stored, so a parallel call beside the gated one has no response.
4. **`outputKey`.** Each final event of the agent carries its text in `stateDelta` under the agent's `outputKey`, written before it is stored. With an output schema, the text is parsed and validated (`z.fromJSONSchema`), kept as text when it does not parse, and saved as parsed when it does not validate.
5. **Go on or stop.** The loop steps again unless the step's last event is final (ADK's `isFinalResponse`, unless it is an empty metadata event after tool calls), the turn stopped the step, or the step stored nothing. ADK's own ceiling of 500 model calls applies when no turn control is lower.

The generator returns an `AgentLoopEnd`:

| `reason` | when | also |
|---|---|---|
| `final` | the last event is a final answer: text, a `set_model_response` answer, a response that skips summarization; or, in a task node's run, `finish_task`'s successful answer | `lastEvent`; `output`, a task node's output |
| `paused` | a call waits on a person: an `ask_user` call with no response, an approval request, or a credential request | `pending`, the waiting call ids |
| `error` | the last event carries a failed call's error, among them a model that thinks but never answers ([ADR 0027](/decisions/0027-thinking-without-answer-is-an-error.md)) | `lastEvent` |
| `stopped` | the turn stopped a step (cancel, deadline, `max_steps`); nothing was stored for it | `stop`, the turn's code and message |
| `empty` | the model answered nothing | |

## Compaction

An agent with `context: { compact_after_tokens, keep_recent_events?, summary_model? }` ([ADR 0033](/decisions/0033-context-task-code.md)) compacts on the native loop as ADK's `TokenBasedContextCompactor` and `LlmSummarizer` do. `lib/runtime/native/compaction.ts` is a rule-for-rule port, and the loop calls `compactBeforeStep` before every step ([ADR 0078](/decisions/0078-native-compaction-ports-adk-compactor.md)).

1. **When.** The active events are the latest compaction and what follows it, in the run's isolation scope. Three things must hold:
   - they hold more raw events than `keep_recent_events` (default 6);
   - the cut leaves something to summarize. It starts `keep_recent_events` from the end, and moves back while it would separate a call from its answer;
   - the prompt size passes `compact_after_tokens`. The size is the latest active event's `usageMetadata.promptTokenCount`. When no active event carries one, it is the agent's projected history (text, and each call and answer as JSON) in characters, divided by 4 and rounded up.
2. **What.** The raw events before the cut, after the active compaction when there is one, so a later summary folds the earlier one in.
3. **The call.** One user message: ADK's default summary prompt, then `[Event i - Author: <author>]` and the event's text, thoughts aside, per event. There is no system prompt and there are no tools, and the call is not streamed. It goes to `summary_model`, or the agent's own model, through `adapterFor` with no fallback. Like the step, it runs through `traceLlmGeneration`: it counts toward `max_steps`, charges the turn, and opens an `llm.request` under `agent.invoke`, outside any `model.call`, where ADK's sits under `invoke_agent`, outside `call_llm`. A first response with no text throws `LLM failed to return a valid summary.`, and the turn fails, as on ADK.
4. **The event.** ADK's compacted event, field for field:
   - author `system`, no invocation id;
   - content `{ role: 'model', parts: [{ text }] }`;
   - `isCompacted: true`, `startTime` and `endTime` (the first and last summarized events' times), and `compactedContent`;
   - the run's isolation scope.

   The loop stores it and yields it before the step, so the step's request already reads `[Previous Context Summary]:` in place of the events up to `endTime`. The full history stays stored. A turn that stopped during the summary stores nothing. The event is not the run's `lastEvent`. In a workflow node's run, the event passes through `nodeStamp` before it is stored, as ADK's node runner stamps it; the outputKey, task and temp-state hooks never see it.

`tests/compaction.test.ts` runs ADR 0033's cases on both runtimes and requires the same stored events and the same request to every adapter: directly on the loop, and through `runSyndicateTurn` with `runtime: 'native'`. It continues a session compacted on one runtime on the other, and compares the ledger rows of a compacting turn.

## Self-correction

`lib/runtime/native/selfCorrection.ts` does what ADK's reflect-and-retry plugins do on the ADK runtime ([ADR 0034](/decisions/0034-self-correction.md), [ADR 0075](/decisions/0075-native-self-correction-ports-adk-plugins.md)). The texts, ids and counts are the same, so both runtimes store the same events. A `SelfCorrection` is built from the syndicate's `retries:` and holds one turn's counters, kept per run id.

**The model side** (`retries.model_errors`, default 2; `0` turns it off), through the step's `correction`:

- `adk_handle_model_error` ("A tool that triggers reflection. …", no parameters) is one of every step's tools, after the agent's. ADK's plugin puts it in the request's toolsDict alone, so the model is told of it only where ADK's model class declares the toolsDict ([ADR 0097](/decisions/0097-reflection-tool-declared-where-adk-declares-it.md)). `declaresReflectionTool` decides per adapter: a Gemini adapter stands for ADK's own Gemini, which sends only the request's config, and is not told of it, unless a caller handed it over behind `adkShim` (`servedThroughShim`, set by `nativeAdapterFor`); every other adapter is told of it, as the shim and the engine's ADK classes declare it. A workflow node agent follows the same rule, as ADK's node agents run under the Runner's plugins. Declared or not, the step can run the tool.
- Two kinds of response are replaced by ADK's reflection call, with id `adk_handle_model_error_<uuid>` and the arguments `response_type`, `error_type`, `error_details`, `finish_reason` and `retry_count`:
  - a response that calls that tool itself (`RESERVED_TOOL_CALL`);
  - a response whose finish reason is `MALFORMED_FUNCTION_CALL`. A Gemini adapter on the contract reports it as the error's code, which the genai mapping reads back as the finish reason, as ADK's Gemini reports both ([ADR 0088](/decisions/0088-native-parity-followups.md)), so a malformed call is retried on both runtimes.
- On a Gemini adapter the reflection call is signed, where ADK's plugin stores it unsigned ([ADR 0103](/decisions/0103-workflow-retry-spelling-and-signed-reflection-call.md)). `reflectionSigning(adapter, model)` decides: the call carries the replaced response's `thoughtSignature` (its first call's, else its first signed part's), or, on a Gemini 3 model, Gemini's placeholder `skip_thought_signature_validator` when the response had none, as after a `MALFORMED_FUNCTION_CALL`. Gemini 3 rejects a request whose current turn holds an unsigned call, so on native the next request passes; on ADK it gets Gemini's 400. Every other provider's reflection call is stored unsigned, as on ADK. This is the one field in which a native self-correction event differs from ADK's.
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
- a partial resets the model count.


## Task mode

`mode: task` ([ADR 0033](/decisions/0033-context-task-code.md), [ADR 0081](/decisions/0081-native-task-mode-ends-a-node-on-finish-task.md)) runs on native as ADK 2.2 runs it, in `lib/runtime/native/taskMode.ts`:

- **The tool.** The request declares `finish_task` after the agent's own tools and before the reflection tool. Its parameters are the agent's output schema, or ADK's default (`result`, a string summary) when it has none. A schema whose `type` is not Gemini's `OBJECT` is wrapped under `result`, a lowercase `object` included, as ADK compares it to `Type.OBJECT`. Its description and the line it adds to the instruction are ADK's, word for word.
- **The answer.** A call missing a top-level required key answers ADK's error naming the keys; any other call answers `Task completed.` (stored `{ result: "Task completed." }`).
- **The schema.** The output schema is never the response schema in task mode. The `set_model_response` line still joins the instruction when an output schema sits beside tools on a model that cannot take both, as ADK's instruction processor writes it, though no `set_model_response` tool is declared.
- **How it ends.** A run marked `taskNode` holds the latest `finish_task` call's arguments, and the event that answers it with success gets, before it is stored, `output` (the arguments, unwrapped from `result` when they were wrapped), `nodeInfo.messageAsOutput`, and the output under the agent's `outputKey` in its `stateDelta`. The run then ends `final` with that `output`, never asking the model again, as ADK's `runTaskMode` ends a workflow node. A plain run goes on after the answer, as `LlmAgent.runAsync` does; the schema allows `mode: task` on workflow nodes only, where the [workflow agent node](/overview/workflow-agent-node.md) sets `taskNode` and stamps the node's path.

`code_execution: gemini` needs nothing of its own in the loop: the request asks Gemini for its code-execution tool (`code_execution` first among Gemini's own), the Gemini adapter returns the code and its result as carried parts on the next part ([ADR 0065](/decisions/0065-gemini-carried-parts-and-server-side-invocations.md)), and the event stores them as ADK's does: the genai mapping writes them out as the `executableCode` and `codeExecutionResult` parts Gemini sent, with their signatures, before the part that carried them ([ADR 0100](/decisions/0100-gemini-row-asserted-on-the-engine-adapter.md)). A history holding raw `executableCode` and `codeExecutionResult` parts (as ADK's own Gemini class stores them) is read as fenced text, as ADK's code-execution processor reads it.

## Approvals

A tool listed in an agent's `require_approval` does not run when called ([ADR 0028](/decisions/0028-approval-gates.md)): the loop stores ADK's `adk_request_confirmation` call and the run ends `paused` (step 3 above). The person's answer is the next user message: a function response to that call carrying `{ confirmed }` (`approvalResponsePart`, `lib/runtime/approvals.ts`), or the same as JSON under `response`.

`lib/runtime/native/interrupts.ts` reads it before every step, as ADK's request-confirmation processor does ([ADR 0077](/decisions/0077-native-approvals-port-the-confirmation-processor.md)):

1. **The answers** are the `adk_request_confirmation` responses in the latest user event, events on another branch left out. With none, the step goes on as usual.
2. **The gates** are the `adk_request_confirmation` calls whose ids the answers name:
   - a request authored by the user is refused (`untrusted_request`);
   - a request authored by another agent is skipped;
   - a request whose pinned call has no id or name is refused (`malformed_request`);
   - a request whose pinned call this agent has already answered is skipped, so a later step never runs the call again.
3. **The binding.** Each pinned call must match a call this agent made, by id. Its tool must be one of the agent's tools. Its name and arguments must equal the call's. The tool must require approval, or have asked for it through `requestConfirmation`. A pinned call that fails a check is refused with ADK's `IntentMismatchError` text, "Tool confirmation rejected for function call '<id>': <reason>.", and nothing runs or is stored. The loop throws it, as the ADK runtime throws it out of the turn.
4. **The run.** The bound calls go through the loop's own call path, with the answer in their context (`confirmation`, and `toolConfirmation` for an ADK tool):
   - an approved call runs its tool;
   - a refused call answers "This tool call is rejected.";
   - self-correction and the `tool.execute` span apply as to any call, under the run's agent span.

   Their response is stored as its own event before the step builds its request, so the model reads the result. Only the pinned call runs: a call that ran beside it in the paused step keeps no response.

An approval opened on either runtime resumes on the other. A plain-text "yes" is not an answer (ADK's `plainTextToolConfirmation`, which no surface turns on).

## Consent

With `credentials` (the run's credential store, pinned to its app) each call's `accessToken(provider)` reads the user's grant ([ADR 0072](/decisions/0072-tool-credentials-sealed-per-user.md)). With `consent` as well, a call whose provider the user has not granted asks for it, and the run pauses on ADK's `adk_request_credential` call (step 3 above) ([ADR 0085](/decisions/0085-oauth-consent-pauses-on-adks-credential-request.md), [tool contracts](/tools/tool-contracts.md#the-consent-step)). The request's `auth_config` carries the authorization URL and the state nonce, never the client secret or the PKCE verifier, which stay in the consent step.

Once the server's callback has stored the grant, `runSyndicateTurn` stores the person's next message as the request's answer, `{ credentialKey, granted: true }` (`credentialResponsePart`, `lib/runtime/credentials.ts`). `grantedCalls` in `lib/runtime/native/interrupts.ts` reads it before every step, ahead of the approval resume, as ADK's auth preprocessor runs ahead of request-confirmation:

1. **The answers** are the `adk_request_credential` responses in the last event with content, which must be the user's.
2. **The requests** are this agent's `adk_request_credential` calls with those ids. An answer naming none, or not granting the request's `credentialKey`, is ignored, as ADK ignores an answer that does not bind. A request an earlier grant already bound is closed, so a replayed grant runs nothing, as a replayed approval runs nothing; ADK would run the call again ([ADR 0101](/decisions/0101-native-loop-security-gate.md)).
3. **The run.** The calls the requests name (`function_call_id`) run again, from the latest event this agent authored that made them, through the loop's own call path, and their response is stored before the step builds its request. The history keeps the call and its latest answer side by side, as ADK's content processor does, so the model reads the result and not the pending notice. A later step finds the agent's own events last, so the call runs once. A call that asks again pauses the run on its new request.

ADK's preprocessor differs in two places. It re-runs the call from the latest event of any author, so a call forged into a user event under the paused call's id would run with the forged arguments; the loop reads only the agent's own events ([ADR 0101](/decisions/0101-native-loop-security-gate.md)). And its answer carries the authorization response, which it exchanges in-process with the client secret its request event stored. Here the callback route exchanged the code before the message arrived, so the answer carries no credential. On the ADK runtime an open credential request is refused before any model call (`UnsupportedOnRuntimeError`). A delegated subagent's loop gets the parent's credentials but no consent step.

## Questions

An `ask_user` call ([ADR 0031](/decisions/0031-ask-user.md)) is a long-running call: the tool returns nothing, the model event lists the call in `longRunningToolIds`, and the run ends `paused` with the call's id in `pending` and no response stored. While it is open, `runSyndicateTurn` stores the person's next plain-text message as the call's function response, `{ result: <text> }` (`questionAnswerPart`, `lib/runtime/questions.ts`), and runs the agent that asked: the orchestrator, or in plan-dispatch the route, its interrupted turn replayed raw.

The loop needs no resume of its own for it ([ADR 0079](/decisions/0079-native-questions-resume-through-the-history.md)). The first step's history holds the call and the answer side by side (the answer is moved next to its call, as ADK's content processor moves it), so the model reads the answer as the call's result and the agent continues its tool loop. ADK's request-input processor, which runs between the request-confirmation processor and compaction, re-runs only a node tool (a workflow run as a tool) paused on an `adk_request_input` call; it returns before doing anything for an agent that lists no node tool, and no native agent lists one. When workflows run natively, that resume belongs in `interrupts.ts`, in the same place in the order.

Only an agent asks. An `ask_user` call in an event the user authored is no question, so a forged call never takes the next message as its answer, on either runtime, as approvals refuse a user-authored request ([ADR 0088](/decisions/0088-native-parity-followups.md)).

A question opened on either runtime is answered on the other. `tests/questions.test.ts` and `tests/questionsA2a.test.ts` run every conversation on ADK, on native, and with the runtime switched between the question and the answer, and require the same results and stored events; `tests/nativeQuestions.test.ts` runs the conversation directly on `runAgentLoop`, and answers the question session fixture 04 holds, which ADK stored.

## Delegation

A DELEGATE syndicate's orchestrator lists each subagent as `subagentTool(agent)`: named for the agent, described by its description, with one string parameter `request`, as ADK's `AgentTool` declares it. A `yaml_reference` subagent is the nested syndicate's orchestrator under the entry's name and description, listing its own subagent tools. The compile refuses a `yaml_reference` chain that reaches itself, or that goes past 16 levels, by name and before any model call, on both runtimes ([ADR 0101](/decisions/0101-native-loop-security-gate.md)). `runCall` asks `subagentOf(tool)` before the generic path, and `runSubagent` (`lib/runtime/native/delegate.ts`) runs the call as `AgentTool.runAsync` runs it ([ADR 0074](/decisions/0074-native-delegation-runs-a-child-loop-as-agent-tool-does.md)):

1. **The subagent's own session.** It is `{ appName: <subagent name>, userId, sessionId }` in the caller's store, not a branch of the caller's session. The first call creates it from the caller's state (the session's, then the call's writes, `temp:` keys dropped). Every later call, in this turn or another, continues it, so the subagent sees its earlier requests and answers.
2. **The request as a message.** `{ role: 'user', parts: [{ text: request }] }` is stored as a user event under a fresh `e-<uuid>` invocation id. A turn already stopped answers `''`.
3. **The child loop.** The subagent runs on `runAgentLoop` as its run's root: not streamed, under the turn's controls and signal (its calls count toward `max_steps`), with the caller's memory and adapters. None of its events reach the caller's stream or session.
4. **State out.** Each event the child stores has its state writes, `temp:` keys aside, written into the call's state delta. They land on the caller's response event, an `outputKey` write among them.
5. **The answer.** The result is the last event's non-thought text, joined by newlines, or `''` when it has no parts (a failed model call, a pause). With an output schema it is parsed as JSON, and text that does not parse fails the call with the parser's message. Once the turn has stopped, no further child events are read.

A `yaml_reference` to a workflow syndicate is a `workflowSubagentTool` instead, holding the whole graph ([ADR 0098](/decisions/0098-workflow-subagent-and-node-approvals.md)). `runCall` asks `workflowSubagentOf(tool)` next, and `runWorkflowSubagent` runs the call as steps 1, 4 and 5 say, with the graph's walk (`runNativeWorkflow`, which `lib/compileNative.ts` hands over) in place of steps 2 and 3: the walk stores the message and yields the events ADK's Runner yields for a `Workflow` root, and the answer is the last one's text, never parsed. A node that gave up fails the call ([As a subagent](/overview/workflow-scheduler.md#as-a-subagent)).

Calls to subagents in one step run one after another, in call order, as ADK runs them. A pause inside a subagent (an `ask_user` call, an approval request) cannot reach the caller ([ADR 0028](/decisions/0028-approval-gates.md)): the child run ends paused, the call answers `''`, and the gated tool never runs. The DELEGATE relay fallback stays in `runSyndicateTurn`, which reads the drained run from either runtime.

Not done by the loop: transfer (`transfer_to_agent`), running subagents concurrently (WS6), and a pause inside a subagent reaching the caller (WS6-2a).

A `temp:` key a tool writes is visible to the rest of the run, as ADK's live session state makes it: the next step's instruction placeholders, its toolsets, and the next step's calls read it. The loop reads each event's `temp:` keys just before the store drops them, and lays them over the session's state when it builds a request or a call's context (`lib/runtime/native/tempState.ts`). They are never written into the session object, since a store that saves the whole session would keep them.

## The runtime flag

`lib/runtime/runtimeFlag.ts` names the runtime: the turn's `runtime` option (`adk` or `native`), else `MELCHIZEDEK_RUNTIME`, else `native` (`DEFAULT_RUNTIME`, [ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md)). Any other value is a configuration error. `describeRuntime` returns the runtime and where it came from, which `melchizedek-doctor` prints. The wiki agent runner (`lib/wiki/agentRun.ts`) follows the same flag, with a `runtime` option of its own.

`@google/adk` is an optional peer. The native runtime loads none of it; `lib/adkPeer.ts` is the one module that tries to, once, and hands out ADK's own base classes when it is installed and stand-ins when it is not. The stand-ins construct as ADK's do and carry ADK's `Symbol.for` marks, so the registry's FunctionTools, the model shims and the session stores still carry their own Tool, adapter or store to the native loop; a method only ADK calls throws `AdkNotInstalledError`. The adk runtime, `compileGraph`, `compileWorkflow`, the retry plugins and `GEMINI_ADAPTER=adk` ask for ADK through `requireAdk`, and fail before any model call with an error that names the package.

On `native`, `runSyndicateTurn` keeps its own logic (routing, guards, the relay fallback, approvals and questions read from the stored events) and swaps only what runs one agent. `runNativeAgent` (`lib/runtime/nativeTurn.ts`) does what ADK's `Runner` does before the agent runs:

1. It reads the session, which must exist.
2. It stores the message as the user's event under a new `e-` invocation id.
3. It runs `runAgentLoop`, with the turn's one `SelfCorrection`, built from the syndicate's `retries:` as the ADK path installs its retry plugins.

The turn runner wraps the stream in `traceAgentRun` with the same metadata on either runtime, so the turn's root span sits over the loop's [spans](#the-spans).

The turn runner drains the events through `drainAgentStream`, so the result has the same shape: text, grounding, usage, a pending approval or question, errors. The adapter for each model id is the one behind what `CompileOptions.resolveModel` returns: a contract adapter itself, an ADK shim's own adapter, or, for `TracedGemini`, `resolveAdapter` under the key the instance carries, so a caller's BYOK key pays on either runtime. An id gets `resolveAdapter` for the id (`nativeAdapterFor`). Any other ADK model class has no adapter behind it and is refused (below). `nativeAdapterFor` resolves each agent's `fallback_model` and compaction `summary_model` when it is built, as `compileAdk` does at compile time. The request goes out under the id ADK's `LlmAgent` sends it under: the resolved model object's own id, else the id the resolver returned, else the YAML's (`wireModelOf` in `lib/compileNative.ts`). A resolver that answers `scripted/boss` with a model under `claude-sonnet-4-6` therefore has the adapter, the span and the circuit breaker see `claude-sonnet-4-6` on both runtimes; `nativeAdapterFor` maps that id, for the agent and each delegated subagent, back to what the resolver returned. A per-request Vertex AI endpoint does not reach a native call yet. Memory search goes to the engine's `MemoryService`, or to an ADK-only service's `searchMemory`. A single agent, a DELEGATE syndicate (each subagent a `subagentTool` holding its own compiled agent, a remote one the A2A tool ADK's runtime runs too), a plan-dispatch syndicate (the classifier and a local route) and a `workflow:` syndicate (the engine's scheduler, through `runNativeWorkflow`; [the native turn](/overview/workflow-scheduler.md#the-native-turn)) run on native. `tests/nativeTurn.test.ts` runs conversations both ways and requires the same results and the same stored events.

The turn-level suites run every case on both runtimes in every `npm test` through `tests/helpers/runtime.ts` ([ADR 0084](/decisions/0084-dual-runtime-suites-in-every-test-run.md)), and CI runs the offline suite a second time with `MELCHIZEDEK_RUNTIME=adk`, so every other suite runs on both runtimes too. `tests/optionalAdk.test.ts` and `tests/packageSurface.test.ts` run every shipped syndicate on the default runtime in a process where `@google/adk` cannot be resolved, from source and from the build. A case native cannot run yet is skipped with its reason and ticket; none is left. A case native refuses by design asserts the refusal on native (the model-switch cases, whose resolver returns a custom ADK class).

What native does not run yet fails before any model call, with an `UnsupportedOnRuntimeError` that names the feature and the runtime:

| Refused | where | until |
|---|---|---|
| an `ask_user` tool on a workflow node's agent (the schema refuses it on both runtimes; this catches a config that skipped validation) | `refuseOnNative` | a ticket that lets an agent node pause |
| a tool node whose tool is unregistered or long-running, with ADK's compile-time message (ADK refuses it too) | `refuseUnrunnableNodes` (lib/workflow/turn.ts) | none planned |
| a caller's `transformAgent` (it transforms ADK agents) | `refuseOnNative` | none planned |
| an ADK model class from `resolveModel` that is neither a shim nor ADK's Gemini (an agent's model, a subagent's, `fallback_model`, `summary_model`); the message names `adkShim(adapter)` as the way to run it ([ADR 0088](/decisions/0088-native-parity-followups.md)) | `compileNative`, `nativeAdapterFor` | none planned: wrap an adapter in the shim |

A turn that paused on either runtime (an approval request, an `ask_user` call) stored ADK's own events, and resumes on either runtime: an approval as [Approvals](#approvals) describes, a question as [Questions](#questions) describes.

## The spans

A native run writes the same ledger rows as an ADK run ([ADR 0076](/decisions/0076-native-loop-spans-feed-the-same-ledger.md)). The ledger reads a turn's spans, and ADK opens three that it depends on, so the loop opens the same three under its own names, in scope `melchizedek.runtime` (`lib/runtime/native/telemetry.ts`):

| the loop's span | ADK's | covers | the ledger reads |
|---|---|---|---|
| `agent.invoke <name>` | `invoke_agent <name>` | the agent's run, opened when the run starts | the agent of every `llm.request` below it (`adk_telemetry.agent`) |
| `model.call` | `call_llm` | one step, with its `llm.request` (two when a fallback answers) | the step's payload row in `adk_payloads` |
| `tool.execute <name>` | `execute_tool <name>` | one tool call, under the agent span | its duration, in `adk_turns.tool_ms` |

`agentLoop.ts` opens them through three hooks: `traceAgentInvocation` around the run, `traceModelCall` around each step and `traceToolCall` around each call. A workflow turn adds `workflow.invoke` and `node.execute` around them, and `tool.execute` around a tool node's call ([the workflow's spans](/overview/workflow-scheduler.md#the-spans)). The tracer's lineage and the exporter read both naming schemes through `lib/observability/lineage.ts`. Like ADK's, the loop's spans reach the in-process listeners and the ledger, and are printed only with `OTEL_CONSOLE_ALL_SPANS=true`.

What they carry:

- **ADK's `gen_ai.*` attributes**: operation, agent name and description, conversation id, tool name and call id, usage and finish reason. `gen_ai.request.model` is the agent's model, as on `call_llm`; `gen_ai.system` is the provider of the adapter that answered.
- **A step's payload.** A `model.call` whose call did not fail carries `llm.payload.request` (the `ModelRequest`, its signal left out) and `llm.payload.response` (the adapter's final response). A failed step carries none: its `llm.request` carries the failed call's payload, as on ADK, where a failed `call_llm` never ends. With `TELEMETRY_PAYLOADS=off` nothing is recorded.
- **No tool arguments or results.** The root span's `ToolCall` and `ToolResponse` events hold them. A tool span records `tool.error` for an error response and `tool.pending` for a long-running call that answered nothing.
- **How the run ended** on the agent span: `agent.end_reason`, `agent.steps`, and `agent.stop_code` for a stopped run.

The rows differ from ADK's in two places. A step's own payload row holds the engine's request and response shapes, and its `provider` column names the provider where ADK's says `gcp.vertex.agent`. And a step's calls run side by side, so `tool_ms` sums their durations where ADK's sum is wall time. The root span is the turn runner's: `runSyndicateTurn` wraps the native stream in `traceAgentRun` with the same metadata as ADK's ([the runtime flag](#the-runtime-flag)).
