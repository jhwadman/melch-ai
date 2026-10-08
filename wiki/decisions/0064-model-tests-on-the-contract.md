---
type: decision
title: "ADR 0064: The model tests assert from a ModelRequest; the ADK path is held to them by one suite of shim cases and a scanned allowlist"
description: "The model suites (models, capabilityMatrix, endpoints, gateway, modelRetry) drive the contract adapters with ModelRequests and assert the wire body, so the native runtime inherits them. One suite, tests/shimBodies.test.ts, holds each provider's ADK class to its adapter's body for every capability-matrix input. ScriptedLlm becomes the ADK shim around ScriptedModel and passes its script's LlmResponses through as written. tests/llmRequestBoundary.test.ts fails any test outside an explicit allowlist that builds an LlmRequest. Shim cases in every model suite, a round trip of the scripted responses through the mapping, and converting every ADK-path suite now were rejected."
tags:
  - decision
  - models
  - testing
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: tests/shimBodies.test.ts
  - resource: tests/llmRequestBoundary.test.ts
  - resource: tests/helpers/capabilityInputs.ts
  - resource: tests/helpers/scriptedLlm.ts
  - resource: tests/helpers/scriptedModel.ts
  - resource: tests/capabilityMatrix.test.ts
  - resource: tests/models.test.ts
  - resource: tests/modelRetry.test.ts
---

# ADR 0064: The model tests assert from a ModelRequest; the ADK path is held to them by one suite of shim cases and a scanned allowlist

## Context

Every provider's translation now lives in a contract adapter ([ADR 0048](/decisions/0048-engine-owned-model-contract.md)), and under ADK each runs behind its shim class ([ADR 0053](/decisions/0053-adapter-caller-charges-and-traces.md), [0055](/decisions/0055-claude-adapter-keeps-the-adk-request.md) to [0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md)). The model suites still built ADK `LlmRequest`s and drove the shim classes, so they tested the adapters only through the genai mapping, and the native runtime ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)) would inherit none of them when ADK leaves. Gate G1 was signed with this ticket (WS1-11) still open.

Three questions needed an answer: where the ADK path's own checks go once the suites move onto the contract, what the scripted ADK model the runtime tests use (`ScriptedLlm`) becomes, and how to keep new tests from building `LlmRequest`s again.

## Decision

1. **The model suites assert from a ModelRequest.** `tests/models.test.ts`, `capabilityMatrix.test.ts`, `endpoints.test.ts`, `gateway.test.ts` and `modelRetry.test.ts` drive `ClaudeAdapter`, `GptAdapter`, `GrokAdapter`, the chat-completions adapters, `AdkGeminiAdapter` and `GeminiAdapter`, and assert the body each posts and the `ModelResponse`s it yields. Tool declarations come from real tool objects through `contractToolDeclaration`, and server-side tools are named in `nativeTools`, as a request carries them on either runtime. The capability matrix's inputs and capture harness move to `tests/helpers/capabilityInputs.ts`.
2. **One suite of shim cases per provider.** `tests/shimBodies.test.ts` sends each capability-matrix input through the provider's ADK class, as the LlmRequest `modelRequestToLlmRequest` makes of it, and requires the body the contract adapter sends for the ModelRequest itself: `ClaudeLlm` (on Claude 4.6 and Opus 5.5), `GptLlm`, `GrokLlm`, `KimiLlm`, `OllamaLlm`, `GatewayLlm`, and `TracedGemini` against `AdkGeminiAdapter`. It also keeps the ADK path's own behaviour the moved suites asserted: the web_search sentinel read by its marker ([ADR 0062](/decisions/0062-server-side-tools-as-markers.md)), and `TracedGemini`'s throw on a 400.
3. **`ScriptedLlm` is the shim around `ScriptedModel`.** It subclasses `AdkShim`, so the turn's charge, the abort and the `llm.request` span are the shim's, as for every production adapter. Its script keeps ADK's terms: it receives the LlmRequest the shim mapped, and its LlmResponses reach ADK exactly as written, through the `toLlmResponse` seam. Its `ScriptedModel` records the ModelRequests. Every test that used it is unchanged, except that the request a failed call records on its span now carries the stream flag the shim always passes.
4. **A scanned allowlist.** `tests/llmRequestBoundary.test.ts` fails a test file that names `LlmRequest`, calls `modelRequestToLlmRequest`, or writes `toolsDict` or `liveConnectConfig`, unless an explicit list names it with a reason: the shim and its mapping, the per-provider shim cases, the ADK runtime and tool layer WS2 replaces (the boundary suite among them, until WS2-12), and the ADK-path provider suites whose contract twins assert the same bodies (`claudeCurrentApi`, `claudeVision`, `reasoningKey`). A listed file that no longer builds one fails it too, and the five suites above can never be listed.

## Alternatives considered

- **ADK-path cases inside each model suite.** Each suite would keep a few shim cases beside its contract cases. Rejected: every suite would then need the allowlist, so the list could no longer tell a model suite on the contract from one that is not, and the cases would repeat the same capture per suite. One suite over the matrix's inputs covers every provider and every capability in one place.
- **Round-trip `ScriptedLlm`'s responses through the mapping** (`llmResponseToModelResponse`, then `modelResponseToLlmResponse`). It would exercise the mapping on every scripted turn. Rejected: the boundary suite compares `ScriptedLlm` with a `ScriptedModel` behind the plain shim, and with both sides mapped the comparison would test the mapping against itself. Passing the written responses through keeps one side in ADK's shape, which is what the suite is for, and the mapping has its own suite (`tests/genaiMapping.test.ts`).
- **Keep `ScriptedLlm` an ADK `BaseLlm` that calls the tracer itself.** No change to any test. Rejected: the ticket asks for the shim, and the scripted model would charge and trace by its own code path, not the one every adapter now uses.
- **Convert every suite that builds an LlmRequest now.** `claudeCurrentApi`, `claudeVision` and `reasoningKey` drive the ADK classes end to end, including the shim's span, and their bodies are already asserted from ModelRequests in `claudeAdapter.test.ts`, `chatCompletionsAdapter.test.ts` and `responsesAdapter.test.ts`. They stay listed, by name and reason, for a later ticket. The runtime suites move with WS2.
- **Match only an import of the `LlmRequest` type.** Rejected: a request built as `{ toolsDict: {} } as any` names no type, and `gateway.test.ts` built them that way.

## Consequences

- A model test written today states its case as a ModelRequest; the native runtime's model-call site (WS2) runs the same adapters on the same requests.
- A change to an adapter's body fails the model suite; a change to a shim's mapping that alters the body fails `tests/shimBodies.test.ts`.
- `ScriptedLlm`'s script receives the request's merged signal (the turn's, ADK's, or the config's), as every shimmed adapter does.
- The allowlist shrinks as WS2 removes the ADK runtime, and empties when ADK leaves at 1.0.
