/**
 * lib/storage/postgres/sessionService.ts — sessions on a direct Postgres
 * connection (ADR 0021), for either runtime (ADR 0052, ADR 0058).
 *
 * WHY it differs from the Supabase session service:
 *   That one re-uploads a conversation's WHOLE events array on every event.
 *   Two turns on one conversation each hold a private copy, and whichever
 *   writes last erases the other's events; the bytes written grow with the
 *   square of the conversation's length. Here each event is one row in
 *   adk_session_events, appended under a row lock on its session, and state
 *   changes are merged into the stored state rather than overwriting it.
 *
 *   Events are stored as ADK produced them. The Supabase service trims thought
 *   signatures and large tool payloads because it rewrites everything on every
 *   event; appending each event once removes that cost, and a DELEGATE
 *   conversation that is replayed to the model gets back exactly what it sent.
 *
 * TWO FACES, ONE STORE:
 *   The class is the engine's SessionService (create, get, list, delete,
 *   append) and ADK's BaseSessionService (createSession, getSession, …), so
 *   the ADK runtime and the native one read and write the same rows. The ADK
 *   methods call the engine's, except appendEvent, which applies the event
 *   to the runner's session through ADK's base service (its write-order
 *   check included), where append uses applyEvent. Both record it the same
 *   way. The rules are lib/runtime/sessions.ts's: a create of an existing
 *   id keeps the conversation, `afterTimestamp` is strict and filters
 *   before `numRecentEvents` counts, an event whose id the caller's session
 *   already holds replaces that row in place (as applyEvent replaces it in
 *   the session), and lastUpdateTime is the appended event's timestamp.
 *
 * Rows share adk_sessions with the Supabase service (same id scheme:
 * '<appName>:<userId>:<sessionId>'), so erase and the session prune cover
 * both. Tables: db/migrations/0001_base.sql and 0003_postgres_storage.sql.
 */

import { randomUUID } from 'node:crypto';

import { BaseSessionService } from '@google/adk';
import type {
  CreateSessionRequest as AdkCreateSessionRequest,
  DeleteSessionRequest as AdkDeleteSessionRequest,
  Event as AdkEvent,
  GetSessionRequest as AdkGetSessionRequest,
  ListSessionsRequest as AdkListSessionsRequest,
  ListSessionsResponse as AdkListSessionsResponse,
  Session as AdkSession,
} from '@google/adk';
import type { Pool, PoolClient } from 'pg';

import type { TurnEvent } from '../../runtime/events.ts';
import { applyEvent, listPage, listWindow, withoutTempKeys } from '../../runtime/sessions.ts';
import type {
  CreateSessionRequest,
  GetSessionOptions,
  ListSessionsRequest,
  ListSessionsResult,
  Session,
  SessionKey,
  SessionService,
} from '../../runtime/sessions.ts';

export interface PostgresSessionOptions {
  /** Days a conversation is kept after its last event (expire_at). Default 7. */
  ttlDays?: number;
}

function dbId(appName: string, userId: string, sessionId: string): string {
  return `${appName}:${userId}:${sessionId}`;
}

/** The persisted part of a state delta: `temp:` keys are never stored. */
export function persistedDelta(delta: Record<string, unknown> | undefined): Record<string, unknown> {
  return withoutTempKeys(delta ?? {});
}

/** Whether the session already holds an event with this one's id: the append replaces it. */
function holds(session: { events: ReadonlyArray<{ id?: string }> }, event: { id?: string }): boolean {
  return Boolean(event.id) && session.events.some((e) => e.id === event.id);
}

/** An event's timestamp, or the clock for an event without one. */
function eventTime(ms: unknown): number {
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now();
}

/** last_update_time is BIGINT milliseconds. */
function rowTime(ms: unknown): number {
  return Math.floor(eventTime(ms));
}

/**
 * A conversation written by the Supabase session service keeps its events as
 * a JSON array on adk_sessions.events; this adapter keeps one row per event.
 * Moving a deployment from one to the other (setting DATABASE_URL) must not
 * cut every conversation off from its history, nor shift the event counts
 * memory ingestion has recorded, so the first read or append of such a
 * conversation copies its array into rows, in order. It runs only while the
 * conversation has no rows, and leaves the array in place, so moving back is
 * still possible.
 */
const IMPORT_LEGACY_EVENTS = `
  INSERT INTO adk_session_events (session_id, seq, ts, event)
  SELECT s.id, e.ord,
         CASE WHEN jsonb_typeof(e.elem->'timestamp') = 'number' THEN (e.elem->>'timestamp')::double precision END,
         e.elem
    FROM adk_sessions s,
         jsonb_array_elements(coalesce(s.events, '[]'::jsonb)) WITH ORDINALITY AS e(elem, ord)
   WHERE s.id = $1
     AND NOT EXISTS (SELECT 1 FROM adk_session_events WHERE session_id = $1)`;

