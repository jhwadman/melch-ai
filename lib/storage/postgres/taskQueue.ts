/**
 * lib/storage/postgres/taskQueue.ts — the task tools' TaskBackend on
 * Postgres (migrations 0009 and 0014, ADR 0021, ADR 0113).
 *
 * Every rule stays in lib/tools/taskTools.ts and runs on a TaskStore
 * snapshot; this file only loads one owner's snapshot and writes the change
 * back, atomically:
 *
 *   mutate  locks the owner's counter row, then that owner's task rows
 *           (FOR UPDATE), runs the change, and writes only what changed.
 *           A worker's claim and a mutate on the same job therefore never
 *           interleave: the claim skips a row a mutate holds, and a mutate
 *           waits for a claim in flight, then reads its result.
 *   claim   takes the oldest queued background job of ANY owner with
 *           FOR UPDATE SKIP LOCKED, so two workers never take one job, and
 *           leases it to the worker until the lease runs out.
 *   renew   extends the lease while the job is still this worker's and
 *           running; resolves false otherwise, so the worker stops the run
 *           (a task_update cancel of a running job lands here).
 *   recover finds running jobs whose lease ran out (the worker died) and
 *           applies the same interrupted-job rule the file store uses. It
 *           never touches a queued job or a running one whose lease is live.
 *
 * Checkpoints (ADR 0113): a running job's latest step checkpoint is the
 * `checkpoint` column beside `record`, never inside it, so the tools never
 * read it. Only the worker holding the lease writes it (saveCheckpoint). It
 * survives while the job is running or queued: recover's requeue keeps it,
 * so the next claim resumes from it, and claimNext leaves it; a mutate that
 * moves the job to any other status, or recover failing it, clears it; a
 * deleted row takes it along. A checkpoint whose JSON is above the cap
 * (TaskBackendOptions.checkpointMaxBytes, default 5 MiB) is not written:
 * the column keeps the previous one, the save still reports the claim, and
 * one line names the job id and the sizes.
 */
import type { Pool, PoolClient } from 'pg';

import { applyFinish, applyInterrupted, checkpointJson } from '../../tools/taskTools.ts';
import type { JobOutcome, OwnedTask, TaskBackend, TaskBackendOptions, TaskRecord, TaskStore, WorkerLease } from '../../tools/taskTools.ts';

const seqOf = (id: string) => Number(id.slice(1)) || 0;

async function loadOwner(db: Pool | PoolClient, owner: string, lock: boolean): Promise<TaskStore> {
  const head = await db.query(`SELECT next_id FROM melchizedek_task_owners WHERE owner = $1${lock ? ' FOR UPDATE' : ''}`, [owner]);
  const rows = await db.query(
    `SELECT record FROM melchizedek_tasks WHERE owner = $1 ORDER BY seq${lock ? ' FOR UPDATE' : ''}`,
    [owner],
  );
  return { version: 1, next_id: head.rows[0]?.next_id ?? 1, tasks: rows.rows.map((r) => r.record as TaskRecord) };
}

