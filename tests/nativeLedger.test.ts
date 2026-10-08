/**
 * tests/nativeLedger.test.ts — a native run writes the ledger rows an ADK run
 * writes (WS2-11, ADR 0076).
 *
 * Each case runs one conversation on the ADK runtime (runSyndicateTurn, a
 * scripted adapter behind the shim, tracing on), then the same conversation
 * on the native loop (runAgentLoop under traceAgentRun, as the turn runner
 * wraps a stream), collects every span each run ended, and hands them to the
 * ledger exporter with a capturing client. adk_turns, adk_telemetry and
 * adk_payloads must hold the same rows, ids, times and durations aside. A
 * model step's own payload row (ADK's call_llm, the loop's model.call) holds
 * the request and response as each runtime holds them, and its provider
 * column names the provider on the loop where ADK names its own scope: those
 * three columns are checked against the scripted adapter instead.
 * Offline: scripted adapters only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter, ModelRequest } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/fallback.ts';
import { agentOfSpanName, isModelCallSpan, isToolSpanName } from '../lib/observability/lineage.ts';
import { SupabaseSpanExporter, isPayloadSpan } from '../lib/observability/supabaseSpanExporter.ts';
import type { PayloadPolicy } from '../lib/observability/supabaseSpanExporter.ts';
import { onSpanEnd, traceAgentRun } from '../lib/observability/tracer.ts';
import type { TurnContent, TurnEvent } from '../lib/runtime/events.ts';
import { SelfCorrection } from '../lib/runtime/native/selfCorrection.ts';
import { runAgentLoop } from '../lib/runtime/native/agentLoop.ts';
import type { NativeAgent } from '../lib/runtime/native/request.ts';
import { asAdkSessionService } from '../lib/runtime/adkSessionBridge.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { drainAgentStream, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool, resolveTools } from '../lib/toolRegistry.ts';
import { toolOf } from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, failure, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { adkReferences, runsAdk } from './helpers/adkReference.ts';

// ADK's ledger rows for each case are recorded (tests/fixtures/adk-reference/nativeledger); ADK runs only under ADK_REFERENCE=live|record.
const reference = adkReferences('nativeLedger');
if (runsAdk()) {
  const { LogLevel, setLogLevel } = await import('@google/adk');
  setLogLevel(LogLevel.ERROR);
}

const APP = 'native-ledger';
const USER = 'u1';
const SESSION = 's1';
const TOOL_MS = 25;

registerTool(
  'native_ledger_lookup',
  defineTool({
    name: 'native_ledger_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }) => {
      await new Promise((r) => setTimeout(r, TOOL_MS));
      return `found ${key}`;
    },
  }),
  { override: true },
);
registerTool(
  'native_ledger_broken',
  defineTool({
    name: 'native_ledger_broken',
    description: 'Always fails.',
    schema: z.object({}),
    execute: async () => {
      throw new Error('the disk is full');
    },
  }),
  { override: true },
);

// ── The two runs ─────────────────────────────────────────────────────────────

type Models = Record<string, ModelScript>;
const build = (scripts: Models): Record<string, ScriptedModel> =>
  Object.fromEntries(Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));

function syndicate(orchestrator: Record<string, unknown>): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: APP,
      orchestrator: { name: 'Solo', model: 'scripted/boss', instruction: 'Answer briefly.', ...orchestrator },
      subagents: [],
      retries: { model_errors: 0, tool_errors: 0 },
    },
    'test',
  ) as SyndicateYamlConfig;
}

/** The orchestrator as a NativeAgent, as tests/nativeLoop.test.ts builds it. */
function nativeAgentOf(o: SyndicateYamlConfig['orchestrator']): NativeAgent {
  return {
    name: o.name,
    model: o.model as string,
    instruction: o.instruction ?? '',
    tools: resolveTools(o.tools).map((t) => toolOf(t) ?? t),
    ...(o.fallback_model ? { fallbackModel: o.fallback_model } : {}),
    generateContentConfig: { toolConfig: { includeServerSideToolInvocations: true } },
  };
}

/** Every span that ends while `fn` runs, but the tracer's start-up probe. */
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

interface Run {
  spans: ReadableSpan[];
  models: Record<string, ScriptedModel>;
  invocationId: string;
}

