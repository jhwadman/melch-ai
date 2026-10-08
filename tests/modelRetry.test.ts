/**
 * tests/modelRetry.test.ts — the shared transient-failure policy
 * (lib/models/retry.ts) and the adapters that use it directly: the
 * chat-completions base (Ollama, gateways) and the engine's own
 * GeminiAdapter. Each is driven on the engine's contract: a ModelRequest
 * in, the wire requests and the final out.
 *
 * Offline: every provider call hits a stubbed `globalThis.fetch`, and the
 * backoff delays are shrunk through setRetryPolicyOverrides so the suite
 * does not sleep.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  classifyError,
  classifyResponse,
  fetchWithRetry,
  googleRetryDelayMs,
  nextRetryDelay,
  parseRetryAfter,
  retryAfterFromHeaders,
  retryPolicy,
  retryUntilFirstYield,
  setRetryPolicyOverrides,
  sleepUnlessAborted,
} from '../lib/models/retry.ts';
import type { FinalModelResponse, ModelAdapter, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { OllamaAdapter } from '../lib/models/ollamaAdapter.ts';
import { GatewayAdapter } from '../lib/models/gatewayAdapter.ts';
import { GeminiAdapter } from '../lib/models/geminiAdapter.ts';
import { DEFAULT_GROK_TIMEOUT_MS, grokTimeoutMs } from '../lib/models/grokAdapter.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';

const FAST = { baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 50 };

function makeRequest(model: string, signal?: AbortSignal): ModelRequest {
  return {
    model,
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    ...(signal ? { signal } : {}),
  };
}

async function collect(gen: AsyncIterable<ModelResponse>): Promise<ModelResponse[]> {
  const out: ModelResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

/** The call's one final, last (contract rule 4). */
function finalOf(responses: ModelResponse[]): FinalModelResponse {
  const final = responses.at(-1);
  assert.ok(final && !final.partial, 'the call ends on a final');
  return final;
}

/** The final's text. */
const textOf = (final: FinalModelResponse) => final.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

/** Runs `fn` with fetch answering from `replies` in order; returns the call count. */
async function withFetch(
  replies: Array<() => Response | Promise<Response>>,
  fn: () => Promise<void>,
): Promise<number> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls++;
    return reply();
  }) as any;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const resetError = () => {
  const err = new TypeError('fetch failed');
  (err as any).cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  return err;
};

// ── Classification ───────────────────────────────────────────────────────────

test('classifyResponse retries exactly 408/409/425/429/500/502/503/504/529', () => {
  for (const s of [408, 409, 425, 429, 500, 502, 503, 504, 529]) {
    assert.equal(classifyResponse(new Response(null, { status: s })).retryable, true, `${s}`);
  }
  for (const s of [400, 401, 403, 404, 413, 422, 501]) {
    assert.equal(classifyResponse(new Response(null, { status: s })).retryable, false, `${s}`);
  }
});

test('classifyError: status on the error wins; network codes are read off the cause chain', () => {
  assert.deepEqual(classifyError(Object.assign(new Error('x'), { status: 503 })).retryable, true);
  assert.deepEqual(classifyError(Object.assign(new Error('x'), { status: 400 })).retryable, false);
  assert.equal(classifyError(resetError()).retryable, true);
  const timeout = new TypeError('fetch failed');
  (timeout as any).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
  assert.equal(classifyError(timeout).retryable, true);
  // A stopped Ollama: report at once, don't retry.
  const refused = new TypeError('fetch failed');
  (refused as any).cause = { code: 'ECONNREFUSED' };
  assert.equal(classifyError(refused).retryable, false);
  assert.equal(classifyError(new Error('something else')).retryable, false);
  assert.equal(classifyError(new DOMException('aborted', 'AbortError')).retryable, false);
});

// ── Retry-After ──────────────────────────────────────────────────────────────

