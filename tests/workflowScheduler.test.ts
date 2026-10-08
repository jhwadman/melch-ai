/**
 * tests/workflowScheduler.test.ts — the engine's own workflow scheduler
 * (lib/workflow/scheduler.ts) against ADK's Workflow on the same graph.
 *
 * Each case builds one syndicate's graph twice: `buildWorkflowGraph` for the
 * scheduler, and today's `compileWorkflow` (lib/workflow.ts) for ADK, with
 * every agent swapped for a stub FunctionNode of the same name. The stubs
 * are the same on both sides (an output from the input, an optional delay),
 * so the two walks are compared on what a scheduler decides: which node
 * runs when, on which input, on which branch, and what the workflow
 * outputs. The orders ADK records are also pinned as literals, so an ADK
 * upgrade that changes them fails here by name. No models run, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FunctionNode, InMemorySessionService, LogLevel, Runner, setLogLevel } from '@google/adk';
import type { LlmAgent } from '@google/adk';

import { compileWorkflow } from '../lib/workflow.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { buildWorkflowGraph } from '../lib/workflow/graph.ts';
import { DEFAULT_MAX_PARALLEL, nextNodes, runWorkflowGraph, streamWorkflowGraph } from '../lib/workflow/scheduler.ts';
import type { NodeRun, SchedulerEvent } from '../lib/workflow/scheduler.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';

setLogLevel(LogLevel.ERROR);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'gemini-3.5-flash-lite';
const agent = (name: string) => ({ name, description: name, model: MODEL, instruction: `${name}.` });

function syndicate(name: string, agents: string[], workflow: Record<string, unknown>): SyndicateYamlConfig {
  const [orchestrator, ...subs] = agents;
  return validateSyndicateConfig(
    { syndicate_name: name, memory_system: 'internal-only', orchestrator: agent(orchestrator), subagents: subs.map(agent), workflow },
    'test',
  ) as SyndicateYamlConfig;
}

/** What an agent does in a case: its output from its input, and how long it takes (ms; absent = no timer). */
interface Stub {
  output?: (input: unknown, call: number) => unknown;
  delay?: number | ((input: unknown, call: number) => number);
}
type Stubs = Record<string, Stub>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One side's record: every agent call with its input, and every node completion with its output and branch. */
interface Record_ {
  calls: string[];
  completions: string[];
  output: unknown;
}

/** The stub table as one function both sides call; `calls` records `name <- input`. */
function stubRunner(stubs: Stubs, calls: string[]) {
  const counts = new Map<string, number>();
  return async (name: string, input: unknown): Promise<unknown> => {
    const call = (counts.get(name) ?? 0) + 1;
    counts.set(name, call);
    calls.push(`${name} <- ${JSON.stringify(input)}`);
    const stub = stubs[name] ?? {};
    const delay = typeof stub.delay === 'function' ? stub.delay(input, call) : stub.delay;
    if (delay !== undefined) await sleep(delay);
    return stub.output ? stub.output(input, call) : `${name}(${typeof input === 'string' ? input : JSON.stringify(input)})`;
  };
}

const completion = (path: string, output: unknown, branch: string | undefined) => `${path} = ${JSON.stringify(output)} @${branch ?? '-'}`;

/** ADK's walk: the real compile, every agent a stub FunctionNode, run by ADK's Runner. */
async function runOnAdk(cfg: SyndicateYamlConfig, stubs: Stubs, input: string): Promise<Record_> {
  const calls: string[] = [];
  const run = stubRunner(stubs, calls);
  const toStub = (a: LlmAgent) => new FunctionNode(a.name, (_ctx: unknown, nodeInput: unknown) => run(a.name, nodeInput)) as unknown as LlmAgent;
  const { workflow } = await compileWorkflow(cfg, {}, toStub);
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({ appName: 'sched', userId: 'u', sessionId: 's' });
  const runner = new Runner({ agent: workflow as any, appName: 'sched', sessionService });
  const completions: string[] = [];
  // The Runner yields no event for the workflow's own output; it is the one terminal node's, as ADK's finalize takes it.
  const terminals = new Set(buildWorkflowGraph(cfg).terminals.map((n) => `${cfg.syndicate_name}.${n}`));
  let output: unknown;
  for await (const ev of runner.runAsync({ userId: 'u', sessionId: 's', newMessage: { role: 'user', parts: [{ text: input }] } })) {
    const p = (ev as any).nodeInfo?.path as string | undefined;
    if ((ev as any).output === undefined || !p) continue;
    if (terminals.has(p)) output = (ev as any).output;
    completions.push(completion(p, (ev as any).output, ev.branch));
  }
  return { calls, completions, output };
}

