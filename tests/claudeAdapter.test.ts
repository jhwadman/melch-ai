/**
 * tests/claudeAdapter.test.ts — Claude on the engine's own model contract
 * (lib/models/claudeAdapter.ts, WS1-4, ADR 0055): the adapter reads a
 * ModelRequest and yields ModelResponses, traced and mapped as the native
 * model step traces and stores them.
 *
 * Offline: globalThis.fetch is replaced by a stub that records the URL,
 * headers and body the real Anthropic SDK sends, and answers in the Messages
 * API's own shape (a 400 unless a test scripts a reply or a stream), so no
 * provider is called. The key is a fixture.
 *
 * What is proved here:
 *   - the request-body assertions of tests/claudeCurrentApi.test.ts,
 *     tests/claudeVision.test.ts and tests/reasoningState.test.ts hold for
 *     ModelRequest inputs;
 *   - what the contract adds: tool choice and its weakening, strict tools,
 *     native tools it drops, tool results as the session stores them;
 *   - the responses: partials and one final, signed blocks on the part they
 *     preceded, usage, finish reasons, grounding, and every failure as a
 *     final, never a throw;
 *   - the contract's reasoning as each generation reads it, and the two
 *     readings of it (claudeReasoningOf, claudeReasoningFromConfig) agreeing.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeAdapter, STRUCTURED_OUTPUT_TOOL, THINKING_STATE_KIND, anthropicTools } from '../lib/models/claudeAdapter.ts';
import { THINKING_BINDING_BETA, claudeReasoningFromConfig, claudeReasoningOf } from '../lib/models/claudeModels.ts';
import type {
  FinalModelResponse,
  Message,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ProviderState,
  ReasoningSetting,
  ToolDeclaration,
} from '../lib/models/contract.ts';
import { ERROR_RETRYABLE_KEY, ERROR_STATUS_KEY } from '../lib/models/errorResponse.ts';
import { modelResponseToLlmResponse } from '../lib/models/genaiMapping.ts';
import type { LlmResponse } from '../lib/models/genaiMapping.ts';
import { reasoningConfig } from '../lib/compile.ts';
import { onSpanEnd, traceLlmGeneration } from '../lib/observability/tracer.ts';

const FIXTURE_KEY = 'fixture-ant-test-0123456789abcdef'; // gitleaks:allow (test fixture)
const ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_PLATFORM', 'ANTHROPIC_BASE_URL', 'AWS_REGION', 'ANTHROPIC_MODEL_MAP'];
const BUDGET_ERA = ['claude-sonnet-4-6', 'claude-haiku-4-5'];
const ADAPTIVE_ERA = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];

const DROP_BLOCK = { prefix_mismatch_behavior: 'drop_block' };
const ADAPTIVE_THINKING = { type: 'adaptive', display: 'summarized', block_binding: DROP_BLOCK };
const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };

const hello: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }];

function modelRequest(model: string, extra: Partial<ModelRequest> = {}): ModelRequest {
  return { model, messages: hello, ...extra };
}

interface Captured {
  url: string;
  headers: Headers;
  body: any;
  /** Every fetch the SDK made. */
  calls: number;
  /** What the adapter yielded. */
  out: ModelResponse[];
  /** What the model step stores: each response mapped (modelResponseToLlmResponse). */
  llm: LlmResponse[];
  warnings: string[];
  span: Record<string, unknown>;
}

/** Runs an adapter on `request` inside the llm.request span, as the model step does (ADR 0053), yielding each response mapped. */
function traced(adapter: ModelAdapter, request: ModelRequest): AsyncGenerator<LlmResponse, void> {
  async function* mapped(): AsyncGenerator<LlmResponse, void> {
    for await (const r of adapter.generate(request)) yield modelResponseToLlmResponse(r);
  }
  return traceLlmGeneration({ provider: adapter.provider, model: request.model, request }, mapped());
}

/** Records what an adapter yields while passing it on. */
function recording(adapter: ModelAdapter, out: ModelResponse[]): ModelAdapter {
  return {
    provider: adapter.provider,
    model: adapter.model,
    async *generate(request) {
      for await (const response of adapter.generate(request)) {
        out.push(response);
        yield response;
      }
    },
  };
}

type Reply = Record<string, unknown> | { sse: string } | { status: number; type: string } | ((n: number, init: any) => Response | Promise<Response>);