test('parseRetryAfter reads delta-seconds and HTTP dates, rejects junk', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  assert.equal(parseRetryAfter('7', now), 7000);
  assert.equal(parseRetryAfter(' 1.5 ', now), 1500);
  assert.equal(parseRetryAfter('Thu, 01 Oct 2026 12:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Thu, 01 Oct 2026 11:00:00 GMT', now), 0); // past → now
  assert.equal(parseRetryAfter('soon', now), undefined);
  assert.equal(parseRetryAfter('', now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
});

test('retryAfterFromHeaders prefers retry-after-ms; googleRetryDelayMs reads RetryInfo', () => {
  assert.equal(retryAfterFromHeaders(new Headers({ 'retry-after-ms': '250', 'retry-after': '9' })), 250);
  assert.equal(retryAfterFromHeaders(new Headers({ 'retry-after': '9' })), 9000);
  assert.equal(retryAfterFromHeaders(new Headers()), undefined);
  const body = '{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}';
  assert.equal(googleRetryDelayMs(body), 37_000);
  assert.equal(classifyError(Object.assign(new Error(body), { status: 429 })).retryAfterMs, 37_000);
});

// ── Scheduling ───────────────────────────────────────────────────────────────

test('backoff is full jitter under a doubling ceiling capped at maxDelayMs', () => {
  const p = DEFAULT_RETRY_POLICY;
  assert.equal(backoffDelayMs(1, p, () => 0), 0);
  assert.equal(backoffDelayMs(1, p, () => 0.999999), 499);
  assert.equal(backoffDelayMs(2, p, () => 0.999999), 999);
  assert.equal(backoffDelayMs(3, p, () => 0.999999), 1999);
  assert.equal(backoffDelayMs(20, p, () => 0.999999), 7999); // capped at 8 s
  for (let i = 0; i < 200; i++) {
    const d = backoffDelayMs(4, p);
    assert.ok(d >= 0 && d < 4000, `${d}`);
  }
});

test('nextRetryDelay stops on non-retryable, exhaustion, abort, and an over-cap Retry-After', () => {
  const p = { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 };
  const r = () => 0.5;
  assert.equal(nextRetryDelay(1, { retryable: true }, p, undefined, r), 250);
  assert.equal(nextRetryDelay(2, { retryable: true }, p, undefined, r), 500);
  assert.equal(nextRetryDelay(3, { retryable: true }, p, undefined, r), undefined); // 3 attempts made
  assert.equal(nextRetryDelay(1, { retryable: false }, p, undefined, r), undefined);
  assert.equal(nextRetryDelay(1, { retryable: true, retryAfterMs: 5000 }, p, undefined, r), 5000);
  assert.equal(nextRetryDelay(1, { retryable: true, retryAfterMs: 61_000 }, p, undefined, r), undefined);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(nextRetryDelay(1, { retryable: true }, p, aborted.signal, r), undefined);
});

test('MODEL_RETRY_MAX_ATTEMPTS sets the attempt count, clamped to 1..10', () => {
  assert.equal(retryPolicy({}).maxAttempts, 3);
  assert.equal(retryPolicy({ MODEL_RETRY_MAX_ATTEMPTS: '1' }).maxAttempts, 1);
  assert.equal(retryPolicy({ MODEL_RETRY_MAX_ATTEMPTS: '5' }).maxAttempts, 5);
  assert.equal(retryPolicy({ MODEL_RETRY_MAX_ATTEMPTS: '0' }).maxAttempts, 1);
  assert.equal(retryPolicy({ MODEL_RETRY_MAX_ATTEMPTS: '99' }).maxAttempts, 10);
  assert.equal(retryPolicy({ MODEL_RETRY_MAX_ATTEMPTS: 'lots' }).maxAttempts, 3);
});

test('sleepUnlessAborted wakes early on abort and reports it', async () => {
  const ctl = new AbortController();
  const started = Date.now();
  setTimeout(() => ctl.abort(), 10);
  assert.equal(await sleepUnlessAborted(5_000, ctl.signal), false);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(await sleepUnlessAborted(1), true);
});

// ── fetchWithRetry ───────────────────────────────────────────────────────────

test('fetchWithRetry: an abort during backoff stops the retries and does not re-send', async () => {
  const ctl = new AbortController();
  let retried = 0;
  const calls = await withFetch([json(503, {})], async () => {
    const p = fetchWithRetry('http://x', { signal: ctl.signal }, {
      signal: ctl.signal,
      policy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 5, baseDelayMs: 10_000, maxDelayMs: 10_000 },
      random: () => 1,
      onRetry: () => { retried++; },
    });
    setTimeout(() => ctl.abort(), 10);
    const { response } = await p;
    assert.equal(response.status, 503);
  });
  assert.equal(calls, 1, 'no request after the abort');
  assert.equal(retried, 1);
});

