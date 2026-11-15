/**
 * tests/runKey.test.ts — a program's run in the ledger (ADR 0159).
 *
 * A run is a trace of steps; every turn stays a trace of its own and names
 * the run and the step that started it. Offline, with a ledger client that
 * keeps the rows in memory and turns over empty event streams: no model is
 * called. Covers the step kind, the always-root turn (two turns under one
 * active span get two trace ids), the stamp on turns, steps and direct model
 * calls, a step's metadata limits, and what an untraced turn leaves behind.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { context, trace } from '@opentelemetry/api';

import { ledgerSpanKind } from '../lib/observability/lineage.ts';
import { MAX_META_KEYS } from '../lib/observability/metadata.ts';
import { patternRedactor, setTelemetryRedactor } from '../lib/observability/redact.ts';
import { MAX_STEP_NAME_CHARS, currentRun, stepMetaAttributes, traceModelCall, traceRun, traceStep } from '../lib/observability/run.ts';
import { attachLedger, flushTracing, initializeTracing, traceAgentRun, traceLlmGeneration } from '../lib/observability/tracer.ts';
import type { TelemetryRow, TurnRow } from '../lib/observability/supabaseSpanExporter.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import type { LlmResponse } from '../lib/models/genaiMapping.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import * as barrel from '../lib/index.ts';

// Obviously fake, but shaped like a key so the redactor's `secret` pattern matches it.
const FAKE_KEY = `sk-${'x'.repeat(24)}`;

const rows: { adk_turns: TurnRow[]; adk_telemetry: TelemetryRow[]; adk_payloads: unknown[] } = { adk_turns: [], adk_telemetry: [], adk_payloads: [] };
let detach: () => Promise<void>;

before(() => {
  detach = attachLedger(
    {
      from: (table: string) => ({
        insert: async (inserted: unknown[]) => {
          (rows[table as keyof typeof rows] as unknown[]).push(...inserted);
          return { error: null };
        },
      }),
    },
    { deadLetterFile: '' },
  );
});

after(async () => {
  await detach();
});

/** The rows written since the last call. */
async function taken(): Promise<typeof rows> {
  await flushTracing();
  const out = { adk_turns: [...rows.adk_turns], adk_telemetry: [...rows.adk_telemetry], adk_payloads: [...rows.adk_payloads] };
  rows.adk_turns.length = rows.adk_telemetry.length = rows.adk_payloads.length = 0;
  return out;
}

async function* events(...list: TurnEvent[]): AsyncGenerator<TurnEvent, void, void> {
  yield* list;
}

/** One turn over an empty event stream: its root span and nothing else. */
async function emptyTurn(syndicateName: string, during?: () => Promise<void>): Promise<void> {
  const stream = during
    ? (async function* () {
        await during();
      })()
    : events();
  for await (const _ of traceAgentRun(stream as AsyncIterableIterator<TurnEvent>, { syndicateName, sessionId: 's1', userId: 'u1' })) void _;
}

/** One provider call with no adapter behind it: a generator of one response carrying usage. */
async function directCall(model: string): Promise<void> {
  const inner = (async function* (): AsyncGenerator<LlmResponse, void> {
    yield { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 }, turnComplete: true } as LlmResponse;
  })();
  for await (const _ of traceLlmGeneration({ provider: 'gemini', model }, inner)) void _;
}

const named = (list: TelemetryRow[], name: string): TelemetryRow => {
  const found = list.filter((r) => r.span_name === name);
  assert.equal(found.length, 1, `one row named ${name}`);
  return found[0];
};
const attrs = (row: TelemetryRow): Record<string, unknown> => (row.span as { attributes: Record<string, unknown> }).attributes;

