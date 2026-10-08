/**
 * tests/events.test.ts — the engine's own event, session and memory
 * interfaces (lib/runtime/events.ts, sessions.ts, memoryService.ts;
 * ADR 0045, ADR 0052).
 *
 * What it holds the code to:
 *   - Every session fixture (tests/fixtures/sessions, both stored forms:
 *     trimmed rows from adk_sessions.events and verbatim rows from
 *     adk_session_events) parses as TurnEvent[] and serializes back to the
 *     file's exact bytes, and every field stored there is one TurnEvent
 *     declares.
 *   - getFunctionCalls, getFunctionResponses and isFinal answer as ADK's own
 *     functions do, on every fixture event and on the edge cases;
 *     createTurnEvent builds the JSON ADK's createEvent builds.
 *   - The parse names the field it cannot read and carries every other one.
 *   - The in-process session service: copies in and out, the delta rules
 *     ADK applies, one meaning for reads and paging across stores, and every
 *     fixture replayed through it unchanged.
 *   - The three modules load nothing at run time and name no @google/*.
 * ADK appears here only as the reference; no model, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  InMemorySessionService as AdkInMemorySessionService,
  createEvent as adkCreateEvent,
  getFunctionCalls as adkGetFunctionCalls,
  getFunctionResponses as adkGetFunctionResponses,
  isFinalResponse as adkIsFinalResponse,
} from '@google/adk';
import type { Event as AdkEvent, Session as AdkSession } from '@google/adk';

import {
  TurnEventError,
  createEventActions,
  createTurnEvent,
  getFunctionCalls,
  getFunctionResponses,
  hasTrailingCodeExecutionResult,
  isFinal,
  newEventId,
  parseTurnEvent,
  parseTurnEvents,
} from '../lib/runtime/events.ts';
import type {
  TurnContent,
  TurnEvent,
  TurnEventActions,
  TurnEventInit,
  TurnFunctionCall,
  TurnFunctionResponse,
  TurnNodeInfo,
  TurnPart,
  TurnUsage,
} from '../lib/runtime/events.ts';
import {
  InProcessSessionService,
  TEMP_STATE_PREFIX,
  applyEvent,
  listPage,
  listWindow,
  selectEvents,
  withoutTempKeys,
} from '../lib/runtime/sessions.ts';
import type { Session, SessionService } from '../lib/runtime/sessions.ts';
import type { MemoryEntry, MemoryService } from '../lib/runtime/memoryService.ts';
import { SKIP_SIGNATURE } from '../lib/session/transcript.ts';
import { FIXTURE_DIR, fixtureFiles, loadFixture } from './helpers/sessionFixtures.ts';
import type { SessionFixture } from './helpers/sessionFixtures.ts';
import { ROOT, importGraph, runtimeImportsOf } from './helpers/importGraph.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface FixtureFile {
  name: string;
  form: 'trimmed' | 'verbatim';
  raw: string;
  fixture: SessionFixture;
}

/** Every fixture file, as bytes and as parsed JSON. */
function fixtureFilesOnDisk(): FixtureFile[] {
  return fixtureFiles().map((name) => {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8');
    return { name, form: name.endsWith('.verbatim') ? 'verbatim' : 'trimmed', raw, fixture: JSON.parse(raw) as SessionFixture };
  });
}

/** Every stored event of every fixture, parsed from fresh JSON, with where it came from. */
function everyStoredEvent(): Array<{ where: string; event: TurnEvent }> {
  return fixtureFilesOnDisk().flatMap(({ name, fixture }) =>
    fixture.sessions.flatMap((row, r) =>
      parseTurnEvents(structuredClone(row.events), `${name}.sessions[${r}].events`).map((event, i) => ({
        where: `${name}.sessions[${r}].events[${i}]`,
        event,
      })),
    ),
  );
}

/** The same JSON as ADK's types see it. TurnEvent is wider than ADK's Event (a string where genai has an enum), so the cast goes through unknown. */
const asAdk = (event: TurnEvent): AdkEvent => event as unknown as AdkEvent;
const adkEventFrom = (init: TurnEventInit): AdkEvent => adkCreateEvent(structuredClone(init) as unknown as Parameters<typeof adkCreateEvent>[0]);

// ── The stored shape ─────────────────────────────────────────────────────────

