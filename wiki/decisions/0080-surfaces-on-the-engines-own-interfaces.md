---
type: decision
title: "ADR 0080: Surfaces on the engine's own interfaces, the engine owns the log level"
description: "The A2A server, REPL, worker, server bin and demos import no ADK, use the engine's session and memory interfaces, and set the engine's own log level."
tags:
  - decision
  - runtime
  - a2a
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
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

# ADR 0080: Surfaces on the engine's own interfaces, the engine owns the log level

**Decided (2026-10-08):** Every surface uses the engine's session and memory interfaces and the engine's `InProcessSessionService` for in-process sessions, and sets the log level through the engine's leaf module `lib/runtime/logging.ts`. The model demo runs through `runSyndicateTurn`; the direct-call script runs on the model contract alone.

**Instead of:** re-exporting ADK's types, wrapping every memory service, ADK's InMemorySessionService, an engine logger that prints, the direct call through runSyndicateTurn

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the either-face bridges and ADK log subscription deleted; surfaces take the engine's interfaces only)

How it works: [Architecture](/overview/architecture.md)
