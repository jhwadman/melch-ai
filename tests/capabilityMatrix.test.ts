/**
 * tests/capabilityMatrix.test.ts — every `evidence: 'test'` cell of
 * CAPABILITY_MATRIX (lib/models/capabilities.ts), asserted against the request
 * body the row's contract adapter (lib/models/contract.ts, ADR 0048) sends
 * for a ModelRequest, so the native runtime inherits every cell.
 *
 * The inputs and the capture harness are tests/helpers/capabilityInputs.ts:
 * globalThis.fetch is a stub that records the request and answers 400, so no
 * provider is called and no SDK retries; keys are fixtures. The ADK path's
 * shim classes are held to the same bodies for the same inputs in
 * tests/shimBodies.test.ts.
 *
 * The point is drift: change what an adapter sends without changing its row
 * in the matrix and one of these fails; change a row without the adapter and
 * it fails too. Every cell must have a check (the last test enforces that).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { setLogLevel, LogLevel } from '@google/adk';

import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  capabilityGaps,
  capabilityOf,
  renderCapabilityMatrix,
  requiredCapabilities,
} from '../lib/models/capabilities.ts';
import type { Capability, MatrixRow } from '../lib/models/capabilities.ts';
import {
  ANTHROPIC_CURRENT,
  DIALECT,
  FAKE_ENV,
  GEMINI_BUDGET_MODEL,
  GEMINI_MODEL,
  GEMINI_SIGNATURE,
  KIMI_REASONING,
  REASONING_ITEM,
  SCHEMA,
  SIGNED_THINKING,
  capture,
  delegationTools,
  geminiCandidate,
  geminiDeclaration,
  geminiExchange,
  geminiRequest,
  geminiThinkingToolLoop,
  request,
  thinkingToolLoop,
  visionRequest,
  withDelegationTools,
} from './helpers/capabilityInputs.ts';
import type { AdapterRow } from './helpers/capabilityInputs.ts';
import type { Message, ModelRequest } from '../lib/models/contract.ts';
import { CARRIED_PARTS_KIND } from '../lib/models/geminiAdapter.ts';
import { contentToMessage, modelResponseToLlmResponse } from '../lib/models/genaiMapping.ts';
import { GEMINI_PROVIDER, THOUGHT_SIGNATURE_KIND } from '../lib/models/geminiState.ts';
import { nativeToolOf } from '../lib/models/schemaNormalize.ts';
import { WEB_SEARCH } from '../lib/tools/webSearchTool.ts';

setLogLevel(LogLevel.ERROR);
// The tracer prints every llm.request span to stdout unless told not to.
process.env.OTEL_CONSOLE_SPANS = 'false';

// ── Readers: one shape per wire dialect ──────────────────────────────────────

function toolSchema(row: AdapterRow, body: any, name: string): any {
  const tools: any[] = body.tools ?? [];
  switch (DIALECT[row]) {
    case 'anthropic':
      return tools.find((t) => t.name === name)?.input_schema;
    case 'responses':
      return tools.find((t) => t.name === name)?.parameters;
    case 'chat':
      return tools.find((t) => t.function?.name === name)?.function?.parameters;
  }
}

function hasImage(row: AdapterRow, body: any): boolean {
  if (DIALECT[row] === 'anthropic') {
    // An image block with a base64 source carrying the part's media type.
    return (body.messages ?? []).some((m: any) =>
      (Array.isArray(m.content) ? m.content : []).some((b: any) => b.type === 'image' && b.source?.type === 'base64' && b.source.media_type === 'image/png'),
    );
  }
  const text = JSON.stringify(DIALECT[row] === 'responses' ? body.input : body.messages);
  return /"type":"(image|input_image|image_url)"/.test(text);
}

// ── One check per capability; each returns the support the request shows ────

type Observed = 'supported' | 'degraded' | 'unsupported';

const CHECKS: Record<Capability, (row: AdapterRow) => Promise<Observed>> = {
  async delegation(row) {
    const s = toolSchema(row, await capture(row, withDelegationTools(row)), 'Scout');
    return s?.properties?.request?.type === 'string' && s.required?.includes('request') ? 'supported' : 'unsupported';
  },

  async memory_tools(row) {
    const s = toolSchema(row, await capture(row, withDelegationTools(row)), 'load_memory');
    return s?.properties?.query ? 'supported' : 'unsupported';
  },

  async structured_output(row) {
    const structured = () => request(row, { outputSchema: SCHEMA });
    const body = await capture(row, structured());
    switch (DIALECT[row]) {
      case 'anthropic': {
        // Claude 4.6 and earlier: a forced tool whose input_schema is the schema.
        const forced = body.tool_choice?.type === 'tool';
        const declared = (body.tools ?? []).some((t: any) => t.name === body.tool_choice?.name && t.input_schema?.properties?.verdict);
        // Current models: output_config.format, strict, and no tool_choice (ADR 0049).
        const current = await capture(row, structured(), false, ANTHROPIC_CURRENT);
        const f = current.output_config?.format;
        const formatted = f?.type === 'json_schema' && f.schema?.properties?.verdict && f.schema.additionalProperties === false && !current.tool_choice;
        return forced && declared && formatted ? 'supported' : 'unsupported';
      }
      case 'responses':
        return body.text?.format?.type === 'json_schema' && body.text.format.schema?.properties?.verdict ? 'supported' : 'unsupported';
      case 'chat': {
        const f = body.response_format;
        if (f?.type === 'json_schema' && f.json_schema?.schema?.properties?.verdict) return 'supported';
        return f?.type === 'json_object' ? 'degraded' : 'unsupported';
      }
    }
  },

  async thinking_with_tools(row) {
    const body = await capture(row, thinkingToolLoop(row));
    switch (DIALECT[row]) {
      case 'anthropic': {
        // Anthropic needs the signed thinking block replayed, verbatim, at the
        // start of the assistant message that holds the tool_use.
        const replayed = (b: any) => {
          const assistant = (b.messages ?? []).find((m: any) => m.role === 'assistant');
          const [first, second] = assistant?.content ?? [];
          return JSON.stringify(first) === JSON.stringify(SIGNED_THINKING) && second?.type === 'tool_use';
        };
        // Claude 4.6 and earlier: a thinking budget, the low level's.
        const budget = body.thinking?.type === 'enabled' && body.thinking.budget_tokens === 2048;
        // Current models: adaptive thinking at the agent's effort, the replay under drop_block (ADR 0049).
        const current = await capture(row, thinkingToolLoop(row), false, ANTHROPIC_CURRENT);
        const adaptive =
          current.thinking?.type === 'adaptive' &&
          current.thinking.block_binding?.prefix_mismatch_behavior === 'drop_block' &&
          current.output_config?.effort === 'low';
        return budget && adaptive && replayed(body) && replayed(current) ? 'supported' : 'unsupported';
      }
      case 'responses': {
        // The reasoning item goes back verbatim, immediately before the
        // function_call it preceded, on a request that keeps nothing
        // server-side and asks for the next step's reasoning encrypted.
        const reasons = !!body.reasoning;
        const tools = (body.tools ?? []).length > 0;
        if (!reasons || !tools) return 'unsupported';
        const input: any[] = body.input ?? [];
        const at = input.findIndex((i) => i.type === 'function_call');
        const replayed = at > 0 && JSON.stringify(input[at - 1]) === JSON.stringify(REASONING_ITEM);
        const stateless = body.store === false && (body.include ?? []).includes('reasoning.encrypted_content');
        return replayed && stateless ? 'supported' : 'degraded';
      }
      case 'chat': {
        const tools = (body.tools ?? []).length > 0;
        if (!tools) return 'unsupported';
        // The budget has no wire form here; only reasoning_effort travels.
        if (body.reasoning_effort !== 'low' || 'thinking' in body) return 'unsupported';
        // Supported where the assistant message holding the call gets its
        // reasoning_content back (Kimi); elsewhere the model re-reasons.
        const assistant = (body.messages ?? []).find((m: any) => m.role === 'assistant');
        const replayed = assistant?.reasoning_content === KIMI_REASONING && assistant.tool_calls?.[0]?.id === 'call_1';
        return replayed ? 'supported' : 'degraded';
      }
    }
  },

  async streaming(row) {
    const body = await capture(row, request(row), true);
    return body.stream === true ? 'supported' : 'unsupported';
  },

  async vision(row) {
    return hasImage(row, await capture(row, visionRequest(row))) ? 'supported' : 'unsupported';
  },

  async native_search(row) {
    const body = await capture(row, request(row, { nativeTools: ['web_search'] }));
    const text = JSON.stringify(body.tools ?? []) + JSON.stringify(body.web_search_options ?? '') + JSON.stringify(body.plugins ?? '');
    return /web_search/.test(text) ? 'supported' : 'unsupported';
  },
};

// ── The Gemini row (ADR 0100): the engine's GeminiAdapter on the real SDK ────
//
// Gemini's wire is its own dialect (contents, functionDeclarations,
// generationConfig), so its checks are written out here rather than read
// through DIALECT. Each asserts the request body the adapter posts and, where
// the cell's claim covers the answer, the final it makes of Gemini's JSON. An
// assertion that fails names what is missing; a check that returns says the
// cell holds.

const CODE = { executableCode: { language: 'PYTHON', code: 'print(6 * 7)' } };
const CODE_RESULT = { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '42\n' } };

const GEMINI_CHECKS: Record<Capability, () => Promise<Observed>> = {
  async delegation() {
    const { body } = await geminiExchange(geminiRequest({ tools: delegationTools() }));
    const scout = geminiDeclaration(body, 'Scout');
    // JSON Schema as written, in parametersJsonSchema; never Gemini's uppercase Schema (ADR 0100).
    assert.equal(scout?.parametersJsonSchema?.properties?.request?.type, 'string', 'Scout takes a string request');
    assert.ok(scout.parametersJsonSchema.required?.includes('request'));
    assert.equal(scout.parameters, undefined, 'no Gemini Schema dialect beside it');
    assert.equal(body.toolConfig, undefined, 'no tool choice asked for: the provider default');
    return 'supported';
  },

  async memory_tools() {
    // Declared, then called and answered: the call and its result go back as functionCall and functionResponse.
    const messages: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: 'what did I say about Friday?' }] },
      { role: 'assistant', parts: [{ type: 'toolCall', id: 'adk-1-0-load_memory', name: 'load_memory', args: { query: 'Friday' } }] },
      { role: 'tool', parts: [{ type: 'toolResult', id: 'adk-1-0-load_memory', name: 'load_memory', result: { memories: ['closed on Friday'] } }] },
    ];
    const { body } = await geminiExchange(geminiRequest({ tools: delegationTools(), messages }));
    assert.ok(geminiDeclaration(body, 'load_memory')?.parametersJsonSchema?.properties?.query, 'load_memory declared with its query');
    assert.deepEqual(body.contents[1], { role: 'model', parts: [{ functionCall: { name: 'load_memory', args: { query: 'Friday' } } }] });
    assert.deepEqual(body.contents[2], {
      role: 'user',
      parts: [{ functionResponse: { name: 'load_memory', response: { memories: ['closed on Friday'] } } }],
    });
    return 'supported';
  },

  async structured_output() {
    const answer = '{"verdict":"yes"}';
    const { body, final } = await geminiExchange(geminiRequest({ outputSchema: SCHEMA }), geminiCandidate([{ text: answer }]));
    const config = body.generationConfig ?? {};
    assert.equal(config.responseMimeType, 'application/json');
    assert.deepEqual(config.responseJsonSchema, SCHEMA, 'the schema as written, lowercase JSON Schema');
    assert.equal(config.responseSchema, undefined, 'no Gemini Schema dialect beside it');
    assert.deepEqual(final.parts, [{ type: 'text', text: answer }]);
    // JSON mode without a schema (ADR 0061): the MIME type alone.
    const json = await geminiExchange(geminiRequest({ outputFormat: 'json' }));
    assert.deepEqual(json.body.generationConfig, { responseMimeType: 'application/json' });
    // Beside tools, as a delegating orchestrator with a schema sends it.
    const both = await geminiExchange(geminiRequest({ outputSchema: SCHEMA, tools: delegationTools() }));
    assert.ok(geminiDeclaration(both.body, 'Scout') && both.body.generationConfig.responseJsonSchema, 'schema and tools in one request');
    return 'supported';
  },

  async thinking_with_tools() {
    // Mid tool loop: the level, the thoughts asked for, the tools, and the call's signature back on the call.
    const { body } = await geminiExchange(geminiThinkingToolLoop('low'));
    assert.deepEqual(body.generationConfig?.thinkingConfig, { thinkingLevel: 'LOW', includeThoughts: true });
    assert.ok(geminiDeclaration(body, 'Scout'), 'the tools travel with thinking');
    assert.deepEqual(body.contents[1], {
      role: 'model',
      parts: [{ functionCall: { name: 'Scout', args: { request: 'find it' } }, thoughtSignature: GEMINI_SIGNATURE }],
    });
    assert.deepEqual(body.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'Scout', response: { result: 'found' } } }] });
    assert.ok(!JSON.stringify(body).includes('I should ask Scout.'), 'thinking is never sent back');

    // Every level on a Gemini 3 id, a budget on any id, and a Gemini 2.x id's budget (ADR 0047).
    const levels: Array<[ModelRequest['reasoning'], string, object]> = [
      ['none', GEMINI_MODEL, { thinkingLevel: 'MINIMAL' }],
      ['medium', GEMINI_MODEL, { thinkingLevel: 'MEDIUM', includeThoughts: true }],
      ['high', GEMINI_MODEL, { thinkingLevel: 'HIGH', includeThoughts: true }],
      [{ budget_tokens: 3000 }, GEMINI_MODEL, { thinkingBudget: 3000, includeThoughts: true }],
      ['low', GEMINI_BUDGET_MODEL, { thinkingBudget: 2048, includeThoughts: true }],
    ];
    for (const [reasoning, model, thinkingConfig] of levels) {
      const sent = await geminiExchange(geminiThinkingToolLoop(reasoning, model));
      assert.deepEqual(sent.body.generationConfig?.thinkingConfig, thinkingConfig, `${JSON.stringify(reasoning)} on ${model}`);
      assert.equal(sent.body.contents[1].parts[0].thoughtSignature, GEMINI_SIGNATURE, `the signature on ${model}`);
    }

    // Another model's signature is not replayed: it binds to the model that wrote it.
    const other = await geminiExchange({ ...geminiThinkingToolLoop('low'), model: 'gemini-3.8-flash' });
    assert.equal(other.body.contents[1].parts[0].thoughtSignature, undefined, "another model's signature stays home");

    // The answer: the thought as a partial, the call's signature written on the call for the next step.
    const reply = geminiCandidate([
      { text: 'Scout will know.', thought: true },
      { functionCall: { name: 'Scout', args: { request: 'find it' } }, thoughtSignature: GEMINI_SIGNATURE },
    ]);
    const { partials, final } = await geminiExchange(geminiRequest({ tools: delegationTools(), reasoning: 'low' }), reply);
    assert.deepEqual(partials.map((p) => p.parts), [[{ type: 'thinking', text: 'Scout will know.' }]]);
    assert.equal(final.finishReason, 'tool_call');
    assert.deepEqual(final.parts, [
      {
        type: 'toolCall',
        id: 'adk-1-0-Scout',
        name: 'Scout',
        args: { request: 'find it' },
        providerState: { provider: GEMINI_PROVIDER, kind: THOUGHT_SIGNATURE_KIND, model: GEMINI_MODEL, payload: GEMINI_SIGNATURE },
      },
    ]);
    return 'supported';
  },

  async streaming() {
    const chunks = [
      geminiCandidate([{ text: 'Weighing it.', thought: true }], { finishReason: '' }),
      geminiCandidate([{ text: 'Cats ' }], { finishReason: '' }),
      geminiCandidate([{ text: 'purr.' }], {
        usageMetadata: { promptTokenCount: 4, toolUsePromptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 2 },
      }),
    ];
    const { url, partials, final } = await geminiExchange(geminiRequest({ stream: true, reasoning: 'low' }), chunks);
    assert.match(url, /:streamGenerateContent\?alt=sse$/, 'the streaming endpoint');
    assert.deepEqual(
      partials.map((p) => p.parts),
      [[{ type: 'thinking', text: 'Weighing it.' }], [{ type: 'text', text: 'Cats ' }], [{ type: 'text', text: 'purr.' }]],
    );
    // One final with the whole text and the usage under the contract's meanings.
    assert.deepEqual(final, {
      partial: false,
      parts: [{ type: 'text', text: 'Cats purr.' }],
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 5, thinkingTokens: 3, cacheReadTokens: 2 },
    });
    const once = await geminiExchange(geminiRequest());
    assert.match(once.url, /:generateContent$/, 'a call that does not stream asks for one response');
    return 'supported';
  },

  async vision() {
    const messages: Message[] = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'what are these?' },
          { type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { type: 'blob', mimeType: 'image/jpeg', url: 'https://example.org/cat.jpg' },
        ],
      },
    ];
    const { body } = await geminiExchange(geminiRequest({ messages }));
    assert.deepEqual(body.contents[0].parts, [
      { text: 'what are these?' },
      { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
      { fileData: { mimeType: 'image/jpeg', fileUri: 'https://example.org/cat.jpg' } },
    ]);
    return 'supported';
  },

  async native_search() {
    // Grounding: googleSearch, with what Gemini searched and cited on the final.
    const answer = 'Café Nord opens at 9.';
    const grounded = geminiCandidate([{ text: answer }], {
      groundingMetadata: {
        webSearchQueries: ['cafe nord hours'],
        groundingChunks: [{ web: { uri: 'https://example.org/nord', title: 'example.org' } }],
        groundingSupports: [{ segment: { endIndex: 22, text: answer }, groundingChunkIndices: [0] }],
      },
      urlContextMetadata: { urlMetadata: [{ retrievedUrl: 'https://example.org/menu', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }] },
    });
    const search = await geminiExchange(geminiRequest({ nativeTools: ['web_search', 'url_context'] }), grounded);
    assert.deepEqual(search.body.tools, [{ googleSearch: {} }, { urlContext: {} }]);
    assert.equal(search.body.toolConfig, undefined, 'native tools alone: no server-side invocations asked for');
    assert.deepEqual(search.final.grounding, {
      citations: [
        { url: 'https://example.org/nord', title: 'example.org', start: 0, end: answer.length },
        { url: 'https://example.org/menu' },
      ],
      searchQueries: [{ tool: 'web_search', query: 'cafe nord hours' }],
    });
    const named = await geminiExchange(geminiRequest({ nativeTools: ['google_search'] }), grounded);
    assert.deepEqual(named.body.tools, [{ googleSearch: {} }]);
    assert.deepEqual(named.final.grounding?.searchQueries, [{ tool: 'google_search', query: 'cafe nord hours' }]);

    // Beside function declarations: the server-side invocations come back (ADR 0065).
    const beside = await geminiExchange(geminiRequest({ tools: delegationTools(), nativeTools: ['web_search', 'code_execution'] }));
    assert.deepEqual(beside.body.tools.slice(1), [{ googleSearch: {} }, { codeExecution: {} }]);
    assert.deepEqual(beside.body.toolConfig, { includeServerSideToolInvocations: true });

    // Code execution: its parts ride on the next output part and go back before it within the turn.
    const ran = await geminiExchange(
      geminiRequest({ nativeTools: ['code_execution'] }),
      geminiCandidate([{ text: 'Compute it.', thought: true, thoughtSignature: 'dGhvdWdodA==' }, CODE, CODE_RESULT, { text: 'The product is 42.' }]),
    );
    const [part] = ran.final.parts;
    assert.equal(part.type === 'text' && part.text, 'The product is 42.');
    assert.equal(part.providerState?.kind, CARRIED_PARTS_KIND);
    const assistant: Message = { role: 'assistant', parts: ran.final.parts };
    const sameTurn = await geminiExchange(
      geminiRequest({ nativeTools: ['code_execution'], messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }, assistant] }),
    );
    assert.deepEqual(sameTurn.body.contents[1].parts, [{ ...CODE, thoughtSignature: 'dGhvdWdodA==' }, CODE_RESULT, { text: 'The product is 42.' }]);
    // Stored, the parts are what Gemini sent, as ADK stores them (ADR 0100); read back from the store, they replay the same.
    const stored = modelResponseToLlmResponse(ran.final).content!;
    assert.deepEqual(stored.parts, [{ ...CODE, thoughtSignature: 'dGhvdWdodA==' }, CODE_RESULT, { text: 'The product is 42.' }]);
    const fromStore = await geminiExchange(
      geminiRequest({ nativeTools: ['code_execution'], messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }, contentToMessage(stored)] }),
    );
    assert.deepEqual(fromStore.body.contents[1].parts, sameTurn.body.contents[1].parts, 'the stored parts replay as the carried ones do');
    const storedNextTurn = await geminiExchange(
      geminiRequest({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
          contentToMessage(stored),
          { role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
        ],
      }),
    );
    assert.deepEqual(storedNextTurn.body.contents[1].parts, [{ text: 'The product is 42.' }], 'stored ones too stay within their turn');
    const nextTurn = await geminiExchange(
      geminiRequest({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }, assistant, { role: 'user', parts: [{ type: 'text', text: 'thanks' }] }],
      }),
    );
    assert.deepEqual(nextTurn.body.contents[1].parts, [{ text: 'The product is 42.' }], 'carried parts stay within their turn');
    return 'supported';
  },
};

// ── The tests ────────────────────────────────────────────────────────────────

const ADAPTER_ROWS = (Object.keys(CAPABILITY_MATRIX) as MatrixRow[]).filter((r): r is AdapterRow => r !== 'gemini');

for (const row of ADAPTER_ROWS) {
  for (const cap of CAPABILITIES) {
    const cell = CAPABILITY_MATRIX[row][cap];
    test(`matrix ${row} · ${cap}: ${cell.support}`, async () => {
      assert.equal(cell.evidence, 'test', `${row}.${cap} is built by this repo, so it must be tested`);
      assert.equal(await CHECKS[cap](row), cell.support);
    });
  }
}

for (const cap of CAPABILITIES) {
  const cell = CAPABILITY_MATRIX.gemini[cap];
  test(`matrix gemini · ${cap}: ${cell.support} (the engine's GeminiAdapter, on the wire)`, async () => {
    assert.equal(cell.evidence, 'test', `gemini.${cap} is the engine's own adapter, so it must be tested (gate G3)`);
    assert.equal(await GEMINI_CHECKS[cap](), cell.support);
  });
}

test('matrix: every cell is tested, and every non-supported cell explains itself', () => {
  for (const [row, cells] of Object.entries(CAPABILITY_MATRIX)) {
    for (const cap of CAPABILITIES) assert.equal(cells[cap].evidence, 'test', `${row}.${cap}`);
  }
  for (const [row, cells] of Object.entries(CAPABILITY_MATRIX)) {
    for (const [cap, cell] of Object.entries(cells)) {
      if (cell.support !== 'supported') assert.ok(cell.note, `${row}.${cap} needs a note saying what is lost`);
    }
  }
});

test('requiredCapabilities reads what an agent asks of its model', () => {
  assert.deepEqual(requiredCapabilities({}), []);
  assert.deepEqual(
    requiredCapabilities({ delegates: true, tools: ['load_memory', 'web_search'], outputSchema: {} }).sort(),
    ['delegation', 'memory_tools', 'native_search', 'structured_output'],
  );
  // Thinking matters only alongside tools or delegation; a zero budget is off.
  assert.deepEqual(requiredCapabilities({ generateContentConfig: { thinkingConfig: { thinkingBudget: 1024 } } }), []);
  assert.ok(
    requiredCapabilities({ tools: ['web_extract'], generateContentConfig: { thinkingConfig: { thinkingBudget: 1024 } } }).includes(
      'thinking_with_tools',
    ),
  );
  assert.ok(
    !requiredCapabilities({ tools: ['web_extract'], generateContentConfig: { thinkingConfig: { thinkingBudget: 0 } } }).includes(
      'thinking_with_tools',
    ),
  );
});

test('capabilityGaps resolves the path first: a gateway-served id gets the gateway row', () => {
  const saved = { a: process.env.ANTHROPIC_API_KEY, g: process.env.MODEL_GATEWAY, k: process.env.MODEL_GATEWAY_API_KEY };
  try {
    process.env.ANTHROPIC_API_KEY = FAKE_ENV.anthropic.ANTHROPIC_API_KEY;
    delete process.env.MODEL_GATEWAY;
    delete process.env.MODEL_GATEWAY_API_KEY;
    assert.equal(capabilityOf('claude-sonnet-4-6', 'vision').row, 'anthropic');
    // Thinking with tools is supported on Claude's own path (ADR 0046).
    assert.deepEqual(
      capabilityGaps('claude-sonnet-4-6', { tools: ['web_extract'], generateContentConfig: { thinkingConfig: { thinkingBudget: 2048 } } }).map(
        (g) => `${g.capability}:${g.support}`,
      ),
      [],
    );

    delete process.env.ANTHROPIC_API_KEY;
    Object.assign(process.env, FAKE_ENV.gateway);
    assert.equal(capabilityOf('claude-sonnet-4-6', 'native_search').row, 'gateway');
    assert.deepEqual(
      capabilityGaps('claude-sonnet-4-6', { tools: ['web_search'] }).map((g) => g.capability),
      ['native_search'],
    );
  } finally {
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.a], ['MODEL_GATEWAY', saved.g], ['MODEL_GATEWAY_API_KEY', saved.k]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('renderCapabilityMatrix covers every row and capability, with numbered notes', () => {
  const md = renderCapabilityMatrix();
  for (const cap of CAPABILITIES) assert.ok(md.includes(cap.replace(/_/g, ' ').split(' ')[0]), cap);
  assert.match(md, /^\| Capability \|/);
  assert.match(md, /Gateway \(any id\)/);
  const noted = Object.values(CAPABILITY_MATRIX).flatMap((r) => Object.values(r)).filter((c) => c.note).length;
  assert.ok(md.includes(`\n${noted}. `), 'one numbered note per annotated cell');
});

// ── Server-side tools by marker (ADR 0062) ───────────────────────────────────

test('web_search is read by its marker: a foreign copy is the same NativeTool as the sentinel, and every adapter sends the same body', async () => {
  // A second copy of the sentinel module: no class in common, the same global marker.
  const foreign = {
    name: 'web_search',
    description: 'a copy',
    [Symbol.for('melchizedek.nativeTool')]: 'web_search',
    _getDeclaration: () => undefined,
    runAsync: async () => undefined,
  };
  // A tool object reaches a request as the NativeTool its marker names
  // (the genai mapping and the native runtime both read it with nativeToolOf);
  // tests/shimBodies.test.ts sends the two objects through each ADK shim.
  assert.equal(nativeToolOf(WEB_SEARCH), 'web_search');
  assert.equal(nativeToolOf(foreign), 'web_search', 'the marker decides');
  for (const row of ADAPTER_ROWS) {
    const withOriginal = request(row, { nativeTools: [nativeToolOf(WEB_SEARCH)!] });
    const withForeign = request(row, { nativeTools: [nativeToolOf(foreign)!] });
    assert.deepEqual(await capture(row, withForeign), await capture(row, withOriginal), `${row}: the marker decides`);
  }
});
