/**
 * tests/models.test.ts — offline tests for model optionality.
 *
 * Everything here runs with NO network and NO API keys:
 *   - schema normalization (the Gemini-uppercase → lowercase bridge)
 *   - model-name → provider routing (the prefix table)
 *   - provider availability gating (env-based, registration is pure)
 *   - adapter usage/thinking extraction against a stubbed fetch
 *   - the web_search tool's per-provider request shaping
 *
 * The adapters are driven on the engine's contract (lib/models/contract.ts,
 * ADR 0048): a ModelRequest in, the wire body and the ModelResponses out,
 * so the native runtime inherits every case. Under ADK each adapter runs
 * behind its shim class (OllamaLlm, KimiLlm, GatewayLlm, GrokLlm, GptLlm,
 * ClaudeLlm), which tests/shimBodies.test.ts holds to the same bodies.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { setLogLevel, LogLevel, LlmAgent, AgentTool, LOAD_MEMORY } from '@google/adk';

import type { FinalModelResponse, ModelAdapter, ModelRequest, ModelResponse, ToolDeclaration } from '../lib/models/contract.ts';
import { contractToolDeclaration, toLowercaseJsonSchema } from '../lib/models/schemaNormalize.ts';
import {
  providerForModel,
  providerKeyPresent,
  providerStatuses,
  resolveModel,
} from '../lib/models/registry.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { GrokLlm } from '../lib/models/grokLlm.ts';
import { KimiLlm } from '../lib/models/kimiLlm.ts';
import { ClaudeLlm } from '../lib/models/claudeLlm.ts';
import { GptLlm } from '../lib/models/gptLlm.ts';
import { anthropicTools } from '../lib/models/claudeAdapter.ts';
import {
  GptAdapter,
  extractServerToolCalls,
  responsesInput,
  responsesServerTools,
  serverToolUsage,
  streamEventDelta,
} from '../lib/models/gptAdapter.ts';
import { GrokAdapter } from '../lib/models/grokAdapter.ts';
import { OllamaAdapter } from '../lib/models/ollamaAdapter.ts';
import { KimiAdapter } from '../lib/models/kimiAdapter.ts';
import { GatewayAdapter } from '../lib/models/gatewayAdapter.ts';
import type { ChatCompletionsRequest } from '../lib/models/chatCompletionsAdapter.ts';
import { splitThinkBlocks, ThinkStreamSplitter } from '../lib/models/chatCompletionsAdapter.ts';
import { mapUsage } from '../lib/models/openAiCompatibleLlm.ts';
import { captureBody } from './helpers/capabilityInputs.ts';

setLogLevel(LogLevel.WARN);

/** A minimal ModelRequest: one user turn. */
function makeRequest(overrides: Partial<ChatCompletionsRequest> = {}): ChatCompletionsRequest {
  return {
    model: 'ollama/qwen3:8b',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  };
}

async function collect(gen: AsyncIterable<ModelResponse>): Promise<ModelResponse[]> {
  const out: ModelResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

/** The one final a call ends with (contract rule 4: exactly one, last). */
function finalOf(responses: ModelResponse[]): FinalModelResponse {
  const final = responses.at(-1);
  assert.ok(final && !final.partial, 'the call ends on a final');
  return final;
}

/** The final's text, its text parts joined. */
const textOf = (final: FinalModelResponse) => final.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

/** The text of every partial's thinking parts, in order. */
const thinkingOf = (responses: ModelResponse[]) =>
  responses.flatMap((r) => (r.partial ? r.parts.filter((p) => p.type === 'thinking').map((p) => p.text) : []));

/** Runs `adapter` on `request`, streaming when asked. */
const run = (adapter: ModelAdapter, request: ModelRequest, stream = false) => collect(adapter.generate({ ...request, stream }));

/** The body the row's adapter posts for `request` (fixture keys, fetch answering 400). */
const gptBody = (request: ModelRequest) => captureBody('openai', () => new GptAdapter({ model: request.model }).generate(request));
const grokBody = (request: ModelRequest) => captureBody('xai', () => new GrokAdapter({ model: request.model }).generate(request));

// ── Schema normalization ─────────────────────────────────────────────────────

test('toLowercaseJsonSchema lowercases types deeply, preserving enum/description', () => {
  const gemini = {
    type: 'OBJECT',
    properties: {
      topic: { type: 'STRING', description: 'The topic', enum: ['A', 'B'] },
      depth: { type: 'INTEGER' },
      tags: { type: 'ARRAY', items: { type: 'STRING' } },
      nested: {
        type: 'OBJECT',
        properties: { flag: { type: 'BOOLEAN' } },
        required: ['flag'],
      },
    },
    required: ['topic'],
  };
  const normalized = toLowercaseJsonSchema(gemini) as any;
  assert.equal(normalized.type, 'object');
  assert.equal(normalized.properties.topic.type, 'string');
  assert.deepEqual(normalized.properties.topic.enum, ['A', 'B']); // enum values keep casing
  assert.equal(normalized.properties.topic.description, 'The topic');
  assert.equal(normalized.properties.tags.items.type, 'string');
  assert.equal(normalized.properties.nested.properties.flag.type, 'boolean');
  assert.deepEqual(normalized.required, ['topic']);
  // Never mutates the input — a Gemini agent may share the object.
  assert.equal(gemini.type, 'OBJECT');
  assert.equal(gemini.properties.nested.properties.flag.type, 'BOOLEAN');
});

test('toLowercaseJsonSchema handles type arrays and non-object input', () => {
  const schema = { type: ['STRING', 'NULL'] };
  assert.deepEqual((toLowercaseJsonSchema(schema) as any).type, ['string', 'null']);
  assert.deepEqual(toLowercaseJsonSchema(undefined), { type: 'object', properties: {} });
});

// ── Provider routing ─────────────────────────────────────────────────────────

test('providerForModel maps every prefix to its provider', () => {
  assert.equal(providerForModel('claude-sonnet-4-6'), 'anthropic');
  assert.equal(providerForModel('gpt-5-mini'), 'openai');
  assert.equal(providerForModel('o4-mini'), 'openai');
  assert.equal(providerForModel('grok-4-1-fast-reasoning'), 'xai');
  assert.equal(providerForModel('kimi-k3'), 'moonshot');
  assert.equal(providerForModel('kimi-k2.7-code-highspeed'), 'moonshot');
  assert.equal(providerForModel('ollama/qwen3:8b'), 'ollama');
  assert.equal(providerForModel('gemini-3.5-flash-lite'), 'gemini');
  assert.equal(providerForModel('something-unknown'), 'gemini'); // ADK-native default
});

test('resolveModel returns the right adapter instance; model id wins over header', () => {
  assert.ok(resolveModel('ollama/qwen3:8b', { defaultProvider: 'anthropic' }) instanceof OllamaLlm);
  assert.ok(resolveModel('claude-sonnet-4-6') instanceof ClaudeLlm);
  assert.ok(resolveModel('grok-4-1-fast-reasoning') instanceof GrokLlm);
  assert.ok(resolveModel('gpt-5-mini') instanceof GptLlm);
  assert.ok(resolveModel('kimi-k3') instanceof KimiLlm);
});

test('resolveModel uses the deprecated provider header only when model is absent', () => {
  assert.ok(resolveModel(undefined, { defaultProvider: 'ollama' }) instanceof OllamaLlm);
  assert.ok(resolveModel(undefined, { defaultProvider: 'anthropic' }) instanceof ClaudeLlm);
});

test('providerStatuses reflects env keys; ollama is always available', () => {
  const saved = { ...process.env };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const off = Object.fromEntries(providerStatuses().map((s) => [s.provider, s.available]));
    assert.deepEqual(off, { gemini: false, anthropic: false, openai: false, xai: false, moonshot: false, ollama: true });

    process.env.XAI_API_KEY = 'test-key';
    assert.equal(providerKeyPresent('xai'), true);
    process.env.GEMINI_API_KEY = 'test-key'; // either Gemini env name counts
    assert.equal(providerKeyPresent('gemini'), true);
  } finally {
    process.env = saved;
  }
});

