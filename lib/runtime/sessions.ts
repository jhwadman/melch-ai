/**
 * lib/runtime/sessions.ts — the engine's own session interface, the rules
 * every store applies, and a store that lives in the process (ADR 0045,
 * ADR 0052).
 *
 * WHY this file exists:
 *   The engine reads and writes sessions through this interface. The
 *   durable stores (lib/session/supabaseSessionService.ts, lib/storage/
 *   postgres/sessionService.ts), the transcript projection (lib/session/
 *   transcript.ts) and InProcessSessionService below implement it
 *   (ADR 0058, ADR 0107). The shapes are ADK's JSON (a Session holds
 *   TurnEvents, lib/runtime/events.ts), so a session ADK wrote before 1.0.0
 *   reads and resumes as one the engine wrote.
 *
 * ONE MEANING ACROSS STORES:
 *   Where ADK's own services disagree with the engine's durable stores, the
 *   interface takes the durable stores' meaning, because that is what
 *   production runs and what a test on this in-process store should see.
 *   Where the two durable stores differ, it takes the Postgres store's,
 *   which never loses an event:
 *   - `afterTimestamp` keeps events strictly after it, and `numRecentEvents`
 *     then keeps the newest of those (ADK's in-memory store counts first
 *     and keeps an event at the timestamp itself).
 *   - Creating a session whose id exists returns it unchanged, events and
 *     all, so a second create never resets a conversation (ADK's in-memory
 *     store resets it).
 *   - Paging reports at least one page (listPage).
 *   - `app:` and `user:` state keys stay in the session's own state, as both
 *     durable stores keep them; ADK's in-memory store shares them across
 *     sessions. No syndicate writes such a key.
 *   The method names are not ADK's (create, not createSession): a caller
 *   moving from ADK's services renames each call (create, get, append).
 *
 * NO RUNTIME IMPORTS: every import here is a type, and nothing in this
 * module's import graph names @google/* (tests/events.test.ts asserts it).
 */

import type { TurnEvent } from './events.ts';

// ── Shapes ───────────────────────────────────────────────────────────────────

/** A conversation's address. Stores key it as `<appName>:<userId>:<sessionId>`. */
export interface SessionKey {
  /** The syndicate (or, for a DELEGATE subagent's own row, its agent path: lib/runtime/native/delegate.ts childAppName). */
  appName: string;
  userId: string;
  sessionId: string;
}

/** A conversation: the same JSON as ADK's `Session`. */
export interface Session {
  id: string;
  appName: string;
  userId: string;
  /** Written only through events' `stateDelta` (applyEvent). Never holds a `temp:` key. */
  state: Record<string, unknown>;
  /** Oldest first. */
  events: TurnEvent[];
  /** Milliseconds since the epoch: the last appended event's timestamp, or the creation time. */
  lastUpdateTime: number;
}

export interface CreateSessionRequest {
  appName: string;
  userId: string;
  /** A new UUID when absent. */
  sessionId?: string;
  /** Initial state; `temp:` keys are dropped. */
  state?: Record<string, unknown>;
}

export interface GetSessionOptions {
  /** Keep only the newest N events (after `afterTimestamp`, when both are set). Ignored unless above zero. */
  numRecentEvents?: number;
  /** Keep only events whose timestamp is strictly greater. Ignored when 0 or absent. */
  afterTimestamp?: number;
}

export interface ListSessionsRequest {
  appName: string;
  /** Every user's sessions when absent. */
  userId?: string;
  /** Page size. Every session matching, in one page, when absent. */
  limit?: number;
  /** Zero-based index of the first session. Ignored when `page` and `limit` are both set. */
  offset?: number;
  /** One-based page number. Needs `limit`; wins over `offset`. */
  page?: number;
  /** By last update, ties by id. Insertion order when absent. */
  order?: 'asc' | 'desc';
}

export interface ListSessionsResult {
  /** The page's sessions, each without its events. */
  sessions: Session[];
  /** One-based. */
  page: number;
  /** The page size, or every matching session's count when no limit was asked for. */
  limit: number;
  /** Sessions matching, across every page. */
  totalItems: number;
  /** At least 1. */
  totalPages: number;
}

/**
 * Where conversations live. Every method fails by throwing, with a message a
 * person can act on; reading a session that does not exist is not a failure.
 */
export interface SessionService {
  create(request: CreateSessionRequest): Promise<Session>;
  /** A copy: changing it changes nothing stored. Undefined when there is no such session. */
  get(key: SessionKey, options?: GetSessionOptions): Promise<Session | undefined>;
  list(request: ListSessionsRequest): Promise<ListSessionsResult>;
  /** Deletes the session and its events. Deleting one that does not exist does nothing. */
  delete(key: SessionKey): Promise<void>;
  /**
   * Records `event` in `session` (applyEvent's rules, on the caller's copy)
   * and in the store, and returns the event as stored. A partial event is
   * returned as it is and recorded nowhere. Two copies of one session
   * appending in turn both land: each append adds its own event.
   */
  append(session: Session, event: TurnEvent): Promise<TurnEvent>;
}

// ── The rules every store applies ────────────────────────────────────────────

/** State keys with this prefix last for one invocation and are never stored. */
export const TEMP_STATE_PREFIX = 'temp:';

/**
 * Sets an own property even when the key is `__proto__`: JSON.parse makes
 * that an own key, and plain assignment would re-parent the object instead.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** A copy of `record` without its `temp:` keys, in the same key order. */
export function withoutTempKeys(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (!key.startsWith(TEMP_STATE_PREFIX)) setOwn(out, key, value);
  return out;
}

