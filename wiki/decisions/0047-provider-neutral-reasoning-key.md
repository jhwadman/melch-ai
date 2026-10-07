---
type: decision
title: 'ADR 0047: One provider-neutral reasoning key, mapped per provider by the compiler'
description: "An agent's YAML says how hard it reasons with `reasoning: none | low | medium | high` or `{ budget_tokens }`; lib/compile.ts turns that into the field the agent's provider reads (a Gemini thinking level, a Claude or Gemini 2.x thinking budget, an effort word everywhere else, always including the gateway); thinkingConfig and reasoningEffort remain as the older spelling and may not sit beside it."
tags:
  - decision
  - models
  - agents
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/compile.ts
  - resource: lib/syndicateSchema.ts
  - resource: lib/models/gptLlm.ts
  - resource: lib/models/grokLlm.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/reasoningKey.test.ts
---

# ADR 0047: One provider-neutral reasoning key, mapped per provider by the compiler

## Context

How hard an agent thinks was written in each provider's own dialect, inside `generateContentConfig`:

- Gemini 3 reads `thinkingConfig.thinkingLevel` (`MINIMAL` to `HIGH`); Gemini 2.x reads `thinkingConfig.thinkingBudget`.
- The Claude adapter reads `thinkingConfig.thinkingBudget`.
- The chat-completions adapters (Kimi, Ollama, the gateway) read `reasoningEffort`.
- GPT read nothing: the Responses adapter sent only `reasoning.summary`. Grok sent a pinned effort.

So changing an agent's `model:` line silently dropped its reasoning setting: a Gemini template moved to Claude kept a `thinkingLevel` that Claude ignores. The capability matrix said as much ("thinkingConfig budgets are ignored on chat-completions"). The native runtime the engine is moving towards owns the model contract, so the setting needs one portable form first.

## Decision

1. **The key.** An agent (orchestrator or subagent) may set `reasoning:` to `none`, `low`, `medium` or `high`, or to `{ budget_tokens: <integer ≥ 0> }`. `none` means as little reasoning as the model allows. A budget of 0 is `none`.

2. **The compiler maps it.** `reasoningConfig(model, setting)` in `lib/compile.ts` picks fields by `providerForModel`. The fields are the ones the adapters already read:

   | Provider | none | low | medium | high | `budget_tokens: n` |
   |---|---|---|---|---|---|
   | Gemini 3 and later | `thinkingLevel: MINIMAL` | `LOW` | `MEDIUM` | `HIGH` | `thinkingBudget: n` |
   | Gemini 1.x / 2.x | `thinkingBudget: 0` | 2048 | 8192 | 16384 | `thinkingBudget: n` |
   | Claude | `thinkingBudget: 0` | 2048 | 8192 | 16384 | `thinkingBudget: n` |
   | GPT (`gpt-*`, `o*`) | `minimal` on the first GPT-5 generation, `none` on GPT-5.1 and later, `low` on o-series | `low` | `medium` | `high` | the level of n |
   | Grok | `low` | `low` | `medium` | `high` | the level of n |
   | Kimi | `none` | `low` | `high` | `high` | the level of n |
   | Ollama | `none` | `low` | `medium` | `high` | the level of n |

   The effort words travel as `generateContentConfig.reasoningEffort`. The thinking levels and budgets travel as `thinkingConfig`.

3. **The effort word is always written,** for Claude and Gemini as well. The gateway can serve any id when a provider's key is absent, and the compiler cannot know the transport: the A2A server decides it per request, from the caller's key. A gateway only reads `reasoningEffort`, so a Claude or Gemini agent there gets its level as the neutral word. Each direct adapter ignores the field it does not read: the Claude adapter never reads `reasoningEffort`, and the genai SDK copies only the fields it knows into a Gemini request. `tests/reasoningKey.test.ts` asserts that the word never reaches Gemini's wire.

4. **A missing word rounds up, never down.** Where a provider lacks a level, the level becomes the provider's nearest setting above it. A budget sent to an effort-only provider becomes the smallest level whose budget covers it: 1 to 2048 is `low`, up to 8192 is `medium`, and anything above is `high`. Asking for more thought and getting less is the worse surprise.

