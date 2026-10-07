/**
 * tests/fallback.test.ts — `fallback_model` and the per-provider circuit
 * breaker (ADR 0044): a provider-side failure is answered by the fallback, a
 * request's own error is not, a stream that already produced text is never
 * replayed elsewhere, and a provider that keeps failing is skipped for the
 * cooldown. A failure arrives either as a throw (Gemini) or as a yielded
 * error response carrying customMetadata['error.retryable'] (every other
 * adapter, lib/models/errorResponse.ts); both are held to the same rules.
 * Offline: scripted models.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BaseLlm, InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { FallbackLlm, circuitOpen, isProviderFailure, resetCircuits } from '../lib/models/fallback.ts';
import { providerErrorResponse } from '../lib/models/errorResponse.ts';
import { providerForModel } from '../lib/models/providerMap.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, scriptedResolver, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Yields its parts, then throws: a stream that fails midway. */
class MidstreamFailure extends BaseLlm {
  calls = 0;
  constructor(model: string) {
    super({ model });
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    this.calls += 1;
    yield text('half an answer');
    throw httpError(503);
  }
  connect(_r: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('no live');
  }
}

function config(): SyndicateYamlConfig {
  return validateSyndicateConfig(
    { syndicate_name: 'S', orchestrator: { name: 'Main', model: 'scripted/primary', fallback_model: 'scripted/backup', instruction: 'Answer.' }, subagents: [] },
    't',
  ) as SyndicateYamlConfig;
}
const turn = (models: Record<string, BaseLlm>) =>
  runSyndicateTurn({
    config: config(),
    parts: [{ text: 'hello' }],
    appName: 'a',
    userId: 'u',
    sessionId: crypto.randomUUID(),
    sessionService: new InMemorySessionService(),
    compile: { resolveModel: scriptedResolver(models as any), log: () => {} },
    trace: false,
  });

beforeEach(() => resetCircuits());
afterEach(() => {
  delete process.env.MODEL_BREAKER_THRESHOLD;
  resetCircuits();
});

test('isProviderFailure: 5xx, 429 and resets count; a 4xx and a cancellation do not', () => {
  assert.equal(isProviderFailure(httpError(503)), true);
  assert.equal(isProviderFailure(httpError(429)), true);
  assert.equal(isProviderFailure(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isProviderFailure(httpError(400)), false);
  assert.equal(isProviderFailure(Object.assign(new Error('stop'), { name: 'AbortError' })), false);
});

test('a provider-side failure is answered by the fallback model', async () => {
  const primary = new ScriptedLlm('scripted/primary', () => {
    throw httpError(503);
  });
  const backup = new ScriptedLlm('scripted/backup', () => text('from the backup'));
  const r = await turn({ primary, backup });
  assert.equal(r.status, 'completed', r.error?.message);
  assert.match(r.text ?? '', /from the backup/);
  assert.deepEqual([primary.calls, backup.calls], [1, 1]);
});

test("the request's own error (a 400) is not redirected to the fallback", async () => {
  const primary = new ScriptedLlm('scripted/primary', () => {
    throw httpError(400);
  });
  const backup = new ScriptedLlm('scripted/backup', () => text('never'));
  const r = await turn({ primary, backup });
  assert.equal(r.status, 'failed');
  assert.equal(backup.calls, 0);
});

test('a stream that already produced text is never replayed on the fallback', async () => {
  const primary = new MidstreamFailure('scripted/primary');
  const backup = new ScriptedLlm('scripted/backup', () => text('never'));
  const r = await turn({ primary, backup });
  assert.equal(r.status, 'failed');
  assert.equal(backup.calls, 0);
});

test('after MODEL_BREAKER_THRESHOLD failures the primary is skipped until the cooldown ends', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '2';
  const primary = new ScriptedLlm('scripted/primary', () => {
    throw httpError(503);
  });
  const backup = new ScriptedLlm('scripted/backup', () => text('from the backup'));
  await turn({ primary, backup });
  await turn({ primary, backup });
  assert.equal(primary.calls, 2);
  const third = await turn({ primary, backup });
  assert.equal(third.status, 'completed');
  assert.equal(primary.calls, 2, 'the open circuit skips the primary');
  assert.equal(backup.calls, 3);
});

test('schema: fallback_model is a model id on any agent', () => {
  assert.throws(
    () => validateSyndicateConfig({ syndicate_name: 'S', orchestrator: { name: 'M', model: 'gemini-x', fallback_model: '', instruction: 'i' }, subagents: [] }, 't'),
    /fallback_model/,
  );
});

