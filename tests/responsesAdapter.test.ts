/**
 * tests/responsesAdapter.test.ts — GPT and Grok on the engine's own model
 * contract (lib/models/gptAdapter.ts, lib/models/grokAdapter.ts, ADR 0048),
 * and GptLlm/GrokLlm as the ADK shim around them (ADR 0053, ADR 0056).
 *
 * Offline: the adapters talk to a fetch stub that answers in the Responses
 * API's own wire format (JSON, or SSE when the request streams), so the real
 * openai SDK builds and parses everything. Keys are fixtures.
 *
 * What is proved here:
 *   - a ModelRequest reaches the wire as the LlmRequest the ADK path sent
 *     did: the request-body assertions of models.test.ts,
 *     reasoningKey.test.ts, responsesReasoningState.test.ts and
 *     endpoints.test.ts, made against ModelRequest inputs, and GptLlm and
 *     GptAdapter sending the same body for the same conversation;
 *   - grok-4.6 takes an effort and replays its reasoning, as 4.5 and 4.7 do;
 *   - a reply becomes partials and one final in the contract's meanings:
 *     usage with reasoning inside the output, grounding, finish reasons;
 *   - every failure is a final; an in-stream failure carries a retry
 *     verdict when its event names a status or an error type; an abort ends
 *     the call at once and is never retryable;
 *   - on the ADK path, GptLlm keeps the Responses usage meaning (the turn's
 *     and the ledger's output count include reasoning, as before), the
 *     server-side tool record on customMetadata, and no groundingMetadata.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogLevel, setLogLevel } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import type { FinalModelResponse, Message, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { GptAdapter, REASONING_STATE_KIND, responsesInput, responsesServerTools, streamErrorDecision } from '../lib/models/gptAdapter.ts';
import { GrokAdapter } from '../lib/models/grokAdapter.ts';
import { GptLlm, buildResponsesInput } from '../lib/models/gptLlm.ts';
import { GrokLlm } from '../lib/models/grokLlm.ts';
import { adkShim } from '../lib/models/adkShim.ts';
import { isRetryableErrorResponse } from '../lib/models/errorResponse.ts';
import { withProviderState } from '../lib/models/providerState.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import { WEB_SEARCH } from '../lib/tools/webSearchTool.ts';
import { X_SEARCH } from '../lib/tools/xSearchTool.ts';

setLogLevel(LogLevel.ERROR);

const OPENAI_KEY = 'fixture-openai-0123456789abcdef'; // gitleaks:allow (test fixture)
const XAI_KEY = 'fixture-xai-0123456789abcdef'; // gitleaks:allow (test fixture)
const INCLUDE = ['reasoning.encrypted_content'];
const DIRECT = { platform: 'direct' as const };

const gpt = (model = 'gpt-5-mini') => new GptAdapter({ model, apiKey: OPENAI_KEY, endpoint: DIRECT });
const grok = (model = 'grok-4.7') => new GrokAdapter({ model, apiKey: XAI_KEY });

// ── Fixtures ─────────────────────────────────────────────────────────────────

function reasoningItem(n: number) {
  return { id: `rs_fixture_${n}`, type: 'reasoning', summary: [{ type: 'summary_text', text: `Scout knows (${n}).` }], encrypted_content: `enc-fixture-${n}` };
}
const R1 = reasoningItem(1);

function functionCall(callId: string, args: Record<string, unknown> = { request: 'look in the attic' }) {
  return { id: `fc_${callId}`, type: 'function_call', status: 'completed', call_id: callId, name: 'Scout', arguments: JSON.stringify(args) };
}

function outputMessage(text: string, annotations: unknown[] = []) {
  return { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations }] };
}

const USAGE = { input_tokens: 12, output_tokens: 7, output_tokens_details: { reasoning_tokens: 4 }, input_tokens_details: { cached_tokens: 2 }, total_tokens: 19 };

function responseOf(output: unknown[], model = 'gpt-5-mini', extra: Record<string, unknown> = {}) {
  return { id: 'resp_fixture', object: 'response', created_at: 0, model, status: 'completed', output, usage: USAGE, ...extra };
}

/** Server-sent events: `event:` lines unless `bare`, as the Responses API names every frame. */
function sseOf(events: any[], bare = false): string {
  return events.map((e) => `${bare ? '' : `event: ${e.type}\n`}data: ${JSON.stringify(e)}\n\n`).join('');
}

/** A reply as the Responses API streams it: summary and text deltas, then response.completed. */
function streamOf(reply: ReturnType<typeof responseOf>): string {
  const events: any[] = [{ type: 'response.created', response: { ...reply, status: 'in_progress', output: [] } }];
  for (const item of reply.output as any[]) {
    for (const s of item.type === 'reasoning' ? item.summary : []) events.push({ type: 'response.reasoning_summary_text.delta', delta: s.text });
    for (const c of item.type === 'message' ? item.content : []) events.push({ type: 'response.output_text.delta', delta: c.text });
  }
  events.push({ type: 'response.completed', response: reply });
  return sseOf(events);
}

/** One scripted answer: a reply (JSON, or SSE when the request streams), an HTTP status, or a raw SSE body. */
type Answer = ReturnType<typeof responseOf> | number | { sse: string } | { stall: string };

interface Sent {
  host: string;
  path: string;
  headers: Headers;
  body: any;
}

