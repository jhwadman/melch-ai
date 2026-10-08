/**
 * tests/nativeQuestions.test.ts — questions (`ask_user`) directly on the
 * native loop (WS2-7b, lib/runtime/questions.ts, ADR 0079).
 *
 * A conversation runs on the ADK runtime (runSyndicateTurn, a scripted
 * adapter behind the shim): a turn whose model asks, then the answer, which
 * the turn runner stores as the call's function response. Then the same
 * conversation on runAgentLoop, each user event as ADK stored it. The stores
 * must hold the same events, ids and times aside: the loop pauses on the
 * open call, and the answer resumes the agent's own tool loop with no
 * request processor acting (ADK's request-input processor resumes node-tool
 * calls only). Then the question ADK stored in session fixture 04 (WS0-6),
 * answered on the loop and through runSyndicateTurn on native. Offline:
 * scripted adapters.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';
import type { Event } from '@google/adk';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/fallback.ts';
import type { TurnContent, TurnEvent } from '../lib/runtime/events.ts';
import { runAgentLoop } from '../lib/runtime/native/agentLoop.ts';
import type { AgentLoopEnd } from '../lib/runtime/native/agentLoop.ts';
import type { NativeAgent } from '../lib/runtime/native/request.ts';
import { SelfCorrection } from '../lib/runtime/native/selfCorrection.ts';
import { pendingQuestion, questionAnswerPart } from '../lib/runtime/questions.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { Session } from '../lib/runtime/sessions.ts';
import { drainAgentStream, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { resolveTools } from '../lib/toolRegistry.ts';
import { toolOf } from '../lib/tools/tool.ts';
import { APP as FIXTURE_APP, USER as FIXTURE_USER, scenario } from './fixtures/sessions/scenarios.ts';
import { conversation, loadFixture, seedSessions } from './helpers/sessionFixtures.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

setLogLevel(LogLevel.ERROR);

const APP = 'native-questions';
const USER = 'u1';
const SESSION = 's1';

const config = validateSyndicateConfig(
  { syndicate_name: APP, orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Help.', tools: ['ask_user'] }, subagents: [] },
  'test',
) as SyndicateYamlConfig;

/** The orchestrator as a NativeAgent (as tests/nativeLoop.test.ts builds one). */
function nativeAgentOf(o: SyndicateYamlConfig['orchestrator']): NativeAgent {
  return {
    name: o.name,
    model: o.model as string,
    instruction: o.instruction ?? '',
    tools: resolveTools(o.tools).map((t) => toolOf(t) ?? t),
    generateContentConfig: { toolConfig: { includeServerSideToolInvocations: true } },
  };
}

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Event ids and times, and ADK's own `adk-` call ids, are minted per run; everything else must match. */
const comparable = (events: TurnEvent[]): unknown =>
  JSON.parse(
    JSON.stringify(events.map((e) => ({ ...e, id: '<id>', timestamp: 0 }))),
    (_key, v) => (typeof v === 'string' && v.startsWith('adk-') ? '<adk-id>' : v),
  );

/** One turn on the native loop: the user event, then runAgentLoop under a turn control, drained as the turn runner drains it. */
async function nativeTurn(model: ScriptedModel, store: { sessions: InProcessSessionService; session: Session }, userEvent: TurnEvent, agent = nativeAgentOf(config.orchestrator)): Promise<AgentLoopEnd> {
  await store.sessions.append(store.session, structuredClone(userEvent));
  const control = createTurnControl({ maxLlmCalls: 50 });
  try {
    return await runWithTurnControl(control, async () => {
      const loop = runAgentLoop(agent, {
        session: store.session,
        sessions: store.sessions,
        invocationId: userEvent.invocationId,
        userContent: userEvent.content as TurnContent,
        selfCorrection: new SelfCorrection(),
        adapterFor: () => model as ModelAdapter,
        log: () => {},
      });
      let done: AgentLoopEnd | undefined;
      const tap = (async function* () {
        for (;;) {
          const next = await loop.next();
          if (next.done) return void (done = next.value);
          yield next.value;
        }
      })();
      await drainAgentStream(tap as any, { streamText: true });
      return done as AgentLoopEnd;
    });
  } finally {
    control.dispose();
  }
}

async function nativeStore(appName: string, userId: string, sessionId: string, events: TurnEvent[] = []) {
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName, userId, sessionId });
  for (const event of structuredClone(events)) await sessions.append(session, event);
  return { sessions, session };
}

const askThenUse: ModelScript = (req, n) =>
  n === 1 ? toolCall('ask_user', { question: 'Which account?', options: ['personal', 'work'] }, 'call-ask') : answer(`using ${JSON.stringify(lastToolResult(req)?.result)}`);

