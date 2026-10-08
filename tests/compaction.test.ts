/**
 * tests/compaction.test.ts — `context:` compaction on the native loop
 * (lib/runtime/native/compaction.ts, WS2-9, ADR 0033).
 *
 * Each parity case runs a conversation on the ADK runtime (runSyndicateTurn,
 * scripted adapters behind the shim, ADK's TokenBasedContextCompactor and
 * LlmSummarizer), then the same conversation through runAgentLoop with the
 * same scripts: the stores must hold the same events, the compacted event
 * included (ids and times aside; its startTime and endTime must be the
 * summarized events' times on each side), and every adapter must be handed
 * the same requests. A session compacted on one runtime then continues on
 * the other with the same request. Then the failure case and the ledger.
 * Offline: scripted adapters only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter, ModelRequest } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/fallback.ts';
import { SupabaseSpanExporter } from '../lib/observability/supabaseSpanExporter.ts';
import { onSpanEnd, traceAgentRun } from '../lib/observability/tracer.ts';
import type { TurnContent, TurnEvent } from '../lib/runtime/events.ts';
import { runAgentLoop } from '../lib/runtime/native/agentLoop.ts';
import { SUMMARY_FAILED, SUMMARY_PROMPT, eventsToCompact, retainStartIndex } from '../lib/runtime/native/compaction.ts';
import type { NativeAgent } from '../lib/runtime/native/request.ts';
import { SelfCorrection } from '../lib/runtime/native/selfCorrection.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { Session } from '../lib/runtime/sessions.ts';
import { drainAgentStream, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool, resolveTools } from '../lib/toolRegistry.ts';
import { toolOf } from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

setLogLevel(LogLevel.ERROR);

const APP = 'compaction';
const USER = 'u1';
const SESSION = 's1';

registerTool(
  'compaction_lookup',
  defineTool({ name: 'compaction_lookup', description: 'Look a key up.', schema: z.object({ key: z.string() }), execute: async ({ key }) => `found ${key}` }),
  { override: true },
);

function syndicate(context: Record<string, unknown>, extra: Record<string, unknown> = {}): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: APP,
      orchestrator: { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', context, ...extra },
      subagents: [],
      retries: { model_errors: 0, tool_errors: 0 },
    },
    'test',
  ) as SyndicateYamlConfig;
}

/** The orchestrator as a NativeAgent, as tests/nativeLoop.test.ts builds it, with its `context:`. */
function nativeAgentOf(o: SyndicateYamlConfig['orchestrator']): NativeAgent {
  return {
    name: o.name,
    model: o.model as string,
    instruction: o.instruction ?? '',
    tools: resolveTools(o.tools).map((t) => toolOf(t) ?? t),
    generateContentConfig: { toolConfig: { includeServerSideToolInvocations: true } },
    ...(o.context ? { context: o.context } : {}),
  };
}

type Models = Record<string, ModelScript>;
const build = (scripts: Models): Record<string, ScriptedModel> =>
  Object.fromEntries(Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));

/**
 * Compaction compares event times (a summary stands in for every event up to
 * its endTime), and a scripted turn makes several events in one millisecond.
 * Every reading of the clock here is a millisecond later than the last, as
 * events a person and a provider produce are.
 */
const realNow = Date.now.bind(Date);
let lastNow = 0;
Date.now = () => (lastNow = Math.max(realNow(), lastNow + 1));

// ── The two runtimes, turn by turn, on a store each keeps ────────────────────

class AdkSide {
  readonly sessions = new InMemorySessionService();
  readonly config: SyndicateYamlConfig;
  readonly models: Record<string, ScriptedModel>;
  constructor(config: SyndicateYamlConfig, models: Record<string, ScriptedModel>) {
    this.config = config;
    this.models = models;
  }

  async start(events: TurnEvent[] = []): Promise<void> {
    const session = await this.sessions.createSession({ appName: APP, userId: USER, sessionId: SESSION });
    for (const event of events) await this.sessions.appendEvent({ session, event: structuredClone(event) as any });
  }

