---
type: schema
title: Memory & telemetry schema
description: "The Postgres DDL shipped in db/, verbatim and in install order: the numbered migrations (sessions, memory facts, erase, the direct-Postgres tables, usage counters), the telemetry ledger, the row-level-security hardening and the memory_v2 upgrade."
tags:
  - schema
  - postgres
  - supabase
  - memory
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: db/migrations/0001_base.sql
  - resource: db/migrations/0002_erase_scope.sql
  - resource: db/migrations/0003_postgres_storage.sql
  - resource: db/migrations/0004_usage.sql
  - resource: db/migrations/0005_agent_registry.sql
  - resource: db/migrations/0006_task_leases.sql
  - resource: db/migrations/0007_memory_commit.sql
  - resource: db/migrations/0008_memory_retention.sql
  - resource: db/telemetry.sql
  - resource: db/hardening.sql
  - resource: db/memory_v2.sql
---

# Memory & telemetry schema

The generated sections below are the db/ files verbatim: the numbered migrations in `db/migrations/`, the optional telemetry ledger, the hardening, and a legacy upgrade script. `npm run db -- apply` (the `melchizedek-db` bin; `print` emits the same SQL for the Supabase SQL Editor) runs the migrations in order, then `db/hardening.sql`; with `--telemetry`, `db/telemetry.sql` and the hardening again. Every migration is idempotent and records itself in `melchizedek_schema_version`. The same SQL runs on Supabase or on any Postgres with pgvector ([ADR 0021](/decisions/0021-postgres-first-storage.md)).

One table the server can read is not created here: `adk_agent_registry`, which `registry:<id>` and `A2A_REGISTRY_AGENTS` load agent configs from. db/ ships no DDL for it; the hardening locks it down when it exists.

<!-- wiki:generated section="migration-0001_base" source="db/migrations/0001_base.sql" -->
## Migration 0001_base

```sql
-- ============================================================================
-- 0001_base.sql — the base schema: sessions and long-term memory.
--
-- Migrations in db/migrations/ run in filename order, then db/hardening.sql
-- (required before serving real users), then optionally db/telemetry.sql
-- (and hardening.sql again). `npx melchizedek-db apply` does exactly that;
-- `print` emits the same SQL to paste into the Supabase SQL Editor.
--
-- Every statement is idempotent: re-running a migration changes nothing
-- already in place, so this file is also the upgrade path from any earlier
-- layout (it subsumes db/memory_v2.sql). Each migration records its own
-- number in melchizedek_schema_version as its last statement.
--
-- The vector width (768) must equal EMBEDDING_DIMENSIONS in lib/config.ts.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ── 1. Sessions ──────────────────────────────────────────────────────────────
-- One row per conversation. `id` is the composite `{appName}:{userId}:{sessionId}`
-- (TEXT, not UUID), which isolates parallel subagents sharing one session id.
CREATE TABLE IF NOT EXISTS adk_sessions (
  id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state JSONB DEFAULT '{}'::jsonb,
  events JSONB DEFAULT '[]'::jsonb,
  last_update_time BIGINT,
  expire_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Retention: every write pushes expire_at seven days out, so a conversation
-- idle for seven days expires. The prune below deletes expired rows.
CREATE INDEX IF NOT EXISTS adk_sessions_expire_idx ON adk_sessions (expire_at);
CREATE INDEX IF NOT EXISTS adk_sessions_user_idx ON adk_sessions (app_name, user_id);

-- ── 2. Long-term memory ──────────────────────────────────────────────────────
-- Structured records: every fact carries its date, source, active/superseded
-- status and entity keys alongside the embedding (lib/memory/README.md).
CREATE TABLE IF NOT EXISTS adk_memory_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL,
  fact TEXT NOT NULL,
  embedding vector(768),
  tag TEXT,
  fact_date DATE,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  keys TEXT[] NOT NULL DEFAULT '{}',
  superseded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Older layouts: add the structured columns where they are missing.
ALTER TABLE adk_memory_facts
  ADD COLUMN IF NOT EXISTS tag TEXT,
  ADD COLUMN IF NOT EXISTS fact_date DATE,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS keys TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS superseded_by UUID;

-- Every query filters on user_key first; per-user sets are small, so an
-- exact scan within the silo is the dependable plan. The HNSW index serves
-- the large-silo case and, unlike an IVFFlat index built on an empty
-- table, needs no training data. (An existing IVFFlat index from an older
-- layout keeps working; drop it once this one exists if you like.)
CREATE INDEX IF NOT EXISTS adk_memory_facts_user_idx ON adk_memory_facts (user_key);
CREATE INDEX IF NOT EXISTS adk_memory_facts_embedding_hnsw_idx
  ON adk_memory_facts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS adk_memory_facts_keys_idx ON adk_memory_facts USING gin (keys);
CREATE INDEX IF NOT EXISTS adk_memory_facts_date_idx ON adk_memory_facts (user_key, fact_date);

-- ── 3. Recall RPC ────────────────────────────────────────────────────────────
-- filter_user_key is REQUIRED: a NULL key would return every user's facts.
-- Every earlier signature is dropped first (Postgres overloads by argument
-- list; a leftover overload makes the call ambiguous).
DROP FUNCTION IF EXISTS match_memory_facts(vector, int, text);
DROP FUNCTION IF EXISTS match_memory_facts(vector, text, int);

CREATE OR REPLACE FUNCTION match_memory_facts (
  query_embedding vector(768),
  filter_user_key text,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id UUID,
  user_key TEXT,
  fact TEXT,
  tag TEXT,
  fact_date DATE,
  source TEXT,
  status TEXT,
  keys TEXT[],
  created_at TIMESTAMPTZ,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF filter_user_key IS NULL THEN
    RAISE EXCEPTION 'filter_user_key is required';
  END IF;
  RETURN QUERY
  SELECT
    adk_memory_facts.id,
    adk_memory_facts.user_key,
    adk_memory_facts.fact,
    adk_memory_facts.tag,
    adk_memory_facts.fact_date,
    adk_memory_facts.source,
    adk_memory_facts.status,
    adk_memory_facts.keys,
    adk_memory_facts.created_at,
    1 - (adk_memory_facts.embedding <=> query_embedding) AS similarity
  FROM adk_memory_facts
  WHERE adk_memory_facts.user_key = filter_user_key
  ORDER BY adk_memory_facts.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ── 4. Session retention ─────────────────────────────────────────────────────
-- Deletes conversations whose expire_at has passed, including the per-
-- subagent rows ADK writes beside them. SECURITY DEFINER so a scheduled job
-- can run it; db/hardening.sql revokes it from every API role.
CREATE OR REPLACE FUNCTION melchizedek_prune_sessions()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n BIGINT := 0;
BEGIN
  DELETE FROM adk_sessions WHERE expire_at IS NOT NULL AND expire_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Nightly when pg_cron is available (Supabase: Database → Extensions →
-- pg_cron). Without it, run `npm run sessions:prune` on a schedule.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('melchizedek-prune-sessions', '23 3 * * *',
                          'SELECT melchizedek_prune_sessions()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END
$cron$;

-- ── 5. Schema version ────────────────────────────────────────────────────────
-- One row per applied migration, so tooling (and the server) can tell a
-- current database from a stale one. Every migration ends by inserting its
-- own number.
CREATE TABLE IF NOT EXISTS melchizedek_schema_version (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO melchizedek_schema_version (version, name)
VALUES (1, '0001_base')
ON CONFLICT (version) DO NOTHING;
```
<!-- /wiki:generated -->

<!-- wiki:generated section="migration-0002_erase_scope" source="db/migrations/0002_erase_scope.sql" -->
## Migration 0002_erase_scope

