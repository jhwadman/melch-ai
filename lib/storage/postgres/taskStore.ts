/**
 * lib/storage/postgres/taskStore.ts — the A2A SDK's TaskStore on Postgres.
 *
 * Tasks outlive the process that started them and are visible to every
 * instance, so a client that polls a different replica, or polls after a
 * restart, still finds its task. Each task is filed under the tenant and
 * owner the SDK's own scoping rule derives from the call context (the
 * default resolver reads the authenticated user name), so one caller cannot
 * load or list another's task. `list` mirrors the SDK's InMemoryTaskStore:
 * same filters, same newest-first order, same page-token format.
 *
 * Cancel across replicas (migration 0014, ADR 0113). The SDK cancels a task
 * through its own event bus when the task runs on this instance; otherwise
 * it writes `canceled` into this store itself. When the row is still leased
 * to another live instance, that write also stamps `cancel_requested_at`
 * and leaves the lease with the instance running the task: its heartbeat
 * (`cancelRequestedTasks`) finds the request and aborts the run. From then
 * on the row stays `canceled` — the running instance's later saves renew or
 * clear its lease but never overwrite the state it reported — so a client
 * told `canceled` is never later shown `completed`.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { Role, TaskState } from '@a2a-js/sdk';
import { resolveUserScope } from '@a2a-js/sdk/server';
import type { TaskStore } from '@a2a-js/sdk/server';

type Task = Parameters<TaskStore['save']>[0];
type Context = Parameters<TaskStore['save']>[1];
type ListParams = Parameters<TaskStore['list']>[0];
type ListResult = Awaited<ReturnType<TaskStore['list']>>;

const DEFAULT_PAGE_SIZE = 50;

export interface PostgresTaskStoreOptions {
  /** Owner of a call. Default: the SDK's resolveUserScope (the authenticated user name). */
  ownerResolver?: (context: Context) => string;
  /** Days a task is kept after its last update (expire_at). Default 7. */
  ttlDays?: number;
  /**
   * While a task is running (submitted or working) it is leased to this
   * instance until `ttlMs` from its last save or renewal (migration 0006).
   */
  lease?: TaskLease;
}

export interface TaskLease {
  /** This process's id: what a lease names as its owner. */
  instanceId: string;
  ttlMs: number;
}

/** States in which a task is being worked on by some instance. */
const RUNNING = new Set<number>([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING]);

/** SQL: the stored row is a running task leased to another live instance. */
const HELD_ELSEWHERE = `(adk_a2a_tasks.lease_owner IS NOT NULL
   AND adk_a2a_tasks.lease_owner IS DISTINCT FROM $12::text
   AND adk_a2a_tasks.lease_until > now()
   AND adk_a2a_tasks.state = ANY($14::int[]))`;
/** SQL: this save is a cancel, written by an instance not running the task. */
const CANCEL_FROM_ELSEWHERE = `($6::int = $13::int AND ${HELD_ELSEWHERE})`;
/** SQL: a cancel was reported for the row; its state stays `canceled`. */
const CANCEL_REPORTED = `(adk_a2a_tasks.cancel_requested_at IS NOT NULL AND adk_a2a_tasks.state = $13::int)`;

/**
 * Ids of the running tasks leased to this instance that a caller asked,
 * through another instance, to cancel. The lease heartbeat aborts each.
 */
export async function cancelRequestedTasks(pool: Pool, lease: TaskLease): Promise<string[]> {
  const r = await pool.query(
    `SELECT id FROM adk_a2a_tasks
     WHERE lease_owner = $1 AND lease_until IS NOT NULL AND cancel_requested_at IS NOT NULL`,
    [lease.instanceId],
  );
  return r.rows.map((row) => String(row.id));
}

/** Extends every lease this instance holds. Returns how many it renewed. */
export async function renewTaskLeases(pool: Pool, lease: TaskLease): Promise<number> {
  const r = await pool.query(
    `UPDATE adk_a2a_tasks SET lease_until = now() + ($2::int * interval '1 millisecond')
     WHERE lease_owner = $1 AND lease_until IS NOT NULL`,
    [lease.instanceId, lease.ttlMs],
  );
  return r.rowCount ?? 0;
}

/** The status a task gets when the instance running it is gone. */
const ORPHANED = 'The server running this task stopped before it finished; send the message again.';

/**
 * Marks running tasks whose lease expired (their instance died) as failed,
 * with a message saying so. Any instance may run it: rows are claimed with
 * SKIP LOCKED, so two reapers never fail the same task twice. A task whose
 * cancel was already reported keeps `canceled`: only its lease is cleared.
 * Returns how many it failed.
 */