// ── Chat-completions base: reasoning + usage extraction ─────────────────────

test('splitThinkBlocks separates the scratchpad from the answer', () => {
  const { reasoning, answer } = splitThinkBlocks('<think>step 1\nstep 2</think>The answer.');
  assert.equal(reasoning, 'step 1\nstep 2');
  assert.equal(answer, 'The answer.');
  assert.deepEqual(splitThinkBlocks('plain'), { reasoning: '', answer: 'plain' });
});

test('ThinkStreamSplitter routes deltas and survives a tag split mid-chunk', () => {
  const s = new ThinkStreamSplitter();
  // The opening tag arrives in three pieces, so nothing may be emitted as
  // answer text until it is resolved — this is the case the regex cannot see.
  assert.deepEqual(s.push('<th'), { reasoning: '', answer: '' });
  assert.deepEqual(s.push('in'), { reasoning: '', answer: '' });
  assert.deepEqual(s.push('k>weigh'), { reasoning: 'weigh', answer: '' });
  assert.deepEqual(s.push('ing it'), { reasoning: 'ing it', answer: '' });
  // Closing tag split too; the text before it is still scratchpad.
  assert.deepEqual(s.push(' done</thi'), { reasoning: ' done', answer: '' });
  assert.deepEqual(s.push('nk>Hello'), { reasoning: '', answer: 'Hello' });
  assert.deepEqual(s.push(' world'), { reasoning: '', answer: ' world' });
  assert.deepEqual(s.flush(), { reasoning: '', answer: '' });
});

test('ThinkStreamSplitter passes untagged text straight through', () => {
  const s = new ThinkStreamSplitter();
  assert.deepEqual(s.push('just an answer'), { reasoning: '', answer: 'just an answer' });
  assert.deepEqual(s.flush(), { reasoning: '', answer: '' });
});

test('ThinkStreamSplitter flushes a held partial tag that never completed', () => {
  const s = new ThinkStreamSplitter();
  // "<thi" looks like the start of a tag, so it is withheld...
  assert.deepEqual(s.push('answer<thi'), { reasoning: '', answer: 'answer' });
  // ...and released as ordinary text once the stream ends without the tag.
  assert.deepEqual(s.flush(), { reasoning: '', answer: '<thi' });
});

test('mapUsage maps OpenAI-style usage to GenAI usageMetadata', () => {
  assert.deepEqual(
    mapUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 5 },
    }),
    { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 30 },
  );
  assert.equal(mapUsage(undefined), undefined);
});

