-- ============================================================================
-- 0006_task_leases — a running A2A task belongs to a live instance (ADR 0021)
-- ============================================================================
-- An instance that saves a task while it is still running (submitted or
-- working) stamps it with its own id and a lease deadline, and renews the
-- lease while the task runs. A final state clears it. When an instance dies
-- mid-task its leases stop being renewed; any instance then finds the task
-- with an expired lease and marks it failed, instead of a client polling a
-- task that will never finish. A task waiting on its client (input-required)
-- holds no lease: nothing is running it.
-- Idempotent; safe to re-run.
-- ============================================================================

ALTER TABLE adk_a2a_tasks ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE adk_a2a_tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

-- Only leased rows are ever scanned for expiry.
CREATE INDEX IF NOT EXISTS adk_a2a_tasks_lease_idx
  ON adk_a2a_tasks (lease_until) WHERE lease_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS adk_a2a_tasks_lease_owner_idx
  ON adk_a2a_tasks (lease_owner) WHERE lease_owner IS NOT NULL;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (6, '0006_task_leases')
ON CONFLICT (version) DO NOTHING;
