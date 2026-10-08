/**
 * tests/chatCompletionsAdapter.test.ts — the chat-completions adapters on the
 * engine's own model contract (lib/models/chatCompletionsAdapter.ts,
 * ollamaAdapter.ts, kimiAdapter.ts, gatewayAdapter.ts; WS1-6, ADR 0057).
 *
 * Every adapter here is driven with a ModelRequest, never an LlmRequest, and
 * the request bodies are the ones the ADK-path tests assert for OllamaLlm,
 * KimiLlm and GatewayLlm (tests/models.test.ts, reasoningKey.test.ts,
 * kimiReasoningState.test.ts, capabilityMatrix.test.ts, gateway.test.ts):
 * the reasoning field per provider, the reasoning_content replay, the
 * think-block splitter, the retry without thinking, the tools, structured
 * output, vision, streaming. Then what the contract adds: usage in its
 * meaning, failures as finals with the retry verdict, the abort, tool choice,
 * and the ADK shims' own shape (the ledger's counts, the older spelling).
 *
 * Offline: globalThis.fetch is a stub that records each request and answers
 * from a script. Keys are fixtures.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogLevel, setLogLevel } from '@google/adk';
import type { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import type { FinalModelResponse, Message, ModelAdapter, ModelRequest, ModelResponse, ToolDeclaration } from '../lib/models/contract.ts';
import { ChatCompletionsAdapter, chatUsage, sumUsage, ENGINE_CALL_ID_PREFIX, REASONING_CONTENT_KIND } from '../lib/models/chatCompletionsAdapter.ts';
import type { ChatCompletionsRequest } from '../lib/models/chatCompletionsAdapter.ts';
import { OllamaAdapter } from '../lib/models/ollamaAdapter.ts';
import { KimiAdapter } from '../lib/models/kimiAdapter.ts';
import { GatewayAdapter } from '../lib/models/gatewayAdapter.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { KimiLlm } from '../lib/models/kimiLlm.ts';
import { GatewayLlm } from '../lib/models/gatewayLlm.ts';
import { olderSpellingOf } from '../lib/models/openAiCompatibleLlm.ts';
import { adkShim } from '../lib/models/adkShim.ts';
import { modelResponseToLlmResponse } from '../lib/models/genaiMapping.ts';
import { setRetryPolicyOverrides } from '../lib/models/retry.ts';
import { ERROR_RETRYABLE_KEY, ERROR_STATUS_KEY } from '../lib/models/errorResponse.ts';
import { flushTracing, onSpanEnd, traceLlmGeneration } from '../lib/observability/tracer.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';

setLogLevel(LogLevel.ERROR);

const MOONSHOT_KEY = 'fixture-moonshot-0123456789abcdef'; // gitleaks:allow (test fixture)
const GATEWAY_ENV = { MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'fixture-gateway-0123456789abcdef' }; // gitleaks:allow (test fixture)
const FAST = { baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 50 };

// ── Harness ──────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'MOONSHOT_API_KEY',
  'MOONSHOT_BASE_URL',
  'OLLAMA_BASE_URL',
  'OLLAMA_RETRY_WITHOUT_THINKING',
  'MODEL_GATEWAY',
  'MODEL_GATEWAY_API_KEY',
  'MODEL_GATEWAY_BASE_URL',
  'MODEL_GATEWAY_MODEL_MAP',
];

/** Sets (or, for undefined, clears) env vars for the body, every other key here cleared. */
async function withEnv<T>(env: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    return await body();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

type Reply = () => Response | Promise<Response>;
type Sent = { url: string; headers: Record<string, string>; body: any };

const json = (body: unknown, status = 200): Reply => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sse = (frames: unknown[]): Reply => () =>
  new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
const failing = (code: string): Reply => () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
};

/** A chat completion with one choice. */
const completion = (message: Record<string, unknown>, finish_reason: string | null = 'stop', usage?: unknown) => ({
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }],
  ...(usage ? { usage } : {}),
});

/** Runs `fn` with fetch answering from `replies` (the last repeats) and `env` set; returns what was sent. */
async function withFetch<T>(replies: Reply[], env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<{ sent: Sent[]; result: T }> {
  return withEnv(env, async () => {
    const sent: Sent[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: any) => {
      sent.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(init.body) });
      return replies[Math.min(sent.length - 1, replies.length - 1)]();
    }) as typeof fetch;
    try {
      return { sent, result: await fn() };
    } finally {
      globalThis.fetch = real;
    }
  });
}

async function drain<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

/** Runs `request` through `adapter` against scripted replies; returns what it sent and yielded. */
async function run(
  adapter: () => ModelAdapter,
  request: ChatCompletionsRequest,
  replies: Reply[] = [json(completion({ content: 'An answer.' }))],
  env: Record<string, string | undefined> = {},
): Promise<{ sent: Sent[]; out: ModelResponse[] }> {
  const { sent, result } = await withFetch(replies, env, () => drain(adapter().generate(request)));
  return { sent, out: result };
}

/** An LlmRequest, for the ADK shims. */
const llmRequest = (model: string, config: Record<string, unknown> = {}): LlmRequest =>
  ({ model, contents: [{ role: 'user', parts: [{ text: 'hello' }] }], liveConnectConfig: {}, toolsDict: {}, config }) as unknown as LlmRequest;

/** The one body sent. */
async function bodyOf(adapter: () => ModelAdapter, request: ChatCompletionsRequest, env: Record<string, string | undefined> = {}): Promise<any> {
  const { sent } = await run(adapter, request, undefined, env);
  assert.equal(sent.length, 1);
  return sent[0].body;
}

const final = (out: ModelResponse[]): FinalModelResponse => {
  const last = out.at(-1)!;
  assert.equal(last.partial, false, 'a call ends with its one final');
  assert.equal(out.filter((r) => !r.partial).length, 1, 'exactly one final');
  return last as FinalModelResponse;
};

const thinking = (out: ModelResponse[]) => out.filter((r) => r.partial).flatMap((r) => r.parts.filter((p) => p.type === 'thinking').map((p) => p.text));

const req = (model: string, extra: Partial<ChatCompletionsRequest> = {}): ChatCompletionsRequest => ({
  model,
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
  ...extra,
});

const ollama = (model = 'ollama/qwen3:8b') => () => new OllamaAdapter({ model });
const kimi = (model = 'kimi-k3') => () => new KimiAdapter({ model, apiKey: MOONSHOT_KEY });
const gateway = (model = 'claude-sonnet-4-6') => () => new GatewayAdapter({ model });

