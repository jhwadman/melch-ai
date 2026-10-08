/**
 * tests/geminiAdapter.test.ts — the Gemini adapter on @google/genai directly,
 * behind the engine's model contract (lib/models/geminiAdapter.ts, WS3-1a).
 *
 * Most tests drive the adapter against a fake client injected through
 * `clientFactory` and assert the request object it builds and the contract
 * responses it yields. The last group runs the real GoogleGenAI client over a
 * stubbed fetch, so the JSON that would reach the Gemini API is asserted too.
 *
 * Offline: no provider is called, and every key is an obvious fixture.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { GoogleGenAI } from '@google/genai';
import type { GenerateContentParameters, GenerateContentResponse, GoogleGenAIOptions } from '@google/genai';

import { GeminiAdapter, THOUGHT_SIGNATURE_KIND } from '../lib/models/geminiAdapter.ts';
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
