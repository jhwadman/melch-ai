---
type: decision
title: "ADR 0055: Claude moves onto the contract and the ADK path keeps its request: the older reasoning spelling rides as an ADK-only extension, and tool results keep ADK's JSON"
description: ClaudeAdapter (lib/models/claudeAdapter.ts) implements ModelAdapter and ClaudeLlm becomes its ADK shim. The contract's reasoning cannot carry everything ADR 0049 reads from an agent's generateContentConfig, so ClaudeLlm adds that reading to the ModelRequest as claudeReasoning, through a protected toModelRequest hook on AdkShim; tool results are serialized in the shape ADK stores, so both runtimes send the same bytes. Reading the contract's reasoning on the ADK path, widening ReasoningSetting, and keeping a second translation in ClaudeLlm were rejected.
tags:
  - decision
  - models
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/claudeAdapter.ts
  - resource: lib/models/claudeLlm.ts
  - resource: lib/models/claudeModels.ts
  - resource: lib/models/adkShim.ts
  - resource: tests/claudeAdapter.test.ts
  - resource: tests/claudeCurrentApi.test.ts
---

# ADR 0055: Claude moves onto the contract and the ADK path keeps its request

## Context

The adapter tickets of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)'s first workstream move each provider's translation onto the engine's model contract ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)). Under ADK, the translated adapter runs behind the [ADK shim](/models/adk-shim.md), which maps ADK's `LlmRequest` to a `ModelRequest` with `llmRequestToModelRequest` and charges and traces the call ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md)).

`ClaudeLlm` read its request straight from the `LlmRequest`. Moving its translation behind the shim keeps every request body the same but one group, the reasoning fields:

- **What ADR 0049 reads.** On the adaptive generations `ClaudeLlm` read `generateContentConfig.reasoningEffort` first, passing `xhigh` and `max` through and reading `minimal` as `low`, and otherwise the thinking budget rounded up to a level. On Claude 4.6 and earlier it read `thinkingConfig.thinkingBudget` alone. `tests/claudeCurrentApi.test.ts` asserts the `xhigh` pass-through.
- **What the contract can say.** `ReasoningSetting` is `none`, `low`, `medium`, `high` or `{ budget_tokens }` ([ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md)). The mapping prefers the budget to the word, drops `xhigh` and `max`, and reads `minimal` as `none`, its rendering on the first GPT-5 generation. On a budget row a level maps to its budget.

Where the compiler writes both spellings from `reasoning:`, the two readings give the same request on every generation. They differ on the older spelling an agent sets by hand: an effort word above `high`, `minimal`, a word with no budget on Claude 4.6 and earlier (no thinking before, a budget after), and a word and a budget that disagree. They also differ for a fallback model on the ADK path, which receives the primary's compiled config.

A second, smaller difference: the mapping turns a tool result into a value (`{ result: 'x' }` becomes `'x'`, `{ error: e }` becomes `e` marked as an error). Serializing that value would change the `tool_result` text of every non-object result, and the native runtime would send different bytes than the ADK path for the same stored history. On Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 a thinking block is bound to the bytes of the conversation before it ([ADR 0049](/decisions/0049-claude-requests-by-model-generation.md)), and gate G2 resumes a pause opened under `adk` under `native`.

## Decision

1. **`ClaudeAdapter` implements `ModelAdapter`** (`lib/models/claudeAdapter.ts`), on the contract's Anthropic table. It opens no span, charges nothing, and reports every failure as a final.
2. **`ClaudeLlm` is a subclass of `AdkShim`** around it, keeping its name, its options (`model`, `apiKey`, `endpoint`), its static `supportedModels`, `registerClaudeLlm()` and `buildAnthropicTools()`. The registry and every caller construct it as before.
3. **The shim has one extension point.** `AdkShim` maps the `LlmRequest` through a protected `toModelRequest(llmRequest, options)`. A provider's ADK class may override it to add what its adapter reads on the ADK path only. It never removes or rewrites a contract field.
4. **The older spelling rides as `claudeReasoning`.** `ClaudeLlm` adds `claudeReasoningFromConfig(config)`, ADR 0049's reading, and `ClaudeAdapter` reads it in place of `reasoning` when it is set (`ClaudeModelRequest`). The native runtime never sets it. Both readings feed one `ClaudeReasoning` (an effort word and a budget) in `lib/models/claudeModels.ts`, so the generation table is applied once.
5. **Tool results keep ADK's JSON.** A `tool_result`'s content is the JSON of the result in the shape ADK stores it: the result when it is an object, `{ result }` when not, `{ error }` for a failure. A failure also sets `is_error: true`, as the contract's table says.

## Alternatives considered

- **Read the contract's `reasoning` on the ADK path too.** No hook and no extension. Rejected: it breaks ADR 0049's `xhigh`, `max` and `minimal` and the test that asserts them, and turns thinking on for a Claude 4.6 agent that sets only an effort word, a spend change no agent asked for. It would be the right reading for a fallback model, which today gets its primary's config; that is the native runtime's to fix, where the compiler stops writing provider fields.
- **Add `xhigh` and `max` to `ReasoningSetting`.** Every adapter would then map two more levels, most to `high`, and ADR 0047's four levels exist so that one setting means the same on every provider. It also would not cover `minimal` or the budget rows' reading.
- **A provider-options bag on the request.** ADR 0048 rejected it: untyped and per-provider. `claudeReasoning` is one typed field that one ADK class sets for one adapter, and it ends with the ADK path at 1.0.
- **Keep the translation in `ClaudeLlm` and add the adapter beside it.** Two translations of one wire, kept in step by hand until 1.0.
- **Serialize the contract's value as the tool result.** Shorter content for a plain value, but the two runtimes would send different bytes for one stored history, which a bound thinking block rejects or drops.

## Consequences

- Every Claude call on the ADK path goes through `ClaudeAdapter`. The existing request-body tests pass unchanged, and `tests/claudeAdapter.test.ts` asserts the same bodies from ModelRequests: on every generation and reasoning setting, a ModelRequest's body equals the one `ClaudeLlm` sends for the compiler's LlmRequest.
- Behind the shim a Claude event now carries `finishReason`, as ADR 0053 says of every shimmed adapter, and `groundingMetadata` when Claude searched the web, so the A2A server reports Claude's web sources as it reports Gemini's. A failed tool's result carries `is_error: true`. A setup failure carries `error.retryable: false`, which `FallbackLlm` reads as it read no verdict. Tool schemas come from `contractToolDeclaration`, so an OpenAPI `nullable` reaches Claude as a type that admits null, an integer bound Gemini spells as a string (`minItems: '2'`) as an integer, and `$schema` is left out.
- The contract adds to Claude what the ADK path never asked of it: `toolChoice` with its weakening, strict tools, and `llm.capability.dropped` for native tools other than `web_search`.
- The span's payload on a failed call (`llm.payload.request`) includes `claudeReasoning` beside the request.
- GPT and the chat-completions adapters may use the same hook for their own older-spelling readings.
- Left as they were, for later decisions: `web_search_20250305` on every model, a `pause_turn` that ends the call, and no `cache_control`.
