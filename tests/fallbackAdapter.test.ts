/**
 * tests/fallbackAdapter.test.ts — `fallback_model` and the per-provider
 * circuit breaker (ADR 0044) on the engine's own model contract
 * (lib/models/fallbackAdapter.ts, ADR 0048): a retryable failure before any
 * output is answered by the fallback; a request's own error, a cancellation
 * and a call that failed midway are not; the breaker trips and recovers on an
 * injected clock; the fallback gets its own model id and the caller's
 * reasoning setting. Then `fallback_model` in a turn, where the model step
 * applies the same rules (lib/runtime/native/agentLoop.ts): a failure
 * arrives either as a throw or as a failed final carrying the retry verdict,
 * and both are held to them; and one breaker serves the turn and
 * FallbackAdapter. Offline: scripted adapters.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FinalModelResponse, ModelAdapter, ModelError, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { FallbackAdapter, isProviderError } from '../lib/models/fallbackAdapter.ts';
import { circuitOpen, resetCircuits, setBreakerClock } from '../lib/models/circuitBreaker.ts';
import { errorDecision, errorText, withRetryVerdict } from '../lib/models/errorResponse.ts';
import { providerForModel } from '../lib/models/providerMap.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, scriptedResolver, text } from './helpers/scriptedLlm.ts';
import type { LlmResponse } from './helpers/scriptedLlm.ts';
import { answer as scriptedAnswer } from './helpers/scriptedModel.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Scripted adapters ────────────────────────────────────────────────────────

/** One scripted call per generate(), chosen by call number; records each request it was sent. */
class ScriptedAdapter implements ModelAdapter {
  calls = 0;
  readonly requests: ModelRequest[] = [];
  readonly provider: string;
  readonly model: string;
  private readonly script: (call: number) => ModelResponse[];

  constructor(provider: string, model: string, script: (call: number) => ModelResponse[]) {
    this.provider = provider;
    this.model = model;
    this.script = script;
  }

  async *generate(request: ModelRequest): AsyncIterable<ModelResponse> {
    this.calls += 1;
    this.requests.push(request);
    yield* this.script(this.calls);
  }
}

const answer = (t: string): FinalModelResponse => ({ partial: false, parts: [{ type: 'text', text: t }], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2 } });
const failure = (error: Partial<ModelError>, parts: FinalModelResponse['parts'] = []): FinalModelResponse => ({
  partial: false,
  parts,
  finishReason: 'error',
  error: { code: 'ANTHROPIC_ERROR', message: 'the call failed', retryable: false, ...error },
});
const overloaded = () => failure({ message: '503 overloaded', retryable: true, status: 503 });

const primaryOf = (script: (call: number) => ModelResponse[]) => new ScriptedAdapter('anthropic', 'claude-sonnet-4-6', script);
const backup = () => new ScriptedAdapter('openai', 'gpt-5-mini', () => [answer('from the backup')]);

function request(extra: Partial<ModelRequest> = {}): ModelRequest {
  return { model: 'claude-sonnet-4-6', system: 'Answer.', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], ...extra };
}

async function collect(adapter: ModelAdapter, req: ModelRequest = request()): Promise<ModelResponse[]> {
  const out: ModelResponse[] = [];
  for await (const r of adapter.generate(req)) out.push(r);
  return out;
}

const finalOf = (responses: ModelResponse[]): FinalModelResponse => {
  const last = responses.at(-1);
  assert.ok(last && !last.partial, 'the call ends with a final response');
  assert.equal(responses.filter((r) => !r.partial).length, 1, 'exactly one final');
  return last;
};
const textOf = (r: FinalModelResponse) => r.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

let restoreClock = () => {};
beforeEach(() => resetCircuits());
afterEach(() => {
  restoreClock();
  restoreClock = () => {};
  delete process.env.MODEL_BREAKER_THRESHOLD;
  delete process.env.MODEL_BREAKER_COOLDOWN_MS;
  resetCircuits();
});

// ── What counts ──────────────────────────────────────────────────────────────

