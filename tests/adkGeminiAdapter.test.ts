/**
 * tests/adkGeminiAdapter.test.ts — the temporary wrapper that serves Gemini
 * on the model contract through ADK's own Gemini (lib/models/
 * adkGeminiAdapter.ts, WS1-8).
 *
 * Every test runs the whole path: the adapter, the genai mapping, TracedGemini,
 * ADK's Gemini and the real @google/genai SDK, over a stubbed fetch. It
 * asserts the JSON that would reach the Gemini API and the contract responses
 * that come back: text, a stream, a tool call whose thought signature is
 * replayed on the next step, grounding, a 503 and a 400, an abort, and the
 * failures ADK reports as error codes. The adapter opens no span and charges
 * nothing (ADR 0053); the last group runs it behind the ADK shim, which does.
 *
 * Offline: no provider is called, and every key is an obvious fixture.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { LogLevel, setLogLevel } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { AdkGeminiAdapter } from '../lib/models/adkGeminiAdapter.ts';
import type { AdkGeminiAdapterOptions } from '../lib/models/adkGeminiAdapter.ts';
import { adkShim } from '../lib/models/adkShim.ts';
import { X_SEARCH } from '../lib/tools/xSearchTool.ts';
import type {
  FinalModelResponse,
  Message,
  ModelRequest,
  ModelResponse,
  PartialModelResponse,
  ToolCallPart,
  ToolDeclaration,
  UserMessage,
} from '../lib/models/contract.ts';
import { GEMINI_PROVIDER, MINTED_CALL_ID_PREFIX, THOUGHT_SIGNATURE_KIND } from '../lib/models/genaiMapping.ts';
import { setRetryPolicyOverrides } from '../lib/models/retry.ts';
import { onSpanEnd } from '../lib/observability/tracer.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';

setLogLevel(LogLevel.ERROR);

const KEY = 'fixture-gemini-key-0123456789';
const MODEL = 'gemini-3-flash';

const ENV_KEYS = [
  'GOOGLE_GENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_PLATFORM', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GEMINI_MODEL_MAP', 'MODEL_RETRY_MAX_ATTEMPTS',
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

// ── The stubbed fetch ────────────────────────────────────────────────────────

interface Captured {
  url: string;
  headers: Headers;
  body: any;
  signal?: AbortSignal;
}

type Reply = (init: RequestInit, call: number) => Response | Promise<Response>;

async function withFetch(reply: Reply, fn: (seen: Captured[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const seen: Captured[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)), signal: init.signal ?? undefined });
    return reply(init, seen.length);
  }) as typeof fetch;
  try {
    await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const candidate = (parts: object[], finishReason = 'STOP', extra: object = {}) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason, ...extra }],
});

// ── Driving the adapter ──────────────────────────────────────────────────────

function adapter(options: Partial<AdkGeminiAdapterOptions> = {}): AdkGeminiAdapter {
  return new AdkGeminiAdapter({ model: MODEL, apiKey: KEY, endpoint: { platform: 'direct' }, ...options });
}

interface Run {
  responses: ModelResponse[];
  partials: PartialModelResponse[];
  final: FinalModelResponse;
}

/** Drains one call, asserting the contract's shape: exactly one final, last, holding no thinking. */
async function run(a: AdkGeminiAdapter, request: Partial<ModelRequest> & { messages: Message[] }): Promise<Run> {
  const responses: ModelResponse[] = [];
  for await (const r of a.generate({ model: a.model, ...request })) responses.push(r);
  const finals = responses.filter((r): r is FinalModelResponse => !r.partial);
  assert.equal(finals.length, 1, 'exactly one final');
  assert.equal(responses.at(-1)?.partial, false, 'the final is last');
  for (const p of finals[0].parts) assert.notEqual((p as { type: string }).type, 'thinking', 'a final never holds thinking');
  return { responses, partials: responses.filter((r): r is PartialModelResponse => r.partial), final: finals[0] };
}

const user = (text: string): UserMessage => ({ role: 'user', parts: [{ type: 'text', text }] });