function respond(reply: Reply | undefined, model: string, n: number, init: any): Response | Promise<Response> {
  if (typeof reply === 'function') return reply(n, init);
  if (reply && 'sse' in reply) return new Response(reply.sse as string, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  if (reply && 'status' in reply && typeof reply.status === 'number') {
    return new Response(JSON.stringify({ type: 'error', error: { type: reply.type, message: `status ${reply.status}` } }), {
      status: reply.status,
      headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
    });
  }
  if (reply) {
    return new Response(
      JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 }, ...reply }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'captured' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Runs `run` with only a fixture key in the environment and a fetch stub
 * that records the first request and answers from `reply`.
 */
async function withStub<T>(reply: Reply | undefined, model: string, run: (seen: () => { url: string; headers: Headers; body: any; calls: number } | undefined) => Promise<T>, env: Record<string, string> = { ANTHROPIC_API_KEY: FIXTURE_KEY }): Promise<T> {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  let seen: { url: string; headers: Headers; body: any; calls: number } | undefined;
  let calls = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    calls++;
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    if (!seen && typeof raw === 'string') {
      seen = { url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers), body: JSON.parse(raw), calls: 0 };
    }
    if (init?.signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    return respond(reply, model, calls, init);
  }) as any;
  try {
    return await run(() => (seen ? { ...seen, calls } : undefined));
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Sends one ModelRequest through a ClaudeAdapter, inside the llm.request span; records the request and the responses. */
async function capture(request: ModelRequest, opts: { reply?: Reply; adapter?: ClaudeAdapter; env?: Record<string, string> } = {}): Promise<Captured> {
  const warnings: string[] = [];
  const spans: Record<string, unknown>[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  const off = onSpanEnd((span) => {
    if (span.name === 'llm.request') spans.push({ ...span.attributes });
  });
  const out: ModelResponse[] = [];
  const llm: LlmResponse[] = [];
  try {
    return await withStub(
      opts.reply,
      request.model,
      async (seen) => {
        const adapter = opts.adapter ?? new ClaudeAdapter({ model: request.model });
        for await (const r of traced(recording(adapter, out), request)) llm.push(r);
        const s = seen();
        return { url: s?.url ?? '', headers: s?.headers ?? new Headers(), body: s?.body, calls: s?.calls ?? 0, out, llm, warnings, span: spans.at(-1) ?? {} };
      },
      opts.env,
    );
  } finally {
    off();
    console.warn = originalWarn;
  }
}

const betas = (c: Captured) => (c.headers.get('anthropic-beta') ?? '').split(',').filter(Boolean);
const finalOf = (c: Captured) => c.out.at(-1) as FinalModelResponse;

// ── Reasoning, by generation (claudeCurrentApi's assertions) ─────────────────

test('budget era: `medium` is a thinking budget, with no effort, display or beta', async () => {
  for (const model of BUDGET_ERA) {
    const c = await capture(modelRequest(model, { reasoning: 'medium' }));
    assert.deepEqual(c.body.thinking, { type: 'enabled', budget_tokens: 8192 }, model);
    assert.equal(c.body.max_tokens, 8192 + 2048, model);
    assert.equal(c.body.output_config, undefined, model);
    assert.ok(!betas(c).includes(THINKING_BINDING_BETA), model);
    assert.ok(!c.url.includes('beta=true'), model);
  }
});

test('adaptive era: a level is adaptive thinking at that effort, summarized, under drop_block', async () => {
  for (const model of ADAPTIVE_ERA) {
    const c = await capture(modelRequest(model, { reasoning: 'medium' }));
    assert.deepEqual(c.body.thinking, ADAPTIVE_THINKING, model);
    assert.deepEqual(c.body.output_config, { effort: 'medium' }, model);
    assert.equal(c.body.max_tokens, 8192 + 2048, model);
    assert.deepEqual(betas(c), [THINKING_BINDING_BETA], model);
    assert.ok(c.url.includes('/v1/messages?beta=true'), model);
    assert.ok(!('betas' in c.body), `${model}: the SDK turns betas into the header`);
  }
  const high = await capture(modelRequest('claude-opus-5-5', { reasoning: 'high' }));
  assert.deepEqual([high.body.output_config.effort, high.body.max_tokens], ['high', 16384 + 2048]);
  const budget = await capture(modelRequest('claude-opus-5-5', { reasoning: { budget_tokens: 5000 } }));
  assert.deepEqual([budget.body.output_config.effort, budget.body.max_tokens], ['medium', 5000 + 2048]);
});

test('`none` is each model\'s off switch at low effort, or low effort where it has none', async () => {
  for (const model of BUDGET_ERA) {
    const c = await capture(modelRequest(model, { reasoning: 'none' }));
    assert.ok(!('thinking' in c.body) && !('output_config' in c.body), model);
  }
  for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
    const c = await capture(modelRequest(model, { reasoning: 'none' }));
    assert.deepEqual(c.body.thinking, ADAPTIVE_THINKING, model);
    assert.deepEqual(c.body.output_config, { effort: 'low' }, model);
  }
  const sonnet = await capture(modelRequest('claude-sonnet-5-5', { reasoning: 'none' }));
  assert.deepEqual(sonnet.body.thinking, { type: 'between_tools' });
  assert.deepEqual(sonnet.body.output_config, { effort: 'low' });
  assert.deepEqual(betas(sonnet), []);
  const expected: Record<string, unknown> = {
    'claude-opus-4-7': { type: 'disabled' },
    'claude-opus-4-8': { type: 'disabled' },
    'claude-sonnet-5': { type: 'disabled' },
    'claude-haiku-5-5': { type: 'disabled' },
    'claude-opus-5': { type: 'adaptive', display: 'summarized' },
    'claude-fable-5': { type: 'adaptive', display: 'summarized' },
  };
  for (const [model, thinking] of Object.entries(expected)) {
    const c = await capture(modelRequest(model, { reasoning: { budget_tokens: 0 } }));
    assert.deepEqual(c.body.thinking, thinking, model);
    assert.deepEqual(c.body.output_config, { effort: 'low' }, model);
    assert.deepEqual(betas(c), [], `${model}: no block_binding with thinking off, or on a model that does not bind`);
  }
});

test('no reasoning set: the model\'s own default, made readable where it thinks', async () => {
  const quiet = await capture(modelRequest('claude-sonnet-4-6'));
  assert.ok(!('thinking' in quiet.body));
  const opus47 = await capture(modelRequest('claude-opus-4-7'));
  assert.ok(!('thinking' in opus47.body) && !('output_config' in opus47.body));
  for (const model of ADAPTIVE_ERA) {
    const c = await capture(modelRequest(model));
    assert.deepEqual(c.body.thinking, ADAPTIVE_THINKING, model);
    assert.equal(c.body.output_config, undefined, model);
    assert.equal(c.body.max_tokens, 16384 + 2048, model);
  }
});

test('no sampling parameter is sent on any generation; maxOutputTokens is the ceiling, raised to fit thinking', async () => {
  for (const model of [...BUDGET_ERA, ...ADAPTIVE_ERA]) {
    const c = await capture(modelRequest(model, { reasoning: 'low', sampling: { temperature: 0.2, topP: 0.9, maxOutputTokens: 1000, stop: ['END'] } }));
    for (const field of ['temperature', 'top_p', 'top_k', 'stop_sequences']) assert.ok(!(field in c.body), `${model}: ${field}`);
    assert.equal(c.body.max_tokens, 2048 + 2048, `${model}: raised to the low budget's floor`);
  }
  const plain = await capture(modelRequest('claude-sonnet-4-6', { sampling: { maxOutputTokens: 1000 } }));
  assert.equal(plain.body.max_tokens, 1000);
});

test('the streamed path sends the same shape through the beta namespace', async () => {
  const c = await capture(modelRequest('claude-opus-5-5', { reasoning: 'low', stream: true }));
  assert.equal(c.body.stream, true);
  assert.deepEqual(c.body.thinking, ADAPTIVE_THINKING);
  assert.deepEqual(betas(c), [THINKING_BINDING_BETA]);
});

// ── Structured output ────────────────────────────────────────────────────────

test('budget era: structured output is a forced tool, offered under auto when thinking is on', async () => {
  for (const model of [...BUDGET_ERA, 'claude-opus-4-7']) {
    const c = await capture(modelRequest(model, { outputSchema: SCHEMA }));
    assert.deepEqual(c.body.tool_choice, { type: 'tool', name: 'structured_output' }, model);
    assert.ok(c.body.tools.some((t: any) => t.name === 'structured_output' && t.input_schema.properties.verdict), model);
    assert.equal(c.body.output_config, undefined, model);
    assert.equal(c.span['llm.structured_output'], 'forced_tool', model);
  }
  const thinking = await capture(modelRequest('claude-sonnet-4-6', { outputSchema: SCHEMA, reasoning: 'low' }));
  assert.equal(thinking.body.tool_choice, undefined);
  assert.ok(thinking.body.tools.some((t: any) => t.name === 'structured_output'));
  assert.equal(thinking.span['llm.structured_output'], 'tool_auto');
});

test('adaptive era: structured output is output_config.format beside the effort, with no tool and no tool_choice', async () => {
  for (const model of [...ADAPTIVE_ERA, 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-5-5']) {
    const c = await capture(modelRequest(model, { outputSchema: SCHEMA, reasoning: 'medium' }));
    assert.deepEqual(
      c.body.output_config,
      {
        effort: 'medium',
        format: { type: 'json_schema', schema: { type: 'object', properties: { verdict: { type: 'string' } }, additionalProperties: false, required: ['verdict'] } },
      },
      model,
    );
    assert.equal(c.body.tool_choice, undefined, model);
    assert.equal(c.body.tools, undefined, model);
    assert.equal(c.span['llm.structured_output'], 'output_format', model);
  }
});

test("outputFormat 'json' sends nothing: the Messages API has no JSON mode (ADR 0061)", async () => {
  for (const model of ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-5-5']) {
    const plain = await capture(modelRequest(model, { reasoning: 'low' }));
    const json = await capture(modelRequest(model, { reasoning: 'low', outputFormat: 'json' }));
    assert.deepEqual(json.body, plain.body, model);
  }
});

test('a schema the transform refuses falls back to the tool, under auto where forcing is a 400', async () => {
  const c = await capture(modelRequest('claude-opus-5-5', { outputSchema: { type: 'array', items: { type: 'string' } } }));
  assert.equal(c.body.output_config, undefined);
  assert.equal(c.body.tool_choice, undefined);
  assert.ok(c.body.tools.some((t: any) => t.name === 'structured_output'));
  assert.equal(c.span['llm.structured_output'], 'tool_auto');
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /claude-opus-5-5: the outputSchema cannot be sent as structured output \(JSON schema must be an object, but got array\)/);
});

test('beside other tools, the structured-output tool is offered under auto, never forced', async () => {
  const c = await capture(modelRequest('claude-sonnet-4-6', { outputSchema: SCHEMA, tools: [lookup] }));
  assert.equal(c.body.tool_choice, undefined);
  assert.deepEqual(c.body.tools.map((t: any) => t.name), ['lookup', 'structured_output']);
  assert.equal(c.span['llm.structured_output'], 'tool_auto');
});

test('the structured-output tool\'s call is the answer\'s text; output_config.format\'s answer is read from the text', async () => {
  const forced = await capture(modelRequest('claude-sonnet-4-6', { outputSchema: SCHEMA }), {
    reply: { content: [{ type: 'tool_use', id: 'toolu_1', name: STRUCTURED_OUTPUT_TOOL, input: { verdict: 'yes' } }], stop_reason: 'tool_use' },
  });
  assert.deepEqual(finalOf(forced).parts, [{ type: 'text', text: '{"verdict":"yes"}' }]);
  assert.equal(finalOf(forced).finishReason, 'stop', 'the answer, not a tool call');

  const formatted = await capture(modelRequest('claude-sonnet-5-5', { outputSchema: SCHEMA }), {
    reply: { content: [{ type: 'thinking', thinking: 'Deciding.', signature: 'sig-fixture-1' }, { type: 'text', text: '{"verdict":"no"}' }] },
  });
  assert.equal(finalOf(formatted).parts.at(-1)?.type === 'text' && (finalOf(formatted).parts.at(-1) as any).text, '{"verdict":"no"}');
});

// ── Signed thinking blocks (claudeCurrentApi's and reasoningState's assertions) ──

const A = { type: 'thinking', thinking: 'Look it up first.', signature: 'sig-fixture-a' };
const B = { type: 'thinking', thinking: 'Now the gated write.', signature: 'sig-fixture-b' };
const signedBy = (model: string | undefined, ...blocks: object[]): ProviderState => ({
  provider: 'anthropic',
  kind: THINKING_STATE_KIND,
  ...(model ? { model } : {}),
  payload: blocks,
});

function toolLoop(model: string | undefined): Message[] {
  return [
    { role: 'user', parts: [{ type: 'text', text: 'update the record' }] },
    { role: 'assistant', parts: [{ type: 'toolCall', id: 'c1', name: 'read_record', args: { id: 7 }, providerState: signedBy(model, A) }] },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'c1', name: 'read_record', result: { body: 'stored' } }] },
    { role: 'assistant', parts: [{ type: 'toolCall', id: 'c2', name: 'write_record', args: { id: 7 }, providerState: signedBy(model, B) }] },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'c2', name: 'write_record', result: { ok: true } }] },
  ];
}

