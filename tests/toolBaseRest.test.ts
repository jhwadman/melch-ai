/**
 * tests/toolBaseRest.test.ts — the rest of the tool base on the engine's own
 * types (ADR 0062): the server-side tools as markers, the examples as an
 * InstructionTool, and the remote agent and MCP tools as own Tools.
 *
 * The examples block is compared with the one ADK 2.2's ExampleTool wrote,
 * recorded in tests/fixtures/adk-reference/toolbaserest.
 * Offline: no provider and no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { examplesTool } from '../lib/compile.ts';
import type { NativeTool } from '../lib/models/contract.ts';
import { contractToolDeclaration, nativeToolOf } from '../lib/models/schemaNormalize.ts';
import { llmRequestToModelRequest } from '../lib/models/genaiMapping.ts';
import type { LlmRequest } from '../lib/models/genaiMapping.ts';
import { remoteAgentOwnTool, remoteAgentTool } from '../lib/a2a/remoteAgent.ts';
import { registerTool, resolveTools } from '../lib/toolRegistry.ts';
import { EXAMPLES_TOOL_NAME, examplesInstruction, examplesInstructionTool } from '../lib/tools/examples.ts';
import { mcpToolParameters } from '../lib/tools/mcpToolFactory.ts';
import {
  COLLECTIONS_SEARCH_MARKER,
  GOOGLE_SEARCH_MARKER,
  URL_CONTEXT_MARKER,
  WEB_SEARCH_MARKER,
  X_SEARCH_MARKER,
} from '../lib/tools/nativeTools.ts';
import {
  NATIVE_TOOL,
  createToolContext,
  instructionToolOf,
  isInstructionTool,
  isNativeToolMarker,
  isTool,
  nativeToolMarkerOf,
  toolOf,
} from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { adkReferences } from './helpers/adkReference.ts';

// ADK's ExampleTool block, the reference for the examples tool, is recorded
// (tests/fixtures/adk-reference/toolbaserest) by ADK 2.2.
const reference = adkReferences('toolBaseRest');

const MARKERS: Array<[unknown, NativeTool]> = [
  [WEB_SEARCH_MARKER, 'web_search'],
  [X_SEARCH_MARKER, 'x_search'],
  [URL_CONTEXT_MARKER, 'url_context'],
  [COLLECTIONS_SEARCH_MARKER, 'collections_search'],
  [GOOGLE_SEARCH_MARKER, 'google_search'],
];

/** A marker from a second copy of the marker module: the symbol, and no object in common. */
function foreignSentinel(native: NativeTool): Record<PropertyKey, unknown> {
  return { name: native, description: 'a copy', [NATIVE_TOOL]: native };
}

/** A client-side tool registered under a server-side tool's name: no marker. */
function clientSearch(name: string) {
  return defineTool({ name, description: 'client-side search', schema: z.object({ q: z.string() }), execute: async () => '' });
}

function llmRequest(model: string, toolsDict: Record<string, unknown>): LlmRequest {
  return { model, contents: [{ role: 'user', parts: [{ text: 'hi' }] }], liveConnectConfig: {}, toolsDict, config: {} } as unknown as LlmRequest;
}

// ── Server-side tools as markers ─────────────────────────────────────────────

test('each server-side tool is an own marker that declares no function and names its NativeTool', () => {
  for (const [marker, native] of MARKERS) {
    assert.ok(isNativeToolMarker(marker), native);
    assert.equal((marker as { name: string }).name, native);
    assert.equal(nativeToolMarkerOf(marker), native);
    assert.equal(nativeToolOf(marker), native);
    assert.equal(contractToolDeclaration(marker), undefined, `${native} declares nothing`);
    assert.equal(isTool(marker), false);
    assert.equal(isInstructionTool(marker), false);
    assert.equal(toolOf(marker), undefined);
    assert.equal(instructionToolOf(marker), undefined);
    assert.ok(Object.isFrozen(marker));
  }
});

test('the registry holds the markers themselves', () => {
  assert.deepEqual(resolveTools(['web_search', 'x_search', 'url_context', 'collections_search', 'google_search']), [
    WEB_SEARCH_MARKER,
    X_SEARCH_MARKER,
    URL_CONTEXT_MARKER,
    COLLECTIONS_SEARCH_MARKER,
    GOOGLE_SEARCH_MARKER,
  ]);
});

