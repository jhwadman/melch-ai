/**
 * tests/geminiAdapter.test.ts — the Gemini adapter on @google/genai directly,
 * behind the engine's model contract (lib/models/geminiAdapter.ts, WS3-1a
 * and WS3-1b).
 *
 * Most tests drive the adapter against a fake client injected through
 * `clientFactory` and assert the request object it builds and the contract
 * responses it yields. The tests named "on the wire" run the real GoogleGenAI
 * client over a stubbed fetch, so the JSON that would reach the Gemini API is
 * asserted too. The last group covers Gemini's own features: grounding with
 * spans, urlContext, code execution carried and replayed, server-side
 * invocations, id stripping, the request's abort, placeholder signatures.
 *
 * Offline: no provider is called, and every key is an obvious fixture.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { GoogleGenAI } from '@google/genai';
import type { GenerateContentParameters, GenerateContentResponse, GoogleGenAIOptions } from '@google/genai';

import {
  CARRIED_PARTS_KIND,
  GeminiAdapter,
  PLACEHOLDER_SIGNATURES_BY_DEFAULT,
  PLACEHOLDER_THOUGHT_SIGNATURE,
  THOUGHT_SIGNATURE_KIND,
} from '../lib/models/geminiAdapter.ts';
import { MINTED_CALL_ID_PREFIX } from '../lib/models/geminiState.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import type { GeminiAdapterOptions, GeminiClient } from '../lib/models/geminiAdapter.ts';
import type {
  AssistantMessage,
  FinalModelResponse,
  Message,
  ModelRequest,
  ModelResponse,
  PartialModelResponse,
  ToolCallPart,
  ToolDeclaration,
  ToolMessage,
  UserMessage,
} from '../lib/models/contract.ts';
import { setRetryPolicyOverrides } from '../lib/models/retry.ts';

const KEY = 'fixture-gemini-key-0123456789';
const MODEL = 'gemini-3-flash';

const ENV_KEYS = [
  'GOOGLE_GENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_PLATFORM', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GEMINI_MODEL_MAP',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let restoreRetries: () => void = () => {};

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  restoreRetries = setRetryPolicyOverrides({ baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 50 });
});

afterEach(() => {
  restoreRetries();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── The fake client ──────────────────────────────────────────────────────────

/** One scripted call: a response, a stream of chunks (an Error throws there), a throw, or a call that never settles. */
type Script =
  | { response: object }
  | { chunks: Array<object | Error> }
  | { error: unknown }
  | { hang: true };

class FakeClient implements GeminiClient {
  readonly requests: GenerateContentParameters[] = [];
  readonly options: GoogleGenAIOptions[] = [];
  readonly #script: Script[];

  constructor(...script: Script[]) {
    this.#script = script;
  }

  readonly factory = (options: GoogleGenAIOptions): GeminiClient => {
    this.options.push(options);
    return this;
  };

  #next(params: GenerateContentParameters): Script {
    this.requests.push(params);
    const step = this.#script.shift();
    if (!step) throw new Error('the fake client ran out of script');
    return step;
  }

  readonly models = {
    generateContent: async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
      const step = this.#next(params);
      if ('hang' in step) return new Promise(() => {});
      if ('error' in step) throw step.error;
      if ('chunks' in step) throw new Error('scripted a stream for a non-streamed call');
      return step.response as GenerateContentResponse;
    },
    generateContentStream: async (params: GenerateContentParameters): Promise<AsyncIterable<GenerateContentResponse>> => {
      const step = this.#next(params);
      if ('hang' in step) return new Promise(() => {});
      if ('error' in step) throw step.error;
      const chunks = 'chunks' in step ? step.chunks : [step.response];
      return (async function* () {
        for (const chunk of chunks) {
          if (chunk instanceof Error) throw chunk;
          yield chunk as GenerateContentResponse;
        }
      })();
    },
  };
}

function adapter(fake: FakeClient, options: Partial<GeminiAdapterOptions> = {}): GeminiAdapter {
  return new GeminiAdapter({ model: MODEL, apiKey: KEY, endpoint: { platform: 'direct' }, clientFactory: fake.factory, ...options });
}

interface Run {
  responses: ModelResponse[];
  partials: PartialModelResponse[];
  final: FinalModelResponse;
}

/** Drains one call, asserting the contract's shape: exactly one final, and it is last. */
async function run(a: GeminiAdapter, request: Partial<ModelRequest> & { messages: Message[] }): Promise<Run> {
  const responses: ModelResponse[] = [];
  for await (const r of a.generate({ model: a.model, ...request })) responses.push(r);
  const finals = responses.filter((r): r is FinalModelResponse => !r.partial);
  assert.equal(finals.length, 1, 'exactly one final');
  assert.equal(responses.at(-1)?.partial, false, 'the final is last');
  for (const p of finals[0].parts) assert.notEqual((p as { type: string }).type, 'thinking', 'a final never holds thinking');
  return { responses, partials: responses.filter((r): r is PartialModelResponse => r.partial), final: finals[0] };
}

const user = (text: string): UserMessage => ({ role: 'user', parts: [{ type: 'text', text }] });

const candidate = (parts: object[], finishReason = 'STOP', extra: object = {}) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason, ...extra }],
});

const LOOKUP: ToolDeclaration = {
  name: 'lookup',
  description: 'Looks a word up.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

// ── Request mapping ──────────────────────────────────────────────────────────

test('system, system messages and every message role map to systemInstruction and contents', async () => {
  const fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  const messages: Message[] = [
    user('Look up "cat".'),
    { role: 'system', parts: [{ type: 'text', text: 'Earlier turns were summarised.' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Looking.' },
        { type: 'toolCall', id: 'call-7', name: 'lookup', args: { q: 'cat' } },
        { type: 'toolCall', id: 'adk-3-1-lookup', name: 'lookup', args: { q: 'dog' } },
      ],
    },
    {
      role: 'tool',
      parts: [
        { type: 'toolResult', id: 'call-7', name: 'lookup', result: { hits: 2 } },
        { type: 'toolResult', id: 'adk-3-1-lookup', name: 'lookup', result: 'not found', isError: true },
      ],
    },
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'And these?' },
        { type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'blob', mimeType: 'application/pdf', url: 'gs://bucket/paper.pdf' },
      ],
    },
    { role: 'assistant', parts: [{ type: 'thinking', text: 'Only thinking, nothing to send.' }] },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'call-8', name: 'count', result: 3 }] },
  ];
  await run(adapter(fake), { system: 'You are terse.', messages });

  const { model, contents, config } = fake.requests[0];
  assert.equal(model, MODEL);
  assert.deepEqual(config?.systemInstruction, { parts: [{ text: 'You are terse.' }, { text: 'Earlier turns were summarised.' }] });
  assert.deepEqual(contents, [
    { role: 'user', parts: [{ text: 'Look up "cat".' }] },
    {
      role: 'model',
      parts: [
        { text: 'Looking.' },
        { functionCall: { id: 'call-7', name: 'lookup', args: { q: 'cat' } } },
        { functionCall: { name: 'lookup', args: { q: 'dog' } } },
      ],
    },
    {
      role: 'user',
      parts: [
        { functionResponse: { id: 'call-7', name: 'lookup', response: { hits: 2 } } },
        { functionResponse: { name: 'lookup', response: { error: 'not found' } } },
      ],
    },
    {
      role: 'user',
      parts: [
        { text: 'And these?' },
        { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
        { fileData: { mimeType: 'application/pdf', fileUri: 'gs://bucket/paper.pdf' } },
      ],
    },
    // The thinking-only assistant message is not sent: a content with no parts fails on Vertex AI.
    { role: 'user', parts: [{ functionResponse: { id: 'call-8', name: 'count', response: { result: 3 } } }] },
  ]);
});

