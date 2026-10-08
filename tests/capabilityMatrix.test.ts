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
  KIMI_REASONING,
  REASONING_ITEM,
  SCHEMA,
  SIGNED_THINKING,
  capture,
  request,
  thinkingToolLoop,
  visionRequest,
  withDelegationTools,
} from './helpers/capabilityInputs.ts';
import type { AdapterRow } from './helpers/capabilityInputs.ts';
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

test('matrix: Gemini cells are ADK-native and every non-supported cell explains itself', () => {
  for (const cap of CAPABILITIES) {
    assert.equal(CAPABILITY_MATRIX.gemini[cap].evidence, 'adk', `gemini.${cap}`);
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
