---
type: decision
title: "ADR 0117: tool_choice and the effort levels xhigh and max get v2 keys; includeThoughts is dropped as read by nothing"
description: "An agent says which tools its model may call with tool_choice: auto | none | required | { name }, folded by the loader into the function-calling config the engine reads; reasoning: gains xhigh and max, which reach the models that take them and go as a model's highest setting elsewhere, with llm.reasoning.weakened on the span and the capability matrix saying where; the codemod converts toolConfig and the effort words, and drops includeThoughts, which no path reads. A list of allowed names, a per-provider passthrough, refusing a level a model lacks, a v2 key for includeThoughts and clamping at compile time were rejected."
tags:
  - decision
  - agents
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-09
sources:
  - resource: lib/agentDialect.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/models/contract.ts
  - resource: lib/models/reasoning.ts
  - resource: lib/models/genaiMapping.ts
  - resource: lib/models/capabilities.ts
  - resource: lib/models/chatCompletionsAdapter.ts
  - resource: lib/models/gatewayAdapter.ts
  - resource: lib/models/kimiAdapter.ts
  - resource: lib/models/gptAdapter.ts
  - resource: lib/models/grokAdapter.ts
  - resource: lib/models/claudeAdapter.ts
  - resource: lib/models/geminiAdapter.ts
  - resource: scripts/yaml_codemod.ts
  - resource: tests/toolChoiceEffort.test.ts
  - resource: tests/yamlCodemod.test.ts
---

# ADR 0117: tool_choice and the effort levels xhigh and max get v2 keys; includeThoughts is dropped as read by nothing

## Context

[ADR 0115](/decisions/0115-yaml-schema-v2-provider-neutral-keys.md) gave an agent's sampling, output and reasoning provider-neutral keys and left three things in the deprecated `generateContentConfig` block:

- **`toolConfig.functionCallingConfig`**, Gemini's spelling of which tools the model may call. The native request builder reads it through `toolChoiceOf` (`lib/models/genaiMapping.ts`) into the model contract's `ToolChoice` (`auto | none | required | { name }`), and every adapter sends that in its own field, weakening a forced choice where its provider rejects one (`llm.tool_choice.weakened`).
- **The effort words `xhigh` and `max`.** The contract's `ReasoningLevel` stopped at `high`, so `reasoningOf` read neither, and since 1.0.0 removed the older-spelling extensions ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)) no request sent them: Claude's adaptive generations take both in `output_config.effort`, Kimi K3 takes `max`, OpenAI's GPT-5.2 and later and grok-4.7 take `xhigh`, and nothing could ask for them.
- **`thinkingConfig.includeThoughts`.** The schema typed it; nothing reads it. The Gemini adapter asks for the thought trace itself whenever the request's reasoning is not `none` (ADR 0047's mapping, `thinkingConfigFor`), and no other adapter has the field.

A file using any of them kept a deprecation line and Gemini's dialect.

## Decision

1. **`tool_choice:`** on the orchestrator and on an inline subagent: `auto` (the default), `none`, `required` (some tool), or `{ name: <tool> }` (that tool), the contract's `ToolChoice` exactly. `toEngineAgent` (`lib/agentDialect.ts`) folds it into `generateContentConfig.toolConfig.functionCallingConfig`: `auto` is mode `AUTO`, `none` `NONE`, `required` `ANY`, and `{ name }` `ANY` with that one name in `allowedFunctionNames`. Other `toolConfig` keys stay beside it. It is one more row of ADR 0115's spelling table: beside `generateContentConfig.toolConfig.functionCallingConfig` on one agent it is a load error against `<agent>.tool_choice`, and on a `yaml_reference` or `a2a_agent_url` subagent it is refused. What each provider then sends is unchanged, including where it weakens a forced choice.

