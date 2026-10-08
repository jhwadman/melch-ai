/**
 * tests/sessionFixtures.test.ts — the ADK session compatibility fixtures
 * (tests/fixtures/sessions, written by generate.ts there) read and resumed on
 * today's runtime. They are frozen copies of the rows production stores in
 * adk_sessions.events and adk_session_events, which nothing migrates: any
 * runtime that serves those conversations must pass this suite unchanged.
 * Every resume runs on both runtimes (tests/helpers/runtime.ts): ADR 0045's
 * stop rule keeps the default on adk while an ADK-written fixture fails to
 * resume under native. The workflow fixture resumes under native through
 * the engine's scheduler (ADR 0095). Scripted models, in-memory sessions,
 * no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogLevel, setLogLevel } from '@google/adk';
import type { BaseSessionService } from '@google/adk';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { MessagePart } from '../lib/runtime/syndicateTurn.ts';
import { APPROVAL_REQUEST, approvalResponsePart, pendingApproval } from '../lib/runtime/approvals.ts';
import { ASK_USER, pendingQuestion } from '../lib/runtime/questions.ts';
import { DEFAULT_MAX_STORED_PAYLOAD_CHARS, SKIP_SIGNATURE } from '../lib/session/transcript.ts';
import { INPUT_REQUEST } from '../lib/workflow.ts';
import { APP, FETCH_FILING, FILING, SEND_NOTE, THOUGHT_SIGNATURE, USER, scenario, scenarios, sentNotes } from './fixtures/sessions/scenarios.ts';
import { conversation, fixtureFiles, loadFixture, pendingWorkflowInput, seedSessions } from './helpers/sessionFixtures.ts';
import type { SessionFixture } from './helpers/sessionFixtures.ts';
import { scriptedResolver, sentTexts } from './helpers/scriptedLlm.ts';
import { forEachRuntime, runtimeOption } from './helpers/runtime.ts';

setLogLevel(LogLevel.ERROR);

const parts = (e: { content?: { parts?: unknown[] } }) => (e.content?.parts ?? []) as Array<Record<string, any>>;

/** Run one more turn of a fixture's conversation on a session service seeded from it. */
async function resume(fixture: SessionFixture, message: MessagePart[]) {
  const s = scenario(fixture.fixture);
  const models = s.models();
  const sessionService: BaseSessionService = await seedSessions(fixture);
  const result = await runSyndicateTurn({
    ...runtimeOption(),
    config: s.config,
    parts: message,
    appName: APP,
    userId: USER,
    sessionId: s.sessionId,
    sessionService,
    compile: { resolveModel: scriptedResolver(models) },
    trace: false,
  });
  return { result, models, sessionService };
}

test('every scenario has its fixture on disk, and nothing else is there', () => {
  const expected = scenarios.flatMap((s) => [s.name, ...(s.verbatimToo ? [`${s.name}.verbatim`] : [])]).sort();
  assert.deepEqual(fixtureFiles(), expected);
});

test('every fixture parses into stored rows with normalized ids and timestamps', () => {
  for (const name of fixtureFiles()) {
    const [base, form] = name.endsWith('.verbatim') ? [name.replace(/\.verbatim$/, ''), 'verbatim' as const] : [name, 'trimmed' as const];
    const f = loadFixture(base, form);
    assert.equal(f.fixture, base);
    assert.equal(f.storedForm, form);
    assert.ok(f.sessions.length > 0, `${name}: no session rows`);
    assert.equal(conversation(f).appName, APP, `${name}: the conversation's own row comes first`);
    const raw = JSON.stringify(f.sessions);
    for (const uuid of raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []) {
      assert.match(uuid, /^00000000-0000-4000-8000-\d{12}$/, `${name}: an id escaped normalization`);
    }
    for (const row of f.sessions) {
      assert.equal(row.userId, USER);
      assert.equal(row.sessionId, scenario(base).sessionId);
      assert.equal(row.events[0]?.author, 'user', `${name}/${row.appName}: a row opens with the user's message`);
      for (const e of row.events) {
        assert.match(e.id, /^ev\d{6}$/);
        assert.equal(typeof e.author, 'string');
        assert.match(e.invocationId, /^e-00000000-/);
        assert.equal(typeof e.timestamp, 'number');
      }
    }
  }
});

