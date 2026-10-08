/**
 * lib/storage/postgres/index.ts — every durable store on one Postgres
 * connection (ADR 0021).
 *
 *   const storage = postgresStorage({ connectionString: process.env.DATABASE_URL });
 *   createA2AApp({ ..., storage });
 *
 * Works on any Postgres with pgvector: Supabase through its connection
 * string, RDS, Cloud SQL, AlloyDB, on-premises. Apply the schema first
 * (`npm run db -- apply`, db/migrations/). With this storage plugged in, A2A
 * tasks and conversations are shared by every instance, so the server can run
 * more than one.
 */

import pg from 'pg';
import type { Pool, PoolConfig } from 'pg';

import { SupabaseVectorMemoryService } from '../../memory/supabaseMemoryService.ts';
import type { Embedder, MemoryExtractor } from '../../memory/providers.ts';
import { ERASE_STORES } from '../../memory/erase.ts';
import type { EraseCounts, EraseOptions } from '../../memory/erase.ts';
import { postgresMemoryStore } from './memoryStore.ts';
import { PostgresSessionService } from './sessionService.ts';
import { PostgresTaskStore, reapExpiredTasks, renewTaskLeases } from './taskStore.ts';
import { postgresTaskBackend } from './taskQueue.ts';
import { postgresCredentialStore } from './credentialStore.ts';
import type { CredentialStoreOptions } from '../../tools/credentialStore.ts';
import type { CredentialStore } from '../../tools/auth.ts';
import { searchPathOption } from '../schema.ts';
import { POSTGRES_RLS_QUERY, evaluatePostgresRls } from '../rlsStatus.ts';
import { postgresAuditSink } from '../../observability/audit.ts';
import type { AuditSink } from '../../observability/audit.ts';
import type { RlsHardeningStatus, RlsRow } from '../rlsStatus.ts';
import type { TaskBackend } from '../../tools/taskTools.ts';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { ReleaseTurnLock, TurnLock } from '../../a2a/turnLock.ts';
import type { PostgresTaskStoreOptions } from './taskStore.ts';

export { PostgresSessionService } from './sessionService.ts';
export { PostgresTaskStore } from './taskStore.ts';
export { postgresMemoryStore } from './memoryStore.ts';
export { postgresCredentialRows, postgresCredentialStore } from './credentialStore.ts';

export interface PostgresStorageOptions {
  /** A Postgres URL. Ignored when `pool` is given. */
  connectionString?: string;
  /** Use an existing pool (yours to close). */
  pool?: Pool;
  /** Extra pool settings (ssl, max, …). */
  poolConfig?: PoolConfig;
  /**
   * The schema the tables live in (lib/storage/schema.ts): put first on
   * every connection's search_path. Default `public`. Ignored when `pool`
   * is given (configure that pool's search_path yourself).
   */
  schema?: string;
  /** Days conversations and tasks are kept after their last update. Default 7. */
  ttlDays?: number;
  /**
   * Long-term memory. `apiKey` is the Gemini key used when the extractor or
   * embedder is Gemini (the default). Omit `memory` for no memory service.
   */
  memory?: { apiKey?: string; extractor?: MemoryExtractor; embedder?: Embedder };
  /** Owner of an A2A call, for the task store. Default: the SDK's user scope. */
  taskOwner?: PostgresTaskStoreOptions['ownerResolver'];
  /**
   * Connections reserved for turn locks: each running turn holds one for its
   * length, apart from the main pool so a long turn never starves queries.
   * Default 20; the A2A concurrency cap bounds what is used.
   */
  lockPoolMax?: number;
  /**
   * How long a running A2A task stays leased to this instance without a
   * renewal before another instance may mark it failed (migration 0006).
   * Default 60 s; renewed every third of it.
   */
  taskLeaseMs?: number;
  /**
   * Third-party tokens held for tools (migration 0013, ADR 0072): the cipher
   * that seals them (credentialCipherFromEnv(), or your KMS's) and each
   * provider's refresh and revoke. Omit for no credential store. Audit rows
   * go to this storage's audit trail.
   */
  credentials?: Omit<CredentialStoreOptions, 'rows' | 'audit'>;
}

export interface PostgresStorage {
  pool: Pool;
  sessionService: PostgresSessionService;
  memoryService?: SupabaseVectorMemoryService;
  taskStore: (agentId: string) => PostgresTaskStore;
  erase: (scopeKey: string, options?: EraseOptions) => Promise<EraseCounts>;
  /** The highest migration recorded in melchizedek_schema_version; null if none. */
  schemaVersion: () => Promise<number | null>;
  /**
   * Whether db/hardening.sql is in force where an API could expose the
   * tables (lib/storage/rlsStatus.ts). Never throws.
   */
  rlsHardening: () => Promise<RlsHardeningStatus>;
  /** Appends to melchizedek_audit (migration 0012, ADR 0042). */
  audit: AuditSink;
  /** Tool credentials, sealed (migration 0013, ADR 0072); present when `credentials` was given. */
  credentials?: CredentialStore;
  /**
   * One turn at a time per conversation, across every instance on this
   * database: a session-level advisory lock on a dedicated connection, so a
   * crashed instance releases it when its connection drops (ADR 0021).
   */
  turnLock: TurnLock;
  /** The task tools' lists and job queue (lib/tools/taskTools.ts setTaskBackend). */
  taskQueue: TaskBackend;
  /** Task leases: renew this instance's, fail other instances' expired ones. */
  leases: { instanceId: string; ttlMs: number; renew: () => Promise<number>; reap: () => Promise<number> };
  /** Closes the pool when this module created it, and the lock pool. */
  close: () => Promise<void>;
}

