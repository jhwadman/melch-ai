---
type: decision
title: 'ADR 0048: The Responses adapters replay encrypted reasoning items and store nothing with the vendor'
description: For reasoning ids, GPT and Grok requests send store false and ask for encrypted reasoning; each run of reasoning items rides on the part after it (ADR 0046) and is replayed before that part within the turn's tool loop, for the same provider and model only.
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/gptLlm.ts
  - resource: lib/models/grokLlm.ts
  - resource: lib/models/providerState.ts
  - resource: lib/models/capabilities.ts
  - resource: tests/responsesReasoningState.test.ts
---

# ADR 0048: The Responses adapters replay encrypted reasoning items and store nothing with the vendor

## Context

OpenAI's and xAI's reasoning models return `reasoning` output items, and both vendors ask for them back on the next request of a tool loop so that the model continues its reasoning instead of starting over. The GPT adapter (`lib/models/gptLlm.ts`, which `GrokLlm` subclasses) dropped those items, so the model re-reasoned at every step. The capability matrix marked thinking with tool use degraded on both rows.

The adapter sent neither `store` nor `include`. The Responses API stores a response by default: OpenAI keeps it for 30 days, and so does xAI. Any reasoning model that the engine called therefore left its responses on the vendor's servers. The engine never read them back.

[ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md) set the convention: provider-opaque state rides on the part it belongs before, and only an adapter of the same provider replays it.

## Decision

- **Which ids.** OpenAI's reasoning ids (o-series and `gpt-5*`) and xAI's `grok-4.5` and `grok-4.7`, through the adapter hook `replaysReasoning()`. Other ids send nothing new.
- **The request.** Those ids send `store: false` and `include: ['reasoning.encrypted_content']`. The vendor keeps no copy of the response, and each reasoning item comes back carrying its encrypted content, so it can be sent back without a stored copy. xAI documents both fields on its Responses API, and `grok-4.7` returns the encrypted content even unasked (docs.x.ai, checked 2026-10-07).
- **Write.** Each run of reasoning items that carry encrypted content rides verbatim, as `providerState { provider: 'openai' | 'xai', kind: 'reasoning_items', model, payload }`, on the part made from the output item right after it: a function call, or the first text of a message. A run followed by anything else (a server-side tool call, a message without text, nothing) is dropped. The adapter writes the state on the streamed and the non-streamed path alike, from the final response.
- **Replay.** Within the current turn's tool loop, the adapter sends the items as input items immediately before their part's item. The turn starts at the last user content that is not purely tool results; `currentTurnStart` in `lib/models/providerState.ts` holds that rule for every adapter. Only the same provider's and model's items are replayed. A model content that replays keeps the model's order of message and `function_call`, so every run is followed by the item it preceded.
- **The guarded retry.** A 400 on a request that carries reasoning additions is retried once without the reasoning param, the `include` and the replayed items. `store: false` stays, and the span carries `llm.retry_without_reasoning`.

## Alternatives

- **`previous_response_id` with `store: true`.** The vendor would chain the reasoning itself, and requests could shrink to the newest items. But every response would stay on the vendor's servers for 30 days, a retention choice the deployment never made. The chain also breaks after 30 days, on another key or organisation (an A2A caller funds its own calls), and on a model switch. Resuming an interrupted turn (ADR 0028) would then depend on vendor state the session does not hold. ADK also builds the full history for every step, so the adapter would have to cut its own input to match a server-side chain.
- **Keep the default storage and send the items by id.** This needs the same 30-day vendor copy, and an item whose copy has expired fails the request.
- **Carry a run across a server-side tool call by replaying the call item too.** That would send `web_search_call` and `custom_tool_call` items back as input, a shape neither vendor documents for this purpose. Dropping such a run loses only reasoning that the model already acted on in the same response.
- **Leave Grok degraded.** xAI documents both fields, so the two rows behave alike.

## Consequences

- The capability matrix marks thinking with tool use as supported on the OpenAI and xAI rows. The cells are asserted against the outgoing request in `tests/capabilityMatrix.test.ts`, and the tool loop is driven through a real ADK runner in `tests/responsesReasoningState.test.ts`.
- `store: false` ends the vendors' default server-side retention for these calls, so their responses no longer appear in the vendor's stored-response logs. The engine's own ledger and traces remain the record of a turn.
- Session events now carry the encrypted reasoning items and their summaries. An item's encrypted content can run to several kilobytes. The transcript projection drops the items with the rest of a past turn.
- Replayed items are input tokens on the next step, and the model no longer spends output tokens reasoning again from the start.
- Encrypted reasoning is bound to the organisation whose key produced it. A step that another organisation's key funds, such as a turn resumed under a different caller's key, has its replayed items refused with a 400. The retry then runs that step without them.
- The retry keeps `store: false`. An endpoint behind `OPENAI_BASE_URL` that refuses the field fails the call instead of storing the response.
- The offline suites assert the wire shape against fixtures. The first funded run (`npm run parity`) is its live check. If a vendor refuses a replayed item with a 400, the retry falls back to the earlier behaviour for that step.
