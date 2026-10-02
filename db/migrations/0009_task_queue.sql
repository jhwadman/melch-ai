-- ============================================================================
-- 0009_task_queue — the task tools' list and job queue on Postgres (ADR 0021)
-- ============================================================================
-- The task tools (lib/tools/taskTools.ts) keep a user's small tasks and a
-- queue of background jobs. On Postgres each caller has its own list (owner
-- = the caller the tool call carries, the A2A server's scope key), and any
-- number of workers take jobs with FOR UPDATE SKIP LOCKED: a job is claimed
-- once, leased to its worker and renewed while it runs; a job whose worker
-- died is queued again, or failed after its attempts run out.
--
-- `record` is the whole task as the tools see it; kind and status are
-- repeated as columns for the queue's index. Ids are per owner (t1, t2…),
-- numbered from melchizedek_task_owners, whose row a change locks first.
-- Idempotent; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS melchizedek_task_owners (
  owner   TEXT    PRIMARY KEY,
  next_id INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS melchizedek_tasks (
  owner       TEXT        NOT NULL,
  id          TEXT        NOT NULL,
  seq         INTEGER     NOT NULL,
  kind        TEXT        NOT NULL,
  status      TEXT        NOT NULL,
  record      JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  PRIMARY KEY (owner, id)
);
-- The queue: oldest queued background job first.
CREATE INDEX IF NOT EXISTS idx_melchizedek_tasks_queued
  ON melchizedek_tasks (seq) WHERE kind = 'background' AND status = 'queued';
CREATE INDEX IF NOT EXISTS idx_melchizedek_tasks_lease
  ON melchizedek_tasks (lease_until) WHERE lease_until IS NOT NULL;

ALTER TABLE melchizedek_task_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE melchizedek_tasks ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON melchizedek_task_owners, melchizedek_tasks FROM anon, authenticated';
  END IF;
END $$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (9, '0009_task_queue')
ON CONFLICT (version) DO NOTHING;