  turn(text: string, trace = false) {
    return runSyndicateTurn({
      config: this.config,
      parts: [{ text }],
      appName: APP,
      userId: USER,
      sessionId: SESSION,
      sessionService: this.sessions,
      compile: { resolveModel: shimResolver(this.models), log: () => {} },
      ...(trace ? {} : { trace: false as const }),
    });
  }

  async events(): Promise<TurnEvent[]> {
    const s = await this.sessions.getSession({ appName: APP, userId: USER, sessionId: SESSION });
    return JSON.parse(JSON.stringify(s?.events ?? [])) as TurnEvent[];
  }
}

class NativeSide {
  readonly sessions = new InProcessSessionService();
  session!: Session;
  readonly yielded: TurnEvent[] = [];
  readonly config: SyndicateYamlConfig;
  readonly models: Record<string, ScriptedModel>;
  constructor(config: SyndicateYamlConfig, models: Record<string, ScriptedModel>) {
    this.config = config;
    this.models = models;
  }

  async start(events: TurnEvent[] = []): Promise<void> {
    this.session = await this.sessions.create({ appName: APP, userId: USER, sessionId: SESSION });
    for (const event of events) await this.sessions.append(this.session, structuredClone(event));
  }

  /** One turn: the user event (ADK's, when given), then the loop under a turn control, drained as the turn runner drains. */
  async turn(text: string, userEvent?: TurnEvent, trace = false): Promise<void> {
    // ADK's user event, at this run's own time.
    const event = userEvent
      ? { ...structuredClone(userEvent), timestamp: Date.now() }
      : { id: `u${Math.random().toString(36).slice(2, 9)}`, invocationId: `e-${Math.random().toString(36).slice(2)}`, author: 'user', content: { role: 'user', parts: [{ text }] }, actions: {}, timestamp: Date.now() };
    await this.sessions.append(this.session, event as TurnEvent);
    const control = createTurnControl({ maxLlmCalls: this.config.max_steps ?? 50 });
    try {
      await runWithTurnControl(control, async () => {
        const loop = runAgentLoop(nativeAgentOf(this.config.orchestrator), {
          session: this.session,
          sessions: this.sessions,
          invocationId: event.invocationId,
          userContent: event.content as TurnContent,
          selfCorrection: new SelfCorrection(this.config.retries ?? {}),
          adapterFor: (id) => {
            const m = this.models[id.replace(/^scripted\//, '')];
            if (!m) throw new Error(`no scripted model '${id}'`);
            return m as ModelAdapter;
          },
          log: () => {},
        });
        const yielded = this.yielded;
        const tap = (async function* () {
          for await (const e of loop) {
            yielded.push(e);
            yield e;
          }
        })();
        const stream = trace
          ? traceAgentRun(tap as any, {
              syndicateName: this.config.syndicate_name,
              bindings: {},
              input: [{ text }],
              sessionId: SESSION,
              userId: USER,
              stage: 'delegate',
              onEnd: () => ({ 'syndicate.relay_fallback': false, 'syndicate.llm_calls': control.llmCalls }),
            })
          : tap;
        await drainAgentStream(stream as any, { streamText: true });
      });
    } finally {
      control.dispose();
    }
  }

  async events(): Promise<TurnEvent[]> {
    const s = await this.sessions.get({ appName: APP, userId: USER, sessionId: SESSION });
    return JSON.parse(JSON.stringify(s?.events ?? [])) as TurnEvent[];
  }
}

/** Ids, times and ADK's own call ids are minted per run; a compaction's span is checked against the times it covers. */
function comparable(events: TurnEvent[]): unknown {
  for (const e of events as any[]) {
    if (!e.isCompacted) continue;
    const times = events.map((x) => x.timestamp);
    assert.ok(times.includes(e.startTime) && times.includes(e.endTime), 'startTime and endTime are summarized events\' times');
  }
  return JSON.parse(
    JSON.stringify(events.map((e: any) => ({ ...e, id: '<id>', timestamp: 0, ...(e.isCompacted ? { startTime: 0, endTime: 0 } : {}) }))),
    (_key, v) => (typeof v === 'string' && v.startsWith('adk-') ? '<adk-id>' : v),
  );
}

const withoutSignal = (r: ModelRequest) => {
  const { signal: _s, ...rest } = r;
  return JSON.parse(JSON.stringify(rest));
};

function assertSameRequests(native: Record<string, ScriptedModel>, adk: Record<string, ScriptedModel>): void {
  for (const key of Object.keys(adk)) {
    assert.equal(native[key]?.calls, adk[key]?.calls, `calls to ${key}`);
    assert.deepEqual(native[key]?.requests.map(withoutSignal), adk[key]?.requests.map(withoutSignal), `requests to ${key}`);
  }
}

/** The conversation on both runtimes; the stores and the requests must match. */
async function assertParity(config: SyndicateYamlConfig, scripts: Models, turns: string[]) {
  resetCircuits();
  const adk = new AdkSide(config, build(scripts));
  await adk.start();
  for (const t of turns) {
    const r = await adk.turn(t);
    assert.equal(r.status, 'completed', r.error?.message);
  }
  const adkEvents = await adk.events();
  const userEvents = adkEvents.filter((e) => e.author === 'user');

  resetCircuits();
  const native = new NativeSide(config, build(scripts));
  await native.start();
  for (const [i, t] of turns.entries()) await native.turn(t, userEvents[i]);
  const nativeEvents = await native.events();

  assert.deepEqual(comparable(nativeEvents), comparable(adkEvents), 'the stored events');
  assertSameRequests(native.models, adk.models);
  // The loop yielded every event it stored, the compactions included.
  const stored = nativeEvents.filter((e) => e.author !== 'user').map((e) => e.id);
  assert.deepEqual(native.yielded.filter((e) => !e.partial).map((e) => e.id), stored, 'yielded what was stored');
  return { adk, native, adkEvents, nativeEvents };
}

// The case of tests/execution.test.ts: the prompt grows 400 tokens a call; past 1,000 the earlier turns become a summary.
const growing = (): ModelScript => (_r, n) => answer(`answer ${n}`, { inputTokens: n * 400, outputTokens: 5 });
const SUMMARY = (): ModelScript => (_r, n) => answer(`SUMMARY ${n}: the person asked about trains.`);

// ── The cases ────────────────────────────────────────────────────────────────

test('ADR 0033: past the threshold, the earlier turns become one summary on both runtimes', async () => {
  const config = syndicate({ compact_after_tokens: 1000, keep_recent_events: 2, summary_model: 'scripted/sum' });
  const { native, nativeEvents } = await assertParity(config, { chat: growing(), sum: SUMMARY() }, ['question 1', 'question 2', 'question 3', 'question 4']);
  assert.equal(native.models.sum!.calls, 1, 'the summarizer ran once');
  const compacted = nativeEvents.filter((e: any) => e.isCompacted);
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0]!.author, 'system');
  assert.equal(compacted[0]!.invocationId, '');
  // The summary request: ADK's prompt, then the summarized events.
  const sent = native.models.sum!.requests[0]!;
  const prompt = (sent.messages[0]!.parts[0] as any).text as string;
  assert.ok(prompt.startsWith(`${SUMMARY_PROMPT}\n\n[Event 1 - Author: user]\nquestion 1\n\n[Event 2 - Author: Chat]\nanswer 1\n\n`));
  assert.equal(sent.tools?.length ?? 0, 0, 'no tools');
  assert.equal(sent.system, undefined, 'no system prompt');
  // The fourth request reads the summary in place of what it covers.
  const fourth = native.models.chat!.requests[3]!;
  assert.match((fourth.messages[0]!.parts[0] as any).text, /^\[Previous Context Summary\]:\nSUMMARY 1/);
  assert.equal(fourth.messages.length, 3);
});