test('resume: a conversation-bound model replays the blocks under drop_block, and the span names a known drop reason only', async () => {
  const c = await capture(modelRequest('claude-opus-5-5', { reasoning: 'medium', messages: toolLoop('claude-opus-5-5') }), {
    reply: {
      content: [{ type: 'text', text: 'Updated.' }],
      input_transformations: [
        { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'prefix_binding_mismatch' },
        { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'a-reason-from-the-future\nforged' },
      ],
    },
  });
  const assistant = c.body.messages.filter((m: any) => m.role === 'assistant');
  assert.deepEqual(assistant.map((m: any) => m.content[0]), [A, B], 'each block, verbatim, before its tool_use');
  assert.deepEqual(c.body.thinking.block_binding, DROP_BLOCK);
  assert.deepEqual(betas(c), [THINKING_BINDING_BETA]);
  assert.deepEqual(finalOf(c).parts, [{ type: 'text', text: 'Updated.' }]);
  assert.equal(c.span['llm.thinking.dropped'], 'prefix_binding_mismatch');
});

test('resume: a budget-era model replays as before; thinking off on a bound model replays nothing', async () => {
  const budget = await capture(modelRequest('claude-sonnet-4-6', { reasoning: 'medium', messages: toolLoop('claude-sonnet-4-6') }));
  assert.deepEqual(budget.body.messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content[0]), [A, B]);
  assert.deepEqual(budget.body.thinking, { type: 'enabled', budget_tokens: 8192 });

  const off = await capture(modelRequest('claude-sonnet-5-5', { reasoning: 'none', messages: toolLoop('claude-sonnet-5-5') }));
  assert.deepEqual(off.body.thinking, { type: 'between_tools' });
  assert.ok(!JSON.stringify(off.body.messages).includes('sig-fixture'), 'between_tools cannot carry drop_block');
});