/** The llm.request spans for `model` that end while `fn` runs. */
async function spansDuring(model: string, fn: () => Promise<unknown>): Promise<ReadableSpan[]> {
  const spans: ReadableSpan[] = [];
  const off = onSpanEnd((span) => {
    if (span.name === 'llm.request' && span.attributes['llm.model'] === model) spans.push(span);
  });
  try {
    await fn();
    await flushTracing();
  } finally {
    off();
  }
  return spans;
}

/** Runs the adapter inside an llm.request span, as its caller does (ADR 0053), and returns the span. */
async function spanOf(adapter: () => ModelAdapter, request: ChatCompletionsRequest, env: Record<string, string | undefined> = {}): Promise<ReadableSpan> {
  async function* mapped(a: ModelAdapter): AsyncGenerator<LlmResponse, void> {
    for await (const r of a.generate(request)) yield modelResponseToLlmResponse(r);
  }
  const [span] = await spansDuring(request.model, () =>
    withFetch([json(completion({ content: 'An answer.' }))], env, async () => {
      const a = adapter();
      return drain(traceLlmGeneration({ provider: a.provider, model: a.model, request }, mapped(a)));
    }),
  );
  assert.ok(span, 'a span');
  return span;
}

// ── Fixtures in the contract ─────────────────────────────────────────────────

const SCOUT: ToolDeclaration = {
  name: 'Scout',
  description: 'Finds things',
  parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] },
};
const LOAD_MEMORY: ToolDeclaration = {
  name: 'load_memory',
  description: 'Loads the memory for the current user.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'The query to load the memory for.' } }, required: ['query'] },
};
const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' }, score: { type: 'integer' } }, required: ['verdict'] };

const state = (payload: string, model = 'kimi-k3', provider = 'moonshot') => ({ provider, kind: REASONING_CONTENT_KIND, model, payload });

/** Two turns: the first a finished tool loop, the second mid-loop with two steps (kimiReasoningState.test.ts's twoTurns). */
function twoTurns(model: string): ChatCompletionsRequest {
  const messages: Message[] = [
    { role: 'user', parts: [{ type: 'text', text: 'first question' }] },
    { role: 'assistant', parts: [{ type: 'toolCall', id: 'old_1', name: 'Scout', args: {}, providerState: state('old reasoning', model) }] },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'old_1', name: 'Scout', result: 'x' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'first answer', providerState: state('old answer reasoning', model) }] },
    { role: 'user', parts: [{ type: 'text', text: 'second question' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Checking.', providerState: state('step one', model) },
        { type: 'toolCall', id: 'c1', name: 'Scout', args: {} },
      ],
    },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'c1', name: 'Scout', result: 'y' }] },
    { role: 'assistant', parts: [{ type: 'toolCall', id: 'c2', name: 'Scout', args: {}, providerState: state('step two', model) }] },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'c2', name: 'Scout', result: 'z' }] },
  ];
  return { model, messages };
}

const assistants = (body: any): any[] => (body.messages ?? []).filter((m: any) => m.role === 'assistant');

// ── The wire: what the ADK-path tests assert, from ModelRequests ─────────────