const LOOKUP: ToolDeclaration = {
  name: 'lookup',
  description: 'Looks a word up.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

const signature = (payload: string) => ({ provider: GEMINI_PROVIDER, kind: THOUGHT_SIGNATURE_KIND, model: MODEL, payload });

/** The llm.request spans that end while `fn` runs. */
async function spansOf(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const spans: Array<Record<string, unknown>> = [];
  const off = onSpanEnd((span) => {
    if (span.name === 'llm.request') spans.push({ ...span.attributes });
  });
  try {
    await fn();
  } finally {
    off();
  }
  return spans;
}

// ── Answers ──────────────────────────────────────────────────────────────────

test('text: one thinking partial, then one final with the text and usage; the request goes as ADK sends it', async () => {
  await withFetch(
    () => json({ ...candidate([{ text: 'Weighing it.', thought: true }, { text: 'A small feline.' }]), usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, thoughtsTokenCount: 3 } }),
    async (seen) => {
      const { partials, final } = await run(adapter(), {
        system: 'Be brief.',
        messages: [{ role: 'system', parts: [{ type: 'text', text: 'Answer in English.' }] }, user('What is a cat?')],
        reasoning: 'high',
        sampling: { temperature: 0.2, maxOutputTokens: 256, stop: ['END'] },
        outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      });
      assert.deepEqual(partials.map((p) => p.parts), [[{ type: 'thinking', text: 'Weighing it.' }]]);
      assert.deepEqual(final, { partial: false, parts: [{ type: 'text', text: 'A small feline.' }], finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 7, thinkingTokens: 3 } });

      assert.equal(seen.length, 1);
      const { url, headers, body } = seen[0];
      assert.match(url, /\/models\/gemini-3-flash:generateContent$/);
      assert.ok(!url.includes(KEY), 'the key is not in the URL');
      assert.equal(headers.get('x-goog-api-key'), KEY);
      assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be brief.' }, { text: 'Answer in English.' }] }, 'system messages join the system prompt');
      assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'What is a cat?' }] }], 'no system content reaches Gemini');
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH', includeThoughts: true });
      assert.equal(body.generationConfig.temperature, 0.2);
      assert.equal(body.generationConfig.maxOutputTokens, 256);
      assert.deepEqual(body.generationConfig.stopSequences, ['END']);
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.deepEqual(body.generationConfig.responseJsonSchema, { type: 'object', properties: { answer: { type: 'string' } } });
      assert.deepEqual(body.toolConfig, { includeServerSideToolInvocations: true }, 'as the compiler sends it on every Gemini agent');
      const raw = JSON.stringify(body);
      for (const absent of ['providerState', 'reasoningEffort', 'abortSignal']) assert.ok(!raw.includes(absent), `${absent} is not on the wire`);
    },
  );
});

test('no reasoning sends no thinking config, and reasoning none sends no includeThoughts', async () => {
  await withFetch(
    () => json(candidate([{ text: 'ok' }])),
    async (seen) => {
      await run(adapter(), { messages: [user('hi')] });
      await run(adapter(), { messages: [user('hi')], reasoning: 'none' });
      assert.equal(seen[0].body.generationConfig?.thinkingConfig, undefined);
      assert.deepEqual(seen[1].body.generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });
    },
  );
});

test('streaming: thinking and text deltas as partials, then exactly one final with the whole text', async () => {
  await withFetch(
    () =>
      sse([
        candidate([{ text: 'Weighing it.', thought: true }], ''),
        candidate([{ text: 'Cats ' }], ''),
        { ...candidate([{ text: 'purr.' }]), usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 3 } },
      ]),
    async (seen) => {
      const { partials, final } = await run(adapter(), { messages: [user('cats?')], stream: true, reasoning: 'low' });
      assert.match(seen[0].url, /:streamGenerateContent\?alt=sse$/);
      assert.deepEqual(
        partials.map((p) => p.parts),
        [[{ type: 'thinking', text: 'Weighing it.' }], [{ type: 'text', text: 'Cats ' }], [{ type: 'text', text: 'purr.' }]],
      );
      assert.deepEqual(final, { partial: false, parts: [{ type: 'text', text: 'Cats purr.' }], finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 5, thinkingTokens: 3 } });
    },
  );
});

