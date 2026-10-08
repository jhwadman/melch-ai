---
type: decision
title: "ADR 0052: The engine types the stored event as it is, and gives sessions and memory interfaces of its own"
description: TurnEvent is the stored ADK Event JSON, typed, and its parse carries every field it does not declare. SessionService and MemoryService are the engine's own interfaces, with their own method names and the durable stores' meaning where ADK's services disagree. An engine event mapped at the store, a projecting parse, ADK's names and types, and ADK's in-memory semantics were rejected.
tags:
  - decision
  - memory
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/runtime/events.ts
  - resource: lib/runtime/sessions.ts
  - resource: lib/runtime/memoryService.ts
  - resource: tests/events.test.ts
---

# ADR 0052: The engine types the stored event as it is, and gives sessions and memory interfaces of its own

## Context

[ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md) has the native runtime read and resume the sessions ADK stored, and fixes the stored Event JSON in `adk_sessions.events` and `adk_session_events`. [ADR 0048](/decisions/0048-engine-owned-model-contract.md) item 8 keeps genai `Content` in stored sessions and makes it a mapping to the model contract.

The stores reach that JSON through ADK's types. The Supabase and Postgres session services extend ADK's `BaseSessionService`, and the memory service implements `BaseMemoryService`. Those types name genai's enums and ADK's classes. The native runtime needs a type for a stored event, a session interface, a memory interface and a store for tests, none of them loading ADK.

ADK's services also disagree with the durable stores on what a read returns:

- **Filtering.** ADK's in-memory store counts `numRecentEvents` first, then keeps events at or after `afterTimestamp`. Both durable stores keep events strictly after the timestamp, then count.
- **Re-creating.** ADK's in-memory store resets a session created again under the same id, and so does the Supabase store, which upserts an empty events array. The Postgres store keeps the existing session.
- **Paging.** ADK's in-memory store reports no pages for an empty listing. The durable stores report one.
- **Prefixed state.** ADK's in-memory store shares `app:` and `user:` keys across sessions. The durable stores keep them in the session's own state.

## Decision

1. **The stored JSON is the type.** `TurnEvent` (`lib/runtime/events.ts`) declares the fields the engine reads, with ADK's names and meanings: `id`, `invocationId`, `author`, `content`, `actions`, `partial`, `turnComplete`, `timestamp`, `customMetadata`, `longRunningToolIds`, `branch`, `errorCode` and `errorMessage`, and `usageMetadata`. It also declares the fields ADK writes beside them. The content keeps genai's shape, described structurally. Nothing converts an event between the store and the runtime. A model call maps the content to the contract, as ADR 0048 item 8 sets out.
2. **The parse checks and carries.** `parseTurnEvent` checks the type of every declared field and returns the same object. A field it does not declare stays in place. An error names the field's path and the type found, never the value.
3. **ADK's semantics for reading and making events.** `getFunctionCalls`, `getFunctionResponses` and `isFinal` answer as ADK's functions do, and `createTurnEvent` builds the JSON ADK's `createEvent` builds.
4. **Interfaces of the engine's own.** `SessionService` (`lib/runtime/sessions.ts`: `create`, `get`, `list`, `delete`, `append`) and `MemoryService` (`lib/runtime/memoryService.ts`: `ingest`, `search`, and the existing erase, retention and dimension checks as optional members) carry ADK's JSON shapes. They do not use ADK's method names, so one class can implement an engine interface and extend ADK's base without either signature constraining the other.
5. **One meaning across stores.** Where ADK's services and the durable stores disagree, the interface takes the durable stores' meaning. Where the two durable stores differ, it takes the Postgres store's, which never loses an event: a second create keeps the conversation. The in-process store (`InProcessSessionService`) implements that meaning. `applyEvent`, `selectEvents`, `listWindow` and `listPage` state those rules once, for every store.
6. **Leaves.** The three modules import only types, and nothing in their import graph names `@google/*`.

## Alternatives considered

- **An engine event built on the contract's `Message`, mapped to genai at the store.** Rejected. A conversation would then go through two mappings, one at the store and one at the model call, where this decision has one. The store's mapping would also have to round-trip every field ADK writes. A field it did not know would be lost on the next rewrite of a conversation, since the Supabase store rewrites the whole events array on every append. ADR 0048 item 8 already keeps `Content` in storage.
- **A parse that projects to the declared fields.** Rejected for the same loss: a read followed by a write would erase any field the engine does not declare from the stored row.
- **ADK's method names and types.** `TurnEvent` could be ADK's `Event`, and the interface could take `BaseSessionService`'s signatures. Today's classes would then implement it with no new methods. But the engine's interface would name genai's enums and ADK's classes until 1.0, which ADR 0045 sets out to remove. Each signature would also constrain the other through the dual-runtime period.
- **ADK's in-memory semantics for the in-process store.** Rejected. A test on the in-process store would pass on behaviour production does not have.

## Consequences

- A store moving onto `SessionService` (WS2-2) applies events through `applyEvent` and pages through `listWindow` and `listPage`. The memory service moves onto `MemoryService` in WS2-3.

> **Note (2026-10-07):** The memory service implements `MemoryService`, with ADK's two methods handing their arguments to `ingest` and `search`, see [ADR 0059](/decisions/0059-memory-on-the-engines-own-interfaces.md).
- An ADK `Event` or `Session` assigns to `TurnEvent` or `Session` without a cast, and `tests/events.test.ts` type-checks that. The reverse needs a cast, because genai types some fields as enums where `TurnEvent` has a string.
- Every session fixture parses and serializes back to its own bytes, in both stored forms, and replays through the in-process store unchanged. That is the read half of ADR 0045's first stop rule. The resume half needs the native loop.
- No engine store shares `app:` or `user:` state across sessions, and no syndicate writes such a key. A syndicate that needs it is a change to this interface.
- The modules are not in the package's `exports` map, so consumers import nothing new. A path is added, with a version bump, when the native runtime becomes selectable.