test('OllamaAdapter yields the thinking, the answer and the usage from a stubbed response', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestBody: any;
  globalThis.fetch = (async (url: any, init: any) => {
    requestedUrl = String(url);
    requestBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '<think>pondering</think>An answer.' } }],
        usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
      }),
      { status: 200 },
    );
  }) as any;
  try {
    const responses = await run(new OllamaAdapter({ model: 'ollama/qwen3:8b' }), makeRequest());

    assert.deepEqual(thinkingOf(responses), ['pondering']);
    const final = finalOf(responses);
    assert.equal(textOf(final), 'An answer.');
    assert.equal(final.usage?.inputTokens, 12);
    assert.equal(final.usage?.outputTokens, 34);

    assert.match(requestedUrl, /\/chat\/completions$/);
    assert.equal(requestBody.model, 'qwen3:8b'); // ollama/ namespace stripped
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Moonshot Kimi: the reasoning controls per generation ────────────────────

/** The body KimiAdapter posts for one request, captured from a stubbed fetch. */
async function kimiBody(model: string, fields: Partial<ChatCompletionsRequest> = {}): Promise<any> {
  const originalFetch = globalThis.fetch;
  const savedKey = process.env.MOONSHOT_API_KEY;
  process.env.MOONSHOT_API_KEY = 'fixture-moonshot-0123456789abcdef'; // gitleaks:allow (test fixture)
  let url = '';
  let body: any;
  globalThis.fetch = (async (u: any, init: any) => {
    url = String(u);
    body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'An answer.', reasoning_content: 'pondering' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, completion_tokens_details: { reasoning_tokens: 3 } },
      }),
      { status: 200 },
    );
  }) as any;
  try {
    const responses = await run(new KimiAdapter({ model }), makeRequest({ model, ...fields }));
    const final = finalOf(responses);
    assert.equal(textOf(final), 'An answer.');
    assert.equal(final.usage?.thinkingTokens, 3);
    assert.deepEqual(thinkingOf(responses), ['pondering'], 'reasoning_content surfaces as thinking');
    assert.equal(url, 'https://api.moonshot.ai/v1/chat/completions');
    return body;
  } finally {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = savedKey;
  }
}

test('KimiAdapter: kimi-k3 pins reasoning_effort below max, keeps an explicit effort, and never sends a thinking switch', async () => {
  const pinned = await kimiBody('kimi-k3');
  assert.equal(pinned.model, 'kimi-k3');
  assert.equal(pinned.reasoning_effort, 'high');
  assert.ok(!('thinking' in pinned));
  // `max` is no contract level: the ADK path carries it as the older spelling (ADR 0057).
  assert.equal((await kimiBody('kimi-k3', { olderSpelling: { reasoningEffort: 'max' } })).reasoning_effort, 'max');
  // K3 cannot switch thinking off: "none" becomes the lightest effort.
  assert.equal((await kimiBody('kimi-k3', { reasoning: 'none' })).reasoning_effort, 'low');
});

test('KimiAdapter: the K2 generation takes a thinking switch and no reasoning_effort', async () => {
  const on = await kimiBody('kimi-k2.6', { reasoning: 'low' });
  assert.ok(!('reasoning_effort' in on), 'reasoning_effort is K3-only');
  assert.ok(!('thinking' in on), 'thinking stays on by default');
  const off = await kimiBody('kimi-k2.6', { reasoning: 'none' });
  assert.deepEqual(off.thinking, { type: 'disabled' });
  assert.deepEqual((await kimiBody('kimi-k2.6', { reasoning: { budget_tokens: 0 } })).thinking, { type: 'disabled' });
});

test('KimiAdapter: without a key the call ends before any request', async () => {
  const saved = process.env.MOONSHOT_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  try {
    const responses = await run(new KimiAdapter({ model: 'kimi-k3' }), makeRequest({ model: 'kimi-k3' }));
    assert.equal(finalOf(responses).error?.code, 'MOONSHOT_MISSING_KEY');
  } finally {
    if (saved !== undefined) process.env.MOONSHOT_API_KEY = saved;
  }
});

/** One SSE frame, in the wire shape Ollama actually emits. */
const sseFrame = (o: any) => `data: ${JSON.stringify(o)}\n\n`;

