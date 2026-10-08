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
 * outputs. A stub's delay is on a virtual clock (tests/helpers/
 * virtualClock.ts), one per side, so the order is the delays' timeline on
 * both sides however loaded the machine is; a stub that races a real timer
 * (a node timeout, a retry's backoff) waits on real time instead. The
 * orders ADK records are also pinned as literals, so an ADK upgrade that
 * changes them fails here by name. No models run, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FunctionNode, InMemorySessionService, LogLevel, Runner, createEvent, setLogLevel } from '@google/adk';
import type { LlmAgent } from '@google/adk';

import { compileWorkflow } from '../lib/workflow.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { buildWorkflowGraph } from '../lib/workflow/graph.ts';
import { toRetryConfig } from '../lib/workflowConfig.ts';
import { virtualClock } from './helpers/virtualClock.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import {
  DEFAULT_MAX_PARALLEL,
  InvocationAbortedError,
  errorName,
  nextNodes,
  retryDelaySeconds,
  runWorkflowGraph,
  shouldRetry,
  nodeErrorEvent,
  streamWorkflowGraph,
} from '../lib/workflow/scheduler.ts';
import type { NodeRun, SchedulerEvent, WorkflowRun } from '../lib/workflow/scheduler.ts';
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

/**
 * What an agent does in a case: its output from its input (it may throw, or
 * return `reported(...)` to report an error as an ADK node does with an
 * event's errorCode), and how long it takes (ms on the side's virtual clock;
 * absent = no wait). `realTime` waits real ms instead, for a stub that races
 * a real timer: a node's timeout or a retry's backoff.
 */
interface Stub {
  output?: (input: unknown, call: number) => unknown;
  delay?: number | ((input: unknown, call: number) => number);
  realTime?: boolean;
}
type Stubs = Record<string, Stub>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A reported error: an ADK event carrying errorCode and errorMessage; the scheduler's `NodeResult.error`. */
class Reported {
  readonly code: string;
  readonly message: string;
  constructor(code: string, message: string) {
    this.code = code;
    this.message = message;
  }
}
const reported = (code: string, message: string) => new Reported(code, message);

/** An error carrying a code, as a provider SDK's errors do. */
const coded = (message: string, code: number | string) => Object.assign(new Error(message), { code });

/**
 * One side's record: every agent call with its input, every node completion
 * with its output and branch, every node error as runSyndicateTurn's drain
 * collects it (with the error type and attempt count of a node that gave
 * up), and the workflow's output or the error it failed with.
 */
interface Record_ {
  calls: string[];
  completions: string[];
  output: unknown;
  nodeErrors: string[];
  /** Every node-error event (ADK's isNodeError) as stored, without its id, time and invocation id. */
  errorEvents: string[];
  error?: string;
}

/** An event as stored, without what differs per run: its id, time and invocation id. */
const storedEvent = (event: unknown) => {
  const { id: _id, timestamp: _t, invocationId: _i, ...rest } = JSON.parse(JSON.stringify(event));
  return JSON.stringify(rest);
};

const nodeError = (path: string, branch: string | undefined, node: string, code: string, message: string, gaveUp?: { errorType?: string; attempt?: number }) =>
  `${path}@${branch ?? '-'} ${node} [${code}] ${message}${gaveUp ? ` (${gaveUp.errorType} after ${gaveUp.attempt})` : ''}`;

/** The stub table as one function both sides call, each side on its own clock; `calls` records `name <- input`. */
function stubRunner(stubs: Stubs, calls: string[]) {
  const counts = new Map<string, number>();
  const clock = virtualClock();
  return async (name: string, input: unknown): Promise<unknown> => {
    const call = (counts.get(name) ?? 0) + 1;
    counts.set(name, call);
    calls.push(`${name} <- ${JSON.stringify(input)}`);
    const stub = stubs[name] ?? {};
    const delay = typeof stub.delay === 'function' ? stub.delay(input, call) : stub.delay;
    if (delay !== undefined) await (stub.realTime ? sleep(delay) : clock.sleep(delay));
    return stub.output ? stub.output(input, call) : `${name}(${typeof input === 'string' ? input : JSON.stringify(input)})`;
  };
}

const completion = (path: string, output: unknown, branch: string | undefined) => `${path} = ${JSON.stringify(output)} @${branch ?? '-'}`;

