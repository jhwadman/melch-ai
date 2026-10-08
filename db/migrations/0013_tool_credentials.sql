-- ============================================================================
-- 0013_tool_credentials.sql — third-party OAuth tokens held for tools (ADR 0072)
-- ============================================================================
-- A tool that acts for an end user against a third-party API (a calendar, a
-- repository host, a CRM) needs that user's delegated access, not the
-- server's own key. melchizedek_tool_credentials holds one token set per
-- app, end user and provider:
--
--   app_name   the app the run pins (the root syndicate's memory namespace)
--   user_id    the A2A server's scope key, as sessions and tasks store it
--   provider   the provider's name as the tool asks for it ('github')
--   scopes     what the user granted
--   access_token_enc, refresh_token_enc
--              ciphertext only, in the engine's envelope ('mzc1.<key id>.…',
--              AES-256-GCM by default, lib/tools/credentialCipher.ts). The
--              CHECK refuses anything else, so a plaintext token cannot be
--              written by mistake. The key never reaches the database.
--   key_id     which key sealed the row, so a wrong key fails closed by name
--   expires_at when the access token stops working (NULL: not stated)
--   version    bumped by every write; a refresh writes only over the version
--              it read, so two instances refreshing at once keep one result
--
-- The server's role reads and writes it; no API role can (RLS on, grants
-- revoked, as db/hardening.sql repeats). melchizedek_erase_scope is replaced
-- with the 0011 function plus a `credentials` store, so one erase of a user
-- also removes their tokens (ADR 0020 item 7). Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS melchizedek_tool_credentials (
  app_name          TEXT        NOT NULL,
  user_id           TEXT        NOT NULL,
  provider          TEXT        NOT NULL,
  scopes            TEXT[]      NOT NULL DEFAULT '{}',
  access_token_enc  TEXT        NOT NULL CHECK (access_token_enc ~ '^mzc1[.]'),
  refresh_token_enc TEXT                 CHECK (refresh_token_enc IS NULL OR refresh_token_enc ~ '^mzc1[.]'),
  key_id            TEXT        NOT NULL,
  expires_at        TIMESTAMPTZ,
  version           INTEGER     NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refreshed_at      TIMESTAMPTZ,
  PRIMARY KEY (app_name, user_id, provider)
);
-- Erase finds a user's rows across apps.
CREATE INDEX IF NOT EXISTS idx_melchizedek_tool_credentials_user
  ON melchizedek_tool_credentials (user_id);

ALTER TABLE melchizedek_tool_credentials ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  REVOKE ALL ON melchizedek_tool_credentials FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON melchizedek_tool_credentials FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON melchizedek_tool_credentials FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON melchizedek_tool_credentials TO service_role;
  END IF;
END $$;

-- One erase covers the credentials too: the 0011 function, plus the
-- `credentials` store at the end.
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
  kept        text[];
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

  -- With a namespace: the conversations still live in another namespace,
  -- which are the only ones a namespace erase keeps. Sub-agent rows share
  -- their conversation's id, so excluding `contexts` keeps them with it.
  SELECT coalesce(array_agg(DISTINCT substr(s.id, length(s.app_name) + length(s.user_id) + 3)), '{}')
    INTO kept
  FROM adk_sessions s
  WHERE p_namespace IS NOT NULL
    AND (s.user_id = p_scope_key OR (p_include_nested AND s.user_id LIKE nested_like))
    AND s.app_name <> p_namespace
    AND NOT (substr(s.id, length(s.app_name) + length(s.user_id) + 3) = ANY(contexts));

  -- Ledger traces of the turns being erased, collected before anything is deleted.
  IF to_regclass('public.adk_turns') IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce(array_agg(DISTINCT trace_id), '{}') FROM adk_turns
      WHERE (user_id = $1 OR ($2 AND user_id LIKE $3))
        AND ($4 IS NULL OR session_id IS NULL OR NOT (session_id = ANY($5)))
    $q$ INTO traces USING p_scope_key, p_include_nested, nested_like, p_namespace, kept;
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
        AND ($4 IS NULL OR session_id IS NULL OR NOT (session_id = ANY($5)))
    $q$ USING p_scope_key, p_include_nested, nested_like, p_namespace, kept;
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
        AND ($4 IS NULL OR context_id IS NULL OR NOT (context_id = ANY($5)))
    $q$ USING p_scope_key, p_include_nested, nested_like, p_namespace, kept;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'tasks'; deleted := n; RETURN NEXT;

  -- Memory ingestion markers (migration 0007): how far each conversation was
  -- distilled. They carry the scope's key and its conversation ids.
  IF to_regclass('public.melchizedek_memory_ingest') IS NOT NULL THEN
    EXECUTE $q$
      DELETE FROM melchizedek_memory_ingest m
      WHERE ($1 IS NULL OR split_part(m.user_key, '/', 1) = $1)
        AND (substr(m.user_key, strpos(m.user_key, '/') + 1) = $2
             OR ($3 AND substr(m.user_key, strpos(m.user_key, '/') + 1) LIKE $4))
    $q$ USING p_namespace, p_scope_key, p_include_nested, nested_like;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'memory_markers'; deleted := n; RETURN NEXT;

  -- The task tools' list and job queue (migration 0009), per caller across
  -- every syndicate: erased with the whole scope, kept by a namespace erase.
  n := 0;
  IF p_namespace IS NULL AND to_regclass('public.melchizedek_tasks') IS NOT NULL THEN
    EXECUTE $q$
      DELETE FROM melchizedek_tasks WHERE owner = $1 OR ($2 AND owner LIKE $3)
    $q$ USING p_scope_key, p_include_nested, nested_like;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE $q$
      DELETE FROM melchizedek_task_owners WHERE owner = $1 OR ($2 AND owner LIKE $3)
    $q$ USING p_scope_key, p_include_nested, nested_like;
  END IF;
  store := 'task_tools'; deleted := n; RETURN NEXT;

  -- Third-party credentials held for the scope's tools (this migration).
  -- They are filed per app (the memory namespace the run pins), so a
  -- namespace erase removes that app's and keeps the others; an erase
  -- without one removes every app's.
  IF to_regclass('public.melchizedek_tool_credentials') IS NOT NULL THEN
    EXECUTE $q$
      DELETE FROM melchizedek_tool_credentials c
      WHERE ($1 IS NULL OR c.app_name = $1)
        AND (c.user_id = $2 OR ($3 AND c.user_id LIKE $4))
    $q$ USING p_namespace, p_scope_key, p_include_nested, nested_like;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'credentials'; deleted := n; RETURN NEXT;
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
VALUES (13, '0013_tool_credentials')
ON CONFLICT (version) DO NOTHING;