// ── Tool calls and thought signatures ────────────────────────────────────────

test('a tool call with a thought signature is replayed on the next step; its minted id stays off the wire', async () => {
  const replies = [
    json({ ...candidate([{ functionCall: { name: 'lookup', args: { q: 'cat' } }, thoughtSignature: 'c2ln' }]), usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5 } }),
    json(candidate([{ text: 'A feline.', thoughtSignature: 'bmV4dA==' }])),
  ];
  await withFetch(
    (_init, n) => replies[n - 1],
    async (seen) => {
      const a = adapter();
      const first: Message[] = [user('What is a cat?')];
      const step1 = await run(a, { messages: first, tools: [LOOKUP] });
      const call = step1.final.parts[0] as ToolCallPart;
      assert.deepEqual(step1.final, {
        partial: false,
        parts: [{ type: 'toolCall', id: `${MINTED_CALL_ID_PREFIX}1-0`, name: 'lookup', args: { q: 'cat' }, providerState: signature('c2ln') }],
        finishReason: 'tool_call',
        usage: { inputTokens: 9, outputTokens: 5 },
      });
      assert.deepEqual(seen[0].body.tools, [{ functionDeclarations: [{ name: 'lookup', description: 'Looks a word up.', parametersJsonSchema: LOOKUP.parameters }] }]);
      assert.deepEqual(seen[0].body.toolConfig, { includeServerSideToolInvocations: true }, 'no choice and no strict tool: the provider default');

      const step2 = await run(a, {
        messages: [...first, { role: 'assistant', parts: step1.final.parts }, { role: 'tool', parts: [{ type: 'toolResult', id: call.id, name: 'lookup', result: { definition: 'a feline' } }] }],
        tools: [LOOKUP],
      });
      const { contents } = seen[1].body;
      assert.deepEqual(contents[1], { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'cat' } }, thoughtSignature: 'c2ln' }] }, 'the signature goes back on its part');
      assert.deepEqual(contents[2], { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { definition: 'a feline' } } }] });
      assert.ok(!JSON.stringify(seen[1].body).includes(MINTED_CALL_ID_PREFIX), 'a minted id is never sent');
      assert.deepEqual(step2.final.parts, [{ type: 'text', text: 'A feline.', providerState: signature('bmV4dA==') }]);
      assert.equal(step2.final.finishReason, 'stop');
    },
  );
});

test('tool choice and strict tools map to the function-calling mode', async () => {
  await withFetch(
    () => json(candidate([{ text: 'ok' }])),
    async (seen) => {
      await run(adapter(), { messages: [user('hi')], tools: [{ ...LOOKUP, strict: true }] });
      await run(adapter(), { messages: [user('hi')], tools: [LOOKUP], toolChoice: { name: 'lookup' } });
      await run(adapter(), { messages: [user('hi')], tools: [LOOKUP], toolChoice: 'none' });
      assert.deepEqual(seen.map((s) => s.body.toolConfig), [
        { functionCallingConfig: { mode: 'VALIDATED' }, includeServerSideToolInvocations: true },
        { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] }, includeServerSideToolInvocations: true },
        { functionCallingConfig: { mode: 'NONE' }, includeServerSideToolInvocations: true },
      ]);
    },
  );
});

