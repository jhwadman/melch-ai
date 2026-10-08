/**
 * tests/resolveAdapter.test.ts — the engine's own registry (WS1-3, ADR 0060):
 * resolveAdapter for every prefix, the gateway fallback, BYOK key injection
 * and endpoints on the contract path, the Gemini adapter choice, the
 * FallbackAdapter pair, and that the ADK path (registerAvailableProviders,
 * resolveModel, the compiler's fallback pair) is what it was.
 *
 * Offline: the environment is set and restored around each test, and every
 * wire call is a stubbed fetch answering 400. Keys are fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMRegistry, LogLevel, setLogLevel } from '@google/adk';

import {
  geminiAdapterChoice,
  registerAvailableProviders,
  resolveAdapter,
  resolveAdapterWithFallback,
  resolveModel,
  TracedGemini,
} from '../lib/models/registry.ts';
import type { ModelAdapter, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { AdkShim } from '../lib/models/adkShim.ts';
import { AdkGeminiAdapter } from '../lib/models/adkGeminiAdapter.ts';
import { ClaudeAdapter } from '../lib/models/claudeAdapter.ts';
import { ClaudeLlm } from '../lib/models/claudeLlm.ts';
import { FallbackAdapter } from '../lib/models/fallbackAdapter.ts';
import { FallbackLlm } from '../lib/models/fallback.ts';
import { GatewayAdapter } from '../lib/models/gatewayAdapter.ts';
import { GeminiAdapter } from '../lib/models/geminiAdapter.ts';
import { GptAdapter } from '../lib/models/gptAdapter.ts';
import { GptLlm } from '../lib/models/gptLlm.ts';
import { GrokAdapter } from '../lib/models/grokAdapter.ts';
import { GrokLlm } from '../lib/models/grokLlm.ts';
import { KimiAdapter } from '../lib/models/kimiAdapter.ts';
import { KimiLlm } from '../lib/models/kimiLlm.ts';
import { OllamaAdapter } from '../lib/models/ollamaAdapter.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { compileSubagent } from '../lib/compile.ts';

setLogLevel(LogLevel.WARN);

const ENV_KEYS = [
  'GOOGLE_GENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GEMINI_PLATFORM',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_PLATFORM',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_PLATFORM',
  'OPENAI_BASE_URL',
  'XAI_API_KEY',
  'MOONSHOT_API_KEY',
  'MOONSHOT_BASE_URL',
  'OLLAMA_BASE_URL',
  'MODEL_GATEWAY',
  'MODEL_GATEWAY_API_KEY',
  'MODEL_GATEWAY_BASE_URL',
  'MODEL_GATEWAY_MODEL_MAP',
  'GEMINI_ADAPTER',
];

const ENV_GEMINI = 'fixture-env-gemini-0123456789';
const ENV_ANTHROPIC = 'fixture-env-anthropic-0123456789';
const ENV_OPENAI = 'fixture-env-openai-0123456789';
const ENV_XAI = 'fixture-env-xai-0123456789';
const ENV_MOONSHOT = 'fixture-env-moonshot-0123456789';
const CALLER = 'fixture-caller-key-0123456789';

const ALL_KEYS = {
  GOOGLE_GENAI_API_KEY: ENV_GEMINI,
  ANTHROPIC_API_KEY: ENV_ANTHROPIC,
  OPENAI_API_KEY: ENV_OPENAI,
  XAI_API_KEY: ENV_XAI,
  MOONSHOT_API_KEY: ENV_MOONSHOT,
};
const GATEWAY_ONLY = { MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'fixture-gateway-0123456789' };

/** Runs fn with ONLY the given env vars set (of the ones this suite touches). */
async function withEnv<T>(vars: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

interface Seen {
  url: string;
  headers: Headers;
}

/** Runs one call through the adapter against a fetch that answers 400; returns what went on the wire and the final. */
async function call(adapter: ModelAdapter): Promise<{ seen: Seen[]; final: ModelResponse | undefined }> {
  const real = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    seen.push({ url, headers });
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'captured', code: 400 } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  let final: ModelResponse | undefined;
  try {
    const request: ModelRequest = { model: adapter.model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] };
    for await (const r of adapter.generate(request)) final = r;
  } finally {
    globalThis.fetch = real;
  }
  return { seen, final };
}

