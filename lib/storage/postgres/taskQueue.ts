/**
 * lib/storage/postgres/taskQueue.ts — the task tools' TaskBackend on
 * Postgres (migration 0009, ADR 0021).
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
 *   recover finds running jobs whose lease ran out (the worker died) and
 *           applies the same interrupted-job rule the file store uses.
 */
import type { Pool, PoolClient } from 'pg';

import { applyFinish, applyInterrupted } from '../../tools/taskTools.ts';
import type { JobOutcome, OwnedTask, TaskBackend, TaskRecord, TaskStore, WorkerLease } from '../../tools/taskTools.ts';

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

export function postgresTaskBackend(pool: Pool): TaskBackend {
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
          await client.query(
            `INSERT INTO melchizedek_tasks (owner, id, seq, kind, status, record, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
             ON CONFLICT (owner, id) DO UPDATE
               SET kind = EXCLUDED.kind, status = EXCLUDED.status, record = EXCLUDED.record, updated_at = NOW(),
                   lease_owner = CASE WHEN EXCLUDED.status = 'running' THEN melchizedek_tasks.lease_owner END,
                   lease_until = CASE WHEN EXCLUDED.status = 'running' THEN melchizedek_tasks.lease_until END`,
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
      await pool.query(
        `UPDATE melchizedek_tasks SET lease_until = NOW() + ($4::int * interval '1 millisecond')
          WHERE owner = $1 AND id = $2 AND lease_owner = $3 AND status = 'running'`,
        [job.owner, job.id, worker.workerId, worker.leaseMs],
      );
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
          await client.query(
            `UPDATE melchizedek_tasks SET status = $3, record = $4::jsonb, updated_at = NOW(), lease_owner = NULL, lease_until = NULL
              WHERE owner = $1 AND id = $2`,
            [row.owner, row.id, t.status, JSON.stringify(t)],
          );
        }
        return { requeued, failed };
      });
    },
  };
}
