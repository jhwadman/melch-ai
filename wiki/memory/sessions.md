---
type: schema
title: Sessions and events
description: "The engine's own types for what a session stores and how a store is reached (lib/runtime/events.ts, sessions.ts, memoryService.ts): TurnEvent as the stored ADK Event JSON, the parse that carries every field, ADK's semantics for reading and making events, SessionService with one meaning across stores, the in-process store, and MemoryService."
tags:
  - memory
  - runtime
  - contracts
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/runtime/events.ts
  - resource: lib/runtime/sessions.ts
  - resource: lib/runtime/memoryService.ts
  - resource: tests/events.test.ts
  - resource: tests/helpers/importGraph.ts
---

# Sessions and events

Three modules hold the engine's own types for sessions and memory ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md), [ADR 0052](/decisions/0052-sessions-and-events-on-own-interfaces.md)):

- `lib/runtime/events.ts`: `TurnEvent`, one step of a conversation as a session stores it, with the functions that read, make and check one.
- `lib/runtime/sessions.ts`: the `SessionService` interface, the rules every store applies, and `InProcessSessionService`.
- `lib/runtime/memoryService.ts`: the `MemoryService` interface.

The native runtime reads and writes sessions through them. The ADK runtime still uses ADK's types. The Supabase and Postgres session services extend ADK's `BaseSessionService`, and long-term memory implements ADK's `BaseMemoryService`; none of them implements the engine's interfaces yet. Each module imports only types, and nothing in its import graph names `@google/*`. The modules are not in the package's `exports` map.

## The event

`TurnEvent` is the stored ADK Event JSON, typed, not a new format. The [stored event shape](/memory/architecture.md) is fixed ([ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md)), so a `TurnEvent` serializes to the bytes ADK would have stored. The content keeps genai's `Content` shape, described structurally, and a model call maps it to the [model contract](/models/model-contract.md) through `lib/models/genaiMapping.ts` ("From genai Content"). genai types a few part fields as enums where `TurnPart` has a string (`executableCode.language`, `codeExecutionResult.outcome`), so handing a `TurnContent` to the mapping takes a cast.

The fields the engine reads:

| Field | Meaning |
|---|---|
| `id` | Eight letters and digits. An append with an id already in the session replaces that event. |
| `invocationId` | Shared by every event of one run; ADK writes `e-<uuid>`. |
| `author` | `user`, or the agent or workflow node that wrote the event. |
| `content` | `{ role, parts }`. A part holds `text` (with `thought: true` for reasoning), `functionCall` `{ id, name, args }`, `functionResponse` `{ id, name, response }`, `inlineData`, `fileData`, `executableCode` or `codeExecutionResult`. It may also carry Gemini's `thoughtSignature` and another provider's `providerState` ([ADR 0046](/decisions/0046-provider-reasoning-state-on-the-part.md)). Absent on an event that only carries actions. |
| `actions` | `stateDelta`, `artifactDelta`, `requestedAuthConfigs`, `requestedToolConfirmations` (the four dictionaries ADK writes on every event), and `skipSummarization`, `transferToAgent`, `escalate`, `agentState`, `endOfAgent`. |
| `partial` | A streaming fragment: shown, never stored. |
| `turnComplete` | The model finished this response. |
| `timestamp` | Milliseconds since the epoch. |
| `customMetadata` | Labels an adapter attaches, JSON only. |
| `longRunningToolIds` | This event's calls that wait for a person. |
| `branch` | The `parent.child` path that keeps a subagent's events from its peers. |
| `errorCode`, `errorMessage` | A failure. Gemini reports its finish or block reason here; the turn runner ignores the code `STOP`. |
| `usageMetadata` | Token counts in Gemini's meanings: `promptTokenCount`, `candidatesTokenCount` (thinking excluded), `thoughtsTokenCount`, `totalTokenCount`, `cachedContentTokenCount`, `toolUsePromptTokenCount`. |

The fields ADK writes beside them, which the engine stores and reads back unchanged: `finishReason`, `groundingMetadata`, `citationMetadata`, `interrupted`, `modelVersion`, and the workflow fields `output`, `route`, `nodeInfo` and `isolationScope` ([ADR 0030](/decisions/0030-workflow-graphs.md)).

A trimmed row (`adk_sessions.events`) and a verbatim row (`adk_session_events`) hold the same type. They differ in values: in a trimmed row a call's signature is the skip value, other signatures are gone, and a long tool result is an elision marker.

### Parsing

`parseTurnEvent` and `parseTurnEvents` check the type of every declared field, at every level, and return the same object, typed. A field the type does not declare stays where it is: a live-streaming field, a part's `videoMetadata`, the camelCase `toolCall` some providers emit. A read followed by a write therefore never loses a field, which matters because the Supabase store rewrites a conversation's whole events array on every append. The parse requires `id`, `invocationId`, `actions` and `timestamp`, and nothing inside `actions`, so a row without one of ADK's four dictionaries still reads. A field of the wrong type throws `TurnEventError`, whose message names the field's path and the type found (`events[3].content.parts[0].functionCall.name: expected a string, got a number`), never the value, since events hold what people said.

### Reading and making events