test('a later compaction folds the earlier summary in, and the cut never splits a call from its answer', async () => {
  // No usage: the size is estimated from the projected history (characters / 4). The summary model is the agent's own.
  const long = (n: number) => `question ${n} ${'x'.repeat(1800)}`;
  const config = syndicate({ compact_after_tokens: 1000, keep_recent_events: 3 }, { tools: ['compaction_lookup'] });
  const chat: ModelScript = (req, n) => {
    const text = (req.messages[0]?.parts[0] as any)?.text as string;
    if (text?.startsWith(SUMMARY_PROMPT)) return answer(`SUMMARY at call ${n}`);
    const last = req.messages.at(-1)!;
    return last.role === 'tool' ? answer(`done ${n}`) : toolCall('compaction_lookup', { key: `k${n}` }, `call-${n}`);
  };
  const { native, nativeEvents } = await assertParity(config, { chat }, [long(1), long(2), long(3), long(4)]);
  const compacted = nativeEvents.filter((e: any) => e.isCompacted) as any[];
  assert.ok(compacted.length >= 2, `compacted ${compacted.length} times`);
  const summaries = native.models.chat!.requests.filter((r) => ((r.messages[0]?.parts[0] as any)?.text as string)?.startsWith(SUMMARY_PROMPT));
  assert.equal(summaries.length, compacted.length);
  assert.match((summaries[1]!.messages[0]!.parts[0] as any).text, /\[Event 1 - Author: system\]\nSUMMARY at call/, 'the second summary reads the first');
});

