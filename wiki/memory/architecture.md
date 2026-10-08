---
type: subsystem
title: Memory architecture
description: Session transcripts distilled into typed, supersedable facts with hybrid vector recall — siloed per user, erasable per scope across every store, resilient to malformed extractions.
tags:
  - memory
  - supabase
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/memory/supabaseMemoryService.ts
  - resource: lib/memory/README.md
  - resource: lib/memory/providers.ts
  - resource: lib/memory/store.ts
  - resource: lib/memory/erase.ts
  - resource: lib/storage/postgres/index.ts
  - resource: lib/session/transcript.ts
  - resource: tests/fixtures/sessions/generate.ts
  - resource: tests/sessionFixtures.test.ts
---

# Memory architecture

Long-term memory is `SupabaseVectorMemoryService` — the ADK `BaseMemoryService` contract backed by one Postgres table (`adk_memory_facts`, created by `db/migrations/0001_base.sql` and reproduced on the [schema page](/memory/schema.md)) with pgvector embeddings (768 dims by default).

## What computes it

Extraction and embeddings are configured per deployment ([ADR 0020](/decisions/0020-memory-contract.md)), in `lib/memory/providers.ts`:

| Variable | Default | Effect |
|---|---|---|
| `MEMORY_EXTRACTION_MODEL` | `gemini-3.8-flash` | Any model id. It runs through the same adapter an agent with that id would, so every provider and the gateway work, and each call is an `llm.request` span in the ledger. |
| `MEMORY_EMBEDDING_PROVIDER` | `gemini` | `gemini`, `openai`, `ollama`, or `openai-compatible` (any `POST /embeddings` endpoint: Azure, LiteLLM, an internal proxy). |
| `MEMORY_EMBEDDING_MODEL` | `gemini-embedding-001` / `text-embedding-3-small` / `nomic-embed-text` | Per provider. |
| `MEMORY_EMBEDDING_DIMENSIONS` | `768` | Must equal the vector column it was created with; a returned vector of another length is refused. |
| `MEMORY_EMBEDDING_BASE_URL` | `https://api.openai.com/v1` / `http://localhost:11434/v1` | Required for `openai-compatible`; overrides the OpenAI or Ollama endpoint. |
| `MEMORY_EMBEDDING_API_KEY` | — | The key for `openai-compatible`. The `openai` provider uses `OPENAI_API_KEY`. |

The ledger's semantic search (the `embed` command of `scripts/telemetry_admin.ts`) uses the same embedder, so both vector columns stay comparable. A deployment that sets nothing uses Gemini for both, on the server's own key (`GOOGLE_GENAI_API_KEY` or `GEMINI_API_KEY`). Memory always runs on server keys, never on an A2A caller's `X-API-Key`.

## Where it is stored

The memory logic runs on a `MemoryStore` (`lib/memory/store.ts`), the five database operations it needs: existing facts, nearest facts, insert, retire, delete. There are two implementations over the same table and the same `match_memory_facts` function:

- **Supabase**, over its REST client.
- **Direct Postgres** (`lib/storage/postgres`, [ADR 0021](/decisions/0021-postgres-first-storage.md)), on any Postgres with pgvector.

`postgresStorage({ connectionString })` also provides sessions, A2A tasks and erase on the same connection:

- **Sessions** are stored one row per event in `adk_session_events`, so two turns on one conversation both land.
- **A2A tasks** in `adk_a2a_tasks` are scoped to their owner and shared by every instance.
- **`erase(scopeKey)`** removes a scope's facts and ingestion markers, conversations (sub-agent rows included), ledger rows, A2A tasks and, on a whole-scope erase, its task-tool list in one transaction (`melchizedek_erase_scope`). A namespace erase keeps a ledger row or task only when its conversation is still live in another namespace, so conversations whose sessions expired are erased too (migration 0011).

The Supabase path erases through the same database function (`lib/memory/erase.ts`). Conversations are kept seven days after their last update (`expire_at`); `melchizedek_prune_sessions()` deletes expired ones, nightly under pg_cron or by `npm run sessions:prune`.

The suite `tests/postgresStorage.test.ts` runs all of it against a real Postgres when `TEST_DATABASE_URL` is set.

### Stored event shape

A stored event is an ADK `Event` serialized as JSON, and the rows already in `adk_sessions.events` and `adk_session_events` are never migrated. The two stores hold it in different forms. The Supabase service passes each event through `trimEventForStorage` (`lib/session/transcript.ts`): a `thoughtSignature` on a function call becomes Gemini's skip value, and other signatures are dropped. A tool result over 2,000 characters keeps its `id` and `name`, so it stays paired with its call, but its `response` becomes `{ "elided": "<size> chars dropped before storage — …" }`, with the size in en-US digit grouping (`2,563`) whatever the server's locale. The Postgres adapter keeps the event verbatim. A DELEGATE subagent writes its own row, keyed by its name as `app_name` with the conversation's session id. A plan-dispatch classifier runs in a throwaway in-memory lane and writes nothing. The engine's own type for a stored event is `TurnEvent`, which reads both forms, and its session and memory interfaces are described in [sessions and events](/memory/sessions.md).

