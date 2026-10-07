/**
 * tests/fallbackAdapter.test.ts — `fallback_model` and the per-provider
 * circuit breaker (ADR 0044) on the engine's own model contract
 * (lib/models/fallbackAdapter.ts, ADR 0048): a retryable failure before any
 * output is answered by the fallback; a request's own error, a cancellation
 * and a call that failed midway are not; the breaker trips and recovers on an
 * injected clock; the fallback gets its own model id and the caller's
 * reasoning setting; and one breaker serves both wrappers. Offline: scripted
 * adapters.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLogLevel, LogLevel } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import type { FinalModelResponse, ModelAdapter, ModelError, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { FallbackAdapter, isProviderError } from '../lib/models/fallbackAdapter.ts';
import { FallbackLlm } from '../lib/models/fallback.ts';
import { circuitOpen, resetCircuits, setBreakerClock } from '../lib/models/circuitBreaker.ts';
import { ScriptedLlm, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

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

// ── One breaker, both paths ──────────────────────────────────────────────────

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

async function drain(llm: FallbackLlm): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const r of llm.generateContentAsync({ contents: [] } as unknown as LlmRequest)) out.push(r);
  return out;
}

test('a provider tripped on the ADK path is skipped on the contract path', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '2';
  const adkPrimary = new ScriptedLlm('claude-sonnet-4-6', () => {
    throw httpError(503);
  });
  const adkBackup = new ScriptedLlm('gpt-5-mini', () => text('from the backup'));
  const llm = new FallbackLlm(adkPrimary, adkBackup, () => {});
  await drain(llm);
  await drain(llm);
  assert.equal(adkPrimary.calls, 2);

  const primary = primaryOf(() => [answer('never')]);
  const fallback = backup();
  assert.equal(textOf(finalOf(await collect(new FallbackAdapter(primary, fallback, { log: () => {} })))), 'from the backup');
  assert.deepEqual([primary.calls, fallback.calls], [0, 1]);
});

test('a provider tripped on the contract path is skipped on the ADK path, on the same clock', async () => {
  process.env.MODEL_BREAKER_THRESHOLD = '2';
  // Far from Date.now(): FallbackLlm sees the circuit open only if it reads the breaker's clock.
  restoreClock = setBreakerClock(() => 42);
  const adapter = new FallbackAdapter(primaryOf(() => [overloaded()]), backup(), { log: () => {} });
  await collect(adapter);
  await collect(adapter);

  const adkPrimary = new ScriptedLlm('claude-sonnet-4-6', () => text('never'));
  const adkBackup = new ScriptedLlm('gpt-5-mini', () => text('from the backup'));
  await drain(new FallbackLlm(adkPrimary, adkBackup, () => {}));
  assert.deepEqual([adkPrimary.calls, adkBackup.calls], [0, 1]);
});

// ── The contract path stays off ADK ──────────────────────────────────────────

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