/** ADK's side, live: the turn through runSyndicateTurn on the adk runtime, traced. */
async function runOnAdk(config: SyndicateYamlConfig, scripts: Models, parts: any[]): Promise<Run> {
  const models = build(scripts);
  const { InMemorySessionService } = await import('@google/adk');
  const sessionService = new InMemorySessionService();
  const spans = await spansOf(async () => {
    await runSyndicateTurn({
      config,
      parts,
      appName: APP,
      userId: USER,
      sessionId: SESSION,
      sessionService,
      compile: { resolveModel: shimResolver(models), log: () => {} },
      // The reference is ADK's: pinned, now that native is the default (ADR 0102).
      runtime: 'adk',
    });
  });
  const session = await sessionService.getSession({ appName: APP, userId: USER, sessionId: SESSION });
  const invocationId = session?.events.find((e) => e.author === 'user')?.invocationId as string;
  return { spans, models, invocationId };
}

/**
 * The same turn on the native loop, traced as the turn runner traces a
 * stream (traceAgentRun with the turn's metadata), drained as it drains one.
 */
async function runNative(config: SyndicateYamlConfig, scripts: Models, parts: any[], invocationId: string): Promise<Run> {
  const models = build(scripts);
  const agent = nativeAgentOf(config.orchestrator);
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: APP, userId: USER, sessionId: SESSION });
  const userContent: TurnContent = { role: 'user', parts };
  await sessions.append(session, { id: 'u0000001', invocationId, author: 'user', content: userContent, actions: {}, timestamp: Date.now() });
  const control = createTurnControl({ maxLlmCalls: config.max_steps ?? 50 });
  const spans = await spansOf(() =>
    runWithTurnControl(control, async () => {
      const loop = runAgentLoop(agent, {
        session,
        sessions,
        selfCorrection: new SelfCorrection(config.retries ?? {}),
        invocationId,
        userContent,
        adapterFor: (id) => models[id.replace(/^scripted\//, '')] as ModelAdapter,
        log: () => {},
      });
      const traced = traceAgentRun(loop as any, {
        syndicateName: config.syndicate_name,
        bindings: config.variables ?? {},
        input: parts,
        sessionId: SESSION,
        userId: USER,
        stage: 'delegate',
        onEnd: () => ({ 'syndicate.relay_fallback': false, 'syndicate.llm_calls': control.llmCalls }),
      });
      await drainAgentStream(traced as any, { streamText: true });
    }),
  );
  control.dispose();
  return { spans, models, invocationId };
}

// ── The rows ─────────────────────────────────────────────────────────────────

interface Ledger {
  adk_turns: any[];
  adk_telemetry: any[];
  adk_payloads: any[];
}

async function ledgerOf(spans: ReadableSpan[], policy: PayloadPolicy): Promise<Ledger> {
  const rows: Ledger = { adk_turns: [], adk_telemetry: [], adk_payloads: [] };
  const client = {
    from: (table: string) => ({
      insert: async (inserted: unknown[]) => {
        rows[table as keyof Ledger].push(...inserted);
        return { error: null };
      },
    }),
  };
  const exporter = new SupabaseSpanExporter({ client, policy, deadLetterFile: '' });
  exporter.export(spans, () => {});
  await exporter.forceFlush();
  return rows;
}

const TIMING_ATTRIBUTES = ['syndicate.latency.model_ms', 'syndicate.latency.tool_ms'];

/** A row with its ids, times and durations replaced; what must match. */
function comparable(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...row, ts: '<ts>', trace_id: '<trace>', span_id: '<span>' };
  for (const key of ['latency_ms', 'model_ms', 'tool_ms']) if (key in out) out[key] = '<ms>';
  if ('expires_at' in out) out.expires_at = '<expires>';
  const scrub = (attrs: Record<string, unknown>) => {
    const copy = { ...attrs };
    for (const key of TIMING_ATTRIBUTES) if (key in copy) copy[key] = '<ms>';
    return copy;
  };
  if (out.attributes) out.attributes = scrub(out.attributes);
  if (out.span) out.span = { ...out.span, traceId: '<trace>', spanId: '<span>', durationMs: '<ms>', attributes: scrub(out.span.attributes) };
  return out;
}

const STEP_PAYLOAD_COLUMNS = ['provider', 'request', 'response', 'request_chars', 'response_chars'];

