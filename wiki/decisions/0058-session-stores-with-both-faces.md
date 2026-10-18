---
type: decision
title: "ADR 0058: The session stores take the engine interface's meaning"
description: "The durable session stores implement SessionService with its meaning: a second create keeps the conversation, a list without a user lists all, lastUpdateTime is the event's timestamp, a known event id replaces its row."
tags:
  - decision
  - memory
  - runtime
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-18
sources:
  - resource: lib/runtime/adkSessionBridge.ts
  - resource: lib/session/supabaseSessionService.ts
  - resource: lib/storage/postgres/sessionService.ts
  - resource: lib/session/transcript.ts
  - resource: tests/adkSessionBridge.test.ts
  - resource: tests/postgresStorage.test.ts
---

# ADR 0058: The session stores take the engine interface's meaning

**Decided (2026-10-07):** The Supabase and Postgres session stores and the transcript projection implement the engine's `SessionService` on the same rows, taking its meaning: a second create keeps the conversation, a list without a user id lists every user's sessions (reachable only by code holding the store), `lastUpdateTime` is the appended event's timestamp, and on Postgres a known event id replaces its row. Until 1.0.0 each store also kept ADK's face, with a bridge for one-faced stores.

**Instead of:** separate engine classes beside the ADK classes, `applyEvent` for the ADK runtime too, refusing a list without a user id, the clock at append for `lastUpdateTime`, looking up every appended id in the stored rows

**Superseded by:** [ADR 0107](/decisions/0107-release-1-0-0-removes-adk.md) (the ADK face and the bridge removed)

How it works: [Sessions and events](/memory/sessions.md)