/** Replaces fetch for the test body; an exhausted script answers 400. */
async function withFetch<T>(answers: Answer[], body: (sent: Sent[]) => Promise<T>): Promise<T> {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    sent.push({ host: url.host, path: url.pathname, headers: new Headers(init?.headers), body: parsed });
    const answer = answers.shift() ?? 400;
    if (typeof answer === 'number') {
      return new Response(JSON.stringify({ error: { message: `status ${answer}`, type: 'invalid_request_error' } }), {
        status: answer,
        headers: { 'content-type': 'application/json' },
      });
    }
    if ('sse' in answer) return new Response(answer.sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    if ('stall' in answer) {
      // One frame, then nothing: a stream that never ends on its own.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(answer.stall));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return parsed?.stream
      ? new Response(streamOf(answer), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return await body(sent);
  } finally {
    globalThis.fetch = original;
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const r of it) out.push(r);
  return out;
}

const finalOf = (out: ModelResponse[]): FinalModelResponse => {
  const last = out.at(-1)!;
  assert.equal(last.partial, false, 'the call ends with a final');
  assert.equal(out.filter((r) => !r.partial).length, 1, 'exactly one final');
  return last as FinalModelResponse;
};

const user = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] });

function request(model: string, over: Partial<ModelRequest> = {}): ModelRequest {
  return { model, messages: [user('hello')], ...over };
}

/** The body an adapter posts for `req` (the stub answers 400; the request is what matters). */
async function bodyOf(adapter: GptAdapter, req: ModelRequest): Promise<any> {
  return withFetch([400, 400], async (sent) => {
    await collect(adapter.generate(req));
    return sent[0].body;
  });
}

// ── The request: the ADK path's assertions against ModelRequest inputs ──────

test('a conversation: instructions, call ids round-tripped, input_text, and the result as the ADK path sent it', () => {
  const messages: Message[] = [
    { role: 'system', parts: [{ type: 'text', text: 'Be concise.' }] },
    user('What is 2+2?'),
    { role: 'assistant', parts: [{ type: 'toolCall', id: 'call_abc', name: 'calc', args: { a: 2 } }] },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'call_abc', name: 'calc', result: 4 }] },
  ];
  const { instructions, input } = responsesInput({ messages });
  assert.equal(instructions, 'Be concise.');
  const call = input.find((i) => i.type === 'function_call');
  const output = input.find((i) => i.type === 'function_call_output');
  assert.equal(call!.call_id, 'call_abc');
  assert.equal(output!.call_id, 'call_abc'); // the Responses API requires the match
  assert.equal(output!.output, '{"result":4}', "genai's functionResponse.response, as before");
  assert.equal(input.find((i) => i.role === 'user')!.content[0].type, 'input_text');

  // The same conversation from an LlmRequest gives the same items.
  const llmRequest = {
    model: 'gpt-5-mini',
    contents: [
      { role: 'system', parts: [{ text: 'Be concise.' }] },
      { role: 'user', parts: [{ text: 'What is 2+2?' }] },
      { role: 'model', parts: [{ functionCall: { id: 'call_abc', name: 'calc', args: { a: 2 } } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'call_abc', name: 'calc', response: { result: 4 } } }] },
    ],
    toolsDict: {},
    liveConnectConfig: {},
  } as unknown as LlmRequest;
  assert.deepEqual(buildResponsesInput(llmRequest).input, input);

  // A failed tool says so in its output; system text joins the request's own.
  const failedTool = responsesInput({
    system: 'You are a calculator.',
    messages: [{ role: 'system', parts: [{ type: 'text', text: 'Turn note.' }] }, { role: 'tool', parts: [{ type: 'toolResult', id: 'c', name: 'calc', result: 'boom', isError: true }] }],
  });
  assert.equal(failedTool.instructions, 'You are a calculator.\n\nTurn note.');
  assert.equal(failedTool.input[0].output, '{"error":"boom"}');
});

test('user-turn blobs: an image inline or by https URL, a PDF as input_file; other URLs and assistant blobs are not sent', () => {
  const { input, droppedBlobs } = responsesInput({
    messages: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'what is this?' },
          { type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { type: 'blob', mimeType: 'application/octet-stream', data: 'AAAA' },
          { type: 'blob', mimeType: 'image/jpeg', url: 'https://example.com/a.jpg' },
          { type: 'blob', mimeType: 'application/pdf', data: 'JVBERi0=' },
          { type: 'blob', mimeType: 'image/png', url: 'gs://bucket/a.png' },
        ],
      },
      { role: 'assistant', parts: [{ type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] },
    ],
  });
  assert.deepEqual(input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this?' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, // untyped: PNG, as before
        { type: 'input_image', image_url: 'https://example.com/a.jpg' },
        { type: 'input_file', filename: 'document.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
      ],
    },
  ]);
  assert.deepEqual(droppedBlobs, ['URL scheme']);
});