test('only the current turn\'s blocks are replayed, before the part they preceded; thinking parts never are', async () => {
  const signed = (n: number) => signedBy(undefined, { type: 'thinking', thinking: `step ${n}`, signature: `sig-${n}` });
  const c = await capture(
    modelRequest('claude-sonnet-4-6', {
      reasoning: { budget_tokens: 2048 },
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'first question' }] },
        { role: 'assistant', parts: [{ type: 'thinking', text: 'old thought' }, { type: 'toolCall', id: 't1', name: 'Scout', args: {}, providerState: signed(0) }] },
        { role: 'tool', parts: [{ type: 'toolResult', id: 't1', name: 'Scout', result: 'ok' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
        { role: 'user', parts: [{ type: 'text', text: 'second question' }] },
        { role: 'assistant', parts: [{ type: 'toolCall', id: 'c1', name: 'Scout', args: {}, providerState: signed(1) }] },
        { role: 'tool', parts: [{ type: 'toolResult', id: 'c1', name: 'Scout', result: 'ok' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'Asking again.', providerState: signed(2) }, { type: 'toolCall', id: 'c2', name: 'Scout', args: {} }] },
        { role: 'tool', parts: [{ type: 'toolResult', id: 'c2', name: 'Scout', result: 'ok' }] },
      ],
    }),
  );
  const assistants = c.body.messages.filter((m: any) => m.role === 'assistant');
  assert.deepEqual(assistants[0].content.map((b: any) => b.type), ['tool_use']);
  assert.deepEqual(assistants[2].content.map((b: any) => b.signature ?? b.type), ['sig-1', 'tool_use']);
  assert.deepEqual(assistants[3].content.map((b: any) => b.signature ?? b.type), ['sig-2', 'text', 'tool_use']);
  assert.ok(c.body.thinking);
  assert.ok(!JSON.stringify(c.body).includes('old thought'));
});