test('01 delegate: the subagent keeps its own row, under its name, on the conversation id', () => {
  const f = loadFixture('01-delegate');
  assert.deepEqual(f.sessions.map((s) => s.appName), [APP, 'Scout']);
  const calls = conversation(f).events.flatMap(parts).filter((p) => p.functionCall);
  assert.deepEqual(calls.map((p) => [p.functionCall.name, p.functionCall.args]), [['Scout', { request: 'look in the attic' }]]);
  assert.match(calls[0]!.functionCall.id, /^adk-/, 'ADK assigns the id Gemini leaves out');
  const scoutRow = f.sessions[1]!;
  assert.deepEqual(scoutRow.events.map((e) => e.author), ['user', 'Scout']);
  assert.equal(parts(scoutRow.events[0]!)[0]?.text, 'look in the attic', 'the subagent receives the request argument as its message');
});

test('02 plan-dispatch: only the route writes to the conversation; the classifier leaves no row', () => {
  const f = loadFixture('02-plan-dispatch');
  assert.equal(f.sessions.length, 1);
  assert.deepEqual(conversation(f).events.map((e) => e.author), ['user', 'Research']);
});

test('06 thought signature: trimmed rows keep a replayable call, verbatim rows keep the real signature', () => {
  const trimmed = conversation(loadFixture('06-thought-signature')).events;
  const verbatim = conversation(loadFixture('06-thought-signature', 'verbatim')).events;
  const callPart = (events: typeof trimmed) => events.flatMap(parts).find((p) => p.functionCall)!;
  assert.equal(callPart(trimmed).thoughtSignature, SKIP_SIGNATURE);
  assert.equal(callPart(verbatim).thoughtSignature, THOUGHT_SIGNATURE);
  const thought = (events: typeof trimmed) => events.flatMap(parts).find((p) => p.thought);
  assert.match(thought(trimmed)?.text ?? '', /Checking the quote/, 'the thought part itself is stored');
  const answer = (events: typeof trimmed) => parts(events.at(-1)!)[0]!;
  assert.equal(answer(trimmed).thoughtSignature, undefined, 'a text part loses its signature in the trimmed form');
  assert.equal(answer(verbatim).thoughtSignature, THOUGHT_SIGNATURE);
});

forEachRuntime('08 elided result: trimmed rows keep a paired marker, verbatim rows the whole result, and the next turn reads either', async () => {
  const size = JSON.stringify({ result: FILING }).length;
  assert.ok(size > DEFAULT_MAX_STORED_PAYLOAD_CHARS, 'the result is long enough to be trimmed');
  for (const form of ['trimmed', 'verbatim'] as const) {
    const f = loadFixture('08-elided-result', form);
    const events = conversation(f).events;
    const call = events.flatMap(parts).find((p) => p.functionCall)!.functionCall;
    const response = events.flatMap(parts).find((p) => p.functionResponse)!.functionResponse;
    assert.equal(response.id, call.id, `${form}: the result stays paired with its call`);
    assert.equal(response.name, FETCH_FILING);
    if (form === 'trimmed') {
      assert.deepEqual(Object.keys(response.response), ['elided']);
      assert.match(response.response.elided, new RegExp(`^${size.toLocaleString('en-US')} chars dropped before storage`));
      assert.ok(!JSON.stringify(f.sessions).includes('Standard disclosure text'), 'none of the result is stored');
    } else {
      assert.deepEqual(response.response, { result: FILING });
    }
    assert.equal(parts(events.at(-1)!)[0]?.text, 'From the filing: Net revenue for the quarter: 9.30B USD.', `${form}: the answer read from the result is stored`);

    // Outside plan-dispatch the stored session is read unprojected, so the
    // next turn's prompt replays the call and its result as stored: from the
    // trimmed form, the model is handed the marker in place of the result.
    const { result, models } = await resume(f, [{ text: 'and then?' }]);
    assert.equal(result.status, 'completed', `${form}: ${result.error?.message}`);
    const replayed = models.clerk!.requests[0]!.contents.flatMap((c) => c.parts ?? []).find((p) => p.functionResponse)?.functionResponse;
    assert.equal(replayed?.name, FETCH_FILING);
    assert.deepEqual(replayed?.response, response.response, `${form}: the next turn reads the stored result as stored`);
  }
});