test('tools go as functionDeclarations with the lowercase schema in parametersJsonSchema', async () => {
  const fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  await run(adapter(fake), { messages: [user('hi')], tools: [LOOKUP] });
  const declaration: Record<string, unknown> = (fake.requests[0].config?.tools as any[])[0].functionDeclarations[0];
  assert.equal(declaration.parameters, undefined, "Gemini's uppercase Schema dialect is not used");
  assert.deepEqual(fake.requests[0].config?.tools, [
    { functionDeclarations: [{ name: 'lookup', description: 'Looks a word up.', parametersJsonSchema: LOOKUP.parameters }] },
  ]);
  assert.equal(fake.requests[0].config?.toolConfig, undefined, 'no toolChoice and no strict tool: the provider default');
});

test('native tools: web_search and google_search are one googleSearch, url_context and code_execution map, the rest are dropped', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const fake = new FakeClient({ response: candidate([{ text: 'a' }]) }, { response: candidate([{ text: 'b' }]) });
  const a = adapter(fake);
  const nativeTools = ['web_search', 'google_search', 'url_context', 'code_execution', 'x_search', 'collections_search'] as const;
  await run(a, { messages: [user('hi')], tools: [LOOKUP], nativeTools: [...nativeTools] });
  await run(a, { messages: [user('hi')], nativeTools: ['x_search'] });
  assert.deepEqual(fake.requests[0].config?.tools?.slice(1), [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }]);
  assert.equal(fake.requests[1].config?.tools, undefined, 'a request whose only native tool is dropped sends no tools');
  assert.equal(warn.mock.callCount(), 2, 'each dropped tool is reported once per adapter');
  assert.match(String(warn.mock.calls[0].arguments[0]), /x_search is not a Gemini tool/);
});

test('toolChoice maps to functionCallingConfig; strict asks for VALIDATED under auto', async () => {
  const cases: Array<[ModelRequest['toolChoice'], ToolDeclaration[], unknown]> = [
    ['auto', [LOOKUP], { mode: 'AUTO' }],
    ['none', [LOOKUP], { mode: 'NONE' }],
    ['required', [LOOKUP], { mode: 'ANY' }],
    [{ name: 'lookup' }, [LOOKUP], { mode: 'ANY', allowedFunctionNames: ['lookup'] }],
    [undefined, [{ ...LOOKUP, strict: true }], { mode: 'VALIDATED' }],
    ['auto', [{ ...LOOKUP, strict: true }], { mode: 'VALIDATED' }],
    ['required', [{ ...LOOKUP, strict: true }], { mode: 'ANY' }],
  ];
  for (const [toolChoice, tools, expected] of cases) {
    const fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
    await run(adapter(fake), { messages: [user('hi')], tools, toolChoice });
    assert.deepEqual(fake.requests[0].config?.toolConfig, { functionCallingConfig: expected }, JSON.stringify(toolChoice));
  }
  const fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  await run(adapter(fake), { messages: [user('hi')], toolChoice: 'required' });
  assert.equal(fake.requests[0].config?.toolConfig, undefined, 'no function declarations: nothing to choose among');
});

test('outputSchema asks for JSON with the schema in responseJsonSchema', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
  const fake = new FakeClient({ response: candidate([{ text: '{"answer":"42"}' }]) });
  const { final } = await run(adapter(fake), { messages: [user('hi')], outputSchema: schema, tools: [LOOKUP] });
  assert.equal(fake.requests[0].config?.responseMimeType, 'application/json');
  assert.deepEqual(fake.requests[0].config?.responseJsonSchema, schema);
  assert.equal(fake.requests[0].config?.responseSchema, undefined);
  assert.deepEqual(final.parts, [{ type: 'text', text: '{"answer":"42"}' }]);
});

test("outputFormat 'json' is JSON mode: responseMimeType alone; a schema says more and wins (ADR 0061)", async () => {
  let fake = new FakeClient({ response: candidate([{ text: '{"answer":"42"}' }]) });
  await run(adapter(fake), { messages: [user('hi')], outputFormat: 'json' });
  assert.equal(fake.requests[0].config?.responseMimeType, 'application/json');
  assert.equal(fake.requests[0].config?.responseJsonSchema, undefined);
  const schema = { type: 'object', properties: { answer: { type: 'string' } } };
  fake = new FakeClient({ response: candidate([{ text: '{}' }]) });
  await run(adapter(fake), { messages: [user('hi')], outputFormat: 'json', outputSchema: schema });
  assert.deepEqual(fake.requests[0].config?.responseJsonSchema, schema);
  fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  await run(adapter(fake), { messages: [user('hi')] });
  assert.equal(fake.requests[0].config?.responseMimeType, undefined, 'plain text asks for no MIME type');
});

test("reasoning maps through ADR 0047's table, with thoughts included unless it is none", async () => {
  const cases: Array<[string, ModelRequest['reasoning'], unknown]> = [
    ['gemini-3-flash', 'none', { thinkingLevel: 'MINIMAL' }],
    ['gemini-3-flash', 'low', { thinkingLevel: 'LOW', includeThoughts: true }],
    ['gemini-3-flash', 'medium', { thinkingLevel: 'MEDIUM', includeThoughts: true }],
    ['gemini-3-flash', 'high', { thinkingLevel: 'HIGH', includeThoughts: true }],
    ['gemini-3-flash', { budget_tokens: 4096 }, { thinkingBudget: 4096, includeThoughts: true }],
    ['gemini-3-flash', { budget_tokens: 0 }, { thinkingLevel: 'MINIMAL' }],
    ['gemini-2.5-flash', 'none', { thinkingBudget: 0 }],
    ['gemini-2.5-flash', 'low', { thinkingBudget: 2048, includeThoughts: true }],
    ['gemini-2.5-pro', 'high', { thinkingBudget: 16384, includeThoughts: true }],
  ];
  for (const [model, reasoning, expected] of cases) {
    const fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
    await run(adapter(fake, { model }), { messages: [user('hi')], reasoning });
    const config = fake.requests[0].config as Record<string, unknown>;
    assert.deepEqual(config.thinkingConfig, expected, `${model} ${JSON.stringify(reasoning)}`);
    assert.equal(config.reasoningEffort, undefined, 'the effort word never reaches a Gemini request');
  }
  const fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  await run(adapter(fake), { messages: [user('hi')] });
  assert.equal(fake.requests[0].config?.thinkingConfig, undefined, "no setting: the model's default");
});

test('sampling and the abort signal go on the config; the platform model map names the wire model', async () => {
  const fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  const controller = new AbortController();
  const a = adapter(fake, { endpoint: { platform: 'direct', models: { [MODEL]: 'gemini-3-flash-preview-09-2026' } } });
  await run(a, {
    messages: [user('hi')],
    sampling: { temperature: 0.2, topP: 0.9, maxOutputTokens: 512, stop: ['END'] },
    signal: controller.signal,
  });
  const { model, config } = fake.requests[0];
  assert.equal(model, 'gemini-3-flash-preview-09-2026');
  assert.equal(config?.temperature, 0.2);
  assert.equal(config?.topP, 0.9);
  assert.equal(config?.maxOutputTokens, 512);
  assert.deepEqual(config?.stopSequences, ['END']);
  assert.equal(config?.abortSignal, controller.signal);
});

// ── Endpoint ─────────────────────────────────────────────────────────────────