/** The conversation's next event row. Runs under the session's row lock. */
const INSERT_EVENT = `
  INSERT INTO adk_session_events (session_id, seq, ts, event)
  VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM adk_session_events WHERE session_id = $1), $2, $3::jsonb)`;

/**
 * An event whose id the session already holds replaces that row in place,
 * as applyEvent replaces it in the session. It reads every event of the
 * conversation, so it runs only when the caller's session held the id.
 */
const REPLACE_EVENT = `
  UPDATE adk_session_events SET ts = $2, event = $3::jsonb
   WHERE session_id = $1 AND event->>'id' = $4`;

export class PostgresSessionService extends BaseSessionService implements SessionService {
  private readonly ttlMs: number;
  private readonly pool: Pool;

  constructor(pool: Pool, options: PostgresSessionOptions = {}) {
    super();
    this.pool = pool;
    this.ttlMs = (options.ttlDays ?? 7) * 24 * 60 * 60 * 1000;
  }

  private expireAt(): string {
    return new Date(Date.now() + this.ttlMs).toISOString();
  }

  // ── The engine's interface (lib/runtime/sessions.ts) ─────────────────────

  async create(request: CreateSessionRequest): Promise<Session> {
    const sessionId = request.sessionId || randomUUID();
    const id = dbId(request.appName, request.userId, sessionId);
    const state = withoutTempKeys(request.state ?? {});
    const now = Date.now();
    // A create for an id that exists, concurrent or not, keeps the row
    // that is already there, events and all, instead of resetting it.
    const inserted = await this.pool.query(
      `INSERT INTO adk_sessions (id, app_name, user_id, state, events, last_update_time, expire_at)
       VALUES ($1, $2, $3, $4::jsonb, '[]'::jsonb, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [id, request.appName, request.userId, JSON.stringify(state), now, this.expireAt()],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.get({ appName: request.appName, userId: request.userId, sessionId });
      if (existing) return existing;
    }
    return { id: sessionId, appName: request.appName, userId: request.userId, state, events: [], lastUpdateTime: now };
  }

  /** Copy a legacy JSON history into rows, once, under the conversation's row lock. */
  private async importLegacyEvents(id: string): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM adk_sessions WHERE id = $1 FOR UPDATE', [id]);
      await client.query(IMPORT_LEGACY_EVENTS, [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** selectEvents' rules, pushed down: strictly after the timestamp, then the newest N, oldest first. */
  async get(key: SessionKey, options: GetSessionOptions = {}): Promise<Session | undefined> {
    const id = dbId(key.appName, key.userId, key.sessionId);
    const row = await this.pool.query(
      `SELECT app_name, user_id, state, last_update_time,
              (jsonb_array_length(coalesce(events, '[]'::jsonb)) > 0
               AND NOT EXISTS (SELECT 1 FROM adk_session_events WHERE session_id = $1)) AS legacy
         FROM adk_sessions WHERE id = $1`,
      [id],
    );
    if (row.rowCount === 0) return undefined;
    if (row.rows[0].legacy) await this.importLegacyEvents(id);

    const params: unknown[] = [id];
    let where = 'session_id = $1';
    if (options.afterTimestamp) {
      params.push(options.afterTimestamp);
      where += ` AND ts > $${params.length}`;
    }
    const n = options.numRecentEvents;
    const recent = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 0;
    const events =
      recent > 0
        ? await this.pool.query(
            `SELECT event FROM (SELECT event, seq FROM adk_session_events WHERE ${where} ORDER BY seq DESC LIMIT $${params.length + 1}) recent ORDER BY seq ASC`,
            [...params, recent],
          )
        : await this.pool.query(`SELECT event FROM adk_session_events WHERE ${where} ORDER BY seq ASC`, params);

    const r = row.rows[0];
    return {
      id: key.sessionId,
      appName: r.app_name,
      userId: r.user_id,
      state: r.state ?? {},
      events: events.rows.map((e) => e.event as TurnEvent),
      lastUpdateTime: Number(r.last_update_time ?? 0),
    };
  }

  /**
   * listWindow and listPage's paging, with the real total beside the page.
   * Every user's sessions when `userId` is absent. By last update, ties by
   * id, when an order is asked for; in the order the rows were created
   * otherwise. Events are left out.
   */
  async list(request: ListSessionsRequest): Promise<ListSessionsResult> {
    const { offset, limit } = listWindow(request);
    const params: unknown[] = [request.appName];
    let where = 'app_name = $1';
    if (request.userId !== undefined) {
      params.push(request.userId);
      where += ` AND user_id = $${params.length}`;
    }
    const total = await this.pool.query(`SELECT count(*)::int AS n FROM adk_sessions WHERE ${where}`, params);
    const orderBy = request.order
      ? `ORDER BY last_update_time ${request.order === 'asc' ? 'ASC' : 'DESC'}, id`
      : 'ORDER BY created_at, id';
    const paged = [...params];
    let window = '';
    if (limit !== undefined) {
      paged.push(limit);
      window += `LIMIT $${paged.length} `;
    }
    paged.push(offset);
    window += `OFFSET $${paged.length}`;
    const rows = await this.pool.query(
      `SELECT id, app_name, user_id, state, last_update_time FROM adk_sessions WHERE ${where} ${orderBy} ${window}`,
      paged,
    );

    const sessions: Session[] = rows.rows.map((row) => ({
      id: String(row.id).slice(String(row.app_name).length + String(row.user_id).length + 2),
      appName: row.app_name,
      userId: row.user_id,
      state: row.state ?? {},
      events: [],
      lastUpdateTime: Number(row.last_update_time ?? 0),
    }));
    return { sessions, ...listPage(total.rows[0].n as number, request) };
  }

  async delete(key: SessionKey): Promise<void> {
    // Events go with it (ON DELETE CASCADE).
    await this.pool.query('DELETE FROM adk_sessions WHERE id = $1', [dbId(key.appName, key.userId, key.sessionId)]);
  }

  async append(session: Session, event: TurnEvent): Promise<TurnEvent> {
    // Streaming fragments are appended whole once complete.
    if (event.partial) return event;
    const replacing = holds(session, event);
    const stored = applyEvent(session, event);
    await this.record(session, stored, replacing);
    return stored;
  }

  /**
   * One event into the store, in one transaction: its row, the state delta
   * merged into the stored state, and the times. Two copies of a session
   * appending in turn both land, since each writes only its own event.
   */
  private async record(
    session: { appName: string; userId: string; id: string },
    event: TurnEvent | AdkEvent,
    replacing: boolean,
  ): Promise<void> {
    const id = dbId(session.appName, session.userId, session.id);
    const delta = persistedDelta(event.actions?.stateDelta as Record<string, unknown> | undefined);
    const ts = typeof event.timestamp === 'number' ? event.timestamp : null;
    const updated = rowTime(event.timestamp);
    const json = JSON.stringify(event);
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The row lock serializes appends to one conversation across every
      // process; a missing row (created elsewhere, or pruned) is recreated.
      const locked = await client.query('SELECT 1 FROM adk_sessions WHERE id = $1 FOR UPDATE', [id]);
      if (locked.rowCount === 0) {
        await client.query(
          `INSERT INTO adk_sessions (id, app_name, user_id, state, events, last_update_time, expire_at)
           VALUES ($1, $2, $3, '{}'::jsonb, '[]'::jsonb, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [id, session.appName, session.userId, updated, this.expireAt()],
        );
        await client.query('SELECT 1 FROM adk_sessions WHERE id = $1 FOR UPDATE', [id]);
      }
      // A conversation the Supabase service wrote: its history first.
      await client.query(IMPORT_LEGACY_EVENTS, [id]);
      const replaced = replacing ? await client.query(REPLACE_EVENT, [id, ts, json, event.id]) : undefined;
      if (!replaced?.rowCount) await client.query(INSERT_EVENT, [id, ts, json]);
      await client.query(
        `UPDATE adk_sessions
            SET state = coalesce(state, '{}'::jsonb) || $2::jsonb,
                last_update_time = $3,
                expire_at = $4,
                updated_at = now()
          WHERE id = $1`,
        [id, JSON.stringify(delta), updated, this.expireAt()],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Failed to append event: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }

  // ── ADK's BaseSessionService, for the ADK runtime ─────────────────────────

  async createSession(request: AdkCreateSessionRequest): Promise<AdkSession> {
    return (await this.create(request)) as unknown as AdkSession;
  }

  async getSession(request: AdkGetSessionRequest): Promise<AdkSession | undefined> {
    const key = { appName: request.appName, userId: request.userId, sessionId: request.sessionId };
    return (await this.get(key, request.config)) as unknown as AdkSession | undefined;
  }

  async listSessions(request: AdkListSessionsRequest): Promise<AdkListSessionsResponse> {
    return (await this.list(request)) as unknown as AdkListSessionsResponse;
  }

  async deleteSession(request: AdkDeleteSessionRequest): Promise<void> {
    await this.delete(request);
  }

  async appendEvent(request: { session: AdkSession; event: AdkEvent }): Promise<AdkEvent> {
    const { session, event } = request;
    if (event.partial) return event;
    // ADK's own merge: applies the state delta to the live session, strips
    // temp: keys, replaces or pushes the event. It must run: a bare push
    // drops every state write (see the Supabase service).
    const replacing = holds(session, event);
    await super.appendEvent({ session, event });
    session.lastUpdateTime = eventTime(event.timestamp);
    await this.record(session, event, replacing);
    return event;
  }
}