test('ledgerSpanKind: a step is kept, by its prefix only, and every other kind reads as before', () => {
  assert.equal(ledgerSpanKind('step.execute collect'), 'step');
  assert.equal(ledgerSpanKind('step.execute a name with spaces'), 'step');
  assert.equal(ledgerSpanKind('step.execute'), null, 'the prefix ends in a space');
  assert.equal(ledgerSpanKind('step.executed x'), null);
  assert.equal(ledgerSpanKind('my step.execute x'), null);
  assert.deepEqual(
    ['Syndicate Execution: A', 'llm.request', 'model.call', 'agent.invoke A', 'tool.execute t', 'script.invoke s', 'script.call agent:a', 'workflow.invoke w', 'node.execute n', 'credential.refresh'].map(ledgerSpanKind),
    ['turn', 'model', 'model', 'agent', 'tool', 'script', 'script', 'node', 'node', null],
  );
});

test('the package index exports the run functions', () => {
  assert.equal(barrel.traceRun, traceRun);
  assert.equal(barrel.traceStep, traceStep);
  assert.equal(barrel.traceModelCall, traceModelCall);
  assert.equal(barrel.currentRun, currentRun);
});

test('a turn is always its own trace: two turns under one active caller span get two trace ids and no parent', async () => {
  initializeTracing();
  const callerSpan = trace.getTracer('a-caller').startSpan('caller.work');
  await context.with(trace.setSpan(context.active(), callerSpan), async () => {
    await emptyTurn('First');
    await emptyTurn('Second');
  });
  callerSpan.end();
  const { adk_turns, adk_telemetry } = await taken();
  assert.equal(adk_turns.length, 2);
  const caller = callerSpan.spanContext().traceId;
  assert.notEqual(adk_turns[0].trace_id, adk_turns[1].trace_id, 'two turns, two traces');
  for (const turn of adk_turns) {
    assert.notEqual(turn.trace_id, caller, 'never the caller’s trace');
    assert.equal(turn.run_id, null, 'no run: no run key');
    assert.equal(turn.run_step_span_id, null);
  }
  assert.deepEqual(adk_telemetry.map((r) => [r.kind, r.parent_span_id, r.run_id]), [['turn', null, null], ['turn', null, null]]);
});

test('two turns under one step: two trace ids, both stamped with the run and the step; the step has a row; a direct llm.request names the step as its parent and carries the run', async () => {
  let inRun: ReturnType<typeof currentRun>;
  let inStep: ReturnType<typeof currentRun>;
  const result = await traceRun({ name: 'daily', id: '2026-11-15', meta: { edition: '2026-11-15' } }, async () => {
    inRun = currentRun();
    return traceStep(
      'collect',
      async () => {
        inStep = currentRun();
        await emptyTurn('Sweep');
        await emptyTurn('Claims');
        await directCall('gemini-3.8-flash');
        return 'done';
      },
      { meta: { stage: 2 } },
    );
  });
  assert.equal(result, 'done', 'the functions return what fn returns');
  assert.equal(currentRun(), undefined, 'no run outside it');
  const { adk_turns, adk_telemetry } = await taken();

  const root = named(adk_telemetry, 'step.execute daily');
  const step = named(adk_telemetry, 'step.execute collect');
  const call = named(adk_telemetry, 'llm.request');
  assert.deepEqual(inRun, { id: '2026-11-15', name: 'daily', traceId: root.trace_id, stepSpanId: root.span_id });
  assert.deepEqual(inStep, { id: '2026-11-15', name: 'daily', traceId: root.trace_id, stepSpanId: step.span_id });

  // The run's own trace: the root step, its child step, the direct call under it.
  assert.deepEqual([root.kind, root.parent_span_id, root.run_id, root.error], ['step', null, '2026-11-15', false]);
  assert.deepEqual([step.kind, step.parent_span_id, step.run_id, step.trace_id], ['step', root.span_id, '2026-11-15', root.trace_id]);
  assert.deepEqual([call.kind, call.parent_span_id, call.run_id, call.trace_id], ['model', step.span_id, '2026-11-15', root.trace_id]);
  assert.deepEqual([call.model, call.input_tokens, call.output_tokens], ['gemini-3.8-flash', 7, 3]);
  assert.equal(attrs(root)['run.name'], 'daily');
  assert.equal(attrs(root)['meta.edition'], '2026-11-15');
  assert.equal(attrs(step)['meta.stage'], 2);
  assert.equal(attrs(step)['run.name'], undefined, 'the run’s name is on its root step and its turns');
  // The root step collects the model calls no turn does.
  assert.equal(attrs(root)['run.llm_calls'], 1);
  assert.equal(attrs(root)['run.models'], 'gemini-3.8-flash');

  // The turns: each its own trace, each naming the run and the step.
  assert.equal(adk_turns.length, 2);
  assert.deepEqual(adk_turns.map((t) => t.syndicate), ['Sweep', 'Claims']);
  assert.equal(new Set([root.trace_id, ...adk_turns.map((t) => t.trace_id)]).size, 3, 'the run and each turn: three traces');
  for (const turn of adk_turns) {
    assert.equal(turn.run_id, '2026-11-15');
    assert.equal(turn.run_step_span_id, step.span_id);
    assert.equal(turn.attributes['run.id'], '2026-11-15');
    assert.equal(turn.attributes['run.name'], 'daily');
    assert.equal(turn.attributes['run.step_span_id'], step.span_id);
    assert.equal(turn.llm_calls, null, 'the direct call is the run’s, not a turn’s');
    const turnRoot = adk_telemetry.find((r) => r.trace_id === turn.trace_id)!;
    assert.deepEqual([turnRoot.kind, turnRoot.parent_span_id, turnRoot.run_id], ['turn', null, null], 'a turn’s own spans stay out of the run’s rows');
  }
  assert.equal(adk_telemetry.length, 5);
});