/** Every header value the call sent, so a test can ask which key went out without knowing the vendor's header. */
function headerValues(seen: Seen[]): string {
  return seen.flatMap((s) => [...s.headers.values()]).join('\n');
}

// ── Every prefix ─────────────────────────────────────────────────────────────

test('resolveAdapter returns each provider\'s contract adapter from the one prefix table', async () => {
  await withEnv(ALL_KEYS, () => {
    const cases: Array<[string, new (...a: any[]) => ModelAdapter, string]> = [
      ['claude-sonnet-4-6', ClaudeAdapter, 'anthropic'],
      ['gpt-5-mini', GptAdapter, 'openai'],
      ['o4-mini', GptAdapter, 'openai'],
      ['grok-4.7', GrokAdapter, 'xai'],
      ['kimi-k3', KimiAdapter, 'moonshot'],
      ['ollama/qwen3:8b', OllamaAdapter, 'ollama'],
      ['gemini-3.5-flash-lite', GeminiAdapter, 'gemini'],
      ['some-unknown-id', GeminiAdapter, 'gemini'],
    ];
    for (const [id, cls, provider] of cases) {
      const adapter = resolveAdapter(id);
      assert.ok(adapter instanceof cls, `${id} → ${cls.name}, got ${adapter.constructor.name}`);
      assert.equal(adapter.provider, provider, id);
      assert.equal(adapter.model, id);
    }
    assert.ok(!(resolveAdapter('gpt-5-mini') instanceof GrokAdapter), 'a gpt id is not served by the Grok subclass');
  });
});

test('Gemini: the engine adapter by default (ADR 0100); the ADK wrapper by GEMINI_ADAPTER=adk or the option', async () => {
  await withEnv({ GOOGLE_GENAI_API_KEY: ENV_GEMINI }, () => {
    assert.equal(geminiAdapterChoice(), 'engine');
    assert.ok(resolveAdapter('gemini-x') instanceof GeminiAdapter);
    assert.ok(resolveAdapter('gemini-x', { gemini: 'adk' }) instanceof AdkGeminiAdapter);
  });
  await withEnv({ GOOGLE_GENAI_API_KEY: ENV_GEMINI, GEMINI_ADAPTER: 'ADK' }, () => {
    assert.equal(geminiAdapterChoice(), 'adk');
    assert.ok(resolveAdapter('gemini-x') instanceof AdkGeminiAdapter);
    assert.ok(resolveAdapter('gemini-x', { gemini: 'engine' }) instanceof GeminiAdapter, 'the option wins over the environment');
  });
  await withEnv({ ...ALL_KEYS, GEMINI_ADAPTER: 'genai' }, () => {
    assert.throws(() => resolveAdapter('gemini-x'), /GEMINI_ADAPTER must be "adk" or "engine"/);
    assert.ok(resolveAdapter('claude-x') instanceof ClaudeAdapter, 'a bad GEMINI_ADAPTER touches only Gemini ids');
  });
});

// ── The gateway fallback ─────────────────────────────────────────────────────

test('the gateway serves an id only when its direct key is absent, never Ollama, never over a BYOK key', async () => {
  await withEnv(GATEWAY_ONLY, () => {
    for (const id of ['claude-sonnet-4-6', 'gpt-5-mini', 'grok-4.7', 'kimi-k3', 'gemini-x']) {
      const adapter = resolveAdapter(id);
      assert.ok(adapter instanceof GatewayAdapter, `${id} via the gateway`);
      assert.equal(adapter.model, id);
    }
    assert.equal(resolveAdapter('claude-sonnet-4-6').provider, 'anthropic', 'attributed to the upstream provider');
    assert.ok(resolveAdapter('ollama/qwen3:8b') instanceof OllamaAdapter);
    assert.ok(resolveAdapter('claude-sonnet-4-6', { apiKey: CALLER }) instanceof ClaudeAdapter, "a caller's key makes the route direct");
    assert.ok(resolveAdapter('gpt-5-mini', { endpoint: { baseURL: 'https://tenant-proxy.internal/v1' } }) instanceof GptAdapter, "a caller's endpoint makes it direct");
    assert.ok(
      resolveAdapter('claude-sonnet-4-6', { apiKey: CALLER, keyProvider: 'gemini' }) instanceof GatewayAdapter,
      "another provider's key is not this provider's key",
    );
  });
  await withEnv({ ...GATEWAY_ONLY, ANTHROPIC_API_KEY: ENV_ANTHROPIC }, () => {
    assert.ok(resolveAdapter('claude-sonnet-4-6') instanceof ClaudeAdapter, 'the direct key wins over the gateway');
  });
});

