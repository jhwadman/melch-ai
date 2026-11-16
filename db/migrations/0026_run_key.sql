-- ============================================================================
-- 0026_run_key — the ledger ties a program's run to its steps and its turns
--                (ADR 0159, extends ADR 0139)
-- ============================================================================
-- A run is a trace of steps (spans named `step.execute <name>`, kind 'step'
-- in adk_telemetry; the root step has no parent). Every turn stays a trace
-- of its own and names the run that started it:
--   adk_telemetry.run_id        the run a span belongs to: on each step, and
--                               on a model call made directly under one
--                               (an llm.request outside any turn). NULL on a
--                               turn's own spans.
--   adk_turns.run_id            the run that started the turn
--   adk_turns.run_step_span_id  the step of that run that was active when
--                               the turn started: a span_id in the run's
--                               trace, so a row of adk_telemetry
-- The run id is the caller's own (a date, a job id) or a UUID. All three are
-- NULL outside a run and on every row written before 0026. The partial
-- indexes hold only rows that are in a run.
--
-- `kind` is plain TEXT with no check constraint (0016), so 'step' needs no
-- change to it.
--
-- The ledger tables are optional: db/telemetry.sql creates them, after the
-- migrations, and adds the same columns for a fresh install. This migration
-- upgrades a ledger that already exists in place, and does nothing where
-- there is none. An identifier a caller chose and a span id: no content of a
-- turn. Idempotent; safe to re-run.
-- ============================================================================

DO $run_key$
BEGIN
  IF to_regclass('public.adk_turns') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS run_id           TEXT';
    EXECUTE 'ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS run_step_span_id TEXT';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_adk_turns_run ON adk_turns (run_id, ts) WHERE run_id IS NOT NULL';
  END IF;
  IF to_regclass('public.adk_telemetry') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS run_id TEXT';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_adk_telemetry_run ON adk_telemetry (run_id, ts) WHERE run_id IS NOT NULL';
  END IF;
END
$run_key$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (26, '0026_run_key')
ON CONFLICT (version) DO NOTHING;
