---
type: decision
title: 'ADR 0058: The session stores implement both session interfaces, and a bridge gives a store that has one the other'
description: "The Supabase and Postgres session services and the transcript projection implement the engine's SessionService beside ADK's BaseSessionService, on the same rows. lib/runtime/adkSessionBridge.ts adapts a store that has only one. The stores take the interface's meaning: a second create keeps the conversation, a list without a user id lists every user's sessions, lastUpdateTime is the event's timestamp, and on Postgres a known event id replaces its row."
tags:
  - decision
  - memory
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-07
sources:
  - resource: lib/runtime/adkSessionBridge.ts
  - resource: lib/session/supabaseSessionService.ts
  - resource: lib/storage/postgres/sessionService.ts
  - resource: lib/session/transcript.ts
  - resource: tests/adkSessionBridge.test.ts
  - resource: tests/postgresStorage.test.ts
---

# ADR 0058: The session stores implement both session interfaces, and a bridge gives a store that has one the other

## Context

[ADR 0052](/decisions/0052-sessions-and-events-on-own-interfaces.md) gave the engine its own `SessionService` (`lib/runtime/sessions.ts`) and named its methods differently from ADK's, so that one class could implement both during the dual-runtime period of [ADR 0045](/decisions/0045-own-runtime-behind-the-seam.md). The durable stores still implemented only ADK's `BaseSessionService`. The native runtime needs them through the engine's interface, while the ADK runtime keeps running on them unchanged.

WS2-1 found three places where the stores disagreed with the interface:

1. **Create.** The Supabase store upserted an empty events array, so a second create under the same id wiped the conversation.
2. **Listing without a user id.** The Supabase store filtered on `user_id=eq.undefined`, so it listed only a user literally named `undefined`. The Postgres store and the interface list every user's sessions of the app.
3. **`lastUpdateTime`.** Both durable stores wrote the clock at append. The interface and ADK's own store use the appended event's timestamp.

Moving the stores onto the interface showed two more:

4. **An event id the session already holds.** ADK's base service and `applyEvent` replace that event in place. The Postgres store inserted a second row, so a read returned the event twice, unlike the session that wrote it.
5. **Listing order.** With no order asked for, the Supabase query had no `ORDER BY`, so offset pages depended on how Postgres scanned the table. With an order, neither store broke ties the same way. The interface orders by last update with ties by id, and otherwise in the order sessions were created.

## Decision

1. **One class, two faces.** `SupabaseSessionService`, `PostgresSessionService` and `ProjectedSessionService` implement `SessionService` (`create`, `get`, `list`, `delete`, `append`) and extend `BaseSessionService`. The ADK methods call the engine's methods, so each store states its rules once and both runtimes read and write the same rows. The one exception is `appendEvent`: it applies the event to the runner's session through ADK's base service, as before, and then records it the same way `append` does. ADK's base service runs a write-order check on state and drops `temp:` keys from the event the runner yields, and the ADK runtime keeps both. `append` uses `applyEvent`, which never changes the caller's event.
2. **A bridge for a store that has one face** (`lib/runtime/adkSessionBridge.ts`). `SessionServiceForAdk` runs the ADK runtime on an engine store, such as `InProcessSessionService`. `AdkSessionServiceForEngine` gives the engine's interface to an ADK store, such as ADK's `InMemorySessionService`. It keeps the interface's meaning: it reads a whole session and filters it with `selectEvents`, returns an existing session from `create`, and reports `listPage`'s figures. `asAdkSessionService` and `asSessionService` return a store unchanged when it already has the face asked for, using a duck check rather than `instanceof`. The projection takes either kind of store.
3. **The stores take the interface's meaning:**
   - A create of an existing id returns the conversation unchanged. The Supabase store inserts with `ON CONFLICT DO NOTHING` (`ignoreDuplicates`) and reads the row it did not insert, as the Postgres store already did. A create drops `temp:` keys from the initial state.
   - A list without a user id lists every user's sessions of the app, in both stores and through both faces. No route, tool or turn lists sessions. Only the stores, the projection and the bridge name the method, and `tests/adkSessionBridge.test.ts` fails if any other module in `lib/` or `scripts/` does. So a listing across users is reachable only by code that holds the store, and that code holds the database credential too. Row-level security on `adk_sessions` and `adk_session_events` is unchanged.
   - `lastUpdateTime`, in the session and in `last_update_time`, is the appended event's timestamp, written as whole milliseconds because the column is `BIGINT`. An event without a numeric timestamp falls back to the clock.
   - On Postgres, an event whose id the caller's session already holds replaces its row in place, keeping its position. A row that no longer exists is written again. Every other event is the conversation's next row, as before. The store does not look for the id in other rows, because that check reads every stored event's JSON on every append.
   - A list orders by `last_update_time`, then id, when an order is asked for, and by `created_at`, then id, when none is.
   - Reads follow `selectEvents`. A `numRecentEvents` below one is ignored, where Postgres used to return no events and Supabase dropped events from the start of the list.
