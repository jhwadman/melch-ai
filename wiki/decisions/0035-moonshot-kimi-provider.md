---
type: decision
title: 'ADR 0035: Moonshot AI (Kimi) is a direct provider; its search stays off the model'
description: kimi-* ids get their own chat-completions adapter funded by MOONSHOT_API_KEY, with a tested capability row, rather than only the gateway path; Moonshot's web search is not wired as native search because the model-side tool is retiring and its successor is a REST API.
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-10-02
sources:
  - resource: lib/models/kimiLlm.ts
  - resource: lib/models/providerMap.ts
  - resource: lib/models/capabilities.ts
---

# ADR 0035: Moonshot AI (Kimi) is a direct provider; its search stays off the model

## Context

Kimi K3 (Moonshot AI, July 2026) is the strongest open-weight model on the
public coding and research leaderboards of autumn 2026, and the first of its
class to be served first-party with tool calling, strict structured output
and vision. Its price is not the draw: $3 / $15 per 1M tokens is Claude
Sonnet 4.6's rate, Claude Sonnet 5.5 is cheaper per token, and thinking is
always on and billed as output. The draw is open weights at the top of the
boards and a flat-rate 1M context. The framework could
already reach it through `MODEL_GATEWAY` as `moonshotai/kimi-k3`, but the
gateway path carries no provider defaults, no doctor entry, no capability
row, and no reasoning controls.

Moonshot's API is OpenAI Chat Completions (it also serves Responses and an
Anthropic-compatible Messages endpoint). Its model-side web search, the
`$web_search` built-in function, is documented as retiring on 2026-10-20 in
favour of standalone REST endpoints (`POST /v1/tools/search`, billed per
call) that an application calls itself.

## Decision

1. **`kimi-*` is a provider prefix** (`moonshot`, key `MOONSHOT_API_KEY`,
   console platform.moonshot.ai) in the prefix table, the registry, the
   doctor, the env template and the gateway slug map (`moonshotai`).
2. **A direct adapter over the chat-completions base**
   (`lib/models/kimiLlm.ts`), not the Responses or Messages dialects: the
   base already gives tool calling, strict `json_schema`, SSE with usage,
   base64 images and `reasoning_content` as THINKING, and neither other
   dialect adds a capability the framework uses.
3. **Reasoning per generation.** `kimi-k3` takes `reasoning_effort`; the
   adapter pins `high` (`DEFAULT_KIMI_REASONING_EFFORT`) below Moonshot's
   default `max`, and maps `none` to `low` because K3 cannot stop thinking.
   K2.x ids take a `thinking` switch and never receive `reasoning_effort`.
4. **Native search is not wired.** The sentinel is dropped with a warning,
   as on Ollama, and the matrix says why. A client-side tool over Moonshot's
   REST search can come later as a tool contract, not as native search.
5. **Thinking with tools is stated as degraded**, not hidden: Moonshot asks
   for K3's `reasoning_content` back on the assistant message of a tool
   loop; the base keeps scratchpads out of history (ADR 0027's shape), so K3
   re-reasons each step. Replaying it would mean persisting thought parts in
   session history for one provider, which is a separate decision.
6. **The model zoo gains a sixth agent**, `kimi` on `kimi-k3` at low effort,
   so `npm run demo:models` proves the surface the moment a key is present.

## Alternatives considered

- **Gateway only.** Rejected: no defaults, no doctor row, no effort control,
  and the capability matrix ([ADR 0019](/decisions/0019-multi-model-parity-matrix.md))
  requires a tested row before a provider is called supported.
- **The Anthropic-compatible endpoint through `ClaudeLlm` with a base URL.**
  Rejected: it serves only `kimi-k3`, and the Claude adapter's forced-tool
  structured output and thinking-block replay are Anthropic semantics
  Moonshot does not document.
- **Wiring `$web_search` as native search.** Rejected: it retires in
  eighteen days and its replacement is not a request field.

## Consequences

- `ProviderId` gains `moonshot`; every exhaustive switch and record was
  extended, and TypeScript enforces the next one.
- Every cell of its row is asserted against the request body the adapter
  sends (`tests/capabilityMatrix.test.ts`, `tests/models.test.ts`). One
  plain turn was verified live on 2026-10-03 (`npm run demo:models`,
  kimi-k3 at low effort, 17.9 s, 262 thinking tokens surfaced); tool loops
  and the dropped search were not exercised live.
- `kimi-k2.5` and the `moonshot-v1` ids, retired on 2026-08-31, are not
  routed by name; the 404 hint names the retirement.
- The cost guidance lives in the adapter header, the config comment,
  DOCUMENTATION §5 and the zoo file: K3 for the strongest open weights,
  `kimi-k2.6` (a quarter of the price) for cost, the gateway's quantized
  endpoints for cheap K3 with fidelity as the trade.
