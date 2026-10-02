/**
 * tests/otlpFilter.test.ts — what an external OTLP backend receives
 * (OTEL_EXPORT_CONTENT): real SDK spans through FilteringSpanExporter into an
 * in-memory exporter standing in for the backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sdkBase from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { FilteringSpanExporter, otlpContentMode } from '../lib/observability/otlpFilter.ts';
import { telemetryRedactor } from '../lib/observability/redact.ts';

const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = sdkBase as any;
const KEY = 'sk-ant-fixture0123456789abcdefghij'; // gitleaks:allow (test fixture)

async function exported(mode: 'redacted' | 'off' | 'raw'): Promise<ReadableSpan> {
  const backend = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new FilteringSpanExporter(backend, mode, telemetryRedactor({ TELEMETRY_REDACT: 'secret,email' } as any)))],
  });
  const span = provider.getTracer('t').startSpan('Syndicate Execution: Desk');
  span.setAttributes({
    'syndicate.input': `my key is ${KEY}, mail me at a@b.example`,
    'syndicate.output': 'the answer',
    'llm.payload.request': '{"contents":"..."}',
    'tool.args': '{"q":"private"}',
    'user.id': 'caller/end-user-7',
    'llm.model': 'gemini-x',
    'syndicate.tokens.input': 42,
    'syndicate.route': 'Research',
  });
  span.addEvent('tool.call', { 'tool.args': '{"q":"private"}', 'tool.name': 'web_extract' });
  span.end();
  await provider.forceFlush();
  return backend.getFinishedSpans()[0];
}

test('redacted (the default) scrubs credentials and the chosen kinds, keeps the conversation', async () => {
  assert.equal(otlpContentMode({}), 'redacted');
  const s = await exported('redacted');
  const input = String(s.attributes['syndicate.input']);
  assert.ok(!input.includes(KEY), 'the key never leaves');
  assert.match(input, /\[redacted:secret\]/);
  assert.match(input, /\[redacted:email\]/);
  assert.equal(s.attributes['syndicate.output'], 'the answer');
  assert.equal(s.attributes['syndicate.tokens.input'], 42);
});

test('off drops every conversation attribute and hashes the user id; metrics and ids stay', async () => {
  assert.equal(otlpContentMode({ OTEL_EXPORT_CONTENT: 'off' } as any), 'off');
  const s = await exported('off');
  for (const k of ['syndicate.input', 'syndicate.output', 'llm.payload.request', 'tool.args']) assert.ok(!(k in s.attributes), k);
  assert.match(String(s.attributes['user.id']), /^sha256:[0-9a-f]{16}$/);
  assert.equal(s.attributes['llm.model'], 'gemini-x');
  assert.equal(s.attributes['syndicate.route'], 'Research');
  assert.equal(s.name, 'Syndicate Execution: Desk', 'the rest of the span reads through');
  assert.ok(!('tool.args' in (s.events[0]!.attributes ?? {})), 'events are filtered too');
  assert.equal(s.events[0]!.attributes!['tool.name'], 'web_extract');
  assert.ok(s.spanContext().traceId, 'span methods still work');
});

test('raw sends spans as recorded', async () => {
  const s = await exported('raw');
  assert.ok(String(s.attributes['syndicate.input']).includes(KEY));
});
