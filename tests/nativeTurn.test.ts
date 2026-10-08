/**
 * tests/nativeTurn.test.ts — runSyndicateTurn on the native runtime
 * (WS2-10, ADR 0073, ADR 0107).
 *
 * Each parity case runs a conversation through runSyndicateTurn and holds
 * it to the same conversation as ADK 2.2 ran it, with the same scripted
 * model behind the pre-1.0 shim, recorded in
 * tests/fixtures/adk-reference/nativeturn (tests/helpers/adkReference.ts):
 * the same result (status, text, usage, route, pause) and the same stored
 * events, ids and times aside. Then what native refuses before any model
 * call, an approval ADK opened (recorded) resumed through the turn runner, a
 * question answered, the run's temp: state, and the wiki agent runner.
 * Offline: scripted adapters only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter, ModelResponse } from '../lib/models/contract.ts';
import { unrunnableModelClass } from '../lib/compileNative.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { flushTracing, onSpanEnd } from '../lib/observability/tracer.ts';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { approvalResponsePart, pendingApproval } from '../lib/runtime/approvals.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { servedThroughShim } from '../lib/runtime/native/selfCorrection.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { UnsupportedOnRuntimeError, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { runWikiAgent } from '../lib/wiki/agentRun.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, streamedAnswer, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { adkReferences } from './helpers/adkReference.ts';

// ADK's side of each parity case, as ADK 2.2 recorded it (tests/fixtures/adk-reference/nativeturn).
const reference = adkReferences('nativeTurn');

/** The engine's in-memory store (ADR 0102). */
const engineSessions = () => new InProcessSessionService();

const APP = 'native-turn';
const USER = 'u1';

registerTool(
  'native_turn_lookup',
  defineTool({
    name: 'native_turn_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }, ctx) => {
      ctx?.state.set('temp:last_key', key);
      return `found ${key}`;
    },
  }),
  { override: true },
);
const sent: string[] = [];
registerTool(
  'native_turn_send',
  defineTool({
    name: 'native_turn_send',
    description: 'Send a note.',
    schema: z.object({ to: z.string() }),
    execute: async ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  }),
  { override: true },
);

function syndicate(orchestrator: Record<string, unknown>, extra: Record<string, unknown> = {}): SyndicateYamlConfig {
  return { syndicate_name: APP, orchestrator: { name: 'Solo', model: 'scripted/boss', instruction: 'Answer briefly.', ...orchestrator }, subagents: [], ...extra } as SyndicateYamlConfig;
}

type Models = Record<string, ModelScript>;

interface Turn {
  parts?: unknown[];
  /** The message, from the previous turn's result: an answer to the approval it opened. */
  answer?: (previous: SyndicateTurnResult) => unknown[];
  streaming?: boolean;
}

interface Run {
  results: SyndicateTurnResult[];
  events: TurnEvent[];
  models: Record<string, ScriptedModel>;
  deltas: string[][];
}

async function converse(config: SyndicateYamlConfig, scripts: Models, turns: Turn[]): Promise<Run> {
  resetCircuits();
  const models = Object.fromEntries(Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));
  const sessionService = engineSessions();
  const results: SyndicateTurnResult[] = [];
  const deltas: string[][] = [];
  for (const t of turns) {
    const d: string[] = [];
    deltas.push(d);
    results.push(
      await runSyndicateTurn({
        config,
        parts: (t.answer ? t.answer(results.at(-1) as SyndicateTurnResult) : (t.parts ?? [{ text: 'find the thing' }])) as any[],
        appName: APP,
        userId: USER,
        sessionId: 's1',
        sessionService,
        compile: { resolveModel: shimResolver(models), log: () => {} },
        trace: false,
        ...(t.streaming ? { streaming: true, events: { onTextDelta: (x: string) => d.push(x) } } : {}),
      }),
    );
  }
  const session = await sessionService.get({ appName: APP, userId: USER, sessionId: 's1' });
  return { results, events: JSON.parse(JSON.stringify(session?.events ?? [])) as TurnEvent[], models, deltas };
}

