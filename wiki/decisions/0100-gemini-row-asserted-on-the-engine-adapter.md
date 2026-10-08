---
type: decision
title: "ADR 0100: The capability matrix's Gemini row is asserted on the engine's GeminiAdapter, which keeps JSON Schema; native stores no turnComplete for ADK's Gemini; GeminiAdapter becomes the default with native"
description: "Gate G3 asks for the Gemini row's evidence to move from adk to test. Every Gemini cell is now asserted in tests/capabilityMatrix.test.ts on the engine's own GeminiAdapter, on the real @google/genai client over a stubbed fetch, so the row describes a request this repository builds. Of ADR 0097's two open differences: the adapter keeps JSON Schema (parametersJsonSchema, responseJsonSchema), since Gemini reads it, every other adapter sends it, converting is lossy, and nothing stored or replayed depends on the dialect; and the native step stores no turnComplete on events of a Gemini adapter that stands for ADK's Gemini, since ADK's Gemini writes none and nothing reads it. geminiTurnParity now runs native on both Gemini adapters and holds the stored events to ADK's in full. Once G3 is signed on a live run of scripts/gemini_engine_check.ts, GeminiAdapter becomes the registry's default for Gemini ids in the release that makes native the default; AdkGeminiAdapter stays selectable for one release and is then deleted. Converting to Gemini's Schema, writing turnComplete on the ADK path instead, keeping the wrapper as the default, and moving the ADK runtime off TracedGemini were rejected."
tags:
  - decision
  - models
  - gemini
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/models/capabilities.ts
  - resource: lib/models/geminiAdapter.ts
  - resource: lib/models/adkGeminiAdapter.ts
  - resource: lib/models/adapterResolver.ts
  - resource: lib/runtime/native/step.ts
  - resource: lib/runtime/native/selfCorrection.ts
  - resource: tests/capabilityMatrix.test.ts
  - resource: tests/helpers/capabilityInputs.ts
  - resource: tests/geminiTurnParity.test.ts
  - resource: scripts/gemini_engine_check.ts
---

# ADR 0100: The Gemini row is asserted on the engine's GeminiAdapter

## Context

Gate G3 of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) is met when the capability matrix's Gemini row ([ADR 0019](/decisions/0019-multi-model-parity-matrix.md)) moves from evidence `adk` to `test`. Every other row was asserted against the request its contract adapter sends. The Gemini row was taken on trust from ADK's own `Gemini`, which this repository does not build requests for. The native default waits on G3 ([ADR 0099](/decisions/0099-native-default-moves-to-0-20-0.md)).

The engine has its own Gemini adapter, `GeminiAdapter` ([Gemini adapter](/models/gemini-adapter.md)), selected with `GEMINI_ADAPTER=engine`. By default the registry's contract path serves Gemini through `AdkGeminiAdapter` ([the wrapper over ADK's Gemini](/models/adk-gemini-adapter.md)), and the ADK runtime through `TracedGemini`.

[ADR 0097](/decisions/0097-reflection-tool-declared-where-adk-declares-it.md) left two differences between the runtimes open:

- **The schema dialect.** ADK's Gemini sends a tool's parameters and the output schema as Gemini's `Schema` (`parameters`, `responseSchema`, upper-case types); the engine sends JSON Schema (`parametersJsonSchema`, `responseJsonSchema`).
- **`turnComplete`.** The native step stores `turnComplete: true` on a Gemini final, as the ADK shim's mapping writes it; ADK's Gemini writes none.

Running the parity suite with `GeminiAdapter` on native found two more request differences: ADK's Gemini sends `role: 'user'` on the system instruction, and ADK's path sends `includeServerSideToolInvocations` on every Gemini agent, where `GeminiAdapter` sends it only beside native tools and function declarations together ([ADR 0065](/decisions/0065-gemini-carried-parts-and-server-side-invocations.md)).

## Decision