test('tools: declarations as given, strict ones in strict form; web_search native, and not sent on Azure', async () => {
  const calc = { name: 'calc', description: 'Calculate', parameters: { type: 'object', properties: { a: { type: 'number' } } } };
  let body = await bodyOf(gpt(), request('gpt-5-mini', { tools: [calc, { ...calc, name: 'exact', strict: true }], nativeTools: ['web_search'] }));
  assert.deepEqual(body.tools, [
    { type: 'function', name: 'calc', description: 'Calculate', parameters: calc.parameters, strict: false },
    {
      type: 'function',
      name: 'exact',
      description: 'Calculate',
      parameters: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false },
      strict: true,
    },
    { type: 'web_search' },
  ]);
  assert.ok(!('tool_choice' in body), 'no choice asked, none sent');

  // Azure OpenAI: the deployment name, the v1 path, no web_search.
  const azure = new GptAdapter({
    model: 'gpt-5-mini',
    endpoint: { platform: 'azure', baseURL: 'https://acme.openai.azure.com/openai/v1', apiKey: 'fixture-azure-0123456789', models: { 'gpt-5-mini': 'acme-gpt5mini' } },
  });
  await withFetch([400], async (sent) => {
    await collect(azure.generate(request('gpt-5-mini', { nativeTools: ['web_search'] })));
    assert.equal(`${sent[0].host}${sent[0].path}`, 'acme.openai.azure.com/openai/v1/responses');
    assert.equal(sent[0].body.model, 'acme-gpt5mini');
    assert.ok(!(sent[0].body.tools ?? []).some((t: any) => t.type === 'web_search'));
  });

  // Tool choice, as asked.
  for (const [choice, wire] of [
    ['required', 'required'],
    ['none', 'none'],
    [{ name: 'calc' }, { type: 'function', name: 'calc' }],
  ] as const) {
    body = await bodyOf(gpt('gpt-4o'), request('gpt-4o', { tools: [calc], toolChoice: choice }));
    assert.deepEqual(body.tool_choice, wire);
  }
});