test('a model call inside a turn is the turn’s: no run key on it, counted on the turn, not on the run', async () => {
  await traceRun({ name: 'nightly' }, async () => {
    await emptyTurn('Desk', () => directCall('gemini-3.5-flash-lite'));
  });
  const { adk_turns, adk_telemetry } = await taken();
  const root = named(adk_telemetry, 'step.execute nightly');
  const call = named(adk_telemetry, 'llm.request');
  const [turn] = adk_turns;
  assert.match(root.run_id!, /^[0-9a-f-]{36}$/, 'a run with no id of its own gets a UUID');
  assert.equal(turn.run_id, root.run_id);
  assert.equal(turn.run_step_span_id, root.span_id, 'with no step open, the run’s root step is the step');
  assert.deepEqual([call.trace_id, call.parent_span_id, call.run_id], [turn.trace_id, turn.span_id, null]);
  assert.equal(call.session_id, 's1', 'it still carries its turn’s identity');
  assert.equal(turn.llm_calls, 1);
  assert.deepEqual([attrs(root)['run.llm_calls'], attrs(root)['run.models']], [0, '']);
});

test('traceStep outside a run is a run of its own; a step opened under another span still nests under its step, in the run’s trace', async () => {
  initializeTracing();
  await traceStep('solo', async () => {
    const other = trace.getTracer('a-caller').startSpan('caller.work');
    await context.with(trace.setSpan(context.active(), other), () => traceStep('inner', async () => {}));
    other.end();
  });
  const { adk_telemetry } = await taken();
  const solo = named(adk_telemetry, 'step.execute solo');
  const inner = named(adk_telemetry, 'step.execute inner');
  assert.match(solo.run_id!, /^[0-9a-f-]{36}$/);
  assert.deepEqual([solo.parent_span_id, attrs(solo)['run.name']], [null, 'solo']);
  assert.deepEqual([inner.trace_id, inner.parent_span_id, inner.run_id], [solo.trace_id, solo.span_id, solo.run_id]);
});

test('a run inside a run is a separate run', async () => {
  await traceRun({ name: 'outer', id: 'o-1' }, () => traceRun({ name: 'inner', id: 'i-1' }, async () => emptyTurn('Desk')));
  const { adk_turns, adk_telemetry } = await taken();
  const outer = named(adk_telemetry, 'step.execute outer');
  const inner = named(adk_telemetry, 'step.execute inner');
  assert.notEqual(outer.trace_id, inner.trace_id);
  assert.deepEqual([inner.parent_span_id, inner.run_id, outer.run_id], [null, 'i-1', 'o-1']);
  assert.deepEqual([adk_turns[0].run_id, adk_turns[0].run_step_span_id], ['i-1', inner.span_id]);
});

