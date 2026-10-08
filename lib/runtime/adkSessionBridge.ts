/**
 * lib/runtime/adkSessionBridge.ts — one session store, either runtime
 * (ADR 0045, ADR 0052, ADR 0058).
 *
 * WHY this file exists:
 *   Until ADK leaves at 1.0, the ADK runtime asks for ADK's
 *   BaseSessionService and the native runtime for the engine's
 *   SessionService (lib/runtime/sessions.ts). The durable stores and the
 *   transcript projection implement both, so they need no bridge. A store
 *   that implements only one of them gets the other here:
 *   - SessionServiceForAdk: the ADK runtime on an engine store, such as
 *     InProcessSessionService.
 *   - AdkSessionServiceForEngine: the engine's interface on an ADK store,
 *     such as ADK's InMemorySessionService, with the interface's meaning
 *     where ADK's store has another (sessions.ts, "ONE MEANING ACROSS
 *     STORES").
 *   asAdkSessionService and asSessionService hand a store back as it is
 *   when it already implements the face asked for, and a bridge back as the
 *   store it wraps, so a store bridged one way and then back is itself.
 *   A surface that takes a store from its caller (the A2A executor and app,
 *   the REPL) types it as EitherSessionService and asks for the face it
 *   needs here (ADR 0080).
 *
 * APPEND: each face keeps its own runtime's rules for the caller's session.
 *   The ADK face applies an event to the runner's session through ADK's
 *   base service, write-order check and all, exactly as the durable stores
 *   do, and the store records it on a copy. The engine face applies it
 *   through applyEvent, which never changes the caller's event, and hands
 *   ADK's store a copy.
 *
 * This module loads ADK at run time, so it is not one of the engine's leaf
 * modules (tests/events.test.ts names those).
 */

import { BaseSessionService } from '../adkPeer.ts';
import type {
  CreateSessionRequest as AdkCreateSessionRequest,
  DeleteSessionRequest as AdkDeleteSessionRequest,
  Event as AdkEvent,
  GetSessionRequest as AdkGetSessionRequest,
  ListSessionsRequest as AdkListSessionsRequest,
  ListSessionsResponse as AdkListSessionsResponse,
  Session as AdkSession,
} from '@google/adk';

import type { TurnEvent } from './events.ts';
import { applyEvent, listPage, listWindow, selectEvents, withoutTempKeys } from './sessions.ts';
import type {
  CreateSessionRequest,
  GetSessionOptions,
  ListSessionsRequest,
  ListSessionsResult,
  Session,
  SessionKey,
  SessionService,
} from './sessions.ts';

/** ADK's session service, named here so a surface never imports ADK for the type (ADR 0080). */
export type AdkSessionService = BaseSessionService;

/** A session store with either face: what a surface takes from its caller. */
export type EitherSessionService = SessionService | BaseSessionService;

/** Every method the engine's interface names. */
export function isSessionService(value: unknown): value is SessionService {
  const v = value as Partial<Record<keyof SessionService, unknown>> | null;
  return (
    typeof v === 'object' && v !== null &&
    typeof v.create === 'function' && typeof v.get === 'function' && typeof v.list === 'function' &&
    typeof v.delete === 'function' && typeof v.append === 'function'
  );
}

/**
 * Every method ADK's runner and services call. A duck check rather than
 * instanceof, so a store built against another copy of ADK still counts.
 */
export function isAdkSessionService(value: unknown): value is BaseSessionService {
  const v = value as Partial<Record<keyof BaseSessionService, unknown>> | null;
  return (
    typeof v === 'object' && v !== null &&
    typeof v.createSession === 'function' && typeof v.getSession === 'function' &&
    typeof v.listSessions === 'function' && typeof v.deleteSession === 'function' &&
    typeof v.appendEvent === 'function'
  );
}

/**
 * A copy a store may apply an event to without touching the caller's
 * session: applyEvent and ADK's base service change only `state`'s keys,
 * the `events` array and `lastUpdateTime`.
 */
function shadowOf<T extends { state: Record<string, unknown>; events: unknown[] }>(session: T): T {
  return { ...session, state: { ...session.state }, events: [...session.events] };
}

/** The key fields only: a request object can carry more. */
function keyOf(request: SessionKey): SessionKey {
  return { appName: request.appName, userId: request.userId, sessionId: request.sessionId };
}

// ── The ADK runtime on an engine store ───────────────────────────────────────