test('fetchWithRetry: network resets are retried, then the last error is thrown', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    const calls = await withFetch([() => { throw resetError(); }], async () => {
      await assert.rejects(fetchWithRetry('http://x', {}), /fetch failed/);
    });
    assert.equal(calls, 3);
  } finally {
    restore();
  }
});

test('fetchWithRetry: a Retry-After over the cap fails at once', async () => {
  const restore = setRetryPolicyOverrides(FAST); // cap 50 ms
  try {
    const calls = await withFetch([json(429, {}, { 'retry-after': '120' })], async () => {
      const { response, retries } = await fetchWithRetry('http://x', {});
      assert.equal(response.status, 429);
      assert.equal(retries, 0);
    });
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

// ── retryUntilFirstYield (the streaming rule) ────────────────────────────────

test('retryUntilFirstYield retries a failure before the first yield', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    let starts = 0;
    const out: string[] = [];
    for await (const x of retryUntilFirstYield<string>(async function* () {
      starts++;
      if (starts === 1) throw Object.assign(new Error('overloaded'), { status: 503 });
      yield 'a';
      yield 'b';
    })) out.push(x);
    assert.deepEqual(out, ['a', 'b']);
    assert.equal(starts, 2);
  } finally {
    restore();
  }
});

test('retryUntilFirstYield never retries once output has been yielded', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    let starts = 0;
    const out: string[] = [];
    await assert.rejects(async () => {
      for await (const x of retryUntilFirstYield<string>(async function* () {
        starts++;
        yield 'partial';
        throw Object.assign(new Error('stream died'), { status: 503 });
      })) out.push(x);
    }, /stream died/);
    assert.deepEqual(out, ['partial'], 'the partial is not duplicated');
    assert.equal(starts, 1);
  } finally {
    restore();
  }
});

test('retryUntilFirstYield: abort stops retries and the error carries the verdict', async () => {
  const ctl = new AbortController();
  ctl.abort();
  let starts = 0;
  const err: any = await (async () => {
    try {
      for await (const _ of retryUntilFirstYield<string>(async function* () {
        starts++;
        throw Object.assign(new Error('busy'), { status: 503 });
      }, { signal: ctl.signal })) { /* nothing */ }
    } catch (e) {
      return e;
    }
  })();
  assert.equal(starts, 1);
  assert.equal(err.status, 503);
  assert.equal(err.retryable, true);
  assert.equal(err.retries, 0);
});

// ── Chat-completions adapter ─────────────────────────────────────────────────

const OK_COMPLETION = json(200, {
  choices: [{ message: { content: 'Recovered.' } }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
});

test('OllamaAdapter retries a 503 and then answers', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    let responses: ModelResponse[] = [];
    const calls = await withFetch([json(503, { error: 'busy' }), OK_COMPLETION], async () => {
      const adapter = new OllamaAdapter({ model: 'ollama/qwen3:8b' });
      responses = await collect(adapter.generate(makeRequest('ollama/qwen3:8b')));
    });
    assert.equal(calls, 2);
    const final = finalOf(responses);
    assert.equal(final.error, undefined);
    assert.equal(textOf(final), 'Recovered.');
  } finally {
    restore();
  }
});

test('OllamaAdapter does not retry a 400, and the error carries status + retryable', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    let responses: ModelResponse[] = [];
    const calls = await withFetch([json(400, { error: 'bad tool schema' }), OK_COMPLETION], async () => {
      const adapter = new OllamaAdapter({ model: 'ollama/qwen3:8b' });
      responses = await collect(adapter.generate(makeRequest('ollama/qwen3:8b')));
    });
    assert.equal(calls, 1);
    const err = finalOf(responses).error!;
    assert.equal(err.code, 'OLLAMA_HTTP_ERROR'); // unchanged code
    assert.equal(err.status, 400);
    assert.equal(err.retryable, false);
    assert.match(err.message, /returned 400/);
  } finally {
    restore();
  }
});