/** Event ids and times, invocation ids and ADK's own `adk-` call ids are minted per run; everything else must match. */
function comparable(events: TurnEvent[]): unknown {
  return JSON.parse(
    JSON.stringify(events.map((e) => ({ ...e, id: '<id>', timestamp: 0, invocationId: '<inv>' }))),
    (_key, v) => (typeof v === 'string' && v.startsWith('adk-') ? '<adk-id>' : v),
  );
}

/** What a surface reads from a result. */
function outcome(r: SyndicateTurnResult): unknown {
  return {
    status: r.status,
    text: r.text,
    error: r.error,
    usage: r.usage,
    route: r.route,
    relayFallback: r.relayFallback,
    approval: r.approval ? { agent: r.approval.agent, tool: r.approval.tool, args: r.approval.args } : undefined,
    input: r.input ? { node: r.input.node, message: r.input.message } : undefined,
    resumedSession: r.resumedSession,
    tools: r.answer ? [...r.answer.invokedToolNames].sort() : undefined,
  };
}

/** ADK's run as recorded: what assertParity compares, each model's system instructions, and what the send tool sent. */
interface AdkRun {
  outcomes: unknown[];
  events: TurnEvent[];
  calls: Record<string, number>;
  systems: Record<string, Array<string | undefined>>;
  deltas: string[][];
  sent: string[];
}

/** JSON's form of a value: what a recording holds (undefined-valued keys dropped). */
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * The conversation on native, held to ADK's recorded run of it (case
 * `name`): the same results, stored events, model calls and text deltas.
 * `sent` holds native's sends; ADK's are `adk.sent`.
 */
async function assertParity(name: string, config: SyndicateYamlConfig, scripts: Models, turns: Turn[] = [{}]): Promise<{ adk: AdkRun; native: Run }> {
  const adk = await reference<AdkRun>(name);
  const native = await converse(config, scripts, turns);
  assert.deepEqual(asJson(native.results.map(outcome)), adk.outcomes, 'the results');
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'the stored events');
  for (const key of Object.keys(scripts)) assert.equal(native.models[key]?.calls, adk.calls[key], `calls to ${key}`);
  assert.deepEqual(native.deltas, adk.deltas, 'the text deltas');
  return { adk, native };
}

// ── Parity ───────────────────────────────────────────────────────────────────

test('a single-agent syndicate answers through runSyndicateTurn on native, as on ADK, over two turns', async () => {
  const { native } = await assertParity(
    'single-agent-two-turns',
    syndicate({ globalInstruction: 'Be kind.' }),
    { boss: (_req, n) => answer(n === 1 ? 'first answer' : 'second answer', { inputTokens: 12, outputTokens: 5 }) },
    [{ parts: [{ text: 'hello' }] }, { parts: [{ text: 'again' }] }],
  );
  assert.equal(native.results[1]?.status, 'completed');
  assert.equal(native.results[1]?.text, 'second answer');
  assert.equal(native.results[1]?.resumedSession, true);
  assert.deepEqual(native.results[1]?.usage, { llmCalls: 1, inputTokens: 12, outputTokens: 5, thinkingTokens: 0 });
  assert.equal(native.models.boss?.requests[1]?.messages.length, 3, 'the second turn sees the first');
});

test('MELCHIZEDEK_RUNTIME=native selects the native runtime when the turn names none', async () => {
  const saved = process.env.MELCHIZEDEK_RUNTIME;
  process.env.MELCHIZEDEK_RUNTIME = 'native';
  try {
    const boss = new ScriptedModel('scripted/boss', () => answer('from the env'));
    const r = await runSyndicateTurn({
      config: syndicate({}),
      parts: [{ text: 'hi' }],
      appName: APP,
      userId: USER,
      sessionId: 'env',
      sessionService: engineSessions(),
      compile: { resolveModel: shimResolver({ boss }) },
      trace: false,
      // The native runtime refuses an agent transform before any model call: reaching it proves the env was read.
      transformAgent: (a) => a,
    }).catch((e: unknown) => e);
    assert.ok(r instanceof UnsupportedOnRuntimeError, 'the env chose native');
    assert.equal(boss.calls, 0);
    const answered = await runSyndicateTurn({
      config: syndicate({}),
      parts: [{ text: 'hi' }],
      appName: APP,
      userId: USER,
      sessionId: 'env2',
      sessionService: engineSessions(),
      compile: { resolveModel: shimResolver({ boss }) },
      trace: false,
    });
    assert.equal(answered.status, 'completed');
    assert.equal(answered.text, 'from the env');
  } finally {
    if (saved === undefined) delete process.env.MELCHIZEDEK_RUNTIME;
    else process.env.MELCHIZEDEK_RUNTIME = saved;
  }
});