test('registerTool takes a marker and registers it', () => {
  registerTool('web_search_alias_rest', WEB_SEARCH_MARKER);
  assert.deepEqual(resolveTools(['web_search_alias_rest']), [WEB_SEARCH_MARKER]);
});

test('marker tests read the symbol, never the object', () => {
  const foreign = foreignSentinel('web_search');
  assert.notEqual(foreign, WEB_SEARCH_MARKER);
  assert.equal(nativeToolOf(foreign), 'web_search');
  assert.equal(nativeToolMarkerOf(foreign), 'web_search');
  assert.equal(nativeToolOf(foreignSentinel('x_search')), 'x_search');
  assert.equal(nativeToolOf(foreignSentinel('collections_search')), 'collections_search');
  // An object made from a marker and stripped of its symbol is not a marker: the symbol decides.
  const unmarked = Object.create(WEB_SEARCH_MARKER, { [NATIVE_TOOL]: { value: undefined } });
  assert.equal(nativeToolOf(unmarked), undefined);
  // A client-side tool under the same name is a client-side tool.
  for (const name of ['web_search', 'x_search', 'collections_search']) {
    assert.equal(nativeToolOf(clientSearch(name)), undefined, name);
    assert.ok(contractToolDeclaration(clientSearch(name)), name);
  }
});

test('nativeToolOf recognises a marker by symbol alone; a tool that merely declares nothing is not a NativeTool', () => {
  for (const native of ['web_search', 'x_search', 'url_context', 'collections_search', 'google_search'] as NativeTool[]) {
    assert.equal(nativeToolOf(foreignSentinel(native)), native);
    assert.equal(nativeToolOf({ name: native, _getDeclaration: () => undefined }), undefined, `${native}: no marker`);
  }
});

test('the genai request mapping reads every marker by symbol, so a foreign copy routes the same as the original', () => {
  for (const [model, native] of [
    ['claude-sonnet-4-6', 'web_search'],
    ['gpt-5-mini', 'web_search'],
    ['grok-4.5', 'x_search'],
    ['grok-4.5', 'collections_search'],
    ['kimi-k3', 'web_search'],
  ] as Array<[string, NativeTool]>) {
    const original = { web_search: WEB_SEARCH_MARKER, x_search: X_SEARCH_MARKER, collections_search: COLLECTIONS_SEARCH_MARKER }[native as 'web_search'];
    const theirs = llmRequestToModelRequest(llmRequest(model, { [native]: original }));
    const ours = llmRequestToModelRequest(llmRequest(model, { [native]: foreignSentinel(native) }));
    assert.deepEqual(ours.nativeTools, [native], `${model} ${native}`);
    assert.deepEqual(ours.nativeTools, theirs.nativeTools);
    assert.equal(ours.tools, undefined, 'never a function tool');
    const client = llmRequestToModelRequest(llmRequest(model, { [native]: clientSearch(native) }));
    assert.equal(client.nativeTools, undefined, `${model}: an unmarked ${native} is client-side`);
    assert.deepEqual(client.tools?.map((t) => t.name), [native]);
  }
});

// ── Examples as an InstructionTool ───────────────────────────────────────────

function emptyRequest(model: string, system?: string): LlmRequest {
  return { model, contents: [], liveConnectConfig: {}, toolsDict: {}, config: system ? { systemInstruction: system } : {} } as unknown as LlmRequest;
}