test('every fixture parses as TurnEvent[] and serializes back to the same bytes', () => {
  const files = fixtureFilesOnDisk();
  assert.ok(files.length >= 10, 'all fixture files are read');
  let events = 0;
  for (const { name, raw, fixture } of files) {
    const reparsed = {
      ...fixture,
      sessions: fixture.sessions.map((row, r) => {
        const parsed: TurnEvent[] = parseTurnEvents(row.events, `${name}.sessions[${r}].events`);
        events += parsed.length;
        return { ...row, events: parsed };
      }),
    };
    assert.equal(`${JSON.stringify(reparsed, null, 2)}\n`, raw, `${name}: the parsed events serialize to the file's bytes`);
    // Each event on its own, against the same event re-read from the bytes.
    const fromBytes = JSON.parse(raw) as SessionFixture;
    fixture.sessions.forEach((row, r) =>
      row.events.forEach((e, i) => assert.equal(JSON.stringify(parseTurnEvent(e)), JSON.stringify(fromBytes.sessions[r]!.events[i]))),
    );
  }
  assert.ok(events >= 39, `every stored event is parsed (${events})`);
});

test('both stored forms are read: trimmed rows (adk_sessions.events) and verbatim rows (adk_session_events)', () => {
  const files = fixtureFilesOnDisk();
  const verbatim = files.filter((f) => f.form === 'verbatim');
  const trimmed = files.filter((f) => f.form === 'trimmed');
  assert.ok(verbatim.length >= 2 && trimmed.length >= 8);
  for (const v of verbatim) {
    assert.equal(v.fixture.storedForm, 'verbatim');
    assert.ok(trimmed.some((t) => t.name === v.name.replace(/\.verbatim$/, '')), `${v.name} has its trimmed counterpart`);
  }
  for (const t of trimmed) assert.equal(t.fixture.storedForm, 'trimmed');

  const events = (name: string) => parseTurnEvents(structuredClone(loadFixture(name.replace(/\.verbatim$/, ''), name.endsWith('.verbatim') ? 'verbatim' : 'trimmed').sessions[0]!.events));

  // A Gemini signature: verbatim keeps it on the call and the answer; trimmed keeps only the call's skip value.
  const callPart = (es: TurnEvent[]) => es.flatMap((e) => e.content?.parts ?? []).find((p) => p.functionCall)!;
  const answerPart = (es: TurnEvent[]) => es.at(-1)!.content!.parts!.at(-1)!;
  const sigVerbatim = events('06-thought-signature.verbatim');
  const sigTrimmed = events('06-thought-signature');
  assert.ok(callPart(sigVerbatim).thoughtSignature && callPart(sigVerbatim).thoughtSignature !== SKIP_SIGNATURE);
  assert.ok(answerPart(sigVerbatim).thoughtSignature);
  assert.equal(callPart(sigTrimmed).thoughtSignature, SKIP_SIGNATURE);
  assert.equal(answerPart(sigTrimmed).thoughtSignature, undefined);
  assert.equal(sigVerbatim.find((e) => e.usageMetadata)?.usageMetadata?.thoughtsTokenCount, 41, 'usage reads in both forms');

  // A long tool result: verbatim keeps it; trimmed keeps the call's id and name with the elision marker.
  const resultOf = (es: TurnEvent[]) => es.flatMap(getFunctionResponses)[0]!;
  const longVerbatim = resultOf(events('08-elided-result.verbatim'));
  const longTrimmed = resultOf(events('08-elided-result'));
  assert.equal(longTrimmed.id, longVerbatim.id);
  assert.equal(longTrimmed.name, longVerbatim.name);
  assert.match(String(longTrimmed.response?.elided), /^2,563 chars dropped before storage/);
  assert.ok(JSON.stringify(longVerbatim.response).length > 2_000);
});

/** Field names TurnEvent and its parts declare; `satisfies` refuses a name the types do not have. */
const DECLARED = {
  event: [
    'id', 'invocationId', 'author', 'content', 'actions', 'partial', 'turnComplete', 'timestamp', 'customMetadata',
    'longRunningToolIds', 'branch', 'errorCode', 'errorMessage', 'usageMetadata', 'finishReason', 'groundingMetadata',
    'citationMetadata', 'interrupted', 'modelVersion', 'output', 'route', 'nodeInfo', 'isolationScope',
  ] satisfies Array<keyof TurnEvent>,
  content: ['role', 'parts'] satisfies Array<keyof TurnContent>,
  part: [
    'text', 'thought', 'thoughtSignature', 'functionCall', 'functionResponse', 'inlineData', 'fileData', 'executableCode',
    'codeExecutionResult', 'providerState',
  ] satisfies Array<keyof TurnPart>,
  functionCall: ['id', 'name', 'args'] satisfies Array<keyof TurnFunctionCall>,
  functionResponse: ['id', 'name', 'response'] satisfies Array<keyof TurnFunctionResponse>,
  actions: [
    'stateDelta', 'artifactDelta', 'requestedAuthConfigs', 'requestedToolConfirmations', 'skipSummarization',
    'transferToAgent', 'escalate', 'agentState', 'endOfAgent',
  ] satisfies Array<keyof TurnEventActions>,
  usageMetadata: [
    'promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount', 'cachedContentTokenCount',
    'toolUsePromptTokenCount',
  ] satisfies Array<keyof TurnUsage>,
  nodeInfo: ['path', 'outputFor', 'messageAsOutput'] satisfies Array<keyof TurnNodeInfo>,
};