test('isProviderError: retryable failures count, with a status in the retryable set when there is one', () => {
  assert.equal(isProviderError({ code: 'ANTHROPIC_ERROR', message: '', retryable: true, status: 503 }), true);
  assert.equal(isProviderError({ code: 'ANTHROPIC_ERROR', message: '', retryable: true, status: 429 }), true);
  assert.equal(isProviderError({ code: 'OLLAMA_UNREACHABLE', message: 'reset', retryable: true }), true, 'a reset has no status');
  assert.equal(isProviderError({ code: 'ANTHROPIC_ERROR', message: '', retryable: false, status: 400 }), false);
  assert.equal(isProviderError({ code: 'MISSING_API_KEY', message: '', retryable: false }), false);
  assert.equal(isProviderError({ code: 'ANTHROPIC_ERROR', message: '', retryable: true, status: 400 }), false, 'a 4xx is the request’s fault whatever the adapter says');
  assert.equal(isProviderError({ code: 'ANTHROPIC_ERROR', message: '', retryable: false, status: 503 }), false, 'the adapter’s retryable: false stands');
});

// ── Redirects ────────────────────────────────────────────────────────────────

test('a retryable failure before any output is answered by the fallback', async () => {
  const logs: string[] = [];
  const primary = primaryOf(() => [overloaded()]);
  const fallback = backup();
  const out = await collect(new FallbackAdapter(primary, fallback, { log: (m) => logs.push(m) }));
  const final = finalOf(out);
  assert.equal(final.error, undefined);
  assert.equal(textOf(final), 'from the backup');
  assert.equal(out.length, 1, 'the primary’s failed final is not passed on');
  assert.deepEqual([primary.calls, fallback.calls], [1, 1]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /claude-sonnet-4-6 failed \(ANTHROPIC_ERROR: 503 overloaded\); answering from gpt-5-mini/);
});

test('a non-retryable failure is passed on, with no fallback and no count against the provider', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '1';
  for (const error of [{ status: 400 }, { code: 'MISSING_API_KEY' }, { retryable: true, status: 400 }] as Partial<ModelError>[]) {
    const primary = primaryOf(() => [failure(error)]);
    const fallback = backup();
    const final = finalOf(await collect(new FallbackAdapter(primary, fallback, { log: () => {} })));
    assert.ok(final.error, JSON.stringify(error));
    assert.equal(final.error.code, error.code ?? 'ANTHROPIC_ERROR');
    assert.equal(fallback.calls, 0, JSON.stringify(error));
    assert.equal(circuitOpen('anthropic'), false, JSON.stringify(error));
  }
});

test('a failure after a partial is passed on, never replayed on the fallback', async () => {
  const scripts: Record<string, ModelResponse[]> = {
    // Streamed text, then the failure, holding the text produced so far.
    text: [{ partial: true, parts: [{ type: 'text', text: 'half an ' }] }, failure({ retryable: true, status: 503 }, [{ type: 'text', text: 'half an ' }])],
    // Thinking on screen, then the failure: a final never holds thinking, so it has no parts.
    thinking: [{ partial: true, parts: [{ type: 'thinking', text: 'Let me see' }] }, failure({ retryable: true, status: 503 })],
  };
  for (const [name, script] of Object.entries(scripts)) {
    const primary = primaryOf(() => script);
    const fallback = backup();
    const out = await collect(new FallbackAdapter(primary, fallback, { log: () => {} }));
    assert.equal(out.length, 2, name);
    assert.equal(out[0], script[0], `${name}: the partial reaches the caller as it came`);
    assert.equal(finalOf(out).error?.status, 503, name);
    assert.equal(fallback.calls, 0, name);
  }
});

test('a failed final that already holds parts is passed on, never replayed on the fallback', async () => {
  const primary = primaryOf(() => [failure({ retryable: true, status: 503 }, [{ type: 'text', text: 'half an answer' }])]);
  const fallback = backup();
  const final = finalOf(await collect(new FallbackAdapter(primary, fallback, { log: () => {} })));
  assert.equal(final.error?.status, 503);
  assert.equal(fallback.calls, 0);
});