test('OllamaAdapter (SSE) streams reasoning and text, then repeats the whole text on the final', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  const body =
    sseFrame({ choices: [{ index: 0, delta: { reasoning: 'weigh' } }] }) +
    sseFrame({ choices: [{ index: 0, delta: { reasoning: 'ing it' } }] }) +
    sseFrame({ choices: [{ index: 0, delta: { content: 'Hello' } }] }) +
    sseFrame({ choices: [{ index: 0, delta: { content: ' world' } }] }) +
    sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
    sseFrame({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 136, total_tokens: 156 } }) +
    'data: [DONE]\n\n';
  globalThis.fetch = (async (_url: any, init: any) => {
    requestBody = JSON.parse(init.body);
    return new Response(body, { status: 200 });
  }) as any;
  try {
    const responses = await run(new OllamaAdapter({ model: 'ollama/qwen3:8b' }), makeRequest(), true);

    assert.equal(requestBody.stream, true);
    assert.deepEqual(requestBody.stream_options, { include_usage: true });

    // Thinking only ever travels on partials — what keeps it out of history.
    assert.deepEqual(thinkingOf(responses), ['weigh', 'ing it']);

    const streamedText = responses.flatMap((r) => (r.partial ? r.parts.filter((p) => p.type === 'text').map((p) => p.text) : []));
    assert.deepEqual(streamedText, ['Hello', ' world']);

    // The final is the ONLY response ADK persists (runner: `if
    // (!event.partial) appendEvent(...)`), so it must carry the whole
    // reply — otherwise the turn renders on screen and vanishes from history.
    const final = finalOf(responses);
    assert.equal(responses.filter((r) => !r.partial).length, 1, 'exactly one final');
    assert.equal(textOf(final), 'Hello world');
    assert.equal(final.usage?.inputTokens, 20);
    assert.equal(final.usage?.outputTokens, 136);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('splitThinkBlocks treats a <think> block that never closed as scratchpad, not reply', () => {
  assert.deepEqual(splitThinkBlocks('<think>counting words, P1: 79 words'), {
    reasoning: 'counting words, P1: 79 words',
    answer: '',
  });
  assert.deepEqual(splitThinkBlocks('<think>a</think>Partial reply <think>b'), {
    reasoning: 'a\n\nb',
    answer: 'Partial reply',
  });
});

// The wire shape a thinking model returns when its scratchpad fills Ollama's
// 4,096-token window: reasoning in its own field, no content, "length".
// Captured from ollama 0.31.1 serving qwen3.5:9b on the model_zoo explainer.
const thinkingOnlyChoice = {
  finish_reason: 'length',
  message: { role: 'assistant', content: '', reasoning: 'P1: 79 words. Total: ~224? Too high. I need' },
};
const contextFullUsage = { prompt_tokens: 318, completion_tokens: 3778, total_tokens: 4096 };

/** Every response, in order: the call ends on a named error final, its tokens counted. */
function assertNamedMaxTokensError(responses: ModelResponse[], thinkingTokens = 3778): void {
  const final = finalOf(responses);
  assert.equal(final.error?.code, 'OLLAMA_MAX_TOKENS');
  assert.match(final.error!.message, /context window/);
  assert.match(final.error!.message, /num_ctx/);
  assert.match(final.error!.message, /reasoningEffort/);
  assert.equal(final.usage?.outputTokens, thinkingTokens, 'tokens spent thinking are still counted');
  assert.ok(thinkingOf(responses).length > 0, 'the scratchpad is still surfaced as thinking');
}

test('OllamaAdapter: a reply lost to thinking, and lost again without thinking, is a named error, not empty text', async () => {
  const originalFetch = globalThis.fetch;
  const efforts: unknown[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    efforts.push(JSON.parse(init.body).reasoning_effort);
    return new Response(JSON.stringify({ choices: [thinkingOnlyChoice], usage: contextFullUsage }), {
      status: 200,
    });
  }) as any;
  try {
    // Retried once with thinking off; both attempts' tokens are counted.
    assertNamedMaxTokensError(await run(new OllamaAdapter({ model: 'ollama/qwen3.5:9b' }), makeRequest()), 2 * 3778);
    assert.deepEqual(efforts, [undefined, 'none']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaAdapter (SSE): a stream that ends inside the scratchpad is a named error, not empty text', async () => {
  const originalFetch = globalThis.fetch;
  const body =
    sseFrame({ choices: [{ index: 0, delta: { reasoning: 'P1: 79 words. ' } }] }) +
    sseFrame({ choices: [{ index: 0, delta: { reasoning: 'Too high. I need' } }] }) +
    sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) +
    sseFrame({ choices: [], usage: contextFullUsage }) +
    'data: [DONE]\n\n';
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as any;
  try {
    assertNamedMaxTokensError(await run(new OllamaAdapter({ model: 'ollama/qwen3.5:9b' }), makeRequest(), true), 2 * 3778);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaAdapter (SSE): an unclosed <think> in content stays thinking; the call errors instead of replying with it', async () => {
  const originalFetch = globalThis.fetch;
  const body =
    sseFrame({ choices: [{ index: 0, delta: { content: '<think>weighing' } }] }) +
    sseFrame({ choices: [{ index: 0, delta: { content: ' it all' } }] }) +
    sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) +
    'data: [DONE]\n\n';
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as any;
  try {
    const responses = await run(new OllamaAdapter({ model: 'ollama/qwen3.5:9b' }), makeRequest(), true);
    const leaked = responses.some((r) => r.parts.some((p) => p.type === 'text' && /think|weighing/.test(p.text)));
    assert.ok(!leaked, 'scratchpad text must never reach the reply');
    assert.equal(finalOf(responses).error?.code, 'OLLAMA_MAX_TOKENS');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaAdapter: a reply cut short keeps its text and finishes on max_tokens; one that stopped finishes on stop', async () => {
  const originalFetch = globalThis.fetch;
  let finish = 'length';
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ finish_reason: finish, message: { content: 'Quantum mechanics is', reasoning: 'brief' } }],
      }),
      { status: 200 },
    )) as any;
  try {
    const adapter = new OllamaAdapter({ model: 'ollama/qwen3.5:9b' });
    let final = finalOf(await run(adapter, makeRequest()));
    assert.equal(final.error, undefined);
    assert.equal(textOf(final), 'Quantum mechanics is');
    assert.equal(final.finishReason, 'max_tokens');

    finish = 'stop';
    final = finalOf(await run(adapter, makeRequest()));
    assert.equal(final.finishReason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat-completions adapters: thinking that stops with no reply is EMPTY_RESPONSE; a bare empty turn is untouched', async () => {
  const originalFetch = globalThis.fetch;
  let message: any = { content: '<think>nothing to add</think>' };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message }] }), { status: 200 })) as any;
  try {
    const adapter = new OllamaAdapter({ model: 'ollama/qwen3.5:9b' });
    let final = finalOf(await run(adapter, makeRequest()));
    assert.equal(final.error?.code, 'OLLAMA_EMPTY_RESPONSE');

    // No reasoning, no truncation: e.g. a model with nothing to say after a
    // tool result. The runtime already handles that shape; it must not become an error.
    message = { content: '' };
    final = finalOf(await run(adapter, makeRequest()));
    assert.equal(final.error, undefined);
    assert.deepEqual(final.parts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaAdapter (SSE) reassembles tool-call arguments split across frames', async () => {
  const originalFetch = globalThis.fetch;
  const body =
    sseFrame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'lookup', arguments: '{"q":' } }] } }] }) +
    sseFrame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"zeno"}' } }] } }] }) +
    'data: [DONE]\n\n';
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as any;
  try {
    const final = finalOf(await run(new OllamaAdapter({ model: 'ollama/qwen3:8b' }), makeRequest(), true));
    const call = final.parts[0];
    assert.ok(call?.type === 'toolCall');
    assert.equal(call.name, 'lookup');
    assert.equal(call.id, 'c1');
    assert.deepEqual(call.args, { q: 'zeno' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Grok speaks the Responses API dialect (GrokAdapter extends GptAdapter, xAI overrides)', async () => {
  // xAI retired chat-completions Live Search (410); Grok now rides the
  // Responses-shaped Agent Tools API through the GPT translator.
  assert.ok(new GrokAdapter({ model: 'grok-4.5' }) instanceof GptAdapter);
  assert.ok(new GrokLlm({ model: 'grok-4.5' }) instanceof GptLlm, 'and its ADK shim is a GptLlm');
  assert.deepEqual(
    GrokLlm.supportedModels.map((p) => String(p)),
    [String(/^grok-.+/)],
  );

  // Without a key, the adapter yields the xAI-specific MISSING_API_KEY error
  // (proves the env/key overrides are wired, no network involved).
  const saved = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    const final = finalOf(await run(new GrokAdapter({ model: 'grok-4.5' }), makeRequest({ model: 'grok-4.5' })));
    assert.equal(final.error?.code, 'MISSING_API_KEY');
    assert.match(final.error!.message, /XAI_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.XAI_API_KEY = saved;
  }

  // Grok's web_search request shaping is the shared Responses builder:
  const tools: any[] = (await grokBody(makeRequest({ model: 'grok-4.5', nativeTools: ['web_search'] }))).tools;
  assert.ok(tools.some((t) => t.type === 'web_search')); // Agent Tools web_search
  assert.ok(!tools.some((t) => t.type === 'function')); // never a function tool
});

test('web_search forwards xAI domain filters from env; OpenAI stays bare', async () => {
  const saved: Record<string, string | undefined> = {
    XAI_WEB_SEARCH_ALLOWED_DOMAINS: process.env.XAI_WEB_SEARCH_ALLOWED_DOMAINS,
    XAI_WEB_SEARCH_EXCLUDED_DOMAINS: process.env.XAI_WEB_SEARCH_EXCLUDED_DOMAINS,
  };
  const webSearch = async (body: Promise<any>) => ((await body).tools as any[]).find((t) => t.type === 'web_search');
  const grok = makeRequest({ model: 'grok-4.5', nativeTools: ['web_search'] });
  try {
    // Configured on a grok model: filters ride the tool object, nested under
    // `filters` on the OpenAI-compatible wire (docs.x.ai › Tools › Web Search).
    process.env.XAI_WEB_SEARCH_ALLOWED_DOMAINS = ' reuters.com , apnews.com ,';
    delete process.env.XAI_WEB_SEARCH_EXCLUDED_DOMAINS;
    assert.deepEqual(await webSearch(grokBody(grok)), {
      type: 'web_search',
      filters: { allowed_domains: ['reuters.com', 'apnews.com'] },
    });

    // Same env, OpenAI model: web_search takes no params and MUST stay bare.
    assert.deepEqual(await webSearch(gptBody(makeRequest({ model: 'gpt-5-mini', nativeTools: ['web_search'] }))), { type: 'web_search' });

    // Mutually exclusive lists: the allowlist wins, exclusions drop (never a 400).
    process.env.XAI_WEB_SEARCH_EXCLUDED_DOMAINS = 'pinterest.com';
    assert.deepEqual((await webSearch(grokBody(grok))).filters, { allowed_domains: ['reuters.com', 'apnews.com'] });

    // Oversize list: truncates to xAI's cap of 5, never fatal.
    delete process.env.XAI_WEB_SEARCH_ALLOWED_DOMAINS;
    process.env.XAI_WEB_SEARCH_EXCLUDED_DOMAINS = 'a.com,b.com,c.com,d.com,e.com,f.com';
    assert.deepEqual((await webSearch(grokBody(grok))).filters, { excluded_domains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'] });

    // Unconfigured: the bare tool it always was, on every provider.
    for (const name of Object.keys(saved)) delete process.env[name];
    assert.deepEqual(await webSearch(grokBody(grok)), { type: 'web_search' });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
      else delete process.env[name];
    }
  }
});

test('streamEventDelta maps Responses SSE events to text/thought deltas', () => {
  assert.deepEqual(
    streamEventDelta({ type: 'response.output_text.delta', delta: 'Hel' }),
    { thought: false, text: 'Hel' },
  );
  assert.deepEqual(
    streamEventDelta({ type: 'response.reasoning_summary_text.delta', delta: 'hmm' }),
    { thought: true, text: 'hmm' },
  );
  // Non-delta events (item boundaries, completion, malformed) map to null.
  assert.equal(streamEventDelta({ type: 'response.completed', response: {} }), null);
  assert.equal(streamEventDelta({ type: 'response.output_item.added' }), null);
  assert.equal(streamEventDelta({ type: 'response.output_text.delta' }), null);
  assert.equal(streamEventDelta(undefined), null);
});

test('collections_search shapes an xAI file_search tool from env ids', async () => {
  const savedIds = process.env.XAI_COLLECTION_IDS;
  const savedMax = process.env.XAI_COLLECTIONS_MAX_RESULTS;
  const request = makeRequest({ model: 'grok-4.5', nativeTools: ['collections_search'] });
  try {
    // Configured: file_search with the parsed ids and the optional cap.
    process.env.XAI_COLLECTION_IDS = ' col_a , col_b ,';
    process.env.XAI_COLLECTIONS_MAX_RESULTS = '7';
    const tools: any[] = (await grokBody(request)).tools ?? [];
    assert.deepEqual(tools.find((t) => t.type === 'file_search'), {
      type: 'file_search',
      vector_store_ids: ['col_a', 'col_b'],
      max_num_results: 7,
    });
    // Never emitted as a client-side function tool.
    assert.ok(!tools.some((t) => t.type === 'function'));

    // Declared but unconfigured: omitted entirely, never fatal.
    delete process.env.XAI_COLLECTION_IDS;
    delete process.env.XAI_COLLECTIONS_MAX_RESULTS;
    const bare: any[] = (await grokBody(request)).tools ?? [];
    assert.ok(!bare.some((t) => t.type === 'file_search'));
  } finally {
    if (savedIds !== undefined) process.env.XAI_COLLECTION_IDS = savedIds;
    else delete process.env.XAI_COLLECTION_IDS;
    if (savedMax !== undefined) process.env.XAI_COLLECTIONS_MAX_RESULTS = savedMax;
    else delete process.env.XAI_COLLECTIONS_MAX_RESULTS;
  }
});

test('x_search forwards env constraints; bare with none set', async () => {
  const saved: Record<string, string | undefined> = {
    XAI_X_SEARCH_FROM_DATE: process.env.XAI_X_SEARCH_FROM_DATE,
    XAI_X_SEARCH_TO_DATE: process.env.XAI_X_SEARCH_TO_DATE,
    XAI_X_SEARCH_ALLOWED_HANDLES: process.env.XAI_X_SEARCH_ALLOWED_HANDLES,
    XAI_X_SEARCH_EXCLUDED_HANDLES: process.env.XAI_X_SEARCH_EXCLUDED_HANDLES,
  };
  const request = makeRequest({ model: 'grok-4.5', nativeTools: ['x_search'] });
  const xSearch = async () => ((await grokBody(request)).tools as any[]).find((t) => t.type === 'x_search');
  try {
    // Configured: constraints ride the tool object (docs.x.ai › Tools › X Search).
    process.env.XAI_X_SEARCH_FROM_DATE = '2026-08-01';
    process.env.XAI_X_SEARCH_TO_DATE = '2026-08-02';
    process.env.XAI_X_SEARCH_ALLOWED_HANDLES = ' @Reuters , AP ,';
    delete process.env.XAI_X_SEARCH_EXCLUDED_HANDLES;
    const tools: any[] = (await grokBody(request)).tools;
    assert.deepEqual(tools.find((t) => t.type === 'x_search'), {
      type: 'x_search',
      from_date: '2026-08-01',
      to_date: '2026-08-02',
      allowed_x_handles: ['Reuters', 'AP'], // trimmed, @-stripped
    });
    // Never emitted as a client-side function tool.
    assert.ok(!tools.some((t) => t.type === 'function'));

    // Mutually exclusive lists: the allowlist wins, exclusions drop (never a 400).
    process.env.XAI_X_SEARCH_EXCLUDED_HANDLES = 'spam_account';
    const both = await xSearch();
    assert.deepEqual(both.allowed_x_handles, ['Reuters', 'AP']);
    assert.equal(both.excluded_x_handles, undefined);

    // Malformed date: dropped with a warning, the rest survive.
    process.env.XAI_X_SEARCH_FROM_DATE = 'yesterday';
    const partial = await xSearch();
    assert.equal(partial.from_date, undefined);
    assert.equal(partial.to_date, '2026-08-02');

    // Unconfigured: the bare tool it always was.
    for (const name of Object.keys(saved)) delete process.env[name];
    assert.deepEqual(await xSearch(), { type: 'x_search' });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
      else delete process.env[name];
    }
  }
});

test('reasoningParam: grok-4.5/4.7 pin effort medium; other ids keep their shapes', () => {
  // grok-4.5 and grok-4.7 send the xAI effort control (docs.x.ai ›
  // Reasoning › Effort levels; xAI's own default is high) — pinned to
  // medium when the agent sets no reasoning.
  assert.deepEqual(new GrokAdapter({ model: 'grok-4.5' }).reasoningParam(undefined), { effort: 'medium' });
  assert.deepEqual(new GrokAdapter({ model: 'grok-4.7' }).reasoningParam(undefined), { effort: 'medium' });
  // Older grok ids don't accept the param and must not send one.
  assert.equal(new GrokAdapter({ model: 'grok-4-1-fast-reasoning' }).reasoningParam(undefined), undefined);
  // OpenAI reasoning ids keep requesting summaries; non-reasoning ids none.
  assert.deepEqual(new GptAdapter({ model: 'gpt-5-mini' }).reasoningParam(undefined), { summary: 'auto' });
  assert.equal(new GptAdapter({ model: 'gpt-4o' }).reasoningParam(undefined), undefined);
});

// ── Claude request building ──────────────────────────────────────────────────

test("anthropicTools: a Gemini-dialect schema arrives lowercase, and web_search is Anthropic's server tool", () => {
  // The schema is converted once, where a tool enters the request (ADR 0048).
  const declaration = contractToolDeclaration({
    name: 'search_catalog',
    description: 'Search the catalog',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] },
  });
  assert.ok(declaration);
  const tools: any[] = anthropicTools({ tools: [declaration], nativeTools: ['web_search'] });
  const fn = tools.find((t) => t.name === 'search_catalog');
  assert.equal(fn.input_schema.type, 'object'); // the uppercase-schema bug, fixed
  assert.equal(fn.input_schema.properties.query.type, 'string');

  const server = tools.find((t) => t.name === 'web_search');
  assert.equal(server.type, 'web_search_20250305'); // Anthropic-native server tool
  assert.equal(typeof server.input_schema, 'undefined');
});

