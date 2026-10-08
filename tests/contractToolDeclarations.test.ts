/**
 * tests/contractToolDeclarations.test.ts — tool declarations in the model
 * contract's shape (lib/models/schemaNormalize.ts, ADR 0048, ADR 0019).
 *
 * Asserted:
 *   - Every tool the registry resolves declares lowercase JSON Schema, or is
 *     a NativeTool, or is preload_memory (a request processor with nothing
 *     to declare).
 *   - Real ADK AgentTool and load_memory objects keep their argument schemas,
 *     and Gemini's dialect (int64 strings, `nullable`) is converted.
 *   - A defineTool contract declares the same parameters directly from zod
 *     and through the FunctionTool toFunctionTool() makes of it.
 *   - The strict variant reaches every object node, however deep.
 *   - The server-side tools map to their NativeTool by marker and name.
 *
 * Offline: no model is called.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { AgentTool, BuiltInCodeExecutor, FunctionTool, GOOGLE_SEARCH, LOAD_MEMORY, LlmAgent, PRELOAD_MEMORY, URL_CONTEXT as ADK_URL_CONTEXT, setLogLevel, LogLevel } from '@google/adk';
import type { Schema } from '@google/genai';

import type { NativeTool, ToolDeclaration } from '../lib/models/contract.ts';
import { contractToolDeclaration, nativeToolOf, toContractJsonSchema, toolDeclarationFor } from '../lib/models/schemaNormalize.ts';
import { registeredToolNames, resolveTools } from '../lib/toolRegistry.ts';
import { toFunctionTool } from '../lib/tools/adkTool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { WIKI_AGENT_TOOL_CONTRACTS } from '../lib/tools/wikiTools.ts';
import { SCIENCE_TOOL_CONTRACTS } from '../lib/tools/scienceTools.ts';
import { TASK_TOOL_CONTRACTS } from '../lib/tools/taskTools.ts';
import { WEB_SEARCH } from '../lib/tools/webSearchTool.ts';
import { X_SEARCH } from '../lib/tools/xSearchTool.ts';
import { COLLECTIONS_SEARCH } from '../lib/tools/collectionsSearchTool.ts';
import { URL_CONTEXT } from '../lib/tools/urlContextTool.ts';

setLogLevel(LogLevel.ERROR);

// ── Helpers ──────────────────────────────────────────────────────────────────

type Node = Record<string, any>;

/** Every schema node, reached through the keywords that hold schemas only. */
function schemaNodes(node: unknown, out: Node[] = []): Node[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  const n = node as Node;
  out.push(n);
  for (const key of ['items', 'additionalProperties', 'not', 'propertyNames', 'contains']) {
    if (Array.isArray(n[key])) n[key].forEach((s: unknown) => schemaNodes(s, out));
    else schemaNodes(n[key], out);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) if (Array.isArray(n[key])) n[key].forEach((s: unknown) => schemaNodes(s, out));
  for (const key of ['properties', '$defs', 'definitions', 'patternProperties']) {
    if (n[key] && typeof n[key] === 'object') Object.values(n[key]).forEach((s) => schemaNodes(s, out));
  }
  return out;
}

const LOWERCASE_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Lowercase JSON Schema: lowercase types, integer bounds, no OpenAPI `nullable`. */
function assertContractDialect(where: string, schema: unknown): void {
  for (const node of schemaNodes(schema)) {
    const types = node.type === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type];
    for (const t of types) assert.ok(LOWERCASE_TYPES.has(t), `${where}: type ${JSON.stringify(t)} is not lowercase JSON Schema`);
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (key in node) assert.equal(typeof node[key], 'number', `${where}: ${key} is ${JSON.stringify(node[key])}, not an integer`);
    }
    assert.ok(!('nullable' in node), `${where}: OpenAPI nullable left in`);
    assert.ok(!('$schema' in node), `${where}: $schema left in`);
  }
}

/** Every object node with properties lists them all as required and allows no others. */
function assertStrict(where: string, schema: unknown): void {
  let objects = 0;
  for (const node of schemaNodes(schema)) {
    if (!node.properties || typeof node.properties !== 'object') continue;
    objects++;
    assert.deepEqual(node.required, Object.keys(node.properties), `${where}: not every property is required`);
    assert.equal(node.additionalProperties, false, `${where}: additionalProperties is not false`);
  }
  assert.ok(objects > 0, `${where}: no object node to check`);
}

function subagentTool(name: string, extra: Record<string, unknown> = {}): AgentTool {
  return new AgentTool({ agent: new LlmAgent({ name, description: `${name} does one thing`, model: 'gemini-3.5-flash-lite', instruction: 'x', ...extra }) });
}

