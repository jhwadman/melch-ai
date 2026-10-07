/**
 * tests/fixtures/sessions/generate.ts — writes the ADK session compatibility
 * fixtures: frozen examples of the session rows the ADK runtime writes today,
 * so a native runtime can be proven to read and resume them.
 *
 *   node --disable-warning=DEP0040 --experimental-strip-types tests/fixtures/sessions/generate.ts          # write
 *   node --disable-warning=DEP0040 --experimental-strip-types tests/fixtures/sessions/generate.ts --check  # compare, exit 1 on a diff
 *
 * Run on demand, never by `npm test`. Each scenario (scenarios.ts) drives real
 * ADK objects through runSyndicateTurn with scripted models, offline. Every
 * event is captured as the session service receives it, serialized as a store
 * serializes it, and passed through trimEventForStorage, which is the
 * `adk_sessions.events` form the Supabase service writes. The Postgres adapter
 * keeps events verbatim in `adk_session_events`; a scenario with
 * `verbatimToo` also gets that form, as `<name>.verbatim.json`.
 *
 * Ids and timestamps are normalized, so regenerating against the same ADK
 * writes the same bytes: an event id becomes `ev000001` (eight characters,
 * like ADK's), every UUID inside any string (invocation ids `e-<uuid>`, call
 * ids `adk-<uuid>`, interrupt ids) becomes a fixed UUID in order of first
 * appearance, and timestamps count up one second per event from 2026-01-01.
 * Nothing else is rewritten: trimEventForStorage writes an elided size with
 * en-US digit grouping on any machine, so the locale never reaches the bytes.
 * A diff after an ADK upgrade means the stored shape changed: read it before
 * committing it. `npm run fixtures:sessions:check` runs the check, and CI
 * runs it after the offline suite.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';
import type { CreateSessionRequest, Event, Session } from '@google/adk';

import { runSyndicateTurn } from '../../../lib/runtime/syndicateTurn.ts';
import { trimEventForStorage } from '../../../lib/session/transcript.ts';
import { fixturePath } from '../../helpers/sessionFixtures.ts';
import type { SessionFixture } from '../../helpers/sessionFixtures.ts';
import { scriptedResolver } from '../../helpers/scriptedLlm.ts';
import { APP, USER, scenarios } from './scenarios.ts';
import type { Scenario } from './scenarios.ts';

setLogLevel(LogLevel.ERROR);

const ADK_VERSION: string = createRequire(import.meta.url)('@google/adk/package.json').version;
const BASE_TIMESTAMP = Date.UTC(2026, 0, 1);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const keyOf = (appName: string, userId: string, sessionId: string) => `${appName}:${userId}:${sessionId}`;

/** An in-memory session service that also keeps what a store would have been handed, in order. */
class RecordingSessionService extends InMemorySessionService {
  readonly created: Array<{ appName: string; userId: string; sessionId: string }> = [];
  readonly appended: Array<{ key: string; event: Record<string, Json> }> = [];

  override async createSession(request: CreateSessionRequest): Promise<Session> {
    const session = await super.createSession(request);
    this.created.push({ appName: session.appName, userId: session.userId, sessionId: session.id });
    return session;
  }

  override async appendEvent(request: { session: Session; event: Event }): Promise<Event> {
    const out = await super.appendEvent(request);
    const { session, event } = request;
    // A store serializes the event at append time; partial events are never stored.
    if (!event.partial) this.appended.push({ key: keyOf(session.appName, session.userId, session.id), event: JSON.parse(JSON.stringify(event)) });
    return out;
  }
}

