/**
 * tests/memoryProviders.test.ts — what computes memory is configurable
 * (ADR 0020): extraction on any model id through the adapters, embeddings on
 * Gemini or any OpenAI-compatible endpoint. Offline: scripted adapters and a
 * stubbed fetch.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  DEFAULT_EMBEDDING_MODELS,
  memoryProvidersFromEnv,
  modelExtractor,
  openAiCompatibleEmbedder,
} from '../lib/memory/providers.ts';
import { ScriptedModel, answer, failure } from './helpers/scriptedModel.ts';

process.env.OTEL_CONSOLE_SPANS = 'false';

test('modelExtractor returns the final text, skipping partials and thoughts', async () => {
  const adapter = new ScriptedModel('claude-sonnet-4-6', () => [
    { partial: true, parts: [{ type: 'thinking', text: 'thinking…' }, { type: 'text', text: 'streamed' }] },
    answer('[FACT] one'),
  ]);
  const extractor = modelExtractor({ model: 'claude-sonnet-4-6', resolve: () => adapter });
  assert.equal(await extractor.extract('PROMPT'), '[FACT] one');
  const seen = adapter.requests[0]!;
  assert.equal(seen.model, 'claude-sonnet-4-6');
  assert.deepEqual(seen.messages[0], { role: 'user', parts: [{ type: 'text', text: 'PROMPT' }] });
  assert.equal(seen.sampling?.temperature, 0.1);
});

test('modelExtractor throws on an adapter error so the turns stay pending', async () => {
  const extractor = modelExtractor({
    model: 'gpt-5-mini',
    resolve: () => new ScriptedModel('gpt-5-mini', () => failure({ code: 'RATE_LIMITED', message: '429' })),
  });
  await assert.rejects(extractor.extract('x'), /gpt-5-mini: RATE_LIMITED — 429/);
});

async function withFetch<T>(handler: (url: string, body: any) => Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => handler(String(url), JSON.parse(init.body))) as any;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('openAiCompatibleEmbedder posts one batch and returns vectors in input order', async () => {
  let posted: any;
  let url = '';
  const vectors = await withFetch(
    (u, body) => {
      url = u;
      posted = body;
      // Out of order on purpose: the embedder sorts by index.
      return Response.json({ data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }] });
    },
    () =>
      openAiCompatibleEmbedder({ baseUrl: 'https://proxy.example/v1/', model: 'emb', dimensions: 3, apiKey: 'k' }).embed([
        'a',
        'b',
      ]),
  );
  assert.equal(url, 'https://proxy.example/v1/embeddings');
  assert.deepEqual(posted, { model: 'emb', input: ['a', 'b'], dimensions: 3 });
  assert.deepEqual(vectors, [[1, 0, 0], [0, 1, 0]]);
});

test('an embedding of the wrong length is refused, naming the configured dimension', async () => {
  await assert.rejects(
    withFetch(
      () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }),
      () => openAiCompatibleEmbedder({ baseUrl: 'http://x/v1', model: 'emb', dimensions: 768 }).embed(['a']),
    ),
    /returned 2 dimensions, but memory is configured for 768/,
  );
});

test('an HTTP error from the embeddings endpoint throws with the status', async () => {
  await assert.rejects(
    withFetch(
      () => new Response('overloaded', { status: 503 }),
      () => openAiCompatibleEmbedder({ provider: 'ollama', baseUrl: 'http://x/v1', model: 'emb', dimensions: 3 }).embed(['a']),
    ),
    /ollama embeddings returned 503: overloaded/,
  );
});

test('memoryProvidersFromEnv: Gemini by default, the configured provider otherwise', () => {
  const d = memoryProvidersFromEnv({}, 'server-gemini-key');
  assert.equal(d.embedder.provider, 'gemini');
  assert.equal(d.embedder.dimensions, 768);

  const o = memoryProvidersFromEnv({
    MEMORY_EXTRACTION_MODEL: 'ollama/qwen3:8b',
    MEMORY_EMBEDDING_PROVIDER: 'ollama',
  });
  assert.equal(o.extractor.model, 'ollama/qwen3:8b');
  assert.equal(o.embedder.provider, 'ollama');
  assert.equal(o.embedder.model, DEFAULT_EMBEDDING_MODELS.ollama);

  const c = memoryProvidersFromEnv({
    MEMORY_EMBEDDING_PROVIDER: 'openai-compatible',
    MEMORY_EMBEDDING_BASE_URL: 'https://llm-proxy.internal/v1',
    MEMORY_EMBEDDING_MODEL: 'bge-m3',
    MEMORY_EMBEDDING_DIMENSIONS: '1024',
  });
  assert.equal(c.embedder.model, 'bge-m3');
  assert.equal(c.embedder.dimensions, 1024);
});

test('memoryProvidersFromEnv: with no Gemini key the embedder goes through a gateway that carries the same model; one that lacks it changes nothing (ADR 0146)', async () => {
  const viaVercel = memoryProvidersFromEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'gw-fixture' });
  assert.equal(viaVercel.embedder.provider, 'gemini');
  assert.equal(viaVercel.embedder.model, 'google/gemini-embedding-001');
  assert.equal(viaVercel.embedder.dimensions, 768);
  let url = '';
  let posted: any;
  await withFetch(
    (u, body) => {
      url = u;
      posted = body;
      return Response.json({ data: [{ index: 0, embedding: Array(768).fill(0.1) }] });
    },
    () => viaVercel.embedder.embed(['a']),
  );
  assert.equal(url, 'https://ai-gateway.vercel.sh/v1/embeddings');
  assert.deepEqual(posted, { model: 'google/gemini-embedding-001', input: ['a'], dimensions: 768 });

  const viaOpenRouter = memoryProvidersFromEnv({ MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'gw-fixture' });
  assert.equal(viaOpenRouter.embedder.model, 'gemini-embedding-001', 'OpenRouter has no Gemini embedding model: the direct path stays');

  const keyed = memoryProvidersFromEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'gw-fixture' }, 'server-gemini-key');
  assert.equal(keyed.embedder.model, 'gemini-embedding-001', 'a Gemini key wins by default');
  const preferred = memoryProvidersFromEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'gw-fixture', MODEL_GATEWAY_PREFER: 'gateway' }, 'server-gemini-key');
  assert.equal(preferred.embedder.model, 'google/gemini-embedding-001', 'the preference moves the embedder too, to the same model');

  const openai = memoryProvidersFromEnv({ MEMORY_EMBEDDING_PROVIDER: 'openai', MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'gw-fixture' });
  assert.equal(openai.embedder.model, 'openai/text-embedding-3-small');
  const proxied = memoryProvidersFromEnv({ MEMORY_EMBEDDING_PROVIDER: 'openai', MEMORY_EMBEDDING_BASE_URL: 'https://proxy.internal/v1', MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'gw-fixture' });
  assert.equal(proxied.embedder.model, 'text-embedding-3-small', 'an explicit proxy is the operator\'s choice; the gateway does not override it');
});

test('memoryProvidersFromEnv refuses a configuration it cannot honour', () => {
  assert.throws(() => memoryProvidersFromEnv({ MEMORY_EMBEDDING_PROVIDER: 'cohere' }), /not one of/);
  assert.throws(
    () => memoryProvidersFromEnv({ MEMORY_EMBEDDING_PROVIDER: 'openai-compatible' }),
    /needs MEMORY_EMBEDDING_BASE_URL and MEMORY_EMBEDDING_MODEL/,
  );
  assert.throws(() => memoryProvidersFromEnv({ MEMORY_EMBEDDING_DIMENSIONS: 'lots' }), /positive integer/);
});
