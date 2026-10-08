/**
 * tests/adkSessionBridge.test.ts — one session store, either runtime
 * (lib/runtime/adkSessionBridge.ts, the durable stores' two faces; ADR 0052,
 * ADR 0058).
 *
 * What it holds the code to:
 *   - A store with both faces is handed back as it is; a store with one gets
 *     the other from the bridge.
 *   - The ADK runtime runs on an engine store through the bridge, and the
 *     engine's interface reads and writes the same session between its turns.
 *   - The engine's interface on ADK's in-memory store keeps the interface's
 *     meaning where ADK's store has another.
 *   - The Supabase store: a second create keeps the conversation, a list
 *     without a user id lists every user's sessions, lastUpdateTime is the
 *     event's timestamp, and the ADK runtime and the engine's interface read
 *     and write the same row (ADR 0045's plan, WS2-2's done-when).
 *   - Nothing in lib/ or scripts/ lists sessions except the stores and the
 *     layers that forward to them, so a listing across users stays reachable
 *     only by code that holds the store.
 *   - The Postgres store replaces the row of an event whose id the session
 *     already holds, and appends every other event as a new row.
 * Scripted models, in-memory stores, no network. The same done-when on a real
 * Postgres is in tests/postgresStorage.test.ts.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InMemorySessionService, LlmAgent, LogLevel, Runner, setLogLevel } from '@google/adk';
import type { BaseSessionService } from '@google/adk';

import {
  AdkSessionServiceForEngine,
  SessionServiceForAdk,
  asAdkSessionService,
  asSessionService,
  isAdkSessionService,
  isSessionService,
} from '../lib/runtime/adkSessionBridge.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import type { TurnEvent, TurnEventInit } from '../lib/runtime/events.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { SessionKey, SessionService } from '../lib/runtime/sessions.ts';
import { ProjectedSessionService } from '../lib/session/transcript.ts';
import { SupabaseSessionService } from '../lib/session/supabaseSessionService.ts';
import { PostgresSessionService } from '../lib/storage/postgres/sessionService.ts';
import { fakeSupabase } from './helpers/fakeSupabase.ts';
import { ScriptedLlm, sentTexts, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const KEY: SessionKey = { appName: 'tea.ns', userId: 'u1', sessionId: 'conv' };
const ev = (id: string, timestamp: number, init: TurnEventInit = {}): TurnEvent =>
  createTurnEvent({ id, timestamp, invocationId: 'e-native', author: 'user', content: { role: 'user', parts: [{ text: id }] }, ...init });

/** One ADK turn on `sessions`; the answer's text. */
async function adkTurn(sessions: BaseSessionService, model: ScriptedLlm, message: string): Promise<string> {
  const agent = new LlmAgent({ name: 'Desk', model, instruction: 'Answer briefly.' });
  const runner = new Runner({ appName: KEY.appName, agent, sessionService: sessions });
  let answer = '';
  for await (const event of runner.runAsync({ userId: KEY.userId, sessionId: KEY.sessionId, newMessage: { role: 'user', parts: [{ text: message }] } })) {
    for (const p of event.content?.parts ?? []) if (p.text && !event.partial) answer = p.text;
  }
  return answer;
}

/**
 * ADK turn, engine read and append, ADK turn: the conversation both
 * runtimes see on one store. Returns what the second turn's model was sent.
 */
async function bothRuntimes(engine: SessionService, adk: BaseSessionService): Promise<string[]> {
  const model = new ScriptedLlm('scripted-desk', (_req, n) => text(n === 1 ? 'Noted: green tea.' : 'Green tea, and oolong too.'));
  await engine.create({ ...KEY, state: { kept: true, 'temp:scratch': 1 } });

  assert.equal(await adkTurn(adk, model, 'I like green tea.'), 'Noted: green tea.');

  const read = (await engine.get(KEY))!;
  assert.deepEqual(read.events.map((e) => e.author), ['user', 'Desk'], 'the engine reads what the ADK runtime wrote');
  assert.deepEqual(read.state, { kept: true }, 'no temp: key is stored at create');
  const said = ev('engine-said', read.events.at(-1)!.timestamp + 1, {
    content: { role: 'user', parts: [{ text: 'Also: oolong.' }] },
    actions: { stateDelta: { tea: 'oolong', 'temp:t': 1 } },
  });
  const given = structuredClone(said);
  const stored = await engine.append(read, said);
  assert.deepEqual(said, given, 'the caller’s event is unchanged');
  assert.deepEqual(stored.actions.stateDelta, { tea: 'oolong' });

  assert.equal(await adkTurn(adk, model, 'What do I like?'), 'Green tea, and oolong too.');
  const sent = sentTexts(model.requests[1]!);
  for (const t of ['I like green tea.', 'Noted: green tea.', 'Also: oolong.', 'What do I like?']) {
    assert.ok(sent.includes(t), `the ADK runtime's second turn was sent "${t}"`);
  }

  const viaAdk = (await adk.getSession(KEY))!;
  const viaEngine = (await engine.get(KEY))!;
  assert.equal(JSON.stringify(viaEngine.events), JSON.stringify(viaAdk.events), 'one conversation, read by either face');
  assert.deepEqual(viaEngine.events.map((e) => e.author), ['user', 'Desk', 'user', 'user', 'Desk']);
  assert.deepEqual({ ...viaAdk.state }, { kept: true, tea: 'oolong' }, 'the engine’s state write reaches the ADK runtime');
  assert.equal(viaEngine.lastUpdateTime, viaEngine.events.at(-1)!.timestamp, 'the last update is the last event’s timestamp');
  return sent;
}

