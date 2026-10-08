/**
 * tests/workflowToolNode.test.ts — a workflow `tool:` node on the engine's
 * own runtime (lib/workflow/toolNode.ts) against ADK's ToolNode.
 *
 * Each case holds one graph's walk with a registry tool and agent stubs to
 * ADK's. ADK's side is ADK 2.2's compile of the graph, every agent swapped
 * for a stub FunctionNode, run by ADK's Runner, as recorded in
 * tests/fixtures/adk-reference/workflowtoolnode (tests/helpers/adkReference.ts).
 * The engine's side is the scheduler (lib/workflow/scheduler.ts) with toolNodeRunner for the tool
 * node and a stub that writes FunctionNode's event for each agent. The two
 * are compared on every event as stored (id, time and invocation id aside),
 * every node's output, path and branch, the workflow's output, and the
 * progress the turn runner prints when it drains the events
 * (drainAgentStream: the `⇢ Node:` log lines and onProgress). No models, no
 * network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool, resolveTools } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { requireApproval } from '../lib/tools/tool.ts';
import { buildWorkflowGraph } from '../lib/workflow/graph.ts';
import { nodeErrorEvent, runWorkflowGraph } from '../lib/workflow/scheduler.ts';
import type { NodeRun } from '../lib/workflow/scheduler.ts';
import { coerceToolArgs, enrichNodeEvent, runToolNode, toolNodeRunner } from '../lib/workflow/toolNode.ts';
import type { ToolNodeContext } from '../lib/workflow/toolNode.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { drainAgentStream } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { adkReferences } from './helpers/adkReference.ts';

// ADK's side of each case is recorded (tests/fixtures/adk-reference/workflowtoolnode).
const reference = adkReferences('workflowToolNode');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The tool of tests/workflow.test.ts's tool-node case, with a zod schema: an own Tool, so that no side needs ADK to hold it.
registerTool(
  'tool_node_lookup',
  defineTool({
    name: 'tool_node_lookup',
    description: 'Look something up.',
    schema: z.object({ q: z.string() }),
    execute: async ({ q }) => {
      if (q === 'boom') throw new Error('kaput');
      return `found ${q}`;
    },
  }),
  { override: true },
);

// An own Tool (defineTool), which reads state and the call, writes state, and returns what it is asked to.
const seen: Array<Record<string, unknown>> = [];
const ownTool = defineTool({
  name: 'tool_node_own',
  description: 'Echo, with state.',
  schema: z.object({ q: z.string() }),
  execute: async ({ q }, ctx) => {
    seen.push({ id: ctx.functionCallId, user: ctx.userId, app: ctx.appName, session: ctx.sessionId, k: ctx.state.get('k'), agent: ctx.agentName, signal: !!ctx.signal, userContent: ctx.userContent });
    ctx.state.set('seen', q);
    if (q === 'list') return [1, 2] as unknown as string;
    if (q === 'number') return 7 as unknown as string;
    if (q === 'nothing') return undefined as unknown as string;
    if (q === 'throw') throw new Error('own failure');
    return { found: q } as unknown as string;
  },
});
registerTool('tool_node_own', ownTool, { override: true });
registerTool('tool_node_gated', requireApproval(defineTool({ name: 'tool_node_gated', description: 'Gated.', schema: z.object({}), execute: async () => 'ran' })), { override: true });
registerTool('tool_node_waits', defineTool({ name: 'tool_node_waits', description: 'Long.', schema: z.object({}), longRunning: true, execute: async () => 'later' }), { override: true });

const MODEL = 'gemini-3.5-flash-lite';
const agent = (name: string) => ({ name, description: name, model: MODEL, instruction: `${name}.` });
const APP = { appName: 'app', userId: 'u', sessionId: 's' };
const STATE = { k: 'v' };
const MESSAGE = { role: 'user', parts: [{ text: 'go' }] };

function syndicate(tool: string, edges: unknown[]): SyndicateYamlConfig {
  return validateSyndicateConfig(
    { syndicate_name: 'Graph', memory_system: 'internal-only', orchestrator: agent('Triage'), subagents: [agent('Reader')], workflow: { edges, nodes: { Lookup: { tool } } } },
    'test',
  ) as SyndicateYamlConfig;
}
/** The graph of tests/workflow.test.ts's tool-node case. */
const chain = (tool: string) => syndicate(tool, [['START', 'Triage', 'Lookup', 'Reader']]);
/** The tool node on a branch of its own. */
const fanned = (tool: string) => syndicate(tool, [['START', 'Triage', ['Lookup', 'Reader']]]);

