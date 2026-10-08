/**
 * tests/toolBaseRest.test.ts — the rest of the tool base on the engine's own
 * types (ADR 0062): the server-side tools as markers, the examples as an
 * InstructionTool, the remote agent and MCP tools as own Tools, and toAdkTool.
 *
 * The ADK runtime must see what it saw before: the same sentinel objects in
 * the registry, ExampleTool's block word for word, the same declarations.
 * Offline: no provider and no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context, ExampleTool, FunctionTool, GOOGLE_SEARCH, setLogLevel, LogLevel } from '@google/adk';
import type { LlmRequest } from '@google/adk';
import { z } from 'zod';

import { examplesTool } from '../lib/compile.ts';
import type { NativeTool } from '../lib/models/contract.ts';
import { contractToolDeclaration, nativeToolOf, toolDeclarationFor } from '../lib/models/schemaNormalize.ts';
import { llmRequestToModelRequest } from '../lib/models/genaiMapping.ts';
import { remoteAgentOwnTool, remoteAgentTool } from '../lib/a2a/remoteAgent.ts';
import { registerTool, resolveTools } from '../lib/toolRegistry.ts';
import { toAdkNativeTool, toAdkTool, toFunctionTool } from '../lib/tools/adkTool.ts';
import { COLLECTIONS_SEARCH, isCollectionsSearchSentinel, wantsCollectionsSearch } from '../lib/tools/collectionsSearchTool.ts';
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
  nativeToolMarker,
  nativeToolMarkerOf,
  toolOf,
} from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { URL_CONTEXT } from '../lib/tools/urlContextTool.ts';
import { WEB_SEARCH, WebSearchTool, isWebSearchSentinel, wantsWebSearch } from '../lib/tools/webSearchTool.ts';
import { X_SEARCH, isXSearchSentinel, wantsXSearch } from '../lib/tools/xSearchTool.ts';

setLogLevel(LogLevel.ERROR);

const MARKERS: Array<[unknown, NativeTool]> = [
  [WEB_SEARCH_MARKER, 'web_search'],
  [X_SEARCH_MARKER, 'x_search'],
  [URL_CONTEXT_MARKER, 'url_context'],
  [COLLECTIONS_SEARCH_MARKER, 'collections_search'],
  [GOOGLE_SEARCH_MARKER, 'google_search'],
];

/** A sentinel from a second copy of the sentinel module: the marker, and no class in common. */
function foreignSentinel(native: NativeTool): Record<PropertyKey, unknown> {
  return { name: native, description: 'a copy', [NATIVE_TOOL]: native, _getDeclaration: () => undefined, runAsync: async () => undefined };
}

/** A client-side tool registered under a server-side tool's name: no marker. */
function clientSearch(name: string): FunctionTool {
  return new FunctionTool({ name, description: 'client-side search', parameters: z.object({ q: z.string() }), execute: async () => '' });
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
    assert.equal(toolDeclarationFor(marker), undefined, `${native} declares nothing`);
    assert.equal(isTool(marker), false);
    assert.equal(isInstructionTool(marker), false);
    assert.equal(toolOf(marker), undefined);
    assert.equal(instructionToolOf(marker), undefined);
    assert.ok(Object.isFrozen(marker));
  }
});