An orchestrator outside plan-dispatch reads its stored session unprojected, so its next turn's prompt replays earlier tool calls and their results as stored. From a trimmed row, the model receives the elision marker in place of the result.

`tests/fixtures/sessions/` freezes these shapes as written by the ADK runtime, so any runtime behind `runSyndicateTurn` can be shown to read and resume the conversations production already holds. There are eight fixtures: a DELEGATE turn, a plan-dispatch turn, an open approval, an open `ask_user` question, a workflow paused at an `ask_user` node, a Gemini turn with a `thoughtSignature` on a function call, a two-turn conversation, and a tool result over 2,000 characters with an answer read from it. The signature and the long result are frozen in both stored forms, because trimming rewrites them. `generate.ts` writes the fixtures on demand, never under `npm test`. It drives real ADK objects through `runSyndicateTurn` with scripted models and normalizes ids and timestamps. The elided size needs no rewrite, because it is en-US on any machine, so regenerating writes the same bytes in any locale. With `--check` it exits 1 when a fixture no longer matches what the runtime writes, which is what a dependency bump that changes the stored shape looks like. `npm run fixtures:sessions:check` runs that check, and CI's test job runs it after the offline suite on both Node versions. `tests/sessionFixtures.test.ts` parses each fixture, finds the open approval and question with `pendingApproval` and `pendingQuestion`, and resumes the approval, the question, the paused workflow and each completed conversation from the stored events alone, the long result from both forms.

## Write path

`addSessionToMemory` serializes the session's events, then a low-temperature extraction model distills them into one-line records:

```
[TAG | date: | source: | status: | keys: ] fact text
```

Eight tags (`FACT`, `PREFERENCE`, `DECISION`, `ACTION`, `CONTEXT`, `INSIGHT`, `CORRECTION`, `EPISODE`); notable extraction rules: units never rounded, relative dates converted to absolute, the model's own training knowledge never stored, unresolved contradictions store **both** sides, exactly one `EPISODE` narrative per transcript. Malformed lines are dropped — a bad extraction must never poison the store.

The A2A server ingests after every completed task, so each session would otherwise be re-read every turn. Three guards keep a fact from being stored twice:

- **A processed marker per session** means each turn is distilled once. It is stored (`melchizedek_memory_ingest`, migration 0007) and advances in the same transaction as the facts and their supersessions (`melchizedek_memory_commit`), so a restart re-reads nothing.
- **Exact duplicates** under the same user key are skipped.
- **Semantic duplicates** are skipped too: an active record with the same tag at cosine ≥ 0.93.

Each step throws on failure and the commit is one transaction, so a failed extraction, embedding or insert leaves the turns pending for the next task, with nothing half-stored. At boot the server refuses an embedder whose vector size differs from the stored column.

## Supersession

A `CORRECTION` record carries a quote of what it supersedes. The service embeds that quote, vector-searches the user's rows, and soft-retires a match at cosine ≥ 0.85 — or ≥ 0.6 when the two records share an index key. Retired rows keep `status='superseded'` and a pointer to their corrector, so history stays inspectable, and recall rewrites their header to say so — a retired fact can never masquerade as current state.

## Recall

`searchMemory` is hybrid: pgvector cosine (top 24 via the `match_memory_facts` RPC), then in-process re-ranking — boosts for index-key hits (+0.12), year (+0.08) and month (+0.10) matches parsed from the query, and active status (+0.05) — sliced to 10. Agents reach it by declaring `load_memory` / `preload_memory` in YAML with `memory_system: "long-term"`.

## Boundaries

Every row is siloed by `user_key = appName/userId`, where `appName` on the A2A server is the syndicate's `memory_namespace` (else `melchizedek-a2a`).

Erasure comes in two sizes. The A2A server's `DELETE /memory` and `erase(scopeKey)` remove a scope from every store: facts, sessions, ledger rows and A2A tasks ([A2A](/protocols/a2a.md)). `deleteUserMemory(userKey)` removes one user key's facts only, leaving sessions and the ledger in place. Both **throw** on failure rather than silently doing nothing. How the whole framework fits around this: [architecture](/overview/architecture.md).

Memory's extraction and embedding providers are their own choice (`MEMORY_EXTRACTION_MODEL`, `MEMORY_EMBEDDING_PROVIDER`), Gemini by default whatever the agents run on, so a syndicate's transcripts can reach a provider its agents do not use. The A2A server says so once per long-term syndicate at load (`memoryCrossesProviders` in `lib/memory/providers.ts`), naming the providers and the two variables; DOCUMENTATION's "Where your data goes" lists every destination and its retention.