test('the gateway adapter carries the gateway key, never a caller key', async () => {
  await withEnv(GATEWAY_ONLY, async () => {
    const { seen } = await call(resolveAdapter('claude-sonnet-4-6', { apiKey: CALLER, keyProvider: 'openai' }));
    assert.ok(seen.length > 0);
    assert.match(seen[0]!.url, /vercel/);
    assert.match(headerValues(seen), /fixture-gateway-0123456789/);
    assert.doesNotMatch(headerValues(seen), new RegExp(CALLER));
  });
});

// ── BYOK key injection ───────────────────────────────────────────────────────

for (const [id, envKey] of [
  ['claude-sonnet-4-6', ENV_ANTHROPIC],
  ['gpt-5-mini', ENV_OPENAI],
  ['grok-4.7', ENV_XAI],
  ['kimi-k3', ENV_MOONSHOT],
  ['gemini-x', ENV_GEMINI],
] as const) {
  test(`BYOK on ${id}: the caller's key goes on the wire, not the environment's, and never into the error`, async () => {
    await withEnv(ALL_KEYS, async () => {
      for (const gemini of id === 'gemini-x' ? (['adk', 'engine'] as const) : (['adk'] as const)) {
        const { seen, final } = await call(resolveAdapter(id, { apiKey: CALLER, gemini }));
        assert.ok(seen.length > 0, `${id} (${gemini}) made a call`);
        const sent = headerValues(seen);
        assert.match(sent, new RegExp(CALLER), `${id} (${gemini}) sends the caller's key`);
        assert.doesNotMatch(sent, new RegExp(envKey), `${id} (${gemini}) does not send the environment's key`);
        assert.ok(final && !final.partial && final.error, `${id} (${gemini}) ends in an error final`);
        assert.doesNotMatch(JSON.stringify(final), new RegExp(CALLER), 'the key never reaches the error');
      }
    });
  });
}

test("BYOK is scoped: a key for another provider is not sent, the model's env key is", async () => {
  await withEnv(ALL_KEYS, async () => {
    const { seen } = await call(resolveAdapter('claude-sonnet-4-6', { apiKey: CALLER, keyProvider: 'gemini' }));
    assert.match(headerValues(seen), new RegExp(ENV_ANTHROPIC));
    assert.doesNotMatch(headerValues(seen), new RegExp(CALLER));
  });
});

// ── Endpoints (ADR 0023) ─────────────────────────────────────────────────────

test('an endpoint from the credentials plug point reaches the adapter', async () => {
  await withEnv({}, async () => {
    let r = await call(resolveAdapter('gpt-5-mini', { endpoint: { baseURL: 'https://tenant-proxy.internal/v1', apiKey: 'fixture-tenant-0123456789' } }));
    assert.equal(r.seen[0]!.url, 'https://tenant-proxy.internal/v1/responses');
    assert.match(headerValues(r.seen), /fixture-tenant-0123456789/);

    r = await call(resolveAdapter('claude-sonnet-4-6', { endpoint: { baseURL: 'https://claude-proxy.internal', apiKey: 'fixture-tenant-0123456789' } }));
    assert.match(r.seen[0]!.url, /^https:\/\/claude-proxy\.internal\/v1\/messages/);
    assert.match(headerValues(r.seen), /fixture-tenant-0123456789/);

    r = await call(resolveAdapter('kimi-k3', { apiKey: CALLER, endpoint: { baseURL: 'https://kimi-proxy.internal/v1' } }));
    assert.equal(r.seen[0]!.url, 'https://kimi-proxy.internal/v1/chat/completions');
  });
});