test('every field stored in the fixtures is one TurnEvent declares, at every level', () => {
  const levels = Object.keys(DECLARED) as Array<keyof typeof DECLARED>;
  const seen = new Map(levels.map((level): [keyof typeof DECLARED, Set<string>] => [level, new Set()]));
  const note = (level: keyof typeof DECLARED, obj: object | undefined) => {
    for (const key of Object.keys(obj ?? {})) seen.get(level)!.add(key);
  };
  for (const { event } of everyStoredEvent()) {
    note('event', event);
    note('content', event.content);
    note('actions', event.actions);
    note('usageMetadata', event.usageMetadata);
    note('nodeInfo', event.nodeInfo);
    for (const part of event.content?.parts ?? []) {
      note('part', part);
      note('functionCall', part.functionCall);
      note('functionResponse', part.functionResponse);
    }
  }
  for (const [level, keys] of seen) {
    const undeclared = [...keys].filter((k) => !(DECLARED[level] as string[]).includes(k));
    assert.deepEqual(undeclared, [], `${level}: stored fields TurnEvent does not declare`);
  }
  // What the engine reads is really there to read.
  for (const key of ['id', 'invocationId', 'author', 'content', 'actions', 'turnComplete', 'timestamp', 'longRunningToolIds', 'usageMetadata']) {
    assert.ok(seen.get('event')!.has(key), `the fixtures store ${key}`);
  }
});

test('a TurnEvent is what ADK stores: ADK events and sessions are assignable to the engine types', async () => {
  // Compile-time: `npx tsc --noEmit` refuses these if the shapes drift apart.
  const adkEvents: AdkEvent[] = loadFixture('06-thought-signature', 'verbatim').sessions[0]!.events;
  const asTurnEvents: TurnEvent[] = adkEvents;
  const adk = new AdkInMemorySessionService();
  const created: AdkSession = await adk.createSession({ appName: 'a', userId: 'u', sessionId: 's' });
  const asSession: Session = created;
  assert.equal(asTurnEvents.length, 4);
  assert.equal(asSession.id, 's');
});

// ── Reading events as ADK does ───────────────────────────────────────────────

test('getFunctionCalls, getFunctionResponses and isFinal answer as ADK does on every fixture event', () => {
  let finals = 0;
  let calls = 0;
  let responses = 0;
  for (const { where, event } of everyStoredEvent()) {
    const adkEvent = asAdk(structuredClone(event));
    assert.deepEqual(getFunctionCalls(event), adkGetFunctionCalls(adkEvent), `${where}: calls`);
    assert.deepEqual(getFunctionResponses(event), adkGetFunctionResponses(adkEvent), `${where}: responses`);
    assert.equal(isFinal(event), adkIsFinalResponse(adkEvent), `${where}: final`);
    finals += isFinal(event) ? 1 : 0;
    calls += getFunctionCalls(event).length;
    responses += getFunctionResponses(event).length;
  }
  assert.ok(finals > 0 && calls > 0 && responses > 0, 'the fixtures exercise each answer');
});

test('the helpers return the parts’ own call and response objects, in order', () => {
  const a = { name: 'a', args: {}, id: '1' };
  const b = { name: 'b', args: {}, id: '2' };
  const event = createTurnEvent({ content: { role: 'model', parts: [{ functionCall: a }, { text: 'x' }, { functionCall: b }] } });
  const got = getFunctionCalls(event);
  assert.equal(got[0], a);
  assert.equal(got[1], b);
  assert.deepEqual(getFunctionCalls(createTurnEvent()), []);
});

