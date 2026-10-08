---
type: decision
title: "ADR 0068: melchizedek-agents/model exports the model layer with no ADK, and its resolveAdapter gives Gemini the engine's adapter"
description: "A new package entry, melchizedek-agents/model (lib/model.ts), exports the contract's types, every contract adapter, resolveAdapter, resolveAdapterWithFallback, FallbackAdapter and the circuit breaker's helpers, with no @google/adk in its runtime import graph. The routing step and the contract table move to lib/models/adapterResolver.ts, which takes the AdkGeminiAdapter factory from its caller: the registry passes one and keeps ADR 0060's default, the entry has none, so a Gemini id gets GeminiAdapter and asking for adk throws. xAI's search settings move to an import-free module. Loading ADK lazily, a silent fallback to GeminiAdapter, and making the existing ./models/registry ADK-free were rejected."
tags:
  - decision
  - models
  - package
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/model.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/models/registry.ts
  - resource: lib/tools/xaiSearchParams.ts
  - resource: tests/packageSurface.test.ts
  - resource: package.json
---

# ADR 0068: melchizedek-agents/model exports the model layer with no ADK, and its resolveAdapter gives Gemini the engine's adapter

## Context

Gate G1 of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) was signed with one package ticket open: a consumer should be able to call any model through the engine's own [contract](/decisions/0048-engine-owned-model-contract.md) without installing `@google/adk`, the package's peer dependency. Every adapter was already importable under `melchizedek-agents/models/*`, but none could be loaded without ADK:

- `GrokAdapter` imported its xAI search settings from the tool modules (`webSearchTool.ts`, `xSearchTool.ts`, `collectionsSearchTool.ts`), which extend ADK's `BaseTool`.
- `resolveAdapter` lives in `lib/models/registry.ts`, which imports ADK to register the ADK classes and to build `TracedGemini`.
- `resolveAdapter` gives a Gemini id `AdkGeminiAdapter` by default until gate G3 ([ADR 0060](/decisions/0060-engine-owned-registry.md)), and that adapter is ADK's Gemini.

## Decision

1. **A new entry, `melchizedek-agents/model`** (`lib/model.ts`), exports the contract's types, `ClaudeAdapter`, `GptAdapter`, `GrokAdapter`, `ChatCompletionsAdapter`, `KimiAdapter`, `OllamaAdapter`, `GatewayAdapter`, `GeminiAdapter`, `resolveAdapter`, `resolveAdapterWithFallback`, `FallbackAdapter`, `isProviderError`, the circuit breaker's helpers and the prefix table. `AdkGeminiAdapter`, the ADK shims, `TracedGemini`, `resolveModel` and `registerAvailableProviders` stay under `melchizedek-agents/models/*`. The barrel does not change. Adding the path is a minor version (0.19.0).
2. **The routing moves to `lib/models/adapterResolver.ts`**, which imports no ADK: `routeFor`, `scopedKey`, the contract adapter table and `adapterResolver(adkGemini?)`. `registry.ts` builds its `resolveAdapter` from it with the `AdkGeminiAdapter` factory, so its behaviour, ADR 0060's default included, is unchanged, and `resolveModel` reads the same `routeFor`.
3. **Through `./model`, a Gemini id gets `GeminiAdapter`.** The entry's resolver has no ADK factory. An unset `GEMINI_ADAPTER` means `engine` there. Asking for `adk`, by the option or by `GEMINI_ADAPTER=adk`, throws an error that names `melchizedek-agents/models/registry`.
4. **xAI's search settings move to `lib/tools/xaiSearchParams.ts`**, which imports nothing. The tool modules re-export each reader under its old name, so `./tools/*` keeps its exports.
5. **The proof is a test of the package.** `tests/packageSurface.test.ts` walks the entry's runtime import graph, loads the entry from source and from a fresh build in a child process where `@google/adk` cannot resolve and builds a Claude and an Ollama request through it, walks the built declarations, and checks that every path in the exports map resolves after the build.

## Alternatives considered

- **Load ADK lazily for `adk`** (a dynamic import inside the Gemini branch). `resolveAdapter` is synchronous, so it would have to return a proxy adapter that imports on its first call, and a consumer without ADK would learn at call time, inside a turn, what the entry could tell them at resolution. The entry's promise, no ADK in its graph, would also hold only by convention.
- **Fall back to `GeminiAdapter` silently when `adk` is asked for.** It never fails, but a deployment that pinned `GEMINI_ADAPTER=adk` for parity would get a different adapter from one import path than from the other, without a word. An error that names the right import is cheaper to read.
- **Make `./models/registry` itself ADK-free** by moving `registerAvailableProviders` and `resolveModel` elsewhere. That moves exported names consumers import today, which is a breaking change; ADK leaves the package at 1.0, and the registry's ADK half goes with it then.
- **Export the adapters from the main barrel.** The barrel loads the compiler and the runtime, which load ADK.

## Consequences

- A project that only calls models installs the package with `--legacy-peer-deps`, since npm 7 and later install peers by default, and imports `melchizedek-agents/model`; the README shows a Claude and an Ollama call.
- The registry's and the entry's `resolveAdapter` differ only for Gemini with `GEMINI_ADAPTER` unset, until gate G3 flips the registry's default to `engine`; then they agree.
- A module added to an adapter's import graph that loads ADK fails `tests/packageSurface.test.ts`, not a consumer's install.
- `lib/persistence/supabaseProvider.ts` still reaches ADK's session and memory services through dynamic imports. The model layer reaches that module only for `hasSupabaseCredentials` (through the span exporter), which loads neither, and the child-process test would fail if it did.
