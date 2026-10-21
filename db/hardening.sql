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

-- ── The API roles ────────────────────────────────────────────────────────
-- anon and authenticated are Supabase's PostgREST roles. Plain Postgres and
-- embedded Postgres (PGlite) have no REST API and normally no such roles;
-- there, the PUBLIC revokes and RLS below are the whole lockdown, and the
-- revokes by role name are skipped rather than failing. These two helpers
-- live in pg_temp: they exist for this session only and leave nothing behind.
CREATE OR REPLACE FUNCTION pg_temp.melchizedek_api_roles() RETURNS text
LANGUAGE sql AS $$
  SELECT string_agg(quote_ident(rolname), ', ' ORDER BY rolname)
  FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
$$;

CREATE OR REPLACE FUNCTION pg_temp.melchizedek_revoke_api(target text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE roles text := pg_temp.melchizedek_api_roles();
BEGIN
  IF roles IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON %s FROM %s', target, roles);
  END IF;
END $$;

-- ── Tier 1: lock the public API paths ────────────────────────────────────

-- Enable RLS. With RLS on and NO policies defined, anon/authenticated get
-- deny-by-default. service_role is unaffected (it bypasses RLS).
ALTER TABLE adk_memory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE adk_sessions     ENABLE ROW LEVEL SECURITY;

-- Belt and suspenders: also revoke the default table privileges from the
-- API roles, so even a future accidentally-created permissive policy
-- cannot re-expose the tables.
DO $$
BEGIN
  PERFORM pg_temp.melchizedek_revoke_api('adk_memory_facts');
  PERFORM pg_temp.melchizedek_revoke_api('adk_sessions');
END $$;

-- Optional observability ledger (db/telemetry.sql). Guarded: the tables only
-- exist when the operator opted into TELEMETRY_SUPABASE. adk_turns holds
-- user input and output, adk_payloads full prompts — same lockdown as the
-- transcript tables, for the same reason.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['adk_telemetry', 'adk_turns', 'adk_payloads', 'adk_verdicts', 'adk_labels',
                            'adk_session_events', 'adk_a2a_tasks', 'melchizedek_usage', 'melchizedek_audit',
                            'model_pricing'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      PERFORM pg_temp.melchizedek_revoke_api(format('%I', t));
    END IF;
  END LOOP;
  -- The production view and the retention function read/delete those
  -- tables on behalf of the caller; neither belongs on the public API.
  -- So does the job queue's read model (migration 0018).
  FOREACH t IN ARRAY ARRAY['adk_turns_production', 'adk_kpi_daily', 'adk_kpi_routes_daily', 'adk_kpi_judges_daily', 'adk_kpi_hourly',
                            'melchizedek_task_queue'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      PERFORM pg_temp.melchizedek_revoke_api(format('%I', t));
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
    PERFORM pg_temp.melchizedek_revoke_api('melchizedek_schema_version');
  END IF;
END $$;

-- Agent registry (adk_agent_registry). Guarded the same way: the table
-- only exists in deployments that boot syndicates with `registry:<id>`.
-- Read exposure leaks every system prompt; write exposure is agent takeover.
DO $$
BEGIN
  IF to_regclass('public.adk_agent_registry') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE adk_agent_registry ENABLE ROW LEVEL SECURITY';
    PERFORM pg_temp.melchizedek_revoke_api('adk_agent_registry');
  END IF;
  -- The task tools' lists and job queue (migration 0009).
  IF to_regclass('public.melchizedek_tasks') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE melchizedek_tasks ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE melchizedek_task_owners ENABLE ROW LEVEL SECURITY';
    PERFORM pg_temp.melchizedek_revoke_api('melchizedek_tasks, melchizedek_task_owners');
  END IF;
  -- The memory processed marker (migration 0007): identifiers only.
  IF to_regclass('public.melchizedek_memory_ingest') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE melchizedek_memory_ingest ENABLE ROW LEVEL SECURITY';
    PERFORM pg_temp.melchizedek_revoke_api('melchizedek_memory_ingest');
  END IF;
  -- Third-party tokens held for tools (migration 0013): ciphertext only,
  -- still nothing an API role should read.
  IF to_regclass('public.melchizedek_tool_credentials') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE melchizedek_tool_credentials ENABLE ROW LEVEL SECURITY';
    PERFORM pg_temp.melchizedek_revoke_api('melchizedek_tool_credentials');
  END IF;
  -- Its history (migration 0005): every definition an id has held.
  IF to_regclass('public.adk_agent_registry_versions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE adk_agent_registry_versions ENABLE ROW LEVEL SECURITY';
    PERFORM pg_temp.melchizedek_revoke_api('adk_agent_registry_versions');
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
                        'melchizedek_prune_memory', 'melchizedek_prune_audit',
                        'melchizedek_cost_usd', 'melchizedek_usage_cost', 'melchizedek_usage_text_cost',
                        'melchizedek_turns_cost', 'melchizedek_telemetry_cost')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    PERFORM pg_temp.melchizedek_revoke_api(format('FUNCTION %s', fn));
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
                      'melchizedek_memory_ingest', 'melchizedek_tasks', 'melchizedek_task_owners',
                      'melchizedek_audit', 'melchizedek_tool_credentials');
$$;

REVOKE ALL ON FUNCTION melchizedek_rls_status() FROM PUBLIC;
DO $$
BEGIN
  PERFORM pg_temp.melchizedek_revoke_api('FUNCTION melchizedek_rls_status()');
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