test("history: adk- ids and another provider's state stay off the wire, and the caller's request is not changed", async () => {
  const messages: Message[] = [
    user('look in the attic'),
    {
      role: 'assistant',
      parts: [{ type: 'toolCall', id: 'adk-7f3', name: 'look', args: { where: 'attic' }, providerState: { provider: 'anthropic', kind: 'thinking_blocks', model: 'claude-opus-5-5', payload: [{ type: 'thinking' }] } }],
    },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'adk-7f3', name: 'look', result: 'a box' }] },
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'and this chart?' },
        // A blob with a display name rides whole; ADK clears the name in place on the Gemini API.
        { type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=', providerState: { provider: GEMINI_PROVIDER, kind: 'genai_part', payload: { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=', displayName: 'chart.png' } } } },
      ],
    },
  ];
  const before = structuredClone(messages);
  await withFetch(
    () => json(candidate([{ text: 'A box and a chart.' }])),
    async (seen) => {
      await run(adapter(), { messages });
      const { contents } = seen[0].body;
      assert.deepEqual(contents[1], { role: 'model', parts: [{ functionCall: { name: 'look', args: { where: 'attic' } } }] });
      assert.deepEqual(contents[2], { role: 'user', parts: [{ functionResponse: { name: 'look', response: { result: 'a box' } } }] });
      assert.deepEqual(contents[3].parts[1], { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, "ADK's Gemini API path drops the display name");
      const raw = JSON.stringify(seen[0].body);
      assert.ok(!raw.includes('adk-7f3') && !raw.includes('thinking_blocks'));
    },
  );
  assert.deepEqual(messages, before, "the caller's history is unchanged, the carried part's display name included");
});

// ── Grounding ────────────────────────────────────────────────────────────────

test("grounding: googleSearch is sent, and the grounding metadata reaches the final's grounding", async () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  try {
    await withFetch(
      () =>
        json(
          candidate([{ text: 'The VIX is at 22.4.' }], 'STOP', {
            groundingMetadata: {
              webSearchQueries: ['vix today'],
              groundingChunks: [{ web: { uri: 'https://a.example/vix', title: 'VIX' } }, { web: { uri: 'https://a.example/vix', title: 'VIX' } }, { web: { uri: 'https://b.example/' } }],
              groundingSupports: [{ segment: { startIndex: 0, endIndex: 19 }, groundingChunkIndices: [0] }],
            },
          }),
        ),
      async (seen) => {
        let final!: FinalModelResponse;
        const spans = await spansOf(async () => {
          ({ final } = await run(adapter(), { messages: [user('where is the vix?')], nativeTools: ['web_search', 'x_search', 'url_context'] }));
        });
        assert.deepEqual(seen[0].body.tools, [{ googleSearch: {} }, { urlContext: {} }]);
        assert.deepEqual(final.parts, [{ type: 'text', text: 'The VIX is at 22.4.' }]);
        assert.deepEqual(final.grounding, {
          citations: [{ url: 'https://a.example/vix', title: 'VIX' }, { url: 'https://b.example/' }],
          searchQueries: [{ tool: 'web_search', query: 'vix today' }],
        });
        assert.equal(spans.length, 0, 'the adapter opens no span of its own (ADR 0053)');
        assert.deepEqual(warnings, ['⚠ x_search is not a Gemini tool; gemini-3-flash runs without it.']);
      },
    );
  } finally {
    console.warn = warn;
  }
});

// ── Failures ─────────────────────────────────────────────────────────────────

test('a 503 is retried before the first chunk, then is a GEMINI_ERROR final, retryable, with its status', async () => {
  await withFetch(
    () => json({ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }, 503),
    async (seen) => {
      let final!: FinalModelResponse;
      const spans = await spansOf(async () => {
        ({ final } = await run(adapter(), { messages: [user('hi')] }));
      });
      assert.equal(seen.length, 3, 'three attempts in all');
      assert.equal(final.error?.code, 'GEMINI_ERROR');
      assert.equal(final.error?.retryable, true);
      assert.equal(final.error?.status, 503);
      assert.match(final.error?.message ?? '', /overloaded/);
      assert.equal(final.finishReason, 'error');
      assert.deepEqual(final.parts, []);
      assert.equal(spans.length, 0, 'the adapter opens no span of its own (ADR 0053)');
    },
  );
  // A transient failure that clears answers.
  const replies = [json({ error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } }, 503), json(candidate([{ text: 'Here.' }]))];
  await withFetch(
    (_init, n) => replies[n - 1],
    async () => {
      const { final } = await run(adapter(), { messages: [user('hi')] });
      assert.deepEqual(final.parts, [{ type: 'text', text: 'Here.' }]);
      assert.equal(final.error, undefined);
    },
  );
});