test('Ollama: the namespace is stripped, the endpoint is local, and nothing else rides on a plain request', async () => {
  const { sent } = await run(ollama(), req('ollama/qwen3:8b'));
  assert.equal(sent[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.deepEqual(sent[0].body, { model: 'qwen3:8b', messages: [{ role: 'user', content: 'hello' }], stream: false });
  assert.equal(sent[0].headers.Authorization, undefined, 'no auth: local');
});

test('the system prompt, then the system messages in order, as one system message first; sampling as its fields', async () => {
  const body = await bodyOf(
    ollama(),
    req('ollama/qwen3:8b', {
      system: 'Be brief.',
      messages: [
        { role: 'system', parts: [{ type: 'text', text: 'Note A' }] },
        { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      ],
      sampling: { temperature: 0.3, topP: 0.9, maxOutputTokens: 256, stop: ['END'] },
    }),
  );
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Be brief.\n\nNote A' },
    { role: 'user', content: 'hello' },
  ]);
  assert.deepEqual([body.temperature, body.top_p, body.max_tokens, body.stop], [0.3, 0.9, 256, ['END']]);
});

test('Kimi K3: reasoning travels as reasoning_effort in its word, pinned when absent, never a thinking switch', async () => {
  const effort = async (reasoning: ModelRequest['reasoning']) => {
    const body = await bodyOf(kimi('kimi-k3'), req('kimi-k3', reasoning === undefined ? {} : { reasoning }));
    assert.ok(!('thinking' in body));
    return body.reasoning_effort;
  };
  assert.equal(await effort(undefined), 'high', 'the pinned default, below Moonshot max');
  assert.equal(await effort('none'), 'low', 'K3 cannot switch thinking off');
  assert.equal(await effort('low'), 'low');
  assert.equal(await effort('medium'), 'high', 'K3 has low | high | max');
  assert.equal(await effort('high'), 'high');
  assert.equal(await effort({ budget_tokens: 3000 }), 'high', 'a budget rounds up to the level that covers it');
  assert.equal(await effort({ budget_tokens: 0 }), 'low');
});

test('Kimi K2.x: a thinking switch and no reasoning_effort', async () => {
  for (const model of ['kimi-k2.6', 'kimi-k2.7-code']) {
    const on = await bodyOf(kimi(model), req(model, { reasoning: 'low' }));
    assert.ok(!('reasoning_effort' in on) && !('thinking' in on), model);
    assert.deepEqual((await bodyOf(kimi(model), req(model, { reasoning: 'none' }))).thinking, { type: 'disabled' });
    assert.deepEqual((await bodyOf(kimi(model), req(model, { reasoning: { budget_tokens: 0 } }))).thinking, { type: 'disabled' });
    assert.ok(!('thinking' in (await bodyOf(kimi(model), req(model)))), 'thinking stays on by default');
  }
});

test('Ollama and the gateway: reasoning_effort as the word ADR 0047 gives the model', async () => {
  assert.equal((await bodyOf(ollama(), req('ollama/qwen3:8b', { reasoning: 'none' }))).reasoning_effort, 'none');
  assert.ok(!('reasoning_effort' in (await bodyOf(ollama(), req('ollama/qwen3:8b')))), 'nothing when nothing is asked');
  const gw = (model: string, reasoning: ModelRequest['reasoning']) => bodyOf(gateway(model), req(model, { reasoning }), GATEWAY_ENV);
  const claude = await gw('claude-sonnet-4-6', { budget_tokens: 8192 });
  assert.equal(claude.reasoning_effort, 'medium', 'a thinking budget has no chat form; its level travels');
  assert.ok(!('thinking' in claude));
  assert.equal((await gw('gpt-5-mini', 'none')).reasoning_effort, 'minimal', "the first GPT-5 generation's word for none");
  assert.equal((await gw('kimi-k3', 'medium')).reasoning_effort, 'high');
});

test("Kimi: each assistant message of the turn's tool loop gets its own reasoning_content; earlier turns' get none", async () => {
  for (const model of ['kimi-k3', 'kimi-k2.6']) {
    const messages = assistants(await bodyOf(kimi(model), twoTurns(model)));
    assert.deepEqual(
      messages.map((m) => [m.content, m.tool_calls?.[0]?.id ?? null, m.reasoning_content ?? null]),
      [
        [null, 'old_1', null],
        ['first answer', null, null],
        ['Checking.', 'c1', 'step one'],
        [null, 'c2', 'step two'],
      ],
      model,
    );
  }
});

test('kimi-k2.7-code (the live question): earlier turns go without their reasoning_content, the tool loop with it', async () => {
  const body = await bodyOf(kimi('kimi-k2.7-code'), twoTurns('kimi-k2.7-code'));
  assert.equal(body.model, 'kimi-k2.7-code');
  assert.deepEqual(
    assistants(body).map((m) => m.reasoning_content ?? null),
    [null, null, 'step one', 'step two'],
    'preserved thinking across turns is not sent; whether K2.7 Code degrades without it is checked live',
  );
  const wire = JSON.stringify(body);
  assert.ok(!wire.includes('old reasoning') && !wire.includes('old answer reasoning'));
});

test("Kimi skips another provider's or another model's state, and replays a turn with no opening user message whole", async () => {
  const foreign = twoTurns('kimi-k3');
  (foreign.messages[5].parts[0] as any).providerState = state('step one', 'kimi-k3', 'anthropic');
  (foreign.messages[7].parts[0] as any).providerState = state('step two', 'kimi-k2.6');
  assert.ok(assistants(await bodyOf(kimi('kimi-k3'), foreign)).every((m) => m.reasoning_content === undefined));

  const tail = twoTurns('kimi-k3');
  tail.messages = tail.messages.slice(5);
  assert.deepEqual(assistants(await bodyOf(kimi('kimi-k3'), tail)).map((m) => m.reasoning_content ?? null), ['step one', 'step two']);
});

test('Ollama and the gateway (whose provider for kimi-k3 IS moonshot) neither send nor write reasoning_content', async () => {
  const sentOllama = await bodyOf(ollama(), { ...twoTurns('ollama/qwen3:8b'), model: 'ollama/qwen3:8b' });
  assert.ok(!JSON.stringify(sentOllama).includes('reasoning_content'));
  const { sent, out } = await run(gateway('kimi-k3'), twoTurns('kimi-k3'), [json(completion({ content: 'Done.', reasoning_content: 'why' }))], GATEWAY_ENV);
  assert.equal(sent[0].body.model, 'moonshotai/kimi-k3');
  assert.ok(!JSON.stringify(sent[0].body).includes('reasoning_content'));
  assert.ok(final(out).parts.every((p) => p.providerState === undefined));
  assert.deepEqual(thinking(out), ['why'], 'the scratchpad is still displayed');
});

test('Kimi writes the response reasoning_content as providerState on the part it preceded, bound to the model', async () => {
  for (const stream of [false, true]) {
    const reply = stream
      ? sse([
          { choices: [{ index: 0, delta: { reasoning_content: 'Scout knows; ' } }] },
          { choices: [{ index: 0, delta: { reasoning_content: 'ask it.' } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Scout', arguments: '{"request":' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"find it"}' } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ])
      : json(completion({ content: '', reasoning_content: 'Scout knows; ask it.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Scout', arguments: '{"request":"find it"}' } }] }, 'tool_calls'));
    const { out } = await run(kimi('kimi-k3'), req('kimi-k3', { tools: [SCOUT], stream }), [reply]);
    const f = final(out);
    assert.equal(f.finishReason, 'tool_call');
    assert.deepEqual(f.parts, [
      { type: 'toolCall', id: 'call_1', name: 'Scout', args: { request: 'find it' }, providerState: { provider: 'moonshot', kind: REASONING_CONTENT_KIND, model: 'kimi-k3', payload: 'Scout knows; ask it.' } },
    ]);
  }
});

test('only the reasoning_content field is carried: <think> blocks and a `reasoning` field are not', async () => {
  for (const message of [{ content: '<think>scratch</think>It is in the attic.' }, { content: 'It is in the attic.', reasoning: 'scratch' }]) {
    const { out } = await run(kimi('kimi-k3'), twoTurns('kimi-k3'), [json(completion(message))]);
    assert.deepEqual(final(out).parts, [{ type: 'text', text: 'It is in the attic.' }]);
    assert.deepEqual(thinking(out), ['scratch']);
  }
});

test('tools: function tools from the declarations, the schema as written; strict sends the strict form', async () => {
  const body = await bodyOf(ollama(), req('ollama/qwen3:8b', { tools: [SCOUT, LOAD_MEMORY] }));
  assert.deepEqual(body.tools, [
    { type: 'function', function: { name: 'Scout', description: 'Finds things', parameters: SCOUT.parameters } },
    { type: 'function', function: { name: 'load_memory', description: LOAD_MEMORY.description, parameters: LOAD_MEMORY.parameters } },
  ]);
  assert.ok(!('tool_choice' in body), 'auto is the default and is not sent');
  const strict = await bodyOf(gateway(), req('claude-sonnet-4-6', { tools: [{ ...SCOUT, parameters: SCHEMA, strict: true }] }), GATEWAY_ENV);
  assert.deepEqual(strict.tools[0].function, {
    name: 'Scout',
    description: 'Finds things',
    parameters: { ...SCHEMA, required: ['verdict', 'score'], additionalProperties: false },
    strict: true,
  });
});

test('the history: text, tool calls, one tool message per result in the genai envelope, images inline, thinking never', async () => {
  const body = await bodyOf(
    ollama(),
    req('ollama/qwen3:8b', {
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'what is this?' },
            { type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
            { type: 'blob', mimeType: 'image/png', url: 'https://example.com/a.png' },
          ],
        },
        {
          role: 'assistant',
          parts: [
            { type: 'thinking', text: 'scratch' },
            { type: 'text', text: 'Let me look.' },
            { type: 'toolCall', id: 'c1', name: 'Scout', args: { request: 'a' } },
            { type: 'toolCall', id: 'c2', name: 'probe', args: {} },
          ],
        },
        {
          role: 'tool',
          parts: [
            { type: 'toolResult', id: 'c1', name: 'Scout', result: 'found' },
            { type: 'toolResult', id: 'c2', name: 'probe', result: 'boom', isError: true },
          ],
        },
        { role: 'assistant', parts: [{ type: 'toolCall', id: 'c3', name: 'Scout', args: {} }] },
        { role: 'tool', parts: [{ type: 'toolResult', id: 'c3', name: 'Scout', result: { answer: 42 } }] },
      ],
    }),
  );
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
    {
      role: 'assistant',
      content: 'Let me look.',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'Scout', arguments: '{"request":"a"}' } },
        { id: 'c2', type: 'function', function: { name: 'probe', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '{"result":"found"}' },
    { role: 'tool', tool_call_id: 'c2', content: '{"error":"boom"}' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'Scout', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c3', content: '{"answer":42}' },
  ]);
});