test('another provider\'s or another Claude model\'s state is ignored, and the unsigned step runs without thinking', async () => {
  for (const state of [
    { provider: 'openai', kind: 'reasoning_items', payload: [{ type: 'reasoning', encrypted_content: 'enc-openai-1' }] },
    signedBy('claude-opus-4-6', A),
  ]) {
    const c = await capture(
      modelRequest('claude-sonnet-4-6', {
        reasoning: { budget_tokens: 2048 },
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'find it' }] },
          { role: 'assistant', parts: [{ type: 'toolCall', id: 'c1', name: 'Scout', args: {}, providerState: state }] },
          { role: 'tool', parts: [{ type: 'toolResult', id: 'c1', name: 'Scout', result: 'ok' }] },
        ],
      }),
    );
    assert.deepEqual(c.body.messages[1].content.map((b: any) => b.type), ['tool_use'], state.provider);
    assert.equal(c.body.thinking, undefined, state.provider);
    assert.equal(c.span['llm.thinking.omitted'], 'unsigned_tool_loop', state.provider);
  }
});

// ── Messages, tools and images ───────────────────────────────────────────────

const lookup: ToolDeclaration = {
  name: 'lookup',
  description: 'Look a record up',
  parameters: { type: 'object', properties: { id: { type: 'integer' }, note: { type: 'string' } }, required: ['id'] },
};

test('system messages join the system prompt; a tool message is one user message of tool results', async () => {
  const c = await capture(
    modelRequest('claude-sonnet-4-6', {
      system: 'Be brief.',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'look up 7' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'Looking.' }, { type: 'toolCall', id: 'c1', name: 'lookup', args: { id: 7 } }, { type: 'toolCall', id: 'c2', name: 'lookup', args: { id: 8 } }] },
        { role: 'tool', parts: [
          { type: 'toolResult', id: 'c1', name: 'lookup', result: { name: 'Ada' } },
          { type: 'toolResult', id: 'c2', name: 'lookup', result: 'not found', isError: true },
        ] },
        { role: 'system', parts: [{ type: 'text', text: 'Summarize in one line.' }] },
      ],
    }),
  );
  assert.equal(c.body.system, 'Be brief.\n\nSummarize in one line.');
  assert.deepEqual(c.body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'look up 7' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'c1', name: 'lookup', input: { id: 7 } },
        { type: 'tool_use', id: 'c2', name: 'lookup', input: { id: 8 } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: '{"name":"Ada"}' },
        { type: 'tool_result', tool_use_id: 'c2', content: '{"error":"not found"}', is_error: true },
      ],
    },
  ]);
});

test('a tool result\'s content is the JSON of the stored function response: a string result as {"result": ...}, an object as it is', async () => {
  const viaContract = await capture(
    modelRequest('claude-sonnet-4-6', {
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', parts: [{ type: 'toolCall', id: 'c1', name: 'a', args: {} }, { type: 'toolCall', id: 'c2', name: 'b', args: {} }] },
        { role: 'tool', parts: [
          { type: 'toolResult', id: 'c1', name: 'a', result: 'plain text' },
          { type: 'toolResult', id: 'c2', name: 'b', result: { rows: [1, 2], total: 2 } },
        ] },
      ],
    }),
  );
  assert.deepEqual(viaContract.body.messages[2].content.map((b: any) => b.content), ['{"result":"plain text"}', '{"rows":[1,2],"total":2}']);
});