// ── Which face a store has ───────────────────────────────────────────────────

test('a store with both faces is handed back as it is; a store with one gets the other', () => {
  const both = [
    new SupabaseSessionService(fakeSupabase().client),
    new PostgresSessionService({} as any),
    new ProjectedSessionService(new InMemorySessionService(), 'Desk'),
  ];
  for (const store of both) {
    assert.ok(isSessionService(store) && isAdkSessionService(store), store.constructor.name);
    assert.equal(asSessionService(store), store);
    assert.equal(asAdkSessionService(store), store);
  }

  const engineOnly = new InProcessSessionService();
  assert.ok(isSessionService(engineOnly) && !isAdkSessionService(engineOnly));
  assert.equal(asSessionService(engineOnly), engineOnly);
  const forAdk = asAdkSessionService(engineOnly);
  assert.ok(forAdk instanceof SessionServiceForAdk && forAdk.service === engineOnly);

  const adkOnly = new InMemorySessionService();
  assert.ok(isAdkSessionService(adkOnly) && !isSessionService(adkOnly));
  assert.equal(asAdkSessionService(adkOnly), adkOnly);
  const forEngine = asSessionService(adkOnly);
  assert.ok(forEngine instanceof AdkSessionServiceForEngine && forEngine.service === adkOnly);

  assert.throws(() => asSessionService({} as any), TypeError);
  assert.throws(() => asAdkSessionService(null as any), TypeError);
});

// ── The bridge ───────────────────────────────────────────────────────────────

test('the ADK runtime runs on an engine store through the bridge, and the engine reads and writes the same session', async () => {
  const store = new InProcessSessionService();
  await bothRuntimes(store, asAdkSessionService(store));
});

test('the engine’s interface on an ADK store, through the bridge: the same conversation', async () => {
  const adk = new InMemorySessionService();
  await bothRuntimes(asSessionService(adk), adk);
});

test('the engine’s interface on ADK’s in-memory store keeps the interface’s meaning', async () => {
  const adk = new InMemorySessionService();
  const sessions = asSessionService(adk);

  const created = await sessions.create({ ...KEY, state: { kept: 1, 'temp:x': 2 } });
  assert.deepEqual({ ...created.state }, { kept: 1 });
  for (const [id, ts] of [['e1', 10], ['e2', 20], ['e3', 30]] as const) await sessions.append(created, ev(id, ts));
  assert.equal(await sessions.append(created, ev('p', 40, { partial: true })).then((e) => e.partial), true);
  assert.deepEqual(created.events.map((e) => e.id), ['e1', 'e2', 'e3'], 'the caller’s session holds the events, the partial one not');

  // ADK's store alone resets a session created again; the interface keeps it.
  const again = await sessions.create({ ...KEY, state: { other: true } });
  assert.deepEqual(again.events.map((e) => e.id), ['e1', 'e2', 'e3'], 'a second create keeps the conversation');
  const reset = new InMemorySessionService();
  await reset.createSession({ ...KEY });
  await reset.appendEvent({ session: (await reset.getSession(KEY))!, event: ev('x', 1) as any });
  assert.deepEqual((await reset.createSession({ ...KEY })).events, [], 'control: ADK’s own create resets it');

  // ADK keeps an event at the timestamp itself and counts before it filters.
  const ids = async (options: object) => (await sessions.get(KEY, options))!.events.map((e) => e.id);
  assert.deepEqual(await ids({ afterTimestamp: 20 }), ['e3'], 'strictly after');
  assert.deepEqual((await adk.getSession({ ...KEY, config: { afterTimestamp: 20 } }))!.events.map((e) => e.id), ['e2', 'e3'], 'control: ADK keeps e2');
  assert.deepEqual(await ids({ afterTimestamp: 15, numRecentEvents: 1 }), ['e3']);
  assert.deepEqual(await ids({ numRecentEvents: -1 }), ['e1', 'e2', 'e3'], 'a count below one asks for nothing');
  assert.equal((await sessions.get(KEY))!.lastUpdateTime, 30);

  // One page, even when empty (ADK reports none).
  const empty = await sessions.list({ appName: 'nobody', limit: 5 });
  assert.deepEqual({ page: empty.page, totalPages: empty.totalPages, totalItems: empty.totalItems }, { page: 1, totalPages: 1, totalItems: 0 });
  const listed = await sessions.list({ appName: KEY.appName, limit: 1, page: 1 });
  assert.deepEqual(listed.sessions.map((s) => s.id), ['conv']);
  assert.deepEqual(listed.sessions[0]!.events, []);

  await sessions.delete(KEY);
  assert.equal(await sessions.get(KEY), undefined);
});

