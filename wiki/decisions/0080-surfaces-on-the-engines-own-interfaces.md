---
type: decision
title: "ADR 0080: The surfaces take stores with either face, bridge at the seam, and set the engine's log level"
description: "The A2A executor and app, the REPL, the worker, the server bin and the demos import no @google/adk. They take a session store and a memory service with either face, read through the engine's interfaces, and hand runSyndicateTurn the ADK faces its fixed signature names through the session bridge and a new memory bridge. In-process sessions are InProcessSessionService. A surface sets the engine's log level (lib/runtime/logging.ts) and ADK's logger follows it from compileAdk. The model demo runs through runSyndicateTurn; the direct call runs on the model contract. Re-exporting ADK's types, a memory bridge on every service, an engine logger that prints, and the direct call through runSyndicateTurn were rejected."
tags:
  - decision
  - runtime
  - a2a
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-08
sources:
  - resource: lib/a2a/executor.ts
  - resource: lib/a2a/app.ts
  - resource: lib/runtime/adkSessionBridge.ts
  - resource: lib/runtime/adkMemoryBridge.ts
  - resource: lib/runtime/logging.ts
  - resource: lib/compileAdk.ts
  - resource: scripts/syndicate_chat.ts
  - resource: scripts/assistant_worker.ts
  - resource: scripts/a2a_server.ts
  - resource: scripts/demo_model_optionality.ts
  - resource: scripts/direct_call.ts
  - resource: tests/surfacesOffAdk.test.ts
---

# ADR 0080: The surfaces take stores with either face, bridge at the seam, and set the engine's log level

## Context

[ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md) puts every turn behind `runSyndicateTurn`, and [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) item 4 fixes its signature, which names ADK's `BaseSessionService` and `BaseMemoryService`. [ADR 0052](/decisions/0052-sessions-and-events-on-own-interfaces.md), [ADR 0058](/decisions/0058-session-stores-with-both-faces.md) and [ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md) give the engine its own session and memory interfaces, a bridge for a session store with one face, and a memory service with both. [ADR 0073](/decisions/0073-one-agent-spec-and-a-runtime-flag.md) adds the runtime flag.

The surfaces still named ADK themselves:

- `lib/a2a/executor.ts` and `lib/a2a/app.ts` typed their stores on ADK's interfaces, built ADK's `InMemorySessionService` for in-process sessions, and typed `resolveModel`'s result on ADK's `BaseLlm`.
- The REPL, the worker and the server bin built ADK's in-memory store or called ADK's `setLogLevel`.
- `scripts/demo_model_optionality.ts` and `scripts/direct_call.ts` built ADK's `LlmAgent` and ran ADK's `Runner`, so neither followed the runtime flag.

Five choices had real alternatives: how a surface names a store's type, what a memory service with only the engine's face becomes on the ADK runtime, the in-process store, how a surface quiets ADK, and what each demo runs on.

## Decision