/** ADK's BaseSessionService over an engine SessionService. */
export class SessionServiceForAdk extends BaseSessionService {
  readonly service: SessionService;

  constructor(service: SessionService) {
    super();
    this.service = service;
  }

  async createSession(request: AdkCreateSessionRequest): Promise<AdkSession> {
    return (await this.service.create(request)) as unknown as AdkSession;
  }

  async getSession(request: AdkGetSessionRequest): Promise<AdkSession | undefined> {
    return (await this.service.get(keyOf(request), request.config)) as unknown as AdkSession | undefined;
  }

  async listSessions(request: AdkListSessionsRequest): Promise<AdkListSessionsResponse> {
    return (await this.service.list(request)) as unknown as AdkListSessionsResponse;
  }

  async deleteSession(request: AdkDeleteSessionRequest): Promise<void> {
    await this.service.delete(keyOf(request));
  }

  async appendEvent({ session, event }: { session: AdkSession; event: AdkEvent }): Promise<AdkEvent> {
    if (event.partial) return event;
    // The store applies the event once, to the session as it stood.
    const before = shadowOf(session) as unknown as Session;
    await super.appendEvent({ session, event });
    session.lastUpdateTime = event.timestamp;
    await this.service.append(before, event as unknown as TurnEvent);
    return event;
  }
}

// ── The engine's interface on an ADK store ───────────────────────────────────

/** The engine's SessionService over an ADK BaseSessionService. */
export class AdkSessionServiceForEngine implements SessionService {
  readonly service: BaseSessionService;

  constructor(service: BaseSessionService) {
    this.service = service;
  }

  /** A session that exists comes back unchanged: ADK's own store would reset it. */
  async create(request: CreateSessionRequest): Promise<Session> {
    if (request.sessionId) {
      const existing = await this.get({ appName: request.appName, userId: request.userId, sessionId: request.sessionId });
      if (existing) return existing;
    }
    const created = await this.service.createSession({
      appName: request.appName,
      userId: request.userId,
      sessionId: request.sessionId,
      state: withoutTempKeys(request.state ?? {}),
    });
    return created as unknown as Session;
  }

  /** Reads the whole session and filters it here, so `options` mean what the interface says. */
  async get(key: SessionKey, options?: GetSessionOptions): Promise<Session | undefined> {
    const held = (await this.service.getSession(keyOf(key))) as unknown as Session | undefined;
    if (!held) return undefined;
    return { ...held, events: selectEvents(held.events, options) };
  }

  /** The window goes to ADK's store as an offset; the paging figures are the interface's. */
  async list(request: ListSessionsRequest): Promise<ListSessionsResult> {
    const { offset, limit } = listWindow(request);
    const listed = await this.service.listSessions({
      appName: request.appName,
      userId: request.userId,
      order: request.order,
      offset,
      limit,
    });
    return {
      sessions: (listed.sessions as unknown as Session[]).map((s) => ({ ...s, events: [] })),
      ...listPage(listed.totalItems, request),
    };
  }

  async delete(key: SessionKey): Promise<void> {
    await this.service.deleteSession(keyOf(key));
  }

  async append(session: Session, event: TurnEvent): Promise<TurnEvent> {
    if (event.partial) return event;
    // ADK's base service applies an event to the session it is given and
    // rewrites the event's delta in place, so ADK's store gets copies of
    // both, and the session as it stood.
    const before = shadowOf(session) as unknown as AdkSession;
    const stored = applyEvent(session, event);
    await this.service.appendEvent({ session: before, event: structuredClone(stored) as unknown as AdkEvent });
    return stored;
  }
}

// ── Either face of a store ───────────────────────────────────────────────────

/** The store as the ADK runtime takes it: itself when it already is one. */
export function asAdkSessionService(service: EitherSessionService): BaseSessionService {
  if (service instanceof AdkSessionServiceForEngine) return service.service;
  if (isAdkSessionService(service)) return service;
  if (isSessionService(service)) return new SessionServiceForAdk(service);
  throw new TypeError('Not a session service: it implements neither SessionService nor ADK\'s BaseSessionService.');
}

/** The store as the engine's interface: itself when it already is one. */
export function asSessionService(service: EitherSessionService): SessionService {
  if (service instanceof SessionServiceForAdk) return service.service;
  if (isSessionService(service)) return service;
  if (isAdkSessionService(service)) return new AdkSessionServiceForEngine(service);
  throw new TypeError('Not a session service: it implements neither SessionService nor ADK\'s BaseSessionService.');
}
