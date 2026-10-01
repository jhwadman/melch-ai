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