/**
 * ADK's walk: the real compile, every agent a stub FunctionNode carrying the
 * agent's node modifiers (retry, timeout) as the compiled agent does, run by
 * ADK's Runner.
 */
async function runOnAdk(cfg: SyndicateYamlConfig, stubs: Stubs, input: string): Promise<Record_> {
  const calls: string[] = [];
  const run = stubRunner(stubs, calls);
  const toStub = (a: LlmAgent) =>
    new FunctionNode(
      a.name,
      async (_ctx: unknown, nodeInput: unknown) => {
        const out = await run(a.name, nodeInput);
        return out instanceof Reported ? createEvent({ errorCode: out.code, errorMessage: out.message }) : out;
      },
      { retryConfig: (a as any).retryConfig, timeout: (a as any).timeout },
    ) as unknown as LlmAgent;
  const { workflow } = await compileWorkflow(cfg, {}, toStub);
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({ appName: 'sched', userId: 'u', sessionId: 's' });
  const runner = new Runner({ agent: workflow as any, appName: 'sched', sessionService });
  const completions: string[] = [];
  const nodeErrors: string[] = [];
  const errorEvents: string[] = [];
  // The Runner yields no event for the workflow's own output; it is the one terminal node's, as ADK's finalize takes it.
  const terminals = new Set(buildWorkflowGraph(cfg).terminals.map((n) => `${cfg.syndicate_name}.${n}`));
  let output: unknown;
  let error: string | undefined;
  try {
    for await (const ev of runner.runAsync({ userId: 'u', sessionId: 's', newMessage: { role: 'user', parts: [{ text: input }] } })) {
      const e = ev as any;
      const p = e.nodeInfo?.path as string | undefined;
      // An error as runSyndicateTurn's drain reads it (errorPolicy 'collect').
      if ((e.errorCode || e.errorMessage) && e.errorCode !== 'STOP') {
        nodeErrors.push(nodeError(p ?? '', ev.branch, e.author, String(e.errorCode), String(e.errorMessage), e.isNodeError ? { errorType: e.errorType, attempt: e.attemptCount } : undefined));
        if (e.isNodeError) errorEvents.push(storedEvent(e));
        continue;
      }
      if (e.output === undefined || !p) continue;
      if (terminals.has(p)) output = e.output;
      completions.push(completion(p, e.output, ev.branch));
    }
  } catch (err) {
    error = `${(err as Error).name}: ${(err as Error).message}`;
    output = undefined;
  }
  return { calls, completions, output, nodeErrors, errorEvents, ...(error ? { error } : {}) };
}

/** The scheduler's walk on the engine's own graph, with the same stubs. */
async function runNative(cfg: SyndicateYamlConfig, stubs: Stubs, input: string, events?: SchedulerEvent[], runs?: WorkflowRun[]): Promise<Record_> {
  const calls: string[] = [];
  const run = stubRunner(stubs, calls);
  const completions: string[] = [];
  const nodeErrors: string[] = [];
  const errorEvents: string[] = [];
  let output: unknown;
  let error: string | undefined;
  try {
    const result = await runWorkflowGraph(buildWorkflowGraph(cfg), {
      input,
      runNode: async (r: NodeRun) => {
        const out = await run(r.target.kind === 'map_item' ? r.target.agent : r.target.name, r.input);
        return out instanceof Reported ? { error: { code: out.code, message: out.message } } : { output: out };
      },
      onEvent: (e) => {
        events?.push(e);
        // ADK writes no event for a node whose output is undefined; the record leaves it out on both sides.
        if ((e.type === 'node_end' || e.type === 'item_end') && e.output !== undefined) completions.push(completion(e.path, e.output, e.branch));
        if (e.type === 'node_error') nodeErrors.push(nodeError(e.path, e.branch, e.node, e.code, e.message, e.source === 'workflow' ? { errorType: e.errorType, attempt: e.attempt } : undefined));
        if (e.type === 'node_error' && e.source === 'workflow') errorEvents.push(storedEvent(nodeErrorEvent(e, 'e-native')));
      },
    });
    runs?.push(result);
    output = result.output;
  } catch (err) {
    error = `${(err as Error).name}: ${(err as Error).message}`;
  }
  // ADK writes a map item's event before the map's own; so does the scheduler. The orders compare as they stand.
  return { calls, completions, output, nodeErrors, errorEvents, ...(error ? { error } : {}) };
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
// Finish times never tie under any max_parallel here (at least 20 ms apart on the virtual clock).
const itemDelays: Record<string, number> = { a: 200, b: 20, c: 110, d: 50, e: 80 };
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
  // Finish times B 5, C 25, A 80 ms on the virtual clock.
  const stubs: Stubs = { A: { delay: 80 }, B: { delay: 5 }, C: { delay: 20 } };
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
  const record = await bothAgree(cfg, {});
  assert.match(record.error ?? '', /^Error: Workflow Two: multiple terminal nodes produced output \(2\)/);
});