// ── Failures reported as error responses (every adapter but Gemini) ──────────

/** An error response as an adapter yields it once a provider call has failed with `status`. */
const errorResponse = (status: number) => providerErrorResponse(httpError(status), 'SCRIPTED_ERROR');
const PRIMARY_PROVIDER = providerForModel('scripted/primary');

test('a retryable error response is answered by the fallback, and the breaker counts the failure', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '1';
  const primary = new ScriptedLlm('scripted/primary', () => errorResponse(503));
  const backup = new ScriptedLlm('scripted/backup', () => text('from the backup'));
  const r = await turn({ primary, backup });
  assert.equal(r.status, 'completed', r.error?.message);
  assert.match(r.text ?? '', /from the backup/);
  assert.equal(r.error, undefined, 'the redirected error is never yielded');
  assert.deepEqual([primary.calls, backup.calls], [1, 1]);
  assert.equal(circuitOpen(PRIMARY_PROVIDER), true, 'the failure was recorded on the breaker');
});

test('a non-retryable error response is passed on, and is never recorded as a success', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '2';
  const statuses = [503, 400, 503];
  const primary = new ScriptedLlm('scripted/primary', (_req, n) => errorResponse(statuses[n - 1]));
  const backup = new ScriptedLlm('scripted/backup', () => text('from the backup'));

  assert.equal((await turn({ primary, backup })).status, 'completed');
  const second = await turn({ primary, backup });
  assert.equal(second.status, 'failed');
  assert.equal(second.error?.code, 'SCRIPTED_ERROR', 'the error reaches the caller as it is');
  assert.equal(backup.calls, 1, 'a 400 is not redirected');
  assert.equal(circuitOpen(PRIMARY_PROVIDER), false);

  assert.equal((await turn({ primary, backup })).status, 'completed');
  assert.equal(circuitOpen(PRIMARY_PROVIDER), true, 'the 400 did not reset the count: two failures opened it');
});

test('an error response after content is passed on, never replayed on the fallback', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '1';
  const partial = { content: { role: 'model', parts: [{ text: 'half an answer' }] }, partial: true } as LlmResponse;
  const primary = new ScriptedLlm('scripted/primary', () => [partial, errorResponse(503)]);
  const backup = new ScriptedLlm('scripted/backup', () => text('never'));
  const r = await turn({ primary, backup });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'SCRIPTED_ERROR');
  assert.equal(backup.calls, 0);
  assert.equal(circuitOpen(PRIMARY_PROVIDER), true, 'the provider still failed, and counts');
});

// ── The wrapper on its own ───────────────────────────────────────────────────

const REQUEST = { model: 'scripted/primary', contents: [{ role: 'user', parts: [{ text: 'hello' }] }], toolsDict: {}, liveConnectConfig: {} } as unknown as LlmRequest;

async function collect(gen: AsyncGenerator<LlmResponse, void>): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

test('a canceled turn is never redirected or counted, whatever the error response says', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '1';
  const primary = new ScriptedLlm('scripted/primary', () => errorResponse(503));
  const backup = new ScriptedLlm('scripted/backup', () => text('never'));
  const stop = new AbortController();
  stop.abort();
  const out = await collect(new FallbackLlm(primary, backup, () => {}).generateContentAsync(REQUEST, false, stop.signal));
  assert.deepEqual(out.map((r) => r.errorCode), ['SCRIPTED_ERROR'], 'passed on as it is');
  assert.equal(backup.calls, 0);
  assert.equal(circuitOpen(PRIMARY_PROVIDER), false);
});

test('only a response with content counts as a success', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '2';
  const replies: LlmResponse[] = [errorResponse(503), { turnComplete: true } as LlmResponse, errorResponse(503), text('back'), errorResponse(503)];
  const primary = new ScriptedLlm('scripted/primary', (_req, n) => replies[n - 1]);
  const backup = new ScriptedLlm('scripted/backup', () => text('from the backup'));
  const llm = new FallbackLlm(primary, backup, () => {});
  await collect(llm.generateContentAsync(REQUEST));
  await collect(llm.generateContentAsync(REQUEST)); // nothing produced: not a success
  await collect(llm.generateContentAsync(REQUEST));
  assert.equal(circuitOpen(PRIMARY_PROVIDER), true, 'the empty call did not reset the count');

  resetCircuits();
  await collect(llm.generateContentAsync(REQUEST)); // an answer: a success
  await collect(llm.generateContentAsync(REQUEST));
  assert.equal(circuitOpen(PRIMARY_PROVIDER), false, 'one failure after a success is under the threshold');
});