```sql
-- ============================================================================
-- 0002_erase_scope — one erase operation across every store (ADR 0020 item 7)
-- ============================================================================
-- melchizedek_erase_scope(scope_key, namespace, include_nested) deletes
-- everything that holds a scope's words, in one transaction, and returns a
-- row count per store:
--
--   memory_facts   adk_memory_facts   user_key = '<namespace>/<scope_key>'
--   sessions       adk_sessions       the scope's conversations, INCLUDING the
--                                     per-subagent rows ADK writes beside them
--                                     ('<SubAgent>:<scope>:<context>')
--   turns          adk_turns          ledger rows for those conversations
--   spans          adk_telemetry      spans of those turns' traces
--   payloads       adk_payloads       captured prompts of those traces
--   verdicts       adk_verdicts       judgments of those traces
--   labels         adk_labels         human labels of those traces
--   tasks          adk_a2a_tasks      A2A tasks the scope owns in those conversations
--                                     (0003; the Postgres adapter's task store)
--
-- namespace NULL erases the scope in every namespace. include_nested also
-- erases scopes nested beneath this one ('<scope_key>/...'), which is how a
-- key-level silo is erased together with its end users under keyMode byok.
-- Ledger tables are optional (db/telemetry.sql); absent ones report 0.
--
-- Conversations are identified by context id. When the same scope reused one
-- context id with two namespaces, a namespace-scoped erase removes both
-- conversations: erasure errs toward deleting, never toward keeping.
--
-- SECURITY INVOKER: it can delete only what the calling role can. It is
-- revoked from PUBLIC here and again by db/hardening.sql, and granted to
-- service_role where that role exists (Supabase).
-- ============================================================================

CREATE OR REPLACE FUNCTION melchizedek_erase_scope(
  p_scope_key      text,
  p_namespace      text    DEFAULT NULL,
  p_include_nested boolean DEFAULT false
) RETURNS TABLE(store text, deleted bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  -- LIKE pattern for scopes nested beneath this one, with the scope's own
  -- wildcard characters escaped.
  nested_like text := replace(replace(replace(p_scope_key, '\', '\\'), '%', '\%'), '_', '\_') || '/%';
  contexts    text[];
  traces      text[];
  n           bigint;
BEGIN
  IF p_scope_key IS NULL OR btrim(p_scope_key) = '' THEN
    RAISE EXCEPTION 'melchizedek_erase_scope: scope_key is required';
  END IF;

  -- The conversations (context ids) being erased. With a namespace, they are
  -- the namespace's own session rows; without one, every row of the scope.
  -- adk_sessions.id is '<app_name>:<user_id>:<context id>'.
  SELECT coalesce(array_agg(DISTINCT substr(s.id, length(s.app_name) + length(s.user_id) + 3)), '{}')
    INTO contexts
  FROM adk_sessions s
  WHERE (s.user_id = p_scope_key OR (p_include_nested AND s.user_id LIKE nested_like))
    AND (p_namespace IS NULL OR s.app_name = p_namespace);

  -- Ledger traces of those conversations, collected before anything is deleted.
  IF to_regclass('public.adk_turns') IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce(array_agg(DISTINCT trace_id), '{}') FROM adk_turns
      WHERE (user_id = $1 OR ($2 AND user_id LIKE $3))
        AND ($4 IS NULL OR session_id = ANY($5))
    $q$ INTO traces USING p_scope_key, p_include_nested, nested_like, p_namespace, contexts;
  ELSE
    traces := '{}';
  END IF;

  -- Memory facts. user_key is '<namespace>/<scope>' and a namespace never
  -- contains '/', so the scope is exactly what follows the first slash.
  DELETE FROM adk_memory_facts f
  WHERE (p_namespace IS NULL OR split_part(f.user_key, '/', 1) = p_namespace)
    AND (substr(f.user_key, strpos(f.user_key, '/') + 1) = p_scope_key
         OR (p_include_nested AND substr(f.user_key, strpos(f.user_key, '/') + 1) LIKE nested_like));
  GET DIAGNOSTICS n = ROW_COUNT;
  store := 'memory_facts'; deleted := n; RETURN NEXT;

  -- Sessions: every row of the scope in those conversations, whatever app
  -- name ADK gave it (subagents run under their own agent name).
  DELETE FROM adk_sessions s
  WHERE (s.user_id = p_scope_key OR (p_include_nested AND s.user_id LIKE nested_like))
    AND substr(s.id, length(s.app_name) + length(s.user_id) + 3) = ANY(contexts);
  GET DIAGNOSTICS n = ROW_COUNT;
  store := 'sessions'; deleted := n; RETURN NEXT;

  -- The ledger, when installed.
  IF to_regclass('public.adk_turns') IS NOT NULL THEN
    EXECUTE $q$
      DELETE FROM adk_turns
      WHERE (user_id = $1 OR ($2 AND user_id LIKE $3))
        AND ($4 IS NULL OR session_id = ANY($5))
    $q$ USING p_scope_key, p_include_nested, nested_like, p_namespace, contexts;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'turns'; deleted := n; RETURN NEXT;

  IF to_regclass('public.adk_telemetry') IS NOT NULL THEN
    EXECUTE 'DELETE FROM adk_telemetry WHERE trace_id = ANY($1)' USING traces;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'spans'; deleted := n; RETURN NEXT;

  IF to_regclass('public.adk_payloads') IS NOT NULL THEN
    EXECUTE 'DELETE FROM adk_payloads WHERE trace_id = ANY($1)' USING traces;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'payloads'; deleted := n; RETURN NEXT;

  IF to_regclass('public.adk_verdicts') IS NOT NULL THEN
    EXECUTE 'DELETE FROM adk_verdicts WHERE trace_id = ANY($1)' USING traces;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'verdicts'; deleted := n; RETURN NEXT;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'adk_labels' AND column_name = 'trace_id'
  ) THEN
    EXECUTE 'DELETE FROM adk_labels WHERE trace_id = ANY($1)' USING traces;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'labels'; deleted := n; RETURN NEXT;

  IF to_regclass('public.adk_a2a_tasks') IS NOT NULL THEN
    EXECUTE $q$
      DELETE FROM adk_a2a_tasks
      WHERE (owner = $1 OR ($2 AND owner LIKE $3))
        AND ($4 IS NULL OR context_id = ANY($5))
    $q$ USING p_scope_key, p_include_nested, nested_like, p_namespace, contexts;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'tasks'; deleted := n; RETURN NEXT;
END;
$$;

-- No API role may execute it (db/hardening.sql repeats this for every
-- melchizedek function); the server's role gets it back.
DO $$
BEGIN
  REVOKE ALL ON FUNCTION melchizedek_erase_scope(text, text, boolean) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION melchizedek_erase_scope(text, text, boolean) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION melchizedek_erase_scope(text, text, boolean) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION melchizedek_erase_scope(text, text, boolean) TO service_role;
  END IF;
END $$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (2, '0002_erase_scope')
ON CONFLICT (version) DO NOTHING;
```
<!-- /wiki:generated -->

<!-- wiki:generated section="migration-0003_postgres_storage" source="db/migrations/0003_postgres_storage.sql" -->
## Migration 0003_postgres_storage

```sql
-- ============================================================================
-- 0003_postgres_storage — tables the direct-Postgres adapter writes (ADR 0021)
-- ============================================================================
-- lib/storage/postgres/ uses these instead of the whole-row JSONB rewrite the
-- Supabase session service does. Both adapters share adk_sessions (one row per
-- conversation: state, timestamps, expiry); the Postgres adapter keeps the
-- events here, one row per event, so two turns appending to one conversation
-- both land instead of the later write erasing the earlier one.
-- ============================================================================

-- ── 1. Session events: append-only, one row per event ──────────────────────
CREATE TABLE IF NOT EXISTS adk_session_events (
  session_id TEXT    NOT NULL REFERENCES adk_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         DOUBLE PRECISION,           -- the event's own timestamp (seconds)
  event      JSONB   NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- ── 2. A2A tasks: durable, shared across instances, scoped to their owner ──
-- One row per task. tenant/owner come from the A2A ServerCallContext
-- (the SDK's own scoping rule), so one caller cannot read another's task by
-- id, and a task survives a restart or a poll that lands on another process.
CREATE TABLE IF NOT EXISTS adk_a2a_tasks (
  tenant     TEXT        NOT NULL DEFAULT '',
  owner      TEXT        NOT NULL,
  agent_id   TEXT        NOT NULL,
  id         TEXT        NOT NULL,
  context_id TEXT,
  state      INTEGER,                    -- TaskState enum value
  status_ts  TEXT,                       -- task.status.timestamp (ISO), the list order
  task       JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expire_at  TIMESTAMPTZ,
  PRIMARY KEY (tenant, owner, agent_id, id)
);
CREATE INDEX IF NOT EXISTS adk_a2a_tasks_list_idx
  ON adk_a2a_tasks (tenant, owner, agent_id, status_ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS adk_a2a_tasks_expire_idx ON adk_a2a_tasks (expire_at);

-- ── 3. Lock both down like every other table ───────────────────────────────
-- (db/hardening.sql repeats this; it must also hold for a database that is
-- never hardened, such as a private Postgres with no REST layer.)
ALTER TABLE adk_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE adk_a2a_tasks ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON adk_session_events, adk_a2a_tasks FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON adk_session_events, adk_a2a_tasks FROM authenticated;
  END IF;
END $$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (3, '0003_postgres_storage')
ON CONFLICT (version) DO NOTHING;
```
<!-- /wiki:generated -->

