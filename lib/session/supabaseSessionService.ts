/**
 * lib/session/supabaseSessionService.ts — sessions through supabase-js
 * (the REST path ADR 0021 keeps for a transition period), for either
 * runtime (ADR 0052, ADR 0058).
 *
 * One row per conversation in adk_sessions, its events as one JSON array
 * that every append rewrites whole (the Postgres adapter keeps a row per
 * event instead, lib/storage/postgres/sessionService.ts). Each event in the
 * row is passed through trimEventForStorage (lib/session/transcript.ts).
 *
 * TWO FACES, ONE STORE:
 *   The class is the engine's SessionService (create, get, list, delete,
 *   append) and ADK's BaseSessionService (createSession, getSession, …), so
 *   the ADK runtime and the native one read and write the same rows. The ADK
 *   methods call the engine's, except appendEvent, which applies the event
 *   to the runner's session through ADK's base service (its write-order
 *   check included), where append uses applyEvent. Both write the row the
 *   same way. The rules are lib/runtime/sessions.ts's:
 *   - a create of an existing id returns the conversation unchanged, where
 *     an upsert would reset it to no events;
 *   - a list without a user id lists every user's sessions of the app, as
 *     the Postgres adapter and ADK's own stores do;
 *   - `afterTimestamp` is strict and filters before `numRecentEvents`
 *     counts (selectEvents);
 *   - lastUpdateTime is the appended event's timestamp, which is the clock
 *     of the process that made the event, just before the append.
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
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

import type { TurnEvent } from '../runtime/events.ts';
import { applyEvent, listPage, listWindow, selectEvents, withoutTempKeys } from '../runtime/sessions.ts';
import type {
  CreateSessionRequest,
  GetSessionOptions,
  ListSessionsRequest,
  ListSessionsResult,
  Session,
  SessionKey,
  SessionService,
} from '../runtime/sessions.ts';
import { trimEventForStorage } from './transcript.ts';

/** Days a conversation is kept after its last write (expire_at). */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** An event's timestamp, or the clock for an event without one. */
function eventTime(ms: unknown): number {
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now();
}

export class SupabaseSessionService extends BaseSessionService implements SessionService {
    private supabase: SupabaseClient;

    constructor(supabaseClient: SupabaseClient) {
        super();
        this.supabase = supabaseClient;
    }

    private getDbId(request: { appName: string, userId: string, sessionId: string }): string {
        return `${request.appName}:${request.userId}:${request.sessionId}`;
    }

    private expireAt(): string {
        return new Date(Date.now() + TTL_MS).toISOString();
    }

    // ── The engine's interface (lib/runtime/sessions.ts) ─────────────────────

    async create(request: CreateSessionRequest): Promise<Session> {
        const sessionId = request.sessionId || randomUUID();
        const key = { appName: request.appName, userId: request.userId, sessionId };
        const session: Session = {
            id: sessionId,
            appName: request.appName,
            userId: request.userId,
            state: withoutTempKeys(request.state ?? {}),
            events: [],
            lastUpdateTime: Date.now(),
        };

        // ON CONFLICT DO NOTHING: the row comes back only when this call
        // inserted it. A row that is already there is the conversation.
        const { data, error } = await this.supabase
            .from('adk_sessions')
            .upsert({
                id: this.getDbId(key),
                app_name: session.appName,
                user_id: session.userId,
                state: session.state,
                events: [],
                last_update_time: session.lastUpdateTime,
                expire_at: this.expireAt(),
            }, { onConflict: 'id', ignoreDuplicates: true })
            .select('id');

        if (error) {
            console.error('Error creating session in Supabase:', error);
            throw new Error(`Failed to create session: ${error.message}`);
        }
        if (!data?.length) {
            const existing = await this.get(key);
            if (existing) return existing;
        }
        return session;
    }

