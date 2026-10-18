---
type: decision
title: "ADR 0052: The stored event is typed as it is; sessions and memory get own interfaces"
description: "TurnEvent types the stored Event JSON as it is and its parse keeps undeclared fields; SessionService and MemoryService are engine interfaces with the durable stores' meaning."
tags:
  - decision
  - memory
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/events.ts
  - resource: lib/runtime/sessions.ts
  - resource: lib/runtime/memoryService.ts
  - resource: tests/events.test.ts
---

# ADR 0052: The stored event is typed as it is; sessions and memory get own interfaces

**Decided (2026-10-07):** The stored Event JSON is the type: `TurnEvent` declares the fields the engine reads, and `parseTurnEvent` checks them and leaves every other field in place, so nothing converts an event between store and runtime. `SessionService` and `MemoryService` are the engine's own interfaces with their own method names; where stores disagree they take the durable stores' meaning, and between those the Postgres store's (a second create keeps the conversation).

**Instead of:** an engine event built on `Message` and mapped at the store, a parse that projects to declared fields, ADK's method names and types, ADK's in-memory semantics for the in-process store

How it works: [Sessions and events](/memory/sessions.md)