export async function reapExpiredTasks(pool: Pool, limit = 100): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT tenant, owner, agent_id, id, task, state FROM adk_a2a_tasks
       WHERE lease_until IS NOT NULL AND lease_until < now()
       ORDER BY lease_until LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    let failed = 0;
    for (const row of r.rows) {
      if (!RUNNING.has(Number(row.state))) {
        await client.query(
          `UPDATE adk_a2a_tasks SET lease_owner = NULL, lease_until = NULL, cancel_requested_at = NULL
           WHERE tenant = $1 AND owner = $2 AND agent_id = $3 AND id = $4`,
          [row.tenant, row.owner, row.agent_id, row.id],
        );
        continue;
      }
      failed += 1;
      const task = row.task as { id: string; contextId?: string; status?: unknown };
      const timestamp = new Date().toISOString();
      task.status = {
        state: TaskState.TASK_STATE_FAILED,
        timestamp,
        message: {
          messageId: randomUUID(),
          contextId: task.contextId ?? '',
          taskId: task.id,
          role: Role.ROLE_AGENT,
          parts: [{ content: { $case: 'text', value: ORPHANED }, filename: '', mediaType: 'text/plain' }],
          extensions: [],
          referenceTaskIds: [],
        },
      };
      await client.query(
        `UPDATE adk_a2a_tasks SET task = $5::jsonb, state = $6, status_ts = $7, updated_at = now(),
                lease_owner = NULL, lease_until = NULL, cancel_requested_at = NULL
         WHERE tenant = $1 AND owner = $2 AND agent_id = $3 AND id = $4`,
        [row.tenant, row.owner, row.agent_id, row.id, JSON.stringify(task), TaskState.TASK_STATE_FAILED, timestamp],
      );
    }
    await client.query('COMMIT');
    return failed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function encodePageToken(timestamp: string, id: string): string {
  return Buffer.from(`${timestamp}|${id}`).toString('base64');
}

function decodePageToken(token: string): { timestamp: string; id: string } {
  const [timestamp, ...idParts] = Buffer.from(token, 'base64').toString('utf-8').split('|');
  if (idParts.length === 0) throw new Error('Invalid page token format.');
  return { timestamp, id: idParts.join('|') };
}

export class PostgresTaskStore implements TaskStore {
  private readonly owner: (context: Context) => string;
  private readonly ttlMs: number;
  private readonly pool: Pool;
  private readonly agentId: string;
  private readonly lease?: TaskLease;

  constructor(pool: Pool, agentId: string, options: PostgresTaskStoreOptions = {}) {
    this.pool = pool;
    this.agentId = agentId;
    this.owner = options.ownerResolver ?? (resolveUserScope as (c: Context) => string);
    this.ttlMs = (options.ttlDays ?? 7) * 24 * 60 * 60 * 1000;
    this.lease = options.lease;
  }

  private scope(context: Context): [string, string] {
    return [(context as { tenant?: string }).tenant ?? '', this.owner(context)];
  }

  async save(task: Task, context: Context): Promise<void> {
    const [tenant, owner] = this.scope(context);
    const t = task as { id: string; contextId?: string; status?: { state?: number; timestamp?: string } };
    // A running task is leased to this instance; any other state holds none.
    const leased = !!this.lease && RUNNING.has(t.status?.state ?? -1);
    // On conflict, three cases (see the header): a cancel written by an
    // instance not running the task records the request and leaves the lease
    // where it is; a row whose cancel was reported keeps its content while
    // the running instance renews or clears the lease; anything else is the
    // plain upsert. A pending request survives while the task runs and is
    // cleared when it stops.
    await this.pool.query(
      `INSERT INTO adk_a2a_tasks (tenant, owner, agent_id, id, context_id, state, status_ts, task, updated_at, expire_at, lease_owner, lease_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), $9, $10,
               CASE WHEN $10::text IS NULL THEN NULL ELSE now() + ($11::int * interval '1 millisecond') END)
       ON CONFLICT (tenant, owner, agent_id, id) DO UPDATE
         SET context_id = CASE WHEN ${CANCEL_REPORTED} THEN adk_a2a_tasks.context_id ELSE EXCLUDED.context_id END,
             state = CASE WHEN ${CANCEL_REPORTED} THEN adk_a2a_tasks.state ELSE EXCLUDED.state END,
             status_ts = CASE WHEN ${CANCEL_REPORTED} THEN adk_a2a_tasks.status_ts ELSE EXCLUDED.status_ts END,
             task = CASE WHEN ${CANCEL_REPORTED} THEN adk_a2a_tasks.task ELSE EXCLUDED.task END,
             updated_at = now(), expire_at = EXCLUDED.expire_at,
             lease_owner = CASE WHEN ${CANCEL_FROM_ELSEWHERE} THEN adk_a2a_tasks.lease_owner ELSE EXCLUDED.lease_owner END,
             lease_until = CASE WHEN ${CANCEL_FROM_ELSEWHERE} THEN adk_a2a_tasks.lease_until ELSE EXCLUDED.lease_until END,
             cancel_requested_at = CASE WHEN ${CANCEL_FROM_ELSEWHERE} THEN now()
                                        WHEN EXCLUDED.lease_owner IS NOT NULL THEN adk_a2a_tasks.cancel_requested_at
                                        ELSE NULL END`,
      [
        tenant,
        owner,
        this.agentId,
        t.id,
        t.contextId ?? null,
        t.status?.state ?? null,
        t.status?.timestamp ?? '',
        JSON.stringify(task),
        new Date(Date.now() + this.ttlMs).toISOString(),
        leased ? this.lease!.instanceId : null,
        this.lease?.ttlMs ?? 0,
        this.lease?.instanceId ?? null,
        TaskState.TASK_STATE_CANCELED,
        [...RUNNING],
      ],
    );
  }