    async get(key: SessionKey, options?: GetSessionOptions): Promise<Session | undefined> {
        const { data, error } = await this.supabase
            .from('adk_sessions')
            .select('*')
            .eq('id', this.getDbId(key))
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return undefined; // Not found
            }
            console.error('Error getting session from Supabase:', error);
            throw new Error(`Failed to get session: ${error.message}`);
        }

        if (!data) return undefined;

        return {
            id: key.sessionId,
            appName: data.app_name,
            userId: data.user_id,
            state: data.state || {},
            events: selectEvents((data.events || []) as TurnEvent[], options),
            lastUpdateTime: Number(data.last_update_time ?? 0),
        };
    }

    /**
     * Paging as listWindow and listPage state it. The window is pushed down
     * to Postgres via .range(), and `count: 'exact'` returns the TOTAL
     * matching rows alongside the page, so totalItems is the real total, not
     * the slice length. Every user's sessions when `userId` is absent. By
     * last update, ties by id, when an order is asked for; in the order the
     * rows were created otherwise, so a page never depends on how Postgres
     * happens to scan.
     */
    async list(request: ListSessionsRequest): Promise<ListSessionsResult> {
        const { offset, limit } = listWindow(request);

        let query = this.supabase
            .from('adk_sessions')
            .select('id, app_name, user_id, state, last_update_time', { count: 'exact' })
            .eq('app_name', request.appName);

        if (request.userId !== undefined) {
            query = query.eq('user_id', request.userId);
        }
        query = request.order
            ? query.order('last_update_time', { ascending: request.order === 'asc' }).order('id', { ascending: true })
            : query.order('created_at', { ascending: true }).order('id', { ascending: true });
        if (limit !== undefined) {
            query = query.range(offset, offset + limit - 1);
        } else if (offset > 0) {
            // An offset without a limit still means "skip these".
            query = query.range(offset, offset + 999_999);
        }

        const { data, error, count } = await query;

        if (error) {
            console.error('Error listing sessions from Supabase:', error);
            throw new Error(`Failed to list sessions: ${error.message}`);
        }

        const sessions: Session[] = (data || []).map(row => ({
            // The composite key without its '<appName>:<userId>:' prefix.
            id: String(row.id).slice(String(row.app_name).length + String(row.user_id).length + 2),
            appName: row.app_name,
            userId: row.user_id,
            state: row.state || {},
            events: [], // A listing leaves events out.
            lastUpdateTime: Number(row.last_update_time ?? 0),
        }));

        return { sessions, ...listPage(count ?? sessions.length, request) };
    }

    async delete(key: SessionKey): Promise<void> {
        const { error } = await this.supabase
            .from('adk_sessions')
            .delete()
            .eq('id', this.getDbId(key));

        if (error) {
            console.error('Error deleting session from Supabase:', error);
            throw new Error(`Failed to delete session: ${error.message}`);
        }
    }

    async append(session: Session, event: TurnEvent): Promise<TurnEvent> {
        // Partial events are streaming fragments of an event that is
        // appended whole when it completes; persisting them would write every
        // token twice.
        if (event.partial) return event;
        const stored = applyEvent(session, event);
        await this.write(session);
        return stored;
    }

    /**
     * The caller's session, as it stands after the event, becomes the row.
     *
     * Trim on the SERIALIZED COPY only. The live session keeps thought
     * signatures and real tool payloads — the agent's own tool loop reads
     * them back mid-turn — but nothing reads them from the ROW: the
     * projection drops both on the way into a prompt, and the memory service
     * walks `part.text` alone. Across 128 live sessions they were ~90% of
     * every byte stored (73% of it Gemini's `thoughtSignature`), and this
     * re-uploads the whole array on every event, so those bytes were paid for
     * again on each one. See trimEventForStorage.
     */
    private async write(session: Session | AdkSession): Promise<void> {
        const cleanSession = JSON.parse(JSON.stringify(session));
        cleanSession.events = (cleanSession.events as AdkEvent[]).map((e: AdkEvent) => trimEventForStorage(e));

        const { error } = await this.supabase
            .from('adk_sessions')
            .upsert({
                id: this.getDbId({ appName: session.appName, userId: session.userId, sessionId: session.id }),
                app_name: cleanSession.appName,
                user_id: cleanSession.userId,
                state: cleanSession.state,
                events: cleanSession.events,
                last_update_time: Math.floor(eventTime(session.lastUpdateTime)),
                expire_at: this.expireAt(),
            });

        if (error) {
            console.error('Error appending event to session in Supabase:', error);
            throw new Error(`Failed to append event: ${error.message}`);
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

    async appendEvent(request: { session: AdkSession, event: AdkEvent }): Promise<AdkEvent> {
        const { session, event } = request;
        if (event.partial) return event;

        // Standard ADK internal state merging. This MUST go through the base
        // implementation: it applies `event.actions.stateDelta` to
        // `session.state` and strips `temp:` keys before pushing the event.
        // Re-implementing it as a bare `events.push` (as this did until
        // 2026-08-15) silently drops every state write — `output_key`, any
        // state-injected instruction variable — and leaves `session.state`
        // permanently `{}`, which is exactly what every stored row showed.
        await super.appendEvent({ session, event });
        session.lastUpdateTime = eventTime(event.timestamp);
        await this.write(session);
        return event;
    }
}