test('a null output is no output, as on ADK: nothing recorded, the successor runs on undefined, a join keys it as undefined', async () => {
  const chain = syndicate('N', ['A', 'B', 'C'], { edges: [['START', 'A', 'B', 'C']] });
  const record = await bothAgree(chain, { B: { output: () => null } });
  assert.deepEqual(record.calls, ['A <- "go"', 'B <- "A(go)"', 'C <- undefined']);
  assert.deepEqual(record.completions, ['N.A = "A(go)" @-', 'N.C = "C(undefined)" @-']);

  // One of two terminals outputs null: only one terminal output, so the walk completes.
  const twoEnds = syndicate('N2', ['A', 'B', 'C'], { edges: [['START', 'A', ['B', 'C']]] });
  assert.equal((await bothAgree(twoEnds, { B: { output: () => null } })).output, 'C(A(go))');

  const joined = syndicate('N3', ['A', 'B', 'C', 'D'], { edges: [['START', 'A', ['B', 'C']], [['B', 'C'], 'J', 'D']], nodes: { J: { join: true } } });
  const viaJoin = await bothAgree(joined, { B: { output: () => null }, D: { output: (input) => input } });
  assert.deepEqual(viaJoin.output, { B: undefined, C: 'C(A(go))' }, 'keyed as undefined, which a JSON write drops');

  const items = syndicate('N4', ['Lead', 'Worker', 'Sum'], { edges: [['START', 'Lead', 'Fan', 'Sum']], nodes: { Fan: { map: 'Worker' } } });
  const viaMap = await bothAgree(items, { Lead: { output: () => ['a', 'b'] }, Worker: { output: (i) => (i === 'a' ? null : i) }, Sum: { output: (list) => list } });
  assert.deepEqual(viaMap.output, [undefined, 'b'], 'a null item is undefined in the list, which JSON writes as null');
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

// ── Retry, timeout and node errors (ADR 0030 on both sides, WS4-2b) ──────────

const retrying = (retry: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  syndicate('R', ['Triage', 'Fixer'], { edges: [['START', 'Triage', 'Fixer']], nodes: { Fixer: { retry: { initial_delay: 0.001, ...retry }, ...extra } } });

/** Run both sides, require the same record, and return it with the scheduler's own result. */
async function bothAgreeOn(cfg: SyndicateYamlConfig, stubs: Stubs): Promise<{ record: Record_; run?: WorkflowRun; events: SchedulerEvent[] }> {
  const adk = await runOnAdk(cfg, stubs, 'go');
  const events: SchedulerEvent[] = [];
  const runs: WorkflowRun[] = [];
  const native = await runNative(cfg, stubs, 'go', events, runs);
  assert.deepEqual(native, adk);
  return { record: adk, run: runs[0], events };
}

test('retry: a node that throws once recovers on its next attempt, and nothing is reported', async () => {
  const stubs: Stubs = { Fixer: { output: (_i, call) => (call === 1 ? (() => { throw coded('flaky', 503); })() : 'fixed') } };
  const { record, run } = await bothAgreeOn(retrying({ max_attempts: 3 }), stubs);
  assert.equal(record.output, 'fixed');
  assert.deepEqual(record.calls, ['Triage <- "go"', 'Fixer <- "Triage(go)"', 'Fixer <- "Triage(go)"']);
  assert.deepEqual(record.nodeErrors, []);
  assert.deepEqual(run?.nodeErrors, []);
});

test('retry: a node that reports an error once recovers; the failed attempt is collected, not fatal (ADR 0030)', async () => {
  const stubs: Stubs = { Fixer: { output: (_i, call) => (call === 1 ? reported('503', 'overloaded') : 'fixed') } };
  const { record, run } = await bothAgreeOn(retrying({ max_attempts: 3, max_delay: 0.02 }), stubs);
  assert.equal(record.output, 'fixed');
  assert.deepEqual(record.nodeErrors, ['R.Fixer@- Fixer [503] overloaded']);
  assert.deepEqual(run?.nodeErrors, [{ node: 'Fixer', code: '503', message: 'overloaded' }], 'as answer.nodeErrors holds it');
});

test('retry: a node that gives up on a reported error fails the walk, the error named once per attempt (ADR 0030)', async () => {
  const stubs: Stubs = { Fixer: { output: () => reported('500', 'down') } };
  const once = await bothAgreeOn(retrying({ max_attempts: 1 }), stubs);
  assert.equal(once.record.error, "NodeReportedError: Node 'Fixer' failed: 500: down");
  assert.deepEqual(once.record.nodeErrors, ['R.Fixer@- Fixer [500] down']);
  const thrice = await bothAgreeOn(retrying({ max_attempts: 3 }), stubs);
  assert.equal(thrice.record.calls.filter((c) => c.startsWith('Fixer')).length, 3);
  assert.deepEqual(thrice.record.nodeErrors, Array(3).fill('R.Fixer@- Fixer [500] down'));
});

test('retry: a node that keeps throwing gives up after max_attempts; the walk reports it once with its type, code and attempts', async () => {
  for (const [error, expected] of [
    [() => new TypeError('bad'), ['TypeError: bad', 'R.Fixer@- Fixer [UNKNOWN_ERROR] bad (TypeError after 3)']],
    [() => coded('overloaded', 503), ['Error: overloaded', 'R.Fixer@- Fixer [503] overloaded (Error after 3)']],
  ] as const) {
    const stubs: Stubs = { Fixer: { output: () => { throw error(); } } };
    const { record } = await bothAgreeOn(retrying({ max_attempts: 3 }), stubs);
    assert.equal(record.error, expected[0]);
    assert.deepEqual(record.nodeErrors, [expected[1]]);
    assert.equal(record.calls.filter((c) => c.startsWith('Fixer')).length, 3);
  }
  // The event ADK writes for the node that gave up, as nodeErrorEvent builds it.
  const { record } = await bothAgreeOn(retrying({ max_attempts: 2 }), { Fixer: { output: () => { throw new TypeError('bad'); } } });
  assert.deepEqual(record.errorEvents.map((e) => JSON.parse(e)), [
    {
      author: 'Fixer',
      nodeInfo: { path: 'R.Fixer' },
      actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {} },
      longRunningToolIds: [],
      isNodeError: true,
      errorType: 'TypeError',
      errorCode: 'UNKNOWN_ERROR',
      errorMessage: 'bad',
      attemptCount: 2,
    },
  ]);
});

test('retry.exceptions from the YAML: only a named error is retried, on ADK (its retryConfig) and on the scheduler alike', async () => {
  const typeError: Stubs = { Fixer: { output: () => { throw new TypeError('bad'); } } };
  const named = await bothAgreeOn(retrying({ max_attempts: 3, jitter: 0, exceptions: ['TypeError'] }), typeError);
  assert.equal(named.record.calls.filter((c) => c.startsWith('Fixer')).length, 3, 'a named error is retried');
  const other = await bothAgreeOn(retrying({ max_attempts: 3, jitter: 0, exceptions: ['NodeTimeoutError'] }), typeError);
  assert.equal(other.record.calls.filter((c) => c.startsWith('Fixer')).length, 1, 'an error not named is not');
  assert.deepEqual(other.record.nodeErrors, ['R.Fixer@- Fixer [UNKNOWN_ERROR] bad (TypeError after 1)']);
});

test('retry.exceptions and retry.jitter: the schema takes them, the graph keeps them, and ADK gets them in its retryConfig', () => {
  const cfg = retrying({ max_attempts: 2, jitter: 0, exceptions: ['TypeError', 'NodeTimeoutError'] });
  const fixer = buildWorkflowGraph(cfg).nodes.get('Fixer') as { settings: { retry?: Record<string, unknown> } };
  assert.deepEqual(fixer.settings.retry, { initial_delay: 0.001, max_attempts: 2, jitter: 0, exceptions: ['TypeError', 'NodeTimeoutError'] });
  assert.deepEqual(toRetryConfig(fixer.settings.retry), { maxAttempts: 2, initialDelay: 0.001, jitter: 0, exceptions: ['TypeError', 'NodeTimeoutError'] });
  for (const [retry, message] of [
    [{ exceptions: [] }, /workflow\.nodes\.Fixer\.retry\.exceptions/],
    [{ exceptions: ['not a name'] }, /an error name, such as TypeError/],
    [{ jitter: -1 }, /workflow\.nodes\.Fixer\.retry\.jitter/],
  ] as const) {
    assert.throws(() => retrying(retry), message);
  }
});

test('timeout: an attempt that runs past it is abandoned and retried; without a retry the walk fails with NodeTimeoutError', async () => {
  // Real time: the first attempt (300 ms) runs 200 ms past the 100 ms timeout, the second (0 ms) ends 100 ms inside it.
  const slowOnce: Stubs = { Fixer: { delay: (_i, call) => (call === 1 ? 300 : 0), realTime: true, output: () => 'fixed' } };
  const recovered = await bothAgreeOn(retrying({ max_attempts: 2 }, { timeout: 0.1 }), slowOnce);
  assert.equal(recovered.record.output, 'fixed');
  assert.deepEqual(recovered.record.nodeErrors, []);

  const timedOut = syndicate('T', ['Triage', 'Fixer'], { edges: [['START', 'Triage', 'Fixer']], nodes: { Fixer: { timeout: 0.1 } } });
  const { record } = await bothAgreeOn(timedOut, { Fixer: { delay: 300, realTime: true } });
  assert.equal(record.error, "NodeTimeoutError: Node 'Fixer' timed out after 0.1 seconds.");
  assert.deepEqual(record.nodeErrors, ["T.Fixer@- Fixer [UNKNOWN_ERROR] Node 'Fixer' timed out after 0.1 seconds. (NodeTimeoutError after 1)"]);
});

test('timeout: the runner\'s signal aborts with the timeout', async () => {
  const cfg = syndicate('T', ['Triage', 'Fixer'], { edges: [['START', 'Triage', 'Fixer']], nodes: { Fixer: { timeout: 0.02 } } });
  let reason: unknown;
  await assert.rejects(
    runWorkflowGraph(buildWorkflowGraph(cfg), {
      input: 'go',
      runNode: async (r) => {
        if (r.target.kind !== 'map_item' && r.target.name === 'Triage') return { output: 'x' };
        await new Promise<void>((resolve) => r.signal.addEventListener('abort', () => resolve(), { once: true }));
        reason = r.signal.reason;
        return { output: 'late' };
      },
    }),
    { name: 'NodeTimeoutError' },
  );
  assert.equal(errorName(reason), 'NodeTimeoutError');
});

const mapped = syndicate('M', ['Lead', 'Worker', 'Sum'], {
  edges: [['START', 'Lead', 'Fan', 'Sum']],
  // Each item runs under Worker's own modifiers; the schema refuses retry and timeout on the map entry (ADR 0103).
  nodes: { Fan: { map: 'Worker', max_parallel: 1 }, Worker: { retry: { max_attempts: 2, initial_delay: 0.001 } } },
});

test('map: each item runs under its agent\'s retry; a reported item error names the item\'s path and branch', async () => {
  const stubs: Stubs = {
    Lead: { output: () => ['a', 'b'] },
    Worker: { delay: 5, output: (item, call) => (item === 'b' && call === 2 ? reported('503', 'once') : `w:${item}`) },
    Sum: { output: (list) => (list as string[]).join(',') },
  };
  const { record } = await bothAgreeOn(mapped, stubs);
  assert.equal(record.output, 'w:a,w:b');
  assert.deepEqual(record.nodeErrors, ['M.Fan.Worker@1@Worker@1 Worker [503] once']);
});

test('map: an item that gives up fails the map with DynamicNodeFailError, reported once under the map\'s name', async () => {
  const stubs: Stubs = { Lead: { output: () => ['a', 'b', 'c'] }, Worker: { output: (item) => { if (item === 'b') throw new Error('item'); return `w:${item}`; } } };
  const { record } = await bothAgreeOn(mapped, stubs);
  assert.equal(record.error, 'DynamicNodeFailError: Dynamic node Worker failed: item');
  assert.deepEqual(record.nodeErrors, ['M.Fan@- Fan [UNKNOWN_ERROR] Dynamic node Worker failed: item (DynamicNodeFailError after 1)']);
  assert.deepEqual(record.calls, ['Lead <- "go"', 'Worker <- "a"', 'Worker <- "b"', 'Worker <- "b"'], 'the pool takes no item after the failure');
});

const bounded = (nodes: Record<string, unknown>) =>
  syndicate('B', ['Lead', 'A', 'B', 'C', 'Tail'], {
    edges: [['START', 'Lead', ['A', 'B', 'C']], [['A', 'B', 'C'], 'All', 'Tail']],
    nodes: { All: { join: true }, ...nodes },
    max_concurrency: 2,
  });

test('max_concurrency counts a retrying node as running, in ADK\'s order', async () => {
  // A's retry waits on a real backoff, so the stubs wait real time: A 5 ms, its retry 5 ms, then C 5 ms; B 400 ms outlasts them by far under load.
  const stubs: Stubs = {
    A: { delay: 5, realTime: true, output: (_i, call) => (call === 1 ? reported('429', 'slow down') : 'a') },
    B: { delay: 400, realTime: true },
    C: { delay: 5, realTime: true },
  };
  const events: SchedulerEvent[] = [];
  const adk = await runOnAdk(bounded({ A: { retry: { max_attempts: 2, initial_delay: 0.001 } } }), stubs, 'go');
  const native = await runNative(bounded({ A: { retry: { max_attempts: 2, initial_delay: 0.001 } } }), stubs, 'go', events);
  assert.deepEqual(native, adk);
  let running = 0;
  let peak = 0;
  for (const e of events) {
    if (e.type === 'node_start') peak = Math.max(peak, ++running);
    if (e.type === 'node_end') running--;
  }
  assert.equal(peak, 2);
  assert.deepEqual(native.nodeErrors, ['B.A@A@1 A [429] slow down']);
});

test('max_concurrency under a failure: the buffered node never starts, the error is ADK\'s', async () => {
  const stubs: Stubs = { A: { delay: 5, output: () => { throw new RangeError('no'); } }, B: { delay: 20 } };
  const { record } = await bothAgreeOn(bounded({}), stubs);
  assert.equal(record.error, 'RangeError: no');
  assert.ok(!record.calls.some((c) => c.startsWith('C')), record.calls.join(' | '));
  assert.deepEqual(record.nodeErrors, ['B.A@- A [UNKNOWN_ERROR] no (RangeError after 1)']);
});

test('which errors retry, and the backoff, are ADK\'s (retry_utils)', async () => {
  const adkRetry = await import(pathToFileURL(path.join(ROOT, 'node_modules/@google/adk/dist/esm/workflow/utils/retry_utils.js')).href);
  class ProviderError extends Error {}
  const named = Object.assign(new Error('x'), { name: 'RateLimitError' });
  for (const error of [new Error('x'), new TypeError('x'), new ProviderError('x'), named, 'text', { plain: true }]) {
    assert.equal(errorName(error), adkRetry.errorName(error));
    for (const exceptions of [undefined, ['TypeError'], ['ProviderError', 'RateLimitError'], []]) {
      for (const attempts of [1, 2, 3, 5]) {
        for (const max of [undefined, 1, 3]) {
          const ours = shouldRetry(error, { ...(max !== undefined ? { max_attempts: max } : {}), ...(exceptions ? { exceptions } : {}) }, attempts);
          const theirs = adkRetry.shouldRetryNode({ error, retryConfig: { maxAttempts: max, exceptions }, nodeState: { attemptCount: attempts } });
          assert.equal(ours, theirs, `${errorName(error)} ${JSON.stringify(exceptions)} ${attempts}/${max}`);
        }
      }
    }
  }
  for (const r of [0, 0.25, 0.5, 0.999]) {
    for (const retry of [{}, { initial_delay: 0.5, backoff_factor: 3, max_delay: 4 }, { initial_delay: 2, max_delay: 3, jitter: 0 }, { jitter: 0.5 }]) {
      for (const attempts of [1, 2, 4, 9]) {
        const ours = retryDelaySeconds(retry, attempts, () => r);
        const theirs = adkRetry.getRetryDelaySeconds({
          retryConfig: { initialDelay: (retry as any).initial_delay, maxDelay: (retry as any).max_delay, backoffFactor: (retry as any).backoff_factor, jitter: (retry as any).jitter },
          nodeState: { attemptCount: attempts },
          randomFn: () => r,
        });
        assert.equal(ours, theirs, `${JSON.stringify(retry)} attempt ${attempts} random ${r}`);
      }
    }
  }
});

// ── Abort and deadline ───────────────────────────────────────────────────────

test('abort during a retry\'s backoff: no further attempt, nothing reported, the successor never runs', async () => {
  const controller = new AbortController();
  const ran: string[] = [];
  const events: SchedulerEvent[] = [];
  await assert.rejects(
    runWorkflowGraph(buildWorkflowGraph(retrying({ max_attempts: 5, initial_delay: 10 })), {
      input: 'go',
      signal: controller.signal,
      onEvent: (e) => events.push(e),
      runNode: async (r) => {
        const name = (r.target as { name: string }).name;
        ran.push(`${name}#${r.attempt}`);
        if (name === 'Fixer') {
          setTimeout(() => controller.abort(new Error('cancel')), 5);
          throw new Error('flaky');
        }
        return { output: name };
      },
    }),
    (e: Error) => e instanceof InvocationAbortedError && e.message === 'Invocation aborted during retry.',
  );
  assert.deepEqual(ran, ['Triage#1', 'Fixer#1']);
  assert.deepEqual(events.filter((e) => e.type === 'node_error'), [], 'an aborted walk reports no node error');
});

test('the turn\'s deadline (turnControl) reaches every run and stops the walk: no node starts after it', async () => {
  const cfg = syndicate('D', ['Lead', 'Slow', 'Next'], { edges: [['START', 'Lead', 'Slow', 'Next']] });
  const control = createTurnControl({ deadlineMs: 20 });
  const ran: string[] = [];
  let slowReason: unknown;
  try {
    await assert.rejects(
      runWithTurnControl(control, () =>
        runWorkflowGraph(buildWorkflowGraph(cfg), {
          input: 'go',
          runNode: async (r) => {
            const name = (r.target as { name: string }).name;
            ran.push(name);
            if (name === 'Slow') {
              // A node that sees the abort but still finishes with an output.
              await new Promise<void>((resolve) => r.signal.addEventListener('abort', () => resolve(), { once: true }));
              slowReason = r.signal.reason;
            }
            return { output: name };
          },
        }),
      ),
      (e: Error) => e instanceof InvocationAbortedError && /exceeded its time limit/.test(String((e.cause as Error)?.message)),
    );
  } finally {
    control.dispose();
  }
  assert.equal(control.stopReason, 'deadline');
  assert.match(String((slowReason as Error)?.message), /exceeded its time limit/);
  assert.deepEqual(ran, ['Lead', 'Slow'], 'Next never starts');
});

test('abort while a timed node runs: the attempt ends at once with InvocationAbortedError, not a timeout', async () => {
  const cfg = syndicate('A', ['Lead', 'Slow'], { edges: [['START', 'Lead', 'Slow']], nodes: { Slow: { timeout: 5, retry: { max_attempts: 3 } } } });
  const controller = new AbortController();
  const started = Date.now();
  let attempts = 0;
  await assert.rejects(
    runWorkflowGraph(buildWorkflowGraph(cfg), {
      input: 'go',
      signal: controller.signal,
      runNode: async (r) => {
        if ((r.target as { name: string }).name === 'Lead') return { output: 'x' };
        attempts++;
        setTimeout(() => controller.abort(), 5);
        await sleep(1000); // ignores its signal; the timeout's race does not wait for it
        return { output: 'late' };
      },
    }),
    (e: Error) => e instanceof InvocationAbortedError && e.message === "Invocation aborted while running node 'Slow'.",
  );
  assert.equal(attempts, 1, 'an abort is never retried');
  assert.ok(Date.now() - started < 500, 'the walk did not wait for the abandoned attempt');
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
