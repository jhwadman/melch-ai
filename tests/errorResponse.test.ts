/**
 * tests/errorResponse.test.ts — an adapter's error response says whether
 * another model may succeed (lib/models/errorResponse.ts), which is what
 * FallbackLlm reads for every primary that reports a failure as a yielded
 * response instead of a throw (ADR 0044).
 *
 * Proved here, offline against a stubbed `globalThis.fetch`:
 *   - ClaudeLlm (the real Anthropic SDK, its own retries spent) marks a 529
 *     retryable with 'error.status' 529, and a 400 not retryable, keeping
 *     ANTHROPIC_ERROR;
 *   - GptLlm (the real openai SDK, its own retries spent) and OllamaLlm (a
 *     chat-completions subclass) attach customMetadata['error.retryable']
 *     true and 'error.status' 503 on a 503, false and 400 on a 400, with
 *     their errorCodes unchanged;
 *   - the chat-completions catch site marks a connection reset retryable
 *     and a refused connection not;
 *   - the message keeps its wording and never carries a key, and a
 *     cancellation is never retryable.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel, LogLevel } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { ClaudeLlm } from '../lib/models/claudeLlm.ts';
import { GptLlm } from '../lib/models/gptLlm.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { setRetryPolicyOverrides } from '../lib/models/retry.ts';
import { ERROR_RETRYABLE_KEY, ERROR_STATUS_KEY, isRetryableErrorResponse, providerErrorResponse } from '../lib/models/errorResponse.ts';

setLogLevel(LogLevel.ERROR);

const OPENAI_KEY = 'fixture-openai-0123456789abcdef'; // gitleaks:allow (test fixture)
const ANTHROPIC_KEY = 'fixture-anthropic-0123456789abcdef'; // gitleaks:allow (test fixture)
const FAST = { baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 50 };

function request(model: string): LlmRequest {
  return { model, contents: [{ role: 'user', parts: [{ text: 'hello' }] }], liveConnectConfig: {}, toolsDict: {} } as unknown as LlmRequest;
}

async function collect(gen: AsyncGenerator<LlmResponse, void>): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

/** Every fetch answers from `reply`; returns the responses and the call count. */
async function withFetch(reply: () => Response, run: () => Promise<LlmResponse[]>): Promise<{ responses: LlmResponse[]; calls: number }> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return reply();
  }) as typeof fetch;
  try {
    return { responses: await run(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

// `retry-after-ms: 0` lets the openai SDK spend its own retries without sleeping.
const status = (code: number) => () =>
  new Response(JSON.stringify({ error: { message: `status ${code}`, type: 'server_error' } }), {
    status: code,
    headers: { 'content-type': 'application/json', 'retry-after-ms': '0' },
  });

const verdict = (r: LlmResponse) => [r.customMetadata?.[ERROR_RETRYABLE_KEY], r.customMetadata?.[ERROR_STATUS_KEY]];

// ── ClaudeLlm (Messages API, the Anthropic SDK) ──────────────────────────────

const ANTHROPIC_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_PLATFORM', 'ANTHROPIC_BASE_URL', 'AWS_REGION', 'ANTHROPIC_MODEL_MAP'];

/** Runs `run` with only a fixture Anthropic key set, restoring the environment after. */
async function withAnthropicEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ANTHROPIC_ENV.map((k) => [k, process.env[k]]));
  for (const k of ANTHROPIC_ENV) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
  try {
    return await run();
  } finally {
    for (const k of ANTHROPIC_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// The Anthropic SDK's error body; `retry-after-ms: 1` keeps its retries fast.
const anthropicStatus = (code: number, type: string) => () =>
  new Response(JSON.stringify({ type: 'error', error: { type, message: `status ${code}` } }), {
    status: code,
    headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
  });

test('ClaudeLlm marks an overloaded 529 retryable once the SDK has spent its retries', async () => {
  const { responses, calls } = await withAnthropicEnv(() =>
    withFetch(anthropicStatus(529, 'overloaded_error'), () =>
      collect(new ClaudeLlm({ model: 'claude-opus-5-5' }).generateContentAsync(request('claude-opus-5-5'))),
    ),
  );
  assert.equal(calls, 3, 'the SDK made its first attempt and two retries');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].errorCode, 'ANTHROPIC_ERROR', 'the error code is unchanged');
  assert.deepEqual(verdict(responses[0]), [true, 529]);
  assert.equal(isRetryableErrorResponse(responses[0]), true);
});

test('ClaudeLlm marks a 400 not retryable', async () => {
  const { responses, calls } = await withAnthropicEnv(() =>
    withFetch(anthropicStatus(400, 'invalid_request_error'), () =>
      collect(new ClaudeLlm({ model: 'claude-opus-5-5' }).generateContentAsync(request('claude-opus-5-5'))),
    ),
  );
  assert.equal(calls, 1);
  assert.equal(responses[0].errorCode, 'ANTHROPIC_ERROR');
  assert.match(responses[0].errorMessage ?? '', /status 400/, 'the SDK wording is kept');
  assert.deepEqual(verdict(responses[0]), [false, 400]);
  assert.equal(isRetryableErrorResponse(responses[0]), false);
});

// ── GptLlm (Responses API, the openai SDK) ───────────────────────────────────

test('GptLlm marks a 503 retryable once the SDK has spent its retries', async () => {
  const { responses, calls } = await withFetch(status(503), () =>
    collect(new GptLlm({ model: 'gpt-4.1', apiKey: OPENAI_KEY }).generateContentAsync(request('gpt-4.1'))),
  );
  assert.equal(calls, 3, 'the SDK made its first attempt and two retries');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].errorCode, 'OPENAI_ERROR', 'the error code is unchanged');
  assert.deepEqual(verdict(responses[0]), [true, 503]);
  assert.equal(isRetryableErrorResponse(responses[0]), true);
});