test('ask, then answer: the loop pauses on the open call, the answer resumes its tool loop, and it stores what ADK stores', async () => {
  resetCircuits();
  const adkModel = new ScriptedModel('scripted/boss', askThenUse);
  const sessionService = new InMemorySessionService();
  for (const text of ['pay the invoice', 'work']) {
    const result = await runSyndicateTurn({
      config,
      parts: [{ text }],
      appName: APP,
      userId: USER,
      sessionId: SESSION,
      sessionService,
      compile: { resolveModel: shimResolver({ boss: adkModel }), log: () => {} },
      trace: false,
    });
    assert.equal(result.status, text === 'work' ? 'completed' : 'input-required');
  }
  const adkEvents = json((await sessionService.getSession({ appName: APP, userId: USER, sessionId: SESSION }))?.events ?? []) as unknown as TurnEvent[];
  const [asked, answered] = adkEvents.filter((e) => e.author === 'user') as [TurnEvent, TurnEvent];
  assert.deepEqual(answered.content?.parts, [questionAnswerPart('call-ask', 'work')], 'the turn runner stored the answer as the call’s response');

  resetCircuits();
  const model = new ScriptedModel('scripted/boss', askThenUse);
  const store = await nativeStore(APP, USER, SESSION);
  const ends = [await nativeTurn(model, store, asked)];
  const opened = json(store.session.events);
  assert.equal(pendingQuestion(opened as unknown as Event[])?.id, 'call-ask');
  assert.deepEqual(ends[0]?.pending, ['call-ask']);
  ends.push(await nativeTurn(model, store, answered));
  assert.deepEqual(ends.map((e) => e.reason), ['paused', 'final']);
  assert.equal(model.calls, 2, 'the resume did not start the turn over');

  // The resumed step reads the call and its answer side by side.
  const resumedRequest = model.requests[1]!;
  const roles = resumedRequest.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-2), ['assistant', 'tool']);
  assert.deepEqual(lastToolResult(resumedRequest), { type: 'toolResult', id: 'call-ask', name: 'ask_user', result: 'work' });

  const nativeEvents = json((await store.sessions.get({ appName: APP, userId: USER, sessionId: SESSION }))?.events ?? []);
  assert.deepEqual(comparable(nativeEvents), comparable(adkEvents), 'the stored events');
  assert.equal(nativeEvents.at(-1)?.content?.parts?.[0]?.text, 'using "work"');
  assert.equal(pendingQuestion(nativeEvents as unknown as Event[]), undefined);
});

test('fixture 04: a question ADK stored is answered on the native loop, and through runSyndicateTurn on native, as ADK answers it', async () => {
  const f = loadFixture('04-open-question');
  const s = scenario(f.fixture);
  const row = conversation(f);
  const question = pendingQuestion(row.events);
  assert.ok(question);
  assert.match(question.id, /^adk-/, 'the model gave no id; ADK minted one');
  const script: ModelScript = (req) => answer(`using ${JSON.stringify(lastToolResult(req)?.result)}`);
  const turn = (runtime: 'adk' | 'native', model: ScriptedModel, sessionService: InMemorySessionService) =>
    runSyndicateTurn({
      config: s.config,
      parts: [{ text: 'work' }],
      appName: FIXTURE_APP,
      userId: FIXTURE_USER,
      sessionId: s.sessionId,
      sessionService,
      compile: { resolveModel: shimResolver({ boss: model }), log: () => {} },
      trace: false,
      runtime,
    });
  const storedAfter = async (service: InMemorySessionService) =>
    json((await service.getSession({ appName: FIXTURE_APP, userId: FIXTURE_USER, sessionId: s.sessionId }))?.events ?? []) as unknown as TurnEvent[];

  const adkModel = new ScriptedModel('scripted/boss', script);
  const adkStore = (await seedSessions(f)) as InMemorySessionService;
  const adkResult = await turn('adk', adkModel, adkStore);
  assert.equal(adkResult.status, 'completed', adkResult.error?.message);
  assert.equal(adkResult.text, 'using "work"');
  const adkEvents = await storedAfter(adkStore);

  // Through the turn runner on native.
  const turnModel = new ScriptedModel('scripted/boss', script);
  const turnStore = (await seedSessions(f)) as InMemorySessionService;
  const nativeResult = await turn('native', turnModel, turnStore);
  assert.equal(nativeResult.status, 'completed', nativeResult.error?.message);
  assert.equal(nativeResult.text, adkResult.text);
  assert.equal(turnModel.calls, 1);
  const withoutInvocation = (events: TurnEvent[]) => events.map((e) => ({ ...e, invocationId: '<inv>' }));
  assert.deepEqual(comparable(withoutInvocation(await storedAfter(turnStore))), comparable(withoutInvocation(adkEvents)), 'the stored events (turn runner)');

  // Directly on the loop, the answer as ADK stored it.
  const loopModel = new ScriptedModel('scripted/boss', script);
  const store = await nativeStore(FIXTURE_APP, FIXTURE_USER, s.sessionId, row.events as unknown as TurnEvent[]);
  const answerEvent = structuredClone(adkEvents[row.events.length]) as TurnEvent;
  assert.equal(answerEvent.author, 'user');
  assert.deepEqual(answerEvent.content?.parts, [questionAnswerPart(question.id, 'work')]);
  const end = await nativeTurn(loopModel, store, answerEvent, nativeAgentOf(s.config.orchestrator));
  assert.equal(end.reason, 'final');
  assert.equal(loopModel.calls, 1, 'the agent resumed its tool loop; it did not start over');
  // ADK's own `adk-` id never reaches the provider (history.ts); the mapping names the pair as it does on ADK.
  const read = lastToolResult(loopModel.requests[0]!);
  assert.deepEqual({ name: read?.name, result: read?.result }, { name: 'ask_user', result: 'work' });
  assert.deepEqual(loopModel.requests[0], adkModel.requests[0], 'the resumed step sent what ADK sent');
  const loopEvents = json((await store.sessions.get({ appName: FIXTURE_APP, userId: FIXTURE_USER, sessionId: s.sessionId }))?.events ?? []);
  assert.deepEqual(comparable(loopEvents), comparable(adkEvents), 'the stored events (loop)');
});
