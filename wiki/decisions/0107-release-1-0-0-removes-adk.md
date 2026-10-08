---
type: decision
title: "ADR 0107: 1.0.0 removes Google ADK, with the soak waived, and runSyndicateTurn takes the engine's session and memory interfaces"
description: "Release 1.0.0 deletes the ADK runtime, the ADK peer and dev dependency, and every module that existed for them (lib/adkPeer.ts, lib/compileAdk.ts, the ADK shim and model classes, TracedGemini, AdkGeminiAdapter, the tool wrappers, the session and memory bridges, the ADK Workflow compile, retryPlugins). The owner waived ADR 0045's two-week soak on 2026-10-08 on the evidence of gates G1 to G4, the WS5-5 security PASS, live parity 36/36 on six providers under native, pipeline.yaml live, and production on native since Heroku v162. The one change to a fixed shape: runSyndicateTurn's sessionService and memoryService take the engine's SessionService and MemoryService. MELCHIZEDEK_RUNTIME=adk and GEMINI_ADAPTER=adk are errors naming 1.0.0; native and engine are accepted no-ops. The stored Event JSON, the interrupt names and the A2A surface do not change. Keeping the soak, keeping ADK's method names on the stores, keeping registerAvailableProviders as a no-op, ignoring a leftover adk setting, and keeping ADK as a test dependency were rejected."
tags:
  - decision
  - runtime
  - release
  - package
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/runtimeFlag.ts
  - resource: lib/runtime/sessions.ts
  - resource: lib/runtime/memoryService.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/models/registry.ts
  - resource: lib/toolRegistry.ts
  - resource: lib/runtime/native/step.ts
  - resource: tests/nativeLedgerCounts.test.ts
  - resource: lib/index.ts
  - resource: package.json
  - resource: tests/importGraph.test.ts
  - resource: tests/sessionFixtures.test.ts
  - resource: tests/packageSurface.test.ts
  - resource: scripts/ci/consumer_turn.mjs
  - resource: .github/workflows/ci.yml
  - resource: CHANGELOG.md
---

# ADR 0107: 1.0.0 removes Google ADK, with the soak waived, and runSyndicateTurn takes the engine's session and memory interfaces

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) moves the engine off Google ADK in stages and makes release 1.0.0 the one that removes it: its runtime path and its peer dependency. It names five gates and two stop rules. The second stop rule asks for two weeks in production with `native` as the default and no incident attributed to the runtime before the ADK path is deleted. [ADR 0102](/decisions/0102-native-default-and-optional-adk-peer.md) made `native` the default in 0.20.0 and `@google/adk` an optional peer that one module, `lib/adkPeer.ts`, loaded. [ADR 0108](/decisions/0108-adk-reference-recorded-by-the-parity-suites.md) recorded ADK's side of every parity case, so the comparisons survive ADK's removal.

The evidence on 2026-10-08:

- Gates G1 to G4 are signed in ADR 0045's gate log.
- The WS5-5 security review passed.
- The live parity run (`npm run parity`) under `native` passed 36 of 36 checks on all six providers.
- `config/agents/examples/pipeline.yaml` ran live on native.
- The production A2A server has run on native since Heroku release v162.
- Every ADK-written session fixture (`tests/fixtures/sessions`) resumes on native.

ADR 0045 also fixes four shapes that change only with an ADR. The `runSyndicateTurn` signature is one of them, and its `sessionService` and `memoryService` parameters were typed as ADK's `BaseSessionService` and `BaseMemoryService`, so a consumer wrapped the engine's own store in `asAdkSessionService` to hand it in. With ADK gone those types cannot stay.

## Decision