test('OllamaAdapter surfaces a persistent 503 as retryable after the attempts run out', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    let responses: ModelResponse[] = [];
    const calls = await withFetch([json(503, { error: 'busy' })], async () => {
      const adapter = new OllamaAdapter({ model: 'ollama/qwen3:8b' });
      responses = await collect(adapter.generate(makeRequest('ollama/qwen3:8b')));
    });
    assert.equal(calls, 3);
    const err = finalOf(responses).error!;
    assert.equal(err.status, 503);
    assert.equal(err.retryable, true);
    assert.match(err.message, /busy/, 'the final body is still read for the message');
  } finally {
    restore();
  }
});

test('OllamaAdapter does not retry a refused connection (Ollama not running)', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    let responses: ModelResponse[] = [];
    const refused = () => {
      const e = new TypeError('fetch failed');
      (e as any).cause = { code: 'ECONNREFUSED' };
      throw e;
    };
    const calls = await withFetch([refused], async () => {
      const adapter = new OllamaAdapter({ model: 'ollama/qwen3:8b' });
      responses = await collect(adapter.generate(makeRequest('ollama/qwen3:8b')));
    });
    assert.equal(calls, 1);
    assert.equal(finalOf(responses).error?.code, 'OLLAMA_UNREACHABLE');
  } finally {
    restore();
  }
});

test('a canceled turn makes no retry on the chat-completions path', async () => {
  const restore = setRetryPolicyOverrides({ ...FAST, baseDelayMs: 10_000, maxDelayMs: 10_000 });
  // Full jitter draws the delay from [0, 10 s); a draw under the 20 ms
  // before the cancel let the retry run first (about one run in 500).
  // Pin the draw near the ceiling so the cancel always comes first.
  const realRandom = Math.random;
  Math.random = () => 0.99;
  const control = createTurnControl();
  try {
    let responses: ModelResponse[] = [];
    const calls = await withFetch([json(503, { error: 'busy' }), OK_COMPLETION], async () => {
      const adapter = new OllamaAdapter({ model: 'ollama/qwen3:8b' });
      setTimeout(() => control.stop('canceled'), 20);
      // The caller hands the turn's signal on the request (ADR 0053).
      responses = await runWithTurnControl(control, () =>
        collect(adapter.generate(makeRequest('ollama/qwen3:8b', control.signal))),
      );
    });
    assert.equal(calls, 1);
    const err = finalOf(responses).error!;
    assert.equal(err.status, 503);
    assert.equal(err.retryable, false, 'a call cut off by a cancelled turn is never retryable');
  } finally {
    Math.random = realRandom;
    control.dispose();
    restore();
  }
});

test('GatewayAdapter keeps GATEWAY_HTTP_ERROR and gains the status', async () => {
  const saved = { gw: process.env.MODEL_GATEWAY, key: process.env.MODEL_GATEWAY_API_KEY };
  process.env.MODEL_GATEWAY = 'openrouter';
  process.env.MODEL_GATEWAY_API_KEY = 'test-gateway-key';
  const restore = setRetryPolicyOverrides(FAST);
  try {
    let responses: ModelResponse[] = [];
    const calls = await withFetch([json(429, { error: 'slow down' }), json(404, { error: 'no such model' })], async () => {
      const adapter = new GatewayAdapter({ model: 'claude-sonnet-4-6' });
      responses = await collect(adapter.generate(makeRequest('claude-sonnet-4-6')));
    });
    assert.equal(calls, 2, '429 retried, 404 not');
    const err = finalOf(responses).error!;
    assert.equal(err.code, 'GATEWAY_HTTP_ERROR');
    assert.equal(err.status, 404);
    assert.equal(err.retryable, false);
  } finally {
    restore();
    if (saved.gw === undefined) delete process.env.MODEL_GATEWAY; else process.env.MODEL_GATEWAY = saved.gw;
    if (saved.key === undefined) delete process.env.MODEL_GATEWAY_API_KEY; else process.env.MODEL_GATEWAY_API_KEY = saved.key;
  }
});