type Stubs = Record<string, (input: unknown) => unknown>;
const readerEcho = (input: unknown) => `read ${JSON.stringify(input)}`;

/** One side's record. */
interface Side {
  events: string[];
  completions: string[];
  output: unknown;
  logs: string[];
  progress: string[];
}

/** An event as stored, without what differs per run: its id, time and invocation id. */
const stored = (event: unknown) => {
  const { id: _id, timestamp: _t, invocationId: _i, ...rest } = JSON.parse(JSON.stringify(event));
  return JSON.stringify(rest);
};

async function drained(events: TurnEvent[]): Promise<Pick<Side, 'logs' | 'progress'>> {
  const logs: string[] = [];
  const progress: string[] = [];
  async function* stream() {
    for (const e of events) yield e as any;
  }
  await drainAgentStream(stream(), { events: { log: (l: string) => logs.push(l), onProgress: (p: string) => progress.push(p) }, publishToolStatus: true, errorPolicy: 'collect' });
  return { logs, progress };
}

/** FunctionNode's event for an agent stub's output, as ADK writes it. */
function stubEvent(run: NodeRun, name: string, output: unknown, invocationId: string): TurnEvent {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const event = createTurnEvent({ author: name, invocationId, content: { role: 'model', parts: [{ text }] }, output } as any);
  return enrichNodeEvent(event, run, { invocationId });
}

/** ADK's side of case `name`, as recorded: its Side, or the message it failed with. */
const adkRun = (name: string): Promise<{ side?: Side; error?: string }> => reference(name);

/** ADK's side as a Side; a failed run fails the case. */
async function adkSide(name: string): Promise<Side> {
  const { side, error } = await adkRun(name);
  assert.equal(error, undefined, 'ADK completes the walk');
  return side!;
}

async function runNative(cfg: SyndicateYamlConfig, stubs: Stubs): Promise<Side> {
  const events: TurnEvent[] = [];
  const invocationId = 'e-native';
  const context: ToolNodeContext = {
    ...APP,
    invocationId,
    userContent: MESSAGE,
    state: () => STATE,
    resolveTool: (name) => resolveTools([name])[0],
    onEvent: (e) => events.push(e),
  };
  const completions: string[] = [];
  const run = await runWorkflowGraph(buildWorkflowGraph(cfg), {
    input: MESSAGE,
    runNode: toolNodeRunner(context, async (r) => {
      const name = r.target.kind === 'map_item' ? r.target.agent : r.target.name;
      const output = stubs[name](r.input);
      // FunctionNode writes no event for an undefined output.
      if (output !== undefined) events.push(stubEvent(r, name, output, invocationId));
      return { output };
    }),
    onEvent: (e) => {
      if (e.type === 'node_end' && e.output !== undefined) completions.push(`${e.path} = ${JSON.stringify(e.output)} @${e.branch ?? '-'}`);
    },
  });
  return { events: events.map(stored), completions, output: run.output, ...(await drained(events)) };
}

/** A native Side in JSON's form, as a recording holds ADK's (an `undefined`-valued key dropped). */
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function bothAgree(name: string, cfg: SyndicateYamlConfig, stubs: Stubs): Promise<Side> {
  const adk = await adkSide(name);
  const native = await runNative(cfg, stubs);
  assert.deepEqual(asJson(native), adk);
  return native;
}

// ── The case from tests/workflow.test.ts ─────────────────────────────────────

test('the tool-node case: the same events, output and progress lines as ADK', async () => {
  const side = await bothAgree('tool-node-case', chain('tool_node_lookup'), { Triage: () => '{"q":"needle"}', Reader: readerEcho });
  assert.equal(side.output, 'read {"result":"found needle"}');
  assert.deepEqual(side.progress, ['Running node: Triage', 'Running node: Lookup', 'Running node: Reader']);
  assert.deepEqual(side.logs, ['⇢ Node: Triage', '⇢ Node: Lookup', '← Result: tool_node_lookup — 25 chars', '⇢ Node: Reader']);
  const lookup = JSON.parse(side.events[1]);
  assert.deepEqual(lookup, {
    author: 'Lookup',
    content: { role: 'user', parts: [{ functionResponse: { id: 'Graph.Lookup:1', name: 'tool_node_lookup', response: { result: 'found needle' } } }] },
    actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {} },
    longRunningToolIds: [],
    output: { result: 'found needle' },
    nodeInfo: { path: 'Graph.Lookup', outputFor: ['Graph.Lookup'] },
  });
});