/** Whether a payload row is a model step's own (its span a model call's, as lineage reads it). */
const stepRow = (run: Run) => {
  const steps = new Set(run.spans.filter((s) => isModelCallSpan(s.name, (s as any).instrumentationScope?.name ?? '')).map((s) => s.spanContext().spanId));
  return (row: any) => steps.has(row.span_id);
};

/** A payload row as compared: `scrub`bed, and a step row's own columns (the header) set aside. */
const withoutStepColumns = (isStep: (row: any) => boolean, scrub: (row: Record<string, any>) => Record<string, any> = comparable) => (row: any) => {
  const out = scrub(row);
  if (isStep(row)) for (const key of STEP_PAYLOAD_COLUMNS) out[key] = '<step>';
  return out;
};

/** A run's ledger as compared: every row scrubbed, each payload row marked a step row or not. What ADK's recording holds. */
interface ComparedLedger {
  adk_turns: Record<string, any>[];
  adk_telemetry: Record<string, any>[];
  adk_payloads: Record<string, any>[];
  /** For each payload row, in order: a model step's own row. */
  steps: boolean[];
}

function comparedLedger(ledger: Ledger, run: Run, scrub: (row: Record<string, any>) => Record<string, any> = comparable): ComparedLedger {
  const isStep = stepRow(run);
  return {
    adk_turns: ledger.adk_turns.map(scrub),
    adk_telemetry: ledger.adk_telemetry.map(scrub),
    adk_payloads: ledger.adk_payloads.map(withoutStepColumns(isStep, scrub)),
    steps: ledger.adk_payloads.map(isStep),
  };
}

interface Compared {
  adk: ComparedLedger;
  native: Ledger;
  nativeRun: Run;
}

/** Takes ADK's ledger for case `name` (recorded, or live), runs the turn on the native loop, and asserts the ledgers hold the same rows. */
async function assertSameLedger(name: string, config: SyndicateYamlConfig, scripts: Models, policy: PayloadPolicy, parts: any[] = [{ text: 'find the thing' }]): Promise<Compared> {
  resetCircuits();
  const { invocationId, ledger: adk } = await reference(name, async () => {
    const adkRun = await runOnAdk(config, scripts, parts);
    return { invocationId: adkRun.invocationId, ledger: comparedLedger(await ledgerOf(adkRun.spans, policy), adkRun) };
  });
  resetCircuits();
  const nativeRun = await runNative(config, scripts, parts, invocationId);
  resetCircuits();
  const native = await ledgerOf(nativeRun.spans, policy);
  const isNativeStep = stepRow(nativeRun);

  assert.deepEqual(native.adk_turns.map(comparable), adk.adk_turns, 'adk_turns');
  assert.deepEqual(native.adk_telemetry.map(comparable), adk.adk_telemetry, 'adk_telemetry');

  // adk_payloads: a model step's own row differs in the three columns the header names.
  assert.deepEqual(native.adk_payloads.map(isNativeStep), adk.steps, 'payload rows: step rows and failed-call rows in the same order');
  assert.deepEqual(native.adk_payloads.map(withoutStepColumns(isNativeStep)), adk.adk_payloads, 'adk_payloads');

  // The loop's step rows hold the request the adapter got and the response it gave, under the provider's name.
  const sent = Object.values(nativeRun.models).flatMap((m) => m.requests);
  for (const row of native.adk_payloads.filter(isNativeStep)) {
    assert.equal(row.provider, 'scripted');
    assert.ok(sent.some((r) => JSON.stringify(withoutSignal(r)) === JSON.stringify(row.request)), 'a request the adapter was handed');
    assert.equal(row.response.partial, false);
    assert.equal(row.request_chars, JSON.stringify(row.request).length);
  }
  return { adk, native, nativeRun };
}

function withoutSignal(request: ModelRequest): Omit<ModelRequest, 'signal'> {
  const { signal: _signal, ...rest } = request;
  return rest;
}

const ALL: PayloadPolicy = { mode: 'all', sampleRate: 1, ttlDays: 30 };

// ── The cases ────────────────────────────────────────────────────────────────

