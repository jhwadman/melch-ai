/**
 * tests/fallback.test.ts — `fallback_model` and the per-provider circuit
 * breaker (ADR 0044): a provider-side failure is answered by the fallback, a
 * request's own error is not, a stream that already produced text is never
 * replayed elsewhere, and a provider that keeps failing is skipped for the
 * cooldown. Offline: scripted models.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BaseLlm, InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { isProviderFailure, resetCircuits } from '../lib/models/fallback.ts';
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
