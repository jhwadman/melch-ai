/**
 * tests/nativeTurn.test.ts — runSyndicateTurn on the native runtime
 * (MELCHIZEDEK_RUNTIME=native or `runtime: 'native'`, WS2-10, ADR 0073).
 *
 * Each parity case runs the same conversation through runSyndicateTurn on
 * ADK and on native, with the same scripted model behind the ADK shim (the
 * native turn calls the shim's own adapter), and requires the same result
 * (status, text, usage, route, pause) and the same stored events, ids and
 * times aside. Then what native refuses before any model call, an approval
 * opened on one runtime resumed on the other, the run's temp: state, and the
 * wiki agent runner on the flag. Offline: scripted adapters only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FunctionTool, InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';
import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/fallback.ts';
import { flushTracing, onSpanEnd } from '../lib/observability/tracer.ts';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { UnsupportedOnRuntimeError, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { runWikiAgent } from '../lib/wiki/agentRun.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, streamedAnswer, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

setLogLevel(LogLevel.ERROR);

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
  new FunctionTool({
    name: 'native_turn_send',
    description: 'Send a note.',
    parameters: z.object({ to: z.string() }),
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
  runtime?: 'adk' | 'native';
}

interface Run {
  results: SyndicateTurnResult[];
  events: TurnEvent[];
  models: Record<string, ScriptedModel>;
  deltas: string[][];
}

async function converse(runtime: 'adk' | 'native', config: SyndicateYamlConfig, scripts: Models, turns: Turn[]): Promise<Run> {
  resetCircuits();
  const models = Object.fromEntries(Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));
  const sessionService = new InMemorySessionService();
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
        runtime: t.runtime ?? runtime,
        ...(t.streaming ? { streaming: true, events: { onTextDelta: (x: string) => d.push(x) } } : {}),
      }),
    );
  }
  const session = await sessionService.getSession({ appName: APP, userId: USER, sessionId: 's1' });
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

async function assertParity(config: SyndicateYamlConfig, scripts: Models, turns: Turn[] = [{}]): Promise<{ adk: Run; native: Run }> {
  const adk = await converse('adk', config, scripts, turns);
  const native = await converse('native', config, scripts, turns);
  assert.deepEqual(native.results.map(outcome), adk.results.map(outcome), 'the results');
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'the stored events');
  for (const key of Object.keys(scripts)) assert.equal(native.models[key]?.calls, adk.models[key]?.calls, `calls to ${key}`);
  assert.deepEqual(native.deltas, adk.deltas, 'the text deltas');
  return { adk, native };
}

// ── Parity ───────────────────────────────────────────────────────────────────

test('a single-agent syndicate answers through runSyndicateTurn on native, as on ADK, over two turns', async () => {
  const { native } = await assertParity(
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
      sessionService: new InMemorySessionService(),
      compile: { resolveModel: shimResolver({ boss }) },
      trace: false,
      // Native refuses an ADK agent transform: reaching it proves the runtime.
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
      sessionService: new InMemorySessionService(),
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
  const { native } = await assertParity(config, {
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
    const { native } = await assertParity(config, { boss: script }, [
      { parts: [{ text: 'tell ops' }] },
      { answer: (r) => [approvalResponsePart(r.approval!.id, approved)] },
    ]);
    assert.equal(native.results[0]?.status, 'input-required');
    assert.equal(native.results[1]?.status, 'completed', native.results[1]?.error?.message);
    assert.equal(native.results[1]?.text, approved ? 'done: "sent to ops@acme.test"' : 'done: "This tool call is rejected."');
    assert.deepEqual(sent, approved ? ['ops@acme.test', 'ops@acme.test'] : [], 'the pinned call ran once per runtime, only when approved');
  }
});

test('an approval opened on one runtime resumes on the other, and the pinned call runs once', async () => {
  const config = syndicate({ instruction: 'Send notes.', tools: ['native_turn_send'], require_approval: ['native_turn_send'] });
  const script: ModelScript = (req, n) => (n === 1 ? toolCall('native_turn_send', { to: 'ops@acme.test' }, 'call-send') : answer(`done: ${lastToolResult(req)?.result}`));
  for (const [opens, resumes] of [['native', 'adk'], ['adk', 'native']] as const) {
    sent.length = 0;
    const boss = new ScriptedModel('scripted/boss', script);
    const sessionService = new InMemorySessionService();
    const base = { config, appName: APP, userId: USER, sessionId: `pause-${opens}`, sessionService, compile: { resolveModel: shimResolver({ boss }) }, trace: false as const };
    const paused = await runSyndicateTurn({ ...base, parts: [{ text: 'tell ops' }], runtime: opens });
    assert.equal(paused.status, 'input-required');
    assert.deepEqual(sent, [], 'nothing ran before the approval');
    const resumed = await runSyndicateTurn({ ...base, parts: [approvalResponsePart(paused.approval!.id, true)], runtime: resumes });
    assert.equal(resumed.status, 'completed', resumed.error?.message);
    assert.equal(resumed.text, 'done: sent to ops@acme.test');
    assert.deepEqual(sent, ['ops@acme.test'], `opened on ${opens}, resumed on ${resumes}`);
    assert.equal(boss.calls, 2, 'the resume did not start the turn over');
  }
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
  const { native } = await assertParity(
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
  assert.deepEqual(sent, ['pr@acme.test', 'pr@acme.test'], 'once per runtime');
});

test('parity: an ask_user call pauses the turn with the question; answering it on native is refused', async () => {
  const config = syndicate({ instruction: 'Ask when unsure.', tools: ['ask_user'] });
  const { native } = await assertParity(config, { boss: () => toolCall('ask_user', { question: 'Which year?' }, 'call-ask') });
  assert.equal(native.results[0]?.status, 'input-required');
  assert.equal(native.results[0]?.input?.message, 'Which year?');
  await assert.rejects(
    converse('native', config, { boss: () => toolCall('ask_user', { question: 'Which year?' }, 'call-ask') }, [{}, { parts: [{ text: '1999' }] }]),
    (e: unknown) => e instanceof UnsupportedOnRuntimeError && /answering Solo's question/.test(e.message),
  );
});

test('parity: a temp: key a tool writes reaches the next step’s instruction, and no store keeps it', async () => {
  const config = syndicate({ instruction: 'Answer. Last key: {temp:last_key?}.', tools: ['native_turn_lookup'] });
  const { adk, native } = await assertParity(config, {
    boss: (_req, n) => (n === 1 ? toolCall('native_turn_lookup', { key: 'alpha' }, 'call-1') : answer('done')),
  });
  for (const run of [adk, native]) {
    const [first, second] = run.models.boss!.requests;
    assert.match(first?.system ?? '', /Last key: \.$/);
    assert.match(second?.system ?? '', /Last key: alpha\.$/);
    assert.ok(!JSON.stringify(run.events).includes('temp:'), 'no stored event carries the temp: key');
  }
});

test('parity: a DELEGATE syndicate delegates to its subagent and relays the answer on native', async () => {
  const config = syndicate(
    { instruction: 'Delegate to Scout.' },
    { subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Find.', description: 'Finds things' }] },
  );
  const { native } = await assertParity(config, {
    boss: (req, n) => (n === 1 ? toolCall('Scout', { request: 'find the thing' }, 'call-scout') : answer(`relayed: ${lastToolResult(req)?.result}`)),
    scout: () => answer('the thing is here'),
  });
  assert.equal(native.results[0]?.text, 'relayed: the thing is here');
  assert.deepEqual(native.results[0]?.answer?.delegations, ['Scout']);
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
  const { native } = await assertParity(syndicate({ tools: ['native_turn_broken'] }, { retries: { tool_errors: 2 } }), { boss: script });
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
      sessionService: new InMemorySessionService(),
      compile: { resolveModel: shimResolver({ boss }) },
      trace: { syndicateName: 'traced-native' },
      runtime: 'native',
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

test('native refuses a workflow, compaction and a transform at compile time, naming the feature', async () => {
  const boss = new ScriptedModel('scripted/boss', () => answer('never'));
  const scout = new ScriptedModel('scripted/scout', () => answer('never'));
  const run = (config: SyndicateYamlConfig, extra: Record<string, unknown> = {}) =>
    runSyndicateTurn({
      config,
      parts: [{ text: 'go' }],
      appName: APP,
      userId: USER,
      sessionId: 'refuse',
      sessionService: new InMemorySessionService(),
      compile: { resolveModel: shimResolver({ boss, scout }) },
      trace: false,
      runtime: 'native',
      ...extra,
    });
  const refused = (pattern: RegExp) => (e: unknown) => e instanceof UnsupportedOnRuntimeError && pattern.test(e.message) && /native runtime/.test(e.message);

  await assert.rejects(run(syndicate({}), { transformAgent: (a: unknown) => a }), refused(/transformAgent/));
  await assert.rejects(run(syndicate({ context: { compact_after_tokens: 1000 } })), refused(/context compaction/));
  const workflow = {
    syndicate_name: APP,
    orchestrator: { name: 'Lead', model: 'scripted/boss', instruction: 'Lead.' },
    subagents: [{ name: 'Step', model: 'scripted/scout', instruction: 'Do.', description: 'a step' }],
    workflow: { edges: [['START', 'Lead'], ['Lead', 'Step']] },
  } as unknown as SyndicateYamlConfig;
  await assert.rejects(run(workflow), refused(/a workflow syndicate/));
  assert.equal(boss.calls + scout.calls, 0, 'no model was called');

  // Self-correction runs on native (ADR 0075), with retries on or off.
  const on = await run(syndicate({}, { retries: { tool_errors: 2 } }), { sessionId: 'on' });
  assert.equal(on.status, 'completed');
  const off = await run(syndicate({}, { retries: { tool_errors: 0, model_errors: 0 } }), { sessionId: 'off' });
  assert.equal(off.status, 'completed');
});

test('an unknown runtime name is a configuration error', async () => {
  await assert.rejects(
    runSyndicateTurn({
      config: syndicate({}),
      parts: [{ text: 'go' }],
      appName: APP,
      userId: USER,
      sessionId: 'bad',
      sessionService: new InMemorySessionService(),
      trace: false,
      runtime: 'loop' as 'native',
    }),
    /must be "adk" or "native"/,
  );
});

// ── The wiki agent runner on the flag ────────────────────────────────────────

test('runWikiAgent follows the runtime: native runs the agent on the loop with its tools', async () => {
  const model = new ScriptedModel('ollama/wiki-test', (req, n) =>
    n === 1 ? toolCall('native_turn_lookup', { key: 'wiki' }, 'call-w') : answer(`summary: ${lastToolResult(req)?.result}`),
  );
  const tool = new FunctionTool({
    name: 'native_turn_lookup',
    description: 'Look a key up.',
    parameters: z.object({ key: z.string() }),
    execute: async ({ key }) => `found ${key}`,
  });
  const result = await runWikiAgent({
    name: 'Gardener',
    description: 'Writes wiki pages.',
    model: 'ollama/wiki-test',
    instruction: 'Summarize.',
    userText: 'summarize the page',
    tools: [tool],
    runtime: 'native',
    adapterFor: (): ModelAdapter => model,
  });
  assert.deepEqual(result, { text: 'summary: found wiki' });
  assert.equal(model.calls, 2);
  assert.deepEqual(model.requests[0]?.tools?.map((t) => t.name), ['native_turn_lookup']);
  assert.deepEqual(model.requests[0]?.sampling, { temperature: 0.3, maxOutputTokens: 4096 });
});