test('isFinal matches ADK on every way an event can end, or not end, a run', () => {
  const call = { functionCall: { name: 'lookup', args: {}, id: 'c1' } };
  const response = { functionResponse: { name: 'lookup', id: 'c1', response: { result: 'ok' } } };
  const cases: Array<[string, TurnEventInit, boolean]> = [
    ['plain text', { content: { role: 'model', parts: [{ text: 'done' }] } }, true],
    ['no content (a workflow pause marker)', { longRunningToolIds: [] }, true],
    ['a streaming fragment', { partial: true, content: { role: 'model', parts: [{ text: 'do' }] } }, false],
    ['a tool call', { content: { role: 'model', parts: [call] } }, false],
    ['a tool response', { content: { role: 'user', parts: [response] } }, false],
    ['a response that skips summarization', { content: { role: 'user', parts: [response] }, actions: { skipSummarization: true } }, true],
    ['a call that waits for a person', { content: { role: 'model', parts: [call] }, longRunningToolIds: ['c1'] }, true],
    ['a tool asking for auth', { content: { role: 'user', parts: [response] }, actions: { requestedAuthConfigs: { c1: {} } } }, true],
    ['an empty auth request', { content: { role: 'user', parts: [response] }, actions: { requestedAuthConfigs: {} } }, false],
    ['a trailing code execution result', { content: { role: 'model', parts: [{ codeExecutionResult: { outcome: 'OUTCOME_OK', output: '2' } }] } }, false],
    ['a code result followed by text', { content: { role: 'model', parts: [{ codeExecutionResult: { output: '2' } }, { text: 'it is 2' }] } }, true],
    ['a partial that skips summarization', { partial: true, actions: { skipSummarization: true } }, true],
  ];
  for (const [label, init, expected] of cases) {
    const event = createTurnEvent({ id: 'evfixed1', timestamp: 1, ...init });
    assert.equal(isFinal(event), expected, label);
    assert.equal(adkIsFinalResponse(adkEventFrom(init)), expected, `${label} (ADK)`);
  }
  assert.equal(hasTrailingCodeExecutionResult(createTurnEvent({ content: { parts: [] } })), false);
});

// ── Making events as ADK does ────────────────────────────────────────────────

test('createTurnEvent builds the JSON ADK’s createEvent builds, key order included', () => {
  const inits: TurnEventInit[] = [
    { id: 'abcdEFG1', timestamp: 1767225600000 },
    { author: 'user', invocationId: 'e-1', content: { role: 'user', parts: [{ text: 'hi' }] }, id: 'abcdEFG2', timestamp: 2 },
    { invocationId: 'e-1', author: 'Analyst', id: 'abcdEFG3', timestamp: 3, content: { role: 'model', parts: [{ text: 'x' }] }, turnComplete: true, usageMetadata: { promptTokenCount: 4 } },
    { id: 'abcdEFG4', timestamp: 4, actions: { stateDelta: { k: 1 }, skipSummarization: true }, longRunningToolIds: ['c1'], branch: 'Boss.Scout' },
  ];
  for (const init of inits) {
    const ours = createTurnEvent(structuredClone(init));
    const theirs = adkEventFrom(init);
    assert.equal(JSON.stringify(ours), JSON.stringify(theirs));
  }
  const fresh = createTurnEvent();
  assert.match(fresh.id, /^[A-Za-z0-9]{8}$/);
  assert.equal(fresh.invocationId, '');
  assert.deepEqual(fresh.actions, { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {} });
  assert.deepEqual(fresh.longRunningToolIds, []);
  assert.ok(Math.abs(fresh.timestamp - Date.now()) < 5_000);
  assert.deepEqual(createEventActions({ escalate: true }), { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {}, escalate: true });
  const ids = new Set(Array.from({ length: 2_000 }, newEventId));
  assert.equal(ids.size, 2_000, 'ids do not repeat');
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{8}$/);
});

// ── Parsing ──────────────────────────────────────────────────────────────────