test('structured output: strict json_schema on Kimi and the gateway, JSON mode on Ollama', async () => {
  const strict = { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: { ...SCHEMA, required: ['verdict', 'score'], additionalProperties: false } } };
  assert.deepEqual((await bodyOf(kimi(), req('kimi-k3', { outputSchema: SCHEMA }))).response_format, strict);
  assert.deepEqual((await bodyOf(gateway(), req('claude-sonnet-4-6', { outputSchema: SCHEMA }), GATEWAY_ENV)).response_format, strict);
  assert.deepEqual((await bodyOf(ollama(), req('ollama/qwen3:8b', { outputSchema: SCHEMA }))).response_format, { type: 'json_object' });
  assert.ok(!('response_format' in (await bodyOf(kimi(), req('kimi-k3')))));
});

test("JSON mode (outputFormat 'json', ADR 0061): json_object on Ollama, Kimi and the gateway; a schema says more and wins", async () => {
  const jsonMode = { type: 'json_object' };
  assert.deepEqual((await bodyOf(ollama(), req('ollama/qwen3:8b', { outputFormat: 'json' }))).response_format, jsonMode);
  assert.deepEqual((await bodyOf(kimi(), req('kimi-k3', { outputFormat: 'json' }))).response_format, jsonMode);
  assert.deepEqual((await bodyOf(kimi('kimi-k2.6'), req('kimi-k2.6', { outputFormat: 'json' }))).response_format, jsonMode);
  assert.deepEqual((await bodyOf(gateway(), req('claude-sonnet-4-6', { outputFormat: 'json' }), GATEWAY_ENV)).response_format, jsonMode);
  assert.equal((await bodyOf(kimi(), req('kimi-k3', { outputSchema: SCHEMA, outputFormat: 'json' }))).response_format.type, 'json_schema');
});

test('the retry without thinking keeps JSON mode and drops the older spelling\'s effort word', async () => {
  const lost = json(completion({ content: '', reasoning: 'thinking...' }, 'length', { prompt_tokens: 10, completion_tokens: 90, total_tokens: 100 }));
  const answered = json(completion({ content: '{"ok":true}' }));
  const request: ChatCompletionsRequest = { ...req('ollama/qwen3.5:9b', { reasoning: 'low', outputFormat: 'json' }), olderSpelling: { reasoningEffort: 'max' } };
  const { sent } = await run(ollama('ollama/qwen3.5:9b'), request, [lost, answered]);
  assert.deepEqual(sent.map((s) => s.body.response_format), [{ type: 'json_object' }, { type: 'json_object' }]);
  assert.deepEqual(sent.map((s) => s.body.reasoning_effort), ['max', 'none']);
});