test('tools: lowercase schemas as given, web_search as Anthropic\'s server tool', async () => {
  const tools = anthropicTools({ tools: [lookup], nativeTools: ['web_search'] });
  assert.deepEqual(tools, [
    { name: 'lookup', description: 'Look a record up', input_schema: lookup.parameters },
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  ]);

  const c = await capture(modelRequest('claude-sonnet-4-6', { tools: [lookup], nativeTools: ['web_search'] }));
  assert.deepEqual(c.body.tools, tools);
  assert.equal(c.span['llm.web_search.native'], true);
});

test('a strict tool sends its strict schema and strict: true', async () => {
  const c = await capture(modelRequest('claude-sonnet-4-6', { tools: [{ ...lookup, strict: true }] }));
  assert.deepEqual(c.body.tools[0], {
    name: 'lookup',
    description: 'Look a record up',
    input_schema: { type: 'object', properties: { id: { type: 'integer' }, note: { type: 'string' } }, required: ['id', 'note'], additionalProperties: false },
    strict: true,
  });
});

test('native tools Anthropic has no tool for are dropped and named on the span; web_search is not sent off Anthropic\'s API', async () => {
  const c = await capture(modelRequest('claude-sonnet-4-6', { tools: [lookup], nativeTools: ['x_search', 'url_context'] }));
  assert.deepEqual(c.body.tools.map((t: any) => t.name), ['lookup']);
  assert.equal(c.span['llm.capability.dropped'], 'x_search,url_context');
  assert.deepEqual(c.warnings, []);
});

test('tool choice: sent as asked where the model allows forcing, weakened to auto and marked where it does not', async () => {
  const budget = 'claude-sonnet-4-6';
  const any = await capture(modelRequest(budget, { tools: [lookup], toolChoice: 'required' }));
  assert.deepEqual(any.body.tool_choice, { type: 'any' });
  const named = await capture(modelRequest(budget, { tools: [lookup], toolChoice: { name: 'lookup' } }));
  assert.deepEqual(named.body.tool_choice, { type: 'tool', name: 'lookup' });
  const none = await capture(modelRequest('claude-opus-5-5', { tools: [lookup], toolChoice: 'none' }));
  assert.deepEqual(none.body.tool_choice, { type: 'none' }, 'none is always honoured');
  const auto = await capture(modelRequest(budget, { tools: [lookup], toolChoice: 'auto' }));
  assert.ok(!('tool_choice' in auto.body), 'auto is the API\'s default: nothing is sent');

  // Fable 5.1, Opus 5.5 and Sonnet 5.5 refuse forcing; so does any model with thinking on.
  for (const [model, reasoning] of [['claude-opus-5-5', undefined], ['claude-sonnet-5-5', 'none'], [budget, 'low']] as const) {
    const c = await capture(modelRequest(model, { tools: [lookup], toolChoice: { name: 'lookup' }, ...(reasoning ? { reasoning } : {}) }));
    assert.ok(!('tool_choice' in c.body), model);
    assert.equal(c.span['llm.tool_choice.weakened'], 'named', model);
  }
});

test('images: user-message blobs in place; untyped data is PNG, an untyped URL is typed by its extension', async () => {
  const c = await capture(
    modelRequest('claude-sonnet-4-6', {
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'draw a cat' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'here it is' }, { type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] },
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'and these?' },
            { type: 'blob', mimeType: 'image/jpeg', data: '/9j/4AAQ' },
            { type: 'blob', mimeType: 'application/octet-stream', data: 'iVBORw0KGgo=' },
            { type: 'blob', mimeType: 'application/octet-stream', url: 'https://example.com/photos/cat.JPG?size=large' },
            { type: 'blob', mimeType: 'application/octet-stream', url: 'https://example.com/files/report.pdf' },
            { type: 'blob', mimeType: 'image/bmp', data: 'Qk0=' },
            { type: 'blob', mimeType: 'image/png', url: 'gs://bucket/secret-path/cat.png' },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(c.body.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'here it is' }] }, 'only user messages carry images');
  assert.deepEqual(c.body.messages[2].content, [
    { type: 'text', text: 'and these?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    { type: 'image', source: { type: 'url', url: 'https://example.com/photos/cat.JPG?size=large' } },
  ]);
  assert.equal(c.span['llm.image.dropped'], 'application/pdf,image/bmp,non-https URL (gs:)');
  assert.equal(c.warnings.length, 3);
  assert.ok(!JSON.stringify([c.warnings, c.span['llm.image.dropped']]).includes('secret-path'));
});