test('an aborted call is never redirected or counted, even when the adapter calls it retryable', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '1';
  const controller = new AbortController();
  controller.abort();
  for (const error of [{ code: 'ANTHROPIC_ERROR', message: 'aborted' }, { retryable: true, status: 503 }] as Partial<ModelError>[]) {
    const primary = primaryOf(() => [failure(error)]);
    const fallback = backup();
    const final = finalOf(await collect(new FallbackAdapter(primary, fallback, { log: () => {} }), request({ signal: controller.signal })));
    assert.ok(final.error, JSON.stringify(error));
    assert.equal(fallback.calls, 0, JSON.stringify(error));
    assert.equal(circuitOpen('anthropic'), false, JSON.stringify(error));
  }
});

// ── The breaker ──────────────────────────────────────────────────────────────

test('the breaker trips after MODEL_BREAKER_THRESHOLD failures and recovers after its cooldown', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '2';
  process.env.MODEL_BREAKER_COOLDOWN_MS = '1000';
  let t = 1_000_000;
  restoreClock = setBreakerClock(() => t);
  // Calls 1 and 2 fail, 3 succeeds, 4 fails again.
  const primary = primaryOf((call) => [call === 3 ? answer('from the primary') : overloaded()]);
  const fallback = backup();
  const adapter = new FallbackAdapter(primary, fallback, { log: () => {} });

  await collect(adapter);
  assert.equal(circuitOpen('anthropic', t), false, 'one failure is under the threshold');
  await collect(adapter);
  assert.equal(circuitOpen('anthropic', t), true, 'the second failure opens the circuit');
  assert.deepEqual([primary.calls, fallback.calls], [2, 2]);

  t += 999;
  assert.equal(textOf(finalOf(await collect(adapter))), 'from the backup');
  assert.deepEqual([primary.calls, fallback.calls], [2, 3], 'the open circuit skips the primary');

  t += 1;
  assert.equal(textOf(finalOf(await collect(adapter))), 'from the primary', 'after the cooldown the primary is called again');
  assert.deepEqual([primary.calls, fallback.calls], [3, 3]);
  assert.equal(circuitOpen('anthropic', t), false);

  await collect(adapter);
  assert.equal(circuitOpen('anthropic', t), false, 'the success cleared the count: one new failure does not reopen it');
  assert.deepEqual([primary.calls, fallback.calls], [4, 4]);
});

test('after the cooldown, a call that fails again reopens the circuit at once', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '2';
  process.env.MODEL_BREAKER_COOLDOWN_MS = '1000';
  let t = 5_000;
  restoreClock = setBreakerClock(() => t);
  const primary = primaryOf(() => [overloaded()]);
  const adapter = new FallbackAdapter(primary, backup(), { log: () => {} });
  await collect(adapter);
  await collect(adapter);
  t += 1000;
  assert.equal(circuitOpen('anthropic', t), false);
  await collect(adapter);
  assert.equal(primary.calls, 3);
  assert.equal(circuitOpen('anthropic', t), true);
  assert.equal(circuitOpen('anthropic', t + 999), true);
  assert.equal(circuitOpen('anthropic', t + 1000), false);
});

test('MODEL_BREAKER_THRESHOLD=0 disables the breaker; the fallback still answers', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '0';
  const primary = primaryOf(() => [overloaded()]);
  const fallback = backup();
  const adapter = new FallbackAdapter(primary, fallback, { log: () => {} });
  for (let i = 0; i < 6; i++) await collect(adapter);
  assert.deepEqual([primary.calls, fallback.calls], [6, 6]);
  assert.equal(circuitOpen('anthropic'), false);
});

// ── The fallback's request ───────────────────────────────────────────────────

