/**
 * tests/toolContract.test.ts — the engine's own tool base (lib/tools/tool.ts,
 * lib/tools/toolContract.ts, ADR 0051) and its ADK wrapper
 * (lib/tools/adkTool.ts).
 *
 * Asserted:
 *   - defineTool makes a Tool: a declaration in the model contract's shape,
 *     and an execute that validates once and hands the handler a complete
 *     ToolContext on every surface. It is still a ToolContract.
 *   - The context: state reads see writes, writes land in stateDelta, the
 *     approval request is recorded, and ADK's Context reads through.
 *   - requireApproval, the long-running marker and result capping.
 *   - The WS1-9 follow-ups: a zod default is optional to the model on every
 *     path, toGeminiSchema walks by keyword, and a record keeps its value
 *     schema on both paths.
 *   - Every registry tool that declares a function is an own Tool behind its
 *     FunctionTool, and preload_memory is an own InstructionTool behind its
 *     ADK tool.
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
import { Context, FunctionTool, LongRunningFunctionTool, ToolConfirmation } from '@google/adk';

import { requireApprovalOn } from '../lib/compile.ts';
import { contractToolDeclaration, toolDeclarationFor } from '../lib/models/schemaNormalize.ts';
import { registerTool, registeredToolNames, resolveTools } from '../lib/toolRegistry.ts';
import { adkToolContext, toFunctionTool } from '../lib/tools/adkTool.ts';
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Node = Record<string, any>;

/** A real ADK Context over a hand-built invocation, as ADK builds one per call. */
function adkContext(opts: { state?: Record<string, unknown>; confirmation?: ToolConfirmation; signal?: AbortSignal } = {}): Context {
  const invocationContext = {
    invocationId: 'inv-1',
    userId: 'scope-a',
    appName: 'desk',
    session: { id: 's1', appName: 'desk', userId: 'scope-a', state: opts.state ?? {}, events: [] },
    agent: { name: 'Boss' },
    abortSignal: opts.signal,
  };
  return new Context({ invocationContext: invocationContext as any, functionCallId: 'call-1', toolConfirmation: opts.confirmation });
}

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

test("ADK's Context reads through: ids, state, delta, actions, confirmation, signal", () => {
  const abort = new AbortController();
  const adk = adkContext({ state: { seen: 1 }, signal: abort.signal });
  const ctx = adkToolContext(adk);
  assert.deepEqual(
    [ctx.invocationId, ctx.agentName, ctx.functionCallId, ctx.userId, ctx.appName, ctx.sessionId],
    ['inv-1', 'Boss', 'call-1', 'scope-a', 'desk', 's1'],
  );
  assert.equal(ctx.state.get('seen'), 1);
  ctx.state.set('note', 'x');
  assert.equal(adk.actions.stateDelta.note, 'x', "the write lands in ADK's delta");
  assert.equal(ctx.stateDelta, adk.actions.stateDelta);
  ctx.actions.skipSummarization = true;
  assert.equal(adk.actions.skipSummarization, true);
  assert.equal(ctx.confirmation, undefined);
  ctx.requestConfirmation({ hint: 'approve?' });
  assert.equal(adk.actions.requestedToolConfirmations['call-1']?.hint, 'approve?');
  assert.equal(ctx.signal, abort.signal);
  const answered = adkToolContext(adkContext({ confirmation: new ToolConfirmation({ confirmed: true, payload: { ok: 1 } }) }));
  assert.deepEqual(answered.confirmation, { confirmed: true, hint: '', payload: { ok: 1 } });
  assert.equal(typeof adkToolContext(undefined).requestConfirmation, 'function', 'outside a run, a standalone context');
});