test('the Gemini API: the given key wins, then the endpoint, then the environment, and Vertex mode is pinned off', async () => {
  const given = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
  await run(adapter(given, { endpoint: { platform: 'direct', apiKey: 'fixture-endpoint-key' } }), { messages: [user('hi')] });
  assert.deepEqual(given.options, [{ vertexai: false, apiKey: KEY }]);

  const fromEndpoint = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  await run(adapter(fromEndpoint, { apiKey: undefined, endpoint: { platform: 'direct', apiKey: 'fixture-endpoint-key' } }), { messages: [user('hi')] });
  assert.deepEqual(fromEndpoint.options, [{ vertexai: false, apiKey: 'fixture-endpoint-key' }]);

  delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
  process.env.GEMINI_API_KEY = 'fixture-env-key';
  const fromEnv = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  await run(new GeminiAdapter({ model: MODEL, clientFactory: fromEnv.factory }), { messages: [user('hi')] });
  assert.deepEqual(fromEnv.options, [{ vertexai: false, apiKey: 'fixture-env-key' }]);
});

test('Vertex AI: project and location from the endpoint, Google credentials, no AI Studio key', async () => {
  const fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  await run(adapter(fake, { endpoint: { platform: 'vertex', project: 'acme', location: 'europe-west4' } }), { messages: [user('hi')] });
  assert.deepEqual(fake.options, [{ vertexai: true, project: 'acme', location: 'europe-west4' }]);

  process.env.GEMINI_PLATFORM = 'vertex';
  process.env.GOOGLE_CLOUD_PROJECT = 'acme';
  process.env.GOOGLE_CLOUD_LOCATION = 'global';
  process.env.GEMINI_MODEL_MAP = JSON.stringify({ [MODEL]: 'publishers/google/models/gemini-3-flash' });
  const fromEnv = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  await run(new GeminiAdapter({ model: MODEL, apiKey: KEY, clientFactory: fromEnv.factory }), { messages: [user('hi')] });
  assert.deepEqual(fromEnv.options, [{ vertexai: true, project: 'acme', location: 'global' }]);
  assert.equal(fromEnv.requests[0].model, 'publishers/google/models/gemini-3-flash');
});

test('setup failures are finals: no key, an incomplete Vertex AI endpoint, a bad platform, a client that will not build', async () => {
  const noKey = new FakeClient();
  let { final } = await run(adapter(noKey, { apiKey: undefined }), { messages: [user('hi')] });
  assert.equal(final.error?.code, 'MISSING_API_KEY');
  assert.equal(final.error?.retryable, false);
  assert.equal(noKey.options.length, 0, 'no client is built without a key');

  ({ final } = await run(adapter(new FakeClient(), { endpoint: { platform: 'vertex', project: 'acme' } }), { messages: [user('hi')] }));
  assert.equal(final.error?.code, 'ENDPOINT_MISCONFIGURED');
  assert.match(final.error?.message ?? '', /GOOGLE_CLOUD_LOCATION not set/);

  process.env.GEMINI_PLATFORM = 'bedrock';
  ({ final } = await run(new GeminiAdapter({ model: MODEL, apiKey: KEY, clientFactory: new FakeClient().factory }), { messages: [user('hi')] }));
  assert.equal(final.error?.code, 'ENDPOINT_MISCONFIGURED');

  const broken = new GeminiAdapter({
    model: MODEL,
    apiKey: KEY,
    endpoint: { platform: 'direct' },
    clientFactory: () => {
      throw new Error(`bad options for ${KEY}`);
    },
  });
  ({ final } = await run(broken, { messages: [user('hi')] }));
  assert.equal(final.error?.code, 'ENDPOINT_MISCONFIGURED');
  assert.ok(!final.error?.message.includes(KEY), 'the key never reaches a message');
});

// ── Responses ────────────────────────────────────────────────────────────────

test('non-streaming: one thinking partial, then a final with text, the tool call, usage and finish', async () => {
  const fake = new FakeClient({
    response: {
      ...candidate([
        { text: 'Let me check the dictionary.', thought: true },
        { text: 'Checking.' },
        { functionCall: { id: 'fc-1', name: 'lookup', args: { q: 'cat' } } },
      ]),
      usageMetadata: {
        promptTokenCount: 100,
        toolUsePromptTokenCount: 20,
        candidatesTokenCount: 30,
        thoughtsTokenCount: 50,
        cachedContentTokenCount: 64,
        totalTokenCount: 200,
      },
    },
  });
  const { responses, partials, final } = await run(adapter(fake), { messages: [user('cat?')], tools: [LOOKUP], reasoning: 'low' });
  assert.equal(responses.length, 2);
  assert.deepEqual(partials, [{ partial: true, parts: [{ type: 'thinking', text: 'Let me check the dictionary.' }] }]);
  assert.deepEqual(final, {
    partial: false,
    parts: [
      { type: 'text', text: 'Checking.' },
      { type: 'toolCall', id: 'fc-1', name: 'lookup', args: { q: 'cat' } },
    ],
    finishReason: 'tool_call',
    usage: { inputTokens: 120, outputTokens: 80, thinkingTokens: 50, cacheReadTokens: 64 },
  });
});

test('streaming: thought chunks become thinking partials, text chunks text partials, then exactly one full final', async () => {
  const fake = new FakeClient({
    chunks: [
      candidate([{ text: 'Thinking about', thought: true }], ''),
      candidate([{ text: ' cats.', thought: true }], ''),
      candidate([{ text: 'Cats ' }], ''),
      candidate([{ text: 'purr.' }], ''),
      { ...candidate([], 'STOP'), usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, thoughtsTokenCount: 6 } },
    ],
  });
  const { partials, final } = await run(adapter(fake), { messages: [user('cats?')], stream: true, reasoning: 'low' });
  assert.deepEqual(
    partials.map((p) => p.parts),
    [
      [{ type: 'thinking', text: 'Thinking about' }],
      [{ type: 'thinking', text: ' cats.' }],
      [{ type: 'text', text: 'Cats ' }],
      [{ type: 'text', text: 'purr.' }],
    ],
  );
  assert.deepEqual(final, {
    partial: false,
    parts: [{ type: 'text', text: 'Cats purr.' }],
    finishReason: 'stop',
    usage: { inputTokens: 5, outputTokens: 10, thinkingTokens: 6 },
  });
  assert.ok(fake.requests.length === 1);
});

test('a call Gemini returns without an id gets a deterministic id from its position and name, kept off the wire', async () => {
  const response = candidate([
    { functionCall: { name: 'lookup', args: { q: 'cat' } } },
    { functionCall: { name: 'lookup', args: { q: 'dog' } } },
    { functionCall: { name: 'count', args: {} } },
  ]);
  const messages = [user('look up cat and dog, then count')];
  const first = await run(adapter(new FakeClient({ response })), { messages, tools: [LOOKUP] });
  const again = await run(adapter(new FakeClient({ response })), { messages, tools: [LOOKUP] });
  const ids = first.final.parts.map((p) => (p as ToolCallPart).id);
  assert.deepEqual(ids, ['adk-1-0-lookup', 'adk-1-1-lookup', 'adk-1-2-count']);
  assert.deepEqual(again.final.parts.map((p) => (p as ToolCallPart).id), ids, 'the same response gets the same ids');
  assert.equal(new Set(ids).size, 3);

  const fake = new FakeClient({ response: candidate([{ text: 'done' }]) });
  const assistant: AssistantMessage = { role: 'assistant', parts: first.final.parts };
  const tool: ToolMessage = {
    role: 'tool',
    parts: ids.map((id, i) => ({ type: 'toolResult', id, name: i === 2 ? 'count' : 'lookup', result: { ok: true } })),
  };
  await run(adapter(fake), { messages: [...messages, assistant, tool], tools: [LOOKUP] });
  const sent = fake.requests[0].contents as any[];
  for (const part of [...sent[1].parts, ...sent[2].parts]) {
    assert.equal((part.functionCall ?? part.functionResponse).id, undefined, 'an engine-made id stays off the wire');
  }
});