test('parity: a tool call, its result and a streamed answer', async () => {
  await assertParity(
    'tool-call-and-streamed-answer',
    syndicate({ tools: ['native_turn_lookup'] }),
    { boss: (req, n) => (n === 1 ? toolCall('native_turn_lookup', { key: 'alpha' }, 'call-1') : streamedAnswer('got ', String(lastToolResult(req)?.result))) },
    [{ streaming: true }],
  );
});

test('parity: plan-dispatch runs the classifier and the route on native', async () => {
  const config = {
    syndicate_name: APP,
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      { name: 'Research', model: 'scripted/research', instruction: 'Research.', description: 'research' },
    ],
    dispatch: { default_route: 'Chat' },
  } as unknown as SyndicateYamlConfig;
  const { native } = await assertParity('plan-dispatch', config, {
    router: () => answer('{"route":"Research","reason":"needs sources"}'),
    chat: () => answer('chat answer'),
    research: (_req, n) => answer(`research answer ${n}`),
  }, [{}, { parts: [{ text: 'and more' }] }]);
  assert.equal(native.results[0]?.route?.route, 'Research');
  assert.equal(native.results[1]?.text, 'research answer 2');
});

test('parity: a gated call pauses the turn input-required, and the answer resumes it on native as on ADK (WS2-7a)', async () => {
  const config = syndicate({ instruction: 'Send notes.', tools: ['native_turn_send'], require_approval: ['native_turn_send'] });
  const script: ModelScript = (req, n) => (n === 1 ? toolCall('native_turn_send', { to: 'ops@acme.test' }, 'call-send') : answer(`done: ${JSON.stringify(lastToolResult(req)?.result)}`));
  for (const approved of [true, false]) {
    sent.length = 0;
    const { adk, native } = await assertParity(`gated-call-${approved ? 'approved' : 'rejected'}`, config, { boss: script }, [
      { parts: [{ text: 'tell ops' }] },
      { answer: (r) => [approvalResponsePart(r.approval!.id, approved)] },
    ]);
    assert.equal(native.results[0]?.status, 'input-required');
    assert.equal(native.results[1]?.status, 'completed', native.results[1]?.error?.message);
    assert.equal(native.results[1]?.text, approved ? 'done: "sent to ops@acme.test"' : 'done: "This tool call is rejected."');
    assert.deepEqual([...adk.sent, ...sent], approved ? ['ops@acme.test', 'ops@acme.test'] : [], 'the pinned call ran once on each side, only when approved');
  }
});

test('an approval ADK opened resumes through runSyndicateTurn, and the pinned call runs once', async () => {
  const config = syndicate({ instruction: 'Send notes.', tools: ['native_turn_send'], require_approval: ['native_turn_send'] });
  // The session as ADK left it after the first turn (recorded): the approval open.
  const adk = await reference<AdkRun>('gated-call-approved');
  const answerAt = adk.events.findIndex((e, i) => i > 0 && e.author === 'user');
  const opened = adk.events.slice(0, answerAt);
  const pending = pendingApproval(opened as unknown as Parameters<typeof pendingApproval>[0]);
  assert.ok(pending, 'ADK left the approval open');
  sent.length = 0;
  const boss = new ScriptedModel('scripted/boss', (req) => answer(`done: ${lastToolResult(req)?.result}`));
  const sessionService = engineSessions();
  const session = await sessionService.create({ appName: APP, userId: USER, sessionId: 'pause-adk' });
  for (const event of structuredClone(opened)) await sessionService.append(session, event);
  const resumed = await runSyndicateTurn({
    config,
    parts: [approvalResponsePart(pending.id, true)],
    appName: APP,
    userId: USER,
    sessionId: 'pause-adk',
    sessionService,
    compile: { resolveModel: shimResolver({ boss }) },
    trace: false,
  });
  assert.equal(resumed.status, 'completed', resumed.error?.message);
  assert.equal(resumed.text, 'done: sent to ops@acme.test');
  assert.deepEqual(sent, ['ops@acme.test'], 'opened on ADK, resumed on native');
  assert.equal(boss.calls, 1, 'the resume did not start the turn over');
});