test('streaming asks for usage; Kimi posts to Moonshot with a bearer key; the gateway to its base with the mapped id', async () => {
  const { sent } = await run(kimi(), req('kimi-k3', { stream: true }), [sse([{ choices: [{ index: 0, delta: { content: 'hi' } }] }])]);
  assert.equal(sent[0].url, 'https://api.moonshot.ai/v1/chat/completions');
  assert.equal(sent[0].headers.Authorization, `Bearer ${MOONSHOT_KEY}`);
  assert.equal(sent[0].body.stream, true);
  assert.deepEqual(sent[0].body.stream_options, { include_usage: true });

  const gw = await run(gateway(), req('claude-sonnet-4-6'), undefined, { MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'secret-key' });
  assert.equal(gw.sent[0].url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
  assert.equal(gw.sent[0].headers.Authorization, 'Bearer secret-key');
  assert.equal(gw.sent[0].body.model, 'anthropic/claude-sonnet-4.6');
  assert.equal(new GatewayAdapter({ model: 'claude-sonnet-4-6' }).provider, 'anthropic', 'attribution stays with the upstream');
});

test('native tools are dropped on every chat path, marked on the span, never sent', async () => {
  const request = req('ollama/qwen3:8b', { nativeTools: ['web_search', 'x_search'], tools: [SCOUT] });
  const body = await bodyOf(ollama(), request);
  assert.deepEqual(body.tools.map((t: any) => t.function.name), ['Scout']);
  const span = await spanOf(ollama(), request);
  assert.equal(span.attributes['llm.web_search.omitted'], true);
  assert.equal(span.attributes['llm.capability.dropped'], 'web_search,x_search');
  assert.equal(span.attributes['llm.transport'], 'direct');
  const gw = await spanOf(gateway('grok-4.7'), req('grok-4.7', { nativeTools: ['web_search'] }), GATEWAY_ENV);
  assert.equal(gw.attributes['llm.capability.dropped'], 'web_search');
  assert.equal(gw.attributes['llm.transport'], 'gateway:openrouter');
  assert.equal(gw.attributes['llm.provider'], 'xai');
});

// ── Tool choice ──────────────────────────────────────────────────────────────

test("tool choice: none sends no tools; the gateway sends required and a named tool as asked", async () => {
  const none = await bodyOf(gateway(), req('claude-sonnet-4-6', { tools: [SCOUT], toolChoice: 'none' }), GATEWAY_ENV);
  assert.ok(!('tools' in none) && !('tool_choice' in none));
  assert.equal((await bodyOf(gateway(), req('claude-sonnet-4-6', { tools: [SCOUT], toolChoice: 'required' }), GATEWAY_ENV)).tool_choice, 'required');
  assert.deepEqual((await bodyOf(gateway(), req('claude-sonnet-4-6', { tools: [SCOUT], toolChoice: { name: 'Scout' } }), GATEWAY_ENV)).tool_choice, {
    type: 'function',
    function: { name: 'Scout' },
  });
});

test('tool choice: Ollama weakens required and a named tool to auto, and the span says so', async () => {
  for (const [toolChoice, mode] of [['required', 'required'], [{ name: 'Scout' }, 'named']] as const) {
    const request = req('ollama/qwen3:8b', { tools: [SCOUT], toolChoice });
    const body = await bodyOf(ollama(), request);
    assert.ok(!('tool_choice' in body), mode);
    assert.equal(body.tools.length, 1);
    assert.equal((await spanOf(ollama(), request)).attributes['llm.tool_choice.weakened'], mode);
  }
});

/** The body and the span's weakened mark for one Kimi tool choice. */
async function kimiChoice(model: string, toolChoice: ModelRequest['toolChoice'], reasoning?: ModelRequest['reasoning']) {
  const request = req(model, { tools: [SCOUT, LOAD_MEMORY], toolChoice, ...(reasoning !== undefined ? { reasoning } : {}) });
  const body = await bodyOf(kimi(model), request);
  assert.equal(body.tools.length, 2, `${model}: the tools are sent whatever the choice`);
  return { body, weakened: (await spanOf(kimi(model), request)).attributes['llm.tool_choice.weakened'] };
}

const NAMED = { type: 'function', function: { name: 'Scout' } };

test('tool choice, kimi-k3 (live, 2026-10-08): required as asked; a named tool, refused while thinking, goes as required', async () => {
  const required = await kimiChoice('kimi-k3', 'required');
  assert.equal(required.body.tool_choice, 'required');
  assert.equal(required.body.reasoning_effort, 'high', 'K3 thinks while forced');
  assert.equal(required.weakened, undefined);
  // K3 always thinks, so `none` does not switch it off: the named choice is still refused.
  for (const reasoning of [undefined, 'none'] as const) {
    const named = await kimiChoice('kimi-k3', { name: 'Scout' }, reasoning);
    assert.equal(named.body.tool_choice, 'required', String(reasoning));
    assert.equal(named.weakened, 'named', String(reasoning));
  }
});

test('tool choice, kimi-k2.6 (live, 2026-10-08): forced only with thinking off; otherwise auto', async () => {
  for (const reasoning of ['none', { budget_tokens: 0 }] as const) {
    const required = await kimiChoice('kimi-k2.6', 'required', reasoning);
    assert.equal(required.body.tool_choice, 'required');
    assert.deepEqual(required.body.thinking, { type: 'disabled' });
    assert.equal(required.weakened, undefined);
    const named = await kimiChoice('kimi-k2.6', { name: 'Scout' }, reasoning);
    assert.deepEqual(named.body.tool_choice, NAMED);
    assert.deepEqual(named.body.thinking, { type: 'disabled' });
    assert.equal(named.weakened, undefined);
  }
  for (const reasoning of [undefined, 'low', 'high'] as const) {
    for (const [toolChoice, mode] of [['required', 'required'], [{ name: 'Scout' }, 'named']] as const) {
      const c = await kimiChoice('kimi-k2.6', toolChoice, reasoning);
      assert.ok(!('tool_choice' in c.body), `${String(reasoning)} ${mode}`);
      assert.ok(!('thinking' in c.body), 'thinking on');
      assert.equal(c.weakened, mode);
    }
  }
});

test('tool choice, other Kimi ids: required and a named tool weaken to auto, thinking or not', async () => {
  for (const model of ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed']) {
    for (const reasoning of [undefined, 'none'] as const) {
      for (const [toolChoice, mode] of [['required', 'required'], [{ name: 'Scout' }, 'named']] as const) {
        const c = await kimiChoice(model, toolChoice, reasoning);
        assert.ok(!('tool_choice' in c.body), `${model} ${mode}`);
        assert.equal(c.weakened, mode);
      }
    }
  }
});

// ── The response ─────────────────────────────────────────────────────────────

test('the think-block splitter, JSON: the scratchpad is one thinking partial, the reply the final', async () => {
  const { out } = await run(ollama(), req('ollama/qwen3:8b'), [json(completion({ content: '<think>pondering</think>An answer.' }))]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { partial: true, parts: [{ type: 'thinking', text: 'pondering' }] });
  assert.deepEqual(final(out), { partial: false, parts: [{ type: 'text', text: 'An answer.' }], finishReason: 'stop' });
});

test('the think-block splitter, SSE: tags split across deltas stay scratchpad, and the final repeats the whole reply', async () => {
  const { out } = await run(ollama(), req('ollama/qwen3:8b', { stream: true }), [
    sse([
      { choices: [{ index: 0, delta: { content: '<thi' } }] },
      { choices: [{ index: 0, delta: { content: 'nk>weigh' } }] },
      { choices: [{ index: 0, delta: { content: 'ing</thi' } }] },
      { choices: [{ index: 0, delta: { content: 'nk>\n\nHello' } }] },
      { choices: [{ index: 0, delta: { content: ' world' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 136, total_tokens: 156 } },
    ]),
  ]);
  assert.deepEqual(thinking(out).join(''), 'weighing');
  const text = out.filter((r) => r.partial).flatMap((r) => r.parts.filter((p) => p.type === 'text').map((p) => p.text));
  assert.deepEqual(text, ['Hello', ' world'], 'the blank lines after the scratchpad are trimmed from the first text only');
  const f = final(out);
  assert.deepEqual(f.parts, [{ type: 'text', text: 'Hello world' }]);
  assert.deepEqual(f.usage, { inputTokens: 20, outputTokens: 136 });
});

test('the think-block splitter: an unclosed <think> stays scratchpad, and the call is a named error, never the scratchpad as reply', async () => {
  for (const stream of [false, true]) {
    const reply = stream
      ? sse([{ choices: [{ index: 0, delta: { content: '<think>weighing' } }] }, { choices: [{ index: 0, delta: { content: ' it all' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }])
      : json(completion({ content: '<think>weighing it all' }, 'length'));
    const { out } = await run(ollama('ollama/qwen3.5:9b'), req('ollama/qwen3.5:9b', { stream, reasoning: 'none' }), [reply]);
    assert.ok(!out.some((r) => r.parts.some((p) => p.type === 'text' && /think|weighing/.test(p.text))), 'scratchpad text never reaches the reply');
    assert.equal(final(out).error?.code, 'OLLAMA_MAX_TOKENS');
  }
});

test('the retry without thinking: a reply lost to thinking is asked once more with reasoning none, both attempts counted', async () => {
  const lost = json(completion({ content: '', reasoning: 'P1: 79 words. Too high.' }, 'length', { prompt_tokens: 318, completion_tokens: 3778, total_tokens: 4096 }));
  const answered = json(completion({ content: 'Quantum mechanics is...' }, 'stop', { prompt_tokens: 318, completion_tokens: 40, total_tokens: 358, completion_tokens_details: { reasoning_tokens: 0 } }));
  const { sent, out } = await run(ollama('ollama/qwen3.5:9b'), req('ollama/qwen3.5:9b', { reasoning: 'low' }), [lost, answered]);
  assert.deepEqual(sent.map((s) => s.body.reasoning_effort), ['low', 'none']);
  const f = final(out);
  assert.equal(f.error, undefined, 'the first error is held back');
  assert.deepEqual(f.parts, [{ type: 'text', text: 'Quantum mechanics is...' }]);
  assert.deepEqual(f.usage, { inputTokens: 636, outputTokens: 3818, thinkingTokens: 0 }, 'one call, one usage: the attempts summed');
  assert.deepEqual(thinking(out), ['P1: 79 words. Too high.'], 'the first attempt still showed its scratchpad');
});

test('the retry without thinking: lost twice is the named error, with both attempts\' usage and the reasoning: hint', async () => {
  for (const stream of [false, true]) {
    const lost = stream
      ? sse([{ choices: [{ index: 0, delta: { reasoning: 'P1: 79 words. ' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }, { choices: [], usage: { prompt_tokens: 318, completion_tokens: 3778, total_tokens: 4096 } }])
      : json(completion({ content: '', reasoning: 'P1: 79 words.' }, 'length', { prompt_tokens: 318, completion_tokens: 3778, total_tokens: 4096 }));
    const { sent, out } = await run(ollama('ollama/qwen3.5:9b'), req('ollama/qwen3.5:9b', { stream }), [lost]);
    assert.deepEqual(sent.map((s) => s.body.reasoning_effort), [undefined, 'none']);
    const f = final(out);
    assert.equal(f.error?.code, 'OLLAMA_MAX_TOKENS');
    assert.equal(f.error?.retryable, false);
    assert.equal(f.finishReason, 'max_tokens');
    assert.match(f.error!.message, /context window/);
    assert.match(f.error!.message, /reasoning: none/, 'the hint names the contract field');
    assert.deepEqual(f.usage, { inputTokens: 636, outputTokens: 7556 });
  }
});

test('the retry without thinking: never for a request that already asks for none, when switched off, or on the gateway', async () => {
  const lost = json(completion({ content: '', reasoning: 'think' }, 'length'));
  const calls = async (adapter: () => ModelAdapter, request: ChatCompletionsRequest, env: Record<string, string | undefined> = {}) =>
    (await run(adapter, request, [lost], env)).sent.length;
  assert.equal(await calls(ollama(), req('ollama/qwen3:8b', { reasoning: 'none' })), 1);
  assert.equal(await calls(ollama(), req('ollama/qwen3:8b', { reasoning: { budget_tokens: 0 } })), 1);
  assert.equal(await calls(ollama(), req('ollama/qwen3:8b'), { OLLAMA_RETRY_WITHOUT_THINKING: 'false' }), 1);
  assert.equal(await calls(gateway(), req('claude-sonnet-4-6'), GATEWAY_ENV), 1);
  const { out } = await run(gateway(), req('claude-sonnet-4-6'), [lost], GATEWAY_ENV);
  assert.equal(final(out).error?.code, 'ANTHROPIC_MAX_TOKENS', 'the gateway names the upstream provider');
  assert.match(final(out).error!.message, /reasoning: setting/);
});

test('thinking that stops with no reply is EMPTY_RESPONSE; a bare empty final is no error; a cut reply keeps its text', async () => {
  const one = async (message: Record<string, unknown>, finish: string) => final((await run(ollama(), req('ollama/qwen3:8b', { reasoning: 'none' }), [json(completion(message, finish))])).out);
  const empty = await one({ content: '<think>nothing to add</think>' }, 'stop');
  assert.equal(empty.error?.code, 'OLLAMA_EMPTY_RESPONSE');
  assert.equal(empty.finishReason, 'stop', 'the model stopped on its own');
  assert.deepEqual(await one({ content: '' }, 'stop'), { partial: false, parts: [], finishReason: 'stop' });
  const cut = await one({ content: 'Quantum mechanics is', reasoning: 'brief' }, 'length');
  assert.equal(cut.error, undefined);
  assert.equal(cut.finishReason, 'max_tokens');
  assert.deepEqual(cut.parts, [{ type: 'text', text: 'Quantum mechanics is' }]);
  assert.equal((await one({ content: 'withheld' }, 'content_filter')).finishReason, 'content_filter');
});

test('tool calls: arguments parsed, kept raw when they do not parse, and an id made when the provider gives none', async () => {
  const request = req('ollama/qwen3:8b', { tools: [SCOUT] });
  const { out } = await run(ollama(), request, [
    json(completion({ content: null, tool_calls: [
      { id: 'call_9', type: 'function', function: { name: 'Scout', arguments: '{"request":"go"}' } },
      { type: 'function', function: { name: 'probe', arguments: 'not json' } },
    ] }, 'tool_calls')),
  ]);
  assert.deepEqual(final(out).parts, [
    { type: 'toolCall', id: 'call_9', name: 'Scout', args: { request: 'go' } },
    { type: 'toolCall', id: `${ENGINE_CALL_ID_PREFIX}1-1-probe`, name: 'probe', args: { raw: 'not json' } },
  ]);
});

test('SSE: tool-call arguments split across frames are reassembled, in index order', async () => {
  const { out } = await run(ollama(), req('ollama/qwen3:8b', { stream: true, tools: [SCOUT] }), [
    sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'Scout', arguments: '{}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"zeno"}' } }] } }] },
    ]),
  ]);
  assert.deepEqual(final(out).parts, [
    { type: 'toolCall', id: 'c1', name: 'lookup', args: { q: 'zeno' } },
    { type: 'toolCall', id: 'c2', name: 'Scout', args: {} },
  ]);
  assert.equal(final(out).finishReason, 'tool_call');
});