async function inTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await run(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The task backend on `pool`; `options` caps the checkpoint a save stores (TaskBackendOptions). */
export function postgresTaskBackend(pool: Pool, options: TaskBackendOptions = {}): TaskBackend {
  return {
    read: (owner) => loadOwner(pool, owner, false),

    async mutate(owner, change) {
      return inTransaction(pool, async (client) => {
        await client.query('INSERT INTO melchizedek_task_owners (owner) VALUES ($1) ON CONFLICT (owner) DO NOTHING', [owner]);
        const store = await loadOwner(client, owner, true);
        const before = new Map(store.tasks.map((t) => [t.id, JSON.stringify(t)]));
        const out = change(store);
        const after = new Set(store.tasks.map((t) => t.id));
        for (const id of before.keys()) {
          if (!after.has(id)) await client.query('DELETE FROM melchizedek_tasks WHERE owner = $1 AND id = $2', [owner, id]);
        }
        for (const t of store.tasks) {
          if (before.get(t.id) === JSON.stringify(t)) continue;
          // Leaving `running` ends the job's lease; staying in it keeps it.
          // A checkpoint survives only in running or queued.
          await client.query(
            `INSERT INTO melchizedek_tasks (owner, id, seq, kind, status, record, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
             ON CONFLICT (owner, id) DO UPDATE
               SET kind = EXCLUDED.kind, status = EXCLUDED.status, record = EXCLUDED.record, updated_at = NOW(),
                   lease_owner = CASE WHEN EXCLUDED.status = 'running' THEN melchizedek_tasks.lease_owner END,
                   lease_until = CASE WHEN EXCLUDED.status = 'running' THEN melchizedek_tasks.lease_until END,
                   checkpoint = CASE WHEN EXCLUDED.status IN ('running', 'queued') THEN melchizedek_tasks.checkpoint END,
                   checkpoint_at = CASE WHEN EXCLUDED.status IN ('running', 'queued') THEN melchizedek_tasks.checkpoint_at END`,
            [owner, t.id, seqOf(t.id), t.kind, t.status, JSON.stringify(t)],
          );
        }
        await client.query('UPDATE melchizedek_task_owners SET next_id = $2 WHERE owner = $1', [owner, store.next_id]);
        return out;
      });
    },

    async claimNext(worker: WorkerLease): Promise<OwnedTask | null> {
      const stamp = new Date().toISOString();
      const r = await pool.query(
        `WITH next AS (
           SELECT owner, id FROM melchizedek_tasks
            WHERE kind = 'background' AND status = 'queued'
            ORDER BY seq, owner LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         UPDATE melchizedek_tasks t
            SET status = 'running',
                lease_owner = $1,
                lease_until = NOW() + ($2::int * interval '1 millisecond'),
                updated_at = NOW(),
                record = t.record || jsonb_build_object(
                  'status', 'running',
                  'attempts', COALESCE((t.record->>'attempts')::int, 0) + 1,
                  'started_at', $3::text,
                  'updated_at', $3::text)
           FROM next
          WHERE t.owner = next.owner AND t.id = next.id
          RETURNING t.owner, t.record`,
        [worker.workerId, worker.leaseMs, stamp],
      );
      const row = r.rows[0];
      return row ? { ...(row.record as TaskRecord), owner: row.owner as string } : null;
    },

    async renew(worker, job) {
      const r = await pool.query(
        `UPDATE melchizedek_tasks SET lease_until = NOW() + ($4::int * interval '1 millisecond')
          WHERE owner = $1 AND id = $2 AND lease_owner = $3 AND status = 'running'`,
        [job.owner, job.id, worker.workerId, worker.leaseMs],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async saveCheckpoint(worker, job, checkpoint) {
      const json = checkpointJson(job, checkpoint, options);
      if (json === null) {
        // Over the cap: the previous checkpoint is kept; the answer is still whether the claim holds.
        const held = await pool.query(
          `SELECT 1 FROM melchizedek_tasks WHERE owner = $1 AND id = $2 AND lease_owner = $3 AND status = 'running'`,
          [job.owner, job.id, worker.workerId],
        );
        return (held.rowCount ?? 0) > 0;
      }
      const r = await pool.query(
        `UPDATE melchizedek_tasks SET checkpoint = $4::jsonb, checkpoint_at = NOW()
          WHERE owner = $1 AND id = $2 AND lease_owner = $3 AND status = 'running'`,
        [job.owner, job.id, worker.workerId, json],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async loadCheckpoint(job) {
      const r = await pool.query(
        `SELECT checkpoint FROM melchizedek_tasks
          WHERE owner = $1 AND id = $2 AND status IN ('running', 'queued')`,
        [job.owner, job.id],
      );
      return (r.rows[0]?.checkpoint as object | null | undefined) ?? null;
    },

    async finish(job: OwnedTask, outcome: JobOutcome) {
      await this.mutate(job.owner, (store) => applyFinish(store, job.id, outcome));
    },

    async recover() {
      return inTransaction(pool, async (client) => {
        const r = await client.query(
          `SELECT owner, id, record FROM melchizedek_tasks
            WHERE status = 'running' AND (lease_until IS NULL OR lease_until < NOW())
            FOR UPDATE SKIP LOCKED`,
        );
        const requeued: string[] = [];
        const failed: string[] = [];
        for (const row of r.rows) {
          const t = row.record as TaskRecord;
          const outcome = applyInterrupted(t);
          (outcome === 'failed' ? failed : requeued).push(`${row.owner || '(shared)'}:${t.id}`);
          // Requeued keeps the checkpoint (the next claim resumes); failed clears it.
          await client.query(
            `UPDATE melchizedek_tasks SET status = $3, record = $4::jsonb, updated_at = NOW(), lease_owner = NULL, lease_until = NULL,
                    checkpoint = CASE WHEN $3::text = 'queued' THEN checkpoint END,
                    checkpoint_at = CASE WHEN $3::text = 'queued' THEN checkpoint_at END
              WHERE owner = $1 AND id = $2`,
            [row.owner, row.id, t.status, JSON.stringify(t)],
          );
        }
        return { requeued, failed };
      });
    },
  };
}