// ── GPT (Responses API) request building ─────────────────────────────────────

test('responsesInput maps messages, round-trips call_id, extracts instructions', () => {
  const { instructions, input } = responsesInput({
    system: 'Be concise.',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'What is 2+2?' }] },
      { role: 'assistant', parts: [{ type: 'toolCall', id: 'call_abc', name: 'calc', args: { a: 2 } }] },
      { role: 'tool', parts: [{ type: 'toolResult', id: 'call_abc', name: 'calc', result: { result: 4 } }] },
    ],
  });
  assert.equal(instructions, 'Be concise.');
  const items = input as any[];
  const call = items.find((i) => i.type === 'function_call');
  const output = items.find((i) => i.type === 'function_call_output');
  assert.equal(call.call_id, 'call_abc');
  assert.equal(output.call_id, 'call_abc'); // Responses API requires the match
  const userMsg = items.find((i) => i.role === 'user');
  assert.equal(userMsg.content[0].type, 'input_text');
});

test('GptAdapter sends lowercase function schemas and the native web_search', async () => {
  const calc = contractToolDeclaration({
    name: 'calc',
    description: 'Calculate',
    parameters: { type: 'OBJECT', properties: { a: { type: 'NUMBER' } } },
  });
  assert.ok(calc);
  const tools: any[] = (await gptBody(makeRequest({ model: 'gpt-5-mini', tools: [calc], nativeTools: ['web_search'] }))).tools;
  assert.equal(tools.find((t) => t.type === 'function').parameters.properties.a.type, 'number');
  assert.ok(tools.some((t) => t.type === 'web_search')); // OpenAI-native tool
});