// ── Usage in the contract's meaning, and the ledger's counts ─────────────────

test("usage in the contract's meaning: completion_tokens counts the reasoning, which reasoning_tokens breaks out", () => {
  assert.deepEqual(
    chatUsage({ prompt_tokens: 12, completion_tokens: 40, total_tokens: 52, completion_tokens_details: { reasoning_tokens: 25 }, prompt_tokens_details: { cached_tokens: 8 } }),
    { inputTokens: 12, outputTokens: 40, thinkingTokens: 25, cacheReadTokens: 8 },
  );
  assert.deepEqual(chatUsage({ prompt_tokens: 3, completion_tokens: 1 }), { inputTokens: 3, outputTokens: 1 });
  assert.equal(chatUsage(undefined), undefined);
  assert.equal(chatUsage({ total_tokens: 9 }), undefined);
  assert.deepEqual(sumUsage({ inputTokens: 1, outputTokens: 2, thinkingTokens: 1 }, { inputTokens: 3, outputTokens: 4, cacheReadTokens: 2 }), {
    inputTokens: 4,
    outputTokens: 6,
    thinkingTokens: 1,
    cacheReadTokens: 2,
  });
});

const REASONED = json(completion({ content: 'An answer.', reasoning_content: 'pondering' }, 'stop', {
  prompt_tokens: 12,
  completion_tokens: 40,
  total_tokens: 52,
  completion_tokens_details: { reasoning_tokens: 25 },
}));