// ── The registry ─────────────────────────────────────────────────────────────

test('every tool the registry resolves declares lowercase JSON Schema or is a NativeTool', () => {
  const names = registeredToolNames();
  assert.ok(names.length > 20, 'the registry resolves its built-in tools');
  const declared: string[] = [];
  const native: string[] = [];
  for (const name of names) {
    const [tool] = resolveTools([name]);
    const decl = contractToolDeclaration(tool);
    const nativeTool = nativeToolOf(tool);
    if (name === 'preload_memory') {
      // A request processor: it writes memory into the instruction and declares nothing.
      assert.equal(decl, undefined);
      assert.equal(nativeTool, undefined);
      continue;
    }
    assert.ok(!!decl !== !!nativeTool, `${name}: exactly one of a declaration and a NativeTool`);
    if (nativeTool) {
      native.push(name);
      assert.equal(nativeTool, name, `${name} is the NativeTool of the same name`);
      continue;
    }
    declared.push(name);
    assert.equal(decl!.name, name);
    assert.ok(decl!.description.length > 0, `${name} has a description`);
    assert.equal(decl!.parameters.type, 'object', `${name}'s parameters are an object`);
    assert.equal(decl!.strict, undefined, 'strict only when asked');
    assertContractDialect(name, decl!.parameters);

    const strictDecl = contractToolDeclaration(tool, { strict: true })!;
    assert.equal(strictDecl.strict, true);
    assertContractDialect(`${name} (strict)`, strictDecl.parameters);
    assertStrict(`${name} (strict)`, strictDecl.parameters);
  }
  assert.deepEqual(native.sort(), ['collections_search', 'google_search', 'url_context', 'web_search', 'x_search']);
  for (const name of ['ask_user', 'load_memory', 'web_extract', 'wiki_read', 'task_add', 'search_literature']) {
    assert.ok(declared.includes(name), `${name} is declared`);
  }
});

test('a registry tool declares what the ADK path declares, in the contract dialect', () => {
  for (const name of registeredToolNames()) {
    const [tool] = resolveTools([name]);
    const decl = contractToolDeclaration(tool);
    const legacy = toolDeclarationFor(tool);
    if (!decl || !legacy) {
      assert.equal(decl, legacy, `${name}: both or neither declare`);
      continue;
    }
    assert.equal(decl.name, legacy.name);
    assert.equal(decl.description, legacy.description);
    // The same properties and required list; only the dialect differs.
    assert.deepEqual(Object.keys(decl.parameters.properties as object), Object.keys(legacy.parameters.properties as object), name);
    assert.deepEqual(decl.parameters.required, legacy.parameters.required, name);
  }
});

// ── Real ADK tools (ADR 0019) ────────────────────────────────────────────────

test('an AgentTool declares its request argument', () => {
  const decl = contractToolDeclaration(subagentTool('XScout'))!;
  assert.deepEqual(decl, {
    name: 'XScout',
    description: 'XScout does one thing',
    parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] },
  });
});

test("an AgentTool over a subagent with an input schema declares it, out of Gemini's dialect", () => {
  const tool = subagentTool('Forecast', {
    inputSchema: z.object({ city: z.string().min(2), days: z.number().nullable(), unit: z.enum(['c', 'f']).nullable() }),
  });
  // ADK writes Gemini's dialect: int64 bounds as strings, OpenAPI's nullable.
  const gemini = (tool as any)._getDeclaration().parameters;
  assert.equal(gemini.properties.city.minLength, '2');
  assert.equal(gemini.properties.days.nullable, true);

  const decl = contractToolDeclaration(tool)!;
  assert.deepEqual(decl.parameters, {
    type: 'object',
    properties: {
      city: { type: 'string', minLength: 2 },
      days: { type: ['number', 'null'] },
      unit: { type: ['string', 'null'], enum: ['c', 'f', null] },
    },
    required: ['city', 'days', 'unit'],
  });
  assertContractDialect('Forecast', decl.parameters);
  assert.equal(gemini.properties.days.nullable, true, 'the tool keeps its own declaration');
});

test('load_memory declares its query argument', () => {
  const decl = contractToolDeclaration(LOAD_MEMORY)!;
  assert.equal(decl.name, 'load_memory');
  assert.deepEqual(decl.parameters.required, ['query']);
  assert.equal((decl.parameters.properties as Node).query.type, 'string');
});