test('the ADK face of an engine store keeps ADK’s rules for the runner’s session', async () => {
  const store = new InProcessSessionService();
  const adk = asAdkSessionService(store);
  const session = await adk.createSession({ ...KEY });
  const event = ev('a1', 10, { actions: { stateDelta: { owner: 'A', 'temp:t': 1 } } }) as any;
  await adk.appendEvent({ session, event });
  assert.deepEqual({ ...event.actions.stateDelta }, { owner: 'A' }, 'ADK’s base service drops temp: keys from the event it was given, as on every ADK store');
  assert.deepEqual({ ...session.state }, { owner: 'A' });
  assert.equal(session.lastUpdateTime, 10);
  const held = (await store.get(KEY))!;
  assert.deepEqual(held.events.map((e) => e.id), ['a1'], 'the store holds the event once');
  assert.deepEqual(held.state, { owner: 'A' });

  // An append on a session the store does not hold (deleted mid-turn) keeps it.
  await store.delete(KEY);
  await adk.appendEvent({ session, event: ev('a2', 20) as any });
  assert.deepEqual((await store.get(KEY))!.events.map((e) => e.id), ['a1', 'a2']);
});

// ── The Supabase store ───────────────────────────────────────────────────────

test('Supabase: a second create keeps the conversation, on either face', async () => {
  const db = fakeSupabase();
  const sessions = new SupabaseSessionService(db.client);
  const created = await sessions.create({ ...KEY, state: { kept: 1 } });
  await sessions.append(created, ev('e1', 5, { actions: { stateDelta: { n: 1 } } }));

  const viaEngine = await sessions.create({ ...KEY, state: { other: true } });
  const viaAdk = await sessions.createSession({ ...KEY, state: { other: true } });
  for (const again of [viaEngine, viaAdk]) {
    assert.deepEqual(again.events.map((e) => e.id), ['e1']);
    assert.deepEqual(again.state, { kept: 1, n: 1 });
  }
  const [row] = db.rows('adk_sessions');
  assert.equal(db.rows('adk_sessions').length, 1);
  assert.deepEqual((row!.events as TurnEvent[]).map((e) => e.id), ['e1'], 'the row still holds the event');
  assert.deepEqual(row!.state, { kept: 1, n: 1 });

  const fresh = await sessions.create({ appName: KEY.appName, userId: KEY.userId });
  assert.match(fresh.id, /^[0-9a-f-]{36}$/);
  assert.equal(db.rows('adk_sessions').length, 2);
});

test('Supabase: the row’s last update is the appended event’s timestamp, on either face', async () => {
  const db = fakeSupabase();
  const sessions = new SupabaseSessionService(db.client);
  const session = await sessions.create({ ...KEY });
  const lastUpdate = () => db.rows('adk_sessions')[0]!.last_update_time;

  await sessions.append(session, ev('e1', 1_700_000_000_123));
  assert.equal(lastUpdate(), 1_700_000_000_123);
  assert.equal(session.lastUpdateTime, 1_700_000_000_123);

  const live = (await sessions.getSession(KEY))!;
  await sessions.appendEvent({ session: live, event: ev('e2', 1_700_000_000_456.7) as any });
  assert.equal(live.lastUpdateTime, 1_700_000_000_456.7);
  assert.equal(lastUpdate(), 1_700_000_000_456, 'whole milliseconds in the BIGINT column');
  assert.equal((await sessions.get(KEY))!.lastUpdateTime, 1_700_000_000_456);
});