test('a Tool run through its FunctionTool writes state and actions on the ADK event', async () => {
  const writer = defineTool({
    name: 'writer',
    description: 'Writes a note.',
    schema: z.object({ note: z.string() }),
    execute: async ({ note }, ctx) => {
      ctx.state.set('last_note', note);
      ctx.actions.skipSummarization = true;
      return `saved ${note} for ${ctx.userId} in ${ctx.agentName}`;
    },
  });
  const adk = adkContext();
  const result = await toFunctionTool(writer).runAsync({ args: { note: 'hi' }, toolContext: adk });
  assert.equal(result, 'saved hi for scope-a in Boss');
  assert.deepEqual(adk.actions.stateDelta, { last_note: 'hi' });
  assert.equal(adk.actions.skipSummarization, true);
  // Invalid arguments come back as the readable error, as before.
  assert.match(String(await toFunctionTool(writer).runAsync({ args: {}, toolContext: adkContext() })), /^Error: invalid arguments for writer: note: /);
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

test("a gated Tool on the ADK runtime uses FunctionTool's own gate, with the same texts", async () => {
  let runs = 0;
  const send = defineTool({ name: 'send', description: 'Sends.', schema: z.object({ to: z.string() }), execute: async ({ to }) => (runs++, `sent to ${to}`) });
  const adkGated = toFunctionTool(requireApproval(send));
  assert.ok(adkGated instanceof FunctionTool, 'compile.ts gates only FunctionTools');
  const asking = adkContext();
  assert.deepEqual(await adkGated.runAsync({ args: { to: 'a' }, toolContext: asking }), { error: APPROVAL_TEXTS.pending });
  assert.equal(asking.actions.requestedToolConfirmations['call-1']?.hint, APPROVAL_TEXTS.hint('send'));
  const approved = adkContext({ confirmation: new ToolConfirmation({ confirmed: true }) });
  const refused = adkContext({ confirmation: new ToolConfirmation({ confirmed: false }) });
  assert.deepEqual(await adkGated.runAsync({ args: { to: 'a' }, toolContext: refused }), { error: APPROVAL_TEXTS.rejected });
  assert.equal(await adkGated.runAsync({ args: { to: 'a' }, toolContext: approved }), 'sent to a');
  assert.equal(runs, 1, 'the Tool ran once: both gates read the same answer');
  // compile.ts gates a registry tool on the ADK side; toolOf keeps that gate on the way back.
  const back = toolOf(requireApprovalOn(toFunctionTool(send)))!;
  assert.equal(back.requiresApproval, true);
  assert.equal(toolOf(toFunctionTool(send)), send);
});

// ── Long-running ─────────────────────────────────────────────────────────────

test("a long-running Tool declares ADK's note and stays pending on the ADK runtime", async () => {
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
  // The note is ADK's own, word for word.
  const adkOwn = new LongRunningFunctionTool({ name: 'wait_for_it', description: 'Waits.', execute: async () => null });
  assert.equal(wait.declaration().description, adkOwn._getDeclaration().description);

  const adkTool = toFunctionTool(wait);
  assert.equal(adkTool.isLongRunning, true);
  assert.deepEqual(contractToolDeclaration(adkTool), wait.declaration());
  const adk = adkContext();
  assert.equal(await adkTool.runAsync({ args: { q: 'x' }, toolContext: adk }), undefined, 'no response: ADK waits for one');
  assert.equal(adk.actions.skipSummarization, true);
});

test('ask_user is a long-running own Tool behind its registry FunctionTool', async () => {
  assert.ok(isTool(askUserTool) && isLongRunning(askUserTool));
  const [registered] = resolveTools(['ask_user']);
  assert.equal(toolOf(registered), askUserTool);
  assert.equal((registered as FunctionTool).isLongRunning, true);
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
  const viaAdk = (toFunctionTool(FOLLOW_UPS)._getDeclaration().parameters ?? {}) as Node;
  assert.deepEqual(viaAdk.required, standard.required);
  assert.deepEqual(viaAdk.properties.nested.required, ['default']);
  assert.deepEqual(toolDeclarationFor(toFunctionTool(FOLLOW_UPS))!.parameters.required, standard.required);
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
  // The ADK declaration and the direct one name the same properties.
  const viaAdk = contractToolDeclaration(toFunctionTool(FOLLOW_UPS))!;
  assert.deepEqual(viaAdk, FOLLOW_UPS.declaration());
});

test('a record keeps its value schema on both paths', () => {
  const gemini = toGeminiSchema(toStandardJsonSchema(FOLLOW_UPS)) as Node;
  // Gemini refuses `propertyNames` with a 400 and accepts the value schema (live, 2026-10-08).
  assert.deepEqual(gemini.properties.counts, { type: 'OBJECT', additionalProperties: { type: 'NUMBER' } });
  const direct = FOLLOW_UPS.declaration().parameters as Node;
  assert.deepEqual(direct.properties.counts, { type: 'object', additionalProperties: { type: 'number' } }, 'keys are strings in JSON: propertyNames adds nothing');
  assert.deepEqual((contractToolDeclaration(toFunctionTool(FOLLOW_UPS))!.parameters as Node).properties.counts, direct.properties.counts);
  assert.deepEqual(
    (toolDeclarationFor(toFunctionTool(FOLLOW_UPS))!.parameters as Node).properties.counts,
    direct.properties.counts,
    "and the ADK path's non-Gemini adapters see it too",
  );
  // A strict object's `additionalProperties: false` is still left out of the ADK dialect.
  const closed = toGeminiSchema(z.toJSONSchema(z.strictObject({ a: z.string() }), { io: 'input' }));
  assert.equal('additionalProperties' in closed, false);
});

// ── The registry ─────────────────────────────────────────────────────────────

test('every registry tool that declares a function is an own Tool behind its FunctionTool', async () => {
  const own: string[] = [];
  for (const name of registeredToolNames()) {
    const [adkTool] = resolveTools([name]);
    const declared = contractToolDeclaration(adkTool);
    if (!declared) {
      // A server-side sentinel, or preload_memory: an own InstructionTool.
      assert.equal(toolOf(adkTool), undefined, `${name} declares nothing, so it is no Tool`);
      if (name === 'preload_memory') assert.equal(instructionToolOf(adkTool)?.name, 'preload_memory');
      continue;
    }
    const tool = toolOf(adkTool);
    assert.ok(tool, `${name} is built through the tool base`);
    assert.ok(adkTool instanceof FunctionTool, `${name} reaches ADK as a FunctionTool`);
    assert.equal(tool!.name, name);
    assert.deepEqual(declared, tool!.declaration(), `${name}: the ADK path declares what the Tool declares`);
    own.push(name);
  }
  for (const name of ['ask_user', 'generate_image', 'inspect_image', 'load_memory', 'web_extract', 'x_api_search', 'wiki_read', 'task_add', 'search_literature']) {
    assert.ok(own.includes(name), `${name} is an own Tool`);
  }
});

test('registerTool takes a defineTool contract, a hand-built Tool, or an ADK tool', async () => {
  const handBuilt: Tool = {
    name: 'probe_hand_built_tool',
    declaration: () => ({ name: 'probe_hand_built_tool', description: 'Echoes.', parameters: { type: 'object', properties: { s: { type: 'string' } } } }),
    execute: async (args: Record<string, unknown>, ctx: ToolContext) => `${String(args.s)} for ${ctx.userId}`,
  };
  registerTool('probe_hand_built_tool', handBuilt);
  const [adkTool] = resolveTools(['probe_hand_built_tool']);
  assert.ok(adkTool instanceof FunctionTool);
  assert.equal(toolOf(adkTool), handBuilt);
  assert.equal(await (adkTool as FunctionTool).runAsync({ args: { s: 'x' }, toolContext: adkContext() }), 'x for scope-a');
  assert.deepEqual((adkTool as FunctionTool)._getDeclaration().parameters, { type: 'OBJECT', properties: { s: { type: 'STRING' } } });

  registerTool('probe_defined_tool', LOOKUP);
  assert.equal(toolOf(resolveTools(['probe_defined_tool'])[0]), LOOKUP);
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
  const leaf = runtimeGraph('lib/tools/tool.ts');
  assert.deepEqual([...leaf.keys()].map((f) => path.relative(ROOT, f)), ['lib/tools/tool.ts'], 'tool.ts loads no other module');
  assert.deepEqual([...leaf.values()].flat(), []);

  const contract = runtimeGraph('lib/tools/toolContract.ts');
  const packages = [...new Set([...contract.values()].flat().filter((s) => !s.startsWith('.')))];
  assert.deepEqual(packages, ['zod']);
  assert.deepEqual(
    [...contract.keys()].map((f) => path.relative(ROOT, f)).sort(),
    ['lib/models/schemaNormalize.ts', 'lib/tools/tool.ts', 'lib/tools/toolContract.ts'],
  );
});

test('the scan sees runtime imports and skips type-only ones (control)', () => {
  const adk = runtimeSpecifiers(path.resolve(ROOT, 'lib/tools/adkTool.ts'));
  assert.ok(adk.includes('@google/adk'), 'the boundary module loads ADK');
  assert.ok(!adk.includes('@google/genai'), 'its genai import is type-only');
  assert.ok(fs.readFileSync(path.resolve(ROOT, 'lib/tools/toolContract.ts'), 'utf8').includes("from '../models/contract.ts'"));
  assert.ok(!runtimeSpecifiers(path.resolve(ROOT, 'lib/tools/toolContract.ts')).includes('../models/contract.ts'));
});