test("xAI's native tools carry deployment config; OpenAI's web_search stays bare and drops xAI's tools", async () => {
  const saved = Object.fromEntries(
    ['XAI_WEB_SEARCH_ALLOWED_DOMAINS', 'XAI_WEB_SEARCH_EXCLUDED_DOMAINS', 'XAI_X_SEARCH_FROM_DATE', 'XAI_X_SEARCH_TO_DATE', 'XAI_X_SEARCH_ALLOWED_HANDLES', 'XAI_X_SEARCH_EXCLUDED_HANDLES', 'XAI_COLLECTION_IDS', 'XAI_COLLECTIONS_MAX_RESULTS'].map((k) => [k, process.env[k]]),
  );
  try {
    for (const k of Object.keys(saved)) delete process.env[k];
    process.env.XAI_WEB_SEARCH_ALLOWED_DOMAINS = ' reuters.com , apnews.com ,';
    process.env.XAI_X_SEARCH_FROM_DATE = '2026-08-01';
    process.env.XAI_X_SEARCH_ALLOWED_HANDLES = ' @Reuters , AP ,';
    process.env.XAI_COLLECTION_IDS = ' col_a , col_b ,';
    process.env.XAI_COLLECTIONS_MAX_RESULTS = '7';
    const all = { nativeTools: ['collections_search', 'x_search', 'web_search'] } as const;
    assert.deepEqual(grok('grok-4.5').nativeToolPlan({ nativeTools: [...all.nativeTools] }).tools, [
      { type: 'web_search', filters: { allowed_domains: ['reuters.com', 'apnews.com'] } },
      { type: 'x_search', from_date: '2026-08-01', allowed_x_handles: ['Reuters', 'AP'] },
      { type: 'file_search', vector_store_ids: ['col_a', 'col_b'], max_num_results: 7 },
    ]);

    // OpenAI: bare web_search; xAI's tools and Gemini's are dropped and named.
    const plan = gpt().nativeToolPlan({ nativeTools: ['web_search', 'x_search', 'collections_search', 'url_context'] });
    assert.deepEqual(plan.tools, [{ type: 'web_search' }]);
    assert.deepEqual(plan.dropped, ['x_search', 'collections_search', 'url_context']);

    // Unconfigured: bare tools, and no file_search at all.
    for (const k of Object.keys(saved)) delete process.env[k];
    const bare = grok('grok-4.5').nativeToolPlan({ nativeTools: [...all.nativeTools] });
    assert.deepEqual(bare.tools, [{ type: 'web_search' }, { type: 'x_search' }]);
    assert.equal(bare.attributes['llm.collections_search.omitted'], true);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('reasoning: each vendor maps the setting to its own field; grok-4.6 takes an effort like 4.5 and 4.7', async () => {
  // GPT: the summary, and the effort in the model's own word (ADR 0047).
  assert.deepEqual(gpt('gpt-5-mini').reasoningParam('high'), { summary: 'auto', effort: 'high' });
  assert.equal(gpt('gpt-5-mini').reasoningParam('none')!.effort, 'minimal');
  assert.equal(gpt('gpt-5.4').reasoningParam('none')!.effort, 'none');
  assert.equal(gpt('o4-mini').reasoningParam('none')!.effort, 'low');
  assert.equal(gpt('gpt-5-mini').reasoningParam({ budget_tokens: 3000 })!.effort, 'medium');
  assert.deepEqual(gpt('gpt-5-mini').reasoningParam(undefined), { summary: 'auto' });
  assert.equal(gpt('gpt-4o').reasoningParam('high'), undefined);

  // Grok: the pinned effort when unset, `none` as `low`.
  for (const model of ['grok-4.5', 'grok-4.6', 'grok-4.7']) {
    assert.deepEqual(grok(model).reasoningParam(undefined), { effort: 'medium' }, model);
    assert.deepEqual(grok(model).reasoningParam('high'), { effort: 'high' }, model);
    assert.deepEqual(grok(model).reasoningParam('none'), { effort: 'low' }, model);
  }
  for (const model of ['grok-4-1-fast-reasoning', 'grok-3', 'grok-4.65']) assert.equal(grok(model).reasoningParam('high'), undefined, model);

  // On the wire, with store: false and encrypted reasoning on the ids that replay.
  for (const adapter of [gpt('gpt-5-mini'), gpt('gpt-5.1'), gpt('o4-mini'), grok('grok-4.5'), grok('grok-4.6'), grok('grok-4.7')]) {
    const body = await bodyOf(adapter, request(adapter.model, { reasoning: 'low' }));
    assert.strictEqual(body.store, false, `${adapter.model}: store`);
    assert.deepEqual(body.include, INCLUDE, `${adapter.model}: include`);
    assert.ok(body.reasoning?.effort, `${adapter.model}: effort`);
  }
  for (const adapter of [gpt('gpt-4o'), gpt('gpt-4.1-mini'), grok('grok-4-1-fast-reasoning'), grok('grok-3')]) {
    const body = await bodyOf(adapter, request(adapter.model, { reasoning: 'low' }));
    assert.ok(!('store' in body) && !('include' in body) && !('reasoning' in body), adapter.model);
  }
});

test('sampling and structured output: as the ADK path sent them, with top_p beside temperature', async () => {
  const sampling = { temperature: 0.2, topP: 0.9, maxOutputTokens: 512, stop: ['END'] };
  const schema = { type: 'object', properties: { verdict: { type: 'string' }, note: { type: 'string' } }, required: ['verdict'] };
  let body = await bodyOf(gpt('gpt-4o'), request('gpt-4o', { sampling, outputSchema: schema }));
  assert.equal(body.max_output_tokens, 512);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.9);
  assert.ok(!('stop' in body), 'the Responses API has no stop field');
  assert.deepEqual(body.text, {
    format: {
      type: 'json_schema',
      name: 'response',
      strict: true,
      schema: { type: 'object', properties: schema.properties, required: ['verdict', 'note'], additionalProperties: false },
    },
  });
  // Reasoning ids refuse sampling; the ceiling still goes.
  body = await bodyOf(gpt('gpt-5-mini'), request('gpt-5-mini', { sampling }));
  assert.ok(!('temperature' in body) && !('top_p' in body));
  assert.equal(body.max_output_tokens, 512);
  // Grok takes them on every id, as before.
  body = await bodyOf(grok('grok-4.7'), request('grok-4.7', { sampling }));
  assert.equal(body.temperature, 0.2);
});

test("JSON mode (outputFormat 'json', ADR 0061): text.format json_object on GPT and Grok; a schema says more and wins", async () => {
  const jsonMode = { format: { type: 'json_object' } };
  assert.deepEqual((await bodyOf(gpt('gpt-4o'), request('gpt-4o', { outputFormat: 'json' }))).text, jsonMode);
  assert.deepEqual((await bodyOf(gpt('gpt-5-mini'), request('gpt-5-mini', { outputFormat: 'json' }))).text, jsonMode);
  assert.deepEqual((await bodyOf(grok('grok-4.7'), request('grok-4.7', { outputFormat: 'json' }))).text, jsonMode);
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
  assert.equal((await bodyOf(gpt('gpt-4o'), request('gpt-4o', { outputSchema: schema, outputFormat: 'json' }))).text.format.type, 'json_schema');
  assert.ok(!('text' in (await bodyOf(gpt('gpt-4o'), request('gpt-4o')))), 'plain text sends no format');
});

test('the ADK path: responseMimeType application/json without a schema is JSON mode on GptLlm and GrokLlm, as before WS1-5', async () => {
  const adkBody = (llm: GptLlm, config: Record<string, unknown>) =>
    withFetch([400, 400], async (sent) => {
      await collect(llm.generateContentAsync({ ...llmRequestOf(llm.model), config } as LlmRequest));
      return sent[0].body;
    });
  const json = { responseMimeType: 'application/json' };
  const gptLlm = () => new GptLlm({ model: 'gpt-5-mini', apiKey: OPENAI_KEY, endpoint: DIRECT });
  const grokLlm = () => new GrokLlm({ model: 'grok-4.7', apiKey: XAI_KEY });
  assert.deepEqual((await adkBody(gptLlm(), json)).text, { format: { type: 'json_object' } });
  assert.deepEqual((await adkBody(grokLlm(), json)).text, { format: { type: 'json_object' } });
  const schema = { ...json, responseSchema: { type: 'OBJECT', properties: { verdict: { type: 'STRING' } }, required: ['verdict'] } };
  assert.equal((await adkBody(gptLlm(), schema)).text.format.type, 'json_schema');
  assert.ok(!('text' in (await adkBody(grokLlm(), {}))));
});

test('GptLlm and GptAdapter send the same body for the same conversation', async () => {
  const state = { provider: 'openai', kind: REASONING_STATE_KIND, model: 'gpt-5-mini', payload: [R1] };
  const llmRequest = {
    model: 'gpt-5-mini',
    contents: [
      { role: 'user', parts: [{ text: 'find it' }] },
      { role: 'model', parts: [{ text: 'Thinking it over.', thought: true }, { text: 'Let me ask Scout.' }, withProviderState({ functionCall: { id: 'call_1', name: 'Scout', args: { request: 'attic' } } }, state)] },
      { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'Scout', response: { result: 'found' } } }] },
    ],
    toolsDict: {
      Scout: { name: 'Scout', description: 'Finds things', parameters: { type: 'OBJECT', properties: { request: { type: 'STRING' } }, required: ['request'] } },
      web_search: WEB_SEARCH,
    },
    config: { systemInstruction: 'Delegate to Scout.', reasoningEffort: 'low', maxOutputTokens: 900 },
    liveConnectConfig: {},
  } as unknown as LlmRequest;
  const modelRequest: ModelRequest = {
    model: 'gpt-5-mini',
    system: 'Delegate to Scout.',
    messages: [
      user('find it'),
      {
        role: 'assistant',
        parts: [
          { type: 'thinking', text: 'Thinking it over.' },
          { type: 'text', text: 'Let me ask Scout.' },
          { type: 'toolCall', id: 'call_1', name: 'Scout', args: { request: 'attic' }, providerState: state },
        ],
      },
      { role: 'tool', parts: [{ type: 'toolResult', id: 'call_1', name: 'Scout', result: 'found' }] },
    ],
    tools: [{ name: 'Scout', description: 'Finds things', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] } }],
    nativeTools: ['web_search'],
    reasoning: 'low',
    sampling: { maxOutputTokens: 900 },
  };
  const viaLlm = await withFetch([400, 400], async (sent) => {
    await collect(new GptLlm({ model: 'gpt-5-mini', apiKey: OPENAI_KEY, endpoint: DIRECT }).generateContentAsync(llmRequest));
    return sent[0].body;
  });
  const viaAdapter = await bodyOf(gpt(), modelRequest);
  assert.deepEqual(viaAdapter, viaLlm);
  // And it is the body the ADK path built: the item replayed before its call, the text after it.
  assert.deepEqual(
    viaAdapter.input.map((i: any) => i.type ?? i.role),
    ['user', 'assistant', 'reasoning', 'function_call', 'function_call_output'],
  );
  assert.deepEqual(viaAdapter.reasoning, { summary: 'auto', effort: 'low' });

  // Grok, with its native tools from the sentinels.
  const grokLlmRequest = { ...llmRequest, model: 'grok-4.7', toolsDict: { ...llmRequest.toolsDict, x_search: X_SEARCH }, config: {} } as unknown as LlmRequest;
  const grokRequest: ModelRequest = { ...modelRequest, model: 'grok-4.7', system: undefined, nativeTools: ['web_search', 'x_search'], reasoning: undefined, sampling: undefined };
  delete grokRequest.system;
  const grokViaLlm = await withFetch([400], async (sent) => {
    await collect(new GrokLlm({ model: 'grok-4.7', apiKey: XAI_KEY }).generateContentAsync(grokLlmRequest));
    return sent[0].body;
  });
  assert.deepEqual(await bodyOf(grok(), grokRequest), grokViaLlm);
});

