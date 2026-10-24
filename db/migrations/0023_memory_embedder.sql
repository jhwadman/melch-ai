-- ============================================================================
-- 0023_memory_embedder — the one embedding model a memory store's vectors
--                        come from (ADR 0147)
-- ============================================================================
-- Every vector in adk_memory_facts must come from one model: a different
-- model at the same dimension passes the size check (0007's
-- melchizedek_memory_dimensions) and quietly degrades recall. This table
-- holds one row: the provider, model and dimension the store was first
-- written with. The memory service records it on its first successful
-- insert and refuses, at start, an embedder whose model differs
-- (lib/memory/supabaseMemoryService.ts); switching models means re-embedding
-- the stored facts, never a silent change.
--
-- A gateway's spelling of the same model (google/gemini-embedding-001 for
-- gemini-embedding-001) is the same model: the service compares the last
-- path segment. Two functions serve the Supabase REST path, which reaches
-- tables through RPC here (0007's convention):
--   melchizedek_memory_embedder()                  the row, or none
--   melchizedek_memory_record_embedder(p, m, d)    record it once; a later
--                                                  call changes nothing
--   melchizedek_memory_set_embedder(p, m, d)       overwrite it: what a
--                                                  completed re-embed writes
--                                                  (lib/memory/reembed.ts)
-- Nothing secret, nothing personal. Idempotent; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS melchizedek_memory_embedder (
  one          BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (one),
  provider     TEXT        NOT NULL,
  model        TEXT        NOT NULL,
  dimensions   INTEGER     NOT NULL CHECK (dimensions > 0),
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION melchizedek_memory_embedder()
RETURNS TABLE (provider text, model text, dimensions integer, recorded_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT provider, model, dimensions, recorded_at FROM melchizedek_memory_embedder WHERE one;
$$;

CREATE OR REPLACE FUNCTION melchizedek_memory_record_embedder(p_provider text, p_model text, p_dimensions integer)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO melchizedek_memory_embedder (one, provider, model, dimensions)
  VALUES (TRUE, p_provider, p_model, p_dimensions)
  ON CONFLICT (one) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION melchizedek_memory_set_embedder(p_provider text, p_model text, p_dimensions integer)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO melchizedek_memory_embedder (one, provider, model, dimensions, recorded_at)
  VALUES (TRUE, p_provider, p_model, p_dimensions, now())
  ON CONFLICT (one) DO UPDATE SET provider = EXCLUDED.provider, model = EXCLUDED.model, dimensions = EXCLUDED.dimensions, recorded_at = now();
$$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (23, '0023_memory_embedder')
ON CONFLICT (version) DO NOTHING;