test('retainStartIndex moves back past a call to keep its answer with it', () => {
  const ev = (parts: any[]): TurnEvent => ({ id: 'x', invocationId: 'i', actions: {}, timestamp: 1, content: { role: 'model', parts } });
  const raw = [ev([{ text: 'q' }]), ev([{ functionCall: { name: 't', id: '1' } }]), ev([{ functionResponse: { name: 't', id: '1', response: {} } }]), ev([{ text: 'a' }])];
  assert.equal(retainStartIndex(raw, 2), 1);
  assert.equal(retainStartIndex(raw, 3), 1);
  assert.equal(retainStartIndex(raw, 4), 0);
});

test('under the threshold or within keep_recent_events nothing is summarized', () => {
  const ev = (i: number, tokens?: number): TurnEvent => ({
    id: `e${i}`, invocationId: 'i', author: i % 2 ? 'Chat' : 'user', actions: {}, timestamp: i,
    content: { role: i % 2 ? 'model' : 'user', parts: [{ text: `t${i}` }] },
    ...(tokens ? { usageMetadata: { promptTokenCount: tokens } } : {}),
  });
  const session = { events: [ev(1), ev(2), ev(3, 999)] } as unknown as Session;
  assert.equal(eventsToCompact({ compact_after_tokens: 1000, keep_recent_events: 1 }, { agentName: 'Chat', session }), undefined, 'at the threshold');
  session.events.push(ev(4, 1001));
  assert.equal(eventsToCompact({ compact_after_tokens: 1000, keep_recent_events: 4 }, { agentName: 'Chat', session }), undefined, 'all kept');
  assert.deepEqual(eventsToCompact({ compact_after_tokens: 1000, keep_recent_events: 1 }, { agentName: 'Chat', session })?.map((e) => e.id), ['e1', 'e2', 'e3']);
});