  /**
   * Asks the instance running a task to cancel it, without changing the
   * task: stamps `cancel_requested_at` on the caller's own row (scoped as
   * `load` is) while it is running and leased. The running instance's lease
   * heartbeat aborts the run, which then ends `canceled`. Returns whether a
   * running task of this caller's was found.
   */
  async requestCancel(taskId: string, context: Context): Promise<boolean> {
    const [tenant, owner] = this.scope(context);
    const r = await this.pool.query(
      `UPDATE adk_a2a_tasks SET cancel_requested_at = now()
       WHERE tenant = $1 AND owner = $2 AND agent_id = $3 AND id = $4
         AND lease_until IS NOT NULL AND state = ANY($5::int[])`,
      [tenant, owner, this.agentId, taskId, [...RUNNING]],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async load(taskId: string, context: Context): Promise<Task | undefined> {
    const [tenant, owner] = this.scope(context);
    const r = await this.pool.query(
      'SELECT task FROM adk_a2a_tasks WHERE tenant = $1 AND owner = $2 AND agent_id = $3 AND id = $4',
      [tenant, owner, this.agentId, taskId],
    );
    return r.rowCount ? (r.rows[0].task as Task) : undefined;
  }

  async list(params: ListParams, context: Context): Promise<ListResult> {
    const [tenant, owner] = this.scope(context);
    const p = params as {
      contextId?: string;
      status?: number;
      pageSize?: number;
      pageToken?: string;
      statusTimestampAfter?: string;
      includeArtifacts?: boolean;
    };
    const pageSize = p.pageSize || DEFAULT_PAGE_SIZE;
    const args: unknown[] = [tenant, owner, this.agentId];
    let where = 'tenant = $1 AND owner = $2 AND agent_id = $3';
    if (p.contextId) {
      args.push(p.contextId);
      where += ` AND context_id = $${args.length}`;
    }
    if (p.status !== undefined && p.status !== 0) {
      args.push(p.status);
      where += ` AND state = $${args.length}`;
    }
    if (p.statusTimestampAfter) {
      args.push(new Date(p.statusTimestampAfter).toISOString());
      where += ` AND status_ts <> '' AND status_ts::timestamptz > $${args.length}::timestamptz`;
    }
    const total = await this.pool.query(`SELECT count(*)::int AS n FROM adk_a2a_tasks WHERE ${where}`, args);

    let cursor = '';
    if (p.pageToken) {
      const c = decodePageToken(p.pageToken);
      args.push(c.timestamp, c.id);
      cursor = ` AND (status_ts, id) < ($${args.length - 1}, $${args.length})`;
    }
    args.push(pageSize + 1);
    const rows = await this.pool.query(
      `SELECT task, status_ts, id FROM adk_a2a_tasks WHERE ${where}${cursor}
        ORDER BY status_ts DESC, id DESC LIMIT $${args.length}`,
      args,
    );
    const page = rows.rows.slice(0, pageSize);
    const tasks = page.map((row) => {
      const task = row.task as Task & { artifacts?: unknown[] };
      if (!p.includeArtifacts) task.artifacts = [];
      return task as Task;
    });
    const last = page[page.length - 1];
    return {
      tasks,
      nextPageToken: rows.rows.length > pageSize && last ? encodePageToken(last.status_ts ?? '', last.id) : '',
      pageSize,
      totalSize: total.rows[0].n,
    } as ListResult;
  }
}