// ── Reasoning across a tool loop, on the contract ───────────────────────────

for (const [label, make, stream] of [
  ['gpt-5-mini', () => gpt('gpt-5-mini'), false],
  ['gpt-5-mini (streamed)', () => gpt('gpt-5-mini'), true],
  ['grok-4.6', () => grok('grok-4.6'), false],
] as const) {
  test(`${label}: the final's call carries the reasoning item, and the next step replays it before the call`, async () => {
    const adapter = make();
    await withFetch([responseOf([R1, functionCall('call_1')], adapter.model), responseOf([outputMessage('It is in the attic.')], adapter.model)], async (sent) => {
      const first = await collect(adapter.generate(request(adapter.model, { stream })));
      const step1 = finalOf(first);
      assert.equal(step1.finishReason, 'tool_call');
      const call = step1.parts[0];
      assert.equal(call.type, 'toolCall');
      assert.deepEqual(call.providerState, { provider: adapter.provider, kind: REASONING_STATE_KIND, model: adapter.model, payload: [R1] });
      // The summary is display-only thinking, never in the final.
      assert.ok(first.some((r) => r.partial && r.parts.some((p) => p.type === 'thinking')));
      assert.ok(!step1.parts.some((p) => (p as { type: string }).type === 'thinking'));

      const second = await collect(
        adapter.generate(
          request(adapter.model, {
            stream,
            messages: [user('find it'), { role: 'assistant', parts: step1.parts }, { role: 'tool', parts: [{ type: 'toolResult', id: 'call_1', name: 'Scout', result: 'found' }] }],
          }),
        ),
      );
      assert.equal(finalOf(second).parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), 'It is in the attic.');
      const input: any[] = sent[1].body.input;
      const at = input.findIndex((i) => i.type === 'function_call' && i.call_id === 'call_1');
      assert.deepEqual(input[at - 1], R1);
      assert.equal(input[at + 1].type, 'function_call_output');
      assert.ok(!JSON.stringify(sent[1].body).includes('providerState'));
      assert.strictEqual(sent[1].body.store, false);
    });
  });
}