4. **The schema, the stored Event JSON and the erase path are unchanged.** No migration is needed. `created_at` has been on `adk_sessions` since `0001_base.sql`.

## What the event timestamp does to paging and ordering

The finding behind item 3's `lastUpdateTime`: ADK's `createEvent` stamps an event with `Date.now()` in the process that appends it, just before the append. A model's event is made when its response arrives and is appended at once. So for stored rows, the event's timestamp orders conversations the way the clock at append did, to within that gap.

- **Paging arithmetic** does not read the value, so it is unaffected.
- **Order by last update** is unchanged in practice. The turn lock serializes the turns of one conversation, and a turn appends its events in the order they were made.
- **Where the two differ:** a row can now move back in time in two cases. One is an append that replaces an older event by id. The other is a conversation whose turns run on two instances with skewed clocks, which the clock at append also showed.

The interface's rule therefore holds for stored rows. A `GREATEST` of the stored and the event time was considered and rejected, because the row would then disagree with the session that wrote it.

## Alternatives considered

- **Engine classes beside the ADK classes**, or the ADK classes reached through the bridge. Rejected. Two classes per store would state each rule twice. Reaching a durable store through `AdkSessionServiceForEngine` reads whole sessions to filter them, and it would keep the Supabase reset behind a get-then-create race. One class with both faces is what ADR 0052 named its methods for.
- **`applyEvent` for the ADK runtime too.** Rejected. It would drop ADK's state write-order check from the runner's session and change the event the runner yields. The ADK runtime keeps working unchanged only if its live session is ADK's.
- **Refuse a list without a user id**, or keep the Supabase store returning nothing. Rejected. The interface, ADK's contract and the Postgres store all list every user's sessions. The restriction that matters is who can reach the call, and nothing outside the stores does.
- **Keep the clock at append** for `lastUpdateTime`. Rejected. It disagrees with the interface and with ADK's own store, and the finding above shows the event's timestamp orders stored rows the same way.
- **Look up every append's id in the stored rows** on Postgres. Rejected for its cost: it reads every event of the conversation on every append. The caller's session is the record of which ids exist.

## Consequences

- The native runtime, once it runs a turn, uses the durable stores and the projection as they are. The ADK runtime runs on them unchanged, and on any engine store through `asAdkSessionService`.
- `tests/adkSessionBridge.test.ts` drives an ADK `Runner` and the engine's interface on one Supabase row, on an engine store through the bridge, and on ADK's store through the bridge. `tests/postgresStorage.test.ts` does the same on real Postgres rows in CI.
- `SupabaseSessionService`, `PostgresSessionService` and `ProjectedSessionService` are published, so their new methods and changed behaviour have a `CHANGELOG.md` entry. The bridge is not in the exports map.
- A create on the Supabase store now costs one more read when the session exists. The runtime creates only after a read found nothing, so that case is rare.
- At 1.0, when ADK leaves, the ADK methods and the bridge are deleted, and each store keeps its engine face.
