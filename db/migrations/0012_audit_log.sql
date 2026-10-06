-- ============================================================================
-- 0012_audit_log.sql — an append-only record of who did what, when (ADR 0042)
-- ============================================================================
-- One row per security-relevant event: a failed authentication, a task's
-- outcome, an erasure. The ledger (adk_turns) records what a turn said;
-- this records who asked, how they authenticated, from where, and what
-- happened, which is what an auditor asks for.
--
-- What a row holds: the event, its outcome, the caller's name and auth
-- method, a SHA-256 prefix of the scope (never the scope key itself), the
-- source address, the agent and task ids, and a small detail object. No
-- conversation content, ever.
--
-- Append-only: a trigger refuses UPDATE and DELETE. Rows leave only
-- through melchizedek_prune_audit(days), which removes rows older than the
-- retention period (the source address is personal data; keep it no longer
-- than the evidence needs). TRUNCATE is revoked from every API role. A
-- database superuser can still alter the table; ship the rows to a log
-- store you do not administer when the evidence must survive that.
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS melchizedek_audit (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  event       TEXT NOT NULL,          -- auth.failure | task.end | memory.erase
  outcome     TEXT,                   -- denied | completed | failed | rejected | canceled | input-required | ok
  caller      TEXT,                   -- the authenticated caller's name ('shared-secret', a caller token's name, 'jwt')
  scope_hash  TEXT,                   -- SHA-256 prefix of the scope key; joins rows without naming a user
  source_ip   TEXT,
  agent_id    TEXT,
  task_id     TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS melchizedek_audit_at_idx ON melchizedek_audit (at);
CREATE INDEX IF NOT EXISTS melchizedek_audit_event_idx ON melchizedek_audit (event, at);

CREATE OR REPLACE FUNCTION melchizedek_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- The retention function sets this for its own transaction only.
  IF TG_OP = 'DELETE' AND coalesce(current_setting('melchizedek.audit_prune', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'melchizedek_audit is append-only (% refused); rows leave only through melchizedek_prune_audit', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS melchizedek_audit_append_only ON melchizedek_audit;
CREATE TRIGGER melchizedek_audit_append_only
  BEFORE UPDATE OR DELETE ON melchizedek_audit
  FOR EACH ROW EXECUTE FUNCTION melchizedek_audit_append_only();

-- Retention: delete rows older than p_days (at least 1). Returns the count.
-- SECURITY DEFINER: the API role holds SELECT and INSERT only, so pruning
-- runs with the owner's rights, through this function and nothing else.
CREATE OR REPLACE FUNCTION melchizedek_prune_audit(p_days integer)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n bigint;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    RAISE EXCEPTION 'melchizedek_prune_audit: p_days must be at least 1';
  END IF;
  PERFORM set_config('melchizedek.audit_prune', 'on', true);
  DELETE FROM melchizedek_audit WHERE at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('melchizedek.audit_prune', '', true);
  RETURN n;
END;
$$;

DO $$
BEGIN
  REVOKE ALL ON melchizedek_audit FROM PUBLIC;
  REVOKE ALL ON FUNCTION melchizedek_prune_audit(integer) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON melchizedek_audit FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON melchizedek_audit FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    -- The server appends and reads; nothing else, so no UPDATE, DELETE or TRUNCATE.
    GRANT SELECT, INSERT ON melchizedek_audit TO service_role;
    GRANT EXECUTE ON FUNCTION melchizedek_prune_audit(integer) TO service_role;
  END IF;
END $$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (12, '0012_audit_log')
ON CONFLICT (version) DO NOTHING;