test('the parse names the field it cannot read, and the type it found, never the value', () => {
  const good = () =>
    ({
      id: 'ev000001',
      invocationId: 'e-1',
      author: 'Boss',
      actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {} },
      content: { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'x' }, id: 'c1' } }] },
      longRunningToolIds: [],
      timestamp: 1767225600000,
    }) as Record<string, any>;
  assert.equal(parseTurnEvent(good()).id, 'ev000001');

  const rejects = (mutate: (e: Record<string, any>) => unknown, path: string, problem: RegExp) => {
    const e = good();
    mutate(e);
    assert.throws(
      () => parseTurnEvents([good(), e]),
      (err: unknown) => err instanceof TurnEventError && err.path === path && problem.test(err.message) && !err.message.includes('secret-value'),
      path,
    );
  };
  rejects((e) => delete e.id, 'events[1].id', /required, but absent/);
  rejects((e) => delete e.actions, 'events[1].actions', /required/);
  rejects((e) => (e.timestamp = 'secret-value'), 'events[1].timestamp', /expected a finite number, got a string/);
  rejects((e) => (e.author = 7), 'events[1].author', /expected a string, got a number/);
  rejects((e) => (e.content.parts = 'secret-value'), 'events[1].content.parts', /expected an array, got a string/);
  rejects((e) => (e.content.parts[0] = null), 'events[1].content.parts[0]', /expected an object, got null/);
  rejects((e) => (e.content.parts[0].functionCall.name = 3), 'events[1].content.parts[0].functionCall.name', /a string/);
  rejects((e) => (e.content.parts[0].functionCall.args = 'secret-value'), 'events[1].content.parts[0].functionCall.args', /an object/);
  rejects((e) => (e.longRunningToolIds = ['c1', 2]), 'events[1].longRunningToolIds[1]', /a string/);
  rejects((e) => (e.actions.stateDelta = []), 'events[1].actions.stateDelta', /expected an object, got an array/);
  rejects((e) => (e.actions.artifactDelta = { 'a.png': '1' }), 'events[1].actions.artifactDelta.a.png', /a finite number/);
  rejects((e) => (e.usageMetadata = { promptTokenCount: '12' }), 'events[1].usageMetadata.promptTokenCount', /a finite number/);
  rejects((e) => (e.errorCode = 500), 'events[1].errorCode', /a string/);
  rejects((e) => (e.partial = 'no'), 'events[1].partial', /a boolean/);
  rejects((e) => (e.route = [{}]), 'events[1].route[0]', /a string, number or boolean/);
  assert.throws(() => parseTurnEvents({}), (err: unknown) => err instanceof TurnEventError && err.path === 'events');
  assert.throws(() => parseTurnEvent('{"id":1}', 'row'), (err: unknown) => err instanceof TurnEventError && err.path === 'row');
});

test('the parse carries every field it does not declare, in place, and accepts what ADK may write', () => {
  const stored = {
    invocationId: 'e-1',
    author: 'Boss',
    interactionId: 'carried',
    actions: { stateDelta: {}, artifactDelta: { 'a.png': 2 }, customMetadata: { carried: true } },
    content: {
      role: 'model',
      parts: [
        { text: 'see', videoMetadata: { fps: 2 } },
        { toolCall: { name: 'camelCase', args: {} } },
        { functionResponse: { id: 'c1', name: 'list', response: ['an', 'array'] } },
        { providerState: { provider: 'anthropic', kind: 'thinking_blocks', payload: [{ signature: 's' }] }, text: 'x' },
      ],
    },
    id: 'ev000009',
    timestamp: 9,
    errorCode: 'STOP',
    customMetadata: { 'responses.server_tool_calls': 1 },
    route: ['a', 2, true],
    output: null,
  };
  const before = JSON.stringify(stored);
  const parsed = parseTurnEvent(stored);
  assert.equal(parsed, stored, 'the same object, not a copy');
  assert.equal(JSON.stringify(parsed), before, 'nothing added, dropped or reordered');
  // An in-memory event's undefined fields count as absent.
  assert.doesNotThrow(() => parseTurnEvent(createTurnEvent()));
});

// ── Sessions: the rules ──────────────────────────────────────────────────────

const KEY = { appName: 'app', userId: 'user', sessionId: 'conv' };
const ev = (id: string, timestamp: number, init: TurnEventInit = {}) =>
  createTurnEvent({ id, timestamp, invocationId: 'e-1', author: 'user', content: { role: 'user', parts: [{ text: id }] }, ...init });
const newSession = (): Session => ({ id: 'conv', appName: 'app', userId: 'user', state: {}, events: [], lastUpdateTime: 0 });

test('applyEvent applies state as ADK’s base service does, and never changes the given event', async () => {
  const sequence = [
    ev('e1', 10, { actions: { stateDelta: { draft: 'v1', 'temp:scratch': 1 } } }),
    ev('e2', 20, { actions: { stateDelta: { draft: 'v2', count: 1 } } }),
    ev('e3', 30, { partial: true, actions: { stateDelta: { draft: 'never' } } }),
    ev('e1', 40, { actions: { stateDelta: { replaced: true } } }),
  ];
  const ours = newSession();
  const given = structuredClone(sequence);
  const stored = given.map((e) => applyEvent(ours, e));
  assert.deepEqual(given, sequence, 'the given events are unchanged');
  assert.equal(stored[2], given[2], 'a partial event comes back as it is');
  assert.deepEqual(stored[0]!.actions.stateDelta, { draft: 'v1' }, 'the stored event loses its temp: keys');
  assert.equal(stored[1], given[1], 'an event with nothing to drop is stored as given');

  const adk = new AdkInMemorySessionService();
  const theirs = await adk.createSession({ appName: 'app', userId: 'user', sessionId: 'conv' });
  for (const e of structuredClone(sequence)) await adk.appendEvent({ session: theirs, event: asAdk(e) });
  assert.equal(JSON.stringify(ours.events), JSON.stringify(theirs.events), 'the same events, in the same order and shape');
  assert.deepEqual({ ...ours.state }, { ...theirs.state });
  assert.deepEqual(ours.state, { draft: 'v2', count: 1, replaced: true });
  assert.equal(ours.lastUpdateTime, 40);
  assert.deepEqual(ours.events.map((e) => e.id), ['e1', 'e2'], 'the same id replaces its event in place');
});