// ── Real ADK tool objects reach every non-Gemini adapter with their schema ───
// Plain objects carry a `parameters` key. Real ADK AgentTool and load_memory
// keep their schema only in _getDeclaration(), and reading `.parameters`
// sent `{}` — the root cause of plans/gpt-agenttool-delegation.md. These use
// the real classes, declared as a request carries them (contractToolDeclaration).

function realTools(): ToolDeclaration[] {
  const sub = new LlmAgent({ name: 'XScout', description: 'Sweeps X for a ticker', model: 'gemini-3.5-flash-lite', instruction: 'x' });
  return [new AgentTool({ agent: sub }), LOAD_MEMORY].map((tool) => {
    const declaration = contractToolDeclaration(tool);
    assert.ok(declaration, `${tool.name} declares a function`);
    return declaration;
  });
}

function assertDelegationSchemas(byName: (n: string) => any) {
  const delegate = byName('XScout');
  assert.ok(delegate, 'AgentTool must be declared');
  assert.equal(delegate.type, 'object');
  assert.equal(delegate.properties.request.type, 'string');
  assert.deepEqual(delegate.required, ['request']);
  const memory = byName('load_memory');
  assert.ok(memory, 'load_memory must be declared');
  assert.ok(memory.properties.query, 'load_memory keeps its query argument');
}