1. **The Gemini row is the engine's `GeminiAdapter`, asserted like every row.** Each Gemini cell in `lib/models/capabilities.ts` is `evidence: 'test'`. `tests/capabilityMatrix.test.ts` checks each against the JSON body `GeminiAdapter` posts through the real `@google/genai` client over a stubbed `fetch`, and, where the cell's claim covers the answer, the final it makes of Gemini's JSON: tools, memory tools, structured output and JSON mode, every thinking level and budget with signature replay, streaming with usage, inline and URL images, and `googleSearch`, `urlContext` and `codeExecution` with grounding and carried parts. The test fails when any cell of any row is not `test`. The type keeps `'adk'` because it is published through `melchizedek-agents/models/*`; no cell uses it.
2. **The engine keeps JSON Schema.** Tool parameters go in `parametersJsonSchema` and the output schema in `responseJsonSchema`. Gemini reads both fields. Every other adapter sends JSON Schema, the contract's schemas are JSON Schema, and a YAML schema written in Gemini's dialect reaches the adapter lowercased. Nothing stored or replayed depends on the dialect: declarations and the output schema are request configuration, and the stored Event JSON holds contents (calls, arguments, results), never declarations. The system instruction's role and the narrower `includeServerSideToolInvocations` rule stay too: Gemini reads no role there, and the flag changes a response only where server-side tools sit beside function declarations.
3. **The native step stores no `turnComplete` for ADK's Gemini.** `standsForAdkGemini(adapter)` (`lib/runtime/native/selfCorrection.ts`) is the test `declaresReflectionTool` already made: a Gemini adapter no caller handed over behind the shim. For such an adapter the step drops `turnComplete` from each mapped response, so its events are the ADK runtime's, field for field. Nothing in the engine reads `turnComplete`; the shim path, where ADK's own flow reads it, is unchanged.
4. **The parity suite runs both Gemini adapters.** `tests/geminiTurnParity.test.ts` runs native on `AdkGeminiAdapter` and on `GeminiAdapter`, holds the requests to ADK's apart from the differences in item 2, and holds the stored events to ADK's in full, `turnComplete` included.
5. **The default and the retirement.** G3 is signed by the owner on a live run of `scripts/gemini_engine_check.ts` (grounding, code execution, a function tool beside server-side tools, and a two-turn session, on both runtimes with `GeminiAdapter`). Then the registry's `resolveAdapter` defaults Gemini ids to `GeminiAdapter` (`GEMINI_ADAPTER` unset means `engine`), in the release that makes `native` the default runtime. `GEMINI_ADAPTER=adk` keeps `AdkGeminiAdapter` for that release. After one release with no Gemini incident on `native` that `adk` fixed, the wrapper is deleted with a version bump and a breaking `CHANGELOG.md` entry, as [the wrapper's page](/models/adk-gemini-adapter.md#retiring-it) lists. The ADK runtime keeps `TracedGemini` until ADK leaves at 1.0.0.

## Alternatives considered

- **Convert to Gemini's `Schema` in the engine adapter, to match ADK byte for byte.** Rejected: the conversion is lossy (JSON Schema keywords Gemini's `Schema` lacks are dropped or rewritten), it adds a second schema path to one provider, and the match buys nothing stored. ADK leaves at 1.0.0, and the comparison suite normalizes the dialect.
- **Write `turnComplete` on the ADK runtime's Gemini events instead.** Rejected: it changes what the default runtime stores, and the ADK runtime is the reference both runtimes are held to.
- **Leave `turnComplete` as it is and keep comparing events without it.** Rejected: a difference nothing needs is a difference every parity test has to explain.
- **Keep `AdkGeminiAdapter` as native's Gemini past G3.** Rejected: native would keep ADK in its Gemini path, which ADR 0045 sets out to remove, and the matrix row would describe an adapter native does not use.
- **Move the ADK runtime to `GeminiAdapter` behind the shim at the same time.** Rejected: it changes the default runtime's Gemini path in the release that changes the default runtime, and doubles what one incident could be traced to.
- **Evidence from the wrapper.** Asserting the row on `AdkGeminiAdapter` would still be ADK's request, which is what G3 moves away from.

## Consequences

- No matrix cell says `adk`. `renderCapabilityMatrix` says every cell is asserted, and the Gemini column is the engine's adapter.
- On native, a Gemini agent's events carry no `turnComplete`, under either Gemini adapter. Events already stored with it read the same: the field is optional, and nothing reads it.
- `scripts/gemini_engine_check.ts` is the G3 run; `tests/geminiEngineCheck.test.ts` runs it offline. G3 stays open until the owner signs it in ADR 0045's gate log.
- Still open, and confirmed only by the live run: Gemini 3 accepting JSON Schema for every syndicate's schemas, the replayed signatures and carried parts, server-side tools beside function declarations, and a URL image by `fileData`. The other items under "Confirmed only against documentation" on the [Gemini adapter](/models/gemini-adapter.md) page stay open.
