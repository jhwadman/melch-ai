/**
 * tests/errorResponse.test.ts — an adapter's failed final, mapped as the
 * model step stores it (modelResponseToLlmResponse), says whether another
 * model may succeed (lib/models/errorResponse.ts): the verdict a
 * fallback_model reads (ADR 0044).
 *
 * Proved here, offline against a stubbed `globalThis.fetch`:
 *   - ClaudeAdapter (the real Anthropic SDK, its own retries spent) marks a
 *     529 retryable with 'error.status' 529, and a 400 not retryable,
 *     keeping ANTHROPIC_ERROR;
 *   - GptAdapter (the real openai SDK, its own retries spent) and
 *     OllamaAdapter (the chat-completions base) attach
 *     customMetadata['error.retryable'] true and 'error.status' 503 on a
 *     503, false and 400 on a 400, with their errorCodes unchanged;
 *   - the chat-completions catch site marks a connection reset retryable
 *     and a refused connection not;
 *   - the message keeps its wording and never carries a key, and a
 *     cancellation is never retryable.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter } from '../lib/models/claudeAdapter.ts';
import { GptAdapter } from '../lib/models/gptAdapter.ts';
import { OllamaAdapter } from '../lib/models/ollamaAdapter.ts';
import type { ModelAdapter } from '../lib/models/contract.ts';
import { modelResponseToLlmResponse } from '../lib/models/genaiMapping.ts';
import type { LlmResponse } from '../lib/models/genaiMapping.ts';
import { setRetryPolicyOverrides } from '../lib/models/retry.ts';
import { ERROR_RETRYABLE_KEY, ERROR_STATUS_KEY, errorDecision, errorText, withRetryVerdict } from '../lib/models/errorResponse.ts';

const OPENAI_KEY = 'fixture-openai-0123456789abcdef'; // gitleaks:allow (test fixture)
const ANTHROPIC_KEY = 'fixture-anthropic-0123456789abcdef'; // gitleaks:allow (test fixture)
const FAST = { baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 50 };

/** One call of `adapter` on a plain request, each response mapped as the model step stores it. */
async function collect(adapter: ModelAdapter): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const r of adapter.generate({ model: adapter.model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] })) {
    out.push(modelResponseToLlmResponse(r));
  }
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

// ── ClaudeAdapter (Messages API, the Anthropic SDK) ──────────────────────────

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

test('ClaudeAdapter marks an overloaded 529 retryable once the SDK has spent its retries', async () => {
  const { responses, calls } = await withAnthropicEnv(() =>
    withFetch(anthropicStatus(529, 'overloaded_error'), () =>
      collect(new ClaudeAdapter({ model: 'claude-opus-5-5' })),
    ),
  );
  assert.equal(calls, 3, 'the SDK made its first attempt and two retries');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].errorCode, 'ANTHROPIC_ERROR', 'the error code is unchanged');
  assert.deepEqual(verdict(responses[0]), [true, 529]);
});

test('ClaudeAdapter marks a 400 not retryable', async () => {
  const { responses, calls } = await withAnthropicEnv(() =>
    withFetch(anthropicStatus(400, 'invalid_request_error'), () =>
      collect(new ClaudeAdapter({ model: 'claude-opus-5-5' })),
    ),
  );
  assert.equal(calls, 1);
  assert.equal(responses[0].errorCode, 'ANTHROPIC_ERROR');
  assert.match(responses[0].errorMessage ?? '', /status 400/, 'the SDK wording is kept');
  assert.deepEqual(verdict(responses[0]), [false, 400]);
});

// ── GptAdapter (Responses API, the openai SDK) ───────────────────────────────

test('GptAdapter marks a 503 retryable once the SDK has spent its retries', async () => {
  const { responses, calls } = await withFetch(status(503), () =>
    collect(new GptAdapter({ model: 'gpt-4.1', apiKey: OPENAI_KEY })),
  );
  assert.equal(calls, 3, 'the SDK made its first attempt and two retries');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].errorCode, 'OPENAI_ERROR', 'the error code is unchanged');
  assert.deepEqual(verdict(responses[0]), [true, 503]);
});

test('GptAdapter marks a 400 not retryable', async () => {
  const { responses, calls } = await withFetch(status(400), () =>
    collect(new GptAdapter({ model: 'gpt-4.1', apiKey: OPENAI_KEY })),
  );
  assert.equal(calls, 1);
  assert.equal(responses[0].errorCode, 'OPENAI_ERROR');
  assert.deepEqual(verdict(responses[0]), [false, 400]);
});

// ── OllamaAdapter (the chat-completions base) ────────────────────────────────

test('OllamaAdapter marks a persistent 503 retryable, and keeps its code', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    const { responses, calls } = await withFetch(status(503), () =>
      collect(new OllamaAdapter({ model: 'ollama/qwen3:8b' })),
    );
    assert.equal(calls, 3, 'the adapter spent its retries first');
    assert.equal(responses[0].errorCode, 'OLLAMA_HTTP_ERROR');
    assert.deepEqual(verdict(responses[0]), [true, 503]);
  } finally {
    restore();
  }
});

test('OllamaAdapter marks a 400 not retryable', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    const { responses, calls } = await withFetch(status(400), () =>
      collect(new OllamaAdapter({ model: 'ollama/qwen3:8b' })),
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
        collect(new OllamaAdapter({ model: 'ollama/qwen3:8b' })),
      );
      assert.equal(responses[0].errorCode, 'OLLAMA_UNREACHABLE', code);
      assert.match(responses[0].errorMessage ?? '', /Could not reach Ollama/, code);
      assert.deepEqual(verdict(responses[0]), [retryable, undefined], code);
    }
  } finally {
    restore();
  }
});

// ── The helpers ──────────────────────────────────────────────────────────────

/** A caught error's response as an adapter's catch site builds it. */
const caught = (err: unknown, errorCode: string, errorMessage: string = errorText(err)): LlmResponse =>
  withRetryVerdict({ errorCode, errorMessage }, errorDecision(err));

test('errorText, errorDecision and withRetryVerdict keep the wording, drop a key, and never call a cancellation retryable', () => {
  const key = 'sk-ant-fixture0123456789abcdefghij'; // gitleaks:allow (test fixture)
  const leaky = Object.assign(new Error(`401 invalid x-api-key ${key}`), { status: 401 });
  const r = caught(leaky, 'ANTHROPIC_ERROR');
  assert.equal(r.errorCode, 'ANTHROPIC_ERROR');
  assert.match(r.errorMessage ?? '', /^401 invalid x-api-key /);
  assert.ok(!(r.errorMessage ?? '').includes(key), 'the key never leaves the adapter');
  assert.deepEqual(verdict(r), [false, 401]);

  const worded = withRetryVerdict({ errorCode: 'X_ERROR', errorMessage: `bad key ${key}` }, { retryable: false });
  assert.ok(!(worded.errorMessage ?? '').includes(key), 'an adapter\'s own wording is scrubbed too');

  const reset = caught(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'X_ERROR', 'Could not reach x (socket hang up).');
  assert.equal(reset.errorMessage, 'Could not reach x (socket hang up).');
  assert.deepEqual(verdict(reset), [true, undefined]);

  const aborted = caught(Object.assign(new Error('aborted'), { name: 'AbortError', status: 503 }), 'X_ERROR');
  assert.equal(aborted.customMetadata?.[ERROR_RETRYABLE_KEY], false);
});