test('replay: only this turn, this model and this provider; order kept; an item without encrypted content is skipped', () => {
  const stateOf = (items: unknown[], model = 'gpt-5-mini', provider = 'openai') => ({ provider, kind: REASONING_STATE_KIND, model, payload: items });
  const call = (id: string, state?: ReturnType<typeof stateOf>) => ({ type: 'toolCall' as const, id, name: 'Scout', args: {}, ...(state ? { providerState: state } : {}) });
  const result = (id: string): Message => ({ role: 'tool', parts: [{ type: 'toolResult', id, name: 'Scout', result: 'found' }] });
  const replay = { provider: 'openai', model: 'gpt-5-mini' };
  const { input } = responsesInput(
    {
      messages: [
        user('first question'),
        { role: 'assistant', parts: [call('c0', stateOf([reasoningItem(0)]))] },
        result('c0'),
        user('second question'),
        { role: 'assistant', parts: [{ type: 'text', text: 'Let me ask.', providerState: stateOf([R1]) }, call('c1', stateOf([{ id: 'rs_bare', type: 'reasoning', summary: [] }, reasoningItem(2)]))] },
        result('c1'),
        { role: 'assistant', parts: [call('c2', stateOf([reasoningItem(3)], 'gpt-5'))] },
        result('c2'),
        { role: 'assistant', parts: [call('c3', stateOf([reasoningItem(4)], 'gpt-5-mini', 'xai'))] },
        result('c3'),
      ],
    },
    replay,
  );
  assert.deepEqual(
    input.filter((i) => i.type === 'reasoning').map((i) => i.id),
    ['rs_fixture_1', 'rs_fixture_2'],
  );
  const kinds = input.map((i) => i.type ?? i.role);
  const start = kinds.indexOf('user', 1);
  assert.deepEqual(kinds.slice(start, start + 6), ['user', 'reasoning', 'assistant', 'reasoning', 'function_call', 'function_call_output']);
  assert.ok(!responsesInput({ messages: [user('q'), { role: 'assistant', parts: [call('c1', stateOf([R1]))] }, result('c1')] }).input.some((i) => i.type === 'reasoning'));

  // A message that replays keeps text before a call that carries nothing of its own;
  // one that does not replay puts its calls first, as the ADK path built it.
  const textThenCall = (state?: ReturnType<typeof stateOf>): Message[] => [
    user('q'),
    { role: 'assistant', parts: [{ type: 'text', text: 'Asking.', ...(state ? { providerState: state } : {}) }, call('c1')] },
    result('c1'),
  ];
  const order = (messages: Message[]) => responsesInput({ messages }, replay).input.map((i) => i.type ?? i.role);
  assert.deepEqual(order(textThenCall(stateOf([R1]))), ['user', 'reasoning', 'assistant', 'function_call', 'function_call_output']);
  assert.deepEqual(order(textThenCall()), ['user', 'function_call', 'assistant', 'function_call_output']);
});

test('the guarded 400 retry drops the reasoning additions and keeps store: false', async () => {
  const state = { provider: 'openai', kind: REASONING_STATE_KIND, model: 'gpt-5-mini', payload: [R1] };
  await withFetch([400, responseOf([outputMessage('done')])], async (sent) => {
    const out = await collect(
      gpt().generate(
        request('gpt-5-mini', {
          reasoning: 'low',
          messages: [
            user('find it'),
            { role: 'assistant', parts: [{ type: 'toolCall', id: 'c1', name: 'Scout', args: {}, providerState: state }] },
            { role: 'tool', parts: [{ type: 'toolResult', id: 'c1', name: 'Scout', result: 'found' }] },
          ],
        }),
      ),
    );
    assert.equal(sent.length, 2);
    assert.ok(sent[0].body.input.some((i: any) => i.type === 'reasoning'));
    const retry = sent[1].body;
    assert.ok(!('reasoning' in retry) && !('include' in retry));
    assert.ok(!retry.input.some((i: any) => i.type === 'reasoning'));
    assert.strictEqual(retry.store, false);
    assert.deepEqual(finalOf(out).parts, [{ type: 'text', text: 'done' }]);
  });
});

// ── The response ─────────────────────────────────────────────────────────────

test('a reply: one thinking partial, then the final in the contract meanings; streamed, text deltas then the whole text', async () => {
  const reply = responseOf([R1, outputMessage('Hello'), outputMessage('world')]);
  await withFetch([reply, reply], async () => {
    const plain = await collect(gpt().generate(request('gpt-5-mini')));
    assert.deepEqual(plain.map((r) => r.partial), [true, false]);
    assert.deepEqual(plain[0].parts, [{ type: 'thinking', text: 'Scout knows (1).' }]);
    const final = finalOf(plain);
    // A second message item starts a new paragraph; the run before the first text rides on it.
    assert.deepEqual(final.parts.map((p) => (p.type === 'text' ? p.text : '')), ['Hello', '\n\nworld']);
    assert.equal(final.parts[0].providerState?.kind, REASONING_STATE_KIND);
    assert.equal(final.finishReason, 'stop');
    // Reasoning is inside output_tokens and the cache inside input_tokens, on both vendors.
    assert.deepEqual(final.usage, { inputTokens: 12, outputTokens: 7, thinkingTokens: 4, cacheReadTokens: 2 });

    const streamed = await collect(gpt().generate(request('gpt-5-mini', { stream: true })));
    const partials = streamed.filter((r) => r.partial).map((r) => r.parts[0]);
    assert.deepEqual(partials, [
      { type: 'thinking', text: 'Scout knows (1).' },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'world' },
    ]);
    assert.deepEqual(finalOf(streamed).parts.map((p) => (p.type === 'text' ? p.text : '')), ['Hello', '\n\nworld']);
  });
});

