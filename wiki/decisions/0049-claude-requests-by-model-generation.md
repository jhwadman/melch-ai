---
type: decision
title: 'ADR 0049: Claude requests follow the model generation'
description: "The Claude adapter reads a per-generation table from the model id: a thinking budget on Claude 4.6 and earlier, adaptive thinking with an effort word after, each model's own off switch for `none`, structured outputs where forced tool use is gone, `drop_block` where thinking is bound to the conversation (which makes a resumed turn safe), and URL images only where the platform takes them."
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/claudeModels.ts
  - resource: lib/models/claudeLlm.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/claudeCurrentApi.test.ts
  - resource: tests/capabilityMatrix.test.ts
---

# ADR 0049: Claude requests follow the model generation

## Context

The Claude adapter sent one request shape to every `claude-*` id: thinking as `{ type: 'enabled', budget_tokens }` from `thinkingConfig.thinkingBudget`, and structured output as a tool forced with `tool_choice: { type: 'tool' }`. Anthropic's API reference, checked on 7 October 2026, no longer accepts that shape on the current models:

- **Budgets.** `budget_tokens` is a 400 on Opus 4.7, 4.8, 5 and 5.5, Sonnet 5 and 5.5, Haiku 5.5, and Fable 5 and 5.1. It is deprecated but still works on Opus 4.6 and Sonnet 4.6, and Haiku 4.5 and older need it for thinking. The current models take `thinking: { type: 'adaptive' }` with `output_config.effort` (`low`, `medium`, `high`, `xhigh`, `max`).
- **Off switches.** `{ type: 'disabled' }` is a 400 on Fable 5 and 5.1, Opus 5.5 and Sonnet 5.5. Opus 5 and Haiku 5.5 accept it only at effort `high` or below. Sonnet 5.5 takes `{ type: 'between_tools' }` instead, also only at `high` or below, and with no other field beside it.
- **Display.** On the adaptive models thinking text defaults to `omitted` (an empty string). This engine shows thinking as dimmed display text.
- **Forced tool use.** `tool_choice` `any` or `tool` is a 400 on Fable 5.1, Opus 5.5 and Sonnet 5.5.
- **Sampling.** `temperature`, `top_p` and `top_k` are removed on the newer models.
- **Preserved thinking.** On Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 a thinking block is bound to the conversation before it: the `system` prompt, the `tools`, and every earlier message must be byte-identical when the block is replayed. Accounts created on or after 31 August 2026 get a 400 when they are not. Any account can opt into the check, and choose to have mismatched blocks dropped instead, with `thinking.block_binding.prefix_mismatch_behavior` under the `thinking-binding-controls-2026-08-01` beta.

[ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md) replays Claude's signed blocks within the current turn's tool loop and named one gap: a turn resumed after an approval or an `ask_user` pause (ADR 0028) is rebuilt from its stored events, and the Supabase store elides a tool result over 2,000 characters before storage, so the resumed history is not what the model saw. Reading the stores for this decision found a second cause. Both session stores keep events as `JSONB` (`adk_sessions.events`, `adk_session_events.event`), and `JSONB` does not keep object key order, so a tool result or call argument with more than one key can come back in a different order, which changes the `tool_result` text the adapter builds, even when nothing was elided. The verbatim Postgres store has this cause too.

From the review of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)'s first workstream: an `https` `fileData` image with no `mimeType` was sent as an image whatever it was. Anthropic's vision documentation says URL image sources are not available on Amazon Bedrock or Google Cloud Vertex AI, which take base64 only.

## Decision

### 1. A table keyed by the model id

`claudeGeneration(model)` in `lib/models/claudeModels.ts` returns the request surface a model id takes. Ids are read as `claude-<family>-<major>[-<minor>]` (a date suffix and a dotted minor are allowed) or the Claude 3 form `claude-<major>-<minor>-<family>`. An id the table does not know, a newer model's, gets the newest row, `current`.

