---
type: decision
title: "ADR 0056: GptLlm and GrokLlm keep the Responses usage meaning and the server-side tool record on the ADK path"
description: GPT and Grok move onto the model contract as GptAdapter and GrokAdapter behind the ADK shim. GptLlm overrides the shim's one response hook so ADK's events keep output_tokens with reasoning included, the server-side tool calls on customMetadata, and no groundingMetadata. This refines ADR 0053's consequence that shimmed adapters align with Gemini's usage meaning. Aligning with Gemini's meaning, a contract field for server-side calls, and a GptLlm that bypasses the shim were rejected.
tags:
  - decision
  - models
  - telemetry
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/gptLlm.ts
  - resource: lib/models/gptAdapter.ts
  - resource: lib/models/adkShim.ts
  - resource: lib/observability/tracer.ts
  - resource: tests/responsesAdapter.test.ts
---

# ADR 0056: GptLlm and GrokLlm keep the Responses usage meaning and the server-side tool record on the ADK path

## Context

GPT and Grok move onto the engine's model contract ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)) as `GptAdapter` and `GrokAdapter`. `GptLlm` and `GrokLlm` become the ADK shim around them ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)), so the registry and every consumer keep their classes. The shim maps each `ModelResponse` back through `modelResponseToLlmResponse` (`lib/models/genaiMapping.ts`), and that mapping loses three things these providers' events have always carried:

- **The output count.** The mapping writes usage in Gemini's meaning, where `candidatesTokenCount` excludes thinking. The earlier `GptLlm` wrote `output_tokens` there, reasoning included. The tracer reads `candidatesTokenCount` for `llm.tokens.output`, the turn's output charge (budgets, the task log) and the root span's `syndicate.tokens.output`, and the ledger's `output_tokens` column is `llm.tokens.output`. Under Gemini's meaning a GPT or Grok call would count fewer output tokens than it did the day before, by its reasoning. A reasoning-heavy Grok call can lose three quarters of its count: 1,247 tokens become 304.
- **The server-side tool calls.** Web and X searches run inside one Responses call and never come back as function calls. `GptLlm` put them on the final event as `customMetadata['responses.server_tool_calls']`, which the root span turns into `ToolCall` events, so `adk_turns.tool_calls` counts a searched answer. The contract has no field for a call's arguments, status and sources, only its query (`grounding.searchQueries`).
- **No grounding.** The mapping writes `grounding` as `groundingMetadata`, which the A2A server folds into search and sources status lines. GPT and Grok events have never carried it.

ADR 0053 recorded, as a consequence, that the adapters moving onto the contract would align with Gemini's usage meaning. For these two providers that would change the ledger's history in a way no dashboard can tell from a real change.

## Decision

1. **One hook on the shim.** `AdkShim` maps each response through a protected `toLlmResponse(response)`, which is `modelResponseToLlmResponse` and runs inside the `llm.request` span, so the tracer reads its result. A subclass that stands in for an ADK-path adapter overrides it. The shim keeps its charge, signal and span logic in one place.
2. **`GptLlm` overrides it, and `GrokLlm` inherits the override:**
   - On a final, `candidatesTokenCount` is the contract's `outputTokens`, reasoning included. `thoughtsTokenCount`, `promptTokenCount` and `totalTokenCount` are as the mapping writes them.
   - The server-side calls and xAI's counters go on `customMetadata` under the keys the ADK path used.
   - `groundingMetadata` is left off.
3. **The adapter reports the contract's meanings.** `GptAdapter`'s `usage` counts reasoning inside `outputTokens` with `thinkingTokens` as its part, and its `grounding` holds the citations and search queries. What the contract cannot hold, the server-side calls, it keeps in a `WeakMap` keyed by the final it yielded, read through `responsesServerTools(final)`. No field is added to the contract, and nothing holds the record after the final is gone.
4. **ADR 0053 is refined, not replaced.** The caller still charges and traces, once per leaf adapter. Only its consequence on the output count does not apply to `GptLlm` and `GrokLlm`.

## Alternatives considered

- **Align with Gemini's meaning, as ADR 0053 expected.** Rejected for GPT and Grok: the ledger's `output_tokens`, the turn's output budget and the task log would drop by the reasoning for the same work, with no marker that the meaning changed. The native runtime, which reads the contract's `Usage` directly, has one meaning on every provider anyway.
- **Change `usageToMetadata` to write the contract's meaning for every adapter.** Rejected: `candidatesTokenCount` is Gemini's field with Gemini's meaning, and the shimmed Gemini adapters and every stored Gemini event read it so.
- **A contract field for server-side calls.** Deferred. The contract's `grounding.searchQueries` is the provider-neutral record, and the native runtime's ledger can count from it. Adding the vendor's own call records to every adapter's response for one consumer on the ADK path would widen ADR 0048's types for a transitional need.
- **`GptLlm` reimplements `generateContentAsync`** around `traceLlmGeneration`, bypassing the shim. Rejected: it repeats the shim's request mapping, signal and charge, which ADR 0053 put in one place.
- **Keep `groundingMetadata` on GPT and Grok events.** Not taken now. It would make their searches visible on the A2A surface as Gemini's are, but it changes what that surface emits for these providers, which this change does not mean to do.

## Consequences

- For GPT and Grok, `llm.tokens.output`, `syndicate.tokens.output`, the turn's output charge and the ledger's `output_tokens` count what they counted before. `tests/responsesAdapter.test.ts` asserts the turn's counts against a bare shim, which counts Gemini's meaning.
- Their stored events keep `candidatesTokenCount` with reasoning included, so `usageFromMetadata` on them still counts that reasoning twice, as on every event they stored before.
- `adk_turns.tool_calls` keeps counting their server-side searches.
- The registry ticket (WS1-3) registers `GptLlm` and `GrokLlm`, not a bare `adkShimClass` around their adapters, or this is lost.
- The chat-completions adapters face the same choice when they move behind the shim; the hook serves them too.
