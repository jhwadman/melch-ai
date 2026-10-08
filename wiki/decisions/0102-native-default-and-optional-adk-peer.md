---
type: decision
title: "ADR 0102: 0.20.0 makes native the default runtime, and @google/adk an optional peer loaded in one module"
description: "Release 0.20.0 sets DEFAULT_RUNTIME to native and the registry's Gemini default to GeminiAdapter, and marks @google/adk optional in peerDependenciesMeta. lib/adkPeer.ts is the one module that loads ADK: a top-level await of a dynamic import, which hands out ADK's own classes when it is installed and stand-ins that construct as ADK's do, carry ADK's Symbol.for marks and throw AdkNotInstalledError on any ADK-only method when it is not. Everything else reaches ADK through it, and everything only ADK runs (the adk runtime, compileGraph, compileWorkflow, the retry plugins, GEMINI_ADAPTER=adk, a wiki agent on adk) asks for it by name. A consumer rolls back by installing @google/adk and setting MELCHIZEDEK_RUNTIME=adk. Splitting every dual-faced class in two, a synchronous require of ADK, and keeping ADK a required peer until 1.0.0 were rejected."
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
  - resource: lib/adkPeer.ts
  - resource: lib/runtime/runtimeFlag.ts
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/compileAdk.ts
  - resource: lib/workflow.ts
  - resource: lib/models/registry.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/doctor.ts
  - resource: lib/toolRegistry.ts
  - resource: package.json
  - resource: .github/workflows/ci.yml
  - resource: scripts/ci/consumer_turn.mjs
  - resource: tests/optionalAdk.test.ts
  - resource: tests/packageSurface.test.ts
  - resource: tests/helpers/withoutAdk.ts
  - resource: tests/sessionFixtures.test.ts
---

# ADR 0102: 0.20.0 makes native the default runtime, and @google/adk an optional peer loaded in one module

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) moves the engine off Google ADK in stages: a native runtime behind the turn runner's flag ([ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md)), then the native default, then ADK's removal at 1.0.0. 0.19.0 shipped native as an opt-in and moved the default to 0.20.0 ([ADR 0099](/decisions/0099-native-default-moves-to-0-20-0.md)), behind gate G3 and ADR 0045's stop rule: the default does not flip while any ADK-written session fixture fails to resume under native. G1 to G4 are signed in ADR 0045's gate log, and every fixture in `tests/fixtures/sessions` resumes under native in `tests/sessionFixtures.test.ts`.

`@google/adk` was a required peer ([ADR 0007](/decisions/0007-engine-as-package.md)), and about 45 modules in `lib/` imported it. Most imports were types. The value imports fell in three groups:

- **ADK-only machinery** used inside functions: `Runner`, `LlmAgent`, `AgentTool`, the retry plugins, ADK's `Workflow` nodes, `LLMRegistry`.
- **Classes extended at load time** by the engine's own dual-faced classes: `BaseTool` and `FunctionTool` (the tool registry builds FunctionTools that carry their own Tool, [ADR 0051](/decisions/0051-own-tool-base-behind-an-adk-wrapper.md)), `BaseToolset`, `BaseLlm` (the model shims and `FallbackLlm`), `Gemini` (`TracedGemini`), `BaseSessionService` (the durable stores and the transcript projection, which are also the engine's `SessionService`, [ADR 0058](/decisions/0058-session-stores-with-both-faces.md)).
- **Module-level instances**: the server-side tool sentinels, `GOOGLE_SEARCH`, the registry's FunctionTools.

The second and third groups load on every path, native included, and several of the exported names (`compileGraph`, `toFunctionTool`, `resolveModel`) are synchronous, so ADK cannot be imported lazily at the point of use.

## Decision