// ── Thought signatures ───────────────────────────────────────────────────────

test('a thought signature survives two steps of a tool loop, on the part it came with, and stays in its turn', async () => {
  const fake = new FakeClient(
    // Step 1: thinking, then a call carrying the signature.
    {
      response: candidate([
        { text: 'I should look it up.', thought: true },
        { functionCall: { name: 'lookup', args: { q: 'cat' } }, thoughtSignature: 'c2lnLXN0ZXAtMQ==' },
      ]),
    },
    // Step 2, streamed: the answer, with its signature on a trailing empty part.
    { chunks: [candidate([{ text: 'A cat ' }], ''), candidate([{ text: 'is a feline.' }], ''), candidate([{ text: '', thoughtSignature: 'c2lnLXN0ZXAtMg==' }])] },
    // Next turn.
    { response: candidate([{ text: 'Sure.' }]) },
  );
  const a = adapter(fake);
  const messages: Message[] = [user('What is a cat?')];

  const step1 = await run(a, { messages, tools: [LOOKUP], reasoning: 'medium' });
  const call = step1.final.parts[0] as ToolCallPart;
  assert.deepEqual(call.providerState, { provider: 'gemini', kind: THOUGHT_SIGNATURE_KIND, model: MODEL, payload: 'c2lnLXN0ZXAtMQ==' });

  messages.push({ role: 'assistant', parts: step1.final.parts });
  messages.push({ role: 'tool', parts: [{ type: 'toolResult', id: call.id, name: 'lookup', result: { definition: 'a feline' } }] });
  const step2 = await run(a, { messages, tools: [LOOKUP], reasoning: 'medium', stream: true });
  assert.deepEqual((fake.requests[1].contents as any[])[1], {
    role: 'model',
    parts: [{ functionCall: { name: 'lookup', args: { q: 'cat' } }, thoughtSignature: 'c2lnLXN0ZXAtMQ==' }],
  });
  assert.deepEqual(step2.final.parts, [
    {
      type: 'text',
      text: 'A cat is a feline.',
      providerState: { provider: 'gemini', kind: THOUGHT_SIGNATURE_KIND, model: MODEL, payload: 'c2lnLXN0ZXAtMg==' },
    },
  ]);

  messages.push({ role: 'assistant', parts: step2.final.parts });
  messages.push(user('Thanks.'));
  await run(a, { messages, tools: [LOOKUP] });
  const nextTurn = JSON.stringify(fake.requests[2].contents);
  assert.ok(!nextTurn.includes('thoughtSignature'), "an earlier turn's signatures are not replayed");
  assert.ok(!nextTurn.includes('providerState'), 'providerState never goes on the wire');
});

test("a thinking part's signature moves to the next output part, received and replayed", async () => {
  const fake = new FakeClient({
    response: candidate([
      { text: 'Plan: look it up.', thought: true, thoughtSignature: 'dGhvdWdodC1zaWc=' },
      { functionCall: { id: 'fc-1', name: 'lookup', args: { q: 'cat' } } },
    ]),
  });
  const { final } = await run(adapter(fake), { messages: [user('cat?')], tools: [LOOKUP] });
  assert.equal((final.parts[0] as ToolCallPart).providerState?.payload, 'dGhvdWdodC1zaWc=');

  const replay = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  const stored: AssistantMessage = {
    role: 'assistant',
    parts: [
      { type: 'thinking', text: 'Plan.', providerState: { provider: 'gemini', kind: THOUGHT_SIGNATURE_KIND, payload: 'c3RvcmVk' } },
      { type: 'toolCall', id: 'fc-1', name: 'lookup', args: { q: 'cat' } },
    ],
  };
  await run(adapter(replay), {
    messages: [user('cat?'), stored, { role: 'tool', parts: [{ type: 'toolResult', id: 'fc-1', name: 'lookup', result: {} }] }],
  });
  assert.deepEqual((replay.requests[0].contents as any[])[1].parts, [
    { functionCall: { id: 'fc-1', name: 'lookup', args: { q: 'cat' } }, thoughtSignature: 'c3RvcmVk' },
  ]);
});

test("another provider's state and another Gemini model's signature are not replayed", async () => {
  const fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  const assistant: AssistantMessage = {
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Claude said this.', providerState: { provider: 'anthropic', kind: 'thinking_blocks', payload: [{ type: 'thinking' }] } },
      { type: 'text', text: 'Pro said this.', providerState: { provider: 'gemini', kind: THOUGHT_SIGNATURE_KIND, model: 'gemini-3-pro', payload: 'cHJv' } },
      { type: 'toolCall', id: 'fc-1', name: 'lookup', args: { q: 'cat' }, providerState: { provider: 'gemini', kind: THOUGHT_SIGNATURE_KIND, payload: 'dW5ib3VuZA==' } },
    ],
  };
  await run(adapter(fake), {
    messages: [user('cat?'), assistant, { role: 'tool', parts: [{ type: 'toolResult', id: 'fc-1', name: 'lookup', result: {} }] }],
  });
  assert.deepEqual((fake.requests[0].contents as any[])[1].parts, [
    { text: 'Claude said this.' },
    { text: 'Pro said this.' },
    { functionCall: { id: 'fc-1', name: 'lookup', args: { q: 'cat' } }, thoughtSignature: 'dW5ib3VuZA==' },
  ]);
});

// ── Abort ────────────────────────────────────────────────────────────────────

test('an aborted signal ends the call before it is sent, not retryable', async () => {
  const fake = new FakeClient();
  const controller = new AbortController();
  controller.abort();
  const { final } = await run(adapter(fake), { messages: [user('hi')], signal: controller.signal });
  assert.equal(fake.requests.length, 0);
  assert.equal(final.error?.code, 'GEMINI_ERROR');
  assert.equal(final.error?.retryable, false);
  assert.equal(final.finishReason, 'error');
});

test('an abort mid-stream ends the call at once, with what arrived before it', async () => {
  const controller = new AbortController();
  // The stream yields one chunk and then stalls for good.
  const fake = new FakeClient({ hang: true });
  fake.models.generateContentStream = async (params) => {
    fake.requests.push(params);
    return (async function* () {
      yield candidate([{ text: 'Partial answer' }], '') as unknown as GenerateContentResponse;
      await new Promise(() => {});
    })();
  };
  const iterator = adapter(fake).generate({ model: MODEL, messages: [user('hi')], stream: true, signal: controller.signal })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.deepEqual(first.value, { partial: true, parts: [{ type: 'text', text: 'Partial answer' }] });
  controller.abort();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'stalled'>((resolve) => {
    timer = setTimeout(() => resolve('stalled'), 1000);
  });
  const second = await Promise.race([iterator.next(), timeout]);
  clearTimeout(timer);
  assert.notEqual(second, 'stalled', 'the abort ends the iteration without waiting for the transport');
  const final = (second as IteratorResult<ModelResponse>).value as FinalModelResponse;
  assert.equal(final.partial, false);
  assert.equal(final.error?.code, 'GEMINI_ERROR');
  assert.equal(final.error?.retryable, false);
  assert.deepEqual(final.parts, [{ type: 'text', text: 'Partial answer' }]);
  assert.equal((await iterator.next()).done, true, 'nothing follows the final');
});