test('a delta key named __proto__ is stored as state, not as the state object’s prototype', () => {
  const session = newSession();
  const delta = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<string, unknown>;
  applyEvent(session, ev('p1', 1, { actions: { stateDelta: delta } }));
  assert.equal(Object.getPrototypeOf(session.state), Object.prototype);
  assert.equal((session.state as { polluted?: unknown }).polluted, undefined);
  assert.deepEqual(Object.keys(session.state), ['__proto__', 'ok']);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  assert.deepEqual(Object.keys(withoutTempKeys(delta)), ['__proto__', 'ok']);
  assert.equal(TEMP_STATE_PREFIX, 'temp:');
});

test('selectEvents: strictly after the timestamp, then the newest N', () => {
  const events = [ev('a', 10), ev('b', 20), ev('c', 30), ev('d', 40)];
  const ids = (es: TurnEvent[]) => es.map((e) => e.id);
  assert.deepEqual(ids(selectEvents(events)), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(selectEvents(events, { afterTimestamp: 20 })), ['c', 'd'], 'an event at the timestamp itself is not after it');
  assert.deepEqual(ids(selectEvents(events, { numRecentEvents: 3 })), ['b', 'c', 'd']);
  assert.deepEqual(ids(selectEvents(events, { afterTimestamp: 10, numRecentEvents: 1 })), ['d']);
  assert.deepEqual(ids(selectEvents(events, { afterTimestamp: 35, numRecentEvents: 3 })), ['d'], 'the filter applies before the count');
  assert.deepEqual(ids(selectEvents(events, { numRecentEvents: 0, afterTimestamp: 0 })), ['a', 'b', 'c', 'd'], 'zero asks for nothing');
  assert.deepEqual(ids(selectEvents(events, { numRecentEvents: -2 })), ['a', 'b', 'c', 'd']);
});

test('list paging: the arithmetic the durable stores use', () => {
  assert.deepEqual(listWindow({}), { offset: 0 });
  assert.deepEqual(listPage(2, {}), { page: 1, limit: 2, totalItems: 2, totalPages: 1 }, 'no paging is one page of everything');
  assert.deepEqual(listWindow({ limit: 10, page: 3, offset: 99 }), { offset: 20, limit: 10 }, 'page wins over offset');
  assert.deepEqual(listPage(25, { limit: 10, page: 3, offset: 99 }), { page: 3, limit: 10, totalItems: 25, totalPages: 3 });
  assert.deepEqual(listWindow({ limit: 3, offset: 6 }), { offset: 6, limit: 3 });
  assert.deepEqual(listPage(7, { limit: 3, offset: 6 }), { page: 3, limit: 3, totalItems: 7, totalPages: 3 }, 'a partial last page counts');
  assert.deepEqual(listPage(0, { limit: 5 }), { page: 1, limit: 5, totalItems: 0, totalPages: 1 }, 'at least one page');
  assert.deepEqual(listWindow({ page: 2, offset: 4 }), { offset: 4 }, 'page without a limit is ignored');
  assert.deepEqual(listWindow({ limit: 5, page: 0 }), { offset: 0, limit: 5 }, 'page counts from 1');
  assert.deepEqual(listWindow({ offset: -3 }), { offset: 0 });
});

// ── Sessions: the in-process store ───────────────────────────────────────────

