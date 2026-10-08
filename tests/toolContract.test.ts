/**
 * tests/toolContract.test.ts — the engine's own tool base (lib/tools/tool.ts,
 * lib/tools/toolContract.ts, ADR 0051).
 *
 * Asserted:
 *   - defineTool makes a Tool: a declaration in the model contract's shape,
 *     and an execute that validates once and hands the handler a complete
 *     ToolContext on every surface. It is still a ToolContract.
 *   - The context: state reads see writes, writes land in stateDelta, the
 *     approval request is recorded.
 *   - requireApproval, the long-running marker and result capping.
 *   - The WS1-9 follow-ups: a zod default is optional to the model on every
 *     path, toGeminiSchema walks by keyword, and a record keeps its value
 *     schema.
 *   - Every registry tool that declares a function is an own Tool, and
 *     preload_memory is an own InstructionTool. registerTool refuses an ADK
 *     tool, which 1.0.0 no longer runs.
 *   - tool.ts and toolContract.ts import nothing from @google/* at runtime.
 *
 * Offline: no model is called.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { contractToolDeclaration } from '../lib/models/schemaNormalize.ts';
import { RESERVED_TOOL_NAMES, registerTool, registeredToolNames, resolveTools } from '../lib/toolRegistry.ts';
import { MAX_MCP_RESULT_CHARS } from '../lib/tools/mcpToolFactory.ts';
import { MAX_RESULT_CHARS as OPENAPI_RESULT_CHARS } from '../lib/tools/openapiTools.ts';
import {
  APPROVAL_TEXTS,
  LONG_RUNNING_NOTE,
  MAX_RESULT_CHARS,
  capResult,
  createToolContext,
  instructionToolOf,
  isLongRunning,
  isTool,
  requireApproval,
  toToolContext,
  toolOf,
} from '../lib/tools/tool.ts';
import type { Tool, ToolContext } from '../lib/tools/tool.ts';
import {
  asTool,
  defineTool,
  executeContract,
  toGeminiSchema,
  toMcpToolDefinition,
  toStandardJsonSchema,
} from '../lib/tools/toolContract.ts';
import type { ToolContract } from '../lib/tools/toolContract.ts';
import { askUserTool } from '../lib/runtime/questions.ts';
import { adkReferences } from './helpers/adkReference.ts';

// ADK's long-running note, the reference for LONG_RUNNING_NOTE, is recorded
// (tests/fixtures/adk-reference/toolcontract) by ADK 2.2's LongRunningFunctionTool.
const reference = adkReferences('toolContract');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Node = Record<string, any>;

const LOOKUP = defineTool({
  name: 'lookup',
  description: 'Looks a key up.',
  schema: z.object({
    key: z.string().min(1).describe('The key'),
    limit: z.number().int().min(1).max(10).default(3),
  }),
  execute: async ({ key, limit }, ctx) => `${key}:${limit}:${ctx.userId ?? '-'}`,
});

// ── defineTool makes a Tool ──────────────────────────────────────────────────

test('defineTool makes a Tool whose declaration is in the model contract shape', () => {
  assert.ok(isTool(LOOKUP));
  assert.equal(LOOKUP.name, 'lookup');
  assert.deepEqual(LOOKUP.declaration(), {
    name: 'lookup',
    description: 'Looks a key up.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', minLength: 1, description: 'The key' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['key'],
    },
  });
  // Each call hands out its own copy.
  const decl = LOOKUP.declaration();
  (decl.parameters.properties as Node).key.type = 'number';
  assert.equal((LOOKUP.declaration().parameters.properties as Node).key.type, 'string');
  assert.deepEqual(contractToolDeclaration(LOOKUP), LOOKUP.declaration());
});

test('execute validates the arguments and runs the handler with defaults applied', async () => {
  assert.equal(await LOOKUP.execute({ key: 'a' }, createToolContext({ userId: 'alice' })), 'a:3:alice');
  assert.equal(await LOOKUP.execute({ key: 'a', limit: 5, extra: true }), 'a:5:-', 'unknown keys are stripped');
  assert.match(String(await LOOKUP.execute({ key: '' })), /^Error: invalid arguments for lookup: key: /);
  assert.match(String(await LOOKUP.execute(undefined)), /^Error: invalid arguments for lookup: key: /);
});

test('a defined Tool is still a ToolContract on every surface, and validates once', async () => {
  // A transform makes a second parse fail: the handler would get a number where the schema reads a string.
  let seen: unknown;
  const once = defineTool({
    name: 'once',
    description: 'Counts characters.',
    schema: z.object({ text: z.string().transform((s) => s.length) }),
    execute: async ({ text }) => ((seen = text), `length ${text}`),
  });
  const asContract: ToolContract<any> = once;
  assert.equal(await executeContract(asContract, { text: 'abcd' }), 'length 4');
  assert.equal(seen, 4);
  assert.deepEqual(toMcpToolDefinition(once).inputSchema, {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  });
  // A hand-built contract object is validated by executeContract, as before.
  const plain = { name: 'plain', description: 'p', schema: z.object({ n: z.number() }), execute: async ({ n }: { n: number }) => `n=${n}` };
  assert.equal(await executeContract(plain, { n: 2 }), 'n=2');
  assert.match(await executeContract(plain, { n: 'x' }), /^Error: invalid arguments for plain: n: /);
  assert.ok(isTool(asTool(plain)), 'asTool makes a hand-built contract a Tool');
  assert.equal(asTool(LOOKUP), LOOKUP, 'a Tool stays itself');
  const annotated = defineTool({ ...plain, annotations: { readOnly: true } } as ToolContract<any>);
  assert.deepEqual((annotated as unknown as Node).annotations, { readOnly: true }, "a spec's own fields ride along");
});

// ── The context ──────────────────────────────────────────────────────────────

test('a standalone context: reads see writes, writes land in stateDelta, the base stays as it was', () => {
  const base = { seen: 1 };
  const ctx = createToolContext({ state: base, userId: 'u', agentName: 'Boss', invocationId: 'inv', functionCallId: 'c' });
  assert.equal(ctx.state.get('seen'), 1);
  assert.equal(ctx.state.has('seen'), true);
  ctx.state.set('seen', 2);
  ctx.state.set('fresh', 'x');
  assert.equal(ctx.state.get('seen'), 2);
  assert.deepEqual(ctx.stateDelta, { seen: 2, fresh: 'x' });
  assert.deepEqual(base, { seen: 1 }, 'the session state is never mutated');
  ctx.state.set('__proto__', { polluted: true });
  assert.equal(Object.getPrototypeOf(ctx.stateDelta), Object.prototype);
  assert.equal(({} as Node).polluted, undefined);
  assert.deepEqual(ctx.state.get('__proto__'), { polluted: true });
  assert.equal(ctx.state.has('toString'), false, 'inherited names are not state');
  assert.equal(ctx.confirmationRequest, undefined);
  ctx.requestConfirmation({ hint: 'ok?', payload: { a: 1 } });
  assert.deepEqual(ctx.confirmationRequest, { hint: 'ok?', payload: { a: 1 } });
  assert.equal(ctx.actions.skipSummarization, undefined);
  assert.deepEqual([ctx.userId, ctx.agentName, ctx.invocationId, ctx.functionCallId], ['u', 'Boss', 'inv', 'c']);
});

test('toToolContext keeps a complete context and completes a partial one', () => {
  const full = createToolContext({ userId: 'u' });
  assert.equal(toToolContext(full), full);
  const fromCaller = toToolContext({ userId: 'alice' });
  assert.equal(fromCaller.userId, 'alice');
  assert.equal(fromCaller.state.get('anything'), undefined);
  assert.equal(typeof toToolContext(undefined).requestConfirmation, 'function');
});

// ── Approval ─────────────────────────────────────────────────────────────────

test('requireApproval: the first call asks, a refusal refuses, an approval runs', async () => {
  let runs = 0;
  const send = defineTool({ name: 'send', description: 'Sends.', schema: z.object({ to: z.string() }), execute: async ({ to }) => (runs++, `sent to ${to}`) });
  const gated = requireApproval(send);
  assert.equal(gated.requiresApproval, true);
  assert.equal(send.requiresApproval, undefined, 'the original stays ungated');
  assert.equal(requireApproval(gated), gated);
  assert.deepEqual(gated.declaration(), send.declaration());

  const first = createToolContext();
  assert.deepEqual(await gated.execute({ to: 'a' }, first), { error: APPROVAL_TEXTS.pending });
  assert.deepEqual(first.confirmationRequest, { hint: APPROVAL_TEXTS.hint('send'), payload: undefined });
  assert.equal(first.actions.skipSummarization, true);
  assert.deepEqual(await gated.execute({ to: 'a' }, createToolContext({ confirmation: { confirmed: false } })), { error: APPROVAL_TEXTS.rejected });
  assert.equal(runs, 0);
  assert.equal(await gated.execute({ to: 'a' }, createToolContext({ confirmation: { confirmed: true } })), 'sent to a');
  assert.equal(runs, 1);
});

// ── Long-running ─────────────────────────────────────────────────────────────

test("a long-running Tool declares ADK's note and answers nothing, so the run waits", async () => {
  const wait = defineTool({
    name: 'wait_for_it',
    description: 'Waits.',
    schema: z.object({ q: z.string() }),
    longRunning: true,
    execute: async (_input, ctx): Promise<undefined> => {
      ctx.actions.skipSummarization = true;
      return undefined;
    },
  });
  assert.ok(isLongRunning(wait));
  assert.ok(!isLongRunning(LOOKUP));
  assert.equal(wait.declaration().description, `Waits.${LONG_RUNNING_NOTE}`);
  // The note is ADK's own, word for word, as ADK 2.2 recorded it.
  const adkOwn = await reference<{ description: string }>('long-running-note');
  assert.equal(wait.declaration().description, adkOwn.description);

  assert.deepEqual(contractToolDeclaration(wait), wait.declaration());
  const ctx = createToolContext();
  assert.equal(await wait.execute({ q: 'x' }, ctx), undefined, 'no response: the run waits for one');
  assert.equal(ctx.actions.skipSummarization, true);
});

test('ask_user is a long-running own Tool in the registry', async () => {
  assert.ok(isTool(askUserTool) && isLongRunning(askUserTool));
  const [registered] = resolveTools(['ask_user']);
  assert.equal(toolOf(registered), askUserTool);
  assert.equal(isLongRunning(registered), true);
  assert.deepEqual(contractToolDeclaration(registered), askUserTool.declaration());
  assert.ok(askUserTool.declaration().description.endsWith(LONG_RUNNING_NOTE));
  const ctx = createToolContext();
  assert.equal(await askUserTool.execute({ question: 'Which account?' }, ctx), undefined);
  assert.equal(ctx.actions.skipSummarization, true);
});

// ── Result size ──────────────────────────────────────────────────────────────

test('capResult cuts a long result and says so; the shared limit is the existing one', async () => {
  assert.equal(MAX_RESULT_CHARS, 20_000);
  assert.equal(OPENAPI_RESULT_CHARS, MAX_RESULT_CHARS);
  assert.equal(MAX_MCP_RESULT_CHARS, MAX_RESULT_CHARS);
  assert.equal(capResult('short', 10), 'short');
  assert.equal(capResult('0123456789abc', 10), '0123456789… [cut at 10 characters]');
  assert.deepEqual(capResult({ a: 1 }, 10), { a: 1 });
  assert.deepEqual(capResult({ text: 'x'.repeat(20) }, 10), { truncated: true, text: '{"text":"x… [cut at 10 characters]' });
  assert.equal(capResult(undefined, 1), undefined);
  assert.equal((capResult('y'.repeat(MAX_RESULT_CHARS + 5)) as string).length, MAX_RESULT_CHARS + '… [cut at 20000 characters]'.length);

  const big = defineTool({ name: 'big', description: 'Big.', schema: z.object({}), maxResultChars: 5, execute: async () => 'abcdefgh' });
  assert.equal(await big.execute({}), 'abcde… [cut at 5 characters]');
  assert.equal(await LOOKUP.execute({ key: 'k'.repeat(30_000) }).then((r) => r.length > 30_000), true, 'no cap unless the tool sets one');
});

// ── The WS1-9 follow-ups ─────────────────────────────────────────────────────

const FOLLOW_UPS = defineTool({
  name: 'follow_ups',
  description: 'Exercises the schema follow-ups.',
  schema: z.object({
    query: z.string(),
    limit: z.number().int().default(8),
    additionalProperties: z.string().describe('A property, not the keyword'),
    default: z.boolean().optional().describe('Also a property'),
    counts: z.record(z.string(), z.number()),
    nested: z.object({ depth: z.number().default(1), default: z.string() }),
  }),
  execute: async () => 'ok',
});

test('a field with a default is optional to the model on every path', () => {
  const standard = toStandardJsonSchema(FOLLOW_UPS) as Node;
  assert.deepEqual(standard.required, ['query', 'additionalProperties', 'counts', 'nested']);
  assert.deepEqual(standard.properties.nested.required, ['default']);
  assert.deepEqual(toMcpToolDefinition(FOLLOW_UPS).inputSchema.required, standard.required);
  const direct = FOLLOW_UPS.declaration().parameters as Node;
  assert.deepEqual(direct.required, standard.required);
  assert.deepEqual(direct.properties.nested.required, ['default']);
  assert.deepEqual((contractToolDeclaration(FOLLOW_UPS)!.parameters as Node).required, standard.required);
});

test('toGeminiSchema walks by keyword: a property named additionalProperties or default survives', () => {
  const gemini = toGeminiSchema(toStandardJsonSchema(FOLLOW_UPS)) as Node;
  assert.deepEqual(gemini.properties.additionalProperties, { type: 'STRING', description: 'A property, not the keyword' });
  assert.deepEqual(gemini.properties.default, { type: 'BOOLEAN', description: 'Also a property' });
  assert.deepEqual(gemini.properties.nested.properties.default, { type: 'STRING' });
  assert.equal(gemini.properties.limit.type, 'INTEGER');
  assert.equal('default' in gemini.properties.limit, false, 'the default keyword is dropped');
  assert.deepEqual(gemini.properties.nested.properties.depth, { type: 'NUMBER' });
  // Data is copied, not walked: an enum value or a const keeps its case.
  assert.deepEqual(toGeminiSchema({ type: 'object', properties: { t: { type: 'string', enum: ['object'], const: { type: 'x' } } } }), {
    type: 'OBJECT',
    properties: { t: { type: 'STRING', enum: ['object'], const: { type: 'x' } } },
  });
  assert.deepEqual(toGeminiSchema('nope'), { type: 'OBJECT', properties: {} });
  // The contract declaration and the Tool's own one name the same properties.
  assert.deepEqual(contractToolDeclaration(FOLLOW_UPS), FOLLOW_UPS.declaration());
});

test('a record keeps its value schema in the Gemini dialect and the contract', () => {
  const gemini = toGeminiSchema(toStandardJsonSchema(FOLLOW_UPS)) as Node;
  // Gemini refuses `propertyNames` with a 400 and accepts the value schema (live, 2026-10-08).
  assert.deepEqual(gemini.properties.counts, { type: 'OBJECT', additionalProperties: { type: 'NUMBER' } });
  const direct = FOLLOW_UPS.declaration().parameters as Node;
  assert.deepEqual(direct.properties.counts, { type: 'object', additionalProperties: { type: 'number' } }, 'keys are strings in JSON: propertyNames adds nothing');
  assert.deepEqual((contractToolDeclaration(FOLLOW_UPS)!.parameters as Node).properties.counts, direct.properties.counts);
  // A strict object's `additionalProperties: false` is still left out of the Gemini dialect.
  const closed = toGeminiSchema(z.toJSONSchema(z.strictObject({ a: z.string() }), { io: 'input' }));
  assert.equal('additionalProperties' in closed, false);
});

// ── The registry ─────────────────────────────────────────────────────────────

test('every registry tool that declares a function is an own Tool', async () => {
  const own: string[] = [];
  for (const name of registeredToolNames()) {
    const [registered] = resolveTools([name]);
    const declared = contractToolDeclaration(registered);
    if (!declared) {
      // A server-side marker, or preload_memory: an own InstructionTool.
      assert.equal(toolOf(registered), undefined, `${name} declares nothing, so it is no Tool`);
      if (name === 'preload_memory') assert.equal(instructionToolOf(registered)?.name, 'preload_memory');
      continue;
    }
    const tool = toolOf(registered);
    assert.ok(tool, `${name} is built through the tool base`);
    assert.equal(tool, registered, `${name} is held as the Tool itself`);
    assert.equal(tool!.name, name);
    assert.deepEqual(declared, tool!.declaration(), `${name}: the contract declaration is what the Tool declares`);
    own.push(name);
  }
  for (const name of ['ask_user', 'generate_image', 'inspect_image', 'load_memory', 'web_extract', 'x_api_search', 'wiki_read', 'task_add', 'search_literature']) {
    assert.ok(own.includes(name), `${name} is an own Tool`);
  }
});

test('registerTool takes a defineTool contract or a hand-built Tool', async () => {
  const handBuilt: Tool = {
    name: 'probe_hand_built_tool',
    declaration: () => ({ name: 'probe_hand_built_tool', description: 'Echoes.', parameters: { type: 'object', properties: { s: { type: 'string' } } } }),
    execute: async (args: Record<string, unknown>, ctx: ToolContext) => `${String(args.s)} for ${ctx.userId}`,
  };
  registerTool('probe_hand_built_tool', handBuilt);
  const [registered] = resolveTools(['probe_hand_built_tool']);
  assert.equal(registered, handBuilt);
  assert.equal(toolOf(registered), handBuilt);
  assert.equal(await toolOf(registered)!.execute({ s: 'x' }, createToolContext({ userId: 'scope-a' })), 'x for scope-a');
  assert.deepEqual(contractToolDeclaration(registered)!.parameters, { type: 'object', properties: { s: { type: 'string' } } });

  registerTool('probe_defined_tool', LOOKUP);
  assert.equal(toolOf(resolveTools(['probe_defined_tool'])[0]), LOOKUP);
});

test('registerTool refuses an ADK tool, naming 1.0.0 and defineTool, and an object that is no tool', () => {
  const adkShaped = {
    name: 'probe_adk_tool',
    description: 'An ADK FunctionTool, by shape.',
    runAsync: async () => 'ran',
    _getDeclaration: () => ({ name: 'probe_adk_tool', description: 'An ADK FunctionTool, by shape.' }),
  };
  assert.throws(() => registerTool('probe_adk_tool', adkShaped), (err: Error) => /1\.0\.0/.test(err.message) && /defineTool/.test(err.message));
  assert.throws(() => registerTool('probe_not_a_tool', { name: 'probe_not_a_tool', description: 'Nothing to run.' }), /is not a tool/);
  assert.throws(() => registerTool('probe_not_an_object', 'lookup'), /is not a tool/);
  assert.ok(!registeredToolNames().includes('probe_adk_tool'));
  assert.ok(!registeredToolNames().includes('probe_not_a_tool'));
});

test('registerTool refuses the framework\'s reserved names, as the registry name or the tool\'s own (0.20.0)', () => {
  assert.deepEqual([...RESERVED_TOOL_NAMES].sort(), [
    'adk_handle_model_error', 'adk_request_confirmation', 'adk_request_credential', 'adk_request_input',
    'ask_user', 'finish_task', 'set_model_response', 'transfer_to_agent',
  ]);
  const impostor = (name: string): Tool => ({
    name,
    declaration: () => ({ name, description: 'Pretends.', parameters: { type: 'object', properties: {} } }),
    execute: async () => 'forged',
  });
  for (const name of RESERVED_TOOL_NAMES) {
    assert.throws(() => registerTool(name, impostor(name), { override: true }), new RegExp(`registerTool: '${name}' is reserved by the framework`), name);
    assert.throws(() => registerTool(`probe_alias_${name}`, impostor(name)), new RegExp(`'${name}' is reserved`), `${name} under another registry name`);
    assert.ok(!registeredToolNames().includes(`probe_alias_${name}`));
  }
  // The framework's own ask_user may be registered again, under its name.
  const before = resolveTools(['ask_user'])[0];
  registerTool('ask_user', askUserTool, { override: true });
  registerTool('ask_user', before, { override: true });
  assert.equal(toolOf(resolveTools(['ask_user'])[0]), askUserTool);
});

// ── No ADK in the tool base ──────────────────────────────────────────────────

/** The source with comments blanked out; string literals are kept whole. */
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The specifiers a module loads at runtime: `import type` and `export type` are erased. */
function runtimeSpecifiers(file: string): string[] {
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  const out: string[] = [];
  for (const m of code.matchAll(/\b(import|export)\b(\s+type\b)?[^'"`;]*?\bfrom\s*(['"])([^'"]+)\3|\bimport\s*(['"])([^'"]+)\5|\bimport\s*\(\s*(['"])([^'"]+)\7\s*\)/g)) {
    if (m[2]) continue;
    out.push(m[4] ?? m[6] ?? m[8]);
  }
  return out;
}

/** Every module `entry` loads at runtime, with the packages each one names. */
function runtimeGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [path.resolve(ROOT, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (graph.has(file)) continue;
    const specs = runtimeSpecifiers(file);
    graph.set(file, specs);
    for (const s of specs) if (s.startsWith('.')) pending.push(path.resolve(path.dirname(file), s));
  }
  return graph;
}

test('tool.ts and toolContract.ts load nothing from @google/* at runtime', () => {
  // tool.ts loads one module, the credential leaf (lib/tools/auth.ts, ADR 0072), which loads nothing.
  const leaf = runtimeGraph('lib/tools/tool.ts');
  assert.deepEqual([...leaf.keys()].map((f) => path.relative(ROOT, f)).sort(), ['lib/tools/auth.ts', 'lib/tools/tool.ts'], 'tool.ts loads only the auth leaf');
  assert.deepEqual([...leaf.values()].flat(), ['./auth.ts']);

  const contract = runtimeGraph('lib/tools/toolContract.ts');
  const packages = [...new Set([...contract.values()].flat().filter((s) => !s.startsWith('.')))];
  assert.deepEqual(packages, ['zod']);
  assert.deepEqual(
    [...contract.keys()].map((f) => path.relative(ROOT, f)).sort(),
    ['lib/models/schemaNormalize.ts', 'lib/tools/auth.ts', 'lib/tools/tool.ts', 'lib/tools/toolContract.ts'],
  );
});

test('the scan sees runtime imports and skips type-only ones (control)', () => {
  // genaiMapping.ts imports two values from @google/genai, and its types in a separate `import type`.
  const mapping = runtimeSpecifiers(path.resolve(ROOT, 'lib/models/genaiMapping.ts'));
  assert.equal(mapping.filter((s) => s === '@google/genai').length, 1, 'the value import is seen, the type-only one skipped');
  assert.ok(fs.readFileSync(path.resolve(ROOT, 'lib/tools/toolContract.ts'), 'utf8').includes("from '../models/contract.ts'"));
  assert.ok(!runtimeSpecifiers(path.resolve(ROOT, 'lib/tools/toolContract.ts')).includes('../models/contract.ts'));
});
