---
type: subsystem
title: Native loop
description: "The native runtime's agent loop (lib/runtime/native/): one model step builds the request the ADK runtime would send for the same agent and session, calls the adapter under the turn's controls inside one llm.request span, and stores the answer as the event ADK would store. What the request holds and in what order, how the history is projected, what a stopped turn records, and what the step returns."
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
  - resource: tests/nativeStep.test.ts
---

# Native loop

The native runtime runs an agent's turn without ADK ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)). It lives in `lib/runtime/native/`, and `runSyndicateTurn` does not select it yet (the runtime flag is WS2-10). Its unit is one **model step**, `runModelStep` in `lib/runtime/native/step.ts`: build the request, call the adapter, record the answer. Running the answer's tool calls, and looping until there are none, is WS2-5b.

Every piece matches the ADK runtime, so a session either runtime wrote is one the other continues ([ADR 0066](/decisions/0066-native-step-sends-the-adk-request.md)). `tests/nativeStep.test.ts` runs syndicates on ADK with a scripted adapter behind the [ADK shim](/models/adk-shim.md), then rebuilds each call on the native step from the session as it stood before the call. The adapter must be handed an equal request, and the store must hold an equal event, id and time aside.

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

A partial event goes to the caller's `onPartial` and is never stored. The final event is stored through `SessionService.append`, which applies the store's rules ([sessions](/memory/sessions.md)).

## What a step returns

`ModelStepResult` holds:

- the request sent;
- the stored event and the adapter's final response;
- the answer's text and the thinking the partials showed (a final never holds thinking);
- the tool calls with their ids as stored, and the long-running ids among them;
- the error of a failed call (stored on the event as ADK stores it);
- `stopped`, for a turn that stopped.
