---
type: decision
title: "ADR 0066: The native loop's model step sends the request the ADK runtime sends, and records its answer as ADK's event"
description: "One step of the native loop (lib/runtime/native/step.ts) builds its ModelRequest from the agent and session as ADK's LlmAgent and tools build theirs, read through the shim's own mapping: identity lines, root global instruction, state placeholders, tool instructions in list order, the history as ADK's content processor projects it, set_model_response for an output schema beside tools, server-side tools only where ADK sends them. It charges and traces through traceLlmGeneration as the shim does, builds the event from the mapped response as ADK merges it, and makes no event for a stopped turn. A request built from the contract's ideal, a contract-native tracer, an event built from the ModelResponse and a stored refusal event were rejected."
tags:
  - decision
  - runtime
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/native/request.ts
  - resource: lib/runtime/native/history.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/models/genaiMapping.ts
  - resource: tests/nativeStep.test.ts
---

# ADR 0066: The native loop's model step sends the request the ADK runtime sends, and records its answer as ADK's event

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) builds the native runtime beside ADK, behind `MELCHIZEDEK_RUNTIME`, and requires that a session one runtime wrote resumes on the other. Its first piece is one model step: build the request, call the adapter, record the answer. The pieces it calls exist: the model contract ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)), `TurnEvent` and `SessionService` ([ADR 0052](/decisions/0052-sessions-and-events-on-own-interfaces.md)), own tools, instruction tools and markers ([ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md), [ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md), [ADR 0062](/decisions/0062-server-side-tools-as-markers.md)), and `resolveAdapter` ([ADR 0060](/decisions/0060-engine-owned-registry.md)).

On the ADK runtime, the request an adapter receives is not the agent's YAML read directly. ADK's `LlmAgent` request processors and each tool's `processLlmRequest` build an `LlmRequest`, and the shim maps it (`llmRequestToModelRequest`). Along the way ADK:

- adds identity lines ("You are an agent. Your internal name is …") unless the agent may transfer to no one;
- fills `{key}` placeholders in a string instruction from session state, and refuses a required key that is absent;
- projects the session's events per agent: it retells another agent's turns as context, drops approval and credential calls, moves a late tool answer next to its call, and strips its own `adk-` call ids;
- turns an output schema beside tools into a `set_model_response` tool plus an instruction line, except on Gemini 2 and later on Vertex AI;
- sends each server-side tool only where its sentinel puts it: `web_search` everywhere, `url_context` and `google_search` on Gemini, `x_search` and `collections_search` on xAI.

ADK also builds the stored event by merging the model's response into an event created before the call. It drops the response when the run's signal has aborted, so a stopped turn stores nothing for the call.

Five choices had real alternatives: what request to send, how to charge and trace the call, how to build the event, what a stopped turn records, and what form the agent takes.

## Decision

1. **The request is the ADK runtime's request.** `buildModelRequest` (`lib/runtime/native/request.ts`) follows ADK's processors in their order, and every ADK rule listed above. It reads the agent's config with the mapping's own readers: `reasoningOf` and `systemText`, and `toolChoiceOf` and `samplingOf`, which `lib/models/genaiMapping.ts` now exports. It declares tools through `contractToolDeclaration`, and reads server-side tools through `nativeToolOf`. It reads the history with `projectHistory` (`lib/runtime/native/history.ts`), a port of ADK's content processor over TurnEvents, and maps it with `contentsToMessages`. It throws where ADK throws: a required state key that is absent, a Gemini-only tool on another model, a config field `LlmAgent` refuses. `tests/nativeStep.test.ts` runs syndicates on ADK behind the shim and rebuilds each call on the native step, and requires an equal request.
2. **The caller charges and traces as the shim does** ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)). The step calls `traceLlmGeneration` with the adapter's `provider`, the agent's model id and the request. The adapter's responses pass through `modelResponseToLlmResponse` inside the span, with the original `ModelResponse` carried beside each, so the refusals, the token charge and the span's attributes are the shim's.
3. **The event is ADK's event.** The step creates the event before the call (run id, agent as author, branch) and merges each mapped response into it, a fresh id for each response after the first. It then applies ADK's rules: an `adk-<uuid>` id for a call without one, `longRunningToolIds` for long-running tools, and `set_model_response` rewritten to its arguments as JSON text with `skipSummarization`. A final event is stored through `SessionService.append`. A partial goes to the caller's `onPartial` and is never stored. The stored JSON equals ADK's for the same answer, id and time aside, which the same test asserts.
4. **A stopped turn makes no call and no event.** When the run's signal has aborted before the call, or aborts while it runs, or the turn refuses the call (`STEP_LIMIT`), the step returns `stopped` with the turn's code and message, as `runSyndicateTurn` reports a stop from the turn's control.
5. **The agent is the compiled agent's fields, in the YAML's spelling.** `NativeAgent` holds the name, description, model id, instruction, global instruction, tools in list order, output schema, `generateContentConfig` (with `reasoning:` mapped in), `includeContents` and `codeExecution`. The tools may be own Tools, contracts, InstructionTools and markers, and during the dual period the ADK tools and toolsets an agent still lists (an AgentTool, MCP and OpenAPI tools, the skills toolset), read by declaration and by `getTools`. The compile split (WS2-10) builds it from the agent spec.

