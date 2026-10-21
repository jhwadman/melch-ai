-- ============================================================================
-- 0018_queue_view — the job queue as an operator reads it (ADR 0021, 0113)
-- ============================================================================
-- A read model over melchizedek_tasks (migration 0009, checkpoint columns
-- from 0014): one row per background job, with what an operator asks of a
-- queue — is it stuck, how often was it tried, why did it fail. Todo items
-- are not jobs and are left out. Nothing is stored; the view reads the
-- table as it stands.
--
--   owner          the list the job belongs to (the caller's scope key;
--                  '' for a shared list)
--   id             the job's id within that list (t1, t2, …)
--   title          the job's title as queued (user text)
--   status         queued | running | done | failed | cancelled
--   attempts       claims so far (a claim counts one, a retry resets it)
--   retries        attempts beyond the first: GREATEST(attempts - 1, 0)
--   max_attempts   the claims a job gets before an interruption fails it
--                  (MAX_ATTEMPTS in lib/tools/taskTools.ts)
--   dead_lettered  true when the job failed and will not run again unless
--                  someone retries it (status 'failed')
--   last_error     the error the job failed with, or why it was not retried
--                  (cut at 1,000 characters when written)
--   lease_owner    the worker holding a running job, and lease_until when
--                  its claim runs out: a running job whose lease is past is
--                  stuck until the next recover()
--   has_checkpoint whether a resumable checkpoint is kept (running or
--                  queued only), and checkpoint_at when it was saved
--   created_at, started_at, finished_at, updated_at
--
-- Retry a dead-lettered or cancelled job with postgresStorage().retryTask
-- (owner, id), the same rule task_update's `queued` applies. The view has
-- the table's owner's privileges where security_invoker is not available
-- (Postgres < 15), so it is revoked from the API roles here and in
-- db/hardening.sql, like the table. Idempotent; safe to re-run.
-- ============================================================================

CREATE OR REPLACE VIEW melchizedek_task_queue AS
  SELECT
    t.owner,
    t.id,
    t.record->>'title'                                        AS title,
    t.status,
    COALESCE((t.record->>'attempts')::int, 0)                 AS attempts,
    GREATEST(COALESCE((t.record->>'attempts')::int, 0) - 1, 0) AS retries,
    2                                                         AS max_attempts,
    (t.status = 'failed')                                     AS dead_lettered,
    t.record->>'error'                                        AS last_error,
    t.lease_owner,
    t.lease_until,
    (t.checkpoint IS NOT NULL)                                AS has_checkpoint,
    t.checkpoint_at,
    (t.record->>'created_at')::timestamptz                    AS created_at,
    (t.record->>'started_at')::timestamptz                    AS started_at,
    (t.record->>'finished_at')::timestamptz                   AS finished_at,
    t.updated_at
  FROM melchizedek_tasks t
  WHERE t.kind = 'background';

COMMENT ON VIEW melchizedek_task_queue IS
  'Background jobs as an operator reads them: status, attempts, retries, dead_lettered, last_error, lease and checkpoint. Retry with postgresStorage().retryTask(owner, id). Migration 0018.';

-- Postgres 15+: the view reads with the querying role's rights.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'ALTER VIEW melchizedek_task_queue SET (security_invoker = true)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON melchizedek_task_queue FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON melchizedek_task_queue FROM authenticated';
  END IF;
END $$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (18, '0018_queue_view')
ON CONFLICT (version) DO NOTHING;
