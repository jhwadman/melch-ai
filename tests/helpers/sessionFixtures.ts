/**
 * tests/helpers/sessionFixtures.ts — loads the ADK session compatibility
 * fixtures (tests/fixtures/sessions/*.json, written by generate.ts there) and
 * seeds a session service with them, so a test can read or resume a session
 * exactly as a store hands it back.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaseSessionService, Event } from '@google/adk';


export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sessions');

/** One stored conversation: every session row it wrote, as the store holds them. */
export interface SessionFixture {
  fixture: string;
  description: string;
  generatedBy: string;
  adkVersion: string;
  /** `trimmed`: adk_sessions.events (Supabase service, trimEventForStorage). `verbatim`: adk_session_events (Postgres adapter). */
  storedForm: 'trimmed' | 'verbatim';
  endsWith: 'completed' | 'input-required';
  /** The syndicate that wrote it. */
  syndicate: unknown;
  /** The user messages that drove it, one per turn. */
  turns: Array<Array<Record<string, unknown>>>;
  /** The conversation's row first, then any a subagent wrote (appName = the subagent's name). */
  sessions: Array<{ appName: string; userId: string; sessionId: string; state: Record<string, unknown>; events: Event[] }>;
}

export function fixturePath(name: string, form: SessionFixture['storedForm'] = 'trimmed'): string {
  return join(FIXTURE_DIR, `${name}${form === 'verbatim' ? '.verbatim' : ''}.json`);
}

/** Every fixture file name on disk, without the extension, in order. */
export function fixtureFiles(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function loadFixture(name: string, form: SessionFixture['storedForm'] = 'trimmed'): SessionFixture {
  return JSON.parse(readFileSync(fixturePath(name, form), 'utf8')) as SessionFixture;
}

/** The conversation's own session row (the first one written). */
export function conversation(fixture: SessionFixture): SessionFixture['sessions'][number] {
  const row = fixture.sessions[0];
  if (!row) throw new Error(`${fixture.fixture}: no session rows`);
  return row;
}

/**
 * A session service holding the fixture's rows, built the way a store's
 * getSession hands them back: each row created, then each stored event
 * appended in order. Appending rebuilds state from the events' deltas, and
 * that state must equal the row's stored state. Without `store`, ADK's
 * InMemorySessionService.
 */
export async function seedSessions(fixture: SessionFixture, store?: BaseSessionService): Promise<BaseSessionService> {
  // ADK's in-memory store unless the caller passes one; loaded only then, so a suite that passes the engine's store never needs ADK.
  const service = store ?? new (await import('@google/adk')).InMemorySessionService();
  for (const row of fixture.sessions) {
    const session = await service.createSession({ appName: row.appName, userId: row.userId, sessionId: row.sessionId });
    for (const event of structuredClone(row.events)) await service.appendEvent({ session, event });
    const seeded = await service.getSession({ appName: row.appName, userId: row.userId, sessionId: row.sessionId });
    if (JSON.stringify(seeded?.state ?? {}) !== JSON.stringify(row.state)) {
      throw new Error(`${fixture.fixture}/${row.appName}: the state replayed from the events differs from the stored state`);
    }
  }
  return service;
}

/** Moved into the library beside pendingQuestion (lib/runtime/questions.ts); re-exported for the suites that read it here. */
export { pendingWorkflowInput } from '../../lib/runtime/questions.ts';