// ── Gemini ───────────────────────────────────────────────────────────────────

const GEMINI_OK = json(200, {
  candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini recovered.' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
});
const GEMINI_503 = json(503, { error: { code: 503, message: 'The model is overloaded. high demand', status: 'UNAVAILABLE' } });
const GEMINI_400 = json(400, { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } });

function withGeminiEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { vertex: process.env.GOOGLE_GENAI_USE_VERTEXAI, platform: process.env.GEMINI_PLATFORM };
  delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
  delete process.env.GEMINI_PLATFORM;
  return fn().finally(() => {
    if (saved.vertex !== undefined) process.env.GOOGLE_GENAI_USE_VERTEXAI = saved.vertex;
    if (saved.platform !== undefined) process.env.GEMINI_PLATFORM = saved.platform;
  });
}

/** Gemini's contract adapter, the engine's GeminiAdapter on @google/genai. */
const GEMINI_ADAPTERS: Array<[string, (model: string) => ModelAdapter]> = [
  ['GeminiAdapter', (model) => new GeminiAdapter({ model, apiKey: 'test-key' })],
];

for (const [name, gemini] of GEMINI_ADAPTERS) {
  test(`${name} retries a 503 "high demand" and then answers`, async () => {
    const restore = setRetryPolicyOverrides(FAST);
    try {
      await withGeminiEnv(async () => {
        let responses: ModelResponse[] = [];
        const calls = await withFetch([GEMINI_503, GEMINI_OK], async () => {
          responses = await collect(gemini('gemini-test').generate(makeRequest('gemini-test')));
        });
        assert.equal(calls, 2);
        const final = finalOf(responses);
        assert.equal(final.error, undefined);
        assert.equal(textOf(final), 'Gemini recovered.');
      });
    } finally {
      restore();
    }
  });

  test(`${name} does not retry a 400 and keeps genai's error body`, async () => {
    const restore = setRetryPolicyOverrides(FAST);
    try {
      await withGeminiEnv(async () => {
        let responses: ModelResponse[] = [];
        const calls = await withFetch([GEMINI_400, GEMINI_OK], async () => {
          responses = await collect(gemini('gemini-test').generate(makeRequest('gemini-test')));
        });
        assert.equal(calls, 1);
        // A failed call is a final, never a throw (contract rule 4).
        const err = finalOf(responses).error!;
        assert.equal(err.code, 'GEMINI_ERROR');
        assert.equal(err.status, 400);
        assert.equal(err.retryable, false);
        assert.match(err.message, /API key not valid/);
      });
    } finally {
      restore();
    }
  });

  test(`${name} re-sends the same request contents on a retry`, async () => {
    const restore = setRetryPolicyOverrides(FAST);
    try {
      await withGeminiEnv(async () => {
        const bodies: any[] = [];
        const real = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = (async (_url: any, init: any) => {
          bodies.push(JSON.parse(init.body));
          return (calls++ === 0 ? GEMINI_503 : GEMINI_OK)();
        }) as any;
        try {
          await collect(gemini('gemini-test').generate(makeRequest('gemini-test')));
        } finally {
          globalThis.fetch = real;
        }
        assert.equal(bodies.length, 2);
        assert.deepEqual(bodies[1].contents, bodies[0].contents);
      });
    } finally {
      restore();
    }
  });
}

// ── Grok timeout ─────────────────────────────────────────────────────────────

test('Grok per-attempt timeout defaults to 10 minutes, env-overridable, floored at 2', () => {
  assert.equal(DEFAULT_GROK_TIMEOUT_MS, 600_000);
  assert.equal(grokTimeoutMs({}), 600_000);
  assert.equal(grokTimeoutMs({ XAI_TIMEOUT_MS: '900000' }), 900_000);
  assert.equal(grokTimeoutMs({ XAI_TIMEOUT_MS: '1000' }), 120_000);
  assert.equal(grokTimeoutMs({ XAI_TIMEOUT_MS: 'nope' }), 600_000);
});