5. **The Responses adapters read the effort.** `GptLlm.reasoningParam` adds `effort` beside `summary` for reasoning-capable ids. `GrokLlm` sends the agent's effort in place of `DEFAULT_GROK_REASONING_EFFORT`, and keeps the pin when the agent sets none.

6. **One spelling per agent.** `thinkingConfig` and `reasoningEffort` remain the older, provider-specific spelling. Setting either beside `reasoning` on the same agent is a load error, reported against `<agent>.reasoning` and naming the other key. The compiler refuses the pair too, for configs built in code. An agent that sets neither compiles exactly as before.

7. **The model it maps for** is the agent's `model:`. A subagent without one maps for the model its resolver returns (the BYOK adapter on the server).

8. **The capability check reads the key.** `requiredCapabilities` counts any setting other than `none` (or a budget of 0) as thinking. The doctor therefore reports `thinking_with_tools` for a thinking agent with tools, as it already did for `thinkingBudget`.

The levels are chosen so that an agent which sets nothing sits at `medium` wherever the engine pins a default: Grok's pinned `medium`, Kimi K3's pinned `high` (which is where `medium` lands), and GPT's own default. The Claude budgets are 2,048 (the model zoo's existing setting), 8,192 and 16,384. `high` stops at 16,384 because the Claude adapter raises `max_tokens` to at least the budget plus 2,048. That keeps a non-streaming request at 18,432 tokens, under the roughly 21,333 at which the Anthropic SDK refuses a non-streaming call made without a client timeout.

## Alternatives considered

- **Translate inside each adapter.** Each adapter would read `reasoning` and shape its own request. This is the end state once the engine owns the model contract, but today the Claude adapter belongs to other work, and ADK's own Gemini class is not ours to change. Mapping onto the fields the adapters already read changes no adapter except the Responses pair, which read nothing before.
- **Write only the provider's native field.** This is simpler, but a Claude or Gemini agent served by the gateway would lose its setting with no signal: the very defect the key exists to remove.
- **Refuse a budget on effort-only providers.** It is honest, but it makes the file break when its `model:` line changes, which is the opposite of portability. Rounding up keeps the file valid and errs towards more thought.
- **Map Kimi K3's `high` to `max`.** That would use all three of K3's settings. But `max` is Moonshot's costliest effort, the one the adapter pins away from, and gateways reject the word. An agent that needs `max` writes `reasoningEffort: max`.
- **Let `reasoning` override the older spelling when both are set.** Which field wins would then depend on merge order. A load error says it once.

## Consequences

- One key works across the six providers and the gateway. The zoo and every template now use it. The other starter-pack examples still use the older spelling, which stays valid.
- `includeThoughts` has no `reasoning` form. An agent that streams Gemini's thought trace keeps `thinkingConfig`.
- On Gemini 3, `none` is `MINIMAL`: a little thinking remains, because some Gemini 3 models cannot stop entirely. Gemini 2.5 Pro rejects a budget of 0, as it already did through `thinkingBudget: 0`.
- A `fallback_model` receives the primary model's mapping. The effort word is always present, so an effort-reading fallback keeps the level, but a Claude fallback behind a Gemini 3 primary sees a `thinkingLevel` it ignores and does not think. Per-adapter translation (the first alternative above) removes this.
- GPT and Grok now honour an explicit `generateContentConfig.reasoningEffort`, which they ignored before. Grok sends the older spelling's `none` as `low`. GPT sends the older spelling's word as written, so a word the model lacks (`none` on the first GPT-5 generation) gets a 400, and the guarded retry then drops the whole `reasoning` param, summary included. `reasoning:` never sends such a word.
- A level on an OpenAI id that does not reason (`gpt-4o`) sends nothing, as the Responses adapter sends no reasoning param to those ids. An id that routes to Gemini without a `gemini-1.` or `gemini-2.` prefix is treated as Gemini 3 and gets a `thinkingLevel`.
- `reasoning` on a subagent that is a nested syndicate (`yaml_reference`) or a remote agent (`a2a_agent_url`) is a load error. Those agents bring their own setting.
- A Claude `budget_tokens` above about 19,000 hits the SDK's non-streaming ceiling on a non-streaming turn. The same is true of `thinkingBudget` today.