// ── Input mapping ────────────────────────────────────────────────────────────

for (const [label, triage] of [
  ['an object', { q: 'obj' }],
  ['JSON text with spaces around it', '  {"q":"padded"}\n'],
  ['a blank string, as no arguments', '  '],
  ['no output, as no arguments', undefined],
  ['arguments the schema refuses', { q: 5 }],
] as const) {
  test(`input mapping as ADK's: ${label}`, async () => {
    await bothAgree(`input-mapping-${label}`, chain('tool_node_lookup'), { Triage: () => triage, Reader: readerEcho });
  });
}

for (const [label, triage] of [
  ['text that is not JSON', 'not json'],
  ['a list', [1]],
  ['a number', 3],
] as const) {
  test(`input mapping as ADK's: ${label} fails the node with ADK's message`, async () => {
    const cfg = chain('tool_node_lookup');
    const stubs: Stubs = { Triage: () => triage, Reader: readerEcho };
    const { error: adkError = assert.fail('ADK accepted the input') } = await adkRun(`input-refused-${label}`);
    assert.match(adkError, /^The input to ToolNode must be an object of tool arguments or null, but got /);
    await assert.rejects(runNative(cfg, stubs), (e: Error) => e instanceof TypeError && e.message === adkError);
  });
}

test('a tool node that fails gets the node-error event ADK writes (nodeErrorEvent)', async () => {
  const cfg = chain('tool_node_lookup');
  const stubs: Stubs = { Triage: () => 'not json', Reader: readerEcho };

  const adk = await reference<string[]>('node-error-event');

  const native: string[] = [];
  const context: ToolNodeContext = { ...APP, invocationId: 'e-native', userContent: MESSAGE, state: () => STATE, resolveTool: (name) => resolveTools([name])[0] };
  await assert.rejects(
    runWorkflowGraph(buildWorkflowGraph(cfg), {
      input: MESSAGE,
      runNode: toolNodeRunner(context, async (r) => ({ output: stubs[(r.target as { name: string }).name](r.input) })),
      onEvent: (e) => {
        if (e.type === 'node_error' && e.source === 'workflow') native.push(stored(nodeErrorEvent(e, 'e-native')));
      },
    }),
    TypeError,
  );
  assert.equal(adk.length, 1);
  assert.deepEqual(native, adk);
  assert.equal(JSON.parse(adk[0]).author, 'Lookup');
});

test('coerceToolArgs: a content\'s text, parsed', () => {
  assert.deepEqual(coerceToolArgs({ role: 'user', parts: [{ text: '{"q":' }, { text: '"c"}' }] }), { q: 'c' });
  assert.deepEqual(coerceToolArgs({ parts: [] }), {});
  assert.deepEqual(coerceToolArgs(undefined), {});
  assert.throws(() => coerceToolArgs('"just a string"'), /but got string/);
});

// ── Results, errors, state, branches ─────────────────────────────────────────

test('a tool that throws answers { error }, and the walk goes on, as on ADK', async () => {
  const side = await bothAgree('tool-throws', chain('tool_node_lookup'), { Triage: () => ({ q: 'boom' }), Reader: readerEcho });
  assert.equal(side.output, `read ${JSON.stringify({ error: "Error in tool 'tool_node_lookup': kaput" })}`);
});

for (const q of ['x', 'list', 'number', 'nothing', 'throw']) {
  test(`an own Tool on a branch of its own: "${q}" answers, writes state and reads the call as on ADK`, async () => {
    seen.length = 0;
    // Reader is a second terminal here, so it outputs nothing (ADK allows one terminal output).
    const stubs: Stubs = { Triage: () => ({ q }), Reader: () => undefined };
    // ADK's side with the call its tool saw (in JSON's form, as recorded).
    const adk = await reference<{ side: Side; seen: unknown }>(`own-tool-${q}`);
    const native = await runNative(fanned('tool_node_own'), stubs);
    assert.deepEqual(asJson(native), adk.side);
    assert.equal(seen.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(seen[0])), adk.seen, 'the tool sees the call ADK\'s did');
    assert.equal(seen[0].id, 'Graph.Lookup:1');
    const lookup = JSON.parse(native.events.find((e) => e.includes('"author":"Lookup"'))!);
    assert.equal(lookup.branch, 'Lookup@1');
    if (q !== 'throw') assert.deepEqual(lookup.actions.stateDelta, { seen: q });
  });
}