test('a tool call, then the answer: the same turn, telemetry and payload rows on both runtimes', async () => {
  const { native, nativeRun } = await assertSameLedger(
    'tool-call-then-answer',
    syndicate({ tools: ['native_ledger_lookup'] }),
    {
      boss: (_r, n) =>
        n === 1 ? toolCall('native_ledger_lookup', { key: 'alpha' }, 'call-1') : answer('alpha is found', { inputTokens: 40, outputTokens: 6 }),
    },
    ALL,
  );
  const [turn] = native.adk_turns;
  assert.equal(turn.tool_calls, 1);
  assert.deepEqual(turn.tool_events, [
    { name: 'ToolCall', tool: 'native_ledger_lookup', args: { key: 'alpha' } },
    { name: 'ToolResponse', tool: 'native_ledger_lookup', data: { result: 'found alpha' } },
  ]);
  assert.equal(turn.llm_calls, 2);
  assert.equal(turn.input_tokens, 40);
  assert.equal(turn.output_tokens, 6);
  assert.equal(turn.output, 'alpha is found');
  assert.equal(turn.agent, 'Solo');
  assert.ok(turn.tool_ms >= TOOL_MS - 5, `tool time counts the tool.execute span (${turn.tool_ms} ms)`);
  assert.deepEqual(native.adk_telemetry.map((r) => [r.span_name, r.agent]), [
    ['llm.request', 'Solo'],
    ['llm.request', 'Solo'],
    [`Syndicate Execution: ${APP}`, 'Solo'],
  ]);
  assert.deepEqual(native.adk_payloads.map((r) => r.reason), ['all', 'all']);

  // The loop's spans, nested as ADK nests its own.
  const byId = new Map(nativeRun.spans.map((s) => [s.spanContext().spanId, s]));
  const parentName = (s: ReadableSpan) => byId.get((s as any).parentSpanContext?.spanId)?.name;
  const named = (name: string) => nativeRun.spans.filter((s) => s.name === name);
  assert.equal(named('agent.invoke Solo').length, 1);
  assert.equal(parentName(named('agent.invoke Solo')[0] as ReadableSpan), `Syndicate Execution: ${APP}`);
  assert.deepEqual(named('model.call').map(parentName), ['agent.invoke Solo', 'agent.invoke Solo']);
  assert.deepEqual(named('llm.request').map(parentName), ['model.call', 'model.call']);
  assert.deepEqual(named('tool.execute native_ledger_lookup').map(parentName), ['agent.invoke Solo']);
  const tool = named('tool.execute native_ledger_lookup')[0] as ReadableSpan;
  assert.equal(tool.attributes['gen_ai.tool.call.id'], 'call-1');
  assert.equal(tool.attributes['tool.args'], undefined, 'a tool span carries no arguments');
  const agentSpan = named('agent.invoke Solo')[0] as ReadableSpan;
  assert.equal(agentSpan.attributes['agent.end_reason'], 'final');
});

test('a failed call: the same rows, the failed call’s payload from its llm.request on both runtimes', async () => {
  const { adk, native, nativeRun } = await assertSameLedger('failed-call', syndicate({}), { boss: () => failure({ code: '429', message: 'rate limited' }) }, ALL);
  const [turn] = native.adk_turns;
  assert.equal(turn.error_code, '429');
  assert.equal(turn.error_message, 'rate limited');
  assert.equal(native.adk_payloads.length, 1);
  assert.deepEqual(native.adk_payloads[0].request, adk.adk_payloads[0].request, 'the request, as a ModelRequest, both ways');
  assert.equal(native.adk_payloads[0].reason, 'error');
  assert.equal(native.adk_payloads[0].response.errorCode, '429');
  const step = nativeRun.spans.find((s) => s.name === 'model.call') as ReadableSpan;
  assert.equal(step.attributes['llm.payload.request'], undefined, 'the failed step carries no payload of its own');
  assert.equal(step.attributes['llm.error_code'], '429');
});

test('a throwing tool and a fallback model: the same rows on both runtimes', async () => {
  await assertSameLedger(
    'throwing-tool',
    syndicate({ tools: ['native_ledger_broken'] }),
    { boss: (_r, n) => (n === 1 ? toolCall('native_ledger_broken', {}, 'call-b') : answer('sorry')) },
    ALL,
  );
  const { native } = await assertSameLedger(
    'fallback-model',
    syndicate({ model: 'scripted/primary', fallback_model: 'scripted/backup' }),
    {
      primary: () => failure({ code: 'SCRIPTED_ERROR', message: 'HTTP 503', retryable: true, status: 503 }),
      backup: () => answer('from the backup', { inputTokens: 5, outputTokens: 2 }),
    },
    ALL,
  );
  assert.deepEqual(native.adk_turns[0].models, ['scripted/backup', 'scripted/primary']);
  // The primary's failure from its llm.request, then the step: under the agent's model, as ADK's call_llm names it, its request sent to the backup.
  assert.deepEqual(native.adk_payloads.map((r) => [r.model, r.response.errorCode ?? null, r.request.model]), [
    ['scripted/primary', 'SCRIPTED_ERROR', 'scripted/primary'],
    ['scripted/primary', null, 'scripted/backup'],
  ]);
});