1. **The soak is waived.** The owner waived ADR 0045's two-week stop rule on 2026-10-08. The evidence above stands in for it. The first stop rule (every ADK-written session fixture resumes) still holds and is tested.
2. **The ADK path is deleted.** Gone: `lib/adkPeer.ts`, `lib/compileAdk.ts`, the adk branch of `runSyndicateTurn`, `retryPlugins`, the ADK `Workflow` compile in `lib/workflow.ts` (`compileWorkflow`, `assembleWorkflow`), the model shim and every ADK model class (`AdkShim`, `ClaudeLlm`, `GptLlm`, `GrokLlm`, `KimiLlm`, `OllamaLlm`, `GatewayLlm`, the chat-completions shim, `FallbackLlm`, `TracedGemini`, `AdkGeminiAdapter`) with LLMRegistry registration, the tool wrappers (`lib/tools/adkTool.ts`, `toFunctionTool`) and the ADK sentinel tool classes, the session and memory bridges, and the ADK paths in the wiki agent runner. `@google/adk` leaves `peerDependencies`, `peerDependenciesMeta` and `devDependencies`.
3. **One runtime, and the flags say so.** `RuntimeName` is `'native'`. `MELCHIZEDEK_RUNTIME=native` and the `runtime: 'native'` option are accepted and change nothing, so a deployment that named its runtime keeps working. `MELCHIZEDEK_RUNTIME=adk` is an error, `RuntimeRemovedError`, which names 1.0.0 and the fix: the A2A server (`createA2AApp`), the chat and the worker read the setting at startup and stop, `runSyndicateTurn` throws before the session is touched, and the doctor reports a problem. `GEMINI_ADAPTER=engine` is accepted; `GEMINI_ADAPTER=adk` throws, naming 1.0.0.
4. **The one change to a fixed shape.** `runSyndicateTurn`'s `sessionService` is the engine's `SessionService` (`lib/runtime/sessions.ts`) and its `memoryService` the engine's `MemoryService` (`lib/runtime/memoryService.ts`). The parameter names, the option keys, their order and the result are unchanged. Two typings follow from ADK's types leaving and are recorded here with it: `TurnEvents.onEvent` receives the engine's `TurnEvent` (the JSON ADK's `Event` carried), and `transformAgent`, which took ADK agents, keeps its key but any value is refused with `UnsupportedOnRuntimeError` before the session is touched.
5. **The other fixed shapes do not change.** The stored Event JSON in `adk_sessions.events` and `adk_session_events`, the interrupt names (`adk_request_confirmation`, `ask_user`) and their argument shapes, and the A2A surface stay as they are. `tests/sessionFixtures.test.ts` resumes the ADK-written fixtures on every run.
6. **The stores and the memory service have one face.** `InProcessSessionService`, `PostgresSessionService`, `SupabaseSessionService` and `ProjectedSessionService` implement `SessionService` alone; `SupabaseVectorMemoryService` implements `MemoryService` alone. ADK's method names (`createSession`, `appendEvent`, `addSessionToMemory`, `searchMemory`) are gone.
7. **Tools and models are the engine's.** The registry holds the engine's `Tool`, `InstructionTool`, `NativeToolMarker` and `Toolset`; `registerTool` refuses an ADK tool by name, pointing at `defineTool`. A model resolver returns an id or a `ModelAdapter`; an ADK model class is refused before any model call. `registerAvailableProviders`, which registered ADK classes, is replaced by `logProviderStatuses`, which reports and registers nothing.
8. **Google's SDK only where it belongs.** `@google/genai` stays a dependency. `tests/importGraph.test.ts` holds that nothing under `lib/` or `scripts/` names Google ADK, and that `@google/genai` is imported only by the Gemini adapter (`lib/models/geminiAdapter.ts`) and the genai mapping it and the stored events speak (`lib/models/genaiMapping.ts`), the image tools (`generateImageTool.ts`, `inspectImageTool.ts`, and `xApiSearchTool.ts`, whose photos a Gemini vision pass transcribes) and memory embeddings (`lib/memory/providers.ts`). The genai request and response shapes the engine used to borrow from ADK (`LlmRequest`, `LlmResponse`) are declared in `genaiMapping.ts`.
9. **The tests run once.** The dual-runtime helpers are deleted. The parity suites compare against ADK's recorded side (ADR 0108), which is data now: the recorder and its CI check are retired. The session fixtures' generator, which drove ADK, is retired the same way; the fixtures stay.
10. **The release is G5.** ADR 0045's G5 stays open until the owner tags and publishes 1.0.0.