forEachRuntime('03 open approval: found in the stored events, and an approval resumes the turn', async () => {
  const f = loadFixture('03-open-approval');
  const events = conversation(f).events;
  const pending = pendingApproval(events);
  assert.ok(pending, 'the approval is pending');
  assert.equal(pending.agent, 'Boss');
  assert.equal(pending.tool, SEND_NOTE);
  assert.deepEqual(pending.args, { to: 'ops@acme.test' });
  const request = events.flatMap(parts).find((p) => p.functionCall?.name === APPROVAL_REQUEST)!;
  assert.equal(pending.id, request.functionCall.id);
  assert.equal(pending.callId, request.functionCall.args.originalFunctionCall.id);

  sentNotes.length = 0;
  const { result, models } = await resume(f, [approvalResponsePart(pending.id, true)]);
  assert.equal(result.status, 'completed', result.error?.message);
  assert.deepEqual(sentNotes, ['ops@acme.test'], 'the pinned call ran once approved');
  assert.equal(result.text, 'done {"result":"sent to ops@acme.test"}');
  assert.equal(models.boss!.calls, 1, 'the agent resumed its tool loop; it did not start over');
});

forEachRuntime('04 open question: found in the stored events, and an answer resumes the turn', async () => {
  const f = loadFixture('04-open-question');
  const events = conversation(f).events;
  const question = pendingQuestion(events);
  assert.ok(question, 'the question is pending');
  assert.equal(question.node, 'Boss');
  assert.equal(question.message, 'Which account?');
  assert.deepEqual(question.payload, { options: ['personal', 'work'] });
  assert.equal(question.id, events.flatMap(parts).find((p) => p.functionCall?.name === ASK_USER)!.functionCall.id);

  const { result, models, sessionService } = await resume(f, [{ text: 'work' }]);
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.text, 'using {"result":"work"}');
  assert.equal(models.boss!.calls, 1);
  const after = await sessionService.getSession({ appName: APP, userId: USER, sessionId: scenario(f.fixture).sessionId });
  assert.equal(pendingQuestion(after!.events), undefined, 'answered');
});

forEachRuntime('05 workflow paused at ask_user: found in the stored events, and the next node sees the reply', async () => {
  const f = loadFixture('05-workflow-ask-user');
  const events = conversation(f).events;
  const input = pendingWorkflowInput(events);
  assert.ok(input, 'the workflow question is pending');
  assert.equal(input.node, 'Confirm');
  assert.equal(input.message, 'Publish?');
  assert.equal(input.payload, 'the draft');
  assert.equal(input.id, events.flatMap(parts).find((p) => p.functionCall?.name === INPUT_REQUEST)!.functionCall.args.interruptId);

  const { result, models, sessionService } = await resume(f, [{ text: 'yes' }]);
  assert.equal(result.status, 'completed', result.error?.message);
  assert.deepEqual(JSON.parse(result.text.replace(/^published /, '')), { reply: 'yes', input: 'the draft' });
  assert.equal(models.triage!.calls, 0, 'the graph resumed where it waited');
  assert.equal(models.publisher!.calls, 1);
  const after = await sessionService.getSession({ appName: APP, userId: USER, sessionId: scenario(f.fixture).sessionId });
  assert.equal(pendingWorkflowInput(after!.events), undefined, 'answered');
});

forEachRuntime('a completed conversation reads back: the answering agent sees what was said', async () => {
  // [fixture, the model that answers the next turn, what it must find in its history]
  const cases: Array<[SessionFixture, string, string[]]> = [
    [loadFixture('01-delegate'), 'boss', ['find the thing', 'Scout says: it is in the attic']],
    [loadFixture('02-plan-dispatch'), 'research', ['what do the sources say?', 'research answer: three sources agree']],
    [loadFixture('06-thought-signature'), 'analyst', ['where is MU trading?', 'Latest quote: MU: 104.20 USD.']],
    [loadFixture('06-thought-signature', 'verbatim'), 'analyst', ['where is MU trading?', 'Latest quote: MU: 104.20 USD.']],
    [loadFixture('07-two-turns'), 'solo', ['hello', 'first answer', 'again', 'second answer']],
    [loadFixture('08-elided-result'), 'clerk', ["what was MU's revenue last quarter?", 'From the filing: Net revenue for the quarter: 9.30B USD.']],
    [loadFixture('08-elided-result', 'verbatim'), 'clerk', ["what was MU's revenue last quarter?", 'From the filing: Net revenue for the quarter: 9.30B USD.']],
  ];
  for (const [f, answering, said] of cases) {
    const { result, models } = await resume(f, [{ text: 'and then?' }]);
    assert.equal(result.status, 'completed', `${f.fixture}: ${result.error?.message}`);
    const seen = sentTexts(models[answering]!.requests[0]!).join(' | ');
    for (const line of said) assert.ok(seen.includes(line), `${f.fixture} (${f.storedForm}): ${answering} never saw "${line}"`);
  }
});