test('the fallback receives its own model id and the original reasoning setting', async () => {
  const primary = primaryOf(() => [overloaded()]);
  const fallback = backup();
  const controller = new AbortController();
  const reasoning = { budget_tokens: 3000 };
  const original = request({ reasoning, signal: controller.signal, stream: true, sampling: { maxOutputTokens: 512 } });
  await collect(new FallbackAdapter(primary, fallback, { log: () => {} }), original);

  assert.equal(primary.requests[0], original, 'the primary gets the caller’s request as it is');
  assert.equal(original.model, 'claude-sonnet-4-6', 'the caller’s request is not mutated');

  const sent = fallback.requests[0];
  assert.equal(sent.model, 'gpt-5-mini');
  assert.equal(sent.reasoning, reasoning, 'the setting itself, for the fallback adapter to map');
  assert.deepEqual(sent.reasoning, { budget_tokens: 3000 });
  assert.equal(sent.signal, controller.signal);
  assert.deepEqual({ ...sent, model: original.model }, original, 'nothing else changes');
});

test('the wrapper reports the primary’s provider and model', () => {
  const adapter = new FallbackAdapter(primaryOf(() => []), backup());
  assert.equal(adapter.provider, 'anthropic');
  assert.equal(adapter.model, 'claude-sonnet-4-6');
});

// ── fallback_model in a turn ─────────────────────────────────────────────────

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Yields an answer, then throws: a stream that fails midway. */
function midstreamFailure(model: string): ModelAdapter & { calls: number } {
  const adapter: ModelAdapter & { calls: number } = {
    model,
    provider: 'scripted',
    calls: 0,
    async *generate() {
      adapter.calls += 1;
      yield scriptedAnswer('half an answer');
      throw httpError(503);
    },
  };
  return adapter;
}

function turnConfig(model = 'scripted/primary', fallback = 'scripted/backup'): SyndicateYamlConfig {
  return validateSyndicateConfig(
    { syndicate_name: 'S', orchestrator: { name: 'Main', model, fallback_model: fallback, instruction: 'Answer.' }, subagents: [] },
    't',
  ) as SyndicateYamlConfig;
}

/** One turn whose orchestrator runs `scripted/primary` with `scripted/backup` as its fallback_model. */
const turn = (models: Record<string, ModelAdapter>, config: SyndicateYamlConfig = turnConfig()) =>
  runSyndicateTurn({
    config,
    parts: [{ text: 'hello' }],
    appName: 'a',
    userId: 'u',
    sessionId: crypto.randomUUID(),
    sessionService: new InProcessSessionService(),
    compile: { resolveModel: scriptedResolver(models as Record<string, ScriptedLlm>), log: () => {} },
    trace: false,
  });

test('a turn: a thrown provider-side failure is answered by the fallback model', async () => {
  const primary = new ScriptedLlm('scripted/primary', () => {
    throw httpError(503);
  });
  const backup = new ScriptedLlm('scripted/backup', () => text('from the backup'));
  const r = await turn({ primary, backup });
  assert.equal(r.status, 'completed', r.error?.message);
  assert.match(r.text ?? '', /from the backup/);
  assert.deepEqual([primary.calls, backup.calls], [1, 1]);
});

test("a turn: the request's own error (a thrown 400) is not redirected to the fallback", async () => {
  const primary = new ScriptedLlm('scripted/primary', () => {
    throw httpError(400);
  });
  const backup = new ScriptedLlm('scripted/backup', () => text('never'));
  const r = await turn({ primary, backup });
  assert.equal(r.status, 'failed');
  assert.equal(backup.calls, 0);
});

test('a turn: a stream that already produced text is never replayed on the fallback', async () => {
  const primary = midstreamFailure('scripted/primary');
  const backup = new ScriptedLlm('scripted/backup', () => text('never'));
  const r = await turn({ primary, backup });
  assert.equal(r.status, 'failed');
  assert.equal(primary.calls, 1);
  assert.equal(backup.calls, 0);
});