/** The scheduler's walk on the engine's own graph, with the same stubs. */
async function runNative(cfg: SyndicateYamlConfig, stubs: Stubs, input: string, events?: SchedulerEvent[]): Promise<Record_> {
  const calls: string[] = [];
  const run = stubRunner(stubs, calls);
  const completions: string[] = [];
  const result = await runWorkflowGraph(buildWorkflowGraph(cfg), {
    input,
    runNode: async (r: NodeRun) => ({ output: await run(r.target.kind === 'map_item' ? r.target.agent : r.target.name, r.input) }),
    onEvent: (e) => {
      events?.push(e);
      // ADK writes no event for a node whose output is undefined; the record leaves it out on both sides.
      if ((e.type === 'node_end' || e.type === 'item_end') && e.output !== undefined) completions.push(completion(e.path, e.output, e.branch));
    },
  });
  // ADK writes a map item's event before the map's own; so does the scheduler. The orders compare as they stand.
  return { calls, completions, output: result.output };
}

async function bothAgree(cfg: SyndicateYamlConfig, stubs: Stubs, input = 'go'): Promise<Record_> {
  const adk = await runOnAdk(cfg, stubs, input);
  const native = await runNative(cfg, stubs, input);
  assert.deepEqual(native, adk);
  return adk;
}

// ── The six-node fixture: fan-out and join ───────────────────────────────────

/**
 *   START → Planner → [Writer, Checker]      (fan-out)
 *   Writer → Editor
 *   [Editor, Checker] → Both (join) → Publisher
 */
const SIX = syndicate('Six', ['Planner', 'Writer', 'Checker', 'Editor', 'Publisher'], {
  edges: [
    ['START', 'Planner', ['Writer', 'Checker']],
    ['Writer', 'Editor'],
    [['Editor', 'Checker'], 'Both', 'Publisher'],
  ],
  nodes: { Both: { join: true } },
});

const SIX_JOINED = (c: string) => ({ Editor: 'Editor(Writer(Planner(go)))', Checker: c });
const SIX_OUTPUT = `Publisher(${JSON.stringify(SIX_JOINED('Checker(Planner(go))'))})`;

/** The orders ADK 2.2 records for the six-node fixture, by timing profile. */
const SIX_ORDERS: Array<[string, Stubs, string[]]> = [
  ['every node immediate', {}, ['Planner', 'Writer', 'Checker', 'Editor', 'Both', 'Publisher']],
  ['the checker slower than writer and editor', { Checker: { delay: 40 }, Writer: { delay: 5 }, Editor: { delay: 5 } }, ['Planner', 'Writer', 'Editor', 'Checker', 'Both', 'Publisher']],
  ['the writer slowest', { Writer: { delay: 40 }, Checker: { delay: 5 } }, ['Planner', 'Checker', 'Writer', 'Editor', 'Both', 'Publisher']],
  ['writer and checker on the same timer', { Writer: { delay: 10 }, Checker: { delay: 10 } }, ['Planner', 'Writer', 'Editor', 'Checker', 'Both', 'Publisher']],
];

for (const [profile, stubs, expected] of SIX_ORDERS) {
  test(`six-node fan-out and join completes in ADK's recorded order: ${profile}`, async () => {
    const adk = await runOnAdk(SIX, stubs, 'go');
    const pinned = adk.completions.map((c) => c.slice('Six.'.length, c.indexOf(' ')));
    assert.deepEqual(pinned, expected, 'ADK records the pinned order');

    const events: SchedulerEvent[] = [];
    const native = await runNative(SIX, stubs, 'go', events);
    assert.deepEqual(native, adk);
    assert.deepEqual(events.filter((e) => e.type === 'node_end').map((e) => e.node), expected);
    assert.equal(native.output, SIX_OUTPUT);
  });
}