test('a 400 is not retried: a GEMINI_ERROR final, not retryable, and its message carries no key', async () => {
  const google = 'AIza' + 'S'.repeat(35);
  await withFetch(
    () => json({ error: { code: 400, message: `API key not valid: ${KEY} (${google}).`, status: 'INVALID_ARGUMENT' } }, 400),
    async (seen) => {
      const { final } = await run(adapter(), { messages: [user('hi')] });
      assert.equal(seen.length, 1);
      assert.equal(final.error?.code, 'GEMINI_ERROR');
      assert.equal(final.error?.retryable, false);
      assert.equal(final.error?.status, 400);
      assert.match(final.error?.message ?? '', /API key not valid/);
      assert.ok(!final.error?.message.includes(KEY), 'the key in use is scrubbed');
      assert.ok(!final.error?.message.includes(google), 'a Google-shaped key is scrubbed');
    },
  );
});

test("an error code ADK yields is the final's error: a withheld answer, a blocked prompt; ADK's STOP is no error", async () => {
  const replies = [
    json(candidate([], 'SAFETY')),
    json({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
    json(candidate([], 'STOP')),
    json(candidate([], 'MAX_TOKENS')),
    json(candidate([{ text: 'Some of it' }], 'SAFETY')),
    sse([candidate([{ text: 'Some of it' }], ''), candidate([], 'SAFETY')]),
  ];
  await withFetch(
    (_init, n) => replies[n - 1],
    async () => {
      const a = adapter();
      const withheld = (await run(a, { messages: [user('1')] })).final;
      assert.deepEqual(withheld, { partial: false, parts: [], finishReason: 'content_filter', error: { code: 'SAFETY', message: 'The model call ended with SAFETY.', retryable: false } });
      const blocked = (await run(a, { messages: [user('2')] })).final;
      assert.equal(blocked.error?.code, 'PROHIBITED_CONTENT');
      assert.equal(blocked.error?.retryable, false);
      assert.equal(blocked.finishReason, 'content_filter');
      assert.deepEqual((await run(a, { messages: [user('3')] })).final, { partial: false, parts: [], finishReason: 'stop' }, 'an empty STOP');
      const cut = (await run(a, { messages: [user('4')] })).final;
      assert.equal(cut.error?.code, 'MAX_TOKENS');
      assert.equal(cut.finishReason, 'max_tokens');

      // ADK makes a policy finish an error only on an empty candidate or at a stream's end.
      const kept = (await run(a, { messages: [user('5')] })).final;
      assert.deepEqual(kept, { partial: false, parts: [{ type: 'text', text: 'Some of it' }], finishReason: 'content_filter' });
      const streamed = (await run(a, { messages: [user('6')], stream: true })).final;
      assert.deepEqual(streamed.parts, [{ type: 'text', text: 'Some of it' }]);
      assert.equal(streamed.error?.code, 'SAFETY');
      assert.equal(streamed.finishReason, 'content_filter');
    },
  );
});

test('an abort: a signal aborted before the call sends nothing; during it, the fetch sees it and the call ends at once', async () => {
  await withFetch(
    () => json(candidate([{ text: 'never' }])),
    async (seen) => {
      const controller = new AbortController();
      controller.abort();
      const { final } = await run(adapter(), { messages: [user('hi')], signal: controller.signal });
      assert.equal(seen.length, 0, 'nothing is sent');
      assert.deepEqual(final, { partial: false, parts: [], finishReason: 'error', error: { code: 'GEMINI_ERROR', message: 'The Gemini request was aborted.', retryable: false } });
    },
  );

  const controller = new AbortController();
  await withFetch(
    (init) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
        setTimeout(() => controller.abort(), 5);
      }),
    async (seen) => {
      const { final } = await run(adapter(), { messages: [user('hi')], signal: controller.signal });
      assert.equal(seen.length, 1, 'an abort is never retried');
      assert.equal(seen[0].signal?.aborted, true, "the SDK's fetch saw the abort");
      assert.equal(final.error?.code, 'GEMINI_ERROR');
      assert.equal(final.error?.retryable, false);
    },
  );

  // A transport that ignores the abort does not hold the caller.
  const stalled = new AbortController();
  await withFetch(
    () => {
      setTimeout(() => stalled.abort(), 5);
      return new Promise<Response>(() => {});
    },
    async () => {
      const { final } = await run(adapter(), { messages: [user('hi')], signal: stalled.signal });
      assert.equal(final.error?.code, 'GEMINI_ERROR');
      assert.equal(final.error?.retryable, false);
    },
  );
});