test('preload_memory and the server-side tools declare nothing', () => {
  for (const tool of [PRELOAD_MEMORY, WEB_SEARCH, X_SEARCH, COLLECTIONS_SEARCH, URL_CONTEXT, GOOGLE_SEARCH, ADK_URL_CONTEXT]) {
    assert.equal(contractToolDeclaration(tool), undefined, (tool as { name: string }).name);
  }
});

test('an MCP-style FunctionTool in uppercase is lowercased by keyword, not by key name', () => {
  // The shape lib/tools/mcpToolFactory.ts builds. A property named `type`
  // holds a schema; a name-blind walk copies it verbatim, uppercase and all.
  const tool = new FunctionTool({
    name: 'file_issue',
    description: 'File an issue',
    parameters: {
      type: 'OBJECT',
      properties: {
        type: { type: 'STRING', enum: ['BUG', 'FEATURE'] },
        labels: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: '5' },
        meta: { type: 'OBJECT', properties: { default: { type: 'BOOLEAN' } } },
      },
      required: ['type'],
    } as unknown as Schema,
    execute: async () => '',
  });
  assert.deepEqual(contractToolDeclaration(tool)!.parameters, {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['BUG', 'FEATURE'] },
      labels: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      meta: { type: 'object', properties: { default: { type: 'boolean' } } },
    },
    required: ['type'],
  });
});

test('a declaration may carry parametersJsonSchema in place of parameters', () => {
  const tool = {
    name: 'lookup',
    _getDeclaration: () => ({ name: 'lookup', description: 'Look it up', parametersJsonSchema: { type: 'object', properties: { id: { type: 'string' } } } }),
  };
  assert.deepEqual(contractToolDeclaration(tool)!.parameters, { type: 'object', properties: { id: { type: 'string' } } });
});

test('nothing that is not a named tool is declared', () => {
  for (const value of [undefined, null, 'web_search', 42, [], { description: 'no name' }, { _getDeclaration: () => { throw new Error('boom'); } }]) {
    assert.equal(contractToolDeclaration(value), undefined, JSON.stringify(value));
  }
  // A hand-built tool with no parameters takes no arguments.
  assert.deepEqual(contractToolDeclaration({ name: 'ping' })!.parameters, { type: 'object', properties: {} });
});

// ── defineTool contracts ─────────────────────────────────────────────────────

const PROBE = defineTool({
  name: 'probe',
  description: 'Exercises every shape a contract schema takes.',
  schema: z.object({
    query: z.string().min(1).max(200).describe('What to look for'),
    limit: z.number().int().min(1).max(10).default(3),
    tags: z.array(z.object({ key: z.string(), value: z.string().optional() })).max(5),
    window: z.object({ from: z.string(), to: z.string().optional() }).nullable(),
    mode: z.enum(['fast', 'deep']).optional(),
    either: z.union([z.string(), z.object({ id: z.number(), note: z.object({ text: z.string() }).optional() })]),
    counts: z.record(z.string(), z.number()),
  }),
  execute: async () => '',
});

const CONTRACTS = [...WIKI_AGENT_TOOL_CONTRACTS, ...SCIENCE_TOOL_CONTRACTS, ...TASK_TOOL_CONTRACTS, PROBE];

test('a defineTool contract declares the same parameters directly and through its FunctionTool', () => {
  for (const contract of CONTRACTS) {
    for (const strict of [false, true]) {
      const direct = contractToolDeclaration(contract, { strict });
      const viaAdk = contractToolDeclaration(toFunctionTool(contract), { strict });
      assert.ok(direct, `${contract.name} is declared`);
      assert.deepEqual(direct, viaAdk, `${contract.name}${strict ? ' (strict)' : ''}`);
      assertContractDialect(contract.name, direct!.parameters);
    }
  }
});

test("a contract's declaration comes from zod, without the keywords the ADK path cannot carry", () => {
  const decl = contractToolDeclaration(PROBE)!;
  assert.equal(decl.name, 'probe');
  assert.equal(decl.description, PROBE.description);
  const props = decl.parameters.properties as Node;
  assert.deepEqual(props.query, { type: 'string', minLength: 1, maxLength: 200, description: 'What to look for' });
  assert.deepEqual(props.limit, { type: 'integer', minimum: 1, maximum: 10 }, 'default is left out');
  assert.deepEqual(props.window.anyOf[1], { type: 'null' });
  assert.deepEqual(
    props.counts,
    { type: 'object', additionalProperties: { type: 'number' } },
    "a map keeps its value schema, as the ADK path keeps it",
  );
  assert.ok(!(decl.parameters.required as string[]).includes('limit'), 'a field with a default is optional');
  for (const node of schemaNodes(decl.parameters)) {
    assert.ok(typeof node.additionalProperties !== 'boolean', 'a boolean additionalProperties is left out');
  }
});