1. **A surface takes either face and asks the bridge for the one it needs.** The session bridge exports `EitherSessionService` and `AdkSessionService`, and the memory bridge `EitherMemoryService` and `AdkMemoryService`. The executor reads a session through `asSessionService` and hands `runSyndicateTurn` and `ingestTurnMemory` the ADK faces from `asAdkSessionService` and `asAdkMemoryService`, built once per executor. `createA2AApp`'s `storage` takes either face. `asSessionService` and `asAdkSessionService` hand a bridge back as the store it wraps, so a store bridged one way and back is itself, and the native runtime reads an engine store directly rather than through two bridges.
2. **A memory bridge for a service with only the engine's face** (`lib/runtime/adkMemoryBridge.ts`). A service with ADK's face, the engine's own among them, passes through unchanged, as ADR 0059 keeps it. `MemoryServiceForAdk` wraps one with only `MemoryService`: `searchMemory` and `addSessionToMemory` hand their arguments, extraction rules and model included, to `search` and `ingest`, and `deleteUserMemory`, `pruneExpired` and `verifyEmbeddingDimensions` are forwarded when the service has them. The A2A server keeps the service it was given for its by-name checks. The bridge imports ADK's types only.
3. **In-process sessions are the engine's `InProcessSessionService`**, in the A2A server (no durable storage, or an `internal-only` syndicate), the REPL, the worker and the model demo. The ADK runtime reaches it through `SessionServiceForAdk`, as `tests/adkSessionBridge.test.ts` already drives it.
4. **`resolveModel`'s result is the compiler's.** `A2AAppOptions.resolveModel` returns `ReturnType<NonNullable<CompileOptions['resolveModel']>>`: a model id, or a model instance, which is ADK's `BaseLlm` while the ADK runtime ships. The type is the same as before, named without ADK, and it follows the compiler when the instance type changes.
5. **The engine owns the log level, and ADK's logger follows it.** `lib/runtime/logging.ts` is a leaf: `setLogLevel` (`debug`, `info`, `warn`, `error`), `logLevel`, `logs` and `onLogLevel`. `lib/compileAdk.ts` subscribes and sets ADK's logger to the same level. Nothing is pushed until a surface sets a level, so a process that never sets one keeps ADK's default, and a test that sets ADK's level itself keeps it. The server bin, the REPL, the worker and the model demo set `warn`.
6. **The model demo runs through the turn runner; the direct call runs on the model contract.** `demo_model_optionality.ts` runs each model-zoo agent as a one-agent syndicate through `runSyndicateTurn`, as the worker runs its agent, so the compiler maps `reasoning:`, `--search` declares `web_search` from YAML, and the runtime follows `MELCHIZEDEK_RUNTIME`. `direct_call.ts` resolves an adapter with `resolveAdapter` from `lib/model.ts` (`melchizedek-agents/model`) and reads its responses: one model, one prompt, no agent framework, and nothing in its runtime import graph names `@google/adk`.

## Alternatives considered

- **Re-export ADK's types from a neutral module and keep `BaseSessionService` as the option type.** The surfaces would stop naming ADK in their imports and change nothing else, but a consumer could still not pass the engine's own store, and the executor would still read sessions through ADK's methods. Either-face options cost one bridge call at the seam.
- **Wrap every memory service in an adapter.** ADR 0059 rejected this for the engine's own service: two objects per service, and by-name checks that must see through the wrapper. The bridge wraps only a service that has no ADK face, applies only at the seam, and forwards the extras.
- **Keep ADK's `InMemorySessionService` for in-process sessions.** It shares `app:` and `user:` state across sessions and resets a session created twice, which no durable store does (ADR 0052 item 5). The engine's store has production's meaning, and the A2A suites pass on it unchanged.
- **An engine logger that prints**, with levels per line, replacing `console` in the surfaces. That is a wider change than the one ADK's logger needs, and it would touch every log line the server's JSON format and the tests read. The level alone is what the surfaces set; a logger can be built on it later.
- **The direct call through `runSyndicateTurn` with an inline config.** It would follow the runtime flag, but the script's point is that the syndicate structure is optional. The model contract is the smallest call the engine offers, and it is what a consumer copies.

## Consequences

- `tests/surfacesOffAdk.test.ts` fails when any of the seven surfaces imports `@google/*`, when anything in the direct call's runtime import graph names `@google/adk`, when the log level stops being a leaf or ADK's logger stops following it, and when either bridge stops passing through, wrapping or unwrapping as stated. The A2A, approvals and questions suites pass unchanged.
- `A2AAppOptions.storage` accepts the engine's `SessionService` and `MemoryService` as well as ADK's. The change only widens a type, under the existing `exports` map, and has a `CHANGELOG.md` entry. The bridges and the logging module are not in the map.
- `runSyndicateTurn`'s signature, the stored Event JSON, the interrupt names and the A2A surface are unchanged.
- `ingestTurnMemory` still takes ADK's faces; its callers bridge.
- At 1.0, when ADK leaves, the bridges, the ADK type aliases and `compileAdk`'s log subscription are deleted, and the surfaces keep the engine's interfaces.