1. **`native` is the default runtime.** `DEFAULT_RUNTIME` in `lib/runtime/runtimeFlag.ts` is `native`; a turn's `runtime` option, else `MELCHIZEDEK_RUNTIME`, else `native`. `describeRuntime` returns the runtime and where it came from. The registry's `resolveAdapter` gives a Gemini id `GeminiAdapter` by default ([ADR 0100](/decisions/0100-gemini-row-asserted-on-the-engine-adapter.md) item 6); `GEMINI_ADAPTER=adk` keeps `AdkGeminiAdapter` for this release. The adk runtime keeps `TracedGemini`.
2. **`@google/adk` is an optional peer** (`peerDependenciesMeta`), still capped at `~2.2.0` and still a pinned dev dependency.
3. **One module loads ADK.** `lib/adkPeer.ts` tries `await import('@google/adk')` once, at its own load. A package that is not installed (`ERR_MODULE_NOT_FOUND` naming `@google/adk`) leaves it absent; any other failure is rethrown, so a broken install is never taken for a missing one. Every other module takes ADK's values from it; type-only imports of `@google/adk` stay where they are.
4. **With ADK installed, its exports are ADK's own.** `BaseTool`, `FunctionTool`, `BaseToolset`, `BaseLlm`, `Gemini`, `BaseSessionService` and `GOOGLE_SEARCH` are ADK's values, so the adk runtime, `instanceof` and ADK's model registry behave as before.
5. **Without it, they are stand-ins.** Each constructs as ADK's does (a tool's name, description and long-running flag; a FunctionTool's execute, parameters and confirmation flag; a model's id; Gemini's key and Vertex AI settings; a toolset's filter), carries ADK's `Symbol.for` mark so the engine's checks read it as they read ADK's, and throws `AdkNotInstalledError` from every method only ADK calls (`runAsync`, `processLlmRequest`, `generateContentAsync`, a store's base `appendEvent`). `getOrCreateSession` is ADK's own logic over the store's methods.
6. **What only ADK runs asks for it by name.** `requireAdk(feature)` returns the module or throws `AdkNotInstalledError`, whose message names the feature, the package, the install command and the native runtime. It guards the adk runtime (checked in `runSyndicateTurn` before the session is touched), `compileAdk` (so `compileGraph`, `compileSubagent`), ADK's `Workflow` (`compileWorkflow`), `retryPlugins`, `LLMRegistry` registration, `AdkGeminiAdapter` and a wiki agent on adk. `registerAvailableProviders` registers nothing without ADK and still returns the statuses.
7. **Native paths stop reaching for ADK where it was incidental.** The turn runner reads calls and responses with the engine's own `getFunctionCalls` / `getFunctionResponses` (`lib/runtime/events.ts`, ADK's semantics); a native dispatch classifier's throwaway lane is the engine's `InProcessSessionService`; the transcript projection's engine face unwraps a bridged engine store instead of going through ADK's base service.
8. **The doctor prints the runtime.** `melchizedek-doctor` opens with the runtime in use, its source, and whether `@google/adk` resolves (and its version), without loading it; `--check` fails when `MELCHIZEDEK_RUNTIME=adk` is set without ADK.
9. **The proof is the package without ADK.** `tests/optionalAdk.test.ts` and `tests/packageSurface.test.ts` run child processes whose resolver answers `@google/adk` as Node does for a missing package: from source and from a fresh build, every shipped syndicate completes a turn on the default runtime with a scripted model, the A2A server answers a message, and each ADK-only path names the package. CI consumes the packed tarball twice: without `@google/adk` (native) and with it (`MELCHIZEDEK_RUNTIME=adk`). The test suite's second CI run moves from `MELCHIZEDEK_RUNTIME=native` to `adk`, so the adk runtime stays covered; the session fixtures are generated on adk, pinned.
10. **Rolling back** is a consumer's choice for this release: install `@google/adk@~2.2.0` beside the package and set `MELCHIZEDEK_RUNTIME=adk` (or pass `runtime: 'adk'`). The runtimes store the same events, so a conversation moves either way. 1.0.0 removes the adk runtime and the peer.

## Alternatives considered

- **Split every dual-faced class into an engine class and an ADK wrapper.** The cleanest end state, and it is what 1.0.0 leaves once ADK goes. Now it would change the prototype chain of exported classes (`WebSearchTool`, `ClaudeLlm`, `PostgresSessionService`, the registry's FunctionTools) in the release that already changes the default, so a consumer who hands a store or a tool straight to ADK would break twice. The stand-ins keep the classes and leave the split to 1.0.0's removal.
- **Load ADK synchronously** with `createRequire`. ADK ships CommonJS and ESM builds; a `require` would load the CommonJS copy beside the consumer's ESM copy, two ADK registries in one process, which ADR 0007 exists to prevent.
- **Load ADK lazily at each use site only.** `compileGraph`, `toFunctionTool` and the registry's module-level tools are synchronous or run at load, so they would need new async signatures, a breaking change for a release that is supposed to break one thing.
- **Keep ADK a required peer until 1.0.0.** Native would be the default while every install still pulled ADK and its dependency tree, and nothing would prove the default runs without it.

## Consequences

- A fresh `npm install melchizedek-agents` has no ADK, and every shipped syndicate, the A2A server and the bins run on native. A consumer calling `runSyndicateTurn` directly passes `asAdkSessionService(new InProcessSessionService())` (both now exported from the barrel and `melchizedek-agents/runtime`) where it passed ADK's `InMemorySessionService`.
- The package has a top-level `await` in its module graph, so it cannot be `require()`d from CommonJS (Node's `require(esm)` refuses an async graph). The package was ESM-only already.
- A TypeScript consumer without ADK sees ADK's types in the published declarations as unresolved; `skipLibCheck` covers it until 1.0.0 removes them.
- With ADK installed, ADK loads on the native runtime too, through `lib/adkPeer.ts`, so the shared classes stay ADK's own.
- The import-graph suites count `lib/adkPeer.ts` as the module that loads ADK: `./model` and the engine's leaves must not reach it.
- `scripts/parity_check.ts` and `scripts/gemini_engine_check.ts`, the owner's live checks, still import ADK directly; they are not bins and need it installed.