test('a contract property named like a keyword keeps its schema', () => {
  const contract = defineTool({
    name: 'keywords',
    description: 'Properties named type and enum.',
    schema: z.object({ type: z.enum(['a', 'b']), enum: z.array(z.string()) }),
    execute: async () => '',
  });
  assert.deepEqual(contractToolDeclaration(contract)!.parameters, {
    type: 'object',
    properties: { type: { type: 'string', enum: ['a', 'b'] }, enum: { type: 'array', items: { type: 'string' } } },
    required: ['type', 'enum'],
  });
});

// ── The strict variant ───────────────────────────────────────────────────────

test('the strict variant reaches every object node, however deep', () => {
  const decl = contractToolDeclaration(PROBE, { strict: true })!;
  assert.equal(decl.strict, true);
  assertStrict('probe', decl.parameters);
  const props = decl.parameters.properties as Node;
  assert.deepEqual(decl.parameters.required, ['query', 'limit', 'tags', 'window', 'mode', 'either', 'counts']);
  assert.deepEqual(props.tags.items.required, ['key', 'value'], 'inside items');
  assert.equal(props.tags.items.additionalProperties, false);
  assert.deepEqual(props.window.anyOf[0].required, ['from', 'to'], 'inside anyOf');
  assert.deepEqual(props.either.anyOf[1].properties.note.required, ['text'], 'an object inside an object inside anyOf');
  assert.equal(props.either.anyOf[1].properties.note.additionalProperties, false);
  assert.deepEqual(props.counts.additionalProperties, { type: 'number' }, 'a map without properties is left open, with its value schema');
});

test('toContractJsonSchema: strict through $defs and tuples, and the input untouched', () => {
  const gemini = {
    type: 'OBJECT',
    properties: {
      pair: { type: 'ARRAY', prefixItems: [{ type: 'OBJECT', properties: { a: { type: 'STRING' } } }] },
      ref: { $ref: '#/$defs/Leaf' },
    },
    $defs: { Leaf: { type: 'OBJECT', properties: { b: { type: 'INTEGER', nullable: true } } } },
  };
  const before = JSON.stringify(gemini);
  const strict = toContractJsonSchema(gemini, { strict: true }) as Node;
  assert.equal(JSON.stringify(gemini), before, 'never mutates its input');
  assertContractDialect('defs', strict);
  assertStrict('defs', strict);
  assert.deepEqual(strict.properties.pair.prefixItems[0].required, ['a']);
  assert.deepEqual(strict.$defs.Leaf, { type: 'object', properties: { b: { type: ['integer', 'null'] } }, required: ['b'], additionalProperties: false });
  assert.deepEqual(toContractJsonSchema(undefined), { type: 'object', properties: {} });
});

test("Gemini's nullable admits null whatever the node is built from", () => {
  const schema = toContractJsonSchema({
    type: 'OBJECT',
    properties: {
      typed: { type: 'STRING', nullable: true, description: 'kept on the node' },
      already: { type: ['STRING', 'NULL'], nullable: true },
      either: { anyOf: [{ type: 'STRING' }, { type: 'NUMBER' }], nullable: true },
      ref: { $ref: '#/$defs/Leaf', nullable: true, description: 'a leaf' },
      both: { allOf: [{ type: 'OBJECT', properties: { a: { type: 'STRING' } } }], nullable: true },
      fixed: { type: 'STRING', const: 'x', nullable: true },
      anything: { description: 'no constraint', nullable: true },
      notNull: { type: 'STRING', nullable: false },
    },
    $defs: { Leaf: { type: 'STRING' } },
  }) as Node;
  const p = schema.properties;
  assert.deepEqual(p.typed, { type: ['string', 'null'], description: 'kept on the node' });
  assert.deepEqual(p.already, { type: ['string', 'null'] });
  assert.deepEqual(p.either, { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] });
  assert.deepEqual(p.ref, { description: 'a leaf', anyOf: [{ $ref: '#/$defs/Leaf' }, { type: 'null' }] });
  assert.deepEqual(p.both, { anyOf: [{ allOf: [{ type: 'object', properties: { a: { type: 'string' } } }] }, { type: 'null' }] });
  assert.deepEqual(p.fixed, { anyOf: [{ type: 'string', const: 'x' }, { type: 'null' }] });
  assert.deepEqual(p.anything, { description: 'no constraint' });
  assert.deepEqual(p.notNull, { type: 'string' });
  assertContractDialect('nullable', schema);
});

