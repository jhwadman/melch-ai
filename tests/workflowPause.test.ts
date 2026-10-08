/**
 * tests/workflowPause.test.ts — a workflow `ask_user` node on the engine's
 * own runtime (lib/workflow/pause.ts, the scheduler's interrupt seam in
 * lib/workflow/scheduler.ts) against ADK's RequestInput.
 *
 * Each case holds one graph's walk with agent stubs to ADK's. ADK's side is
 * ADK 2.2's compile of the graph, every agent swapped for a stub
 * FunctionNode, run by ADK's Runner, as recorded in
 * tests/fixtures/adk-reference/workflowpause (tests/helpers/adkReference.ts).
 * The engine's side is the scheduler with
 * askUserNodeRunner for the ask_user node, a stub that writes FunctionNode's
 * event for each agent, and workflowPauseEvent once the walk ends paused.
 * The two are compared on every event as stored (event id, time and
 * invocation id aside, each interrupt id replaced by its order of first
 * appearance), every node's output, path and branch, the walk's interrupts,
 * and what the turn runner reads from the events when it drains them
 * (drainAgentStream: the log lines, onProgress and the input requests that
 * become `result.input`). No models, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { buildWorkflowGraph } from '../lib/workflow/graph.ts';
import { runWorkflowGraph } from '../lib/workflow/scheduler.ts';
import type { NodeRun, SchedulerEvent } from '../lib/workflow/scheduler.ts';
import { askUserNodeRunner, genaiSchemaToJsonSchema, runAskUserNode, workflowPauseEvent } from '../lib/workflow/pause.ts';
import { enrichNodeEvent } from '../lib/workflow/toolNode.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { drainAgentStream } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { PendingInput } from '../lib/workflowConfig.ts';
import { adkReferences } from './helpers/adkReference.ts';

// ADK's side of each case is recorded (tests/fixtures/adk-reference/workflowpause).
const reference = adkReferences('workflowPause');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MODEL = 'gemini-3.5-flash-lite';
const agent = (name: string) => ({ name, description: name, model: MODEL, instruction: `${name}.` });
const APP = { appName: 'app', userId: 'u', sessionId: 's' };
const MESSAGE = { role: 'user', parts: [{ text: 'go' }] };
/** The workflow's input as ADK's runNodeAsInvocation extracts it from MESSAGE. */
const WORKFLOW_INPUT = 'go';

function syndicate(edges: unknown[], confirm: Record<string, unknown> = { ask_user: 'Publish?' }, subagents = ['Publisher']): SyndicateYamlConfig {
  return validateSyndicateConfig(
    { syndicate_name: 'Graph', memory_system: 'internal-only', orchestrator: agent('Triage'), subagents: subagents.map(agent), workflow: { edges, nodes: { Confirm: confirm } } },
    'test',
  ) as SyndicateYamlConfig;
}
/** The graph of tests/workflow.test.ts's pause case. */
const chain = (confirm?: Record<string, unknown>) => syndicate([['START', 'Triage', 'Confirm', 'Publisher']], confirm);

type Stubs = Record<string, (input: unknown) => unknown>;
const STUBS: Stubs = { Triage: () => 'the draft', Publisher: (input) => `published ${JSON.stringify(input)}`, Reader: (input) => `read ${JSON.stringify(input)}` };

/** One side's record. */
interface Side {
  events: string[];
  completions: string[];
  interrupts: string[];
  logs: string[];
  progress: string[];
  inputs: PendingInput[];
}

/** Every event as stored, without its id, time and invocation id, and each interrupt id as `<interrupt N>`. */
function normalize(events: TurnEvent[], interruptIds: string[]): { events: string[]; interrupts: string[] } {
  const names = new Map<string, string>();
  const name = (id: string) => {
    if (!names.has(id)) names.set(id, `<interrupt ${names.size + 1}>`);
    return names.get(id)!;
  };
  const out = events.map((event) => {
    const { id: _id, timestamp: _t, invocationId: _i, ...rest } = JSON.parse(JSON.stringify(event));
    let json = JSON.stringify(rest);
    for (const id of event.longRunningToolIds ?? []) json = json.split(id).join(name(id));
    return json;
  });
  return { events: out, interrupts: interruptIds.map(name) };
}

