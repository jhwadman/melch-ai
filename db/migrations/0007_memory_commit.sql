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
