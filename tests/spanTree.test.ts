/**
 * tests/spanTree.test.ts — the ledger keeps the span tree (ADR 0139), fully
 * offline: which spans get an adk_telemetry row and of what kind, each row's
 * parent (the nearest ancestor the ledger keeps, read from the tracer's
 * lineage when the span starts), a span's error flag, a tool span's
 * arguments and result (redacted, then cut at 8 KB), the cache counts and
 * finish reason on llm.request, and what leaves for an OTLP backend.
 * tests/nativeLedger.test.ts checks the tree of a real turn on the loop;
 * tests/postgresLedger.test.ts checks the columns and the cache pricing in
 * Postgres.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import type { FinalModelResponse, ModelResponse } from '../lib/models/contract.ts';
import { modelResponseToLlmResponse } from '../lib/models/genaiMapping.ts';
import type { LlmResponse } from '../lib/models/genaiMapping.ts';
import { LEDGER_PARENT_ATTRIBUTE, ledgerSpanKind } from '../lib/observability/lineage.ts';
import { filterAttributes } from '../lib/observability/otlpFilter.ts';
import { patternRedactor } from '../lib/observability/redact.ts';
import { SupabaseSpanExporter, isLedgerSpan, toTelemetryRow } from '../lib/observability/supabaseSpanExporter.ts';
import type { TelemetryRow } from '../lib/observability/supabaseSpanExporter.ts';
import { onSpanEnd, startEngineSpan, traceLlmGeneration } from '../lib/observability/tracer.ts';
import { TOOL_ATTRIBUTE_MAX_CHARS, traceToolCall, traceToolNodeCall } from '../lib/runtime/native/telemetry.ts';

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

/** Runs `fn` with `span` active, then ends the span. */
async function within<T>(span: ReturnType<typeof startEngineSpan>, fn: () => Promise<T>): Promise<T> {
  try {
    return await context.with(trace.setSpan(context.active(), span), fn);
  } finally {
    span.end();
  }
}

async function exported(spans: ReadableSpan[]): Promise<TelemetryRow[]> {
  const rows: TelemetryRow[] = [];
  const client = { from: (table: string) => ({ insert: async (r: unknown[]) => { if (table === 'adk_telemetry') rows.push(...(r as TelemetryRow[])); return { error: null }; } }) };
  const exporter = new SupabaseSpanExporter({ client, policy: { mode: 'off', sampleRate: 0, ttlDays: 30 }, deadLetterFile: '' });
  exporter.export(spans, () => {});
  await exporter.forceFlush();
  return rows;
}

test('the ledger keeps a row for each span of the tree, of its kind, and for no other span', () => {
  const kinds: Array<[string, string | null]> = [
    ['Syndicate Execution: Desk', 'turn'],
    ['agent.invoke Clerk', 'agent'],
    ['model.call', 'model'],
    ['llm.request', 'model'],
    ['tool.execute lookup', 'tool'],
    ['script.invoke weekly', 'script'],
    ['script.call agent:Clerk', 'script'],
    ['workflow.invoke Graph', 'node'],
    ['node.execute triage', 'node'],
    ['credential.refresh', null],
    ['invoke_agent Clerk', null],
    ['HTTP GET', null],
  ];
  for (const [name, kind] of kinds) {
    assert.equal(ledgerSpanKind(name), kind, name);
    assert.equal(isLedgerSpan({ name } as ReadableSpan), kind !== null, name);
  }
});

test('a row names its parent: the direct one, or the nearest ancestor the ledger keeps when a span between is not kept', async () => {
  const spans = await spansOf(async () => {
    const root = startEngineSpan('melchizedek-tracer', 'Syndicate Execution: TreeDesk');
    await within(root, async () => {
      const agent = startEngineSpan('melchizedek.runtime', 'agent.invoke Clerk');
      await within(agent, async () => {
        // A span the ledger does not keep, between the agent and its tool call.
        const refresh = startEngineSpan('melchizedek-tracer', 'credential.refresh');
        await within(refresh, async () => {
          const tool = startEngineSpan('melchizedek.runtime', 'tool.execute lookup');
          tool.setAttribute('tool.error', true);
          tool.end();
        });
      });
    });
  });
  const rows = await exported(spans);
  const byName = new Map(rows.map((r) => [r.span_name, r]));
  assert.deepEqual([...byName.keys()].sort(), ['Syndicate Execution: TreeDesk', 'agent.invoke Clerk', 'tool.execute lookup'], 'credential.refresh gets no row');
  const root = byName.get('Syndicate Execution: TreeDesk')!;
  const agent = byName.get('agent.invoke Clerk')!;
  const tool = byName.get('tool.execute lookup')!;
  assert.equal(root.parent_span_id, null);
  assert.equal(root.kind, 'turn');
  assert.equal(agent.parent_span_id, root.span_id);
  assert.equal(tool.parent_span_id, agent.span_id, 'the agent, not the refresh span between them');
  assert.equal((tool.span.attributes as Record<string, unknown>)[LEDGER_PARENT_ATTRIBUTE], agent.span_id);
  assert.equal((agent.span.attributes as Record<string, unknown>)[LEDGER_PARENT_ATTRIBUTE], undefined, 'recorded only where it differs from the direct parent');
  assert.deepEqual([root.error, agent.error, tool.error], [false, false, true], 'a tool error response marks its row');
});