test('under an errors-only policy a clean turn keeps no payloads on either runtime', async () => {
  const { native } = await assertSameLedger(
    'errors-only-policy',
    syndicate({ tools: ['native_ledger_lookup'] }),
    { boss: (_r, n) => (n === 1 ? toolCall('native_ledger_lookup', { key: 'b' }, 'call-2') : answer('ok')) },
    { mode: 'errors', sampleRate: 0, ttlDays: 30 },
  );
  assert.equal(native.adk_payloads.length, 0);
});

// ── A workflow: per-node attribution (WS4-6, ADR 0095) ───────────────────────

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastUserText = (request: ModelRequest): string =>
  (request.messages.at(-1)?.parts ?? []).map((p: any) => (p.type === 'text' ? p.text : '')).join('');

/**
 * A graph with every kind of node: an agent, a tool node, a fan-out, a map
 * whose items run side by side, a join, and an agent that calls a tool.
 * Finish times are at least 20 ms apart, so the spans end in one order.
 */
function workflowSyndicate(): SyndicateYamlConfig {
  const node = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });
  return validateSyndicateConfig(
    {
      syndicate_name: 'LedgerGraph',
      memory_system: 'internal-only',
      orchestrator: node('Triage'),
      subagents: [node('Lister', { outputSchema: { type: 'ARRAY', items: { type: 'STRING' } } }), node('Summarizer'), node('Editor', { tools: ['native_ledger_lookup'] })],
      workflow: {
        edges: [['START', 'Triage', ['Lookup', 'Lister']], ['Lookup', 'Both'], ['Lister', 'Each', 'Both'], ['Both', 'Editor']],
        nodes: { Lookup: { tool: 'native_ledger_lookup' }, Each: { map: 'Summarizer' }, Both: { join: true } },
      },
      retries: { model_errors: 0, tool_errors: 0 },
    },
    'test',
  ) as SyndicateYamlConfig;
}

const workflowScripts: Models = {
  triage: () => answer('{"key":"alpha"}', { inputTokens: 11, outputTokens: 3 }),
  lister: async () => {
    await delay(TOOL_MS + 40);
    return answer('["a","b"]', { inputTokens: 12, outputTokens: 4 });
  },
  summarizer: async (request) => {
    if (lastUserText(request) === 'b') await delay(30);
    return answer(`s(${lastUserText(request)})`, { inputTokens: 13, outputTokens: 5 });
  },
  editor: (_r, n) => (n === 1 ? toolCall('native_ledger_lookup', { key: 'beta' }, 'call-e') : answer('edited', { inputTokens: 14, outputTokens: 6 })),
};

/** One workflow turn through runSyndicateTurn on `runtime`, traced, and the spans it ended. */
async function workflowTurn(runtime: 'adk' | 'native'): Promise<Run & { status: string }> {
  const models = build(workflowScripts);
  // ADK's own in-memory store under ADK (live only); the engine's on native, as a consumer without ADK holds it (ADR 0102).
  const sessionService = runtime === 'adk' ? new (await import('@google/adk')).InMemorySessionService() : asAdkSessionService(new InProcessSessionService());
  let status = '';
  const spans = await spansOf(async () => {
    const r = await runSyndicateTurn({
      runtime,
      config: workflowSyndicate(),
      parts: [{ text: 'go' }],
      appName: APP,
      userId: USER,
      sessionId: SESSION,
      sessionService,
      compile: { resolveModel: shimResolver(models), log: () => {} },
    });
    status = r.status;
  });
  const session = await sessionService.getSession({ appName: APP, userId: USER, sessionId: SESSION });
  return { spans, models, status, invocationId: session?.events.find((e) => e.author === 'user')?.invocationId as string };
}