Two things stay out of the step. Self-correction's `adk_handle_model_error` tool, which `runSyndicateTurn`'s reflect-and-retry plugin adds on the ADK runtime, comes with WS2-8. Resuming an approval or an input request, which ADK's processors do before the request, comes with WS2-7.

## Alternatives considered

- **Build the request from the contract's ideal.** That means an output schema beside tools, server-side tools named everywhere for each adapter to keep or drop, and no identity lines. It is the request the contract allows, and WS6-1 moves there for structured output with delegation. But the model would see a different prompt and different tools depending on the runtime, and a turn would change behaviour when the default flips at 0.19.0. G2's cross-runtime resume and the boundary suite under both runtimes rest on the same request. Each departure gets its own ticket and ADR, made on both runtimes at once.
- **A contract-native tracer**, the tracing `ModelAdapter` decorator ADR 0053 deferred. It is cleaner for the native runtime, but it is a second implementation of refusals, charges and span attributes that has to be held equal to the first. Mapping each response once inside the existing tracer makes the ledger identical by construction. The decorator stays open for WS2-11's telemetry work.
- **Build the event from the `ModelResponse` directly.** It avoids the genai round trip, but it is a second mapping of finish reason, usage, grounding, error verdict and parts into the stored JSON, which ADR 0045 fixes. Building from the mapped response makes the event the one ADK stores.
- **Store a refusal event for a stopped turn.** It would leave a trace in the session, but the ADK runtime stores none. A session that resumes on either runtime would then differ, and the turn already reports the stop from its control.
- **Contract-shaped settings on the agent** (`reasoning`, `sampling`, `toolChoice` instead of `generateContentConfig`). This is a cleaner type, but the YAML and the compiler speak `generateContentConfig`. A second reading of it would drift from the mapping's, which is what the ADK path's request is held to.

## Consequences

- WS2-5b runs the step in a loop. The step's result gives it the stored event, the text, the thinking from the partials, the tool calls with their stored ids, the long-running ids, and the declared tools by name. A `set_model_response` call ends the step as ADK's does.
- `lib/models/genaiMapping.ts` exports `toolChoiceOf` and `samplingOf`, reachable as `melchizedek-agents/models/genaiMapping` through the existing `./models/*` pattern. The native modules are not in the `exports` map.
- The native step imports `lib/models/registry.ts` (for the default adapter) and the genai mapping, both of which load `@google/*`. It goes ADK-free when ADK leaves at 1.0, with the stored history's genai shape still read through the mapping ([ADR 0048](/decisions/0048-engine-owned-model-contract.md) item 8).
- An ADK tool's `processLlmRequest` side effects beyond its declaration do not reach the native request. An own tool states what it writes through `instruction(ctx)`. Every registry tool is own or a marker, and the skills toolset's index is part of the instruction.
- State placeholders read the session's own keys only, so `{constructor}` is an absent key here, where ADK's `in` check would read the prototype. Placeholders are found by one linear scan, not by ADK's regular expression, which backtracks on a long run of braces.