test("examples write ADK's recorded ExampleTool block, word for word, in every case", async () => {
  const hi = { role: 'user', parts: [{ text: 'hello' }] };
  const exampleSets = [
    [{ input: 'What is 2+2?', output: '4' }],
    [
      { input: 'Greet me', output: 'Hello!\nHow can I help?' },
      { input: 'Say nothing', output: '' },
      { input: '', output: 'An answer to nothing.' },
    ],
  ];
  const contexts: Array<[string, unknown]> = [
    ['a text message', hi],
    ['no user content', undefined],
    ['a first part without text', { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }, { text: 'hi' }] }],
    ['an empty first text', { role: 'user', parts: [{ text: '' }] }],
  ];
  const models = ['gemini-2.5-flash', 'claude-sonnet-4-6', 'gpt-5-mini'];
  const systems = [undefined, 'Base.'];
  for (const [i, examples] of exampleSets.entries()) {
    // ADK's ExampleTool over every model, system and context, in loop order: the reference.
    const theirRequests = await reference<LlmRequest[]>(`example-tool-block-${i + 1}`);
    const [listed] = examplesTool(examples);
    const ours = instructionToolOf(listed)!;
    assert.equal(ours.name, EXAMPLES_TOOL_NAME);
    let k = 0;
    for (const model of models) {
      for (const system of systems) {
        for (const [label, userContent] of contexts) {
          const ourRequest = emptyRequest(model, system);
          // The native request builder appends an InstructionTool's text after a blank line, as ADK's appendInstructions did.
          const written = await ours.instruction(createToolContext({ userContent: userContent as any }));
          if (written) ourRequest.config = { systemInstruction: system ? `${system}\n\n${written}` : written };
          assert.deepEqual(JSON.parse(JSON.stringify(ourRequest)), theirRequests[k++], `${model} · ${system ?? 'no system'} · ${label}`);
        }
      }
    }
    assert.equal(k, theirRequests.length, 'one recorded request per case');
  }
});

test('the examples InstructionTool writes the same block on the engine\'s own context, and nothing without examples', async () => {
  const examples = [{ input: 'Q', output: 'A' }];
  const tool = examplesInstructionTool(examples)!;
  const text = await tool.instruction(createToolContext({ userContent: { role: 'user', parts: [{ text: 'hi' }] } }));
  assert.equal(text, examplesInstruction(examples));
  assert.equal(
    text,
    '<EXAMPLES>\nBegin few-shot\nThe following are examples of user queries and model responses using the available tools.\n\n' +
      'EXAMPLE 1:\nBegin example\n[user]\nQ\n[model]\nA\nEnd example\n\nEnd few-shot\n<EXAMPLES>',
  );
  assert.equal(await tool.instruction(createToolContext()), undefined);
  assert.equal(examplesInstructionTool([]), undefined);
  assert.equal(examplesInstructionTool(undefined), undefined);
  assert.deepEqual(examplesTool(undefined), []);
});

// ── The remote agent tool ────────────────────────────────────────────────────

test('the remote agent tool is an own Tool with its declaration', async () => {
  const params = { name: 'Oracle', description: 'A remote oracle', url: 'https://oracle.example.test' };
  const own = remoteAgentOwnTool(params);
  assert.ok(isTool(own));
  assert.deepEqual(own.declaration(), {
    name: 'Oracle',
    description: 'A remote oracle',
    parameters: { type: 'object', properties: { request: { type: 'string', description: 'What to ask Oracle.' } }, required: ['request'] },
  });
  const registered = remoteAgentTool(params);
  assert.ok(isTool(registered));
  assert.equal(toolOf(registered), registered);
  assert.deepEqual(contractToolDeclaration(registered), own.declaration());
  assert.equal(remoteAgentOwnTool({ ...params, description: '' }).declaration().description, 'Remote agent Oracle');
  // A call without a request is refused as text, before any network.
  assert.equal(await own.execute({}, createToolContext()), 'Error: Oracle needs a request.');
  assert.equal(await own.execute({ request: '   ' }, createToolContext()), 'Error: Oracle needs a request.');
});

// ── MCP tools ────────────────────────────────────────────────────────────────

test("an MCP tool's parameters are what the engine declares for it", () => {
  const inputSchema = {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'The query', default: 'x' },
      untyped: { description: '' },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      filter: { type: 'object', properties: { from: { type: 'string' } }, additionalProperties: false, propertyNames: { pattern: '^[a-z]+$' } },
    },
    required: ['q'],
  };
  const parameters = mcpToolParameters(inputSchema);
  assert.deepEqual(parameters, {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'The query' },
      untyped: { type: 'string', description: '' },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, description: '' },
      filter: { type: 'object', properties: { from: { type: 'string' } }, description: '' },
    },
    required: ['q'],
  });
  const own = { name: 'search', declaration: () => ({ name: 'search', description: 'Search.', parameters }), execute: async () => '' };
  assert.deepEqual(contractToolDeclaration(own), { name: 'search', description: 'Search.', parameters });
  assert.equal(contractToolDeclaration(own, { strict: true })?.name, 'search');
  assert.deepEqual(mcpToolParameters(undefined), { type: 'object', properties: {}, required: [] });
});
