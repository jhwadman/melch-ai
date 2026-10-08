/**
 * tests/shimBodies.test.ts — the ADK path sends the body the contract does.
 *
 * The model tests assert from a ModelRequest to the wire body through the
 * contract adapters (tests/capabilityMatrix.test.ts, models.test.ts,
 * endpoints.test.ts, gateway.test.ts, modelRetry.test.ts), so the native
 * runtime inherits them. Under ADK each of those adapters runs behind its
 * provider's shim class (ClaudeLlm, GptLlm, GrokLlm, KimiLlm, OllamaLlm,
 * GatewayLlm; ADR 0053, 0055 to 0057), and Gemini runs on ADK's own Gemini
 * (TracedGemini) with AdkGeminiAdapter as its contract twin. This suite
 * holds each ADK-path class to the contract adapter's body: for every input
 * the capability matrix is checked with, the class sends, for the LlmRequest
 * the genai mapping makes of the ModelRequest (modelRequestToLlmRequest),
 * the same body the adapter sends for the ModelRequest itself.
 *
 * It is one of the few suites allowed to build an LlmRequest
 * (tests/llmRequestBoundary.test.ts keeps the list).
 *
 * Offline: the capture harness (tests/helpers/capabilityInputs.ts) stubs
 * fetch to record the body and answer 400. Keys are fixtures.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogLevel, setLogLevel } from '@google/adk';
import type { BaseLlm } from '@google/adk';

import type { ModelRequest } from '../lib/models/contract.ts';
import { modelRequestToLlmRequest } from '../lib/models/genaiMapping.ts';
import { ClaudeLlm } from '../lib/models/claudeLlm.ts';
import { GptLlm } from '../lib/models/gptLlm.ts';
import { GrokLlm } from '../lib/models/grokLlm.ts';
import { KimiLlm } from '../lib/models/kimiLlm.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { GatewayLlm } from '../lib/models/gatewayLlm.ts';
import { TracedGemini } from '../lib/models/registry.ts';
import { AdkGeminiAdapter } from '../lib/models/adkGeminiAdapter.ts';
import { setRetryPolicyOverrides } from '../lib/models/retry.ts';
import { WEB_SEARCH, WebSearchTool, wantsWebSearch } from '../lib/tools/webSearchTool.ts';
import {
  ANTHROPIC_CURRENT,
  MODEL,
  SCHEMA,
  adapterFor,
  captureBody,
  delegationTools,
  request,
  thinkingToolLoop,
  visionRequest,
  withDelegationTools,
} from './helpers/capabilityInputs.ts';
import type { AdapterRow } from './helpers/capabilityInputs.ts';

setLogLevel(LogLevel.ERROR);

/** The ADK-path class for a row, as the registry constructs it. */
function shimFor(row: AdapterRow, model: string): BaseLlm {
  switch (row) {
    case 'anthropic':
      return new ClaudeLlm({ model });
    case 'openai':
      return new GptLlm({ model });
    case 'xai':
      return new GrokLlm({ model });
    case 'moonshot':
      return new KimiLlm({ model });
    case 'ollama':
      return new OllamaLlm({ model });
    case 'gateway':
      return new GatewayLlm({ model });
  }
}

/** The body the ADK-path class sends for the LlmRequest the mapping makes of `request`. */
function shimBody(row: AdapterRow | 'gemini', build: () => BaseLlm, request: ModelRequest): Promise<any> {
  return captureBody(row, () => build().generateContentAsync(modelRequestToLlmRequest(request), request.stream === true));
}

/** The matrix's inputs, named, for one row: each a ModelRequest. */
function inputs(row: AdapterRow): Array<[string, ModelRequest]> {
  const cases: Array<[string, ModelRequest]> = [
    ['text', request(row)],
    ['streaming', { ...request(row), stream: true }],
    ['delegation and memory tools', withDelegationTools(row)],
    ['structured output', request(row, { outputSchema: SCHEMA })],
    ['JSON mode', request(row, { outputFormat: 'json' })],
    ['a thinking tool loop', thinkingToolLoop(row)],
    ['vision', visionRequest(row)],
    ['native web search', request(row, { nativeTools: ['web_search'] })],
    ['sampling', request(row, { sampling: { temperature: 0.2, maxOutputTokens: 512 } })],
  ];
  if (row === 'anthropic') {
    // The current generation's request shape (ADR 0049).
    for (const [name, req] of [...cases]) cases.push([`${name} on ${ANTHROPIC_CURRENT}`, { ...req, model: ANTHROPIC_CURRENT }]);
  }
  return cases;
}

const ROWS: AdapterRow[] = ['anthropic', 'openai', 'xai', 'moonshot', 'ollama', 'gateway'];

for (const row of ROWS) {
  test(`${row}: the ADK-path class sends the contract adapter's body for every matrix input`, async () => {
    for (const [name, req] of inputs(row)) {
      const contract = await captureBody(row, () => adapterFor(row, req.model).generate(req));
      const adk = await shimBody(row, () => shimFor(row, req.model), req);
      assert.deepEqual(adk, contract, `${row} · ${name} (${req.model})`);
    }
  });
}