test('a step that throws is marked failed and rethrows; its row holds the error’s kind, never its message', async () => {
  class StageError extends Error {
    override name = 'StageError';
  }
  await assert.rejects(
    traceRun({ name: 'failing' }, () =>
      traceStep('stage', async () => {
        throw new StageError('the reader said something private');
      }),
    ),
    /something private/,
  );
  const { adk_telemetry } = await taken();
  const root = named(adk_telemetry, 'step.execute failing');
  const stage = named(adk_telemetry, 'step.execute stage');
  assert.deepEqual([root.error, stage.error, attrs(stage)['error.type']], [true, true, 'StageError']);
  assert.ok(!JSON.stringify([root, stage]).includes('something private'));
});

test('a step records no argument and no result', async () => {
  await traceRun({ name: 'quiet' }, () => traceStep('stage', async () => ({ secret: 'the whole edition' })));
  const { adk_telemetry } = await taken();
  assert.ok(!JSON.stringify(adk_telemetry).includes('the whole edition'));
  assert.deepEqual(Object.keys(attrs(named(adk_telemetry, 'step.execute stage'))).sort(), ['gen_ai.operation.name', 'run.id', 'step.name']);
});

test('step metadata keeps the metadata limits: bad keys, long values, credentials, agent.* and anything past 32 are dropped with a warning that names keys only; strings are redacted', () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => void warnings.push(message);
  setTelemetryRedactor(patternRedactor(['secret', 'email']));
  try {
    assert.deepEqual(
      stepMetaAttributes(
        {
          edition: '2026-11-15',
          count: 590,
          dry: false,
          contact: 'write to desk@example.com',
          'bad key': 'x',
          '.dot': 'x',
          long: 'v'.repeat(257),
          token: FAKE_KEY,
          'agent.name': 'x',
          nested: { a: 1 } as unknown as string,
          nan: Number.NaN,
        },
        'collect',
      ),
      { 'meta.edition': '2026-11-15', 'meta.count': 590, 'meta.dry': false, 'meta.contact': 'write to [redacted:email]' },
    );
    assert.equal(warnings.length, 1);
    for (const key of ['bad key', '.dot', 'long', 'token', 'agent.name', 'nested', 'nan']) assert.ok(warnings[0].includes(key), key);
    assert.ok(!warnings[0].includes(FAKE_KEY), 'never the value');
    assert.ok(!warnings[0].includes('v'.repeat(20)));

    warnings.length = 0;
    const many = Object.fromEntries(Array.from({ length: MAX_META_KEYS + 3 }, (_, i) => [`k${i}`, i]));
    assert.equal(Object.keys(stepMetaAttributes(many, 'collect')).length, MAX_META_KEYS);
    assert.match(warnings[0], /3 metadata entries dropped \(k32, k33, k34\)/);

    warnings.length = 0;
    assert.deepEqual(stepMetaAttributes(undefined, 'collect'), {});
    assert.deepEqual(stepMetaAttributes({ a: 'b' }, 'collect'), { 'meta.a': 'b' });
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = warn;
    setTelemetryRedactor(null);
  }
});

test('a run’s name and id are checked before anything runs: a name is one short line, an id is short and never a credential', async () => {
  let ran = false;
  const fn = async () => void (ran = true);
  await assert.rejects(traceRun({ name: '' }, fn), TypeError);
  await assert.rejects(traceRun({ name: 'x'.repeat(MAX_STEP_NAME_CHARS + 1) }, fn), TypeError);
  await assert.rejects(traceRun({ name: 'two\nlines' }, fn), TypeError);
  await assert.rejects(traceStep('   ', fn), TypeError);
  await assert.rejects(traceStep(`fetch ${FAKE_KEY}`, fn), (err: Error) => err instanceof TypeError && !err.message.includes(FAKE_KEY));
  await assert.rejects(traceRun({ name: 'ok', id: '' }, fn), TypeError);
  await assert.rejects(traceRun({ name: 'ok', id: 'x'.repeat(257) }, fn), TypeError);
  await assert.rejects(traceRun({ name: 'ok', id: FAKE_KEY }, fn), (err: Error) => err instanceof TypeError && !err.message.includes(FAKE_KEY));
  assert.equal(ran, false);
  assert.deepEqual((await taken()).adk_telemetry, []);
});