// ── Behind the ADK shim (ADR 0053) ───────────────────────────────────────────

test('behind the ADK shim: one span per call, tagged by the adapter; a spent step budget never reaches it', async () => {
  const warn = console.warn;
  console.warn = () => {};
  const llmRequest = {
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: 'where is the vix?' }] }],
    config: { tools: [{ googleSearch: {} }] },
    toolsDict: { x_search: X_SEARCH },
    liveConnectConfig: {},
  } as unknown as LlmRequest;
  const control = createTurnControl({ maxLlmCalls: 1 });
  try {
    await withFetch(
      () => json({ ...candidate([{ text: 'The VIX is at 22.4.' }], 'STOP', { groundingMetadata: { webSearchQueries: ['vix today'] } }), usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 6 } }),
      async (seen) => {
        const shim = adkShim(adapter());
        const first: LlmResponse[] = [];
        const second: LlmResponse[] = [];
        const spans = await spansOf(() =>
          runWithTurnControl(control, async () => {
            for await (const r of shim.generateContentAsync(llmRequest)) first.push(r);
            for await (const r of shim.generateContentAsync(llmRequest)) second.push(r);
          }),
        );
        assert.equal(seen.length, 1, 'the refused call never reaches Gemini');
        assert.equal(spans.length, 1, 'one span for the call, opened by the shim');
        assert.equal(spans[0]['llm.provider'], 'gemini');
        assert.equal(spans[0]['llm.web_search.native'], true, "TracedGemini's tag, on the shim's span");
        assert.equal(spans[0]['llm.capability.dropped'], 'x_search');
        assert.equal(spans[0]['llm.tokens.input'], 8);
        assert.equal(spans[0]['llm.tokens.output'], 6);
        assert.deepEqual(first.at(-1)?.content, { role: 'model', parts: [{ text: 'The VIX is at 22.4.' }] });
        assert.deepEqual(first.at(-1)?.groundingMetadata, { webSearchQueries: ['vix today'] });
        assert.equal(second.length, 1);
        assert.equal(second[0].errorCode, 'STEP_LIMIT');
        assert.equal(control.llmCalls, 1, 'charged once');
      },
    );
  } finally {
    control.dispose();
    console.warn = warn;
  }
});

test('setup failures are finals: no key, an incomplete Vertex AI endpoint, a platform Gemini lacks', async () => {
  const noKey = await run(new AdkGeminiAdapter({ model: MODEL, endpoint: { platform: 'direct' } }), { messages: [user('hi')] });
  assert.equal(noKey.final.error?.code, 'MISSING_API_KEY');
  assert.equal(noKey.final.error?.retryable, false);
  const vertex = await run(new AdkGeminiAdapter({ model: MODEL, endpoint: { platform: 'vertex' } }), { messages: [user('hi')] });
  assert.equal(vertex.final.error?.code, 'ENDPOINT_MISCONFIGURED');
  assert.match(vertex.final.error?.message ?? '', /Vertex AI/);
  const bedrock = await run(new AdkGeminiAdapter({ model: MODEL, endpoint: { platform: 'bedrock' } }), { messages: [user('hi')] });
  assert.equal(bedrock.final.error?.code, 'ENDPOINT_MISCONFIGURED');
});

test('the adapter reports Gemini and the model as the YAML names it', () => {
  const a = adapter();
  assert.equal(a.provider, 'gemini');
  assert.equal(a.model, MODEL);
});