test('parity: dispatch resumes the route that asked on native, the classifier skipped, as on ADK', async () => {
  const config = {
    syndicate_name: APP,
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      { name: 'Outreach', model: 'scripted/outreach', instruction: 'Send.', description: 'sends notes', tools: ['native_turn_send'], require_approval: ['native_turn_send'] },
    ],
    dispatch: { default_route: 'Chat' },
  } as unknown as SyndicateYamlConfig;
  sent.length = 0;
  const { adk, native } = await assertParity(
    'dispatch-resumes-route',
    config,
    {
      router: () => answer('{"route":"Outreach","reason":"a send"}'),
      chat: () => answer('chat'),
      outreach: (req, n) => (n === 1 ? toolCall('native_turn_send', { to: 'pr@acme.test' }, 'call-pr') : answer(`sent: ${lastToolResult(req)?.result}`)),
    },
    [{ parts: [{ text: 'email pr' }] }, { answer: (r) => [approvalResponsePart(r.approval!.id, true)] }],
  );
  assert.equal(native.results[1]?.route?.decidedBy, 'approval');
  assert.equal(native.models.router?.calls, 1, 'the classifier ran once, for the original message');
  assert.equal(native.results[1]?.text, 'sent: sent to pr@acme.test');
  assert.deepEqual([...adk.sent, ...sent], ['pr@acme.test', 'pr@acme.test'], 'once on each side');
});

test('parity: an ask_user call pauses the turn with the question, and the answer resumes it on native as on ADK (WS2-7b)', async () => {
  const config = syndicate({ instruction: 'Ask when unsure.', tools: ['ask_user'] });
  const script: ModelScript = (req, n) => (n === 1 ? toolCall('ask_user', { question: 'Which year?' }, 'call-ask') : answer(`in ${lastToolResult(req)?.result}`));
  const { native } = await assertParity('ask-user-pause', config, { boss: script }, [{}, { parts: [{ text: '1999' }] }]);
  assert.equal(native.results[0]?.status, 'input-required');
  assert.equal(native.results[0]?.input?.message, 'Which year?');
  assert.equal(native.results[1]?.status, 'completed', native.results[1]?.error?.message);
  assert.equal(native.results[1]?.text, 'in 1999');
});

test('parity: a temp: key a tool writes reaches the next step’s instruction, and no store keeps it', async () => {
  const config = syndicate({ instruction: 'Answer. Last key: {temp:last_key?}.', tools: ['native_turn_lookup'] });
  const { adk, native } = await assertParity('temp-key', config, {
    boss: (_req, n) => (n === 1 ? toolCall('native_turn_lookup', { key: 'alpha' }, 'call-1') : answer('done')),
  });
  for (const [systems, events] of [[adk.systems.boss!, adk.events], [native.models.boss!.requests.map((r) => r.system), native.events]] as const) {
    const [first, second] = systems;
    assert.match(first ?? '', /Last key: \.$/);
    assert.match(second ?? '', /Last key: alpha\.$/);
    assert.ok(!JSON.stringify(events).includes('temp:'), 'no stored event carries the temp: key');
  }
});