test('GPT adapter declares AgentTool and load_memory arguments', async () => {
  const tools: any[] = (await gptBody(makeRequest({ model: 'gpt-5-mini', tools: realTools() }))).tools;
  assertDelegationSchemas((n) => tools.find((t) => t.name === n)?.parameters);
});

test('Claude adapter declares AgentTool and load_memory arguments', () => {
  const tools: any[] = anthropicTools({ tools: realTools() });
  assertDelegationSchemas((n) => tools.find((t) => t.name === n)?.input_schema);
});

test('chat-completions adapters (Ollama, gateway) declare AgentTool and load_memory arguments', () => {
  const request = makeRequest({ tools: realTools() });
  for (const adapter of [new OllamaAdapter({ model: 'ollama/qwen3:8b' }), new GatewayAdapter({ model: 'claude-sonnet-4-6' })]) {
    const tools = adapter.toolsFor(request) as any[];
    assertDelegationSchemas((n) => tools.find((t) => t.function.name === n)?.function.parameters);
  }
});

test('an AgentTool whose subagent has no description is still declared', async () => {
  const sub = new LlmAgent({ name: 'Quiet', model: 'gemini-3.5-flash-lite', instruction: 'x' });
  const declaration = contractToolDeclaration(new AgentTool({ agent: sub }));
  assert.ok(declaration);
  const tools: any[] = (await gptBody(makeRequest({ model: 'gpt-5-mini', tools: [declaration] }))).tools;
  assert.ok(tools.some((t) => t.name === 'Quiet'));
});

// Shapes copied from a live xAI grok-4.7 Responses call (2026-09-25),
// sources trimmed.
const XAI_OUTPUT = [
  { type: 'reasoning', id: 'r1', status: 'completed', summary: [], encrypted_content: 'x' },
  {
    id: 'ws_1', type: 'web_search_call', status: 'completed',
    action: { type: 'search', query: 'NVDA stock yesterday performance', sources: [{ type: 'url', url: 'https://www.stocktitan.net/sec-filings/NVDA/' }] },
  },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: "I'll pull the tape.", annotations: [] }] },
  {
    call_id: 'xs_call-3', input: '{"query":"NVDA since:2026-09-24 until:2026-09-26","limit":"5","mode":"Latest"}',
    name: 'x_keyword_search', type: 'custom_tool_call', id: 'ctc_3', status: 'completed',
  },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '- NVDA closed down 0.4%.', annotations: [] }] },
];
const XAI_USAGE = {
  input_tokens: 56765, output_tokens: 1247, output_tokens_details: { reasoning_tokens: 943 }, total_tokens: 58012,
  num_server_side_tools_used: 2, cost_in_usd_ticks: 1697320000,
  server_side_tool_usage_details: { web_search_calls: 1, x_search_calls: 1, x_posts_fetched: 14, x_users_fetched: 0, code_interpreter_calls: 0 },
};

test('extractServerToolCalls reads xAI web_search_call and custom_tool_call items', () => {
  assert.deepEqual(extractServerToolCalls(XAI_OUTPUT), [
    {
      name: 'web_search',
      args: { type: 'search', query: 'NVDA stock yesterday performance' },
      status: 'completed',
      sources: ['https://www.stocktitan.net/sec-filings/NVDA/'],
    },
    {
      name: 'x_keyword_search',
      args: { query: 'NVDA since:2026-09-24 until:2026-09-26', limit: '5', mode: 'Latest' },
      status: 'completed',
    },
  ]);
  // Client function calls are the runtime's to run, not server-side records.
  assert.deepEqual(extractServerToolCalls([{ type: 'function_call', name: 'f', arguments: '{}', call_id: 'c' }]), []);
  assert.deepEqual(extractServerToolCalls(undefined), []);
  // Malformed custom input is kept raw, never thrown.
  assert.deepEqual(
    extractServerToolCalls([{ type: 'custom_tool_call', name: 'x_semantic_search', input: 'not json' }])[0].args,
    { raw: 'not json' },
  );
});

