---
type: decision
title: "ADR 0115: YAML schema v2 says sampling, output and reasoning in provider-neutral keys, and generateContentConfig becomes a deprecated spelling behind a mapper"
description: "WS6-4. An agent says how it samples with sampling: { temperature, top_p, max_output_tokens, stop }, what it answers in with output: { schema, mime }, and how hard it reasons with reasoning: (ADR 0047); model_overrides: gives one provider its own instruction or an addition to it. generateContentConfig and outputSchema still load and behave as before, with one deprecation line per file, and a v2 key beside its v1 spelling is a load error. The loader maps v2 onto the engine form the runtime already reads, so a migrated file compiles to the same AgentSpec. scripts/yaml_codemod.ts rewrites v1 files, comments kept; every shipped YAML is migrated. Translating in each adapter now, a new engine form, a sampling key for knobs no provider receives, a per-provider config passthrough and a hard break were rejected."
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
  - resource: lib/loadSyndicate.ts
  - resource: lib/compile.ts
  - resource: scripts/yaml_codemod.ts
  - resource: tests/agentDialect.test.ts
  - resource: tests/yamlCodemod.test.ts
---

# ADR 0115: YAML schema v2 says sampling, output and reasoning in provider-neutral keys, and generateContentConfig becomes a deprecated spelling behind a mapper

## Context

An agent's YAML kept the spelling of Google's `GenerateContentConfig` for everything it asked of its model: `temperature`, `topP`, `maxOutputTokens`, `stopSequences`, `responseMimeType`, `thinkingConfig`, and beside it ADK's `outputSchema`. Since 1.0.0 removed ADK ([ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md)) the engine owns the model contract ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)), and the native request builder reads that object through a few readers: `reasoningOf`, `samplingOf` (temperature, topP, maxOutputTokens, stopSequences), JSON mode from `responseMimeType`, and the tool choice from `toolConfig`. The other fields the schema typed (`topK`, `seed`, `presencePenalty`, `frequencyPenalty`, `candidateCount`, `safetySettings`, `includeThoughts`) reach no provider.

So a file written for Claude or GPT spoke Gemini's dialect, and a field that looked like a setting could be a no-op. [ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md) gave reasoning one neutral key; the rest stayed in the dialect. Prompts had the opposite problem: one instruction serves every provider, and a nuance one model needs (a firmer JSON reminder, a shorter style note) had no place.

## Decision

1. **The v2 keys.** On the orchestrator and on an inline subagent:

   | v2 key | Replaces | The engine form the loader writes |
   |---|---|---|
   | `sampling.temperature` | `generateContentConfig.temperature` | the same field |
   | `sampling.top_p` | `generateContentConfig.topP` | the same field |
   | `sampling.max_output_tokens` | `generateContentConfig.maxOutputTokens` | the same field |
   | `sampling.stop` | `generateContentConfig.stopSequences` | the same field |
   | `output.schema` | `outputSchema` | `outputSchema` |
   | `output.mime` (`application/json` or `text/plain`) | `generateContentConfig.responseMimeType` | the same field |
   | `reasoning` (ADR 0047, unchanged) | `thinkingConfig`, `reasoningEffort` | compiled as ADR 0047 says |
   | `model_overrides.<provider>` | (new) | applied by the compiler |

   `sampling` carries exactly the fields the model contract's `Sampling` carries, so every v2 key reaches a provider.