test("the ledger's counts are unchanged through the chat shims: llm.tokens.output and the turn's charge include the reasoning", async () => {
  const charged = async (llm: BaseLlm, model: string) => {
    const control = createTurnControl({ maxLlmCalls: 5 });
    let out: LlmResponse[] = [];
    const [span] = await spansDuring(model, async () => {
      out = (await withFetch([REASONED], {}, () => runWithTurnControl(control, () => drain(llm.generateContentAsync(llmRequest(model)))))).result;
    });
    control.dispose();
    return { span, out, tokens: [control.inputTokens, control.outputTokens, control.thinkingTokens] };
  };

  const viaKimiLlm = await charged(new KimiLlm({ model: 'kimi-k3', apiKey: MOONSHOT_KEY }), 'kimi-k3');
  assert.deepEqual(viaKimiLlm.out.at(-1)!.usageMetadata, { promptTokenCount: 12, candidatesTokenCount: 40, thoughtsTokenCount: 25, totalTokenCount: 52 });
  assert.deepEqual(
    [viaKimiLlm.span.attributes['llm.tokens.input'], viaKimiLlm.span.attributes['llm.tokens.output'], viaKimiLlm.span.attributes['llm.tokens.thinking']],
    [12, 40, 25],
    'completion_tokens, as the chat-completions adapters have always reported it',
  );
  assert.deepEqual(viaKimiLlm.tokens, [12, 40, 25]);

  // The plain shim writes Gemini's meaning (output less thinking); the chat shims keep theirs (ADR 0057).
  const viaPlainShim = await charged(adkShim(new KimiAdapter({ model: 'kimi-k2.6', apiKey: MOONSHOT_KEY })), 'kimi-k2.6');
  assert.equal(viaPlainShim.span.attributes['llm.tokens.output'], 15);
});

// ── Failures are finals, with the retry verdict ──────────────────────────────

test('a missing key or gateway is a final before any request, never retryable', async () => {
  const noKey = await run(() => new KimiAdapter({ model: 'kimi-k3' }), req('kimi-k3'));
  assert.equal(noKey.sent.length, 0);
  assert.deepEqual(final(noKey.out), {
    partial: false,
    parts: [],
    finishReason: 'error',
    error: { code: 'MOONSHOT_MISSING_KEY', message: 'MOONSHOT_API_KEY is not set in environment.', retryable: false },
  });
  assert.equal(final((await run(gateway('gpt-5-mini'), req('gpt-5-mini'), undefined, { MODEL_GATEWAY: 'vercel' })).out).error?.code, 'GATEWAY_KEY_MISSING');
  assert.equal(final((await run(gateway('gpt-5-mini'), req('gpt-5-mini'))).out).error?.code, 'GATEWAY_NOT_CONFIGURED');
});

test('HTTP failures keep their codes and wording, with the status and the retry verdict', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    const busy = await run(ollama(), req('ollama/qwen3:8b'), [json({ error: 'busy' }, 503)]);
    assert.equal(busy.sent.length, 3, 'the adapter spent its retries first');
    assert.deepEqual(final(busy.out).error, {
      code: 'OLLAMA_HTTP_ERROR',
      message: 'Ollama returned 503: {"error":"busy"}. Is the model pulled? Try: ollama pull qwen3:8b',
      retryable: true,
      status: 503,
    });
    const bad = await run(kimi(), req('kimi-k3'), [json({ error: 'no' }, 404)]);
    assert.equal(bad.sent.length, 1);
    assert.equal(final(bad.out).error?.code, 'MOONSHOT_HTTP_ERROR');
    assert.equal(final(bad.out).error?.retryable, false);
    assert.match(final(bad.out).error!.message, /Is "kimi-k3" a current Kimi id\?/);
    const gw = await run(gateway(), req('claude-sonnet-4-6'), [json({ error: 'slow down' }, 429), json({ error: 'no such model' }, 404)], GATEWAY_ENV);
    assert.deepEqual([gw.sent.length, final(gw.out).error?.code, final(gw.out).error?.status, final(gw.out).error?.retryable], [2, 'GATEWAY_HTTP_ERROR', 404, false]);
  } finally {
    restore();
  }
});

test('an unreachable endpoint: a reset is retryable, a refused connection is not, and a key never reaches the message', async () => {
  const restore = setRetryPolicyOverrides(FAST);
  try {
    for (const [code, retryable] of [['ECONNRESET', true], ['ECONNREFUSED', false]] as const) {
      const f = final((await run(ollama(), req('ollama/qwen3:8b'), [failing(code)])).out);
      assert.equal(f.error?.code, 'OLLAMA_UNREACHABLE', code);
      assert.equal(f.error?.retryable, retryable, code);
      assert.match(f.error!.message, /Could not reach Ollama/);
    }
    const leaky = () => {
      throw new Error(`proxy said: invalid key ${MOONSHOT_KEY.replace('fixture', 'sk')}`);
    };
    const f = final((await run(kimi(), req('kimi-k3'), [leaky])).out);
    assert.equal(f.error?.code, 'MOONSHOT_UNREACHABLE');
    assert.ok(!f.error!.message.includes('0123456789abcdef'), f.error!.message);
  } finally {
    restore();
  }
});