test('a session compacted on ADK continues on the native loop with the same request, and the reverse', async () => {
  const config = syndicate({ compact_after_tokens: 1000, keep_recent_events: 2, summary_model: 'scripted/sum' });
  const turns = ['question 1', 'question 2', 'question 3', 'question 4', 'question 5'];

  // The reference: all five turns on each runtime alone.
  resetCircuits();
  const adkOnly = new AdkSide(config, build({ chat: growing(), sum: SUMMARY() }));
  await adkOnly.start();
  for (const t of turns) await adkOnly.turn(t);
  resetCircuits();
  const nativeOnly = new NativeSide(config, build({ chat: growing(), sum: SUMMARY() }));
  await nativeOnly.start();
  for (const t of turns) await nativeOnly.turn(t);

  // ADK writes four turns (the fourth compacts), the native loop answers the fifth.
  resetCircuits();
  const adkFirst = new AdkSide(config, build({ chat: growing(), sum: SUMMARY() }));
  await adkFirst.start();
  for (const t of turns.slice(0, 4)) await adkFirst.turn(t);
  const handedOver = await adkFirst.events();
  assert.ok(handedOver.some((e: any) => e.isCompacted));
  const nativeAfter = new NativeSide(config, build({ chat: (_r, n) => answer(`answer ${n + 4}`, { inputTokens: (n + 4) * 400, outputTokens: 5 }), sum: (_r, n) => answer(`SUMMARY ${n + 1}: the person asked about trains.`) }));
  await nativeAfter.start(handedOver);
  await nativeAfter.turn(turns[4]!);
  assert.deepEqual(withoutSignal(nativeAfter.models.chat!.requests[0]!), withoutSignal(adkOnly.models.chat!.requests[4]!), 'ADK → native: the fifth request');
  assert.deepEqual(nativeAfter.models.sum!.requests.map(withoutSignal), adkOnly.models.sum!.requests.slice(1).map(withoutSignal), 'ADK → native: the fifth turn\'s summary');

  // The native loop writes four turns, ADK answers the fifth.
  resetCircuits();
  const nativeFirst = new NativeSide(config, build({ chat: growing(), sum: SUMMARY() }));
  await nativeFirst.start();
  for (const t of turns.slice(0, 4)) await nativeFirst.turn(t);
  const adkAfter = new AdkSide(config, build({ chat: (_r, n) => answer(`answer ${n + 4}`, { inputTokens: (n + 4) * 400, outputTokens: 5 }), sum: (_r, n) => answer(`SUMMARY ${n + 1}: the person asked about trains.`) }));
  await adkAfter.start(await nativeFirst.events());
  const r = await adkAfter.turn(turns[4]!);
  assert.equal(r.status, 'completed', r.error?.message);
  assert.deepEqual(withoutSignal(adkAfter.models.chat!.requests[0]!), withoutSignal(nativeOnly.models.chat!.requests[4]!), 'native → ADK: the fifth request');
  assert.deepEqual(adkAfter.models.sum!.requests.map(withoutSignal), nativeOnly.models.sum!.requests.slice(1).map(withoutSignal), 'native → ADK: the fifth turn\'s summary');
});

test('a summary model that answers no text fails the turn on both runtimes, and nothing is compacted', async () => {
  const config = syndicate({ compact_after_tokens: 1000, keep_recent_events: 2, summary_model: 'scripted/sum' });
  const scripts: Models = { chat: growing(), sum: () => answer('') };
  const turns = ['question 1', 'question 2', 'question 3'];
  resetCircuits();
  const adk = new AdkSide(config, build(scripts));
  await adk.start();
  for (const t of turns) await adk.turn(t);
  // ADK's summarizer throws out of the agent's run, and the turn with it.
  await assert.rejects(adk.turn('question 4'), new RegExp(SUMMARY_FAILED.replace('.', '\\.')));

  resetCircuits();
  const native = new NativeSide(config, build(scripts));
  await native.start();
  for (const t of turns) await native.turn(t);
  await assert.rejects(native.turn('question 4'), new RegExp(SUMMARY_FAILED.replace('.', '\\.')));
  assert.equal(native.models.chat!.calls, adk.models.chat!.calls, 'no step after the failed summary');
  assert.ok(!(await native.events()).some((e: any) => e.isCompacted));
  assert.ok(!(await adk.events()).some((e: any) => e.isCompacted));
});

// ── The ledger ───────────────────────────────────────────────────────────────

async function spansOf(fn: () => Promise<void>): Promise<ReadableSpan[]> {
  const spans: ReadableSpan[] = [];
  const off = onSpanEnd((s) => {
    if (s.name !== 'melchizedek.tracer.probe') spans.push(s);
  });
  try {
    await fn();
  } finally {
    off();
  }
  return spans;
}

async function ledgerOf(spans: ReadableSpan[]): Promise<{ adk_turns: any[]; adk_telemetry: any[]; adk_payloads: any[] }> {
  const rows = { adk_turns: [] as any[], adk_telemetry: [] as any[], adk_payloads: [] as any[] };
  const client = { from: (table: string) => ({ insert: async (inserted: unknown[]) => (rows[table as keyof typeof rows].push(...inserted), { error: null }) }) };
  const exporter = new SupabaseSpanExporter({ client, policy: { mode: 'all', sampleRate: 1, ttlDays: 30 }, deadLetterFile: '' });
  exporter.export(spans, () => {});
  await exporter.forceFlush();
  return rows;
}