2. **model_overrides.** Keyed by the provider ids `providerForModel` returns (`gemini`, `anthropic`, `openai`, `xai`, `moonshot`, `ollama`). Each entry holds one of `instruction` (replaces the agent's instruction) or `instruction_append` (added after a blank line). The compiler applies the entry for the provider of the agent's model id, the same id `reasoning` maps for, to the base instruction before the skills index is appended. A `fallback_model` answers the same request, so it gets the primary's instruction.

3. **Native tools need no new key.** They are already neutral `tools:` names (`web_search`, `url_context`, `x_search`, `collections_search`) and `code_execution: gemini`, which names the one sandbox the engine wires. Gemini's own tool objects inside `generateContentConfig.tools` are refused by the request builder, as before.

4. **A mapper, not a second engine form.** `toEngineAgent` (`lib/agentDialect.ts`) folds `sampling` and `output` into the shape the runtime already reads. `validateSyndicateConfig` applies it to every agent it returns, so every loader (a file, the registry, a nested reference, the A2A server) hands the compiler the engine form; the compiler applies it again for a config built in code. `AgentSpec.generateContentConfig` stays the engine's carrier. A file migrated to v2 therefore compiles to the AgentSpec its v1 form compiled to.

5. **v1 is deprecated, not removed.** `generateContentConfig` and `outputSchema` load and behave exactly as before. A load that finds either prints one line through `LoadSyndicateOptions.onWarning` (default `console.warn`, the loader's existing log path), once per file or registry id per process, naming the key paths and never their values. The JSON Schema marks both `deprecated`, so an editor strikes them through. Knobs with no v2 form (`toolConfig`, the effort words `xhigh` and `max`, a budget of -1, `includeThoughts`, and the fields no provider receives) remain reachable only there.

6. **One spelling per concept.** A v2 key beside its v1 spelling on one agent is a load error against the v2 key's path, naming both (`sampling.temperature` with `generateContentConfig.temperature`, `output.schema` with `outputSchema`, and the rest of the table). ADR 0047's `reasoning` rule stands. Keys that do not overlap may sit together. `sampling`, `output` and `model_overrides` on a nested (`yaml_reference`) or remote (`a2a_agent_url`) subagent are a load error, as `reasoning` is.

7. **The codemod.** `melchizedek-codemod [--check] <file|dir>…` (the package's bin; `npm run yaml:codemod` in this repository; `scripts/yaml_codemod.ts`) rewrites v1 keys to v2, and with `--check` exits non-zero when a file would change. It edits through the `yaml` package's Document API, keeping comments and layout; it is idempotent. It turns a thinking setting into `reasoning:` only where the engine reads the same `ReasoningSetting` before and after for the agent's model, drops `includeThoughts: false` (the default, read by nothing), and leaves anything without a v2 form in `generateContentConfig` with a note. Every shipped YAML is migrated: the examples, the templates, the annotated `syndicateSchema.yaml` and the author skill's asset.

8. **The proof.** `tests/fixtures/v1/` holds the shipped files as 1.0.3 had them. `tests/yamlCodemod.test.ts` migrates each, compiles every agent before and after offline, and asserts the AgentSpec equal. Where a thinking setting became `reasoning:`, `generateContentConfig` is compared through the engine's reading (`reasoningOf`, and the rest of the object field by field): `reasoning:` always writes the gateway's effort word too (ADR 0047 §3), which the engine never reads beside a thinking level or budget. For those agents the test also builds the ModelRequest the engine sends (`buildModelRequest`, for the provider the agent's model routes to) from both specs and asserts it identical.

## Alternatives considered

- **Translate in each adapter, from a neutral engine form.** This is where the model contract is going, but it changes `AgentSpec`, `NativeAgent` and every adapter's input in a minor release, under four other branches editing the same schema. Mapping at the loader changes no runtime path and leaves that move to a later record.
- **Make the codemod byte-exact for thinking settings.** `reasoning:` adds the gateway's effort word, so no v2 spelling reproduces a v1 `thinkingConfig` byte for byte. Keeping `thinkingConfig` would leave Gemini's dialect in every shipped Gemini file; changing what `reasoning:` compiles to would change files already on it. Comparing through the engine's reading is the exact claim that holds.
- **Neutral keys for every typed field (`top_k`, `seed`, penalties, candidates, safety).** The engine sends none of them; a v2 key that does nothing is the defect this record removes. Each gains a key when the model contract carries it.
- **A per-provider config passthrough in `model_overrides`.** It would carry the leftovers (`reasoningEffort: max`, `toolConfig`) out of the deprecated block, but it is `generateContentConfig` again under another name. `model_overrides` holds prompt nuances only.
- **Remove v1 in 1.1.0.** Registry rows and consumers' files would stop loading in a minor release.
- **Warn on every load.** A server that loads per request would repeat the line; once per file per process says it.

## Consequences

- A file can be moved between providers by its `model:` line alone, and a key in it either reaches the provider or is refused.
- The loader returns the engine form: a caller reading `config.orchestrator.sampling` after a load finds it folded into `generateContentConfig`.
- `LoadSyndicateOptions` gains `onWarning`; the agent YAML types gain `sampling`, `output` and `model_overrides`; the package gains the `melchizedek-codemod` bin. Nothing is added to the exports map.
- Downstream sites that byte-copy the shipped templates and examples (melch.ai, lyceumagents) receive the v2 spelling, and any copy they keep of the annotated schema should be refreshed.
- `toolConfig` and the effort words beyond `high` (`xhigh`, `max`) still need `generateContentConfig`, so a file that uses them keeps one deprecation line. Neutral keys for them are a follow-up ticket, not part of this record.