test('serverToolUsage keeps the total and the non-zero xAI counters; {} for OpenAI usage', () => {
  assert.deepEqual(serverToolUsage(XAI_USAGE), { total: 2, web_search_calls: 1, x_search_calls: 1, x_posts_fetched: 14 });
  assert.deepEqual(serverToolUsage({ input_tokens: 10, output_tokens: 2 }), {});
  assert.deepEqual(serverToolUsage(undefined), {});
});

test('a searched Grok response: message items split by a paragraph, search calls on the server-side tool record', () => {
  const adapter = new GrokAdapter({ model: 'grok-4.7' });
  const { final } = adapter.finalOf({ output: XAI_OUTPUT, usage: XAI_USAGE });
  // Narration no longer runs into the answer's first line.
  assert.equal(textOf(final), "I'll pull the tape.\n\n- NVDA closed down 0.4%.");
  assert.ok(!final.parts.some((p) => p.type === 'toolCall')); // the runtime must never run these
  const record = responsesServerTools(final);
  assert.equal(record?.calls.length, 2);
  assert.deepEqual(record?.usage, { total: 2, web_search_calls: 1, x_search_calls: 1, x_posts_fetched: 14 });

  // A plain answer carries no server-side tool record at all.
  const plain = adapter.finalOf({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }).final;
  assert.equal(responsesServerTools(plain), undefined);
  assert.equal(textOf(plain), 'hi');
});

// ── Retry without thinking (ADR 0027 follow-up) ──────────────────────────────

/** A fetch that answers each request from the next scripted body, recording what was asked. */
function scriptedFetch(bodies: Array<(stream: boolean) => string>, seen: any[]) {
  let i = 0;
  return (async (_url: string, init: any) => {
    const req = JSON.parse(init.body);
    seen.push(req);
    return new Response(bodies[Math.min(i++, bodies.length - 1)]!(!!req.stream), { status: 200 });
  }) as any;
}
const thinkingOnly = (stream: boolean) =>
  stream
    ? sseFrame({ choices: [{ index: 0, delta: { reasoning: 'P1: 79 words.' } }] }) +
      sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) +
      sseFrame({ choices: [], usage: contextFullUsage }) +
      'data: [DONE]\n\n'
    : JSON.stringify({ choices: [thinkingOnlyChoice], usage: contextFullUsage });
const answered = (stream: boolean) =>
  stream
    ? sseFrame({ choices: [{ index: 0, delta: { content: 'Quantum ' } }] }) +
      sseFrame({ choices: [{ index: 0, delta: { content: 'answer.' }, finish_reason: 'stop' }] }) +
      sseFrame({ choices: [], usage: { prompt_tokens: 318, completion_tokens: 40, total_tokens: 358 } }) +
      'data: [DONE]\n\n'
    : JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: 'Quantum answer.' } }],
        usage: { prompt_tokens: 318, completion_tokens: 40, total_tokens: 358 },
      });

for (const stream of [false, true]) {
  test(`OllamaAdapter${stream ? ' (SSE)' : ''}: thinking with no answer is retried once with thinking off, and answers`, async () => {
    const originalFetch = globalThis.fetch;
    const seen: any[] = [];
    globalThis.fetch = scriptedFetch([thinkingOnly, answered], seen);
    try {
      const responses = await run(new OllamaAdapter({ model: 'ollama/qwen3.5:9b' }), makeRequest(), stream);
      assert.equal(seen.length, 2);
      assert.equal(seen[0].reasoning_effort, undefined);
      assert.equal(seen[1].reasoning_effort, 'none');
      const final = finalOf(responses);
      assert.equal(final.error, undefined, "the first attempt's error is never yielded");
      assert.match(textOf(final), /Quantum answer\./);
      assert.equal(final.usage?.inputTokens, 2 * 318, 'both attempts are counted');
      assert.equal(final.usage?.outputTokens, 3778 + 40);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('OllamaAdapter: no retry for an agent already running without thinking, or with OLLAMA_RETRY_WITHOUT_THINKING=false', async () => {
  const originalFetch = globalThis.fetch;
  const before = process.env.OLLAMA_RETRY_WITHOUT_THINKING;
  try {
    let seen: any[] = [];
    globalThis.fetch = scriptedFetch([thinkingOnly, answered], seen);
    const adapter = new OllamaAdapter({ model: 'ollama/qwen3.5:9b' });
    let final = finalOf(await run(adapter, makeRequest({ reasoning: 'none' })));
    assert.equal(seen.length, 1);
    assert.equal(final.error?.code, 'OLLAMA_MAX_TOKENS');

    process.env.OLLAMA_RETRY_WITHOUT_THINKING = 'false';
    seen = [];
    globalThis.fetch = scriptedFetch([thinkingOnly, answered], seen);
    final = finalOf(await run(adapter, makeRequest()));
    assert.equal(seen.length, 1);
    assert.equal(final.error?.code, 'OLLAMA_MAX_TOKENS');
  } finally {
    globalThis.fetch = originalFetch;
    if (before === undefined) delete process.env.OLLAMA_RETRY_WITHOUT_THINKING;
    else process.env.OLLAMA_RETRY_WITHOUT_THINKING = before;
  }
});

test('a gateway or other chat-completions adapter never retries without thinking', async () => {
  const originalFetch = globalThis.fetch;
  const before = { g: process.env.MODEL_GATEWAY, k: process.env.MODEL_GATEWAY_API_KEY };
  process.env.MODEL_GATEWAY = 'openrouter';
  process.env.MODEL_GATEWAY_API_KEY = 'fixture-gateway-0123456789abcdef'; // gitleaks:allow (test fixture)
  const seen: any[] = [];
  globalThis.fetch = scriptedFetch([thinkingOnly, answered], seen);
  try {
    await run(new GatewayAdapter({ model: 'claude-sonnet-4-6' }), makeRequest({ model: 'claude-sonnet-4-6' }));
    assert.equal(seen.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of [['MODEL_GATEWAY', before.g], ['MODEL_GATEWAY_API_KEY', before.k]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