test('six-node fixture: branches, run ids and paths are ADK\'s', async () => {
  const events: SchedulerEvent[] = [];
  await runNative(SIX, {}, 'go', events);
  const starts = events.filter((e) => e.type === 'node_start').map((e) => e.type === 'node_start' && `${e.path}#${e.runId}@${e.branch ?? '-'}`);
  assert.deepEqual(starts, [
    'Six.Planner#1@-',
    'Six.Writer#1@Writer@1',
    'Six.Checker#1@Checker@1',
    'Six.Editor#1@Writer@1',
    'Six.Both#1@-',
    'Six.Publisher#1@-',
  ]);
});

// ── A node with several predecessors ─────────────────────────────────────────

const FANIN = syndicate('FanIn', ['Lead', 'A', 'B', 'C', 'After', 'Echo'], {
  edges: [
    ['START', 'Lead', ['A', 'B', 'C']],
    [['A', 'B', 'C'], 'All', 'After'],
    [['A', 'B'], 'Echo'],
  ],
  nodes: { All: { join: true } },
});

test('a join waits for every predecessor, however late, and keys their outputs in edge order', async () => {
  const stubs: Stubs = { A: { delay: 30 }, B: { delay: 5 }, C: { delay: 15 }, Echo: { output: () => undefined } };
  const events: SchedulerEvent[] = [];
  const adk = await runOnAdk(FANIN, stubs, 'go');
  const native = await runNative(FANIN, stubs, 'go', events);
  assert.deepEqual(native, adk);
  const ends = events.filter((e) => e.type === 'node_end').map((e) => e.node);
  // All starts only after A, the last of its three predecessors.
  const allStart = events.findIndex((e) => e.type === 'node_start' && e.node === 'All');
  const aEnd = events.findIndex((e) => e.type === 'node_end' && e.node === 'A');
  assert.ok(allStart > aEnd, 'the join starts after its last predecessor completes');
  assert.equal(ends.filter((n) => n === 'All').length, 1);
  const allInput = events.find((e) => e.type === 'node_start' && e.node === 'All');
  assert.deepEqual(Object.keys((allInput as any).input), ['A', 'B', 'C']);
  // A plain node with two predecessors runs once per predecessor, as on ADK: only a join waits.
  assert.deepEqual(native.calls.filter((c) => c.startsWith('Echo')), ['Echo <- "B(Lead(go))"', 'Echo <- "A(Lead(go))"']);
});

// ── Map under max_parallel ───────────────────────────────────────────────────

const mapSyndicate = (maxParallel?: number) =>
  syndicate('Mapped', ['Splitter', 'Worker', 'Summary'], {
    edges: [['START', 'Splitter', 'Fan', 'Summary']],
    nodes: { Fan: { map: 'Worker', ...(maxParallel !== undefined ? { max_parallel: maxParallel } : {}) } },
  });

const ITEMS = ['a', 'b', 'c', 'd', 'e'];
const itemDelays: Record<string, number> = { a: 30, b: 5, c: 20, d: 5, e: 10 };
const MAP_STUBS: Stubs = {
  Splitter: { output: () => ITEMS },
  Worker: { output: (item) => `w:${item}`, delay: (item) => itemDelays[item as string] },
  Summary: { output: (list) => (list as string[]).join(',') },
};

for (const maxParallel of [1, 2, undefined]) {
  test(`map runs one worker per item under max_parallel ${maxParallel ?? `(default ${DEFAULT_MAX_PARALLEL})`}, outputs by index`, async () => {
    const cfg = mapSyndicate(maxParallel);
    const events: SchedulerEvent[] = [];
    const adk = await runOnAdk(cfg, MAP_STUBS, 'go');
    const native = await runNative(cfg, MAP_STUBS, 'go', events);
    assert.deepEqual(native, adk);
    assert.equal(native.output, 'w:a,w:b,w:c,w:d,w:e');

    let running = 0;
    let peak = 0;
    for (const e of events) {
      if (e.type === 'item_start') peak = Math.max(peak, ++running);
      if (e.type === 'item_end') running--;
    }
    assert.equal(peak, Math.min(maxParallel ?? DEFAULT_MAX_PARALLEL, ITEMS.length));
    const items = events.filter((e) => e.type === 'item_start').map((e) => e.type === 'item_start' && `${e.path}@${e.branch}`);
    assert.deepEqual(items, ITEMS.map((_, i) => `Mapped.Fan.Worker@${i}@Worker@${i}`));
  });
}