test('InProcessSessionService: create, and create again on the same id', async () => {
  const sessions: SessionService = new InProcessSessionService({ now: () => 1_000 });
  const generated = await sessions.create({ appName: 'app', userId: 'user' });
  assert.match(generated.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(generated.lastUpdateTime, 1_000);

  const created = await sessions.create({ ...KEY, state: { kept: 1, 'temp:dropped': 2 } });
  assert.deepEqual(JSON.parse(JSON.stringify(created)), { id: 'conv', appName: 'app', userId: 'user', state: { kept: 1 }, events: [], lastUpdateTime: 1_000 });
  await sessions.append(created, ev('e1', 5));
  const again = await sessions.create({ appName: 'app', userId: 'user', sessionId: 'conv', state: { other: true } });
  assert.deepEqual(again.events.map((e) => e.id), ['e1'], 'a second create keeps the conversation');
  assert.deepEqual(again.state, { kept: 1 });
});

test('InProcessSessionService: copies in and out, and append lands from every copy', async () => {
  const sessions = new InProcessSessionService();
  const turnA = await sessions.create({ appName: 'app', userId: 'user', sessionId: 'conv' });
  const turnB = (await sessions.get(KEY))!;
  const first = ev('a1', 10, { actions: { stateDelta: { owner: 'A', 'temp:t': 1 } } });
  const stored = await sessions.append(turnA, first);
  assert.deepEqual(stored.actions.stateDelta, { owner: 'A' });
  assert.deepEqual(first.actions.stateDelta, { owner: 'A', 'temp:t': 1 }, 'the caller’s event is unchanged');
  assert.deepEqual(turnA.state, { owner: 'A' }, 'the caller’s session is updated');
  await sessions.append(turnB, ev('b1', 20, { actions: { stateDelta: { other: 'B' } } }));
  assert.equal(await sessions.append(turnA, ev('a2', 30, { partial: true })).then((e) => e.partial), true);

  const held = (await sessions.get(KEY))!;
  assert.deepEqual(held.events.map((e) => e.id), ['a1', 'b1'], 'both copies’ events land; the partial one does not');
  assert.deepEqual(held.state, { owner: 'A', other: 'B' });
  assert.equal(held.lastUpdateTime, 20);

  held.events.push(ev('x', 99));
  held.state.owner = 'mutated';
  stored.actions.stateDelta!.owner = 'mutated';
  const reread = (await sessions.get(KEY))!;
  assert.deepEqual(reread.events.map((e) => e.id), ['a1', 'b1'], 'a returned session is a copy');
  assert.equal(reread.state.owner, 'A');
  assert.equal(reread.events[0]!.actions.stateDelta!.owner, 'A', 'the store keeps its own copy of an appended event');
  assert.deepEqual((await sessions.get(KEY, { numRecentEvents: 1 }))!.events.map((e) => e.id), ['b1']);
  assert.deepEqual((await sessions.get(KEY, { afterTimestamp: 10 }))!.events.map((e) => e.id), ['b1']);
});

test('InProcessSessionService: get, delete and append on sessions it does not hold', async () => {
  const sessions = new InProcessSessionService();
  assert.equal(await sessions.get(KEY), undefined);
  await sessions.delete(KEY);
  const orphan = newSession();
  await sessions.append(orphan, ev('o1', 7));
  const kept = (await sessions.get(KEY))!;
  assert.deepEqual(kept.events.map((e) => e.id), ['o1'], 'an append to a session it does not hold keeps the caller’s session');
  await sessions.delete(KEY);
  assert.equal(await sessions.get(KEY), undefined);
  const other = await sessions.create({ appName: 'app', userId: 'user:with:colons', sessionId: 'conv' });
  assert.equal((await sessions.get({ appName: 'app', userId: 'user:with:colons', sessionId: 'conv' }))?.id, other.id);
  assert.equal(await sessions.get({ appName: 'app:user', userId: 'with:colons', sessionId: 'conv' }), undefined, 'keys cannot collide through a colon');
});

test('InProcessSessionService: list filters, orders, pages, and leaves events out', async () => {
  let clock = 0;
  const sessions = new InProcessSessionService({ now: () => ++clock });
  for (const [userId, sessionId] of [['u1', 's3'], ['u1', 's1'], ['u2', 's2'], ['u1', 's4']] as const) {
    const s = await sessions.create({ appName: 'app', userId, sessionId, state: { userId } });
    await sessions.append(s, ev(`${sessionId}-e`, sessionId === 's4' ? 2 : 100));
  }
  await sessions.create({ appName: 'other', userId: 'u1', sessionId: 's9' });

  const all = await sessions.list({ appName: 'app' });
  assert.deepEqual(all.sessions.map((s) => s.id), ['s3', 's1', 's2', 's4'], 'every user, in insertion order');
  assert.ok(all.sessions.every((s) => s.events.length === 0), 'events are left out');
  assert.deepEqual(all.sessions[2]!.state, { userId: 'u2' });
  assert.deepEqual({ page: all.page, limit: all.limit, totalItems: all.totalItems, totalPages: all.totalPages }, { page: 1, limit: 4, totalItems: 4, totalPages: 1 });

  const u1 = await sessions.list({ appName: 'app', userId: 'u1', order: 'asc' });
  assert.deepEqual(u1.sessions.map((s) => s.id), ['s4', 's1', 's3'], 'by last update, ties by id');
  const desc = await sessions.list({ appName: 'app', userId: 'u1', order: 'desc', limit: 2, page: 2 });
  assert.deepEqual(desc.sessions.map((s) => s.id), ['s4']);
  assert.deepEqual({ page: desc.page, limit: desc.limit, totalItems: desc.totalItems, totalPages: desc.totalPages }, { page: 2, limit: 2, totalItems: 3, totalPages: 2 });
  const offset = await sessions.list({ appName: 'app', limit: 2, offset: 1 });
  assert.deepEqual(offset.sessions.map((s) => s.id), ['s1', 's2']);
  assert.deepEqual((await sessions.list({ appName: 'none' })).sessions, []);
});

test('every fixture replays through the in-process store unchanged, in both stored forms', async () => {
  for (const { name, fixture } of fixtureFilesOnDisk()) {
    const sessions = new InProcessSessionService();
    for (const row of fixture.sessions) {
      const session = await sessions.create({ appName: row.appName, userId: row.userId, sessionId: row.sessionId });
      for (const event of parseTurnEvents(structuredClone(row.events))) await sessions.append(session, event);
      const held = (await sessions.get({ appName: row.appName, userId: row.userId, sessionId: row.sessionId }))!;
      assert.equal(JSON.stringify(held.events), JSON.stringify(row.events), `${name}/${row.appName}: the events read back byte for byte`);
      assert.deepEqual(held.state, row.state, `${name}/${row.appName}: the state replayed from the events is the stored state`);
      assert.equal(held.lastUpdateTime, row.events.at(-1)!.timestamp);
    }
  }
});

// ── Memory ───────────────────────────────────────────────────────────────────

test('a MemoryService is ingest and search over one user’s silo; the extras are optional', async () => {
  const facts = new Map<string, string[]>();
  const memory: MemoryService = {
    async ingest(session, options) {
      const key = `${session.appName}/${session.userId}`;
      const said = session.events.flatMap((e) => (e.author === 'user' ? (e.content?.parts ?? []).map((p) => p.text ?? '') : []));
      facts.set(key, [...(facts.get(key) ?? []), ...said.map((t) => `${options?.extractionRules ?? ''}${t}`)]);
    },
    async search({ appName, userId, query }) {
      const memories: MemoryEntry[] = (facts.get(`${appName}/${userId}`) ?? [])
        .filter((f) => f.includes(query))
        .map((text) => ({ content: { role: 'user', parts: [{ text }] }, author: 'memory_service', timestamp: '2026-01-01T00:00:00.000Z' }));
      return { memories };
    },
  };
  const session = newSession();
  applyEvent(session, ev('likes tea', 1));
  await memory.ingest(session);
  assert.equal((await memory.search({ appName: 'app', userId: 'user', query: 'tea' })).memories.length, 1);
  assert.equal((await memory.search({ appName: 'app', userId: 'someone-else', query: 'tea' })).memories.length, 0, 'another user’s silo is not read');
  assert.equal(memory.deleteUserMemory, undefined);
});

// ── The leaf ─────────────────────────────────────────────────────────────────

test('the three modules load nothing at run time, and nothing they reach names @google/*', () => {
  const modules = ['lib/runtime/events.ts', 'lib/runtime/sessions.ts', 'lib/runtime/memoryService.ts'];
  for (const entry of modules) {
    assert.deepEqual(runtimeImportsOf(entry), [], `${entry}: every import is a type`);
    const graph = importGraph(entry);
    const files = [...graph.keys()].map((f) => path.relative(ROOT, f));
    const allowed = [...modules, 'lib/models/contract.ts', 'lib/models/providerState.ts'];
    assert.deepEqual(files.filter((f) => !allowed.includes(f)), [], `${entry}: reaches only the runtime interfaces and the model contract`);
    assert.deepEqual([...graph.values()].flat().filter((s) => !s.startsWith('.')), [], `${entry}: names no package`);
  }
  // Control: the scan sees a real runtime import and a type-only one.
  // ADK's values come through lib/adkPeer.ts, the one module that loads it (ADR 0102).
  assert.ok(runtimeImportsOf('lib/session/supabaseSessionService.ts').some((s) => s.includes('adkPeer.ts')));
  assert.ok(!runtimeImportsOf('lib/runtime/approvals.ts').some((s) => s.includes('@google/adk')), 'approvals.ts imports ADK as a type only');
});