function scrubbed(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...row, ts: '<ts>', trace_id: '<trace>', span_id: '<span>' };
  for (const key of ['latency_ms', 'model_ms', 'tool_ms']) if (key in out) out[key] = '<ms>';
  const scrub = (attrs: Record<string, unknown>) => {
    const copy = { ...attrs };
    for (const key of ['syndicate.latency.model_ms', 'syndicate.latency.tool_ms']) if (key in copy) copy[key] = '<ms>';
    return copy;
  };
  if (out.attributes) out.attributes = scrub(out.attributes);
  if (out.span) out.span = { ...out.span, traceId: '<trace>', spanId: '<span>', durationMs: '<ms>', attributes: scrub(out.span.attributes ?? {}) };
  return out;
}

test('the summarizing call is charged and traced as on ADK: the same turn and telemetry rows', async () => {
  const config = syndicate({ compact_after_tokens: 1000, keep_recent_events: 2, summary_model: 'scripted/sum' });
  const scripts: Models = { chat: growing(), sum: SUMMARY() };
  const turns = ['question 1', 'question 2', 'question 3'];
  resetCircuits();
  const adk = new AdkSide(config, build(scripts));
  await adk.start();
  for (const t of turns) await adk.turn(t);
  const adkSpans = await spansOf(async () => {
    await adk.turn('question 4', true);
  });
  const userEvent = (await adk.events()).filter((e) => e.author === 'user').at(-1)!;

  resetCircuits();
  const native = new NativeSide(config, build(scripts));
  await native.start();
  for (const t of turns) await native.turn(t);
  const nativeSpans = await spansOf(() => native.turn('question 4', userEvent, true));

  const a = await ledgerOf(adkSpans);
  const n = await ledgerOf(nativeSpans);
  assert.equal(a.adk_turns[0]?.attributes?.['syndicate.llm_calls'], 2, 'the summary is charged against the turn');
  assert.deepEqual(n.adk_turns.map(scrubbed), a.adk_turns.map(scrubbed), 'adk_turns');
  assert.deepEqual(n.adk_telemetry.map(scrubbed), a.adk_telemetry.map(scrubbed), 'adk_telemetry');
  const summaryRow = n.adk_telemetry.find((r) => r.model === 'scripted/sum');
  assert.ok(summaryRow, 'the summary call has its telemetry row');
  assert.equal(summaryRow.agent, 'Chat', 'under the agent that compacted');
  assert.equal(n.adk_payloads.length, a.adk_payloads.length, 'the same payload rows');
});

// ── Through the turn runner ──────────────────────────────────────────────────

test('runSyndicateTurn on the native runtime compacts as on ADK: the same stored events and requests', async () => {
  const config = syndicate({ compact_after_tokens: 1000, keep_recent_events: 2, summary_model: 'scripted/sum' });
  const turns = ['question 1', 'question 2', 'question 3', 'question 4', 'question 5'];
  const run = async (runtime: 'adk' | 'native') => {
    resetCircuits();
    const models = build({ chat: growing(), sum: SUMMARY() });
    const sessionService = new InMemorySessionService();
    for (const text of turns) {
      const r = await runSyndicateTurn({
        config,
        parts: [{ text }],
        appName: APP,
        userId: USER,
        sessionId: SESSION,
        sessionService,
        compile: { resolveModel: shimResolver(models), log: () => {} },
        trace: false,
        runtime,
      });
      assert.equal(r.status, 'completed', r.error?.message);
      assert.equal(r.text, `answer ${models.chat!.calls}`);
    }
    const s = await sessionService.getSession({ appName: APP, userId: USER, sessionId: SESSION });
    return { models, events: JSON.parse(JSON.stringify(s?.events ?? [])) as TurnEvent[] };
  };
  const adk = await run('adk');
  const native = await run('native');
  // Each runtime mints its own run ids.
  const strip = (events: TurnEvent[]) => events.map((e) => ({ ...e, invocationId: e.invocationId ? '<run>' : '' }));
  assert.deepEqual(comparable(strip(native.events)), comparable(strip(adk.events)), 'the stored events');
  assert.equal(native.events.filter((e: any) => e.isCompacted).length, 2, 'the fourth and fifth turns compact');
  assertSameRequests(native.models, adk.models);
});