// ── Errors ───────────────────────────────────────────────────────────────────

/** An error shaped like genai's ApiError. */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { name: 'ApiError', status });
}

test('a transient failure is retried before the first chunk, then answers', async () => {
  const fake = new FakeClient({ error: apiError(503, 'The model is overloaded.') }, { response: candidate([{ text: 'Recovered.' }]) });
  const { final } = await run(adapter(fake), { messages: [user('hi')] });
  assert.equal(fake.requests.length, 2);
  assert.deepEqual(final.parts, [{ type: 'text', text: 'Recovered.' }]);
  assert.equal(final.error, undefined);
});

test('a thrown call is a GEMINI_ERROR final with its status and retry classification, and no key', async () => {
  const overloaded = new FakeClient(...Array.from({ length: 3 }, () => ({ error: apiError(503, 'The model is overloaded.') })));
  let { final } = await run(adapter(overloaded), { messages: [user('hi')] });
  assert.equal(overloaded.requests.length, 3, 'the shared policy: three attempts');
  assert.deepEqual(final.error, { code: 'GEMINI_ERROR', message: 'The model is overloaded.', retryable: true, status: 503 });
  assert.equal(final.finishReason, 'error');

  const invalid = new FakeClient({ error: apiError(400, `API key not valid: ${KEY} and AIza${'x'.repeat(35)}`) });
  ({ final } = await run(adapter(invalid), { messages: [user('hi')] }));
  assert.equal(invalid.requests.length, 1, 'a 400 is the request’s own fault and is not retried');
  assert.equal(final.error?.status, 400);
  assert.equal(final.error?.retryable, false);
  assert.ok(!final.error?.message.includes(KEY), 'the key in use is scrubbed');
  assert.ok(!final.error?.message.includes('AIza'), 'a Google key shape is scrubbed');
  assert.match(final.error?.message ?? '', /API key not valid/);

  const reset = new FakeClient(
    { error: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) },
    { response: candidate([{ text: 'ok' }]) },
  );
  ({ final } = await run(adapter(reset), { messages: [user('hi')] }));
  assert.equal(reset.requests.length, 2, 'a connection reset is retried');
});

test('a stream that fails after its first chunk is not retried; the final keeps the text', async () => {
  const fake = new FakeClient({ chunks: [candidate([{ text: 'Half an ans' }], ''), apiError(503, 'stream broke')] });
  const { partials, final } = await run(adapter(fake), { messages: [user('hi')], stream: true });
  assert.equal(fake.requests.length, 1);
  assert.equal(partials.length, 1);
  assert.deepEqual(final.parts, [{ type: 'text', text: 'Half an ans' }]);
  assert.equal(final.error?.code, 'GEMINI_ERROR');
  assert.equal(final.error?.status, 503);
});

test("a blocked prompt carries Gemini's block reason as the code", async () => {
  let { final } = await run(adapter(new FakeClient({ response: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 9 } } })), {
    messages: [user('hi')],
  });
  assert.equal(final.error?.code, 'PROHIBITED_CONTENT');
  assert.equal(final.error?.retryable, false);
  assert.equal(final.finishReason, 'content_filter');
  assert.deepEqual(final.usage, { inputTokens: 9, outputTokens: 0 });

  ({ final } = await run(adapter(new FakeClient({ chunks: [{ promptFeedback: { blockReason: 'BLOCKED_REASON_UNSPECIFIED' } }] })), {
    messages: [user('hi')],
    stream: true,
  }));
  assert.equal(final.error?.code, 'OTHER', 'an unspecified block is OTHER, a code the contract knows');

  ({ final } = await run(adapter(new FakeClient({ response: {} })), { messages: [user('hi')] }));
  assert.equal(final.error?.code, 'UNKNOWN_ERROR');
  assert.equal(final.finishReason, 'error');
});

test('a safety finish is an error with the finish reason as the code, even after text', async () => {
  let { final } = await run(adapter(new FakeClient({ response: candidate([], 'SAFETY') })), { messages: [user('hi')] });
  assert.equal(final.error?.code, 'SAFETY');
  assert.equal(final.finishReason, 'content_filter');

  ({ final } = await run(adapter(new FakeClient({ chunks: [candidate([{ text: 'Here is how to' }], ''), candidate([], 'RECITATION')] })), {
    messages: [user('hi')],
    stream: true,
  }));
  assert.equal(final.error?.code, 'RECITATION');
  assert.equal(final.finishReason, 'content_filter');
  assert.deepEqual(final.parts, [{ type: 'text', text: 'Here is how to' }]);

  ({ final } = await run(adapter(new FakeClient({ response: candidate([], 'IMAGE_SAFETY') })), { messages: [user('hi')] }));
  assert.equal(final.error?.code, 'IMAGE_SAFETY');
  assert.equal(final.finishReason, 'content_filter');
});

test('finish reasons: thinking cut short is MAX_TOKENS, a cut-short reply keeps its text, an empty STOP is no error', async () => {
  let { final } = await run(adapter(new FakeClient({ response: candidate([{ text: 'Still thinking', thought: true }], 'MAX_TOKENS') })), {
    messages: [user('hi')],
    reasoning: 'high',
  });
  assert.equal(final.error?.code, 'MAX_TOKENS');
  assert.equal(final.finishReason, 'max_tokens');
  assert.deepEqual(final.parts, []);

  ({ final } = await run(adapter(new FakeClient({ response: candidate([{ text: 'A long ans' }], 'MAX_TOKENS') })), { messages: [user('hi')] }));
  assert.equal(final.error, undefined);
  assert.equal(final.finishReason, 'max_tokens');

  ({ final } = await run(adapter(new FakeClient({ response: candidate([], 'STOP') })), { messages: [user('hi')] }));
  assert.deepEqual(final, { partial: false, parts: [], finishReason: 'stop' });

  ({ final } = await run(adapter(new FakeClient({ response: candidate([], 'MALFORMED_FUNCTION_CALL') })), { messages: [user('hi')] }));
  assert.equal(final.error?.code, 'MALFORMED_FUNCTION_CALL');
  assert.equal(final.finishReason, 'other');
});

// ── Grounding ────────────────────────────────────────────────────────────────

test('grounding metadata becomes the cited pages and the search queries', async () => {
  const fake = new FakeClient({
    response: candidate([{ text: 'It rained.' }], 'STOP', {
      groundingMetadata: {
        webSearchQueries: ['weather paris yesterday'],
        groundingChunks: [
          { web: { uri: 'https://example.org/paris', title: 'example.org' } },
          { web: { uri: 'https://example.org/paris', title: 'example.org' } },
          { web: { uri: 'https://example.com/meteo' } },
          { retrievedContext: { uri: 'gs://corpus/doc' } },
        ],
      },
    }),
  });
  const { final } = await run(adapter(fake), { messages: [user('weather?')], nativeTools: ['google_search'] });
  assert.deepEqual(final.grounding, {
    citations: [{ url: 'https://example.org/paris', title: 'example.org' }, { url: 'https://example.com/meteo' }],
    searchQueries: [{ tool: 'google_search', query: 'weather paris yesterday' }],
  });
});

// ── The real client over a stubbed fetch ─────────────────────────────────────

interface Captured {
  url: string;
  headers: Headers;
  body: any;
}

