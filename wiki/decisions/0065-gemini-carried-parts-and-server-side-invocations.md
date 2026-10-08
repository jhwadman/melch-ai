---
type: decision
title: "ADR 0065: GeminiAdapter carries code execution and server-side invocations on the next part, asks for invocations on the Gemini API only, and keeps a placeholder signature off"
description: "GeminiAdapter carries the Gemini parts the contract has no type for (executableCode, codeExecutionResult, server-side toolCall and toolResponse) whole, as providerState of kind carried_parts on the next output part, and replays them before that part within the current turn. It sends includeServerSideToolInvocations when native tools sit beside function declarations, on the Gemini API only, because the SDK refuses it for Vertex AI. Gemini's documented placeholder thought signature sits behind a constant, off by default, until the G3 live run. Projecting the parts as visible text, a new contract part type, always sending the flag and sending the placeholder by default were rejected."
tags:
  - decision
  - models
  - gemini
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/models/geminiAdapter.ts
  - resource: lib/models/geminiState.ts
  - resource: lib/models/providerState.ts
  - resource: lib/compile.ts
  - resource: tests/geminiAdapter.test.ts
---

# ADR 0065: Gemini's carried parts, server-side invocations and the placeholder signature

## Context

The engine's [Gemini adapter](/models/gemini-adapter.md) has to cover Gemini's own features before it can replace the [wrapper over ADK's Gemini](/models/adk-gemini-adapter.md) at gate G3 ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)). Three of them did not fit what the adapter did:

- **Parts the contract has no type for.** With code execution, a response holds `executableCode` and `codeExecutionResult` parts. With native tools beside function declarations, Gemini 3 can also return server-side `toolCall` and `toolResponse` parts. Gemini wants them back within the turn, in order, with their thought signatures. The contract's output parts are text, tool calls and blobs ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)).
- **`toolConfig.includeServerSideToolInvocations`.** The ADK path sends it on every Gemini agent (`lib/compile.ts`). `@google/genai` 2.25 throws before any request when it is set on a Vertex AI client: "only supported in Gemini Developer API mode".
- **A current-turn call with no signature.** After a mid-turn fallback, a step's function call was made by another provider or model and has no Gemini signature. Gemini 3 rejects such a request with a 400. Gemini documents a placeholder signature for exactly this case, which no test here can confirm against the API.

## Decision

1. **Carried parts ride on the next output part.** The adapter keeps each such part whole, as Gemini sent it, its own `thoughtSignature` included, and writes the run of them as `providerState { provider: 'gemini', kind: 'carried_parts', model, payload: { before, signature? } }` on the next output part ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md)). `signature` is that part's own thought signature, since a part holds one `providerState`. A part without carried parts keeps the plain `thought_signature` kind. A run with no output part after it rides on an empty text part of its own.
2. **Replay.** Within the current turn the carried parts go back immediately before the part that holds them. This model's signatures go with them; another Gemini model's carried parts go back without their signatures. Earlier turns' carried parts are not sent, as their signatures are not. Another provider ignores the state.
3. **Server-side invocations are asked for on the Gemini API only**, and only when native tools sit beside function declarations. On Vertex AI the flag is never sent.
4. **The placeholder signature is off by default.** `PLACEHOLDER_THOUGHT_SIGNATURE` (`skip_thought_signature_validator`, Gemini's documented value) goes on the first unsigned function call of each current-turn step only when the adapter is built with `placeholderSignatures: true`. The default is `PLACEHOLDER_SIGNATURES_BY_DEFAULT`, false, until the G3 live run confirms the value and the 400 it avoids.

## Alternatives considered

- **Project the parts as visible text, as the genai mapping does** (code in a fenced block, its output as text, the part kept as `genai_part` state). The final's text would then hold code the model ran but did not say, which changes what a person reads and what a structured answer parses. The mapping does it because it must round-trip ADK's stored events byte for byte; the adapter has no such constraint.
- **A contract part type for code execution.** Every other adapter would have to learn to skip it, and no other provider returns it today. The state convention exists so that one provider's machinery rides through the others unread.
- **Always send `includeServerSideToolInvocations`, as the ADK path does.** On Vertex AI every call would fail inside the SDK. With function declarations alone or native tools alone it asks for nothing the response needs.
- **Send the placeholder by default.** It would hide a 400 that only a live run can confirm, with a value that only Gemini's documentation vouches for. Off, a mid-turn fallback onto Gemini 3 fails visibly, and the fallback chain ([ADR 0044](/decisions/0044-fallback-model-and-circuit-breaker.md)) still answers.

## Consequences

- A two-step tool loop with code execution replays the code, its result and every signature on the second step, through the real SDK, and none of it on the next turn. `tests/geminiAdapter.test.ts` asserts it.
- The `carried_parts` kind is read only by `GeminiAdapter`. The ADK wrapper and the genai mapping pass it through as another adapter's state, so a session that switches between the two Gemini adapters mid-turn loses the carried parts and that part's signature. Nothing switches mid-turn: one adapter serves the Gemini ids at a time.
- The ADK path sends the flag on Vertex AI too, so a Gemini agent on Vertex AI fails there inside the SDK. That path is not changed here.
- The G3 live run confirms: the carried parts and their signatures as accepted on replay, the flag's effect beside function declarations, and the placeholder value.
