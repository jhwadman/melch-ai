-- ============================================================================
-- 0025_task_claim_token — every claim on a background job has its own identity
--                         (ADR 0157, extends ADR 0021 and ADR 0113)
-- ============================================================================
-- melchizedek_tasks.claim_token  (table from 0009)
--   Written by claimNext in the statement that takes the job, cleared when
--   the job leaves `running`. lease_owner names a worker process; a worker
--   can claim the same job twice, so only this column tells one claim from
--   the next. Every worker mutation matches it.
--
-- It is kept BESIDE `record`, never inside it, so task_get and task_list
-- never show it, and the operator view melchizedek_task_queue (0018) does not
-- select it. It is a fencing value, not a credential: it grants nothing to
-- anyone who cannot already write this table.
--
-- Nullable, with no backfill: a job an older worker holds has no token, and a
-- worker on this release never adopts it. Old workers do not write this
-- column and do not check it, so the fencing holds only once they are drained
-- (the release notes give the order). No new table, so RLS and grants are
-- unchanged. Idempotent; safe to re-run.
-- ============================================================================

ALTER TABLE melchizedek_tasks ADD COLUMN IF NOT EXISTS claim_token TEXT;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (25, '0025_task_claim_token')
ON CONFLICT (version) DO NOTHING;