async function withFetch(reply: (init: RequestInit) => Response | Promise<Response>, fn: (seen: Captured[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const seen: Captured[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return reply(init);
  }) as typeof fetch;
  try {
    await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}

const realClient = (options: GoogleGenAIOptions) => new GoogleGenAI(options);

test('on the wire (real SDK): schemas, signatures, tool config and thinking reach the Gemini API as mapped', async () => {
  const signed: AssistantMessage = {
    role: 'assistant',
    parts: [{ type: 'toolCall', id: 'adk-1-0-lookup', name: 'lookup', args: { q: 'cat' }, providerState: { provider: 'gemini', kind: THOUGHT_SIGNATURE_KIND, model: MODEL, payload: 'c2ln' } }],
  };
  await withFetch(
    () =>
      new Response(JSON.stringify({ ...candidate([{ text: '{"answer":"a feline"}', thoughtSignature: 'bmV4dA==' }]), usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    async (seen) => {
      const a = new GeminiAdapter({ model: MODEL, apiKey: KEY, endpoint: { platform: 'direct' }, clientFactory: realClient });
      const { final } = await run(a, {
        system: 'Be brief.',
        messages: [user('What is a cat?'), signed, { role: 'tool', parts: [{ type: 'toolResult', id: 'adk-1-0-lookup', name: 'lookup', result: { definition: 'a feline' } }] }],
        tools: [{ ...LOOKUP, strict: true }],
        outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
        reasoning: 'high',
        signal: new AbortController().signal,
      });
      assert.equal(seen.length, 1);
      const { url, headers, body } = seen[0];
      assert.match(url, /\/models\/gemini-3-flash:generateContent$/);
      assert.ok(!url.includes(KEY), 'the key is not in the URL');
      assert.equal(headers.get('x-goog-api-key'), KEY);
      assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be brief.' }] });
      assert.deepEqual(body.contents[1], { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'cat' } }, thoughtSignature: 'c2ln' }] });
      assert.deepEqual(body.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { definition: 'a feline' } } }] });
      assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: 'lookup', description: 'Looks a word up.', parametersJsonSchema: LOOKUP.parameters }] }]);
      assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'VALIDATED' } });
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH', includeThoughts: true });
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.deepEqual(body.generationConfig.responseJsonSchema, { type: 'object', properties: { answer: { type: 'string' } } });
      const raw = JSON.stringify(body);
      for (const absent of ['providerState', 'reasoningEffort', 'abortSignal', 'adk-1-0-lookup']) assert.ok(!raw.includes(absent), `${absent} is not on the wire`);

      assert.deepEqual(final, {
        partial: false,
        parts: [{ type: 'text', text: '{"answer":"a feline"}', providerState: { provider: 'gemini', kind: THOUGHT_SIGNATURE_KIND, model: MODEL, payload: 'bmV4dA==' } }],
        finishReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 3 },
      });
    },
  );
});

test('on the wire (real SDK): a streamed answer arrives as partials and one final', async () => {
  const sse = [
    candidate([{ text: 'Weighing it.', thought: true }], ''),
    candidate([{ text: 'Cats ' }], ''),
    { ...candidate([{ text: 'purr.' }]), usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 3 } },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('');
  await withFetch(
    () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    async (seen) => {
      const a = new GeminiAdapter({ model: MODEL, apiKey: KEY, endpoint: { platform: 'direct' }, clientFactory: realClient });
      const { partials, final } = await run(a, { messages: [user('cats?')], stream: true, reasoning: 'low' });
      assert.match(seen[0].url, /:streamGenerateContent\?alt=sse$/);
      assert.deepEqual(
        partials.map((p) => p.parts),
        [[{ type: 'thinking', text: 'Weighing it.' }], [{ type: 'text', text: 'Cats ' }], [{ type: 'text', text: 'purr.' }]],
      );
      assert.deepEqual(final, { partial: false, parts: [{ type: 'text', text: 'Cats purr.' }], finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 5, thinkingTokens: 3 } });
    },
  );
});