test('Supabase: a list without a user id lists every user’s sessions of the app', async () => {
  const db = fakeSupabase();
  const sessions = new SupabaseSessionService(db.client);
  for (const userId of ['u1', 'u2', 'undefined']) await sessions.create({ appName: 'a', userId, sessionId: `s-${userId}` });
  await sessions.create({ appName: 'other', userId: 'u1', sessionId: 's-x' });

  const all = await sessions.list({ appName: 'a' });
  assert.deepEqual(all.sessions.map((s) => s.userId), ['u1', 'u2', 'undefined'], 'every user, in the order created');
  assert.equal(all.totalItems, 3);
  assert.deepEqual((await sessions.listSessions({ appName: 'a' })).sessions.map((s) => s.id), ['s-u1', 's-u2', 's-undefined']);
  assert.deepEqual((await sessions.list({ appName: 'a', userId: 'u2' })).sessions.map((s) => s.id), ['s-u2'], 'a user id still scopes it');
});

test('Supabase (done-when): the ADK runtime and the engine’s interface read and write the same row', async () => {
  const db = fakeSupabase();
  const sessions = new SupabaseSessionService(db.client);
  await bothRuntimes(sessions, sessions);

  const rows = db.rows('adk_sessions');
  assert.equal(rows.length, 1, 'one conversation, one row');
  const row = rows[0]!;
  assert.equal(row.id, `${KEY.appName}:${KEY.userId}:${KEY.sessionId}`);
  const events = row.events as TurnEvent[];
  assert.equal(JSON.stringify(events), JSON.stringify((await sessions.get(KEY))!.events), 'the engine reads the row as stored');
  assert.equal(JSON.stringify(events), JSON.stringify((await sessions.getSession(KEY))!.events), 'so does the ADK runtime');
  assert.deepEqual(row.state, { kept: true, tea: 'oolong' });
  assert.equal(row.last_update_time, events.at(-1)!.timestamp);
});

test('nothing in the engine lists sessions: a list without a user id is reachable only by code holding the store', () => {
  // A listing without a user id reads every user's conversations of an app.
  // No route, tool or turn asks for one; only the stores and the layers that
  // forward to them name the method. A caller that lists sessions is a
  // disclosure decision, so it has to be added here on purpose.
  const forwarders = [
    'lib/runtime/adkSessionBridge.ts',
    'lib/session/supabaseSessionService.ts',
    'lib/session/transcript.ts',
    'lib/storage/postgres/sessionService.ts',
  ];
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const naming = [...files('lib'), ...files('scripts')].filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return /\blistSessions\s*\(/.test(src) || /\.list\(\s*\{\s*appName/.test(src);
  });
  assert.deepEqual(naming.sort(), forwarders);
});

// ── The Postgres store ───────────────────────────────────────────────────────

test('Postgres: an event whose id the session holds replaces its row; any other is the next row', async () => {
  const sql: Array<{ text: string; params: unknown[] }> = [];
  let rowsReplaced = 1;
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      sql.push({ text, params });
      return { rowCount: text.includes('UPDATE adk_session_events') ? rowsReplaced : 1, rows: [] };
    },
    release: () => undefined,
  };
  const sessions = new PostgresSessionService({ connect: async () => client } as any);
  const session = { id: KEY.sessionId, appName: KEY.appName, userId: KEY.userId, state: {}, events: [] as TurnEvent[], lastUpdateTime: 0 };
  const writes = () => sql.filter((q) => /adk_session_events/.test(q.text) && /^\s*(INSERT|UPDATE)/.test(q.text) && q.params.length > 1);

  await sessions.append(session, ev('e1', 10));
  assert.deepEqual(writes().map((q) => q.text.trim().split(/\s+/)[0]), ['INSERT'], 'a new id is the next row');

  sql.length = 0;
  await sessions.append(session, ev('e1', 20, { content: { role: 'user', parts: [{ text: 'edited' }] } }));
  const [replace] = writes();
  assert.match(replace!.text, /UPDATE adk_session_events SET ts = \$2, event = \$3::jsonb\s+WHERE session_id = \$1 AND event->>'id' = \$4/);
  assert.deepEqual(replace!.params.slice(0, 2), ['tea.ns:u1:conv', 20]);
  assert.equal(writes().length, 1, 'the replaced row is not appended again');
  assert.deepEqual(session.events.map((e) => e.id), ['e1'], 'as applyEvent replaces it in the session');

  // A row that is gone (pruned, erased) is written again.
  sql.length = 0;
  rowsReplaced = 0;
  await sessions.append(session, ev('e1', 25));
  assert.deepEqual(writes().map((q) => q.text.trim().split(/\s+/)[0]), ['UPDATE', 'INSERT']);
  rowsReplaced = 1;

  // The ADK face decides the same way, from the runner's session before ADK's merge.
  sql.length = 0;
  await sessions.appendEvent({ session: session as any, event: ev('e2', 30) as any });
  assert.deepEqual(writes().map((q) => q.text.trim().split(/\s+/)[0]), ['INSERT']);
  const update = sql.find((q) => q.text.includes('UPDATE adk_sessions'))!;
  assert.equal(update.params[2], 30, 'last_update_time is the event’s timestamp');
});
