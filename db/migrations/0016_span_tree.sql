-- ============================================================================
-- 0016_span_tree — the ledger keeps a turn's span tree and its cache tokens
--                  (ADR 0139)
-- ============================================================================
-- adk_telemetry holds one row per span the ledger keeps: the turn's root,
-- each agent run, model step and provider call, tool call, script run and
-- call, workflow walk and node run (lib/observability/lineage.ts
-- ledgerSpanKind). Each row now says where it sits:
--   parent_span_id  the nearest ancestor span the ledger keeps a row for;
--                   NULL for a root, and for every row written before 0016
--   kind            turn | agent | model | tool | script | node; NULL for a
--                   row written before 0016
--   error           the span failed (an error status or code, a tool's error
--                   response); NULL for a row written before 0016
-- The full span (attributes, events, status) stays in `span`.
--
-- Cache tokens, the parts of input_tokens a provider read from or wrote to
-- its prompt cache (lib/models/contract.ts Usage), priced at their own rates
-- by 0017_cache_pricing:
--   adk_telemetry.cache_read_tokens / cache_write_tokens  one call's (an
--       llm.request row), or the turn's sum (a root row)
--   adk_turns.cache_read_tokens / cache_write_tokens      summed over every
--       call of the turn, as a provider bills them
-- NULL where nothing was reported, and on every row written before 0016.
--
-- The ledger tables are optional: db/telemetry.sql creates them, after the
-- migrations, and adds the same columns for a fresh install. This migration
-- upgrades a ledger that already exists in place, and does nothing where
-- there is none. Numbers and span ids only: nothing personal, nothing secret.
-- Idempotent; safe to re-run.
-- ============================================================================

DO $span_tree$
BEGIN
  IF to_regclass('public.adk_telemetry') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS parent_span_id     TEXT';
    EXECUTE 'ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS kind               TEXT';
    EXECUTE 'ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS error              BOOLEAN';
    EXECUTE 'ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS cache_read_tokens  INTEGER';
    EXECUTE 'ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_adk_telemetry_parent ON adk_telemetry (trace_id, parent_span_id)';
  END IF;
  IF to_regclass('public.adk_turns') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS cache_read_tokens  INTEGER';
    EXECUTE 'ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER';
  END IF;
END
$span_tree$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (16, '0016_span_tree')
ON CONFLICT (version) DO NOTHING;