test('an abort ends the call at once, with the ordinary failure code, never retryable', async () => {
  // Before the request: nothing is sent.
  const aborted = new AbortController();
  aborted.abort();
  const before = await run(ollama(), req('ollama/qwen3:8b', { signal: aborted.signal }));
  assert.equal(before.sent.length, 0);
  assert.deepEqual([final(before.out).error?.code, final(before.out).error?.retryable], ['OLLAMA_UNREACHABLE', false]);

  // Mid-stream: a stream that never ends is cut off.
  const ctl = new AbortController();
  const hung: Reply = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hel' } }] })}\n\n`));
        },
      }),
      { status: 200 },
    );
  setTimeout(() => ctl.abort(), 20);
  const during = await run(kimi(), req('kimi-k3', { stream: true, signal: ctl.signal }), [hung]);
  assert.deepEqual(during.out[0], { partial: true, parts: [{ type: 'text', text: 'Hel' }] });
  assert.deepEqual([final(during.out).error?.code, final(during.out).error?.retryable], ['MOONSHOT_UNREACHABLE', false]);

  // During the retry wait: the last status is reported, and a canceled call is not retryable.
  const restore = setRetryPolicyOverrides({ ...FAST, baseDelayMs: 10_000, maxDelayMs: 10_000 });
  try {
    const wait = new AbortController();
    setTimeout(() => wait.abort(), 20);
    const f = final((await run(ollama(), req('ollama/qwen3:8b', { signal: wait.signal }), [json({ error: 'busy' }, 503)])).out);
    assert.deepEqual([f.error?.status, f.error?.retryable], [503, false]);
  } finally {
    restore();
  }
});

test('the turn signal stops a call that carries no signal of its own', async () => {
  const control = createTurnControl();
  control.stop('canceled');
  const { sent, out } = await runWithTurnControl(control, () => run(ollama(), req('ollama/qwen3:8b')));
  control.dispose();
  assert.equal(sent.length, 0);
  assert.equal(final(out).error?.retryable, false);
});

// ── The ADK shims: the older spelling, and the shape ADK has always seen ─────

test('olderSpellingOf: only what the contract leaves out', () => {
  assert.equal(olderSpellingOf(undefined), undefined);
  assert.equal(olderSpellingOf({ reasoningEffort: 'low' } as any), undefined, 'a level rides in reasoning');
  assert.equal(olderSpellingOf({ reasoningEffort: 'minimal' } as any), undefined, 'minimal is none');
  assert.deepEqual(olderSpellingOf({ reasoningEffort: 'max' } as any), { reasoningEffort: 'max' });
  assert.equal(olderSpellingOf({ responseMimeType: 'application/json' }), undefined, 'JSON mode rides in outputFormat (ADR 0061)');
  assert.equal(olderSpellingOf({ responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } } as any), undefined, 'a schema rides in outputSchema');
});

test('through the shims, the older spelling reaches the wire: K3 max; and JSON mode without a schema, through the contract', async () => {
  const bodyVia = async (make: () => BaseLlm, request: LlmRequest, env: Record<string, string | undefined> = {}) =>
    (await withFetch([json(completion({ content: 'ok' }))], env, () => drain(make().generateContentAsync(request)))).sent[0].body;
  assert.equal((await bodyVia(() => new KimiLlm({ model: 'kimi-k3', apiKey: MOONSHOT_KEY }), llmRequest('kimi-k3', { reasoningEffort: 'max' }))).reasoning_effort, 'max');
  assert.ok(!('reasoning_effort' in (await bodyVia(() => new KimiLlm({ model: 'kimi-k2.6', apiKey: MOONSHOT_KEY }), llmRequest('kimi-k2.6', { reasoningEffort: 'max' })))));
  assert.deepEqual((await bodyVia(() => new OllamaLlm({ model: 'ollama/qwen3:8b' }), llmRequest('ollama/qwen3:8b', { responseMimeType: 'application/json' }))).response_format, { type: 'json_object' });
  assert.deepEqual((await bodyVia(() => new KimiLlm({ model: 'kimi-k3', apiKey: MOONSHOT_KEY }), llmRequest('kimi-k3', { responseMimeType: 'application/json' }))).response_format, { type: 'json_object' });
  assert.deepEqual((await bodyVia(() => new GatewayLlm({ model: 'gpt-5.4' }), llmRequest('gpt-5.4', { responseMimeType: 'application/json' }), GATEWAY_ENV)).response_format, { type: 'json_object' });
  assert.equal((await bodyVia(() => new GatewayLlm({ model: 'gpt-5.4' }), llmRequest('gpt-5.4', { reasoningEffort: 'xhigh' }), GATEWAY_ENV)).reasoning_effort, 'xhigh');
  // A level rides in the contract's reasoning, mapped as the compiler maps it.
  assert.equal((await bodyVia(() => new KimiLlm({ model: 'kimi-k3', apiKey: MOONSHOT_KEY }), llmRequest('kimi-k3', { reasoningEffort: 'medium' }))).reasoning_effort, 'high');
});

test('through the shims, the final keeps the shape ADK has always seen from these classes', async () => {
  const finalVia = async (reply: Reply) =>
    (await withFetch([reply], {}, () => drain(new OllamaLlm({ model: 'ollama/qwen3:8b' }).generateContentAsync(llmRequest('ollama/qwen3:8b'))))).result.at(-1)!;
  const restore = setRetryPolicyOverrides(FAST);
  try {
    assert.deepEqual(await finalVia(json(completion({ content: 'Done.' }, 'stop', { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }))), {
      content: { role: 'model', parts: [{ text: 'Done.' }] },
      turnComplete: true,
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
    });
    assert.deepEqual(await finalVia(json(completion({ content: '' }))), { content: { role: 'model', parts: [] }, turnComplete: true });
    const http = await finalVia(json({ error: 'busy' }, 503));
    assert.deepEqual([http.errorCode, (http as any).status, (http as any).retryable], ['OLLAMA_HTTP_ERROR', 503, true]);
    assert.deepEqual(http.customMetadata, { [ERROR_RETRYABLE_KEY]: true, [ERROR_STATUS_KEY]: 503 });
    assert.equal(http.finishReason, undefined);
  } finally {
    restore();
  }
});

test('the adapters are ModelAdapters with the provider telemetry attributes the call to', () => {
  const adapters: ChatCompletionsAdapter[] = [
    new OllamaAdapter({ model: 'ollama/qwen3:8b' }),
    new KimiAdapter({ model: 'kimi-k3' }),
    new GatewayAdapter({ model: 'gemini-3.8-flash' }),
  ];
  assert.deepEqual(adapters.map((a) => [a.provider, a.model]), [['ollama', 'ollama/qwen3:8b'], ['moonshot', 'kimi-k3'], ['gemini', 'gemini-3.8-flash']]);
  assert.equal(new KimiLlm({ model: 'kimi-k3' }).adapter instanceof KimiAdapter, true, 'the shim wraps the adapter');
});