/** A workflow ledger row as compared: the invocation id differs per run; everything else of a row must match. */
const scrubInvocation = (row: Record<string, any>) => {
  const out = comparable(row);
  if ('invocation_id' in out) out.invocation_id = '<inv>';
  if (out.attributes?.['adk.invocation_id']) out.attributes = { ...out.attributes, 'adk.invocation_id': '<inv>' };
  if (out.span?.attributes?.['adk.invocation_id']) out.span = { ...out.span, attributes: { ...out.span.attributes, 'adk.invocation_id': '<inv>' } };
  return out;
};

test('a workflow on native writes the ledger rows ADK writes, each model call attributed to its node’s agent', async () => {
  resetCircuits();
  // ADK's side (recorded, or live): the turn's status and its ledger, scrubbed as compared.
  const adk = await reference('workflow', async () => {
    const adkRun = await workflowTurn('adk');
    return { status: adkRun.status, ledger: comparedLedger(await ledgerOf(adkRun.spans, ALL), adkRun, scrubInvocation) };
  });
  resetCircuits();
  const nativeRun = await workflowTurn('native');
  assert.equal(adk.status, 'completed');
  assert.equal(nativeRun.status, 'completed');
  const native = await ledgerOf(nativeRun.spans, ALL);

  assert.deepEqual(native.adk_turns.map(scrubInvocation), adk.ledger.adk_turns, 'adk_turns');
  assert.deepEqual(native.adk_telemetry.map(scrubInvocation), adk.ledger.adk_telemetry, 'adk_telemetry');

  // Per-node attribution: every model call's row names the agent of the node that made it.
  assert.deepEqual(native.adk_telemetry.map((r) => [r.span_name, r.agent, r.model]), [
    ['llm.request', 'Triage', 'scripted/triage'],
    ['llm.request', 'Lister', 'scripted/lister'],
    ['llm.request', 'Summarizer', 'scripted/summarizer'],
    ['llm.request', 'Summarizer', 'scripted/summarizer'],
    ['llm.request', 'Editor', 'scripted/editor'],
    ['llm.request', 'Editor', 'scripted/editor'],
    ['Syndicate Execution: LedgerGraph', 'Editor', null],
  ]);
  const [turn] = native.adk_turns;
  assert.equal(turn.stage, 'workflow');
  assert.equal(turn.llm_calls, 6);
  assert.equal(turn.tool_calls, 1, 'the Editor’s call; a tool node answers without a call');
  assert.ok(turn.tool_ms >= 2 * TOOL_MS - 10, `tool time counts the tool node’s span and the Editor’s (${turn.tool_ms} ms)`);

  // adk_payloads: the step rows hold each runtime's own shapes (the header), every other column matches.
  assert.deepEqual(native.adk_payloads.map(withoutStepColumns(stepRow(nativeRun), scrubInvocation)), adk.ledger.adk_payloads, 'adk_payloads');
  assert.deepEqual(native.adk_payloads.map((r) => r.agent), ['Triage', 'Lister', 'Summarizer', 'Summarizer', 'Editor', 'Editor']);

  // The spans nest as ADK's: workflow → node → agent → model call, a map item's node under its map's.
  const byId = new Map(nativeRun.spans.map((s) => [s.spanContext().spanId, s]));
  const parentName = (s: ReadableSpan) => byId.get((s as any).parentSpanContext?.spanId)?.name;
  const named = (name: string) => nativeRun.spans.filter((s) => s.name === name);
  assert.equal(parentName(named('workflow.invoke LedgerGraph')[0] as ReadableSpan), 'Syndicate Execution: LedgerGraph');
  for (const name of ['Triage', 'Lookup', 'Lister', 'Each', 'Both', 'Editor']) {
    assert.deepEqual(named(`node.execute ${name}`).map(parentName), ['workflow.invoke LedgerGraph'], name);
  }
  assert.deepEqual(named('node.execute Summarizer').map(parentName), ['node.execute Each', 'node.execute Each']);
  assert.deepEqual(named('agent.invoke Summarizer').map(parentName), ['node.execute Summarizer', 'node.execute Summarizer']);
  for (const name of ['Triage', 'Lister', 'Editor']) assert.deepEqual(named(`agent.invoke ${name}`).map(parentName), [`node.execute ${name}`], name);
  assert.deepEqual(named('tool.execute native_ledger_lookup').map(parentName).sort(), ['agent.invoke Editor', 'node.execute Lookup']);
  const lookup = named('node.execute Lookup')[0] as ReadableSpan;
  assert.deepEqual(
    ['adk.node.path', 'adk.node.run_id', 'adk.node.attempt', 'adk.node.status', 'adk.node.interrupt_count'].map((k) => lookup.attributes[k]),
    ['LedgerGraph.Lookup', '1', 1, 'completed', 0],
  );
  assert.equal(named('node.execute Summarizer').map((s) => s.attributes['adk.node.path']).sort().join(), 'LedgerGraph.Each.Summarizer@0,LedgerGraph.Each.Summarizer@1');
});