test('the same route on both paths: resolveModel and resolveAdapter send a key and endpoint to one place', async () => {
  await withEnv({}, async () => {
    const options = { endpoint: { baseURL: 'https://tenant-proxy.internal/v1' }, apiKey: CALLER };
    const viaAdapter = await call(resolveAdapter('gpt-5-mini', options));
    const shim = resolveModel('gpt-5-mini', { ...options, defaultProvider: 'openai' }) as GptLlm;
    assert.ok(shim instanceof GptLlm);
    const viaShim = await call(shim.adapter);
    assert.equal(viaShim.seen[0]!.url, viaAdapter.seen[0]!.url);
    assert.equal(viaShim.seen[0]!.headers.get('authorization'), viaAdapter.seen[0]!.headers.get('authorization'));
  });
});

// ── The fallback pair ────────────────────────────────────────────────────────

test('resolveAdapterWithFallback: a FallbackAdapter around both adapters, the key kept with the primary\'s provider', async () => {
  await withEnv(ALL_KEYS, async () => {
    assert.ok(resolveAdapterWithFallback('claude-sonnet-4-6', undefined) instanceof ClaudeAdapter);
    const pair = resolveAdapterWithFallback('claude-sonnet-4-6', 'gpt-5-mini', { apiKey: CALLER }, { log: () => {} });
    assert.ok(pair instanceof FallbackAdapter);
    assert.ok(pair.primary instanceof ClaudeAdapter);
    assert.ok(pair.fallback instanceof GptAdapter);
    assert.equal(pair.provider, 'anthropic');
    const { seen } = await call(pair.fallback);
    assert.doesNotMatch(headerValues(seen), new RegExp(CALLER), "the primary's key is not sent to the fallback's provider");
    assert.match(headerValues(seen), new RegExp(ENV_OPENAI));
  });
});

// ── The ADK path is unchanged ────────────────────────────────────────────────

test('resolveModel still returns each provider\'s own ADK class', async () => {
  await withEnv(ALL_KEYS, () => {
    assert.ok(resolveModel('claude-x') instanceof ClaudeLlm);
    assert.equal(resolveModel('gpt-5-mini').constructor, GptLlm);
    assert.ok(resolveModel('grok-4.7') instanceof GrokLlm);
    assert.ok(resolveModel('kimi-k3') instanceof KimiLlm);
    assert.ok(resolveModel('ollama/qwen3:8b') instanceof OllamaLlm);
    assert.ok(resolveModel('gemini-x') instanceof TracedGemini);
  });
});

test("registerAvailableProviders registers the providers' own classes under their own patterns", async () => {
  await withEnv(ALL_KEYS, () => {
    registerAvailableProviders();
    assert.equal(LLMRegistry.resolve('claude-sonnet-4-6'), ClaudeLlm);
    assert.equal(LLMRegistry.resolve('gpt-5-mini'), GptLlm);
    assert.equal(LLMRegistry.resolve('o4-mini'), GptLlm);
    assert.equal(LLMRegistry.resolve('grok-4.7'), GrokLlm);
    assert.equal(LLMRegistry.resolve('kimi-k3'), KimiLlm);
    assert.equal(LLMRegistry.resolve('ollama/qwen3:8b'), OllamaLlm);
    assert.equal(LLMRegistry.resolve('gemini-3.5-flash-lite'), TracedGemini);
  });
});

test('the compiler\'s fallback pair stays FallbackLlm(shim(primary), shim(fallback)) (ADR 0053)', async () => {
  await withEnv(ALL_KEYS, async () => {
    const agent = (await compileSubagent(
      { name: 'Pair', description: 'p', instruction: 'y', model: 'claude-sonnet-4-6', fallback_model: 'gpt-5-mini' } as any,
      { resolveModel: (m) => resolveModel(m), log: () => {} },
    )) as any;
    assert.ok(agent.model instanceof FallbackLlm);
    assert.ok(agent.model.primary instanceof ClaudeLlm && agent.model.primary instanceof AdkShim);
    assert.ok(agent.model.fallback instanceof GptLlm && agent.model.fallback instanceof AdkShim);
  });
});