test("on the wire (real SDK): genai's ApiError becomes GEMINI_ERROR with its status, and an abort stops the fetch", async () => {
  await withFetch(
    () => new Response(JSON.stringify({ error: { code: 400, message: 'Invalid JSON payload.', status: 'INVALID_ARGUMENT' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    async (seen) => {
      const a = new GeminiAdapter({ model: MODEL, apiKey: KEY, endpoint: { platform: 'direct' }, clientFactory: realClient });
      const { final } = await run(a, { messages: [user('hi')] });
      assert.equal(seen.length, 1);
      assert.equal(final.error?.code, 'GEMINI_ERROR');
      assert.equal(final.error?.status, 400);
      assert.equal(final.error?.retryable, false);
      assert.match(final.error?.message ?? '', /Invalid JSON payload/);
    },
  );

  const controller = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  await withFetch(
    (init) =>
      new Promise<Response>((_, reject) => {
        fetchSignal = init.signal ?? undefined;
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
        setTimeout(() => controller.abort(), 5);
      }),
    async () => {
      const a = new GeminiAdapter({ model: MODEL, apiKey: KEY, endpoint: { platform: 'direct' }, clientFactory: realClient });
      const { final } = await run(a, { messages: [user('hi')], signal: controller.signal });
      assert.equal(fetchSignal?.aborted, true, "the SDK's fetch saw the abort");
      assert.equal(final.error?.code, 'GEMINI_ERROR');
      assert.equal(final.error?.retryable, false);
    },
  );
});

// ── Gemini's own features (WS3-1b) ───────────────────────────────────────────

const json = (body: object): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const engineAdapter = (options: Partial<GeminiAdapterOptions> = {}) =>
  new GeminiAdapter({ model: MODEL, apiKey: KEY, endpoint: { platform: 'direct' }, clientFactory: realClient, ...options });
const carried = (before: object[], signature?: string, model = MODEL) => ({
  provider: 'gemini',
  kind: CARRIED_PARTS_KIND,
  model,
  payload: { before, ...(signature ? { signature } : {}) },
});

const CODE = { executableCode: { language: 'PYTHON', code: 'print(6 * 7)' } };
const RESULT = { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '42\n' } };

test('on the wire (real SDK): grounding becomes spanned citations and queries, urlContext cites the pages it read', async () => {
  // "Café" is 5 bytes in UTF-8 and 4 UTF-16 units: the spans are converted.
  const answer = 'Café Nord opens at 9. It rains today.';
  await withFetch(
    () =>
      json(
        candidate([{ text: answer }], 'STOP', {
          groundingMetadata: {
            webSearchQueries: ['cafe nord hours', 'weather today'],
            groundingChunks: [
              { web: { uri: 'https://example.org/nord', title: 'example.org' } },
              { web: { uri: 'https://example.com/weather', title: 'example.com' } },
              { web: { uri: 'https://example.net/unused' } },
            ],
            groundingSupports: [
              { segment: { endIndex: 22, text: 'Café Nord opens at 9.' }, groundingChunkIndices: [0] },
              // Offsets that miss the text: the text's place in the answer is the span.
              { segment: { startIndex: 3, endIndex: 9, partIndex: 1, text: 'It rains today.' }, groundingChunkIndices: [1, 1] },
              // A segment not in the answer has no span.
              { segment: { text: 'Not in the answer.' }, groundingChunkIndices: [2] },
            ],
          },
          urlContextMetadata: {
            urlMetadata: [
              { retrievedUrl: 'https://example.org/menu', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' },
              { retrievedUrl: 'https://example.org/paywalled', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_PAYWALL' },
            ],
          },
        }),
      ),
    async (seen) => {
      const { final } = await run(engineAdapter(), {
        messages: [user('When does Café Nord open? See https://example.org/menu')],
        nativeTools: ['web_search', 'url_context'],
      });
      assert.deepEqual(seen[0].body.tools, [{ googleSearch: {} }, { urlContext: {} }]);
      assert.equal(seen[0].body.toolConfig, undefined, 'no function declarations: no server-side invocations asked for');
      assert.deepEqual(final.grounding, {
        citations: [
          { url: 'https://example.org/nord', title: 'example.org', start: 0, end: 21 },
          { url: 'https://example.com/weather', title: 'example.com', start: 22, end: 37 },
          { url: 'https://example.net/unused' },
          { url: 'https://example.org/menu' },
        ],
        searchQueries: [
          { tool: 'web_search', query: 'cafe nord hours' },
          { tool: 'web_search', query: 'weather today' },
        ],
      });
      assert.equal(answer.slice(0, 21), 'Café Nord opens at 9.');
    },
  );
});

test('on the wire (real SDK): native tools beside function declarations ask for server-side invocations, on the Gemini API only', async () => {
  await withFetch(
    () => json(candidate([{ text: 'ok' }])),
    async (seen) => {
      const a = engineAdapter();
      await run(a, { messages: [user('hi')], tools: [LOOKUP], nativeTools: ['google_search', 'code_execution'], toolChoice: 'auto' });
      await run(a, { messages: [user('hi')], tools: [LOOKUP] });
      await run(a, { messages: [user('hi')], tools: [LOOKUP], nativeTools: ['x_search'] });
      assert.deepEqual(seen[0].body.tools.slice(1), [{ googleSearch: {} }, { codeExecution: {} }]);
      assert.deepEqual(seen[0].body.toolConfig, { functionCallingConfig: { mode: 'AUTO' }, includeServerSideToolInvocations: true });
      assert.equal(seen[1].body.toolConfig, undefined, 'function declarations alone: the provider default');
      assert.equal(seen[2].body.toolConfig, undefined, 'a dropped native tool is not a native tool sent');
    },
  );

  // Vertex AI: the SDK refuses the flag, so the adapter never sends it there.
  const vertex = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  await run(adapter(vertex, { endpoint: { platform: 'vertex', project: 'acme', location: 'global' } }), {
    messages: [user('hi')],
    tools: [LOOKUP],
    nativeTools: ['url_context'],
  });
  assert.deepEqual(vertex.requests[0].config?.tools?.slice(1), [{ urlContext: {} }]);
  assert.equal(vertex.requests[0].config?.toolConfig, undefined);
  await withFetch(
    () => json(candidate([{ text: 'ok' }])),
    async (seen) => {
      const sdk = new GoogleGenAI({ vertexai: true, project: 'acme', location: 'global' });
      await assert.rejects(
        sdk.models.generateContent({ model: MODEL, contents: 'hi', config: { toolConfig: { includeServerSideToolInvocations: true } } }),
        /only supported in Gemini Developer API mode/,
      );
      assert.equal(seen.length, 0);
    },
  );
});

test('on the wire (real SDK): code execution and its result ride on the next part, replayed within the turn, never after it', async () => {
  const replies = [
    // Step 1: a thought, the code and its result, text, and a call.
    candidate([
      { text: 'Compute it first.', thought: true, thoughtSignature: 'dGhvdWdodA==' },
      CODE,
      RESULT,
      { text: 'The product is 42.' },
      { functionCall: { name: 'lookup', args: { q: '42' } }, thoughtSignature: 'Y2FsbA==' },
    ]),
    // Step 2: the answer.
    candidate([{ text: '42 is the answer.' }]),
    // Next turn.
    candidate([{ text: 'You are welcome.' }]),
  ];
  await withFetch(
    () => json(replies.shift()!),
    async (seen) => {
      const a = engineAdapter();
      const messages: Message[] = [user('What is 6 times 7, and look it up.')];
      const step1 = await run(a, { messages, tools: [LOOKUP], nativeTools: ['code_execution'], reasoning: 'low' });
      assert.deepEqual(step1.final.parts, [
        // The thought's signature goes on the next part Gemini sent, the code.
        { type: 'text', text: 'The product is 42.', providerState: carried([{ ...CODE, thoughtSignature: 'dGhvdWdodA==' }, RESULT]) },
        {
          type: 'toolCall',
          id: 'adk-1-0-lookup',
          name: 'lookup',
          args: { q: '42' },
          providerState: { provider: 'gemini', kind: THOUGHT_SIGNATURE_KIND, model: MODEL, payload: 'Y2FsbA==' },
        },
      ]);
      assert.equal(step1.final.finishReason, 'tool_call');

      messages.push({ role: 'assistant', parts: step1.final.parts });
      messages.push({ role: 'tool', parts: [{ type: 'toolResult', id: 'adk-1-0-lookup', name: 'lookup', result: { fact: 'answer' } }] });
      await run(a, { messages, tools: [LOOKUP], nativeTools: ['code_execution'] });
      assert.deepEqual(seen[1].body.contents[1], {
        role: 'model',
        parts: [
          { ...CODE, thoughtSignature: 'dGhvdWdodA==' },
          RESULT,
          { text: 'The product is 42.' },
          { functionCall: { name: 'lookup', args: { q: '42' } }, thoughtSignature: 'Y2FsbA==' },
        ],
      });
      assert.deepEqual(seen[1].body.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { fact: 'answer' } } }] });

      messages.push({ role: 'assistant', parts: [{ type: 'text', text: '42 is the answer.' }] });
      messages.push(user('Thanks.'));
      await run(a, { messages, tools: [LOOKUP], nativeTools: ['code_execution'] });
      const nextTurn = JSON.stringify(seen[2].body.contents);
      for (const absent of ['executableCode', 'codeExecutionResult', 'thoughtSignature', 'providerState']) {
        assert.ok(!nextTurn.includes(absent), `${absent} from an earlier turn is not sent`);
      }
      assert.deepEqual(seen[2].body.contents[1].parts, [{ text: 'The product is 42.' }, { functionCall: { name: 'lookup', args: { q: '42' } } }]);
    },
  );
});

test('carried parts: streamed text splits around them, server-side invocations ride too, and a trailing run gets an empty part', async () => {
  const toolCall = { toolCall: { id: 'srv-1', toolType: 'GOOGLE_SEARCH_WEB', args: { queries: ['vix'] } } };
  const toolResponse = { toolResponse: { id: 'srv-1', toolType: 'GOOGLE_SEARCH_WEB', response: { ok: true } } };
  const fake = new FakeClient({
    chunks: [candidate([{ text: 'Let me ' }], ''), candidate([{ text: 'check. ' }, toolCall, toolResponse], ''), candidate([{ text: 'It is 22.' }])],
  });
  const { partials, final } = await run(adapter(fake), { messages: [user('vix?')], stream: true, nativeTools: ['web_search'] });
  assert.deepEqual(
    partials.map((p) => p.parts),
    [[{ type: 'text', text: 'Let me ' }], [{ type: 'text', text: 'check. ' }], [{ type: 'text', text: 'It is 22.' }]],
    'carried parts are not streamed',
  );
  assert.deepEqual(final.parts, [
    { type: 'text', text: 'Let me check. ' },
    { type: 'text', text: 'It is 22.', providerState: carried([toolCall, toolResponse]) },
  ]);

  const trailing = new FakeClient({ response: candidate([{ text: 'Running it.' }, CODE, { ...RESULT, thoughtSignature: 'cmVzdWx0' }]) });
  const after = await run(adapter(trailing), { messages: [user('run it')], nativeTools: ['code_execution'] });
  assert.deepEqual(after.final.parts, [
    { type: 'text', text: 'Running it.' },
    { type: 'text', text: '', providerState: carried([CODE, { ...RESULT, thoughtSignature: 'cmVzdWx0' }]) },
  ]);
  assert.equal(after.final.error, undefined);

  // Replayed, the empty part sends only what it carries.
  const replay = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  await run(adapter(replay), { messages: [user('run it'), { role: 'assistant', parts: after.final.parts }] });
  assert.deepEqual((replay.requests[0].contents as any[])[1].parts, [{ text: 'Running it.' }, CODE, { ...RESULT, thoughtSignature: 'cmVzdWx0' }]);

  // Only code, cut short: still no answer.
  const cut = new FakeClient({ response: candidate([CODE], 'MAX_TOKENS') });
  const short = await run(adapter(cut), { messages: [user('run it')], nativeTools: ['code_execution'] });
  assert.equal(short.final.error?.code, 'MAX_TOKENS');
});

test("carried parts and their signature: another Gemini model's go back unsigned", async () => {
  const fake = new FakeClient({ response: candidate([{ text: 'ok' }]) });
  const assistant: AssistantMessage = {
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Pro computed.', providerState: carried([{ ...CODE, thoughtSignature: 'cHJv' }, RESULT], 'cHJvLXRleHQ=', 'gemini-3-pro') },
      { type: 'text', text: 'Flash computed.', providerState: carried([CODE, RESULT], 'Zmxhc2g=') },
    ],
  };
  await run(adapter(fake), { messages: [user('compute'), assistant] });
  assert.deepEqual((fake.requests[0].contents as any[])[1].parts, [
    CODE,
    RESULT,
    { text: 'Pro computed.' },
    CODE,
    RESULT,
    { text: 'Flash computed.', thoughtSignature: 'Zmxhc2g=' },
  ]);
});