## Alternatives considered

- **Keep the two-week soak.** It would hold the release for two weeks to learn what the evidence above already shows; the production server has run on native since v162, every provider passed live parity on native, and the stop rule that protects stored data is a test that runs on every commit.
- **Keep ADK's method names on the stores and the memory service as deprecated aliases.** They would keep ADK's semantics alive (ADK's `appendEvent` merged state through its base class) in a release whose point is that those semantics are the engine's own, and a consumer calling them would keep code that names ADK. The changelog's migration list maps each name.
- **Keep `registerAvailableProviders` as a no-op.** A function named for registering into ADK's LLMRegistry that registers nothing misleads; `logProviderStatuses` says what it does.
- **Ignore a leftover `MELCHIZEDEK_RUNTIME=adk`, or warn and run native.** A deployment that set it on purpose expects ADK; running something else without saying so is the silent change ADR 0045 exists to avoid. An error at startup names the release and the fix. `native` stays accepted because it asks for what runs.
- **Keep `@google/adk` as a dev dependency to re-record the references.** ADR 0108 already rejected it: the recordings are the reference, and a test-only ADK keeps the second registry and the version pin alive.

## Consequences

- A consumer uninstalls `@google/adk`, passes the engine's stores, defines tools with `defineTool`, and unsets any `adk` setting; `CHANGELOG.md`'s 1.0.0 "Breaking — read before upgrading" section lists every removed export and the migration.
- The package has no top-level `await`, so it loads from CommonJS through `require()` again (`tests/packageSurface.test.ts`).
- CI runs the offline suite once and the storage suite once. The consumer step installs the packed tarball alone, checks that no ADK arrived with it, runs a turn, serves an A2A message and checks that `MELCHIZEDEK_RUNTIME=adk` is refused.
- ADR 0024's seam, boundary suite and A2A items stand; its "track ADK's current major" item no longer applies.

## One output meaning on the ledger

[ADR 0057](/decisions/0057-chat-completions-shims-keep-the-adk-shape.md) kept the provider's meaning for the chat-completions adapters on the ADK path, `candidatesTokenCount` counting the reasoning, and [ADR 0056](/decisions/0056-responses-usage-meaning-on-the-adk-path.md) did the same for GPT and Grok, so the ledger's counts would not change. The shims that did it are deleted with ADK. The native step maps every adapter's final through one function, `usageToMetadata` (`lib/models/genaiMapping.ts`), and it has done so in production since 0.20.0 made `native` the default.

This release keeps that one meaning for every provider and supersedes ADR 0057's and ADR 0056's ledger clauses (their other decisions are gone with the shims). `llm.tokens.output`, the turn's output charge and the ledger's `output_tokens` exclude the thinking; `llm.tokens.thinking` and `thinking_tokens` carry it, so output plus thinking is the provider's own output count. That sum holds because every adapter fills the contract's `thinkingTokens` where its provider reports a split: Gemini's `thoughtsTokenCount`, the Responses `output_tokens_details.reasoning_tokens` (GPT, Grok), and the chat-completions `completion_tokens_details.reasoning_tokens` (Kimi, the gateways). Anthropic and Ollama report no split, so their whole output count is `output_tokens` and `thinking_tokens` is 0; the sum still holds. A Kimi call that used 40 completion tokens, 25 of them reasoning, records 15 and 25; the ADK path recorded 40 and 25.

Restoring the provider's meaning for chat-completions and Responses in the native step was rejected. It would make `output_tokens` mean two things by provider, and on the Responses path ADR 0056's meaning also wrote the reasoning into `thinking_tokens`, so output plus thinking counted it twice. Rows before 0.20.0 for GPT, Grok, Kimi and the gateways keep that older meaning; a query that compares output across that boundary subtracts `thinking_tokens` from those rows. `tests/nativeLedgerCounts.test.ts` pins the counts per provider family on the `adk_telemetry` and `adk_turns` rows.