<!-- wiki:generated section="migration-0004_usage" source="db/migrations/0004_usage.sql" -->
## Migration 0004_usage

```sql
-- ============================================================================
-- 0004_usage — per-day usage counters for budgets (ADR 0026)
-- ============================================================================
-- One row per (UTC day, subject). A subject is 'caller:<name>' or
-- 'scope:<SHA-256 prefix of the scope key>': no user identifier is stored.
-- The server adds each finished task's spend with melchizedek_usage_add, one
-- atomic upsert, so several instances share the same counts. Rows hold
-- numbers only: no user text, no credentials.
-- ============================================================================

CREATE TABLE IF NOT EXISTS melchizedek_usage (
  day             DATE        NOT NULL,
  subject         TEXT        NOT NULL,
  tasks           BIGINT      NOT NULL DEFAULT 0,
  llm_calls       BIGINT      NOT NULL DEFAULT 0,
  input_tokens    BIGINT      NOT NULL DEFAULT 0,
  output_tokens   BIGINT      NOT NULL DEFAULT 0,
  thinking_tokens BIGINT      NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, subject)
);

-- Adds to a subject's counters for one day and returns the new totals.
CREATE OR REPLACE FUNCTION melchizedek_usage_add(
  p_day      date,
  p_subject  text,
  p_tasks    bigint,
  p_calls    bigint,
  p_input    bigint,
  p_output   bigint,
  p_thinking bigint
) RETURNS TABLE(tasks bigint, llm_calls bigint, input_tokens bigint, output_tokens bigint, thinking_tokens bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO melchizedek_usage AS u (day, subject, tasks, llm_calls, input_tokens, output_tokens, thinking_tokens)
  VALUES (p_day, p_subject, p_tasks, p_calls, p_input, p_output, p_thinking)
  ON CONFLICT (day, subject) DO UPDATE SET
    tasks           = u.tasks + EXCLUDED.tasks,
    llm_calls       = u.llm_calls + EXCLUDED.llm_calls,
    input_tokens    = u.input_tokens + EXCLUDED.input_tokens,
    output_tokens   = u.output_tokens + EXCLUDED.output_tokens,
    thinking_tokens = u.thinking_tokens + EXCLUDED.thinking_tokens,
    updated_at      = NOW()
  RETURNING u.tasks, u.llm_calls, u.input_tokens, u.output_tokens, u.thinking_tokens;
$$;

-- Old days are history, not budget: keep 90 days.
CREATE OR REPLACE FUNCTION melchizedek_prune_usage()
RETURNS BIGINT
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH gone AS (DELETE FROM melchizedek_usage WHERE day < CURRENT_DATE - 90 RETURNING 1)
  SELECT count(*) FROM gone;
$$;

ALTER TABLE melchizedek_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION melchizedek_usage_add(date, text, bigint, bigint, bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION melchizedek_prune_usage() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON melchizedek_usage FROM anon;
    REVOKE ALL ON FUNCTION melchizedek_usage_add(date, text, bigint, bigint, bigint, bigint, bigint) FROM anon;
    REVOKE ALL ON FUNCTION melchizedek_prune_usage() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON melchizedek_usage FROM authenticated;
    REVOKE ALL ON FUNCTION melchizedek_usage_add(date, text, bigint, bigint, bigint, bigint, bigint) FROM authenticated;
    REVOKE ALL ON FUNCTION melchizedek_prune_usage() FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION melchizedek_usage_add(date, text, bigint, bigint, bigint, bigint, bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION melchizedek_prune_usage() TO service_role;
  END IF;
END $$;

-- Nightly with the session prune, when pg_cron is available.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('melchizedek-prune-usage', '29 3 * * *', 'SELECT melchizedek_prune_usage()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END
$cron$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (4, '0004_usage')
ON CONFLICT (version) DO NOTHING;
```
<!-- /wiki:generated -->

<!-- wiki:generated section="migration-0005_agent_registry" source="db/migrations/0005_agent_registry.sql" -->
## Migration 0005_agent_registry

```sql
-- ============================================================================
-- 0005_agent_registry — the agent registry, versioned (ADR 0018 items 4, 7)
-- ============================================================================
-- `adk_agent_registry` keeps its shape and stays the read path: one row per
-- id, `yaml_content` is the ACTIVE definition, so every server and publishing
-- tool written against it keeps working. What changes is that no write to it
-- can lose history:
--
--   * `adk_agent_registry_versions` is append-only: every definition an id
--     has ever held, numbered per id, with its config hash, author, note and
--     publish time. Updates and deletes are refused.
--   * A trigger on `adk_agent_registry` records the version on EVERY write,
--     whoever makes it (melchizedek-registry, an older deploy script, a
--     dashboard edit). Writing a definition an id already held re-activates
--     that version instead of adding a duplicate, so a rollback is just
--     writing the old content back, and melchizedek_registry_activate does
--     exactly that.
--   * Deleting the active row retires the id; its versions stay.
--
-- The author and note come from the transaction settings
-- `melchizedek.registry_author` / `melchizedek.registry_note`, which
-- melchizedek_registry_publish sets; a direct write records the database
-- role instead. The table holds agent definitions only: prompts and tool
-- lists, no user data. Existing rows become version 1 of their id.
-- Idempotent; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS adk_agent_registry (
  id           TEXT PRIMARY KEY,
  yaml_content JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE adk_agent_registry ADD COLUMN IF NOT EXISTS version      INTEGER;
ALTER TABLE adk_agent_registry ADD COLUMN IF NOT EXISTS config_hash  TEXT;
ALTER TABLE adk_agent_registry ADD COLUMN IF NOT EXISTS published_by TEXT;
ALTER TABLE adk_agent_registry ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS adk_agent_registry_versions (
  id           TEXT        NOT NULL,
  version      INTEGER     NOT NULL,
  yaml_content JSONB       NOT NULL,
  config_hash  TEXT        NOT NULL,
  published_by TEXT        NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note         TEXT,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS idx_adk_agent_registry_versions_hash
  ON adk_agent_registry_versions (id, config_hash);

-- jsonb's text form is canonical (keys sorted, whitespace fixed), so equal
-- definitions hash equal whatever tool wrote them.
CREATE OR REPLACE FUNCTION melchizedek_registry_hash(p_config jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT encode(sha256(convert_to(p_config::text, 'UTF8')), 'hex');
$$;

-- ── Every write to the active table records a version ────────────────────
CREATE OR REPLACE FUNCTION melchizedek_registry_record()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  h        text := melchizedek_registry_hash(NEW.yaml_content);
  existing integer;
  author   text := COALESCE(NULLIF(current_setting('melchizedek.registry_author', true), ''), session_user::text);
  note     text := NULLIF(current_setting('melchizedek.registry_note', true), '');
BEGIN
  -- An update that does not change the definition is not a publish.
  IF TG_OP = 'UPDATE' AND OLD.config_hash = h AND OLD.version IS NOT NULL THEN
    NEW.version := OLD.version;
    NEW.config_hash := h;
    RETURN NEW;
  END IF;

  -- Serialise publishes of one id, so two writers cannot take one number.
  PERFORM pg_advisory_xact_lock(hashtext('melchizedek_registry:' || NEW.id));

  SELECT version INTO existing
  FROM adk_agent_registry_versions
  WHERE id = NEW.id AND config_hash = h
  ORDER BY version DESC
  LIMIT 1;

  IF existing IS NULL THEN
    SELECT COALESCE(MAX(version), 0) + 1 INTO existing
    FROM adk_agent_registry_versions WHERE id = NEW.id;
    INSERT INTO adk_agent_registry_versions (id, version, yaml_content, config_hash, published_by, note)
    VALUES (NEW.id, existing, NEW.yaml_content, h, author, note);
  END IF;

  NEW.version      := existing;
  NEW.config_hash  := h;
  NEW.published_by := author;
  NEW.published_at := NOW();
  NEW.updated_at   := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_adk_agent_registry_record ON adk_agent_registry;
CREATE TRIGGER trg_adk_agent_registry_record
  BEFORE INSERT OR UPDATE ON adk_agent_registry
  FOR EACH ROW EXECUTE FUNCTION melchizedek_registry_record();

-- ── History is append-only ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION melchizedek_registry_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'adk_agent_registry_versions is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_adk_agent_registry_versions_immutable ON adk_agent_registry_versions;
CREATE TRIGGER trg_adk_agent_registry_versions_immutable
  BEFORE UPDATE OR DELETE ON adk_agent_registry_versions
  FOR EACH ROW EXECUTE FUNCTION melchizedek_registry_versions_immutable();

-- ── Publish and activate, with an author and a note ──────────────────────
-- Both return the version that is now active. Validation is the caller's:
-- the same schema the loader enforces (lib/registry.ts runs it first).
CREATE OR REPLACE FUNCTION melchizedek_registry_publish(
  p_id     text,
  p_config jsonb,
  p_author text,
  p_note   text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v integer;
BEGIN
  IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9_.-]{1,120}$' THEN
    RAISE EXCEPTION 'invalid registry id: %', p_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('melchizedek.registry_author', COALESCE(p_author, ''), true);
  PERFORM set_config('melchizedek.registry_note', COALESCE(p_note, ''), true);
  INSERT INTO adk_agent_registry (id, yaml_content) VALUES (p_id, p_config)
  ON CONFLICT (id) DO UPDATE SET yaml_content = EXCLUDED.yaml_content
  RETURNING version INTO v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION melchizedek_registry_activate(
  p_id      text,
  p_version integer,
  p_author  text,
  p_note    text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  cfg jsonb;
BEGIN
  SELECT yaml_content INTO cfg FROM adk_agent_registry_versions WHERE id = p_id AND version = p_version;
  IF cfg IS NULL THEN
    RAISE EXCEPTION 'no version % of registry id %', p_version, p_id USING ERRCODE = 'no_data_found';
  END IF;
  RETURN melchizedek_registry_publish(p_id, cfg, p_author, COALESCE(p_note, format('activate v%s', p_version)));
END;
$$;

-- ── Backfill: what is already live becomes version 1 ─────────────────────
-- The trigger does the recording; the update sets nothing that changes the
-- definition, so it only fires for rows that have no version yet.
DO $$
BEGIN
  PERFORM set_config('melchizedek.registry_author', 'migration 0005', true);
  PERFORM set_config('melchizedek.registry_note', 'the definition live when versioning began', true);
  UPDATE adk_agent_registry SET yaml_content = yaml_content WHERE version IS NULL;
END $$;

-- Locked down like every other table here; db/hardening.sql repeats it.
ALTER TABLE adk_agent_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE adk_agent_registry_versions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON adk_agent_registry, adk_agent_registry_versions FROM anon, authenticated';
  END IF;
END $$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (5, '0005_agent_registry')
ON CONFLICT (version) DO NOTHING;
```
<!-- /wiki:generated -->