async function drained(events: TurnEvent[]): Promise<Pick<Side, 'logs' | 'progress' | 'inputs'>> {
  const logs: string[] = [];
  const progress: string[] = [];
  async function* stream() {
    for (const e of events) yield e as any;
  }
  const d = await drainAgentStream(stream(), { events: { log: (l: string) => logs.push(l), onProgress: (p: string) => progress.push(p) }, publishToolStatus: true, errorPolicy: 'collect' });
  // An interrupt id is per run: compared by where it points, not its value.
  const inputs = d.inputRequests.map((input) => ({ ...input, id: events.some((e) => e.longRunningToolIds?.includes(input.id)) ? '<an interrupt of the run>' : input.id }));
  return { logs, progress, inputs };
}

function completionsOf(events: TurnEvent[]): string[] {
  return events.filter((e) => e.output !== undefined && e.nodeInfo?.path).map((e) => `${e.nodeInfo!.path} = ${JSON.stringify(e.output)} @${e.branch ?? '-'}`);
}

/** ADK's side of case `name`, as recorded. */
const adkSide = (name: string): Promise<Side> => reference<Side>(name);

/** A value in JSON's form, as a recording holds it (an `undefined`-valued key dropped). */
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** FunctionNode's event for an agent stub's output, as ADK writes it (createEvent's keys in its order: author, invocationId, branch, content, output). */
function stubEvent(run: NodeRun, name: string, output: unknown, invocationId: string): TurnEvent {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const event = createTurnEvent({ author: name, invocationId, branch: run.branch, content: { role: 'model', parts: [{ text }] }, output } as any);
  return enrichNodeEvent(event, run, { invocationId });
}

async function runNative(cfg: SyndicateYamlConfig, stubs: Stubs, onEvent?: (e: SchedulerEvent) => void): Promise<Side & { output: unknown }> {
  const events: TurnEvent[] = [];
  const invocationId = 'e-native';
  const run = await runWorkflowGraph(buildWorkflowGraph(cfg), {
    input: WORKFLOW_INPUT,
    runNode: askUserNodeRunner({ invocationId, onEvent: (e) => events.push(e) }, async (r) => {
      const name = r.target.kind === 'map_item' ? r.target.agent : r.target.name;
      const output = stubs[name](r.input);
      if (output !== undefined) events.push(stubEvent(r, name, output, invocationId));
      return { output };
    }),
    ...(onEvent ? { onEvent } : {}),
  });
  if (run.interruptIds.length > 0) events.push(workflowPauseEvent({ name: cfg.syndicate_name, invocationId, input: WORKFLOW_INPUT, interruptIds: run.interruptIds }));
  return { ...normalize(events, run.interruptIds), completions: completionsOf(events), ...(await drained(events)), output: run.output };
}

async function bothAgree(name: string, cfg: SyndicateYamlConfig, stubs: Stubs = STUBS): Promise<Side & { output: unknown }> {
  const adk = await adkSide(name);
  const native = await runNative(cfg, stubs);
  const { output, ...rest } = native;
  assert.deepEqual(asJson(rest), adk);
  return native;
}

// ── The case from tests/workflow.test.ts ─────────────────────────────────────

test('the pause case: the same stored events, interrupts, progress and input request as ADK', async () => {
  const side = await bothAgree('pause-case', chain());
  assert.equal(side.output, undefined, 'a paused walk has no output');
  assert.deepEqual(side.interrupts, ['<interrupt 1>']);
  assert.deepEqual(side.completions, ['Graph.Triage = "the draft" @-'], 'Publisher did not run');
  assert.deepEqual(side.inputs, [{ id: '<an interrupt of the run>', node: 'Confirm', message: 'Publish?', payload: 'the draft' }]);
  assert.deepEqual(side.logs, ['⇢ Node: Triage', '⇢ Node: Confirm', '⏸ Confirm asks: Publish?']);
  assert.deepEqual(JSON.parse(side.events[1]), {
    content: {
      role: 'model',
      parts: [{ functionCall: { name: 'adk_request_input', args: { interruptId: '<interrupt 1>', payload: 'the draft', message: 'Publish?', response_schema: null }, id: '<interrupt 1>' } }],
    },
    longRunningToolIds: ['<interrupt 1>'],
    author: 'Confirm',
    actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {}, agentState: { input: 'the draft' } },
    nodeInfo: { path: 'Graph.Confirm' },
  });
  assert.deepEqual(JSON.parse(side.events[2]), {
    author: 'Graph',
    longRunningToolIds: ['<interrupt 1>'],
    actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {}, agentState: { input: 'go' } },
    nodeInfo: { path: 'Graph' },
  });
});