test("gemini: TracedGemini sends AdkGeminiAdapter's body (the contract's Gemini under ADK, until gate G3)", async () => {
  const model = 'gemini-3.5-flash';
  const cases: Array<[string, ModelRequest]> = [
    ['text', { model, system: 'Be brief.', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] }],
    ['tools', { model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'look it up' }] }], tools: delegationTools() }],
    ['structured output', { model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'judge' }] }], outputSchema: SCHEMA }],
    ['grounding', { model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'news?' }] }], nativeTools: ['web_search'] }],
    ['reasoning', { model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'think' }] }], reasoning: 'high' }],
  ];
  for (const [name, req] of cases) {
    const contract = await captureBody('gemini', () => new AdkGeminiAdapter({ model }).generate(req));
    // The LlmRequest a compiled Gemini agent sends: the mapping's, with the
    // flag the compiler adds to every Gemini agent (lib/compile.ts) and the
    // YAML's includeThoughts, which the contract's Gemini always asks for.
    const llmRequest = modelRequestToLlmRequest(req);
    const config = llmRequest.config ?? {};
    config.toolConfig = { ...config.toolConfig, includeServerSideToolInvocations: true };
    if (config.thinkingConfig) config.thinkingConfig = { ...config.thinkingConfig, includeThoughts: true };
    llmRequest.config = config;
    const adk = await captureBody('gemini', () => new TracedGemini({ model }).generateContentAsync(llmRequest));
    assert.deepEqual(adk, contract, `gemini · ${name}`);
  }
});

test('TracedGemini on the ADK path retries a 503, and throws a 400 with its status and verdict, as ADK’s Gemini does', async () => {
  // The contract's Gemini adapters end both as finals (tests/modelRetry.test.ts);
  // ADK's own path keeps the throw FallbackLlm reads.
  const restore = setRetryPolicyOverrides({ baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 50 });
  const real = globalThis.fetch;
  const saved = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ok = { candidates: [{ content: { role: 'model', parts: [{ text: 'recovered' }] }, finishReason: 'STOP' }] };
  try {
    let calls = 0;
    globalThis.fetch = (async () => (calls++ === 0 ? reply(503, { error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } }) : reply(200, ok))) as any;
    const text: string[] = [];
    const llmRequest = modelRequestToLlmRequest({ model: 'gemini-test', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] });
    for await (const r of new TracedGemini({ model: 'gemini-test', apiKey: 'test-key' }).generateContentAsync(llmRequest)) {
      text.push(...(r.content?.parts ?? []).map((p) => p.text ?? ''));
    }
    assert.equal(calls, 2);
    assert.equal(text.join(''), 'recovered');

    calls = 0;
    globalThis.fetch = (async () => (calls++, reply(400, { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } }))) as any;
    let thrown: any;
    try {
      for await (const _ of new TracedGemini({ model: 'gemini-test', apiKey: 'test-key' }).generateContentAsync(llmRequest)) void _;
    } catch (err) {
      thrown = err;
    }
    assert.equal(calls, 1);
    assert.equal(thrown?.status, 400);
    assert.equal(thrown?.retryable, false);
    assert.match(String(thrown?.message), /API key not valid/);
  } finally {
    globalThis.fetch = real;
    if (saved !== undefined) process.env.GOOGLE_GENAI_USE_VERTEXAI = saved;
    restore();
  }
});

// ── The web_search tool on the ADK path ─────────────────────────────────────

test('WebSearchTool: a Gemini request gets grounding; any other gets the sentinel, which its shim sends as web_search', async () => {
  const tool = new WebSearchTool();

  const geminiRequest = modelRequestToLlmRequest(request('anthropic', { model: 'gemini-3.5-flash-lite' }));
  await tool.processLlmRequest({ llmRequest: geminiRequest } as any);
  assert.deepEqual(geminiRequest.config?.tools, [{ googleSearch: {} }]);
  assert.equal(wantsWebSearch(geminiRequest), false); // no sentinel on Gemini

  const claudeRequest = modelRequestToLlmRequest(request('anthropic'));
  await tool.processLlmRequest({ llmRequest: claudeRequest } as any);
  assert.equal(claudeRequest.config?.tools, undefined); // no Gemini grounding
  assert.equal(wantsWebSearch(claudeRequest), true); // adapters read this
  assert.equal(tool._getDeclaration(), undefined); // never a client-side function tool
  const sent = await captureBody('anthropic', () => new ClaudeLlm({ model: MODEL.anthropic }).generateContentAsync(claudeRequest));
  const contract = await captureBody('anthropic', () => adapterFor('anthropic').generate(request('anthropic', { nativeTools: ['web_search'] })));
  assert.deepEqual(sent, contract);
});

test('every shim reads web_search in toolsDict by its marker: a foreign copy sends the same body as the sentinel (ADR 0062)', async () => {
  // A second copy of the sentinel module: no class in common, the same global marker.
  const foreign = {
    name: 'web_search',
    description: 'a copy',
    [Symbol.for('melchizedek.nativeTool')]: 'web_search',
    _getDeclaration: () => undefined,
    runAsync: async () => undefined,
  };
  for (const row of ROWS) {
    const withTool = async (tool: unknown) => {
      const llmRequest = modelRequestToLlmRequest(request(row));
      llmRequest.toolsDict['web_search'] = tool as any;
      return captureBody(row, () => shimFor(row, MODEL[row]).generateContentAsync(llmRequest));
    };
    const original = await withTool(WEB_SEARCH);
    assert.deepEqual(await withTool(foreign), original, `${row}: the marker decides`);
    const contract = await captureBody(row, () => adapterFor(row).generate(request(row, { nativeTools: ['web_search'] })));
    assert.deepEqual(original, contract, `${row}: the sentinel is the contract's web_search`);
  }
});

test('the rows here are the matrix rows the repo builds', () => {
  assert.deepEqual([...ROWS].sort(), (Object.keys(MODEL) as AdapterRow[]).sort());
});