test('in a turn that opted out of tracing a step runs its function and records nothing', async () => {
  const control = createTurnControl({ untraced: true });
  const seen = await runWithTurnControl(control, () =>
    traceRun({ name: 'untraced', id: 'u-1' }, () =>
      traceStep('stage', async () => {
        await traceModelCall({ provider: 'gemini', model: 'gemini-3.8-flash' }, async () => ({ result: 1, usage: { inputTokens: 5, outputTokens: 2 } }));
        return currentRun();
      }),
    ),
  );
  control.dispose();
  assert.equal(seen, undefined, 'no span, so no run context');
  assert.deepEqual(await taken(), { adk_turns: [], adk_telemetry: [], adk_payloads: [] });
});

test('traceModelCall: the result comes back, the usage lands on an llm.request under the step, and the run counts it', async () => {
  const answer = await traceRun({ name: 'calls', id: 'c-1' }, () =>
    traceStep('extract', () =>
      traceModelCall({ provider: 'gemini', model: 'gemini-3.5-flash-lite' }, async () => ({
        result: { text: 'the answer' },
        usage: { inputTokens: 1200, outputTokens: 340, thinkingTokens: 40, cacheReadTokens: 800 },
      })),
    ),
  );
  assert.deepEqual(answer, { text: 'the answer' });
  const { adk_telemetry, adk_payloads } = await taken();
  const step = named(adk_telemetry, 'step.execute extract');
  const call = named(adk_telemetry, 'llm.request');
  assert.deepEqual(
    [call.provider, call.model, call.input_tokens, call.output_tokens, call.thinking_tokens, call.cache_read_tokens, call.parent_span_id, call.run_id, call.error],
    ['gemini', 'gemini-3.5-flash-lite', 1200, 300, 40, 800, step.span_id, 'c-1', false],
  );
  assert.equal(attrs(call)['llm.finish_reason'], 'stop');
  assert.ok(!JSON.stringify(adk_telemetry).includes('the answer'), 'no response is recorded');
  assert.deepEqual(adk_payloads, []);
  const root = named(adk_telemetry, 'step.execute calls');
  assert.deepEqual([attrs(root)['run.llm_calls'], attrs(root)['run.models']], [1, 'gemini-3.5-flash-lite']);
});

test('traceModelCall: a call that throws is a failed llm.request and rethrows; a call with no usage records zeros', async () => {
  await assert.rejects(
    traceStep('flaky', () =>
      traceModelCall({ provider: 'gemini', model: 'gemini-3.8-flash' }, async () => {
        throw new Error('503 from the provider');
      }),
    ),
    /503 from the provider/,
  );
  const failed = await taken();
  const call = named(failed.adk_telemetry, 'llm.request');
  assert.deepEqual([call.error, attrs(call)['llm.error_code']], [true, 'THROWN']);
  assert.equal(named(failed.adk_telemetry, 'step.execute flaky').error, true);

  assert.equal(await traceModelCall({ provider: 'x', model: 'no-usage' }, async () => ({ result: 'r' })), 'r');
  const bare = named((await taken()).adk_telemetry, 'llm.request');
  assert.deepEqual([bare.input_tokens, bare.output_tokens, bare.run_id, bare.parent_span_id], [0, 0, null, null], 'outside a run and a turn: a call on its own');
});

test('traceModelCall inside a turn whose step budget is spent throws without making the call', async () => {
  const control = createTurnControl({ maxLlmCalls: 1 });
  let made = 0;
  const call = () =>
    traceModelCall({ provider: 'gemini', model: 'gemini-3.8-flash' }, async () => {
      made++;
      return { result: made };
    });
  await runWithTurnControl(control, async () => {
    assert.equal(await call(), 1);
    await assert.rejects(call(), (err: Error & { code?: string }) => typeof err.code === 'string' && err.message.length > 0);
  });
  control.dispose();
  assert.equal(made, 1);
  await taken();
});