The helpers answer as ADK's own functions do:

- `getFunctionCalls` and `getFunctionResponses` return the parts' own `functionCall` and `functionResponse` objects, in order.
- `isFinal` is ADK's `isFinalResponse`. An event is final at once when the run is meant to stop on it: a response that skips summarization (an approval request), a call that waits for a person, or a tool asking for auth. Otherwise it is final when it has no call and no response, is not partial, and does not end on a code execution result (`hasTrailingCodeExecutionResult`).
- `createTurnEvent` builds an event as ADK's `createEvent` does, key order included: the given fields, then an id from `newEventId`, an empty invocation id, the four action dictionaries (`createEventActions`), no long-running ids and the time now.

## Sessions

A `Session` is the same JSON as ADK's: `id`, `appName`, `userId`, `state`, `events` (oldest first) and `lastUpdateTime`. A `SessionKey` is `appName`, `userId` and `sessionId`. A DELEGATE subagent's own row has the subagent's name as `appName`.

`SessionService` has five methods:

- `create({ appName, userId, sessionId?, state? })` makes a UUID when no id is given and drops `temp:` keys from the state.
- `get(key, { numRecentEvents?, afterTimestamp? })` returns a copy, or undefined.
- `list({ appName, userId?, limit?, offset?, page?, order? })` returns the page's sessions without their events, with `page`, `limit`, `totalItems` and `totalPages`.
- `delete(key)` deletes the session and its events, and does nothing for one that does not exist.
- `append(session, event)` records the event in the caller's session and in the store, and returns the event as stored.

The names are not ADK's, so a store can implement this interface beside ADK's base class.

`applyEvent(session, event)` holds the rules every store applies on append, as ADK's base service does:

1. A partial event is returned as it is, and nothing changes.
2. The stored event's `stateDelta` loses its `temp:` keys. The caller's event is never changed.
3. Each remaining key is written into `session.state`, as an own property even when it is named `__proto__`.
4. The event replaces the one with the same id, or is appended.
5. `lastUpdateTime` becomes the event's timestamp.

### One meaning across stores

ADK's services and the engine's durable stores disagree in places. The interface takes the durable stores' meaning, and where the two durable stores differ, the Postgres store's:

| | The interface | ADK's in-memory store |
|---|---|---|
| `afterTimestamp` with `numRecentEvents` (`selectEvents`) | Events strictly after the timestamp, then the newest N of those. A value of 0 or below applies nothing. | The newest N, then events at or after the timestamp. |
| Creating an id that exists | Returns the session unchanged. The Supabase store resets it today. | Resets it. |
| An empty or one-page listing (`listPage`) | One page. `page` wins over `offset` beside a `limit`, and `limit` reports the total when none was asked for (`listWindow`). | No pages when empty. |
| `app:` and `user:` state keys | Kept in the session's own state. | Shared across the app's or user's sessions. |
| `lastUpdateTime` | The last appended event's timestamp. The durable stores write the clock at append. | The event's timestamp, on a partial event too. |

No syndicate writes an `app:` or `user:` key.

### The in-process store

`InProcessSessionService` keeps sessions in the process and loses them when it exits. It is the store for a syndicate with no durable one, and for tests. Every read hands out a copy and every append stores one, so no caller shares an object with the store. Two copies of one session appending in turn both land, as on the Postgres store. An append to a session the store does not hold, such as one deleted while its turn ran, keeps the caller's session as it stands after the event. Its keys cannot collide through a colon in a user id. It takes a clock (`now`) for tests.

## Memory

`MemoryService` is what the native runtime asks of long-term memory ([memory architecture](/memory/architecture.md)):

- `ingest(session, { extractionRules?, extractionModel? })` distils the events not yet ingested. The runtime calls it after the answer is delivered. It throws when a step fails, leaving those events pending.
- `search({ appName, userId, query })` returns `{ memories }`, best first, in the JSON of ADK's `MemoryEntry`: `content`, `author`, `timestamp` (ISO 8601).
- `deleteUserMemory`, `pruneExpired` and `verifyEmbeddingDimensions` are optional, with the names the A2A server already calls them by.

Every fact is filed under `<appName>/<userId>`, and a search reads that silo alone. `appName` is the memory namespace, which the runtime pins to the root syndicate's ([ADR 0020](/decisions/0020-memory-contract.md)).

## What proves it

`tests/events.test.ts`:

- **Fixtures.** Every [session fixture](/memory/architecture.md) parses as `TurnEvent[]` and serializes back to the file's exact bytes, in both stored forms. Every field stored there is one `TurnEvent` declares, at every level. Every fixture replays through the in-process store with its events unchanged and its state rebuilt.
- **ADK parity.** On every fixture event and a dozen edge cases, the helpers give ADK's answers, and `createTurnEvent` gives `createEvent`'s JSON. `applyEvent` leaves a session as ADK's base service does. An ADK `Event` and `Session` assign to `TurnEvent` and `Session` without a cast, which `npx tsc --noEmit` checks.
- **Parse errors.** The parse names the failing path and never the value.
- **Leaves.** The three modules load nothing at run time and reach no `@google/*` module. The scan is `tests/helpers/importGraph.ts`.