test('GptLlm marks a 400 not retryable', async () => {
  const { responses, calls } = await withFetch(status(400), () =>
    collect(new GptLlm({ model: 'gpt-4.1', apiKey: OPENAI_KEY }).generateContentAsync(request('gpt-4.1'))),
  );
  assert.equal(calls, 1);
  assert.equal(responses[0].errorCode, 'OPENAI_ERROR');
  assert.deepEqual(verdict(responses[0]), [false, 400]);
  assert.equal(isRetryableErrorResponse(responses[0]), false);
});

// ── OllamaLlm (the chat-completions base) ────────────────────────────────────

test('OllamaLlm marks a persistent 503 retryable, and keeps its code and the top-level fields', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    const { responses, calls } = await withFetch(status(503), () =>
      collect(new OllamaLlm({ model: 'ollama/qwen3:8b' }).generateContentAsync(request('ollama/qwen3:8b'))),
    );
    assert.equal(calls, 3, 'the adapter spent its retries first');
    const err = responses[0] as LlmResponse & { status?: number; retryable?: boolean };
    assert.equal(err.errorCode, 'OLLAMA_HTTP_ERROR');
    assert.deepEqual(verdict(err), [true, 503]);
    assert.deepEqual([err.status, err.retryable], [503, true]);
  } finally {
    restore();
  }
});

test('OllamaLlm marks a 400 not retryable', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    const { responses, calls } = await withFetch(status(400), () =>
      collect(new OllamaLlm({ model: 'ollama/qwen3:8b' }).generateContentAsync(request('ollama/qwen3:8b'))),
    );
    assert.equal(calls, 1);
    assert.equal(responses[0].errorCode, 'OLLAMA_HTTP_ERROR');
    assert.match(responses[0].errorMessage ?? '', /Ollama returned 400/, 'the wording is unchanged');
    assert.deepEqual(verdict(responses[0]), [false, 400]);
  } finally {
    restore();
  }
});

test('the chat-completions catch site: a reset is retryable, a refused connection is not', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  const failing = (code: string) => () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
  };
  try {
    for (const [code, retryable] of [['ECONNRESET', true], ['ECONNREFUSED', false]] as const) {
      const { responses } = await withFetch(failing(code), () =>
        collect(new OllamaLlm({ model: 'ollama/qwen3:8b' }).generateContentAsync(request('ollama/qwen3:8b'))),
      );
      assert.equal(responses[0].errorCode, 'OLLAMA_UNREACHABLE', code);
      assert.match(responses[0].errorMessage ?? '', /Could not reach Ollama/, code);
      assert.deepEqual(verdict(responses[0]), [retryable, undefined], code);
    }
  } finally {
    restore();
  }
});

// ── The helper ───────────────────────────────────────────────────────────────

test('providerErrorResponse keeps the wording, drops a key, and never calls a cancellation retryable', () => {
  const key = 'sk-ant-fixture0123456789abcdefghij'; // gitleaks:allow (test fixture)
  const leaky = Object.assign(new Error(`401 invalid x-api-key ${key}`), { status: 401 });
  const r = providerErrorResponse(leaky, 'ANTHROPIC_ERROR');
  assert.equal(r.errorCode, 'ANTHROPIC_ERROR');
  assert.match(r.errorMessage ?? '', /^401 invalid x-api-key /);
  assert.ok(!(r.errorMessage ?? '').includes(key), 'the key never leaves the adapter');
  assert.deepEqual(verdict(r), [false, 401]);

  const reset = providerErrorResponse(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'X_ERROR', 'Could not reach x (socket hang up).');
  assert.equal(reset.errorMessage, 'Could not reach x (socket hang up).');
  assert.deepEqual(verdict(reset), [true, undefined]);

  const aborted = providerErrorResponse(Object.assign(new Error('aborted'), { name: 'AbortError', status: 503 }), 'X_ERROR');
  assert.equal(aborted.customMetadata?.[ERROR_RETRYABLE_KEY], false);
});