/**
 * A pool emits 'error' when an idle connection dies (a database restart, a
 * failover, an administrator's terminate); unhandled, that event crashes the
 * process. The pool drops the dead client and opens a fresh one on the next
 * query, so the right response is to log it and carry on.
 */
function survivesIdleErrors(p: pg.Pool, label: string): pg.Pool {
  p.on('error', (err) => console.warn(`[storage] ${label}: an idle Postgres connection failed (${err.message}); it will be replaced.`));
  return p;
}

/**
 * The advisory-lock id for a turn-lock key: the first 64 bits of its SHA-256,
 * signed. Hashed here rather than with Postgres' hashtext, because a key is
 * joined with NUL separators (lib/a2a/turnLock.ts) and Postgres text cannot
 * hold a NUL byte. The same key gives the same id on every instance.
 */
export function advisoryLockId(key: string): string {
  return BigInt.asIntN(64, BigInt(`0x${createHash('sha256').update(key).digest('hex').slice(0, 16)}`)).toString();
}

export function postgresStorage(options: PostgresStorageOptions): PostgresStorage {
  const owned = !options.pool;
  const pool =
    options.pool ??
    survivesIdleErrors(
      new pg.Pool({
        connectionString: options.connectionString,
        ...options.poolConfig,
        ...(searchPathOption(options.schema ?? 'public') ? { options: searchPathOption(options.schema ?? 'public') } : {}),
      }),
      'pool',
    );
  if (!options.pool && !options.connectionString && !options.poolConfig?.host) {
    throw new Error('postgresStorage needs a connectionString (e.g. DATABASE_URL) or a pool');
  }

  const sessionService = new PostgresSessionService(pool, { ttlDays: options.ttlDays });
  const lease = { instanceId: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`, ttlMs: options.taskLeaseMs ?? 60_000 };
  const memoryService = options.memory
    ? new SupabaseVectorMemoryService(
        { apiKey: options.memory.apiKey ?? '', extractor: options.memory.extractor, embedder: options.memory.embedder },
        postgresMemoryStore(pool),
      )
    : undefined;

  // Turn locks hold a connection for a whole turn: their own small pool.
  let lockPool: pg.Pool | undefined;
  const locks = () =>
    (lockPool ??= survivesIdleErrors(
      new pg.Pool({
        ...(options.pool ? (options.pool as unknown as { options: PoolConfig }).options : { connectionString: options.connectionString, ...options.poolConfig }),
        max: options.lockPoolMax ?? 20,
      }),
      'turn-lock pool',
    ));
  const turnLock: TurnLock = async (key, { waitMs, signal }) => {
    const lockId = advisoryLockId(key);
    const client = await locks().connect();
    const deadline = Date.now() + Math.max(0, waitMs);
    try {
      for (;;) {
        const r = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [lockId]);
        if (r.rows[0]?.ok) break;
        if (Date.now() >= deadline || signal?.aborted) {
          client.release();
          return null;
        }
        await new Promise((res) => setTimeout(res, Math.min(200, Math.max(10, deadline - Date.now()))));
      }
    } catch (err) {
      client.release(err as Error);
      throw err;
    }
    let released = false;
    const release: ReleaseTurnLock = async () => {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]);
        client.release();
      } catch (err) {
        // Dropping the connection releases a session-level lock too.
        client.release(err as Error);
      }
    };
    return release;
  };

  const audit = postgresAuditSink(pool);
  const credentials = options.credentials ? postgresCredentialStore(pool, { ...options.credentials, audit }) : undefined;

  return {
    pool,
    sessionService,
    turnLock,
    ...(credentials ? { credentials } : {}),
    ...(memoryService ? { memoryService } : {}),
    taskStore: (agentId) => new PostgresTaskStore(pool, agentId, { ttlDays: options.ttlDays, ownerResolver: options.taskOwner, lease }),
    leases: { ...lease, renew: () => renewTaskLeases(pool, lease), reap: () => reapExpiredTasks(pool) },
    taskQueue: postgresTaskBackend(pool),
    async schemaVersion() {
      try {
        const r = await pool.query('SELECT max(version) AS v FROM melchizedek_schema_version');
        return r.rows[0]?.v == null ? null : Number(r.rows[0].v);
      } catch (err) {
        // No version table at all: the migrations were never applied.
        if ((err as { code?: string }).code === '42P01') return null;
        throw err;
      }
    },
    audit,
    async rlsHardening() {
      try {
        const r = await pool.query(POSTGRES_RLS_QUERY);
        const row = r.rows[0] as { api_roles: boolean; schema: string; rows: RlsRow[] };
        return evaluatePostgresRls({ apiRoles: row.api_roles, schema: row.schema, rows: row.rows });
      } catch (err) {
        return { applied: false, detail: `hardening check failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    async erase(scopeKey, eraseOptions = {}) {
      if (!scopeKey?.trim()) throw new Error('erase: a scope key is required');
      const r = await pool.query('SELECT store, deleted FROM melchizedek_erase_scope($1, $2, $3)', [
        scopeKey,
        eraseOptions.namespace ?? null,
        eraseOptions.includeNested ?? false,
      ]);
      const counts = Object.fromEntries(ERASE_STORES.map((s) => [s, 0])) as EraseCounts;
      for (const row of r.rows) {
        if ((ERASE_STORES as readonly string[]).includes(row.store)) counts[row.store as keyof EraseCounts] = Number(row.deleted);
      }
      return counts;
    },
    async close() {
      if (lockPool) await lockPool.end();
      if (owned) await pool.end();
    },
  };
}