test('map: a non-list input is one item, an empty list outputs []', async () => {
  for (const [split, expected] of [[() => 'solo', ['w:solo']], [() => [], []]] as const) {
    const stubs: Stubs = { ...MAP_STUBS, Splitter: { output: split }, Worker: { output: (item) => `w:${item}` }, Summary: { output: (list) => list } };
    const result = await bothAgree(mapSyndicate(2), stubs);
    assert.deepEqual(result.output, expected);
  }
});

// ── Outputs flowing, routing, max_concurrency ────────────────────────────────

test('outputs flow as inputs: START gets the workflow input, each node its predecessor\'s output', async () => {
  const cfg = syndicate('Chain', ['One', 'Two', 'Three'], { edges: [['START', 'One', 'Two', 'Three']] });
  const stubs: Stubs = { One: { output: (i) => ({ n: (i as string).length }) }, Two: { output: (i) => [(i as any).n, 'x'] }, Three: { output: (i) => (i as unknown[]).length } };
  const result = await bothAgree(cfg, stubs, 'hello');
  assert.deepEqual(result.calls, ['One <- "hello"', 'Two <- {"n":5}', 'Three <- [5,"x"]']);
  assert.equal(result.output, 2);
});

const ROUTED = syndicate('Routed', ['Triage', 'Bug', 'Feature', 'Other', 'Num'], {
  edges: [['START', 'Triage', { bug: 'Bug', feature: ['Feature', 'Num'], '01': 'Num', default: 'Other' }]],
});

for (const [route, expected] of [
  ['bug', ['Triage', 'Triage__route', 'Bug']],
  ['feature', ['Triage', 'Triage__route', 'Feature', 'Num']],
  ['nothing', ['Triage', 'Triage__route', 'Other']],
  ['1', ['Triage', 'Triage__route', 'Num']],
] as const) {
  test(`routing on the route step's output, as ADK matches it: "${route}"`, async () => {
    const stubs: Stubs = { Triage: { output: () => ({ route, text: 'x' }) } };
    // Several terminals: only one may produce output, so the others output nothing here.
    for (const n of ['Bug', 'Feature', 'Other']) stubs[n] = { output: () => undefined };
    const events: SchedulerEvent[] = [];
    const adk = await runOnAdk(ROUTED, stubs, 'go');
    const native = await runNative(ROUTED, stubs, 'go', events);
    assert.deepEqual(native, adk);
    assert.deepEqual(events.filter((e) => e.type === 'node_end').map((e) => e.node), expected);
  });
}

test('nextNodes: a key spelled as an integer matches as ADK stores it', () => {
  const graph = buildWorkflowGraph(ROUTED);
  assert.deepEqual(nextNodes(graph, 'Triage__route', '1'), ['Num']);
  assert.deepEqual(nextNodes(graph, 'Triage__route', '01'), ['Other']);
  assert.deepEqual(nextNodes(graph, 'Triage__route', ['bug', 'feature']), ['Bug', 'Feature', 'Num']);
  assert.deepEqual(nextNodes(graph, 'Triage__route', undefined), ['Other']);
  assert.deepEqual(nextNodes(graph, 'Triage', undefined), ['Triage__route']);
});

test('max_concurrency bounds the nodes running at once, in ADK\'s order', async () => {
  const cfg = syndicate('Bounded', ['Lead', 'A', 'B', 'C', 'Tail'], {
    edges: [['START', 'Lead', ['A', 'B', 'C']], [['A', 'B', 'C'], 'All', 'Tail']],
    nodes: { All: { join: true } },
    max_concurrency: 2,
  });
  const stubs: Stubs = { A: { delay: 20 }, B: { delay: 5 }, C: { delay: 5 } };
  const events: SchedulerEvent[] = [];
  const adk = await runOnAdk(cfg, stubs, 'go');
  const native = await runNative(cfg, stubs, 'go', events);
  assert.deepEqual(native, adk);
  let running = 0;
  let peak = 0;
  for (const e of events) {
    if (e.type === 'node_start') peak = Math.max(peak, ++running);
    if (e.type === 'node_end') running--;
  }
  assert.equal(peak, 2);
  assert.deepEqual(events.filter((e) => e.type === 'node_end').map((e) => e.node), ['Lead', 'B', 'C', 'A', 'All', 'Tail']);
});