test('an untrusted schema with an own __proto__ key changes no prototype', () => {
  const fromMcp = JSON.parse('{"type":"OBJECT","properties":{"x":{"__proto__":{"polluted":true},"$ref":"#/a","nullable":true}}}');
  const schema = toContractJsonSchema(fromMcp) as Node;
  const inner = schema.properties.x.anyOf[0];
  assert.equal(Object.getPrototypeOf(inner), Object.prototype);
  assert.ok(Object.hasOwn(inner, '__proto__'), 'kept as a key');
  assert.equal(({} as Node).polluted, undefined);
  assert.equal(inner.polluted, undefined);
});

test('the strict form reaches an object that nullable moved into an anyOf branch', () => {
  const strict = toContractJsonSchema(
    {
      type: 'OBJECT',
      properties: {
        window: { type: 'OBJECT', properties: { from: { type: 'STRING' } }, nullable: true },
        pinned: { type: 'OBJECT', properties: { at: { type: 'STRING' } }, const: { at: 'now' }, nullable: true },
      },
    },
    { strict: true },
  ) as Node;
  assertStrict('nullable objects', strict);
  assert.deepEqual(strict.properties.window, { type: ['object', 'null'], properties: { from: { type: 'string' } }, required: ['from'], additionalProperties: false });
  assert.deepEqual(strict.properties.pinned.anyOf[0].required, ['at']);
  assert.equal(strict.properties.pinned.anyOf[0].additionalProperties, false);
});

test('a strict declaration leaves the tool and its non-strict declaration as they were', () => {
  const tool = toFunctionTool(PROBE);
  const plain = contractToolDeclaration(tool)!;
  contractToolDeclaration(tool, { strict: true });
  assert.deepEqual(contractToolDeclaration(tool), plain);
  assert.equal(plain.parameters.additionalProperties, undefined);
});

// ── NativeTool ───────────────────────────────────────────────────────────────

test('the server-side tools map to their NativeTool', () => {
  const cases: Array<[unknown, NativeTool]> = [
    [WEB_SEARCH, 'web_search'],
    [GOOGLE_SEARCH, 'google_search'],
    [URL_CONTEXT, 'url_context'],
    [ADK_URL_CONTEXT, 'url_context'],
    [X_SEARCH, 'x_search'],
    [COLLECTIONS_SEARCH, 'collections_search'],
    [new BuiltInCodeExecutor(), 'code_execution'],
  ];
  for (const [tool, expected] of cases) assert.equal(nativeToolOf(tool), expected, expected);
});

test('NativeTool is recognised by marker and name, not by class', () => {
  // A second copy of a sentinel module: same name, no declaration, another class.
  assert.equal(nativeToolOf({ name: 'x_search', _getDeclaration: () => undefined }), 'x_search');
  // ADK's markers live in the global symbol registry.
  assert.equal(nativeToolOf({ name: 'google_search', [Symbol.for('google.adk.inModelTool')]: true }), 'google_search');
  assert.equal(nativeToolOf({ [Symbol.for('google.adk.builtInCodeExecutor')]: true }), 'code_execution');
});

test('a client-side tool is never a NativeTool, whatever its name', () => {
  const clientSearch = new FunctionTool({
    name: 'web_search',
    description: 'A client-side search someone registered under the same name',
    parameters: z.object({ q: z.string() }),
    execute: async () => '',
  });
  const contract = defineTool({ name: 'web_search', description: 'search', schema: z.object({ q: z.string() }), execute: async () => '' });
  for (const tool of [clientSearch, contract, toFunctionTool(contract), LOAD_MEMORY, subagentTool('Scout'), PRELOAD_MEMORY]) {
    assert.equal(nativeToolOf(tool), undefined, (tool as { name: string }).name);
  }
  assert.ok(contractToolDeclaration(clientSearch), 'and it is declared');
  for (const value of [undefined, null, 'web_search', { name: 'web_search' }, { name: 'web_search', _getDeclaration: () => { throw new Error('boom'); } }]) {
    assert.equal(nativeToolOf(value), undefined, String(value));
  }
});

test('a request in the contract splits a resolved tool list into tools and nativeTools', () => {
  const resolved = resolveTools(['web_search', 'wiki_read', 'load_memory', 'x_search']);
  const tools: ToolDeclaration[] = resolved.map((t) => contractToolDeclaration(t)).filter((d): d is ToolDeclaration => !!d);
  const nativeTools = resolved.map(nativeToolOf).filter((n): n is NativeTool => !!n);
  assert.deepEqual(tools.map((t) => t.name), ['wiki_read', 'load_memory']);
  assert.deepEqual(nativeTools, ['web_search', 'x_search']);
});