test('a gated tool asks for approval on its event and answers pending, as on ADK', async () => {
  const side = await bothAgree('gated-tool', chain('tool_node_gated'), { Triage: () => ({}), Reader: readerEcho });
  const lookup = JSON.parse(side.events[1]);
  assert.equal(lookup.actions.skipSummarization, true);
  assert.deepEqual(Object.keys(lookup.actions.requestedToolConfirmations), ['Graph.Lookup:1']);
});

// ── Refusals ─────────────────────────────────────────────────────────────────

test('a long-running tool is refused with ADK\'s message', async () => {
  const cfg = chain('tool_node_waits');
  const adkError = await reference<string>('long-running-refused');
  await assert.rejects(runNative(cfg, { Triage: () => ({}), Reader: readerEcho }), (e: Error) => e.message === adkError);
});

test('an unregistered tool is refused with the compile\'s message', async () => {
  const graph = buildWorkflowGraph(chain('tool_node_lookup'));
  const node = graph.nodes.get('Lookup');
  assert.equal(node?.kind, 'tool');
  const run: NodeRun = { target: node as any, input: {}, runId: '1', path: 'Graph.Lookup', branch: undefined, signal: new AbortController().signal, attempt: 1 };
  await assert.rejects(runToolNode(node as any, run, { invocationId: 'i', resolveTool: () => undefined }), /^Error: workflow node 'Lookup': tool 'tool_node_lookup' is not registered$/);
});

test('an ADK tool (anything with runAsync) is refused, naming 1.0.0 and defineTool, and never run', async () => {
  const graph = buildWorkflowGraph(chain('tool_node_lookup'));
  const node = graph.nodes.get('Lookup');
  const run: NodeRun = { target: node as any, input: {}, runId: '1', path: 'Graph.Lookup', branch: undefined, signal: new AbortController().signal, attempt: 1 };
  let ran = false;
  const adkTool = { name: 'tool_node_lookup', description: 'An ADK FunctionTool, by shape.', runAsync: async () => { ran = true; return 'ran'; } };
  await assert.rejects(
    runToolNode(node as any, run, { invocationId: 'i', resolveTool: () => adkTool }),
    (e: Error) => /workflow node 'Lookup': tool 'tool_node_lookup' is an ADK tool/.test(e.message) && /1\.0\.0/.test(e.message) && /defineTool/.test(e.message),
  );
  assert.equal(ran, false);
});

test('toolNodeRunner hands every other run on, or refuses it by name', async () => {
  const graph = buildWorkflowGraph(chain('tool_node_lookup'));
  const triage = graph.nodes.get('Triage') as any;
  const run: NodeRun = { target: triage, input: 'x', runId: '1', path: 'Graph.Triage', branch: undefined, signal: new AbortController().signal, attempt: 1 };
  const context: ToolNodeContext = { invocationId: 'i', resolveTool: () => undefined };
  assert.deepEqual(await toolNodeRunner(context, () => ({ output: 'next' }))(run), { output: 'next' });
  assert.throws(() => toolNodeRunner(context)(run), /tool nodes only; Triage is a agent run/);
});

// ── No ADK ───────────────────────────────────────────────────────────────────

test('lib/workflow/toolNode.ts reaches no @google/ package through a value import', () => {
  const visited = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const [statement] of src.matchAll(/^import\s[^;]*;/gm)) {
      if (/^import\s+type\s/.test(statement)) continue;
      const spec = /from\s+'([^']*)'/.exec(statement)?.[1] ?? '';
      if (spec.startsWith('@google/')) offenders.push(`${path.relative(ROOT, file)}: ${spec}`);
      if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), spec));
    }
  };
  visit(path.join(ROOT, 'lib/workflow/toolNode.ts'));
  assert.deepEqual(offenders, []);
});