test('the pause case through runSyndicateTurn as ADK recorded it: the walk\'s events carry the same result.input', async () => {
  const cfg = syndicate([['START', 'Triage', 'Confirm', 'Publisher']], { ask_user: 'Publish?' });
  const cfgScripted = { ...cfg, orchestrator: { ...cfg.orchestrator, model: 'scripted/triage' }, subagents: cfg.subagents!.map((s) => ({ ...s, model: 'scripted/publisher' })) } as SyndicateYamlConfig;
  // ADK's turn as recorded: its status, its input without the interrupt id (per run), and whether it named one.
  const adk = await reference<{ status: string; input: unknown; named: boolean }>('pause-through-runsyndicateturn');
  assert.equal(adk.status, 'input-required');
  const native = await runNative(cfgScripted, STUBS);
  const input = native.inputs[native.inputs.length - 1];
  assert.deepEqual(asJson({ ...input, id: undefined }), asJson(adk.input));
  assert.ok(adk.named, 'ADK names the interrupt');
  assert.equal(input.id, '<an interrupt of the run>', 'the input names an interrupt the walk stored');
});

// ── The request's arguments ──────────────────────────────────────────────────

for (const [label, schema] of [
  ['a genai schema', { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' }, why: { type: 'STRING', nullable: true, maxLength: '40' } }, required: ['ok'], propertyOrdering: ['ok', 'why'] }],
  ['a JSON Schema in lower case, whose types ADK drops', { type: 'object', properties: { ok: { type: 'boolean' } } }],
  ['an enum of numbers written as text', { type: 'INTEGER', enum: ['1', '2', ' ', 'x'], format: 'enum' }],
] as const) {
  test(`a node schema reaches response_schema as ADK writes it: ${label}`, async () => {
    const side = await bothAgree(`node-schema-${label}`, chain({ ask_user: 'Publish?', schema }));
    const args = JSON.parse(side.events[1]).content.parts[0].functionCall.args;
    assert.deepEqual(side.inputs[0].schema, args.response_schema);
  });
}

test('genaiSchemaToJsonSchema is ADK\'s, case for case', async () => {
  const cases: Record<string, unknown>[] = [
    {},
    { type: 'STRING', description: 'd', example: 'e', format: 'date-time' },
    { type: 'ARRAY', items: { type: 'NUMBER', enum: ['1.5', 'a'] }, minItems: '1', maxItems: '3' },
    { type: 'OBJECT', nullable: true, properties: { a: { anyOf: [{ type: 'STRING' }, { type: 'NULL' }] } }, minProperties: '1' },
    { type: 'object', properties: { x: { type: 'string', minLength: 2 } } },
  ];
  // ADK's genaiSchemaToJsonSchema over the cases, recorded.
  const theirs = await reference<unknown[]>('genai-schema-to-json-schema');
  for (const [i, schema] of cases.entries()) assert.deepEqual(asJson(genaiSchemaToJsonSchema(schema)), theirs[i], JSON.stringify(schema));
});

test('no input: payload null, and the node input recorded as nothing', async () => {
  await bothAgree('no-input', chain(), { ...STUBS, Triage: () => undefined });
});

test('an object input is the payload as it is', async () => {
  const side = await bothAgree('object-input', chain(), { ...STUBS, Triage: () => ({ title: 'T', options: ['yes', 'no'] }) });
  assert.deepEqual(side.inputs[0].payload, { title: 'T', options: ['yes', 'no'] });
  assert.deepEqual(side.logs.at(-1), '⏸ Confirm asks: Publish? (yes / no)');
});

// ── The walk around a pause ──────────────────────────────────────────────────

test('a pause on one branch: the other branch runs on, the walk ends paused, as on ADK', async () => {
  const cfg = syndicate([['START', 'Triage', ['Confirm', 'Reader']], ['Confirm', 'Publisher']], { ask_user: 'Publish?' }, ['Publisher', 'Reader']);
  const side = await bothAgree('pause-on-one-branch', cfg);
  assert.equal(side.output, undefined);
  assert.deepEqual(side.completions, ['Graph.Triage = "the draft" @-', 'Graph.Reader = "read \\"the draft\\"" @Reader@1']);
  assert.equal(JSON.parse(side.events[1]).branch, 'Confirm@1');
});

test('a waiting node triggered again does not run again in the walk, as on ADK', async () => {
  const cfg = syndicate([['START', 'Triage', ['Writer', 'Checker']], ['Writer', 'Confirm', 'Publisher'], ['Checker', 'Confirm']], { ask_user: 'Publish?' }, ['Writer', 'Checker', 'Publisher']);
  const stubs: Stubs = { ...STUBS, Writer: () => 'draft', Checker: () => 'claims' };
  const native = await runNative(cfg, stubs);
  assert.deepEqual(native.interrupts, ['<interrupt 1>'], 'one request: the second trigger waits behind the first');
  const adk = await adkSide('waiting-node-triggered-again');
  const { output: _o, ...rest } = native;
  assert.deepEqual(asJson(rest), adk);
});

test('the scheduler: a waiting node reports node_waiting, not node_end, and its error does not fail it', async () => {
  const graph = buildWorkflowGraph(chain());
  const seen: string[] = [];
  const run = await runWorkflowGraph(graph, {
    input: 'go',
    runNode: (r) => (r.target.kind === 'ask_user' ? { interruptIds: ['i-1'], error: { code: 'ASKED', message: 'reported with the pause' } } : { output: 'x' }),
    onEvent: (e) => seen.push(e.type === 'node_waiting' ? `waiting ${e.node} ${e.interruptIds.join(',')}` : `${e.type} ${'node' in e ? e.node : ''}`),
  });
  assert.deepEqual(run.interruptIds, ['i-1']);
  assert.equal(run.output, undefined);
  assert.deepEqual(run.order, ['Triage']);
  assert.deepEqual(run.nodeErrors, [{ node: 'Confirm', code: 'ASKED', message: 'reported with the pause' }]);
  assert.deepEqual(seen, ['node_start Triage', 'node_end Triage', 'node_start Confirm', 'node_error Confirm', 'waiting Confirm i-1']);
});

test('the scheduler: a walk with no pause reports no interrupts', async () => {
  const run = await runWorkflowGraph(buildWorkflowGraph(chain()), { input: 'go', runNode: () => ({ output: 'x' }) });
  assert.deepEqual(run.interruptIds, []);
  assert.equal(run.output, 'x');
});

// ── The runner ───────────────────────────────────────────────────────────────

test('runAskUserNode takes its interrupt id from the context, and hands the event over before it returns', () => {
  const graph = buildWorkflowGraph(chain());
  const node = graph.nodes.get('Confirm') as any;
  const events: TurnEvent[] = [];
  const result = runAskUserNode(node, { input: 'd', path: 'Graph.Confirm', branch: 'B@1' }, { invocationId: 'inv', newInterruptId: () => 'fixed', onEvent: (e) => events.push(e) });
  assert.deepEqual(result, { interruptIds: ['fixed'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].invocationId, 'inv');
  assert.equal(events[0].branch, 'B@1');
  assert.deepEqual(events[0].longRunningToolIds, ['fixed']);
});

test('askUserNodeRunner hands every other run on, or refuses it by name', async () => {
  const graph = buildWorkflowGraph(chain());
  const triage = graph.nodes.get('Triage') as any;
  const run: NodeRun = { target: triage, input: 'x', runId: '1', path: 'Graph.Triage', branch: undefined, signal: new AbortController().signal, attempt: 1 };
  assert.deepEqual(await askUserNodeRunner({ invocationId: 'i' }, () => ({ output: 'next' }))(run), { output: 'next' });
  assert.throws(() => askUserNodeRunner({ invocationId: 'i' })(run), /ask_user nodes only; Triage is a agent run/);
});

// ── No ADK ───────────────────────────────────────────────────────────────────

test('lib/workflow/pause.ts reaches no @google/ package through a value import', () => {
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
  visit(path.join(ROOT, 'lib/workflow/pause.ts'));
  assert.deepEqual(offenders, []);
});