test('a turn: after MODEL_BREAKER_THRESHOLD failures the primary is skipped until the cooldown ends', async () => {
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

/** An error response as an adapter's failed final maps to once a provider call has failed with `status`. */
const errorResponse = (status: number) => {
  const err = httpError(status);
  return withRetryVerdict({ errorCode: 'SCRIPTED_ERROR', errorMessage: errorText(err) }, errorDecision(err));
};
const PRIMARY_PROVIDER = providerForModel('scripted/primary');

test('a turn: a retryable failed final is answered by the fallback, and the breaker counts the failure', async () => {
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

test('a turn: a non-retryable failed final is passed on, and is never recorded as a success', async () => {
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

test('a turn: a failed final after content is passed on, never replayed on the fallback', async () => {
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

test('a turn: only a step with content counts as a success', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '2';
  const replies: LlmResponse[] = [errorResponse(503), { turnComplete: true } as LlmResponse, errorResponse(503), text('back'), errorResponse(503)];
  const primary = new ScriptedLlm('scripted/primary', (_req, n) => replies[n - 1]);
  const backup = new ScriptedLlm('scripted/backup', () => text('from the backup'));
  await turn({ primary, backup });
  await turn({ primary, backup }); // nothing produced: not a success
  await turn({ primary, backup });
  assert.equal(circuitOpen(PRIMARY_PROVIDER), true, 'the empty step did not reset the count');

  resetCircuits();
  await turn({ primary, backup }); // an answer: a success
  await turn({ primary, backup });
  assert.equal(circuitOpen(PRIMARY_PROVIDER), false, 'one failure after a success is under the threshold');
});

// ── One breaker, the turn and FallbackAdapter ────────────────────────────────

test('a provider tripped in a turn is skipped by FallbackAdapter', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '2';
  const turnPrimary = new ScriptedLlm('claude-sonnet-4-6', () => {
    throw httpError(503);
  });
  const turnBackup = new ScriptedLlm('gpt-5-mini', () => text('from the backup'));
  const models = { 'claude-sonnet-4-6': turnPrimary, 'gpt-5-mini': turnBackup };
  const config = turnConfig('claude-sonnet-4-6', 'gpt-5-mini');
  await turn(models, config);
  await turn(models, config);
  assert.equal(turnPrimary.calls, 2);

  const primary = primaryOf(() => [answer('never')]);
  const fallback = backup();
  assert.equal(textOf(finalOf(await collect(new FallbackAdapter(primary, fallback, { log: () => {} })))), 'from the backup');
  assert.deepEqual([primary.calls, fallback.calls], [0, 1]);
});

test('a provider tripped by FallbackAdapter is skipped in a turn, on the same clock', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '2';
  // Far from Date.now(): the turn sees the circuit open only if it reads the breaker's clock.
  restoreClock = setBreakerClock(() => 42);
  const adapter = new FallbackAdapter(primaryOf(() => [overloaded()]), backup(), { log: () => {} });
  await collect(adapter);
  await collect(adapter);

  const turnPrimary = new ScriptedLlm('claude-sonnet-4-6', () => text('never'));
  const turnBackup = new ScriptedLlm('gpt-5-mini', () => text('from the backup'));
  const r = await turn({ 'claude-sonnet-4-6': turnPrimary, 'gpt-5-mini': turnBackup }, turnConfig('claude-sonnet-4-6', 'gpt-5-mini'));
  assert.equal(r.status, 'completed', r.error?.message);
  assert.deepEqual([turnPrimary.calls, turnBackup.calls], [0, 1]);
});

// ── The contract path imports no SDK ─────────────────────────────────────────

test('the contract-level wrapper imports nothing from @google/*', () => {
  const seen = new Set<string>();
  const packages: string[] = [];
  const pending = [path.resolve(ROOT, 'lib/models/fallbackAdapter.ts')];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    // Import and export statements start a line; comment lines start with `*` or `//`.
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)) {
      if (m[1].startsWith('.')) pending.push(path.resolve(path.dirname(file), m[1]));
      else packages.push(m[1]);
    }
  }
  const files = [...seen].map((f) => path.relative(ROOT, f)).sort();
  assert.deepEqual(files, ['lib/models/circuitBreaker.ts', 'lib/models/contract.ts', 'lib/models/fallbackAdapter.ts', 'lib/models/providerState.ts', 'lib/models/retry.ts']);
  assert.deepEqual(packages, []);
});