<!-- wiki:generated section="migration-0006_task_leases" source="db/migrations/0006_task_leases.sql" -->
## Migration 0006_task_leases

```sql
-- ============================================================================
-- 0006_task_leases — a running A2A task belongs to a live instance (ADR 0021)
-- ============================================================================
-- An instance that saves a task while it is still running (submitted or
-- working) stamps it with its own id and a lease deadline, and renews the
-- lease while the task runs. A final state clears it. When an instance dies
-- mid-task its leases stop being renewed; any instance then finds the task
-- with an expired lease and marks it failed, instead of a client polling a
-- task that will never finish. A task waiting on its client (input-required)
-- holds no lease: nothing is running it.
-- Idempotent; safe to re-run.
-- ============================================================================

ALTER TABLE adk_a2a_tasks ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE adk_a2a_tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

-- Only leased rows are ever scanned for expiry.
CREATE INDEX IF NOT EXISTS adk_a2a_tasks_lease_idx
  ON adk_a2a_tasks (lease_until) WHERE lease_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS adk_a2a_tasks_lease_owner_idx
  ON adk_a2a_tasks (lease_owner) WHERE lease_owner IS NOT NULL;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (6, '0006_task_leases')
ON CONFLICT (version) DO NOTHING;
```
<!-- /wiki:generated -->

<!-- wiki:generated section="migration-0007_memory_commit" source="db/migrations/0007_memory_commit.sql" -->
## Migration 0007_memory_commit

```sql
-- ============================================================================
-- 0007_memory_commit — memory ingestion commits as one unit (ADR 0020)
-- ============================================================================
-- Three parts of the memory contract that need the database:
--
--   * melchizedek_memory_ingest — the processed marker, durable: how many
--     events of each session have been distilled. It survives a restart, so
--     a turn is never extracted twice, and it advances in the SAME
--     transaction that stores the facts, so it can never run ahead of them
--     (ADR 0020 item 6). It holds identifiers only (scope and session id),
--     never the user's words; stale rows are pruned after 30 days.
--   * melchizedek_memory_commit — inserts a batch of facts, retires the rows
--     they supersede (linked to their replacement) and advances the marker,
--     in one transaction. Both storage backends call it; over the Supabase
--     REST API it is the only way to make those writes atomic.
--   * melchizedek_memory_dimensions — the size of the embedding column, so
--     the server can refuse an embedder whose vectors would not fit
--     (ADR 0020 item 5) instead of failing on every insert.
-- Idempotent; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS melchizedek_memory_ingest (
  user_key        TEXT        NOT NULL,
  session_id      TEXT        NOT NULL,
  events_ingested INTEGER     NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_key, session_id)
);
CREATE INDEX IF NOT EXISTS idx_melchizedek_memory_ingest_updated ON melchizedek_memory_ingest (updated_at);

-- p_rows:   [{fact, embedding: [..], tag, fact_date, source, status, keys: [..]}]
-- p_retire: [{id, by_fact}] — retire row `id`, superseded by the new row whose
--           fact is `by_fact` (skipped if that fact was not inserted).
-- Returns the inserted rows. The marker only ever moves forward.
CREATE OR REPLACE FUNCTION melchizedek_memory_commit(
  p_user_key   text,
  p_session_id text,
  p_events     integer,
  p_rows       jsonb,
  p_retire     jsonb
) RETURNS TABLE(new_id uuid, new_fact text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  inserted jsonb;
BEGIN
  IF p_user_key IS NULL OR btrim(p_user_key) = '' THEN
    RAISE EXCEPTION 'melchizedek_memory_commit: user_key is required';
  END IF;

  WITH ins AS (
    INSERT INTO adk_memory_facts (user_key, fact, embedding, tag, fact_date, source, status, keys)
    SELECT p_user_key,
           r->>'fact',
           (r->'embedding')::text::vector,
           r->>'tag',
           NULLIF(r->>'fact_date', '')::date,
           r->>'source',
           COALESCE(r->>'status', 'active'),
           COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(r->'keys', '[]'::jsonb))), '{}')
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
    RETURNING adk_memory_facts.id AS fid, adk_memory_facts.fact AS ffact
  )
  SELECT COALESCE(jsonb_object_agg(ffact, fid), '{}'::jsonb) INTO inserted FROM ins;

  UPDATE adk_memory_facts f
     SET status = 'superseded',
         superseded_by = (inserted->>(x->>'by_fact'))::uuid,
         updated_at = NOW()
    FROM jsonb_array_elements(COALESCE(p_retire, '[]'::jsonb)) AS x
   WHERE f.id = (x->>'id')::uuid
     AND f.user_key = p_user_key
     AND f.status = 'active'
     AND inserted ? (x->>'by_fact');

  IF p_session_id IS NOT NULL AND p_events IS NOT NULL THEN
    INSERT INTO melchizedek_memory_ingest AS m (user_key, session_id, events_ingested, updated_at)
    VALUES (p_user_key, p_session_id, p_events, NOW())
    ON CONFLICT (user_key, session_id) DO UPDATE
      SET events_ingested = GREATEST(m.events_ingested, EXCLUDED.events_ingested),
          updated_at = NOW();
  END IF;

  RETURN QUERY SELECT (e.value #>> '{}')::uuid, e.key FROM jsonb_each(inserted) AS e;
END;
$$;

CREATE OR REPLACE FUNCTION melchizedek_memory_dimensions()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT NULLIF(a.atttypmod, -1)
  FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public.adk_memory_facts')
    AND a.attname = 'embedding'
    AND NOT a.attisdropped;
$$;

CREATE OR REPLACE FUNCTION melchizedek_prune_memory_ingest()
RETURNS bigint
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH d AS (DELETE FROM melchizedek_memory_ingest WHERE updated_at < NOW() - INTERVAL '30 days' RETURNING 1)
  SELECT count(*) FROM d;
$$;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('melchizedek-prune-memory-ingest', '37 3 * * *',
                          'SELECT melchizedek_prune_memory_ingest()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END
$cron$;

ALTER TABLE melchizedek_memory_ingest ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON melchizedek_memory_ingest FROM anon, authenticated';
  END IF;
END $$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (7, '0007_memory_commit')
ON CONFLICT (version) DO NOTHING;
```
<!-- /wiki:generated -->