// ── Ends ─────────────────────────────────────────────────────────────────────

test('two terminal outputs fail the run with ADK\'s message', async () => {
  const cfg = syndicate('Two', ['Lead', 'A', 'B'], { edges: [['START', 'Lead', ['A', 'B']]] });
  const adkError = await runOnAdk(cfg, {}, 'go').then(
    () => assert.fail('ADK accepts two terminal outputs'),
    (e: Error) => e.message,
  );
  await assert.rejects(runNative(cfg, {}, 'go'), (e: Error) => e.message === adkError);
});

test('a node that throws stops the walk: the others are aborted and settle, the error is rethrown', async () => {
  const cfg = syndicate('Fails', ['Lead', 'Slow', 'Bad', 'Never'], {
    edges: [['START', 'Lead', ['Slow', 'Bad']], ['Slow', 'Never']],
  });
  const boom = new Error('boom');
  let slowSawAbort = false;
  let slowSettled = false;
  const ran: string[] = [];
  await assert.rejects(
    runWorkflowGraph(buildWorkflowGraph(cfg), {
      input: 'go',
      runNode: async (r) => {
        const name = r.target.kind === 'map_item' ? r.target.agent : r.target.name;
        ran.push(name);
        if (name === 'Bad') throw boom;
        if (name === 'Slow') {
          await new Promise<void>((resolve) => r.signal.addEventListener('abort', () => resolve(), { once: true }));
          slowSawAbort = r.signal.aborted;
          slowSettled = true;
        }
        return { output: name };
      },
    }),
    (e) => e === boom,
  );
  assert.ok(slowSawAbort && slowSettled, 'the pending node saw the abort and settled before the error surfaced');
  assert.deepEqual(ran, ['Lead', 'Slow', 'Bad']);
});

test('the caller\'s signal reaches every run', async () => {
  const cfg = syndicate('Abort', ['Lead', 'Tail'], { edges: [['START', 'Lead', 'Tail']] });
  const controller = new AbortController();
  await assert.rejects(
    runWorkflowGraph(buildWorkflowGraph(cfg), {
      input: 'go',
      signal: controller.signal,
      runNode: async (r) => {
        queueMicrotask(() => controller.abort(new Error('stop')));
        await new Promise<void>((resolve) => r.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw r.signal.reason;
      },
    }),
    /stop/,
  );
});

test('streamWorkflowGraph yields every event in order, then the run', async () => {
  const stream = streamWorkflowGraph(buildWorkflowGraph(SIX), { input: 'go', runNode: async (r) => ({ output: `${(r.target as any).name}` }) });
  const seen: string[] = [];
  let step = await stream.next();
  while (!step.done) {
    seen.push(`${step.value.type}:${step.value.node}`);
    step = await stream.next();
  }
  assert.equal(seen.length, 12);
  assert.equal(seen[0], 'node_start:Planner');
  assert.equal(seen.at(-1), 'node_end:Publisher');
  assert.deepEqual(step.value.order, ['Planner', 'Writer', 'Checker', 'Editor', 'Both', 'Publisher']);
  assert.equal(step.value.output, 'Publisher');
});

// ── No ADK ───────────────────────────────────────────────────────────────────

test('lib/workflow/scheduler.ts reaches ADK through no value import', () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const [statement] of src.matchAll(/^import\s[^;]*;/gm)) {
      if (/^import\s+type\s/.test(statement)) continue;
      const spec = /from\s+'([^']*)'/.exec(statement)?.[1] ?? '';
      if (spec.startsWith('@google/adk') || spec.startsWith('@google/genai')) offenders.push(`${path.relative(ROOT, file)}: ${spec}`);
      if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), spec));
    }
  };
  visit(path.join(ROOT, 'lib/workflow/scheduler.ts'));
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'lib/workflow/scheduler.ts'), 'utf8'), /@google\/adk/);
});