test('the ADK sentinels carry the same marker, and toAdkTool hands the ADK runtime the objects it always ran', () => {
  const sentinels: Array<[unknown, unknown, NativeTool]> = [
    [WEB_SEARCH_MARKER, WEB_SEARCH, 'web_search'],
    [X_SEARCH_MARKER, X_SEARCH, 'x_search'],
    [URL_CONTEXT_MARKER, URL_CONTEXT, 'url_context'],
    [COLLECTIONS_SEARCH_MARKER, COLLECTIONS_SEARCH, 'collections_search'],
    [GOOGLE_SEARCH_MARKER, GOOGLE_SEARCH, 'google_search'],
  ];
  for (const [marker, adk, native] of sentinels) {
    assert.equal(toAdkTool(marker as any), adk, native);
    assert.equal(toAdkNativeTool(marker as any), adk, native);
    assert.equal(nativeToolOf(adk), native);
    assert.equal(contractToolDeclaration(adk), undefined);
  }
  // The engine's own sentinels carry the marker; ADK's GOOGLE_SEARCH has ADK's.
  for (const adk of [WEB_SEARCH, X_SEARCH, URL_CONTEXT, COLLECTIONS_SEARCH]) assert.ok(nativeToolMarkerOf(adk));
  assert.equal(nativeToolMarkerOf(GOOGLE_SEARCH), undefined);
  // The registry holds the very same objects as before.
  assert.deepEqual(resolveTools(['web_search', 'x_search', 'url_context', 'collections_search', 'google_search']), [
    WEB_SEARCH,
    X_SEARCH,
    URL_CONTEXT,
    COLLECTIONS_SEARCH,
    GOOGLE_SEARCH,
  ]);
  // Code execution is an agent's code_execution: gemini, never a listed tool.
  assert.throws(() => toAdkTool(nativeToolMarker('code_execution')), /code_execution: gemini/);
});

test('toAdkTool picks the wrapper for every kind of own tool, and passes an ADK tool through', async () => {
  const contract = defineTool({ name: 'echo_rest', description: 'Echo.', schema: z.object({ s: z.string() }), execute: async ({ s }) => s });
  const fn = toAdkTool(contract);
  assert.ok(fn instanceof FunctionTool);
  assert.equal(toolOf(fn), contract);
  const instruction = { name: 'note_rest', instruction: async () => 'A note.' };
  assert.equal(instructionToolOf(toAdkTool(instruction)), instruction);
  const adk = clientSearch('lookup_rest');
  assert.equal(toAdkTool(adk), adk);
});

test('registerTool takes a marker and registers its sentinel', () => {
  registerTool('web_search_alias_rest', WEB_SEARCH_MARKER);
  assert.deepEqual(resolveTools(['web_search_alias_rest']), [WEB_SEARCH]);
});

test('sentinel tests read the marker, never the class', () => {
  const foreign = foreignSentinel('web_search');
  assert.equal(foreign instanceof WebSearchTool, false);
  assert.equal(isWebSearchSentinel(foreign), true);
  assert.equal(isWebSearchSentinel(WEB_SEARCH_MARKER), true);
  assert.equal(wantsWebSearch(llmRequest('claude-sonnet-4-6', { web_search: foreign })), true);
  assert.equal(isXSearchSentinel(foreignSentinel('x_search')), true);
  assert.equal(wantsXSearch(llmRequest('grok-4.5', { x_search: foreignSentinel('x_search') })), true);
  assert.equal(isCollectionsSearchSentinel(foreignSentinel('collections_search')), true);
  assert.equal(wantsCollectionsSearch(llmRequest('grok-4.5', { collections_search: foreignSentinel('collections_search') })), true);
  // A subclass instance stripped of its marker is not a sentinel: the marker decides.
  const unmarked = Object.create(WEB_SEARCH, { [NATIVE_TOOL]: { value: undefined } });
  assert.equal(unmarked instanceof WebSearchTool, true);
  assert.equal(isWebSearchSentinel(unmarked), false);
  // A client-side tool under the same name is a client-side tool.
  for (const name of ['web_search', 'x_search', 'collections_search']) {
    assert.equal(isWebSearchSentinel(clientSearch(name)) || isXSearchSentinel(clientSearch(name)) || isCollectionsSearchSentinel(clientSearch(name)), false);
  }
});

test('nativeToolOf recognises a marker by symbol alone; a tool that merely declares nothing is not a NativeTool', () => {
  for (const native of ['web_search', 'x_search', 'url_context', 'collections_search', 'google_search'] as NativeTool[]) {
    assert.equal(nativeToolOf(foreignSentinel(native)), native);
    assert.equal(nativeToolOf({ name: native, _getDeclaration: () => undefined }), undefined, `${native}: no marker`);
  }
});