test("on the wire (real SDK): ids the engine or the genai mapping made never reach Gemini; Gemini's own go back", async () => {
  await withFetch(
    () => json(candidate([{ text: 'ok' }])),
    async (seen) => {
      const assistant: AssistantMessage = {
        role: 'assistant',
        parts: [
          { type: 'toolCall', id: `${MINTED_CALL_ID_PREFIX}1-0`, name: 'lookup', args: { q: 'a' } },
          { type: 'toolCall', id: 'adk-1-1-lookup', name: 'lookup', args: { q: 'b' } },
          { type: 'toolCall', id: 'fc-gemini-7', name: 'lookup', args: { q: 'c' } },
        ],
      };
      const tool: ToolMessage = {
        role: 'tool',
        parts: [
          { type: 'toolResult', id: `${MINTED_CALL_ID_PREFIX}1-0`, name: 'lookup', result: { r: 1 } },
          { type: 'toolResult', id: 'adk-1-1-lookup', name: 'lookup', result: { r: 2 } },
          { type: 'toolResult', id: 'fc-gemini-7', name: 'lookup', result: { r: 3 } },
        ],
      };
      await run(engineAdapter(), { messages: [user('look up a, b and c'), assistant, tool], tools: [LOOKUP] });
      const raw = JSON.stringify(seen[0].body);
      assert.ok(!raw.includes(MINTED_CALL_ID_PREFIX), 'a minted id is never sent');
      assert.ok(!raw.includes('adk-1-1-lookup'), "the engine's id is never sent");
      assert.deepEqual(seen[0].body.contents[1].parts.map((p: any) => p.functionCall.id), [undefined, undefined, 'fc-gemini-7']);
      assert.deepEqual(seen[0].body.contents[2].parts.map((p: any) => p.functionResponse.id), [undefined, undefined, 'fc-gemini-7']);
    },
  );
});

test("on the wire (real SDK): the abort comes from the request alone, never from the turn's own signal", async () => {
  const control = createTurnControl();
  control.stop('canceled');
  let fetchSignal: AbortSignal | null | undefined;
  await withFetch(
    (init) => {
      fetchSignal = init.signal;
      return json(candidate([{ text: 'still answered' }]));
    },
    async (seen) => {
      const { final } = await runWithTurnControl(control, () => run(engineAdapter(), { messages: [user('hi')] }));
      assert.equal(seen.length, 1, 'a stopped turn does not stop a request that carries no signal');
      assert.equal(fetchSignal?.aborted ?? false, false);
      assert.equal(final.error, undefined);
      assert.deepEqual(final.parts, [{ type: 'text', text: 'still answered' }]);

      const controller = new AbortController();
      controller.abort();
      const turn = createTurnControl();
      const aborted = await runWithTurnControl(turn, () => run(engineAdapter(), { messages: [user('hi')], signal: controller.signal }));
      turn.dispose();
      assert.equal(seen.length, 1, "the request's aborted signal ends the call before it is sent");
      assert.equal(aborted.final.error?.code, 'GEMINI_ERROR');
    },
  );
  control.dispose();
});

test('placeholder signatures: off by default; on, the first unsigned call of each current-turn step gets one', async () => {
  const unsigned: AssistantMessage = {
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Claude called these.' },
      { type: 'toolCall', id: 'toolu_1', name: 'lookup', args: { q: 'a' } },
      { type: 'toolCall', id: 'toolu_2', name: 'lookup', args: { q: 'b' } },
    ],
  };
  const results: ToolMessage = {
    role: 'tool',
    parts: [
      { type: 'toolResult', id: 'toolu_1', name: 'lookup', result: {} },
      { type: 'toolResult', id: 'toolu_2', name: 'lookup', result: {} },
    ],
  };
  const signed: AssistantMessage = {
    role: 'assistant',
    parts: [{ type: 'toolCall', id: 'fc-3', name: 'lookup', args: { q: 'c' }, providerState: { provider: 'gemini', kind: THOUGHT_SIGNATURE_KIND, model: MODEL, payload: 'b3du' } }],
  };
  const signedResult: ToolMessage = { role: 'tool', parts: [{ type: 'toolResult', id: 'fc-3', name: 'lookup', result: {} }] };
  const earlier: Message[] = [user('earlier'), unsigned, results, { role: 'assistant', parts: [{ type: 'text', text: 'done' }] }];
  const messages: Message[] = [...earlier, user('now'), unsigned, results, signed, signedResult];

  await withFetch(
    () => json(candidate([{ text: 'ok' }])),
    async (seen) => {
      await run(engineAdapter(), { messages, tools: [LOOKUP] });
      assert.ok(!JSON.stringify(seen[0].body).includes(PLACEHOLDER_THOUGHT_SIGNATURE), 'off by default');

      await run(engineAdapter({ placeholderSignatures: true }), { messages, tools: [LOOKUP] });
      const contents = seen[1].body.contents;
      assert.equal(contents[1].parts[1].thoughtSignature, undefined, 'an earlier turn is not touched');
      assert.deepEqual(contents[5].parts, [
        { text: 'Claude called these.' },
        { functionCall: { id: 'toolu_1', name: 'lookup', args: { q: 'a' } }, thoughtSignature: PLACEHOLDER_THOUGHT_SIGNATURE },
        { functionCall: { id: 'toolu_2', name: 'lookup', args: { q: 'b' } } },
      ]);
      assert.deepEqual(contents[7].parts, [{ functionCall: { id: 'fc-3', name: 'lookup', args: { q: 'c' } }, thoughtSignature: 'b3du' }], 'a real signature stays');
    },
  );
  assert.equal(PLACEHOLDER_SIGNATURES_BY_DEFAULT, false);
});
