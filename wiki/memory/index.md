# Memory

<!-- wiki:generated section="listing" source="directory contents" -->
- [Memory architecture](/memory/architecture.md) — Session transcripts distilled into typed, supersedable facts with hybrid vector recall — siloed per user, erasable per scope across every store, resilient to malformed extractions.
- [Memory & telemetry schema](/memory/schema.md) — The Postgres DDL shipped in db/, verbatim and in install order: the numbered migrations (sessions, memory facts, erase, the direct-Postgres tables, usage counters), the telemetry ledger, the row-level-security hardening and the memory_v2 upgrade.
- [Sessions and events](/memory/sessions.md) — The engine's own types for what a session stores and how a store is reached (lib/runtime/events.ts, sessions.ts, memoryService.ts): TurnEvent as the stored ADK Event JSON, the parse that carries every field, ADK's semantics for reading and making events, SessionService with one meaning across stores, the in-process store, the durable stores and the projection with both session interfaces, the bridge for a store with one (adkSessionBridge.ts), and MemoryService.
<!-- /wiki:generated -->