| Row | Ids | Thinking | `reasoning: none` | Forced `tool_choice` | Structured output | Display | Bound to the conversation |
|---|---|---|---|---|---|---|---|
| `budget` | Claude 3.x; Opus 4, 4.1, 4.5, 4.6; Sonnet 4, 4.5, 4.6; Haiku 4.5 | budget | no `thinking` | yes | forced tool | no | no |
| `opus-4.7` | Opus 4.7 | adaptive, off unless asked | `disabled` | yes | forced tool | yes | no |
| `opus-4.8` | Opus 4.8 | adaptive, off unless asked | `disabled` | yes | `output_config.format` | yes | no |
| `sonnet-5` | Sonnet 5 | adaptive, on by default | `disabled` | yes | `output_config.format` | yes | no |
| `opus-5` | Opus 5 | adaptive, on by default | adaptive at `low` | yes | `output_config.format` | yes | no |
| `fable-5` | Fable 5, Mythos 5 | adaptive, always on | adaptive at `low` | yes | `output_config.format` | yes | no |
| `haiku-5.5` | Haiku 5.5 | adaptive, on by default | `disabled` | yes | `output_config.format` | yes | yes |
| `sonnet-5.5` | Sonnet 5.5 | adaptive, on by default | `between_tools` | no | `output_config.format` | yes | yes |
| `current` | Opus 5.5, Fable 5.1, Mythos 5.1, unknown ids | adaptive, always on | adaptive at `low` | no | `output_config.format` | yes | yes |

The Claude 4.6 models stay on the budget path, which still works there and is the one [ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md)'s budgets were set for.

### 2. Reasoning on the adaptive rows

The adapter reads `generateContentConfig.reasoningEffort`, which the compiler writes for every model id (ADR 0047), and otherwise the older spelling's `thinkingConfig.thinkingBudget`, rounded up to a level as ADR 0047 rounds it. This supersedes ADR 0047's statement that the Claude adapter never reads the effort word: on the adaptive rows it is the only thing it reads.

| ADR 0047 level | Adaptive rows send | max_tokens at least |
|---|---|---|
| none | the row's off switch at effort `low` (`disabled`, or `between_tools`); adaptive at `low` where the row has none | — |
| low | `thinking: adaptive`, `effort: low` | 4,096 |
| medium | `thinking: adaptive`, `effort: medium` | 10,240 |
| high | `thinking: adaptive`, `effort: high` | 18,432 |
| `{ budget_tokens: n }` | the level of n | n + 2,048 |
| not set | the model's own default: `thinking: adaptive` where it thinks by default, nothing on Opus 4.7 and 4.8 | 18,432 where the model thinks (its default effort is at most `high`) |

- The older spelling's `xhigh` and `max` pass through (with the `high` floor), and `minimal` is `low`.
- Thinking that is on asks for `display: 'summarized'`.
- The `max_tokens` floor is the one the budget path sets (the budget plus 2,048), because thinking still counts toward `max_tokens`. An agent moved from Sonnet 4.6 to Sonnet 5.5 keeps the same ceiling, under the Anthropic SDK's non-streaming limit.
- No sampling parameter is sent on any generation.

**Opus 5's `none`.** Opus 5 accepts `disabled` at `high` effort or below. Anthropic documents two failure modes for it there: the model sometimes writes a tool call into its reply text, where it never runs and no error is raised, and internal tags leak into the reply. Their recommendation is thinking on at a low effort. For an engine whose agents call tools, the first failure is a silent wrong answer, so `none` on Opus 5 is adaptive at `low`. Every other row with an off switch uses it, as ADR 0047's "as little reasoning as the model allows" says.

### 3. Structured output

Where `output_config.format` is documented (Opus 4.8 and later, Sonnet 5 and later, Haiku 5.5, Fable and Mythos), an outputSchema travels as `output_config: { format: { type: 'json_schema', schema } }` and the answer is read from the text. The schema goes through the Anthropic SDK's own strict-schema transform (`jsonSchemaOutputFormat`): `additionalProperties: false` on every object, and constraints structured outputs cannot express move into the description.

This is the only option on the three models that reject forced tool use. It is also the simpler one on the models that accept forced tool use: it combines with thinking, where a forced tool cannot, so a thinking agent's schema is enforced instead of merely offered. It also removes a Bedrock-only rule on Sonnet 5, where forced `tool_choice` needs thinking disabled.

The `budget` and `opus-4.7` rows keep the forced tool (structured outputs are not documented for Opus 4.7), offered under `tool_choice: auto` when thinking is on. A schema the transform refuses falls back to that tool, under `auto` where forcing is a 400, with one warning per adapter. A root that is not an object, or a node with no type, is refused. The span records `llm.structured_output` (`output_format`, `forced_tool` or `tool_auto`). ADK sets a `responseSchema` only on an agent without tools, so the format never meets the agent's own tools.

### 4. Interrupted turns: `drop_block` on conversation-bound models