test('grounding, server-side tools and finish reasons', async () => {
  // A searched grok-4.7 answer: two message items, url citations, a web and an X search.
  const narration = "I'll pull the tape.";
  const answer = 'NVDA 🚀 closed down 0.4% (stocktitan).';
  const cite = answer.indexOf('(stocktitan)');
  const reply = responseOf(
    [
      { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'NVDA stock', sources: [{ type: 'url', url: 'https://www.stocktitan.net/' }] } },
      outputMessage(narration),
      { call_id: 'xs_1', type: 'custom_tool_call', name: 'x_keyword_search', input: '{"query":"NVDA since:2026-09-24","limit":"5"}', status: 'completed' },
      // The API counts characters: the emoji is one, two UTF-16 units.
      outputMessage(answer, [{ type: 'url_citation', url: 'https://www.stocktitan.net/', title: 'StockTitan', start_index: cite - 1, end_index: cite - 1 + '(stocktitan)'.length }]),
    ],
    'grok-4.7',
    { usage: { ...USAGE, num_server_side_tools_used: 2, server_side_tool_usage_details: { web_search_calls: 1, x_search_calls: 1, code_interpreter_calls: 0 } } },
  );
  await withFetch([reply, responseOf([outputMessage('cut')], 'gpt-5-mini', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })], async () => {
    const final = finalOf(await collect(grok().generate(request('grok-4.7'))));
    const text = final.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    assert.equal(text, `${narration}\n\n${answer}`);
    const [citation] = final.grounding!.citations!;
    assert.equal(text.slice(citation.start, citation.end), '(stocktitan)');
    assert.deepEqual({ url: citation.url, title: citation.title }, { url: 'https://www.stocktitan.net/', title: 'StockTitan' });
    assert.deepEqual(final.grounding!.searchQueries, [
      { tool: 'web_search', query: 'NVDA stock' },
      { tool: 'x_search', query: 'NVDA since:2026-09-24' },
    ]);
    const tools = responsesServerTools(final)!;
    assert.deepEqual(tools.calls.map((c) => c.name), ['web_search', 'x_keyword_search']);
    assert.deepEqual(tools.usage, { total: 2, web_search_calls: 1, x_search_calls: 1 });

    const cut = finalOf(await collect(gpt().generate(request('gpt-5-mini'))));
    assert.equal(cut.finishReason, 'max_tokens');
    assert.equal(responsesServerTools(cut), undefined);
  });
});

// ── Failures ─────────────────────────────────────────────────────────────────

test('setup failures and HTTP failures are finals, never throws', async () => {
  const saved = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    const out = await collect(new GrokAdapter({ model: 'grok-4.7' }).generate(request('grok-4.7')));
    assert.equal(out.length, 1);
    assert.deepEqual(finalOf(out).error, { code: 'MISSING_API_KEY', message: 'XAI_API_KEY is not set in environment.', retryable: false });
  } finally {
    if (saved !== undefined) process.env.XAI_API_KEY = saved;
  }
  await withFetch([400], async () => {
    const final = finalOf(await collect(gpt('gpt-4o').generate(request('gpt-4o'))));
    assert.equal(final.finishReason, 'error');
    assert.deepEqual([final.error!.code, final.error!.retryable, final.error!.status], ['OPENAI_ERROR', false, 400]);
    assert.ok(!final.error!.message.includes(OPENAI_KEY));
  });
});

test('in-stream failures carry a retry verdict when the event names a status or an error type', async () => {
  const failedEvent = (code: string) => ({ type: 'response.failed', response: { status: 'failed', error: { code, message: `failed: ${code}` } } });
  const cases: Array<[string, Answer, string, boolean, number?]> = [
    ['response.failed server_error', { sse: sseOf([{ type: 'response.output_text.delta', delta: 'Hal' }, failedEvent('server_error')]) }, 'OPENAI_STREAM_ERROR', true],
    ['response.failed rate_limit_exceeded', { sse: sseOf([failedEvent('rate_limit_exceeded')]) }, 'OPENAI_STREAM_ERROR', true],
    ['response.failed invalid_prompt', { sse: sseOf([failedEvent('invalid_prompt')]) }, 'OPENAI_STREAM_ERROR', false],
    ['a bare error event with a status', { sse: sseOf([{ type: 'error', status: 503, message: 'overloaded' }], true) }, 'OPENAI_STREAM_ERROR', true, 503],
    ['a bare error event that names nothing', { sse: sseOf([{ type: 'error', message: 'stream broke' }], true) }, 'OPENAI_STREAM_ERROR', false],
    // An SSE frame named `error` is thrown by the SDK as an APIError with no status.
    ['an `event: error` frame, server_error', { sse: sseOf([{ type: 'error', code: 'server_error', message: 'try again' }]) }, 'OPENAI_ERROR', true],
    ['an `event: error` frame, a request fault', { sse: sseOf([{ type: 'error', code: 'invalid_request_error', message: 'bad input' }]) }, 'OPENAI_ERROR', false],
  ];
  for (const [label, answer, code, retryable, status] of cases) {
    await withFetch([answer], async () => {
      const final = finalOf(await collect(gpt('gpt-4o').generate(request('gpt-4o', { stream: true }))));
      assert.equal(final.error?.code, code, label);
      assert.equal(final.error?.retryable, retryable, label);
      assert.equal(final.error?.status, status, label);
      assert.deepEqual(final.parts, [], `${label}: no half answer is stored`);
    });
  }
  // The verdict reaches FallbackLlm on the ADK path.
  await withFetch([{ sse: sseOf([failedEvent('server_error')]) }], async () => {
    const out = await collect(new GptLlm({ model: 'gpt-4o', apiKey: OPENAI_KEY, endpoint: DIRECT }).generateContentAsync(llmRequestOf('gpt-4o'), true));
    const last = out.at(-1)!;
    assert.equal(last.errorCode, 'OPENAI_STREAM_ERROR');
    assert.equal(isRetryableErrorResponse(last), true);
  });
  assert.deepEqual(streamErrorDecision({ type: 'error', error: { type: 'server_error' } }), { retryable: true });
  assert.deepEqual(streamErrorDecision(undefined), { retryable: false });
});