// ── The naming schemes ───────────────────────────────────────────────────────

test('lineage reads both runtimes’ span names', () => {
  assert.equal(agentOfSpanName('invoke_agent Analyst'), 'Analyst');
  assert.equal(agentOfSpanName('agent.invoke Analyst'), 'Analyst');
  assert.equal(agentOfSpanName('llm.request'), null);
  assert.ok(isToolSpanName('execute_tool lookup') && isToolSpanName('tool.execute lookup'));
  assert.ok(!isToolSpanName('execute_tool') && !isToolSpanName('tool.executed'));
  assert.ok(isModelCallSpan('call_llm', 'gcp.vertex.agent') && isModelCallSpan('model.call', 'melchizedek.runtime'));
  assert.ok(!isModelCallSpan('model.call', 'somebody-else') && !isModelCallSpan('call_llm', 'melchizedek.runtime'));
});

test('a model.call span is a payload span only when it carries a payload', () => {
  const span = (attributes: Record<string, unknown>, scope = 'melchizedek.runtime') =>
    ({ name: 'model.call', attributes, instrumentationScope: { name: scope } }) as unknown as ReadableSpan;
  assert.equal(isPayloadSpan(span({ 'llm.payload.request': '{}', 'llm.payload.response': '{}' })), true);
  assert.equal(isPayloadSpan(span({ 'llm.error_code': '429' })), false);
  assert.equal(isPayloadSpan(span({ 'llm.payload.response': '{}' }, 'other')), false);
});

test('TELEMETRY_PAYLOADS=off records no payload on the loop’s spans', async () => {
  const saved = process.env.TELEMETRY_PAYLOADS;
  process.env.TELEMETRY_PAYLOADS = 'off';
  try {
    const config = syndicate({});
    const run = await runNative(config, { boss: () => answer('fine') }, [{ text: 'hi' }], 'e-off');
    const step = run.spans.find((s) => s.name === 'model.call') as ReadableSpan;
    assert.ok(step, 'the span is still opened');
    assert.equal(step.attributes['llm.payload.request'], undefined);
    assert.equal(step.attributes['gen_ai.system'], 'scripted');
  } finally {
    if (saved === undefined) delete process.env.TELEMETRY_PAYLOADS;
    else process.env.TELEMETRY_PAYLOADS = saved;
  }
});

test('a consumer that stops early still ends every span the loop opened', async () => {
  const config = syndicate({ tools: ['native_ledger_lookup'] });
  const models = build({ boss: (_r, n) => (n === 1 ? toolCall('native_ledger_lookup', { key: 'c' }, 'call-3') : answer('done')) });
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: APP, userId: USER, sessionId: 'early' });
  await sessions.append(session, { id: 'u0000002', invocationId: 'e-early', author: 'user', content: { role: 'user', parts: [{ text: 'go' }] }, actions: {}, timestamp: 1 });
  const control = createTurnControl();
  const spans = await spansOf(() =>
    runWithTurnControl(control, async () => {
      const loop = runAgentLoop(nativeAgentOf(config.orchestrator), {
        session,
        sessions,
        selfCorrection: new SelfCorrection(config.retries ?? {}),
        invocationId: 'e-early',
        adapterFor: () => models.boss as ModelAdapter,
      });
      const first: TurnEvent | undefined = (await loop.next()).value as TurnEvent;
      assert.ok(first?.content?.parts?.[0]?.functionCall);
      await loop.return(undefined as any);
    }),
  );
  control.dispose();
  assert.deepEqual(spans.map((s) => s.name).sort(), ['agent.invoke Solo', 'llm.request', 'model.call']);
});