test('parity: a DELEGATE syndicate delegates to its subagent and relays the answer on native', async () => {
  const config = syndicate(
    { instruction: 'Delegate to Scout.' },
    { subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Find.', description: 'Finds things' }] },
  );
  const { native } = await assertParity('delegate', config, {
    boss: (req, n) => (n === 1 ? toolCall('Scout', { request: 'find the thing' }, 'call-scout') : answer(`relayed: ${lastToolResult(req)?.result}`)),
    scout: () => answer('the thing is here'),
  });
  assert.equal(native.results[0]?.text, 'relayed: the thing is here');
  assert.deepEqual(native.results[0]?.answer?.delegations, ['Scout']);
});

test('a resolver may answer an id with a model under another id: the request goes out under that id, as ADK sends it', async () => {
  // A gateway stand-in or a caller's alias: the YAML says scripted/boss, the
  // resolver returns a model whose own id is provider-model-x. ADK's LlmAgent
  // sent the request under the model's id, so the adapter (which chooses
  // thinking, replay and pricing by it) must see that id on native too.
  const seen: Record<string, string[]> = { adk: [], native: [] };
  const run = async (runtime: 'native') => {
    const boss = new ScriptedModel('provider-model-x', (req, n) => {
      seen[runtime]!.push(req.model);
      return n === 1 ? toolCall('Scout', { request: 'look' }, 'call-scout') : answer('done');
    });
    const scout = new ScriptedModel('provider-model-y', (req) => {
      seen[runtime]!.push(req.model);
      return answer('here');
    });
    const resolve = (id: string | undefined) => servedThroughShim(id === 'scripted/scout' ? scout : boss);
    const r = await runSyndicateTurn({
      config: syndicate({ instruction: 'Delegate to Scout.' }, { subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Find.', description: 'Finds' }] }),
      parts: [{ text: 'find it' }],
      appName: APP,
      userId: USER,
      sessionId: `alias-${runtime}`,
      sessionService: engineSessions(),
      compile: { resolveModel: resolve, log: () => {} },
      trace: false,
    });
    assert.equal(r.status, 'completed', `${runtime}: ${r.error?.message}`);
  };
  seen.adk = await reference<string[]>('resolver-alias');
  await run('native');
  assert.deepEqual(seen.adk, ['provider-model-x', 'provider-model-y', 'provider-model-x']);
  assert.deepEqual(seen.native, seen.adk);
});

/** An adapter that breaks the contract by throwing: after yielding `before`, if any. */
function throwingAdapter(model: string, error: Error, before: ModelResponse[] = []): ModelAdapter & { calls: number } {
  const adapter = {
    model,
    provider: 'scripted',
    calls: 0,
    async *generate() {
      adapter.calls += 1;
      for (const response of before) yield response;
      throw error;
    },
  };
  return adapter;
}

test('parity: an adapter that throws ends the step on ADK’s error event (UNKNOWN_ERROR, or a JSON body’s code), never a thrown turn', async () => {
  const cases: Array<[Error, string, string]> = [
    [Object.assign(new Error('HTTP 400'), { status: 400 }), 'UNKNOWN_ERROR', 'HTTP 400'],
    [new Error(JSON.stringify({ error: { code: 'QUOTA', message: 'over quota' } })), 'QUOTA', 'over quota'],
  ];
  for (const [error, code, message] of cases) {
    const run = async () => {
      const sessionService = engineSessions();
      const result = await runSyndicateTurn({
        config: syndicate({}),
        parts: [{ text: 'hello' }],
        appName: APP,
        userId: USER,
        sessionId: 's1',
        sessionService,
        compile: { resolveModel: () => servedThroughShim(throwingAdapter('scripted/boss', error)), log: () => {} },
        trace: false,
      });
      const session = await sessionService.get({ appName: APP, userId: USER, sessionId: 's1' });
      return { result, events: JSON.parse(JSON.stringify(session?.events ?? [])) as TurnEvent[] };
    };
    const adk = await reference<{ outcome: unknown; events: TurnEvent[] }>(`throwing-adapter-${code}`);
    const native = await run();
    assert.equal(native.result.status, 'failed');
    assert.deepEqual(native.result.error, { code, message });
    assert.deepEqual(asJson(outcome(native.result)), adk.outcome);
    assert.deepEqual(comparable(native.events), comparable(adk.events), 'the stored events');
    assert.equal(native.events.at(-1)?.errorCode, code);
  }
});

test('parity: with a fallback_model, a thrown provider failure is answered by the fallback; a stream that produced first is not', async () => {
  const fails = Object.assign(new Error('HTTP 503'), { status: 503 });
  for (const [label, before, backupCalls] of [
    ['before anything', [], 1],
    ['after an answer', [answer('half an answer')], 0],
  ] as const) {
    const runs: Record<string, { outcome: unknown; events: TurnEvent[]; calls: [number, number] }> = {};
    const run = async () => {
      resetCircuits();
      const primary = throwingAdapter('scripted/primary', fails, [...before]);
      const backup = new ScriptedModel('scripted/backup', () => answer('from the backup'));
      const sessionService = engineSessions();
      const result = await runSyndicateTurn({
        config: syndicate({ model: 'scripted/primary', fallback_model: 'scripted/backup' }),
        parts: [{ text: 'hello' }],
        appName: APP,
        userId: USER,
        sessionId: 's1',
        sessionService,
        compile: { resolveModel: (id) => servedThroughShim(id === 'scripted/backup' ? backup : primary), log: () => {} },
        trace: false,
      });
      const session = await sessionService.get({ appName: APP, userId: USER, sessionId: 's1' });
      return { outcome: asJson(outcome(result)), events: JSON.parse(JSON.stringify(session?.events ?? [])) as TurnEvent[], calls: [primary.calls, backup.calls] as [number, number] };
    };
    runs.adk = await reference<{ outcome: unknown; events: TurnEvent[]; calls: [number, number] }>(`fallback-${label}`);
    runs.native = await run();
    for (const side of ['adk', 'native'] as const) {
      const [primaryCalls, fallbackCalls] = runs[side]!.calls;
      assert.equal(primaryCalls, 1, `${side} ${label}`);
      assert.equal(fallbackCalls, backupCalls, `${side} ${label}: calls to the fallback`);
    }
    assert.deepEqual(runs.native!.outcome, runs.adk!.outcome, label);
    assert.deepEqual(comparable(runs.native!.events), comparable(runs.adk!.events), `${label}: the stored events`);
  }
  resetCircuits();
});

registerTool(
  'native_turn_broken',
  defineTool({
    name: 'native_turn_broken',
    description: 'Always fails.',
    schema: z.object({}),
    execute: async () => {
      throw new Error('the disk is full');
    },
  }),
  { override: true },
);

test('parity: self-correction answers a throwing tool with reflection guidance on native, from the YAML’s retries:', async () => {
  const script: ModelScript = (req, n) => (n === 1 ? toolCall('native_turn_broken', {}, 'call-broken') : answer(`saw: ${JSON.stringify(lastToolResult(req)?.result).slice(0, 40)}`));
  const { native } = await assertParity('self-correction', syndicate({ tools: ['native_turn_broken'] }, { retries: { tool_errors: 2 } }), { boss: script });
  assert.equal(native.results[0]?.status, 'completed');
  const response = native.events.flatMap((e) => e.content?.parts ?? []).find((p) => p.functionResponse)?.functionResponse?.response;
  assert.ok(JSON.stringify(response).includes('REFLECT_AND_RETRY'), 'the reflection guidance answered the call');
});

test('a traced native turn has the turn runner’s root span over the loop’s agent, model and tool spans', async () => {
  const spans: ReadableSpan[] = [];
  const off = onSpanEnd((span) => spans.push(span));
  try {
    const boss = new ScriptedModel('scripted/boss', (req, n) => (n === 1 ? toolCall('native_turn_lookup', { key: 'alpha' }, 'call-1') : answer('done')));
    const r = await runSyndicateTurn({
      config: syndicate({ tools: ['native_turn_lookup'] }),
      parts: [{ text: 'find alpha' }],
      appName: APP,
      userId: USER,
      sessionId: 'traced',
      sessionService: engineSessions(),
      compile: { resolveModel: shimResolver({ boss }) },
      trace: { syndicateName: 'traced-native' },
    });
    assert.equal(r.status, 'completed');
    await flushTracing();
  } finally {
    off();
  }
  const root = spans.find((s) => s.name === 'Syndicate Execution: traced-native');
  assert.ok(root, 'the turn runner’s root span');
  const inTurn = spans.filter((s) => s.spanContext().traceId === root.spanContext().traceId).map((s) => s.name);
  assert.ok(inTurn.includes('agent.invoke Solo'), 'the loop’s agent span');
  assert.equal(inTurn.filter((n) => n === 'model.call').length, 2, 'one model.call per step');
  assert.ok(inTurn.includes('tool.execute native_turn_lookup'), 'the tool span');
});

// ── What native refuses, before any model call ───────────────────────────────

test('native refuses a transform and an ask_user tool on a workflow node at compile time, naming the feature', async () => {
  const boss = new ScriptedModel('scripted/boss', () => answer('never'));
  const scout = new ScriptedModel('scripted/scout', () => answer('never'));
  const run = (config: SyndicateYamlConfig, extra: Record<string, unknown> = {}) =>
    runSyndicateTurn({
      config,
      parts: [{ text: 'go' }],
      appName: APP,
      userId: USER,
      sessionId: 'refuse',
      sessionService: engineSessions(),
      compile: { resolveModel: shimResolver({ boss, scout }) },
      trace: false,
      ...extra,
    });
  const refused = (pattern: RegExp) => (e: unknown) => e instanceof UnsupportedOnRuntimeError && pattern.test(e.message) && /native runtime/.test(e.message);

  await assert.rejects(run(syndicate({}), { transformAgent: (a: unknown) => a }), refused(/transformAgent/));
  const workflow = {
    syndicate_name: APP,
    orchestrator: { name: 'Lead', model: 'scripted/boss', instruction: 'Lead.' },
    subagents: [{ name: 'Step', model: 'scripted/scout', instruction: 'Do.', description: 'a step', tools: ['ask_user'] }],
    workflow: { edges: [['START', 'Lead'], ['Lead', 'Step']] },
  } as unknown as SyndicateYamlConfig;
  // A workflow runs on native (ADR 0095); an ask_user tool on one of its nodes, which the schema refuses, does not.
  await assert.rejects(run(workflow), refused(/an ask_user tool on a workflow node \(Step/));
  assert.equal(boss.calls + scout.calls, 0, 'no model was called');

  // Self-correction runs on native (ADR 0075), with retries on or off.
  const on = await run(syndicate({}, { retries: { tool_errors: 2 } }), { sessionId: 'on' });
  assert.equal(on.status, 'completed');
  const off = await run(syndicate({}, { retries: { tool_errors: 0, model_errors: 0 } }), { sessionId: 'off' });
  assert.equal(off.status, 'completed');
});

/**
 * What a 0.x resolver returned for an ADK model class: an object carrying
 * ADK's own BaseLlm mark (registered with Symbol.for, so it is ADK's mark
 * without ADK), with no contract adapter behind it.
 */
class CustomAdkModel {
  readonly model = 'scripted/custom';
  calls = 0;
  constructor() {
    Object.defineProperty(this, Symbol.for('google.adk.baseModel'), { value: true });
  }
}

test('a resolver returning an ADK model class is refused before any model call (ADR 0088, ADR 0107)', async () => {
  const boss = new ScriptedModel('scripted/boss', () => answer('never'));
  const scout = new ScriptedModel('scripted/scout', () => answer('never'));
  const custom = new CustomAdkModel();
  const shims = shimResolver({ boss, scout });
  const resolveModel = ((id: string | undefined) => (id === 'scripted/custom' ? custom : shims(id))) as unknown as (id: string | undefined) => ModelAdapter;
  const run = async (config: SyndicateYamlConfig) =>
    runSyndicateTurn({
      config,
      parts: [{ text: 'go' }],
      appName: APP,
      userId: USER,
      sessionId: 'custom',
      sessionService: engineSessions(),
      compile: { resolveModel },
      trace: false,
    });
  const refused = (id: string, where: string) => (e: unknown) =>
    e instanceof UnsupportedOnRuntimeError &&
    e.runtime === 'native' &&
    e.message.startsWith(`${where}: the ADK model class CustomAdkModel that resolveModel returned for '${id}'`) &&
    e.message.includes('ADK model classes left in 1.0.0');

  // The agent's own model, a delegated subagent's, its fallback and its summary model.
  await assert.rejects(run(syndicate({ model: 'scripted/custom' })), refused('scripted/custom', 'Solo'));
  const delegating = syndicate({}, { subagents: [{ name: 'Helper', model: 'scripted/custom', instruction: 'Help.', description: 'helps' }] });
  await assert.rejects(run(delegating), refused('scripted/custom', 'Helper'));
  await assert.rejects(run(syndicate({ fallback_model: 'scripted/custom' })), refused('scripted/custom', 'Solo'));
  await assert.rejects(run(syndicate({ context: { compact_after_tokens: 1000, summary_model: 'scripted/custom' } })), refused('scripted/custom', 'Solo'));
  assert.equal(boss.calls + scout.calls + custom.calls, 0, 'no model was called');

  // What native does run: an id, a contract adapter, an adapter marked as served through the shim.
  assert.equal(unrunnableModelClass('scripted/boss'), undefined);
  assert.equal(unrunnableModelClass(boss), undefined);
  assert.equal(unrunnableModelClass(servedThroughShim(new ScriptedModel('scripted/shimmed', () => answer('x')))), undefined);
  assert.equal(unrunnableModelClass(custom), 'CustomAdkModel');
});

test('a resolver returning a plain { model, apiKey } object is refused, never run on the env key (1.0.0)', async () => {
  const boss = new ScriptedModel('scripted/boss', () => answer('never'));
  const shims = shimResolver({ boss });
  const byok = { model: 'scripted/custom', apiKey: 'sk-test-not-a-real-key' };
  const resolveModel = ((id: string | undefined) => (id === 'scripted/custom' ? byok : shims(id))) as unknown as (id: string | undefined) => ModelAdapter;
  const run = async (config: SyndicateYamlConfig) =>
    runSyndicateTurn({
      config,
      parts: [{ text: 'go' }],
      appName: APP,
      userId: USER,
      sessionId: 'byok-object',
      sessionService: engineSessions(),
      compile: { resolveModel },
      trace: false,
    });
  const refused = (where: string) => (e: unknown) =>
    e instanceof UnsupportedOnRuntimeError &&
    e.runtime === 'native' &&
    e.message.startsWith(`${where}: the plain object that resolveModel returned for 'scripted/custom'`) &&
    e.message.includes('1.0.0') &&
    e.message.includes('return a model id or a ModelAdapter (e.g. new ClaudeAdapter({ model, apiKey }))') &&
    !e.message.includes('sk-test-not-a-real-key');

  // The agent's own model, and an id the loop asks for later (its fallback).
  await assert.rejects(run(syndicate({ model: 'scripted/custom' })), refused('Solo'));
  await assert.rejects(run(syndicate({ fallback_model: 'scripted/custom' })), refused('Solo'));
  assert.equal(boss.calls, 0, 'no model was called');
});

test('an unknown runtime name is a configuration error', async () => {
  await assert.rejects(
    runSyndicateTurn({
      config: syndicate({}),
      parts: [{ text: 'go' }],
      appName: APP,
      userId: USER,
      sessionId: 'bad',
      sessionService: engineSessions(),
      trace: false,
      runtime: 'loop' as 'native',
    }),
    /must be "native"/,
  );
});

// ── The wiki agent runner ────────────────────────────────────────────────────

test('runWikiAgent runs the agent on the loop with its tools', async () => {
  const model = new ScriptedModel('ollama/wiki-test', (req, n) =>
    n === 1 ? toolCall('native_turn_lookup', { key: 'wiki' }, 'call-w') : answer(`summary: ${lastToolResult(req)?.result}`),
  );
  // runWikiAgent takes the engine's own Tools (lib/wiki/agentRun.ts): a defineTool contract is one.
  const tool = defineTool({
    name: 'native_turn_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }) => `found ${key}`,
  });
  const result = await runWikiAgent({
    name: 'Gardener',
    description: 'Writes wiki pages.',
    model: 'ollama/wiki-test',
    instruction: 'Summarize.',
    userText: 'summarize the page',
    tools: [tool],
    adapterFor: (): ModelAdapter => model,
  });
  assert.deepEqual(result, { text: 'summary: found wiki' });
  assert.equal(model.calls, 2);
  assert.deepEqual(model.requests[0]?.tools?.map((t) => t.name), ['native_turn_lookup']);
  assert.deepEqual(model.requests[0]?.sampling, { temperature: 0.3, maxOutputTokens: 4096 });
});