test('Bedrock: the Bedrock client and its mapped id, a URL image and web_search dropped and said so', async () => {
  const { setSdkImporter } = await import('../lib/models/endpoints.ts');
  let body: any;
  let constructed: any;
  class AnthropicBedrock {
    messages = {
      create: async (b: any) => {
        body = b;
        return { content: [{ type: 'text', text: 'hi from bedrock' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    beta = { messages: this.messages };
    constructor(o: any) {
      constructed = o;
    }
  }
  setSdkImporter(async () => ({ AnthropicBedrock }));
  try {
    const c = await capture(
      modelRequest('claude-sonnet-4-6', {
        nativeTools: ['web_search'],
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'blob', mimeType: 'image/png', url: 'https://example.com/cat.png' }, { type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }],
      }),
      { env: { ANTHROPIC_PLATFORM: 'bedrock', AWS_REGION: 'us-east-1', ANTHROPIC_MODEL_MAP: '{"claude-sonnet-4-6":"us.anthropic.claude-sonnet-4-6-v1:0"}' } },
    );
    assert.deepEqual(constructed, { awsRegion: 'us-east-1' });
    assert.equal(body.model, 'us.anthropic.claude-sonnet-4-6-v1:0');
    assert.equal(body.tools, undefined, 'web_search is not sent on Bedrock');
    assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }]);
    assert.equal(c.span['llm.image.dropped'], 'URL source');
    assert.equal(c.span['llm.web_search.omitted'], true);
    assert.equal(c.span['llm.capability.dropped'], 'web_search');
    assert.deepEqual(finalOf(c).parts, [{ type: 'text', text: 'hi from bedrock' }]);
  } finally {
    setSdkImporter(undefined);
  }
});

// ── Responses ────────────────────────────────────────────────────────────────

test('non-streamed: one thinking partial, then the final with the signed blocks on the part they preceded', async () => {
  const THINKING = { type: 'thinking', thinking: 'Scout knows.', signature: 'sig-fixture-thinking-1' };
  const REDACTED = { type: 'redacted_thinking', data: 'redacted-fixture-blob-1' };
  const c = await capture(modelRequest('claude-sonnet-4-6', { reasoning: 'low', tools: [lookup] }), {
    reply: {
      content: [THINKING, REDACTED, { type: 'text', text: 'Asking Scout.' }, { type: 'tool_use', id: 'toolu_01', name: 'lookup', input: { id: 7 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 },
    },
  });
  assert.deepEqual(c.out, [
    { partial: true, parts: [{ type: 'thinking', text: 'Scout knows.' }] },
    {
      partial: false,
      parts: [
        { type: 'text', text: 'Asking Scout.', providerState: signedBy('claude-sonnet-4-6', THINKING, REDACTED) },
        { type: 'toolCall', id: 'toolu_01', name: 'lookup', args: { id: 7 } },
      ],
      finishReason: 'tool_call',
      usage: { inputTokens: 170, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 10 },
    },
  ]);
  // Mapped, as the model step stores it.
  const final = c.llm.at(-1)!;
  assert.deepEqual(final.content?.parts?.[0], { text: 'Asking Scout.', providerState: signedBy('claude-sonnet-4-6', THINKING, REDACTED) });
  assert.deepEqual(final.usageMetadata, { promptTokenCount: 170, candidatesTokenCount: 40, cachedContentTokenCount: 60, totalTokenCount: 210 });
});

/** A Messages API reply as the API streams it. */
function sse(content: any[], stopReason = 'end_turn'): string {
  const msg = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } };
  const events: unknown[] = [{ type: 'message_start', message: msg }];
  content.forEach((block, index) => {
    if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const piece of block.pieces) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 9 } });
  events.push({ type: 'message_stop' });
  return events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

test('streamed: thinking and text deltas as partials, then one final repeating the whole text, never thinking', async () => {
  const c = await capture(modelRequest('claude-opus-5-5', { reasoning: 'low', stream: true }), {
    reply: { sse: sse([{ type: 'thinking', thinking: 'Greet.', signature: 'sig-s' }, { type: 'text', pieces: ['Hello, ', 'world.'] }]) },
  });
  assert.deepEqual(
    c.out.filter((r) => r.partial),
    [
      { partial: true, parts: [{ type: 'thinking', text: 'Greet.' }] },
      { partial: true, parts: [{ type: 'text', text: 'Hello, ' }] },
      { partial: true, parts: [{ type: 'text', text: 'world.' }] },
    ],
  );
  const final = finalOf(c);
  assert.equal(c.out.filter((r) => !r.partial).length, 1);
  assert.deepEqual(final.parts, [
    { type: 'text', text: 'Hello, world.', providerState: signedBy('claude-opus-5-5', { type: 'thinking', thinking: 'Greet.', signature: 'sig-s' }) },
  ]);
  assert.equal(final.finishReason, 'stop');
});

test('finish reasons: max_tokens, a refusal and a paused turn keep their text and are not errors', async () => {
  for (const [stop, expected] of [['max_tokens', 'max_tokens'], ['refusal', 'content_filter'], ['pause_turn', 'other'], ['end_turn', 'stop']] as const) {
    const c = await capture(modelRequest('claude-sonnet-4-6'), { reply: { content: [{ type: 'text', text: 'partial' }], stop_reason: stop } });
    assert.equal(finalOf(c).finishReason, expected, stop);
    assert.equal(finalOf(c).error, undefined, stop);
    assert.deepEqual(finalOf(c).parts, [{ type: 'text', text: 'partial' }], stop);
  }
});