test('an abort ends the call at once, with the ordinary code and never retryable', async () => {
  // Before the call: nothing is sent.
  const early = new AbortController();
  early.abort();
  await withFetch([], async (sent) => {
    const final = finalOf(await collect(gpt().generate(request('gpt-5-mini', { signal: early.signal }))));
    assert.deepEqual(final.error, { code: 'OPENAI_ERROR', message: 'The OpenAI request was aborted.', retryable: false });
    assert.equal(sent.length, 0);
  });
  // Mid-stream, on a stream that never ends by itself.
  const controller = new AbortController();
  await withFetch([{ stall: sseOf([{ type: 'response.output_text.delta', delta: 'Hal' }]) }], async () => {
    const out: ModelResponse[] = [];
    for await (const r of grok().generate(request('grok-4.7', { stream: true, signal: controller.signal }))) {
      out.push(r);
      if (r.partial) controller.abort();
    }
    assert.deepEqual(out[0].parts, [{ type: 'text', text: 'Hal' }]);
    assert.deepEqual(finalOf(out).error, { code: 'XAI_ERROR', message: 'The xAI request was aborted.', retryable: false });
  });
});

// ── The ADK path: GptLlm and GrokLlm around the adapters ─────────────────────

function llmRequestOf(model: string, toolsDict: Record<string, unknown> = {}): LlmRequest {
  return { model, contents: [{ role: 'user', parts: [{ text: 'hello' }] }], toolsDict, config: {}, liveConnectConfig: {} } as unknown as LlmRequest;
}

test('GptLlm keeps the Responses usage meaning: the turn and the ledger count reasoning inside the output, as before', async () => {
  const run = async (llm: { generateContentAsync(r: LlmRequest, s?: boolean): AsyncGenerator<LlmResponse, void> }) => {
    const control = createTurnControl({ maxLlmCalls: 5 });
    const out = await withFetch([responseOf([outputMessage('hi')])], () => runWithTurnControl(control, () => collect(llm.generateContentAsync(llmRequestOf('gpt-5-mini')))));
    const counts = [control.inputTokens, control.outputTokens, control.thinkingTokens];
    control.dispose();
    return { usage: out.at(-1)!.usageMetadata, counts };
  };
  const gptLlm = await run(new GptLlm({ model: 'gpt-5-mini', apiKey: OPENAI_KEY, endpoint: DIRECT }));
  assert.equal(gptLlm.usage?.candidatesTokenCount, 7, 'output_tokens, reasoning included');
  assert.equal(gptLlm.usage?.thoughtsTokenCount, 4);
  assert.equal(gptLlm.usage?.promptTokenCount, 12);
  assert.equal(gptLlm.usage?.totalTokenCount, 19);
  assert.deepEqual(gptLlm.counts, [12, 7, 4]);
  // The bare shim writes Gemini's meaning, reasoning excluded: why GptLlm overrides it.
  const bare = await run(adkShim(gpt()));
  assert.deepEqual(bare.counts, [12, 3, 4]);
});

test('GrokLlm events keep the server-side tool record, and carry no groundingMetadata', async () => {
  const reply = responseOf(
    [
      { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'NVDA', sources: [{ type: 'url', url: 'https://example.com/' }] } },
      outputMessage('Down 0.4%.', [{ type: 'url_citation', url: 'https://example.com/', title: 'Example', start_index: 0, end_index: 4 }]),
    ],
    'grok-4.7',
    { usage: { ...USAGE, num_server_side_tools_used: 1, server_side_tool_usage_details: { web_search_calls: 1 } } },
  );
  for (const stream of [false, true]) {
    await withFetch([reply], async () => {
      const out = await collect(new GrokLlm({ model: 'grok-4.7', apiKey: XAI_KEY }).generateContentAsync(llmRequestOf('grok-4.7', { web_search: WEB_SEARCH }), stream));
      const final = out.at(-1) as LlmResponse;
      assert.equal(final.turnComplete, true);
      assert.deepEqual(final.customMetadata?.['responses.server_tool_calls'], [
        { name: 'web_search', args: { type: 'search', query: 'NVDA' }, status: 'completed', sources: ['https://example.com/'] },
      ]);
      assert.deepEqual(final.customMetadata?.['responses.server_tool_usage'], { total: 1, web_search_calls: 1 });
      assert.equal(final.groundingMetadata, undefined);
      assert.equal(final.content?.parts?.[0]?.text, 'Down 0.4%.');
    });
  }
});