/**
 * Applies one event to a live session, as ADK's BaseSessionService did,
 * and returns the event as a store keeps it:
 *   1. A partial event is returned as it is, and the session is untouched.
 *   2. The stored event's `stateDelta` loses its `temp:` keys (a copy; the
 *      given event is never changed).
 *   3. Each remaining delta key is written into `session.state`.
 *   4. The event replaces the session's event with the same id, or is
 *      appended.
 *   5. `session.lastUpdateTime` becomes the event's timestamp.
 */
export function applyEvent(session: Session, event: TurnEvent): TurnEvent {
  if (event.partial) return event;
  let stored = event;
  const delta = event.actions?.stateDelta;
  if (delta) {
    const kept = withoutTempKeys(delta);
    if (Object.keys(kept).length !== Object.keys(delta).length) {
      stored = { ...event, actions: { ...event.actions, stateDelta: kept } };
    }
    for (const [key, value] of Object.entries(kept)) setOwn(session.state, key, value);
  }
  const at = session.events.findIndex((e) => e.id === stored.id);
  if (at >= 0) session.events[at] = stored;
  else session.events.push(stored);
  session.lastUpdateTime = stored.timestamp;
  return stored;
}

/** A finite number, rounded down; undefined otherwise. */
function whole(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : undefined;
}

/** The events a read with `options` returns, oldest first (GetSessionOptions). */
export function selectEvents(events: readonly TurnEvent[], options: GetSessionOptions = {}): TurnEvent[] {
  let out = [...events];
  const after = options.afterTimestamp;
  if (after) out = out.filter((e) => e.timestamp > after);
  const n = whole(options.numRecentEvents);
  if (n !== undefined && n > 0) out = out.slice(-n);
  return out;
}

/**
 * The window a list request asks for: a zero-based offset and, when a limit
 * was given, the page size. `page` wins over `offset` only beside a limit.
 */
export function listWindow(request: Pick<ListSessionsRequest, 'limit' | 'offset' | 'page'>): { offset: number; limit?: number } {
  const limitRaw = whole(request.limit);
  const limit = limitRaw === undefined ? undefined : Math.max(0, limitRaw);
  const page = whole(request.page);
  const offset =
    limit !== undefined && page !== undefined ? (Math.max(1, page) - 1) * limit : Math.max(0, whole(request.offset) ?? 0);
  return limit === undefined ? { offset } : { offset, limit };
}

/** The paging figures a list result reports, given how many sessions matched. */
export function listPage(
  totalItems: number,
  request: Pick<ListSessionsRequest, 'limit' | 'offset' | 'page'>,
): Omit<ListSessionsResult, 'sessions'> {
  const { offset, limit } = listWindow(request);
  return {
    page: limit ? Math.floor(offset / limit) + 1 : 1,
    limit: limit ?? totalItems,
    totalItems,
    totalPages: limit ? Math.max(1, Math.ceil(totalItems / limit)) : 1,
  };
}

// ── In the process ───────────────────────────────────────────────────────────

export interface InProcessSessionOptions {
  /** The clock for a new session's lastUpdateTime. Default Date.now. */
  now?: () => number;
}

/**
 * Sessions held in this process, lost when it exits: the store for a
 * syndicate with no durable one, and for tests. Every read hands out a copy
 * and every append stores a copy, so no caller shares an object with the
 * store. An append to a session the store does not hold (deleted while its
 * turn ran) keeps the caller's session as it stands after the event.
 */
export class InProcessSessionService implements SessionService {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;

  constructor(options: InProcessSessionOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private static key(appName: string, userId: string, sessionId: string): string {
    return JSON.stringify([appName, userId, sessionId]);
  }

  async create(request: CreateSessionRequest): Promise<Session> {
    const id = request.sessionId || globalThis.crypto.randomUUID();
    const key = InProcessSessionService.key(request.appName, request.userId, id);
    const existing = this.sessions.get(key);
    if (existing) return structuredClone(existing);
    const session: Session = {
      id,
      appName: request.appName,
      userId: request.userId,
      state: withoutTempKeys(structuredClone(request.state ?? {})),
      events: [],
      lastUpdateTime: this.now(),
    };
    this.sessions.set(key, session);
    return structuredClone(session);
  }

  async get(key: SessionKey, options?: GetSessionOptions): Promise<Session | undefined> {
    const held = this.sessions.get(InProcessSessionService.key(key.appName, key.userId, key.sessionId));
    if (!held) return undefined;
    const copy = structuredClone(held);
    copy.events = selectEvents(copy.events, options);
    return copy;
  }

  async list(request: ListSessionsRequest): Promise<ListSessionsResult> {
    const matching = [...this.sessions.values()].filter(
      (s) => s.appName === request.appName && (request.userId === undefined || s.userId === request.userId),
    );
    if (request.order) {
      const sign = request.order === 'asc' ? 1 : -1;
      matching.sort((a, b) => sign * (a.lastUpdateTime - b.lastUpdateTime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    const { offset, limit } = listWindow(request);
    const window = matching.slice(offset, limit === undefined ? undefined : offset + limit);
    return {
      sessions: window.map((s) => ({
        id: s.id,
        appName: s.appName,
        userId: s.userId,
        state: structuredClone(s.state),
        events: [],
        lastUpdateTime: s.lastUpdateTime,
      })),
      ...listPage(matching.length, request),
    };
  }

  async delete(key: SessionKey): Promise<void> {
    this.sessions.delete(InProcessSessionService.key(key.appName, key.userId, key.sessionId));
  }

  async append(session: Session, event: TurnEvent): Promise<TurnEvent> {
    if (event.partial) return event;
    const stored = applyEvent(session, event);
    const key = InProcessSessionService.key(session.appName, session.userId, session.id);
    const held = this.sessions.get(key);
    if (held) applyEvent(held, structuredClone(stored));
    else this.sessions.set(key, structuredClone(session));
    return stored;
  }
}