<!-- wiki:generated section="migration-0008_memory_retention" source="db/migrations/0008_memory_retention.sql" -->
## Migration 0008_memory_retention

```sql
-- ============================================================================
-- 0008_memory_retention — facts may expire per namespace (ADR 0020 item 7)
-- ============================================================================
-- A syndicate that declares `memory_retention_days` (with its own
-- `memory_namespace`) has facts older than that deleted. The server calls
-- this once when it loads the syndicate and daily after; the window lives in
-- the YAML, so removing it stops the pruning. A namespace is the part of
-- user_key before the first '/', and never contains one.
-- Idempotent; safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION melchizedek_prune_memory(p_namespace text, p_days integer)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  n bigint;
BEGIN
  IF p_namespace IS NULL OR p_namespace !~ '^[A-Za-z0-9._-]{1,96}$' THEN
    RAISE EXCEPTION 'melchizedek_prune_memory: invalid namespace %', p_namespace USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_days IS NULL OR p_days < 1 THEN
    RAISE EXCEPTION 'melchizedek_prune_memory: days must be at least 1' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM adk_memory_facts
   WHERE split_part(user_key, '/', 1) = p_namespace
     AND created_at < NOW() - make_interval(days => p_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (8, '0008_memory_retention')
ON CONFLICT (version) DO NOTHING;
```
<!-- /wiki:generated -->

<!-- wiki:generated section="telemetry-ddl" source="db/telemetry.sql" -->
## Telemetry ledger (optional)