2. **`reasoning: xhigh | max`.** `ReasoningLevel` gains the two levels above `high`. A budget never rounds up to either.
   - **The compiler** (`reasoningConfig`, `lib/models/reasoning.ts`) writes them as asked in `reasoningEffort`, beside `high`'s `thinkingConfig` for Claude and Gemini (`HIGH`, or 16,384 tokens), except that Kimi has no `xhigh` and gets `max` (a missing word rounds up, ADR 0047 §4). `reasoningOf` reads `xhigh` and `max` as levels, and prefers them to a `thinkingConfig` that says `high`, which is what the compiler writes beside them; a `thinkingConfig` that says less keeps its own reading. So the request carries the level asked for, and each adapter maps it, a fallback included.
   - **Each adapter holds the word at its model's ceiling** (`effortCeiling`, `effortWord`): `max` on Claude's adaptive generations and on Kimi K3; `xhigh` on GPT-5.2 and later and on grok-4.7; `high` on the other OpenAI and Grok ids, on Ollama, and on Gemini (`HIGH`, or `high`'s budget on 2.x); `high`'s budget on Claude 4.6 and earlier; and `high` on a gateway for any id, since the words above it are not accepted across gateways. A level sent lower than asked marks the `llm.request` span `llm.reasoning.weakened` with the level asked for, as a weakened tool choice is marked.
   - **The capability matrix says which**: `REASONING_ABOVE_HIGH` (`lib/models/capabilities.ts`), one line per row, rendered under the matrix by `npm run doctor -- --matrix` and asserted against the request bodies in `tests/toolChoiceEffort.test.ts`.

3. **`includeThoughts` has no v2 key.** It is read by nothing, so a key for it would be the no-op ADR 0115 removes. The codemod drops it with any value; a `true` gets a note saying the Gemini adapter asks for the trace whenever reasoning is not `none`.

4. **The codemod** (`scripts/yaml_codemod.ts`) converts:
   - `toolConfig` holding only `functionCallingConfig` (mode `AUTO`, `NONE` or `ANY`, and `allowedFunctionNames`) and `includeServerSideToolInvocations` (which the compiler sets on every agent) to the `tool_choice:` the engine reads today. `ANY` with several names is read as `required`, which the codemod writes, with a note. Mode `VALIDATED` (strict tool schemas), any other mode, and any other `toolConfig` key stay, each with a note.
   - A thinking setting to whatever `reasoningOf` reads from it today, `xhigh` and `max` included, where the v2 key's engine form reads back the same for the agent's model (ADR 0115 §7's rule, unchanged). Kimi's `reasoningEffort: xhigh` stays: the compiler writes `max` for it.

5. **The proof.** `tests/fixtures/v1-tool-choice/` holds three v1 files written for this (no shipped YAML used these knobs): a Gemini pair, a Claude pair and the effort-word providers (Kimi K3, GPT-5.4, GPT-5 mini, grok-4.7, Ollama), with `toolConfig`, `includeThoughts: true`, and `reasoningEffort: xhigh | max`. Each migrates with nothing left under `generateContentConfig`, and for each agent the test builds the ModelRequest from both specs and captures the body its provider's adapter posts over a stubbed fetch: identical before and after. Kimi K3 is sent `reasoning_effort: max` again.

## Alternatives considered

- **`tool_choice: { only: [names] }`, a list.** Gemini takes a list of allowed names, but the contract carries one name, and every other provider forces one tool or any tool. A list of several would load and then be sent as `required`: a key that says more than reaches the provider. A list of one is `{ name }` with brackets. When the contract carries an allowlist, `{ only }` can be added beside `{ name }`.
- **Refuse `xhigh` and `max` on a model that lacks them.** Honest, but it breaks a file when its `model:` line changes, which ADR 0047 rejected for budgets on the same grounds; and the compiler cannot know the transport (a gateway serves any id). The highest setting plus a span mark plus the matrix row keeps the file portable and the loss visible.
- **Clamp at compile time**, writing the model's word into `generateContentConfig`. The compiled config would then say exactly what the direct path sends, but the request would lose the level asked for: a fallback on another provider, or the gateway, could not map it, and no adapter could mark the span.
- **A v2 key for `includeThoughts`.** It reaches no provider; showing or hiding the thought trace is a display choice of the caller, not a request field. A key that does nothing is the defect ADR 0115 removed.
- **Raise the budget for `xhigh` and `max` on Claude 4.6 and Gemini 2.x.** Above 16,384 a non-streaming Claude request passes the Anthropic SDK's ceiling (ADR 0047). `high`'s budget, marked as weakened, is the same answer on both budget paths.
- **A per-provider passthrough** for these knobs in `model_overrides`. ADR 0115 rejected it as `generateContentConfig` under another name; with these keys nothing is left that needs it.

## Consequences

- A YAML can say every knob the engine sends to a provider in the v2 keys. `generateContentConfig` is left only for `toolConfig` mode `VALIDATED`, Gemini's dynamic budget (`thinkingBudget: -1`), and fields no provider receives.
- `ReasoningLevel` and `REASONING_BUDGETS` gain `xhigh` and `max`, so an exhaustive `Record<ReasoningLevel, …>` in a consumer must add them. `effortCeiling`, `effortWord`, `isAboveHigh` and `REASONING_ORDER` (`melchizedek-agents/models/reasoning`) and `REASONING_ABOVE_HIGH` (`melchizedek-agents/models/capabilities`) are new names on modules the `./models/*` subpath already exports; `functionCallingConfigOf` and `TOOL_CHOICE_MODES` are internal. The exports map is unchanged.
- The older spelling's `reasoningEffort: xhigh | max` now reaches the provider (it was dropped since 1.0.0), and beside a `thinkingConfig` that says `high` it now wins. A file that relied on the word being ignored thinks harder, and costs more, after upgrading.
- `ChatCompletionsAdapter` gains the protected hooks `reasoningCeiling` and `effortFor`; the gateway overrides the first.
- The `xhigh` and `max` support claimed per model (GPT-5.2 and later, grok-4.7, every adaptive Claude generation, Kimi K3) follows the providers' documentation and the older spelling's behaviour before 1.0.0; it is asserted against the request bodies the adapters build, not against live providers.