On a row bound to the conversation, every request with adaptive thinking sets `thinking.block_binding: { prefix_mismatch_behavior: 'drop_block' }`, and the adapter sends it through the SDK's beta namespace with `betas: ['thinking-binding-controls-2026-08-01']`. When a replayed block's history differs from the history it was made in, whatever the reason, the API drops that block and every later one for that request, and the request succeeds. Responses list each drop in `input_transformations`. The adapter puts the known reasons (`prefix_binding_mismatch`, `model_binding_mismatch`) on the span as `llm.thinking.dropped`.

- **Every request, not only resumed ones.** The setting is sent on every request to those models, because changing thinking parameters between requests invalidates the prompt cache.
- **With thinking off.** `between_tools` and `disabled` cannot carry `block_binding`, so on a bound row with thinking off the adapter replays no signed block. Removing every block of the current turn removes a leading run, which the check allows.
- **Unbound rows.** Rows not bound to the conversation replay as ADR 0046 says.

The session stores do not change.

### 5. Images

- **Untyped URLs.** An `https` `fileData` part that names no type is typed by its URL's extension. A non-image (a PDF, an SVG) is dropped with the same span attribute and warning as any rejected type. A URL with no extension the adapter knows is sent, and Anthropic reads the type from the bytes.
- **Cloud platforms.** On Bedrock and Vertex AI a URL image is dropped (`llm.image.dropped: URL source`, one warning naming the platform), and inline images are sent. The capability matrix states it as a platform cell: image input is degraded on Claude on Bedrock and on Vertex AI.

## Alternatives considered

- **Leave the paused turn's events untrimmed until it resumes.** In the Supabase store this was a small change, because the service re-trims the whole array from the live session on every append. It does not make the history identical: `JSONB` still reorders keys, in both stores. It would also keep a turn's full payloads in the row until the next turn.
- **Drop the replay of signed blocks that follow an elided result.** This misses the key-order cause. It also cannot tell a block made before the pause from one made after the resume, which was made against the elided history and is valid.
- **A prefix digest on the state.** Record a hash of the messages a block was made after, and drop the block client-side when the rebuilt prefix differs. This keeps the reasoning made after a resume and needs no beta. But it imitates a server check whose inputs (the `system` prompt and `tools` as the API renders them) the adapter cannot see whole, and it changes ADR 0046's payload. It remains the upgrade path if a resumed turn's lost reasoning shows up in quality.
- **Serialize tool results with sorted keys.** This would fix the `tool_result` text. It would not fix call arguments, which go back as objects in the model's own key order, and it changes every Claude request's bytes.
- **Fetch a URL image and send it as base64 on Bedrock and Vertex AI.** This would keep the image, but the adapter would fetch a caller-supplied URL from the server: a new outbound surface that needs the SSRF guard (ADR 0036), size limits and a timeout. Dropping it and saying so in the matrix is honest, and it is reversible.
- **Map `none` to `low` effort everywhere,** as Anthropic recommends for latency-sensitive routes. ADR 0047 defines `none` as the least reasoning the model allows. The off switch is that wherever it has no documented silent failure; Opus 5 is the exception above.
- **Move the 4.6 models to adaptive thinking.** Anthropic recommends it, and it would make two generations one. But the budget is a hard ceiling that ADR 0047's levels were tuned for, and the budget path still works there. Moving them is a separate change.

## Consequences

- One `reasoning:` setting means the same thing across the generations, and a model change no longer turns into a 400. `npm test` asserts the request body per generation in `tests/claudeCurrentApi.test.ts`, and the matrix test asserts both generations' cells.
- Thinking now shows on the adaptive models, as a summary.
- A resumed turn on a bound model loses the reasoning from the first changed block on, for the rest of that turn: each later step re-plans from the visible history. It does not fail.
- The newer rows send a beta header. A proxy in front of the API (`ANTHROPIC_BASE_URL`) must pass `/v1/messages?beta=true` and the header through.
- `none` on Sonnet 5.5 (`between_tools`) does not replay the progress-note blocks it returns, so the model sees its tool calls without those notes.
- The adaptive path does not apply the budget path's rule for a tool loop whose call carries no signed block (another provider made it). Opus 5.5, Fable 5.1 and Sonnet 5.5 cannot turn thinking off, so the API must accept that loop with thinking on. It is verified against the documentation only.
- Bedrock and Vertex AI drop URL images. A caller there sends images inline.
- Verified against documentation and the SDK only, not a live call:
  - the beta namespace on the Bedrock and Vertex AI clients;
  - `input_transformations` on a streamed response (the SDK keeps the `message_start` fields on its final message);
  - `output_config.format` beside `effort`, and beside `between_tools`;
  - the unsigned-loop behaviour above.
