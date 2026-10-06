-- ============================================================================
-- 0011_erase_expired.sql — a namespace erase reaches expired conversations
-- ============================================================================
-- melchizedek_erase_scope (0010) found a namespace's conversations through
-- its live adk_sessions rows and erased ledger turns and A2A tasks only for
-- those. Sessions expire after seven idle days (0001) while the ledger keeps
-- turns indefinitely, so a namespace erase (the default for DELETE /memory)
-- left every expired conversation's input, output and tool results behind
-- and reported success.
--
-- Turns and tasks do not record the memory namespace, so a namespace erase
-- now keeps only what provably belongs to ANOTHER namespace: rows whose
-- conversation is still live there. Everything else of the scope goes,
-- including conversations whose sessions have expired, whichever namespace
-- they were in. Erasure errs toward deleting, never toward keeping (0002).
-- An erase without a namespace is unchanged. Idempotent.
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
VALUES (11, '0011_erase_expired')
ON CONFLICT (version) DO NOTHING;