```sql
-- ============================================================
-- Melchizedek — The observability ledger (TELEMETRY_SUPABASE=true)
-- Idempotent: safe to run on a fresh project AND on one that already has
-- the v1 adk_telemetry table. Run it in the Supabase SQL Editor (or with
-- psql via SUPABASE_DB_URL), THEN re-run db/hardening.sql — it locks these
-- tables down too.
-- ============================================================
--
-- WHY THREE TABLES
-- The engine emits OpenTelemetry spans for every turn and every model
-- call (lib/observability/tracer.ts). By default they print to the console
-- and are gone. With the sink on, lib/observability/supabaseSpanExporter.ts
-- writes them here in three tiers with three lifetimes:
--
--   adk_turns      ONE ROW PER TURN — the system of record. Input, output,
--                  the responding agent, the plan-dispatch route and how it
--                  was decided, errors, tokens, latency split into model vs
--                  tool time, the tool calls WITH their full responses
--                  (the grounding evidence), and the identity that joins the
--                  row to everything else: trace_id, session_id, user_id,
--                  task_id, invocation_id. Plus provenance: config_hash (the
--                  resolved syndicate that ran) and engine_version. Kept
--                  indefinitely; full-text searchable. Eval runs land here
--                  too, tagged eval_* so production views exclude them.
--   adk_telemetry  ONE ROW PER SPAN — the raw llm.request and root spans as
--                  before (v1 shape, now with the identity columns). Per-call
--                  tokens, latency and the agent that made the call. Small;
--                  kept indefinitely.
--   adk_payloads   FULL REQUEST/RESPONSE PER MODEL CALL — the assembled
--                  prompt (system instruction, history, tool schemas) and the
--                  raw response. 10-100x the size of a turn row and repeats
--                  the history on every call, so it is captured by POLICY
--                  (TELEMETRY_PAYLOADS: errors and fallbacks always, a
--                  deterministic sample of the rest) and EXPIRES (30 days by
--                  default, melchizedek_prune_telemetry() enforces it).
--
-- Join keys: adk_turns.trace_id = adk_telemetry.trace_id = adk_payloads.trace_id = adk_verdicts.ref = adk_labels.ref
--            adk_sessions.id     = app_name || ':' || user_id || ':' || adk_turns.session_id
--            adk_sessions.events[*].invocationId = adk_turns.invocation_id
--
-- Writes go through the service_role key. The anon/authenticated API paths
-- are closed by db/hardening.sql — re-run it after this file.

-- ── adk_telemetry: raw spans (v1 table, upgraded in place) ───────────────
CREATE TABLE IF NOT EXISTS adk_telemetry (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL,
  span_name       TEXT NOT NULL,          -- 'llm.request' | 'Syndicate Execution: <name>'
  syndicate       TEXT,                   -- syndicate name, when known
  agent           TEXT,                   -- the agent that made the call / answered the turn
  provider        TEXT,                   -- 'gemini' | 'anthropic' | 'openai' | 'xai' | 'ollama'
  model           TEXT,                   -- model id as declared in YAML
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  thinking_tokens INTEGER,
  latency_ms      DOUBLE PRECISION,
  span            JSONB NOT NULL          -- full span (attributes, events, status)
);
ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS session_id     TEXT;
ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS user_id        TEXT;
ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS task_id        TEXT;
ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS invocation_id  TEXT;
ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS schema_version SMALLINT NOT NULL DEFAULT 2;

CREATE INDEX IF NOT EXISTS idx_adk_telemetry_ts      ON adk_telemetry (ts DESC);
CREATE INDEX IF NOT EXISTS idx_adk_telemetry_trace   ON adk_telemetry (trace_id);
CREATE INDEX IF NOT EXISTS idx_adk_telemetry_session ON adk_telemetry (session_id);

-- ── adk_turns: one row per turn — the system of record ───────────────────
CREATE TABLE IF NOT EXISTS adk_turns (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts                 TIMESTAMPTZ NOT NULL,
  trace_id           TEXT NOT NULL,
  span_id            TEXT NOT NULL,
  -- identity
  session_id         TEXT,                -- the A2A contextId / CLI session id
  user_id            TEXT,                -- hashed caller silo (a2a-<keyhash>[/<siteUserId>])
  task_id            TEXT,                -- the A2A task
  invocation_id      TEXT,                -- ADK invocation: matches adk_sessions.events[*].invocationId
  -- what ran
  syndicate          TEXT NOT NULL,
  stage              TEXT NOT NULL DEFAULT 'delegate',  -- delegate | dispatch | classify | judge
  agent              TEXT,                -- the agent whose text became the answer
  route              TEXT,                -- plan-dispatch: the specialist chosen
  route_reason       TEXT,
  route_fell_back    BOOLEAN,
  route_via_override BOOLEAN,
  relay_fallback     BOOLEAN NOT NULL DEFAULT false,  -- DELEGATE: last tool result relayed verbatim
  -- the exchange
  input              TEXT,
  output             TEXT,
  error_code         TEXT,
  error_message      TEXT,
  -- cost and time
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  thinking_tokens    INTEGER,
  latency_ms         DOUBLE PRECISION,
  model_ms           DOUBLE PRECISION,    -- summed llm.request durations
  tool_ms            DOUBLE PRECISION,    -- summed ADK execute_tool durations
  llm_calls          INTEGER,
  tool_calls         INTEGER,
  models             TEXT[],
  -- evidence: [{name, tool, args, data}] — the full tool responses the answer was built from
  tool_events        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- provenance
  config_hash        TEXT,                -- lib/observability/lineage.ts configDigest()
  engine_version     TEXT,                -- "<package version>+<commit>"
  -- eval tagging (null on production traffic)
  eval_run           TEXT,
  eval_suite         TEXT,
  eval_case          TEXT,
  eval_variant       TEXT,
  eval_trial         INTEGER,
  -- everything else the span carried
  attributes         JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version     SMALLINT NOT NULL DEFAULT 2,
  -- search
  search             TSVECTOR GENERATED ALWAYS AS
                       (to_tsvector('english', coalesce(input, '') || ' ' || coalesce(output, ''))) STORED,
  UNIQUE (trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_adk_turns_ts        ON adk_turns (ts DESC);
CREATE INDEX IF NOT EXISTS idx_adk_turns_trace     ON adk_turns (trace_id);
CREATE INDEX IF NOT EXISTS idx_adk_turns_session   ON adk_turns (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_adk_turns_user      ON adk_turns (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_adk_turns_syndicate ON adk_turns (syndicate, ts DESC);
CREATE INDEX IF NOT EXISTS idx_adk_turns_route     ON adk_turns (route);
CREATE INDEX IF NOT EXISTS idx_adk_turns_eval_run  ON adk_turns (eval_run);
CREATE INDEX IF NOT EXISTS idx_adk_turns_search    ON adk_turns USING gin (search);

-- ── Surface identity: WHERE the turn came from ───────────────────────────
-- The ledger's own identity columns describe the SERVER's view of a turn
-- (conversation, credential, task). They cannot say which Discord channel
-- asked, because the contextId is an opaque conversation key and user_id is
-- the caller's credential hash. A caller may name its own surface with the
-- optional X-Surface-* request headers; the server validates them, stamps
-- them on the root span, and they land here.
--
-- Deliberately additive and deliberately NOT tied to memory: the X-User-Id
-- header silos long-term memory, so using it to carry a Discord author id
-- would give every human their own memory silo and change what the agent
-- remembers. Observability must not change behavior, so this is a separate
-- channel that only ever reaches telemetry.
--
-- surface_user is a PSEUDONYM, not an account id: callers are expected to
-- send a salted hash, so a channel's traffic
-- stays sliceable without the ledger holding a platform identity.
ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS surface         TEXT;  -- 'discord' | 'cli' | 'web' | ...
ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS surface_guild   TEXT;  -- Discord guild (server) id
ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS surface_channel TEXT;  -- Discord channel id
ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS surface_user    TEXT;  -- salted hash of the asker

CREATE INDEX IF NOT EXISTS idx_adk_turns_surface_channel
  ON adk_turns (surface, surface_channel, ts DESC);
CREATE INDEX IF NOT EXISTS idx_adk_turns_surface_user
  ON adk_turns (surface, surface_user, ts DESC);
-- Note for anyone applying these ALTERs by hand rather than re-running this
-- file: adk_turns_production below is `SELECT *`, and Postgres expands that
-- at CREATE time. It does not gain these columns until it is re-created, so
-- run the whole file, in order.

-- ── adk_payloads: full prompt/response per model call, by policy, expiring ─
CREATE TABLE IF NOT EXISTS adk_payloads (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL,
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL,
  session_id      TEXT,
  invocation_id   TEXT,
  agent           TEXT,
  provider        TEXT,
  model           TEXT,
  reason          TEXT NOT NULL,          -- 'error' | 'fallback' | 'sample' | 'all'
  request         JSONB,                  -- the assembled model request (system instruction, history, tools)
  response        JSONB,                  -- the raw model response
  request_chars   INTEGER,
  response_chars  INTEGER,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  schema_version  SMALLINT NOT NULL DEFAULT 2,
  UNIQUE (trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_adk_payloads_trace   ON adk_payloads (trace_id);
CREATE INDEX IF NOT EXISTS idx_adk_payloads_expires ON adk_payloads (expires_at);
CREATE INDEX IF NOT EXISTS idx_adk_payloads_session ON adk_payloads (session_id);

-- ── Retention ─────────────────────────────────────────────────────────────
-- Payloads expire by row; turns and raw spans are kept unless a turn_days
-- bound is passed. SECURITY DEFINER so a scheduled job can run it; revoked
-- from the API roles by db/hardening.sql.
CREATE OR REPLACE FUNCTION melchizedek_prune_telemetry(turn_days INTEGER DEFAULT NULL)
RETURNS TABLE(payloads_deleted BIGINT, turns_deleted BIGINT, spans_deleted BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p BIGINT := 0; t BIGINT := 0; s BIGINT := 0;
BEGIN
  DELETE FROM adk_payloads WHERE expires_at < now();
  GET DIAGNOSTICS p = ROW_COUNT;
  IF turn_days IS NOT NULL THEN
    DELETE FROM adk_turns WHERE ts < now() - make_interval(days => turn_days);
    GET DIAGNOSTICS t = ROW_COUNT;
    DELETE FROM adk_telemetry WHERE ts < now() - make_interval(days => turn_days);
    GET DIAGNOSTICS s = ROW_COUNT;
  END IF;
  RETURN QUERY SELECT p, t, s;
END;
$$;

-- Nightly prune when pg_cron is available (Supabase: Database → Extensions →
-- pg_cron). Without it, run `npm run telemetry:prune` on a schedule instead.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('melchizedek-prune-telemetry', '17 3 * * *',
                          'SELECT melchizedek_prune_telemetry()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END
$cron$;

-- ── A production-only view: the turns a user actually received ───────────
-- Excludes eval traffic, judge calls, and the plan-dispatch classifier's
-- own turn (stage 'classify' — joinable to its dispatch row by task_id).
CREATE OR REPLACE VIEW adk_turns_production AS
  SELECT * FROM adk_turns
  WHERE eval_run IS NULL AND stage IN ('delegate', 'dispatch');

-- ── adk_verdicts: eval-judge verdicts, persisted ─────────────────────────
-- One row per (turn, judge, run). A re-judge with a new rubric is a new
-- run_id beside the old one, never an overwrite: judge_hash and
-- dataset_hash say exactly what graded what. `ref` is the turn's trace_id
-- when it has one, else a session key — so verdicts on session-sourced
-- exchanges persist too.
CREATE TABLE IF NOT EXISTS adk_verdicts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  ref             TEXT NOT NULL,          -- trace_id, or 'session:<id>:<n>'
  trace_id        TEXT,
  run_id          TEXT NOT NULL,
  record_id       TEXT,
  suite           TEXT NOT NULL,
  case_id         TEXT,
  variant         TEXT,
  trial           INTEGER,
  judge           TEXT NOT NULL,          -- the judge label in the suite
  judge_kind      TEXT NOT NULL,          -- programmatic | llm | golden | pairwise
  judge_hash      TEXT,                   -- rubric + model + thresholds + script
  judge_model     TEXT,
  dataset_hash    TEXT,
  config_hash     TEXT,                   -- of the syndicate that produced the turn
  passed          BOOLEAN,
  score           DOUBLE PRECISION,
  fields          JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale       TEXT,
  error           TEXT,
  judge_tokens    INTEGER,
  schema_version  SMALLINT NOT NULL DEFAULT 2,
  UNIQUE (ref, judge, run_id)
);
CREATE INDEX IF NOT EXISTS idx_adk_verdicts_ref   ON adk_verdicts (ref);
CREATE INDEX IF NOT EXISTS idx_adk_verdicts_trace ON adk_verdicts (trace_id);
CREATE INDEX IF NOT EXISTS idx_adk_verdicts_run   ON adk_verdicts (run_id);
CREATE INDEX IF NOT EXISTS idx_adk_verdicts_judge ON adk_verdicts (suite, judge, ts DESC);

-- ── adk_labels: human judgments, the calibration ground truth ─────────────
-- An eval harness's labelling tool writes here. A label outlives every re-judge of the
-- same turn; judge-versus-human agreement (Cohen's kappa) is computed by
-- joining on ref.
CREATE TABLE IF NOT EXISTS adk_labels (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  ref             TEXT NOT NULL,
  trace_id        TEXT,
  labeler         TEXT NOT NULL,
  judge           TEXT,                   -- the judge this label calibrates; NULL = all
  suite           TEXT,
  run_id          TEXT,
  case_id         TEXT,
  variant         TEXT,
  passed          BOOLEAN,
  score           DOUBLE PRECISION,
  fields          JSONB NOT NULL DEFAULT '{}'::jsonb,
  note            TEXT,
  schema_version  SMALLINT NOT NULL DEFAULT 2,
  UNIQUE (ref, labeler, judge)
);
CREATE INDEX IF NOT EXISTS idx_adk_labels_ref ON adk_labels (ref);

-- ── Semantic search over turns ───────────────────────────────────────────
-- The same embedding model and dimensions as long-term memory
-- (lib/config.ts EMBEDDING_MODEL / EMBEDDING_DIMENSIONS). Rows are embedded
-- by `npm run telemetry:embed` (a job, not the exporter — inference stays
-- off the export path); match_turns queries them.
ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS embedding vector(768);
DO $idx$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_adk_turns_embedding') THEN
    BEGIN
      EXECUTE 'CREATE INDEX idx_adk_turns_embedding ON adk_turns USING hnsw (embedding vector_cosine_ops)';
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'CREATE INDEX idx_adk_turns_embedding ON adk_turns USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)';
    END;
  END IF;
END
$idx$;

CREATE OR REPLACE FUNCTION match_turns(
  query_embedding vector(768),
  match_count INTEGER DEFAULT 20,
  since TIMESTAMPTZ DEFAULT NULL,
  filter_syndicate TEXT DEFAULT NULL,
  filter_route TEXT DEFAULT NULL,
  include_evals BOOLEAN DEFAULT false
)
RETURNS TABLE(
  id BIGINT, ts TIMESTAMPTZ, trace_id TEXT, session_id TEXT, syndicate TEXT, stage TEXT, route TEXT, agent TEXT,
  input TEXT, output TEXT, latency_ms DOUBLE PRECISION, similarity DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.ts, t.trace_id, t.session_id, t.syndicate, t.stage, t.route, t.agent, t.input, t.output, t.latency_ms,
         1 - (t.embedding <=> query_embedding) AS similarity
  FROM adk_turns t
  WHERE t.embedding IS NOT NULL
    AND t.stage IN ('delegate', 'dispatch')
    AND (include_evals OR t.eval_run IS NULL)
    AND (since IS NULL OR t.ts >= since)
    AND (filter_syndicate IS NULL OR t.syndicate = filter_syndicate)
    AND (filter_route IS NULL OR t.route = filter_route)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── KPI views ─────────────────────────────────────────────────────────────
-- Standing daily aggregates over production turns and persisted verdicts,
-- for dashboards (Supabase charts, Metabase, Grafana) and the alert job.
CREATE OR REPLACE VIEW adk_kpi_daily AS
  SELECT date_trunc('day', ts) AS day,
         syndicate,
         count(*)                                           AS turns,
         count(DISTINCT session_id)                         AS sessions,
         count(DISTINCT user_id)                            AS users,
         avg((error_code IS NOT NULL)::int)                 AS error_rate,
         avg(coalesce(route_fell_back, false)::int)         AS route_fallback_rate,
         avg(relay_fallback::int)                           AS relay_fallback_rate,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)  AS p50_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
         sum(input_tokens)                                  AS input_tokens,
         sum(output_tokens)                                 AS output_tokens,
         sum(thinking_tokens)                               AS thinking_tokens,
         avg(llm_calls)                                     AS avg_llm_calls,
         avg(tool_calls)                                    AS avg_tool_calls
  FROM adk_turns_production
  GROUP BY 1, 2;

CREATE OR REPLACE VIEW adk_kpi_routes_daily AS
  SELECT date_trunc('day', ts) AS day,
         syndicate,
         coalesce(route, agent) AS route,
         count(*)                                           AS turns,
         avg((error_code IS NOT NULL)::int)                 AS error_rate,
         avg(coalesce(route_fell_back, false)::int)         AS route_fallback_rate,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
         avg(latency_ms)                                    AS mean_ms,
         sum(input_tokens + output_tokens)                  AS tokens
  FROM adk_turns_production
  GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW adk_kpi_judges_daily AS
  SELECT date_trunc('day', v.ts) AS day,
         v.suite, v.judge, v.judge_kind, v.variant,
         count(*)                                  AS verdicts,
         avg(v.passed::int)                        AS pass_rate,
         avg(v.score)                              AS mean_score,
         count(*) FILTER (WHERE v.error IS NOT NULL) AS judge_errors
  FROM adk_verdicts v
  GROUP BY 1, 2, 3, 4, 5;

-- Hourly variant for alerts: the last N hours at a glance.
CREATE OR REPLACE VIEW adk_kpi_hourly AS
  SELECT date_trunc('hour', ts) AS hour,
         syndicate,
         count(*)                                           AS turns,
         avg((error_code IS NOT NULL)::int)                 AS error_rate,
         avg(coalesce(route_fell_back, false)::int)         AS route_fallback_rate,
         avg(relay_fallback::int)                           AS relay_fallback_rate,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
         sum(input_tokens + output_tokens)                  AS tokens
  FROM adk_turns_production
  GROUP BY 1, 2;
```
<!-- /wiki:generated -->