/** Ids and timestamps replaced by stable values, across every session of one fixture. */
function normalizer() {
  const eventIds = new Map<string, string>();
  const uuids = new Map<string, string>();
  const uuid = (m: string) => {
    const k = m.toLowerCase();
    if (!uuids.has(k)) uuids.set(k, `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, '0')}`);
    return uuids.get(k)!;
  };
  const walk = (v: Json): Json => {
    if (typeof v === 'string') return eventIds.get(v) ?? v.replace(UUID, uuid);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(UUID, uuid), walk(x)]));
    return v;
  };
  return (event: Record<string, Json>, seq: number): Record<string, Json> => {
    if (typeof event.id === 'string' && !eventIds.has(event.id)) eventIds.set(event.id, `ev${String(eventIds.size + 1).padStart(6, '0')}`);
    const out = walk(event) as Record<string, Json>;
    if (typeof out.timestamp === 'number') out.timestamp = BASE_TIMESTAMP + seq * 1000;
    return out;
  };
}

async function generate(s: Scenario): Promise<SessionFixture[]> {
  const sessions = new RecordingSessionService();
  const models = s.models();
  for (const [i, parts] of s.turns.entries()) {
    const r = await runSyndicateTurn({
      config: s.config,
      parts,
      appName: APP,
      userId: USER,
      sessionId: s.sessionId,
      sessionService: sessions,
      compile: { resolveModel: scriptedResolver(models) },
      trace: false,
    });
    const want = i === s.turns.length - 1 ? s.endsWith : 'completed';
    if (r.status !== want) throw new Error(`${s.name}: turn ${i + 1} ended ${r.status}, expected ${want}${r.error ? ` (${r.error.code}: ${r.error.message})` : ''}`);
  }

  // The append log is what a row-per-event store holds; the final session is
  // what a whole-array store holds. They must agree, or a fixture would freeze
  // one store's shape and not the other's.
  for (const { appName, userId, sessionId } of sessions.created) {
    const session = await sessions.getSession({ appName, userId, sessionId });
    const logged = sessions.appended.filter((a) => a.key === keyOf(appName, userId, sessionId)).map((a) => a.event);
    if (JSON.stringify(logged) !== JSON.stringify(JSON.parse(JSON.stringify(session?.events ?? [])))) {
      throw new Error(`${s.name}: ${keyOf(appName, userId, sessionId)} — the events appended differ from the session's final events`);
    }
  }

  const build = async (form: SessionFixture['storedForm']): Promise<SessionFixture> => {
    const normalize = normalizer();
    const byKey = new Map<string, Json[]>(sessions.created.map(({ appName, userId, sessionId }) => [keyOf(appName, userId, sessionId), []]));
    sessions.appended.forEach(({ key, event }, seq) => {
      const stored = form === 'trimmed' ? (JSON.parse(JSON.stringify(trimEventForStorage(event as unknown as Event))) as Record<string, Json>) : event;
      byKey.get(key)!.push(normalize(stored, seq));
    });
    return {
      fixture: s.name,
      description: s.description,
      generatedBy: 'tests/fixtures/sessions/generate.ts',
      adkVersion: ADK_VERSION,
      storedForm: form,
      endsWith: s.endsWith,
      syndicate: s.config,
      turns: s.turns,
      sessions: await Promise.all(
        sessions.created.map(async ({ appName, userId, sessionId }) => {
          const session = await sessions.getSession({ appName, userId, sessionId });
          const events = (byKey.get(keyOf(appName, userId, sessionId)) ?? []) as unknown as Event[];
          return { appName, userId, sessionId, state: JSON.parse(JSON.stringify(session?.state ?? {})), events };
        }),
      ),
    };
  };

  return [await build('trimmed'), ...(s.verbatimToo ? [await build('verbatim')] : [])];
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const s of scenarios) {
    for (const file of await generate(s)) {
      const path = fixturePath(file.fixture, file.storedForm);
      const body = `${JSON.stringify(file, null, 2)}\n`;
      if (!check) {
        writeFileSync(path, body);
        console.log(`wrote ${path}`);
        continue;
      }
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        /* missing counts as stale */
      }
      if (current !== body) {
        stale += 1;
        console.error(`stale: ${path}`);
      }
    }
  }
  if (check) {
    if (stale) {
      console.error(`${stale} fixture file(s) differ from what the runtime writes now.`);
      process.exit(1);
    }
    console.log('session fixtures are current.');
  }
}

await main();