test('web search grounding: the queries that ran and the cited pages, with the span of the text they cite', async () => {
  const c = await capture(modelRequest('claude-sonnet-4-6', { nativeTools: ['web_search'] }), {
    reply: {
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'tallest tower' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
        { type: 'text', text: 'The answer: ' },
        {
          type: 'text',
          text: 'it is 828 m tall.',
          citations: [{ type: 'web_search_result_location', url: 'https://example.test/tower', title: 'Tower', cited_text: '828 metres', encrypted_index: 'x' }],
        },
      ],
    },
  });
  assert.deepEqual(finalOf(c).grounding, {
    citations: [{ url: 'https://example.test/tower', title: 'Tower', citedText: '828 metres', start: 12, end: 29 }],
    searchQueries: [{ tool: 'web_search', query: 'tallest tower' }],
  });
  assert.deepEqual(c.llm.at(-1)?.groundingMetadata, { webSearchQueries: ['tallest tower'], groundingChunks: [{ web: { uri: 'https://example.test/tower', title: 'Tower' } }] });
  assert.equal(c.llm.at(-1)?.turnComplete, true, 'the rest of the final is kept');
});

// ── Failures are finals ──────────────────────────────────────────────────────

test('no key: MISSING_API_KEY before any request, not retryable', async () => {
  const c = await capture(modelRequest('claude-sonnet-4-6'), { env: {} });
  assert.equal(c.calls, 0);
  assert.deepEqual(c.out, [
    { partial: false, parts: [], finishReason: 'error', error: { code: 'MISSING_API_KEY', message: 'ANTHROPIC_API_KEY is not set in environment.', retryable: false } },
  ]);
  assert.equal(c.llm[0].errorCode, 'MISSING_API_KEY');
  assert.equal(c.llm[0].customMetadata?.[ERROR_RETRYABLE_KEY], false);
});

test('a failed call is ANTHROPIC_ERROR with the retry verdict and status: a 529 retryable, a 400 not', async () => {
  const overloaded = await capture(modelRequest('claude-opus-5-5'), { reply: { status: 529, type: 'overloaded_error' } });
  assert.equal(overloaded.calls, 3, 'the SDK made its first attempt and two retries');
  assert.equal(overloaded.out.length, 1);
  assert.deepEqual(finalOf(overloaded).error, { code: 'ANTHROPIC_ERROR', message: finalOf(overloaded).error!.message, retryable: true, status: 529 });
  assert.deepEqual([overloaded.llm[0].customMetadata?.[ERROR_RETRYABLE_KEY], overloaded.llm[0].customMetadata?.[ERROR_STATUS_KEY]], [true, 529]);

  const bad = await capture(modelRequest('claude-opus-5-5'), { reply: { status: 400, type: 'invalid_request_error' } });
  assert.equal(bad.calls, 1);
  assert.match(finalOf(bad).error!.message, /status 400/);
  assert.deepEqual([finalOf(bad).error!.retryable, finalOf(bad).error!.status, finalOf(bad).finishReason], [false, 400, 'error']);
});

test('the signal: an aborted request is never sent; one aborted in flight ends at once, not retryable', async () => {
  const before = new AbortController();
  before.abort();
  const c = await capture(modelRequest('claude-sonnet-4-6', { signal: before.signal }));
  assert.equal(c.calls, 0);
  assert.deepEqual([finalOf(c).error?.code, finalOf(c).error?.retryable], ['ANTHROPIC_ERROR', false]);

  const during = new AbortController();
  // A provider that never answers: like fetch, the request fails only when its signal aborts.
  const hung = (_n: number, init: any) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))));
  setTimeout(() => during.abort(), 20);
  const started = Date.now();
  const d = await capture(modelRequest('claude-sonnet-4-6', { signal: during.signal }), { reply: hung });
  assert.ok(Date.now() - started < 2000, 'ended at once');
  assert.equal(d.out.length, 1);
  assert.deepEqual([finalOf(d).error?.code, finalOf(d).error?.retryable], ['ANTHROPIC_ERROR', false]);
});

// ── Reasoning ────────────────────────────────────────────────────────────────

test('the contract maps a level to its budget on a budget-era model (ADR 0049)', async () => {
  const levelOnContract = await capture(modelRequest('claude-sonnet-4-6', { reasoning: 'high' }));
  assert.deepEqual(levelOnContract.body.thinking, { type: 'enabled', budget_tokens: 16384 }, 'the contract maps a level to its budget');
});

test('claudeReasoningOf and claudeReasoningFromConfig agree wherever the compiler writes both spellings', () => {
  const settings: ReasoningSetting[] = ['none', 'low', 'medium', 'high', { budget_tokens: 5000 }, { budget_tokens: 0 }, { budget_tokens: 30000 }];
  for (const setting of settings) {
    assert.deepEqual(claudeReasoningFromConfig(reasoningConfig('claude-opus-5-5', setting)), claudeReasoningOf(setting), JSON.stringify(setting));
  }
  assert.deepEqual(claudeReasoningOf(undefined), {});
  assert.deepEqual(claudeReasoningFromConfig({}), {});
});