<!-- wiki:generated section="hardening-ddl" source="db/hardening.sql" -->
## Hardening (RLS)

```sql
-- ============================================================
-- Melchizedek — Database Hardening (run AFTER the numbered migrations in
-- db/migrations/ and, if upgrading, after db/memory_v2.sql — order with
-- memory_v2 does not matter; the function revoke below handles either
-- signature). `npm run db -- apply` runs it last; it is idempotent.
-- ============================================================
--
-- WHY THIS EXISTS
-- In a default Supabase project, tables created in the `public` schema are
-- exposed through the auto-generated REST API (PostgREST) and are readable/
-- writable with the widely-distributed `anon` key whenever Row-Level
-- Security is disabled. Melchizedek's `adk_sessions` (conversation
-- transcripts), `adk_memory_facts` (distilled user facts) and
-- `adk_agent_registry` (the agent definitions the A2A server boots from)
-- must never be reachable that way. The registry is the sharpest of the
-- three: anon write access there means replacing an agent's instruction and
-- tool list, i.e. taking over every server that boots `registry:<id>`.
--
-- WHAT EACH TIER BUYS — BE HONEST WITH YOURSELF ABOUT THIS:
--   Tier 1 (this file): closes the anon/authenticated API paths entirely.
--     The Melchizedek server itself connects with the service_role key,
--     which BYPASSES RLS by design — so tier 1 does not constrain the
--     server; it constrains everyone else.
--   Tier 2 (documented at the bottom, not enabled by default): a dedicated
--     runtime role bound by RLS policies scoped to one user_key per
--     request. This constrains the server too — a bug in application code
--     cannot read across silos. It requires connecting via a direct
--     Postgres role instead of the service_role REST client.
--
-- The A2A server checks at boot whether this file has been applied and
-- prints a prominent warning if not (see lib/persistence/supabaseProvider.ts).

-- ── Tier 1: lock the public API paths ────────────────────────────────────

-- Enable RLS. With RLS on and NO policies defined, anon/authenticated get
-- deny-by-default. service_role is unaffected (it bypasses RLS).
ALTER TABLE adk_memory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE adk_sessions     ENABLE ROW LEVEL SECURITY;

-- Belt and suspenders: also revoke the default table privileges from the
-- API roles, so even a future accidentally-created permissive policy
-- cannot re-expose the tables.
REVOKE ALL ON adk_memory_facts FROM anon, authenticated;
REVOKE ALL ON adk_sessions     FROM anon, authenticated;

-- Optional observability ledger (db/telemetry.sql). Guarded: the tables only
-- exist when the operator opted into TELEMETRY_SUPABASE. adk_turns holds
-- user input and output, adk_payloads full prompts — same lockdown as the
-- transcript tables, for the same reason.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['adk_telemetry', 'adk_turns', 'adk_payloads', 'adk_verdicts', 'adk_labels',
                            'adk_session_events', 'adk_a2a_tasks', 'melchizedek_usage'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    END IF;
  END LOOP;
  -- The production view and the retention function read/delete those
  -- tables on behalf of the caller; neither belongs on the public API.
  FOREACH t IN ARRAY ARRAY['adk_turns_production', 'adk_kpi_daily', 'adk_kpi_routes_daily', 'adk_kpi_judges_daily', 'adk_kpi_hourly'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    END IF;
  END LOOP;
  -- Function privileges for these are handled in the FUNCTIONS block below.
END $$;

-- Schema bookkeeping (db/migrations). Nothing secret, but nothing the public
-- API needs either.
DO $$
BEGIN
  IF to_regclass('public.melchizedek_schema_version') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE melchizedek_schema_version ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON melchizedek_schema_version FROM anon, authenticated';
  END IF;
END $$;

-- Agent registry (adk_agent_registry). Guarded the same way: the table
-- only exists in deployments that boot syndicates with `registry:<id>`.
-- Read exposure leaks every system prompt; write exposure is agent takeover.
DO $$
BEGIN
  IF to_regclass('public.adk_agent_registry') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE adk_agent_registry ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON adk_agent_registry FROM anon, authenticated';
  END IF;
  -- The memory processed marker (migration 0007): identifiers only.
  IF to_regclass('public.melchizedek_memory_ingest') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE melchizedek_memory_ingest ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON melchizedek_memory_ingest FROM anon, authenticated';
  END IF;
  -- Its history (migration 0005): every definition an id has held.
  IF to_regclass('public.adk_agent_registry_versions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE adk_agent_registry_versions ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON adk_agent_registry_versions FROM anon, authenticated';
  END IF;
END $$;

-- ── FUNCTIONS: no API role may execute them ──────────────────────────────
-- Postgres grants EXECUTE on every new function to PUBLIC, and anon and
-- authenticated inherit PUBLIC — so revoking from those two roles BY NAME
-- alone would leave the PUBLIC grant in force. Two
-- of these are SECURITY DEFINER (they bypass RLS): through the anon key,
-- match_turns would read stored conversations and the prune functions would
-- delete the ledger and sessions. Revoke from PUBLIC as well, then grant
-- back to service_role only (the server's role; it is not a superuser and
-- would otherwise lose access too).
--
-- Every overload of every melchizedek function is covered by name, so this
-- works on any schema version.
DO $$
DECLARE
  fn regprocedure;
  has_service_role boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('match_memory_facts', 'match_turns', 'melchizedek_prune_telemetry',
                        'melchizedek_prune_sessions', 'melchizedek_rls_status',
                        'melchizedek_erase_scope', 'melchizedek_usage_add', 'melchizedek_prune_usage',
                        'melchizedek_registry_hash', 'melchizedek_registry_record',
                        'melchizedek_registry_versions_immutable', 'melchizedek_registry_publish',
                        'melchizedek_registry_activate', 'melchizedek_memory_commit',
                        'melchizedek_memory_dimensions', 'melchizedek_prune_memory_ingest',
                        'melchizedek_prune_memory')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    IF has_service_role THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;
END $$;

-- ── Boot-time verification hook ──────────────────────────────────────────
-- The server calls this to confirm hardening is applied. SECURITY DEFINER
-- so it can read pg_class regardless of caller privileges; it exposes
-- nothing but two booleans.
CREATE OR REPLACE FUNCTION melchizedek_rls_status()
RETURNS TABLE(table_name text, rls_enabled boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.relname::text, c.relrowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('adk_memory_facts', 'adk_sessions', 'adk_telemetry',
                      'adk_turns', 'adk_payloads', 'adk_verdicts', 'adk_labels',
                      'adk_agent_registry', 'adk_agent_registry_versions',
                      'adk_session_events', 'adk_a2a_tasks', 'melchizedek_usage',
                      'melchizedek_memory_ingest');
$$;

REVOKE ALL ON FUNCTION melchizedek_rls_status() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION melchizedek_rls_status() TO service_role;
  END IF;
END $$;

-- Verify (each must return false):
--   SELECT has_function_privilege('anon', 'match_turns(vector,integer,timestamptz,text,text,boolean)', 'EXECUTE');
--   SELECT has_function_privilege('anon', 'melchizedek_prune_telemetry(integer)', 'EXECUTE');
--   SELECT has_function_privilege('anon', 'melchizedek_prune_sessions()', 'EXECUTE');

-- ── Tier 2 (optional, for sensitive deployments): constrain the server ───
-- Left commented out because it requires an application change: the server
-- must connect as this role (direct Postgres connection string, not the
-- service_role REST client) and set `app.user_key` per transaction:
--
--   SET LOCAL app.user_key = 'melchizedek-a2a/a2a-<keyhash>/<userId>';
--
-- With that in place, even buggy application code cannot read or delete
-- another silo's rows — the database refuses.
--
-- CREATE ROLE melchizedek_app LOGIN PASSWORD '<strong-password>';
-- GRANT USAGE ON SCHEMA public TO melchizedek_app;
-- GRANT SELECT, INSERT, DELETE ON adk_memory_facts TO melchizedek_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON adk_sessions TO melchizedek_app;
--
-- CREATE POLICY memory_silo ON adk_memory_facts
--   FOR ALL TO melchizedek_app
--   USING (user_key = current_setting('app.user_key', true))
--   WITH CHECK (user_key = current_setting('app.user_key', true));
--
-- CREATE POLICY session_silo ON adk_sessions
--   FOR ALL TO melchizedek_app
--   USING (user_id = split_part(current_setting('app.user_key', true), '/', 2))
--   WITH CHECK (user_id = split_part(current_setting('app.user_key', true), '/', 2));
```
<!-- /wiki:generated -->

