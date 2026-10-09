-- ============================================================================
-- 0014_durable_runs — long runs survive a restart and stop when cancelled
--                     (ADR 0113, extends ADR 0015)
-- ============================================================================
-- Two additions, both nullable columns on tables earlier migrations create:
--
--   melchizedek_tasks.checkpoint, checkpoint_at  (table from 0009)
--     A background job's latest step checkpoint, written by the worker that
--     holds the job's lease while it runs. It is kept BESIDE `record`, never
--     inside it, so task_get and task_list never show it. It survives only
--     while the job is `running` or `queued`: a job re-queued after its
--     worker died keeps it, and the next claim resumes from it; any other
--     status (done, failed, cancelled) clears it, and a pruned or erased
--     record takes it along.
--
--   adk_a2a_tasks.cancel_requested_at  (table from 0003, leases from 0006)
--     A cancel that reaches an instance not running the A2A task is recorded
--     here; the running instance's lease heartbeat sees it and aborts the
--     run, so cancel works across replicas.
--
-- No new table, so RLS and grants are unchanged. Idempotent; safe to re-run.
-- ============================================================================

ALTER TABLE melchizedek_tasks ADD COLUMN IF NOT EXISTS checkpoint JSONB;
ALTER TABLE melchizedek_tasks ADD COLUMN IF NOT EXISTS checkpoint_at TIMESTAMPTZ;

ALTER TABLE adk_a2a_tasks ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (14, '0014_durable_runs')
ON CONFLICT (version) DO NOTHING;