test('a row read from a span the tracer did not see takes its direct parent, and an error status marks it', () => {
  const span = {
    name: 'agent.invoke Clerk',
    attributes: {},
    events: [],
    status: { code: SpanStatusCode.ERROR },
    startTime: [0, 0],
    duration: [0, 1_000_000],
    parentSpanContext: { spanId: 'abc123', traceId: 't' },
    spanContext: () => ({ traceId: 't', spanId: 's' }),
  } as unknown as ReadableSpan;
  const row = toTelemetryRow(span);
  assert.equal(row.parent_span_id, 'abc123');
  assert.equal(row.kind, 'agent');
  assert.equal(row.error, true);
});

const FAKE_KEY = 'sk-ant-api03-' + 'k'.repeat(40);

test('a tool span carries its arguments and its result, redacted, the result cut at 8 KB', async () => {
  const big = 'x'.repeat(TOOL_ATTRIBUTE_MAX_CHARS * 2);
  const spans = await spansOf(async () => {
    await traceToolCall({ id: 'c1', name: 'lookup', args: { key: 'alpha', token: FAKE_KEY } }, undefined, async () => ({
      part: { functionResponse: { name: 'lookup', response: { result: `${FAKE_KEY} ${big}` } } },
    }));
    await traceToolCall({ id: 'c2', name: 'small', args: {} }, undefined, async () => ({ part: { functionResponse: { name: 'small', response: { result: 'ok' } } } }));
    await traceToolNodeCall({ id: 'n1', name: 'tidy', args: { path: 'a' } }, undefined, async () => ({ tidied: 3 }));
  });
  const [lookup, small, node] = spans.map((s) => s.attributes);
  assert.equal(lookup['tool.args'], '{"key":"alpha","token":"[redacted:secret]"}');
  const result = lookup['tool.result'] as string;
  assert.equal(result.length, TOOL_ATTRIBUTE_MAX_CHARS, 'the first 8 KB');
  assert.ok(result.startsWith('{"result":"[redacted:secret] xxx'), 'redacted before it was cut');
  assert.ok(!result.includes(FAKE_KEY));
  assert.equal(lookup['tool.result_truncated'], true);
  assert.equal(small['tool.args'], '{}');
  assert.equal(small['tool.result'], '{"result":"ok"}');
  assert.equal(small['tool.result_truncated'], undefined);
  assert.equal(node['tool.args'], '{"path":"a"}', 'a tool node’s call too');
  assert.equal(node['tool.result'], '{"tidied":3}');
});

test('OTLP with OTEL_EXPORT_CONTENT=off drops a tool span’s arguments and result; redacted mode scrubs them', () => {
  const attrs = { 'gen_ai.tool.name': 'lookup', 'tool.args': `{"t":"${FAKE_KEY}"}`, 'tool.result': `{"r":"${FAKE_KEY}"}`, 'tool.result_truncated': true };
  const off = filterAttributes(attrs, 'off', undefined);
  assert.equal(off['tool.args'], undefined);
  assert.equal(off['tool.result'], undefined);
  assert.equal(off['gen_ai.tool.name'], 'lookup');
  const redacted = filterAttributes(attrs, 'redacted', patternRedactor(['secret']));
  assert.ok(!JSON.stringify(redacted).includes(FAKE_KEY));
});

test('llm.request records the cache counts and the finish reason its source response reports', async () => {
  const final = (usage: FinalModelResponse['usage'], finishReason: FinalModelResponse['finishReason'] = 'stop'): FinalModelResponse => ({
    partial: false, parts: [{ type: 'text', text: 'hi' }], finishReason, ...(usage ? { usage } : {}),
  });
  const run = async (responses: ModelResponse[], withSource: boolean) => {
    const sources = new WeakMap<LlmResponse, ModelResponse>();
    async function* inner(): AsyncGenerator<LlmResponse, void> {
      for (const r of responses) {
        const mapped = modelResponseToLlmResponse(r);
        sources.set(mapped, r);
        yield mapped;
      }
    }
    for await (const _ of traceLlmGeneration({ provider: 'scripted', model: 'scripted/cache', ...(withSource ? { source: (r: LlmResponse) => sources.get(r) } : {}) }, inner())) {
      /* drain */
    }
  };
  const spans = await spansOf(async () => {
    await run([final({ inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 600, cacheWriteTokens: 300 }, 'max_tokens')], true);
    await run([final({ inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 600, cacheWriteTokens: 300 })], false);
    await run([final({ inputTokens: 50, outputTokens: 5 })], true);
  });
  const [sourced, unsourced, uncached] = spans.filter((s) => s.name === 'llm.request').map((s) => s.attributes);
  assert.equal(sourced['llm.tokens.input'], 1_000, 'the cache counts are parts of the input');
  assert.equal(sourced['llm.tokens.cache_read'], 600);
  assert.equal(sourced['llm.tokens.cache_write'], 300);
  assert.equal(sourced['llm.finish_reason'], 'max_tokens');
  assert.equal(unsourced['llm.tokens.cache_read'], 600, 'Gemini’s usage names the reads');
  assert.equal(unsourced['llm.tokens.cache_write'], undefined, 'but not the writes: those need the source');
  assert.equal(unsourced['llm.finish_reason'], undefined);
  assert.equal(uncached['llm.tokens.cache_read'], undefined, 'nothing reported, nothing recorded');
  assert.equal(uncached['llm.finish_reason'], 'stop');
  const [row] = await exported(spans.filter((s) => s.name === 'llm.request'));
  assert.deepEqual([row.cache_read_tokens, row.cache_write_tokens, row.kind], [600, 300, 'model']);
});
