---
type: decision
title: 'ADR 0048: The engine owns its model message format, not @google/genai Content'
description: Every model adapter implements one engine-owned contract (lib/models/contract.ts) of messages, parts, a request, a response stream and an adapter interface, a leaf with no @google/* in its import graph. genai Content stays only as a mapping for stored sessions and the ADK path. Kept Content and adopting another library's types were rejected.
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/models/contract.ts
  - resource: lib/loadSyndicate.ts
  - resource: tests/modelContract.test.ts
---

# ADR 0048: The engine owns its model message format, not @google/genai Content

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) sets the engine on owning its runtime, the model contract first. Every adapter today receives ADK's `LlmRequest` and yields `LlmResponse`, both built on `@google/genai` `Content`, which is Gemini's wire format. Six adapters translate it to five other wires, and the format shows its origin in five ways:

- **No slot for reasoning state.** Another provider's state rides as an extra field on a part ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md)), which the genai types do not know.
- **Gemini's schema dialect.** Tool and output schemas arrive in uppercase types, and every non-Gemini adapter converts them (`lib/models/schemaNormalize.ts`).
- **Sentinel tools.** Server-side tools travel as tool objects with no declaration, which each adapter has to recognise and strip (`isWebSearchSentinel` and its siblings).
- **Failures with two shapes.** ADK's Gemini adapter throws on a failed call, the others yield an `errorCode`, and an empty `STOP` candidate arrives as an error code the turn runner has to ignore.
- **Reasoning mapped once, for one model.** The compiler writes the agent's reasoning into provider fields for the primary model, so a fallback model receives the primary's mapping ([ADR 0047](/decisions/0047-provider-neutral-reasoning-key.md)).

The native runtime needs one format that it and every adapter share.

## Decision

1. **One engine-owned contract.** `lib/models/contract.ts` defines it:
   - `Message`: system, user, assistant and tool messages, each typed to the parts it may hold.
   - `Part`: text, thinking (display only), toolCall, toolResult and blob. Any part may carry `providerState`, reusing ADR 0046's type.
   - `ToolDeclaration`, with lowercase JSON Schema `parameters` and a `strict` flag.
   - `NativeTool`: the server-side tools by name, in place of sentinel objects.
   - `ModelRequest`, `ModelResponse` (separate partial and final shapes) and `ModelAdapter` (`provider`, `model`, `generate(request): AsyncIterable<ModelResponse>`).
   - `ProviderCapabilities`, from which the capability matrix can later be derived.
2. **A leaf.** The module is types only, its one import is `ProviderState`, and no module in its import graph names `@google/*`. `tests/modelContract.test.ts` asserts that and walks a full tool loop written in the contract.
3. **The reasoning key belongs to the contract.** `ReasoningSetting` moves from the loader to the contract, and `lib/loadSyndicate.ts` imports and re-exports it, so the dependency points from the loader to the contract. Each adapter maps the setting itself, so a fallback model gets its own mapping.
4. **The adapter rules are part of the contract.** Partials carry deltas. Exactly one final, which never holds thinking, ends every call. A failure is a final with `error` set, never a throw. The abort signal stops the request in flight, and a cancellation is never retryable.
5. **Error codes carry over verbatim.** `error.code` keeps every code the adapters emit under ADK, Gemini's finish and block reasons included, so a caller matching on one keeps working. `GEMINI_ERROR` is added for the failed call ADK throws. `retryable` decides whether a fallback answers.
6. **One meaning for usage.** Input tokens include cached ones, and output tokens include thinking ones. The cache and thinking counts are parts of those totals, on every provider.
7. **Tool choice is a preference.** An adapter weakens a forced choice to `auto` where the provider rejects forcing (Anthropic's Fable 5.1, Opus 5.5 and Sonnet 5.5, and Claude with thinking on) and marks the span.
8. **genai Content becomes a mapping.** Stored sessions and the ADK path keep `Content`. The mapping between it and the contract is one-to-one, and the stored Event JSON keeps its shape.

`wiki/models/model-contract.md` gives every field's purpose and each provider's mapping to its wire.

## Alternatives considered

- **Keep genai `Content` as the internal format.** It costs nothing now, and Gemini needs no translation. But it keeps all five problems above, and it keeps `@google/genai` in the engine's core after ADK leaves at 1.0. Its types are Google's to change: ADK and genai are pinned exact because a minor version changed part shapes. Every non-Gemini adapter would stay a translation from Gemini's wire.
- **Adopt another library's types:**
  - **The Vercel AI SDK's provider types** (`LanguageModelV2` and its prompt parts) are the closest fit and ship adapters. But they are versioned with that SDK, its provider packages bring their own request shaping and retries, and opaque reasoning state rides in a provider-metadata bag the engine would read through their conventions. That is the lock-in ADR 0045 rejects for the runtime, moved down one layer.
  - **One vendor's SDK types** (OpenAI's Responses items or Anthropic's `MessageParam`) put another vendor's wire at the centre, swapping Gemini's quirks for that vendor's.
  - **LangChain's message classes** bring a large dependency for a handful of types.

  In each case the types are cheap to write and expensive to depend on. The engine's contract is one file of types it controls.
- **A free-form `providerOptions` bag on the request** for `topK`, `seed`, `safetySettings` and effort words outside the four levels. Rejected for now. A bag is untyped and per-provider, which is the dialect problem the `reasoning:` key removed. The contract names what it leaves out, and a field joins it when an agent needs one on the native runtime.

## Consequences

- The adapter tickets (WS1-4 to WS1-6) implement `ModelAdapter`, and the genai mapping (WS1-2) is a pure function both ways, specified in `wiki/models/model-contract.md`.
- Server-side tools stop being sentinel objects on the native path. The sentinels stay on the ADK path until it is removed.
- Lowercase JSON Schema is the one dialect inside the contract. A schema in Gemini's uppercase dialect is converted once, where it enters, instead of by every adapter, and Gemini receives the lowercase form as `parametersJsonSchema` and `responseJsonSchema`.
- A consumer can import the types as `melchizedek-agents/models/contract`. Nothing in the barrel changes.
- Fields the contract leaves out (`topK`, `seed`, penalties, `safetySettings`, JSON mode without a schema, `includeThoughts`, effort words beyond the four levels) work only on the ADK runtime until a field is added.
- G1 of ADR 0045 is met once every capability-matrix cell asserts against this contract.