<!-- wiki:generated section="memory-ddl" source="db/memory_v2.sql" -->
## Upgrade path for databases created before the migrations

```sql
-- ============================================================================
-- memory_v2.sql — structured memory records for adk_memory_facts
--
-- An upgrade for a database created before the numbered migrations in
-- db/migrations/ (a fresh install gets these columns from them). Idempotent;
-- safe to re-run. Existing rows survive: old facts get
-- status 'active', empty keys, and NULL tag/date/source — they keep working
-- as plain semantic memories.
--
-- What this adds:
--   * structured columns: tag, fact_date, source, status, keys, superseded_by
--   * indexes for the two non-semantic recall channels (keys, dates)
--   * match_memory_facts v2 — same call signature, now returns the
--     structured columns so the service can re-rank and relabel.
-- ============================================================================

-- 1. Structured record columns
ALTER TABLE adk_memory_facts
  ADD COLUMN IF NOT EXISTS tag TEXT,
  ADD COLUMN IF NOT EXISTS fact_date DATE,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS keys TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS superseded_by UUID;

-- 2. Recall-channel indexes: entity keys (GIN) and dates (btree, per user)
CREATE INDEX IF NOT EXISTS adk_memory_facts_keys_idx
  ON adk_memory_facts USING gin (keys);
CREATE INDEX IF NOT EXISTS adk_memory_facts_date_idx
  ON adk_memory_facts (user_key, fact_date);

-- 3. match_memory_facts v2 — drop every prior signature first (Postgres
--    overloads functions by argument list; leaving an old one creates an
--    ambiguous call).
DROP FUNCTION IF EXISTS match_memory_facts(vector, int, text);
DROP FUNCTION IF EXISTS match_memory_facts(vector, text, int);

CREATE OR REPLACE FUNCTION match_memory_facts (
  query_embedding vector(768),
  filter_user_key text,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id UUID,
  user_key TEXT,
  fact TEXT,
  tag TEXT,
  fact_date DATE,
  source TEXT,
  status TEXT,
  keys TEXT[],
  created_at TIMESTAMPTZ,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF filter_user_key IS NULL THEN
    RAISE EXCEPTION 'filter_user_key is required';
  END IF;
  RETURN QUERY
  SELECT
    adk_memory_facts.id,
    adk_memory_facts.user_key,
    adk_memory_facts.fact,
    adk_memory_facts.tag,
    adk_memory_facts.fact_date,
    adk_memory_facts.source,
    adk_memory_facts.status,
    adk_memory_facts.keys,
    adk_memory_facts.created_at,
    1 - (adk_memory_facts.embedding <=> query_embedding) AS similarity
  FROM adk_memory_facts
  WHERE adk_memory_facts.user_key = filter_user_key
  ORDER BY adk_memory_facts.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```
<!-- /wiki:generated -->

How the pipeline uses these tables: [memory architecture](/memory/architecture.md).