test('the ADK-path request mapping reads every sentinel by marker, so a foreign copy routes the same as the original', () => {
  for (const [model, native] of [
    ['claude-sonnet-4-6', 'web_search'],
    ['gpt-5-mini', 'web_search'],
    ['grok-4.5', 'x_search'],
    ['grok-4.5', 'collections_search'],
    ['kimi-k3', 'web_search'],
  ] as Array<[string, NativeTool]>) {
    const original = { web_search: WEB_SEARCH, x_search: X_SEARCH, collections_search: COLLECTIONS_SEARCH }[native as 'web_search'];
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

function adkContext(userContent?: unknown): Context {
  const invocationContext = {
    invocationId: 'inv-1',
    userId: 'u',
    appName: 'app',
    session: { id: 's1', appName: 'app', userId: 'u', state: {}, events: [] },
    agent: { name: 'Boss' },
    userContent,
  };
  return new Context({ invocationContext: invocationContext as any });
}

function emptyRequest(model: string, system?: string): LlmRequest {
  return { model, contents: [], liveConnectConfig: {}, toolsDict: {}, config: system ? { systemInstruction: system } : {} } as unknown as LlmRequest;
}

test("examples write ADK's ExampleTool block, word for word, in every case", async () => {
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
  for (const examples of exampleSets) {
    const theirs = new ExampleTool(
      examples.map((e) => ({ input: { role: 'user', parts: [{ text: e.input }] }, output: [{ role: 'model', parts: [{ text: e.output }] }] })),
    );
    const [ours] = examplesTool(examples) as [ExampleTool];
    assert.equal(ours.name, EXAMPLES_TOOL_NAME);
    for (const model of ['gemini-2.5-flash', 'claude-sonnet-4-6', 'gpt-5-mini']) {
      for (const system of [undefined, 'Base.']) {
        for (const [label, userContent] of contexts) {
          const theirRequest = emptyRequest(model, system);
          const ourRequest = emptyRequest(model, system);
          await theirs.processLlmRequest({ toolContext: adkContext(userContent), llmRequest: theirRequest } as any);
          await ours.processLlmRequest({ toolContext: adkContext(userContent), llmRequest: ourRequest } as any);
          assert.deepEqual(ourRequest, theirRequest, `${model} · ${system ?? 'no system'} · ${label}`);
        }
      }
    }
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

test('the remote agent tool is an own Tool, and the ADK runtime gets the declaration it always had', async () => {
  const params = { name: 'Oracle', description: 'A remote oracle', url: 'https://oracle.example.test' };
  const own = remoteAgentOwnTool(params);
  assert.ok(isTool(own));
  assert.deepEqual(own.declaration(), {
    name: 'Oracle',
    description: 'A remote oracle',
    parameters: { type: 'object', properties: { request: { type: 'string', description: 'What to ask Oracle.' } }, required: ['request'] },
  });
  const adk = remoteAgentTool(params);
  assert.ok(adk instanceof FunctionTool);
  assert.ok(isTool(toolOf(adk)));
  // What the hand-built FunctionTool declared, before this change.
  assert.deepEqual(adk._getDeclaration(), {
    name: 'Oracle',
    description: 'A remote oracle',
    parameters: { type: 'OBJECT', properties: { request: { type: 'STRING', description: 'What to ask Oracle.' } }, required: ['request'] },
  });
  assert.deepEqual(contractToolDeclaration(adk), own.declaration());
  assert.equal(remoteAgentOwnTool({ ...params, description: '' }).declaration().description, 'Remote agent Oracle');
  // A call without a request is refused as text, before any network.
  assert.equal(await own.execute({}, createToolContext()), 'Error: Oracle needs a request.');
  assert.equal(await own.execute({ request: '   ' }, createToolContext()), 'Error: Oracle needs a request.');
});

// ── MCP tools ────────────────────────────────────────────────────────────────

test("an MCP tool's parameters are what the ADK runtime declares for it, on either path", () => {
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
  const adk = toFunctionTool(own);
  assert.deepEqual(contractToolDeclaration(adk), contractToolDeclaration(own), 'the same declaration on both runtimes');
  assert.deepEqual(contractToolDeclaration(own, { strict: true }), contractToolDeclaration(adk, { strict: true }));
  assert.deepEqual(mcpToolParameters(undefined), { type: 'object', properties: {}, required: [] });
});
