/**
 * tests/traceOff.test.ts — `runSyndicateTurn({ trace: false })` records
 * nothing. With the Supabase ledger and an OTLP endpoint both configured
 * (pointed at a loopback server standing in for both), a turn that opted out
 * of tracing starts no tracer, opens no span (root, agent, model step,
 * llm.request, tool call) and sends no row and no OTLP batch; a default turn
 * in the same process still exports, and an untraced turn after it still
 * sends nothing. Offline: scripted models, a server on 127.0.0.1.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { trace } from '@opentelemetry/api';

import { flushTracing, onSpanEnd } from '../lib/observability/tracer.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

/** What reached the stand-in ledger and OTLP collector: one entry per request. */
const received: string[] = [];
let http: HttpServer;
let outputs = '';
const saved: Record<string, string | undefined> = {};
const ENV = ['TELEMETRY_SUPABASE', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OUTPUTS_DIR'];

before(async () => {
  const app = express();
  app.post('/rest/v1/:table', express.json({ limit: '10mb' }), (req, res) => {
    received.push(`ledger:${req.params.table}`);
    res.status(201).end();
  });
  app.post('/v1/traces', express.raw({ type: () => true, limit: '10mb' }), (_req, res) => {
    received.push('otlp');
    res.status(200).end();
  });
  http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const addr = http.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  for (const k of ENV) saved[k] = process.env[k];
  outputs = mkdtempSync(join(tmpdir(), 'trace-off-'));
  process.env.TELEMETRY_SUPABASE = 'true';
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-test-service-role';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = base;
  process.env.OUTPUTS_DIR = outputs;
});

after(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  http?.closeAllConnections?.();
  http?.close();
  rmSync(outputs, { recursive: true, force: true });
});

const config = {
  syndicate_name: 'Quiet',
  orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout.' },
  subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
} as unknown as SyndicateYamlConfig;

/** A DELEGATE turn: two agents, three model calls, one tool (delegation) call. */
function turn(sessionId: string, traceOpt: false | undefined) {
  const boss = new ScriptedLlm('scripted/boss', (_req, n) => (n === 1 ? call('Scout', { request: 'find it' }) : text('Here it is.')));
  const scout = new ScriptedLlm('scripted/scout', () => text('found'));
  return runSyndicateTurn({
    config,
    parts: [{ text: 'find the thing' }],
    appName: 'trace-off',
    userId: 'u',
    sessionId,
    sessionService: new InProcessSessionService(),
    compile: { resolveModel: scriptedResolver({ boss, scout }) },
    ...(traceOpt === false ? { trace: false as const } : {}),
  });
}

/** Whether a tracer provider has been registered behind the global proxy. */
function tracerStarted(): boolean {
  const delegate = (trace.getTracerProvider() as { getDelegate?: () => object }).getDelegate?.();
  return !!delegate && delegate.constructor.name !== 'NoopTracerProvider';
}

/** Lets the sinks deliver: the batch processors flush, then the ledger's inserts settle. */
async function settle(): Promise<void> {
  await flushTracing();
  await new Promise((r) => setTimeout(r, 50));
  await flushTracing();
}

test('trace: false with the ledger and OTLP configured starts no tracer and exports nothing', async () => {
  const result = await turn('quiet-1', false);
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(result.text, 'Here it is.');
  assert.equal(result.usage.llmCalls, 3, 'the step budget still counts every call');
  assert.equal(tracerStarted(), false, 'an untraced turn does not start the tracer');
  await settle();
  assert.deepEqual(received, []);
});

test('a default turn still exports to the ledger and the OTLP endpoint', async () => {
  const ended: string[] = [];
  const off = onSpanEnd((s) => ended.push(s.name));
  try {
    const result = await turn('loud-1', undefined);
    assert.equal(result.status, 'completed', result.error?.message);
  } finally {
    off();
  }
  assert.equal(tracerStarted(), true);
  await settle();
  assert.ok(ended.includes('Syndicate Execution: Quiet'), `spans: ${ended.join(', ')}`);
  assert.ok(ended.includes('llm.request') && ended.includes('model.call') && ended.includes('tool.execute Scout'), `spans: ${ended.join(', ')}`);
  assert.ok(received.includes('ledger:adk_telemetry'), `received: ${received.join(', ')}`);
  assert.ok(received.includes('ledger:adk_turns'), `received: ${received.join(', ')}`);
  assert.ok(received.includes('otlp'), `received: ${received.join(', ')}`);
});

test('trace: false after the tracer started still opens no span and sends nothing', async () => {
  await settle();
  received.length = 0;
  const ended: string[] = [];
  const off = onSpanEnd((s) => ended.push(s.name));
  try {
    const result = await turn('quiet-2', false);
    assert.equal(result.status, 'completed', result.error?.message);
  } finally {
    off();
  }
  await settle();
  assert.deepEqual(ended, [], 'no span ended during the untraced turn');
  assert.deepEqual(received, []);
});
