/**
 * tests/workflowParity.test.ts — the workflow parity gaps closed before
 * native workflows go live (WS4-6a, ADR 0093), each against ADK.
 *
 *   1. Workflow placeholders in a node agent's instruction (`{x.field}`,
 *      `<x.field from Node>`) are filled on native as ADK 2.2's
 *      injectSessionState fills them with its workflowInstructionScope.
 *   2. A join and a map store the events ADK's JoinNode and ParallelWorker
 *      store, so fan-out, join and map cases compare on stored events.
 *   3. Under concurrent fan-out the events land in ADK's order: three
 *      branches (an agent calling a tool and routing on, a tool node, a map)
 *      under delay profiles that keep any two finish times 20 ms apart, and
 *      a node two branches trigger; and, with the pause, an agent node's
 *      user turn stored ahead of an ask_user request started in the same
 *      pass, as ADK appends the turn straight to the session. Closer
 *      finishes race on both runtimes and are not pinned.
 *   4. A compaction event a node agent stores carries the node stamp
 *      (enrichNodeEvent), and outside task mode the summary as its output,
 *      as ADK's node runner and maybeSetOutput write it.
 *
 * Parity cases run one workflow syndicate on ADK (runSyndicateTurn, runtime
 * adk) and on the scheduler with agentNodeRuntime, with the same scripted
 * models (tests/helpers/workflowParity.ts), and compare the stored events
 * (ids and times aside), every model's requests, the routes, the output and
 * the progress lines. No network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LogLevel, setLogLevel } from '@google/adk';
import { z } from 'zod';

import { createTurnEvent } from '../lib/runtime/events.ts';
import { injectSessionState, predecessorOutputs } from '../lib/runtime/native/request.ts';
import type { WorkflowInstructionScope } from '../lib/runtime/native/request.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { buildWorkflowGraph } from '../lib/workflow/graph.ts';
import { mapNodeEvent, nodeOutputContent } from '../lib/workflow/nodeEvents.ts';
import { runWorkflowGraph } from '../lib/workflow/scheduler.ts';
import { answer, requestTexts, toolCall } from './helpers/scriptedModel.ts';
import { agent, bothAgree, workflowConfig } from './helpers/workflowParity.ts';

setLogLevel(LogLevel.ERROR);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. Workflow placeholders ─────────────────────────────────────────────────

/** ADK's own injectSessionState, called with a context shaped like the one runLlmAgentAsNode builds. */
async function adkInject(template: string, state: Record<string, unknown>, scope?: WorkflowInstructionScope): Promise<string> {
  const { injectSessionState: adk } = await import(pathToFileURL(path.join(ROOT, 'node_modules/@google/adk/dist/esm/agents/instructions.js')).href);
  return adk(template, { invocationContext: { session: { state }, ...(scope ? { workflowInstructionScope: scope } : {}) } });
}

const SCOPE: WorkflowInstructionScope = {
  input: { topic: 'cats', who: 'kids', n: 3, obj: { a: 1 }, empty: '', nil: null },
  outputsByNode: { Planner: { topic: 'dogs', list: [1, 2] }, Writer: 'plain text', Counter: 7 },
};
const STATE = { mood: 'calm', 'user:name': 'Ada' };

const TEMPLATES = [
  'Write on {input.topic} for {input.who}.',
  '{input.n} {input.obj} {input.empty}|{input.nil}|',
  '{input.missing} / {input.gone?} / {any.topic} / {input.topic?}',
  '{input.missing?} then {input.missing}: the first spelling stays',
  '{input.missing} then {input.missing?}',
  '{{input.topic}} {{{input.who}}} {input.topic }',
  '<input.topic from Planner> <x.list from Planner> <input.topic   from   Planner  > < input.topic from Planner>',
  '<input.topic from Writer> <input.n from Counter> <input.x from Nope> <input.topic from Planner',
  '<input.topic fromPlanner> <input.topic from  > <1x.topic from Planner> <input..topic from Planner>',
  '<input.topic\tfrom\nPlanner> <a.b.c from Planner> <input.topic from Planner2>',
  '{ <input.topic from Planner> } overlap',
  '{mood} {user:name} {missing_state?} {input.topic} <input.topic from Planner>',
  '{ "a": 1 } {not valid} {a:b:c} { {',
  'no placeholders at all',
  '<<input.topic from Planner>> <> < > <input.',
];

test("workflow placeholders: the same text as ADK's injectSessionState, with and without a scope", async () => {
  for (const template of TEMPLATES) {
    assert.equal(injectSessionState(template, STATE, SCOPE), await adkInject(template, STATE, SCOPE), `with a scope: ${template}`);
  }
  for (const template of TEMPLATES) {
    // Without a scope a workflow key is not a key at all; a thrown error is compared as its message.
    let ours: string | Error;
    let theirs: string | Error;
    try {
      ours = injectSessionState(template, STATE);
    } catch (e) {
      ours = e as Error;
    }
    try {
      theirs = await adkInject(template, STATE);
    } catch (e) {
      theirs = e as Error;
    }
    assert.deepEqual(String(ours), String(theirs), `without a scope: ${template}`);
  }
  assert.equal(injectSessionState('{input.topic} <input.topic from Planner>', {}), '{input.topic} <input.topic from Planner>', 'outside a workflow node both stay as written');
});

test('workflow placeholders: a non-object input fills nothing, an array input reads its own keys, as on ADK', async () => {
  for (const input of ['cats', 3, null, undefined, ['a', 'b'], { role: 'user', parts: [{ text: 'x' }] }]) {
    const scope = { input, outputsByNode: {} };
    const template = '{input.topic} {input.length} {input.role?} {input.parts}';
    assert.equal(injectSessionState(template, {}, scope), await adkInject(template, {}, scope), JSON.stringify(input));
  }
});

test('workflow placeholders scan in linear time (no backtracking pattern on the instruction)', () => {
  const scope = { input: { a: 1 }, outputsByNode: { N: { a: 1 } } };
  const hostile = [
    '<'.repeat(100_000),
    `<${' '.repeat(100_000)}`,
    `<a.b${' '.repeat(100_000)}fro`,
    `<a.b from${' '.repeat(100_000)}`,
    `<a.b from N${' '.repeat(100_000)}`,
    '<a.b from N'.repeat(20_000),
    `<${'a'.repeat(100_000)}`,
    '{'.repeat(100_000),
    '{a.'.repeat(50_000),
  ];
  for (const template of hostile) {
    const started = performance.now();
    injectSessionState(template, {}, scope);
    assert.ok(performance.now() - started < 1000, `${template.slice(0, 12)}… took ${performance.now() - started} ms`);
  }
});

test("predecessorOutputs is ADK's collectPredecessorOutputs: this invocation's stamped outputs by node name, the last winning", () => {
  const ev = (invocationId: string, path: string | undefined, output: unknown) => ({ ...createTurnEvent({ author: 'x', invocationId }), ...(path ? { nodeInfo: { path } } : {}), output });
  const events = [
    ev('e-1', 'Graph.Planner', { topic: 'a' }),
    ev('e-1', 'Graph.Each.Summ@0', 's0'),
    ev('e-1', 'Graph.Each.Summ@1', 's1'),
    ev('e-1', 'Graph.Each', ['s0', 's1']),
    ev('e-0', 'Graph.Old', 'earlier turn'),
    ev('e-1', undefined, 'no path'),
    ev('e-1', 'Graph.Planner', { topic: 'b' }),
    { ...createTurnEvent({ author: 'x', invocationId: 'e-1' }), nodeInfo: { path: 'Graph.Silent' } },
  ];
  assert.deepEqual(predecessorOutputs(events, 'e-1'), { Planner: { topic: 'b' }, Summ: 's1', Each: ['s0', 's1'] });
});

const PLACEHOLDER_CHAIN = workflowConfig(
  { edges: [['START', 'Planner', 'Writer', 'Editor']] },
  [
    agent('Writer', { instruction: 'Write on {input.topic} for {input.who?}; {input.missing} / {input.gone?} <input.topic from Planner> <x.y from Nope> {mood?}' }),
    agent('Editor', { instruction: 'Edit <input.topic from Planner> and <input.z from Writer> {input.topic}' }),
  ],
  agent('Planner', { outputSchema: { type: 'OBJECT', properties: { topic: { type: 'STRING' }, who: { type: 'STRING' } } } }),
);

test('a chain fills each node agent\'s placeholders from its input and the stored outputs, as on ADK', async () => {
  const scripts = { planner: () => answer('{"topic":"cats","who":"kids"}'), writer: () => answer('{"z":1}'), editor: () => answer('done') };
  const { native } = await bothAgree(PLACEHOLDER_CHAIN, scripts, 'go', { mood: 'calm' });
  const system = (key: string) => native.models[key]!.requests[0]!.system ?? '';
  assert.match(system('writer'), /Write on cats for kids; \{input\.missing\} \/  cats <x\.y from Nope> calm$/);
  assert.match(system('editor'), /Edit cats and <input\.z from Writer> \{input\.topic\}$/, "the Writer's text output is not an object: its fields stay as written");
});

test('a task-mode node fills its placeholders, and the node after it reads its finish_task output, as on ADK', async () => {
  const cfg = workflowConfig(
    { edges: [['START', 'Lead', 'Extractor', 'Booker']] },
    [
      agent('Extractor', { mode: 'task', instruction: 'Extract for {input.who?}.', outputSchema: { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] } }),
      agent('Booker', { instruction: 'Book {input.city} (<input.city from Extractor>).' }),
    ],
    agent('Lead', { outputSchema: { type: 'OBJECT', properties: { who: { type: 'STRING' } } } }),
  );
  const scripts = {
    lead: () => answer('{"who":"Ada"}'),
    extractor: (_r: unknown, n: number) => (n === 1 ? toolCall('finish_task', { city: 'Lyon' }, 'c1') : answer('never')),
    booker: (req: Parameters<typeof requestTexts>[0]) => answer(`booked ${requestTexts(req).at(-1)}`),
  };
  const { native } = await bothAgree(cfg, scripts as any, 'go');
  assert.match(native.models.booker!.requests[0]!.system ?? '', /Book Lyon \(Lyon\)\.$/);
});

// ── 2. The events of a join and a map ────────────────────────────────────────

type Req = Parameters<typeof requestTexts>[0];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lastText = (req: Req) => requestTexts(req).at(-1) ?? '';
/** A model that answers after `ms`; any two finish times in a case are at least 20 ms apart. */
const after = (ms: number, text: (req: Req) => string) => async (req: Req) => {
  await sleep(ms);
  return answer(text(req));
};

test("fan-out and join: the join stores its output event, before its successor's input, as on ADK", async () => {
  const cfg = workflowConfig(
    { edges: [['START', 'Triage', ['Writer', 'Checker']], [['Writer', 'Checker'], 'Both', 'Editor']], nodes: { Both: { join: true } } },
    [agent('Writer'), agent('Checker'), agent('Editor')],
  );
  const scripts = { triage: () => answer('t'), writer: after(80, () => 'w'), checker: after(20, () => 'c'), editor: (req: Req) => answer(`e ${lastText(req)}`) };
  const { native } = await bothAgree(cfg, scripts, 'go');
  const join = native.events.find((e) => e.author === 'Both')!;
  assert.deepEqual(join.output, { Writer: 'w', Checker: 'c' });
  assert.deepEqual(join.nodeInfo, { path: 'Graph.Both', outputFor: ['Graph.Both'] });
  assert.equal(join.content, undefined, 'a join stores no content');
  const order = native.events.map((e) => e.author);
  assert.equal(order.indexOf('Both') + 1, order.lastIndexOf('user'), "the join's event, then the Editor's input");
});

test('a join of branches a route step fanned out keys every predecessor, as on ADK', async () => {
  const cfg = workflowConfig(
    { edges: [['START', 'Triage', { both: ['A', 'B'], default: 'A' }], [['A', 'B'], 'J', 'Last']], nodes: { J: { join: true } } },
    [agent('A'), agent('B'), agent('Last')],
  );
  const scripts = { triage: () => answer('both'), a: after(20, () => 'a'), b: after(60, () => 'b'), last: (req: Req) => answer(`last ${lastText(req)}`) };
  const { native } = await bothAgree(cfg, scripts, 'go');
  assert.equal(native.output, 'last {"A":"a","B":"b"}');
});

const MAP = (maxParallel?: number, lister: Record<string, unknown> = { outputSchema: { type: 'ARRAY', items: { type: 'STRING' } } }) =>
  workflowConfig(
    { edges: [['START', 'Lister', 'Each', 'Merge']], nodes: { Each: { map: 'Summ', ...(maxParallel !== undefined ? { max_parallel: maxParallel } : {}) } } },
    [agent('Summ'), agent('Merge')],
    agent('Lister', lister),
  );
const DELAYS: Record<string, number> = { a: 100, b: 20, c: 60 };
const mapScripts = (list: string) => ({
  lister: () => answer(list),
  summ: async (req: Req) => {
    const item = lastText(req);
    await sleep(DELAYS[item] ?? 40);
    return answer(`s ${item}`);
  },
  merge: (req: Req) => answer(`m ${lastText(req)}`),
});

for (const maxParallel of [undefined, 2, 1]) {
  test(`a map stores its list as ADK's ParallelWorker does (max_parallel ${maxParallel ?? 'default'}): one part per item, the list as output`, async () => {
    const { native } = await bothAgree(MAP(maxParallel), mapScripts('["a","b","c"]'), 'go');
    const map = native.events.find((e) => e.author === 'Each')!;
    assert.deepEqual(map.output, ['s a', 's b', 's c'], 'by index, whatever order the items finished in');
    assert.deepEqual(map.content, { role: 'model', parts: [{ text: 's a' }, { text: 's b' }, { text: 's c' }] });
    assert.deepEqual(map.nodeInfo, { path: 'Graph.Each', outputFor: ['Graph.Each'] });
    assert.equal(native.events.filter((e) => e.author === 'Each').length, 1, 'no wrapper event per item');
  });
}

test("a map of an empty list, of a non-list input and of object items stores ADK's content for each", async () => {
  const empty = await bothAgree(MAP(), mapScripts('[]'), 'go');
  assert.deepEqual(empty.native.events.find((e) => e.author === 'Each')!.content, { role: 'model', parts: [{ text: '[]' }] }, 'an empty list is its JSON text');
  const single = await bothAgree(MAP(undefined, {}), mapScripts('a'), 'go');
  assert.deepEqual(single.native.events.find((e) => e.author === 'Each')!.output, ['s a'], 'a non-list input is one item');
  const objects = workflowConfig(
    { edges: [['START', 'Lister', 'Each', 'Merge']], nodes: { Each: { map: 'Summ' } } },
    [agent('Summ', { outputSchema: { type: 'OBJECT', properties: { item: { type: 'STRING' } } } }), agent('Merge')],
    agent('Lister'),
  );
  const scripts = { lister: () => answer('x'), summ: () => answer('{"item":"x"}'), merge: () => answer('done') };
  const { native } = await bothAgree(objects, scripts, 'go');
  assert.deepEqual(native.events.find((e) => e.author === 'Each')!.content, { role: 'model', parts: [{ text: '[{"item":"x"}]' }] }, "object items are the list's JSON text");
});

test("nodeOutputContent is ADK's toContent", async () => {
  const { toContent } = await import(pathToFileURL(path.join(ROOT, 'node_modules/@google/adk/dist/esm/workflow/base_node.js')).href);
  const values = ['x', ['a', 'b'], [], [1], ['a', { text: 'b' }], ['a', null], { text: 't', extra: 1 }, { k: 1 }, 3, true, { role: 'user', parts: [{ text: 'c' }] }, [{ functionCall: { name: 'f' } }], null, undefined];
  for (const value of values) assert.deepEqual(nodeOutputContent(value), toContent(value), JSON.stringify(value));
});

test('a map stopped from outside outputs nothing, so it stores no event, as ADK\'s ParallelWorker yields nothing', async () => {
  const cfg = MAP(1);
  const controller = new AbortController();
  const ends: unknown[] = [];
  await assert.rejects(
    runWorkflowGraph(buildWorkflowGraph(cfg), {
      input: 'go',
      signal: controller.signal,
      runNode: async (run) => {
        if (run.target.kind !== 'map_item') return { output: ['a', 'b', 'c'] };
        if (run.target.index === 0) setTimeout(() => controller.abort(), 20);
        await sleep(60);
        return { output: `s ${run.input}` };
      },
      onEvent: (e) => {
        if (e.type === 'node_end' && e.kind === 'map') ends.push(e.output);
      },
    }),
    /aborted/,
  );
  assert.deepEqual(ends, [undefined]);
  assert.equal(mapNodeEvent({ name: 'Each', path: 'Graph.Each', branch: undefined, invocationId: 'e-1', output: undefined }), undefined);
});

// ── 3. The order of stored events under concurrent fan-out ───────────────────

/** The stub delays of one profile, in ms: agent A's calls, the tool, A2, B, Lister, the items p and q. */
interface Profile {
  a: number;
  tool: number;
  a2: number;
  b: number;
  lister: number;
  p: number;
  q: number;
}

let toolDelay = 0;
registerTool(
  'parity_slow_lookup',
  defineTool({
    name: 'parity_slow_lookup',
    description: 'Look something up, slowly.',
    schema: z.object({ q: z.string().optional() }),
    execute: async ({ q }) => {
      await sleep(toolDelay);
      return `got ${q}`;
    },
  }),
  { override: true },
);

/**
 * Three branches at once off one node: an agent that calls a tool and then
 * routes to A2; a tool node feeding B; a Lister feeding a map of two items.
 * A join waits for all three. Every event lands at a time the profile sets.
 */
const FAN_OUT = workflowConfig(
  {
    edges: [
      ['START', 'Lead', ['A', 'Look', 'Lister']],
      ['A', { go: 'A2', default: 'A2' }],
      ['Look', 'B'],
      ['Lister', 'Each'],
      [['A2', 'B', 'Each'], 'J', 'Last'],
    ],
    nodes: { Look: { tool: 'parity_slow_lookup' }, Each: { map: 'Summ', max_parallel: 2 }, J: { join: true } },
  },
  [agent('A', { tools: ['parity_slow_lookup'] }), agent('A2'), agent('B'), agent('Lister', { outputSchema: { type: 'ARRAY', items: { type: 'STRING' } } }), agent('Summ'), agent('Last')],
  agent('Lead', { outputSchema: { type: 'OBJECT', properties: { q: { type: 'STRING' } } } }),
);

function fanOutScripts(d: Profile) {
  return {
    lead: () => answer('{"q":"x"}'),
    a: async (_req: Req, n: number) => {
      await sleep(d.a);
      return n === 1 ? toolCall('parity_slow_lookup', { q: 'a' }, 'call-a') : answer('go');
    },
    a2: after(d.a2, () => 'a2'),
    b: after(d.b, (req) => `b ${lastText(req)}`),
    lister: after(d.lister, () => '["p","q"]'),
    summ: async (req: Req) => {
      const item = lastText(req);
      await sleep(item === 'p' ? d.p : d.q);
      return answer(`s ${item}`);
    },
    last: () => answer('last'),
  };
}

/** Each event's finish time in a profile: no two closer than 20 ms, so the order is the timeline's on both runtimes. */
function timeline(d: Profile): number[] {
  const aCall = d.a;
  const aAnswer = aCall + d.tool + d.a;
  return [aCall, d.tool, aCall + d.tool, aAnswer, aAnswer + d.a2, d.tool + d.b, d.lister, d.lister + d.p, d.lister + d.q].sort((x, y) => x - y);
}

const PROFILES: Record<string, Profile> = {
  'the agent branch first': { a: 20, tool: 50, a2: 60, b: 80, lister: 110, p: 80, q: 140 },
  'the tool branch first, the map last': { a: 60, tool: 20, a2: 40, b: 20, lister: 100, p: 60, q: 120 },
  'the map first': { a: 80, tool: 100, a2: 20, b: 60, lister: 20, p: 40, q: 20 },
};

for (const [name, profile] of Object.entries(PROFILES)) {
  test(`concurrent fan-out stores its events in ADK's order: ${name}`, async () => {
    const times = timeline(profile);
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 20, `the profile keeps finish times 20 ms apart: ${times.join(', ')}`);
    toolDelay = profile.tool;
    const { native } = await bothAgree(FAN_OUT, fanOutScripts(profile), 'go');
    assert.equal(native.output, 'last');
    assert.equal(native.events.filter((e) => e.nodeInfo?.path === 'Graph.Each').length, 1);
  });
}

test('a node two branches trigger runs once per trigger, its events in ADK\'s order', async () => {
  const cfg = workflowConfig({ edges: [['START', 'A', ['B', 'C']], [['B', 'C'], 'D']] }, [agent('B'), agent('C'), agent('D')], agent('A'));
  const scripts = { a: () => answer('a'), b: after(60, () => 'b'), c: after(20, () => 'c'), d: (req: Req) => answer(`d ${lastText(req)}`) };
  const { native } = await bothAgree(cfg, scripts, 'go');
  assert.deepEqual(
    native.events.filter((e) => e.author === 'D').map((e) => e.output),
    ['d c', 'd b'],
  );
});

// ── 4. A node agent's compaction carries the node stamp ──────────────────────

/**
 * Compaction compares event times, and a scripted turn stores several events
 * in one millisecond; as in tests/compaction.test.ts, each reading of the
 * clock is a millisecond after the last while `fn` runs.
 */
async function withTickingClock<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  let last = 0;
  Date.now = () => (last = Math.max(realNow(), last + 1));
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Lead → Worker → Last, Worker compacting before its first step: Lead's answer reports a prompt past the threshold. */
function compactingChain(worker: Record<string, unknown>) {
  const cfg = workflowConfig({ edges: [['START', 'Lead', 'Worker', 'Last']] }, [agent('Worker', worker), agent('Last')], agent('Lead'));
  // The schema keeps `context:` to a delegate orchestrator; the runtimes compile it on any agent, so the case sets it after validation.
  (cfg.subagents as unknown as Array<Record<string, unknown>>)[0]!.context = { compact_after_tokens: 100, keep_recent_events: 1, summary_model: 'scripted/sum' };
  return cfg;
}

test("a node agent's compaction event carries the node's path, and outside task mode the summary as output, as on ADK", async () => {
  const scripts = {
    lead: () => answer('lead says hi', { inputTokens: 1000, outputTokens: 5 }),
    worker: (req: Req) => answer(`w ${lastText(req)}`),
    last: (req: Req) => answer(`l ${lastText(req)}`),
    sum: () => answer('SUMMARY'),
  };
  const { native } = await withTickingClock(() => bothAgree(compactingChain({}), scripts, 'go'));
  assert.equal(native.models.sum!.calls, 1, 'the Worker compacted once');
  const compacted = native.events.find((e) => (e as { isCompacted?: boolean }).isCompacted)!;
  assert.deepEqual(compacted.nodeInfo, { messageAsOutput: true, path: 'Graph.Worker', outputFor: ['Graph.Worker'] });
  assert.equal(compacted.output, 'SUMMARY', "ADK's maybeSetOutput reads the summary as the node's output until its answer replaces it");
  assert.equal(native.output, 'l w lead says hi');
});

test("a task-mode node's compaction event carries the node's path and no output, as on ADK", async () => {
  const worker = { mode: 'task', outputSchema: { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] } };
  const scripts = {
    lead: () => answer('Lyon, two nights', { inputTokens: 1000, outputTokens: 5 }),
    worker: () => toolCall('finish_task', { city: 'Lyon' }, 'c1'),
    last: (req: Req) => answer(`l ${lastText(req)}`),
    sum: () => answer('SUMMARY'),
  };
  const { native } = await withTickingClock(() => bothAgree(compactingChain(worker), scripts, 'go'));
  const compacted = native.events.find((e) => (e as { isCompacted?: boolean }).isCompacted)!;
  assert.deepEqual(compacted.nodeInfo, { path: 'Graph.Worker' });
  assert.equal(compacted.output, undefined);
  assert.equal(native.output, 'l {"city":"Lyon"}');
});

// ── With the pause (WS4-4a) ──────────────────────────────────────────────────

test('a join whose predecessor waits on a person does not start and stores no event; the walk ends paused, as on ADK', async () => {
  const cfg = workflowConfig(
    { edges: [['START', 'Triage', ['Confirm', 'Reader']], [['Confirm', 'Reader'], 'J', 'Last']], nodes: { Confirm: { ask_user: 'Publish?' }, J: { join: true } } },
    [agent('Reader'), agent('Last')],
  );
  const scripts = { triage: () => answer('the draft'), reader: after(20, (req) => `read ${lastText(req)}`), last: () => answer('never') };
  const { adk, native } = await bothAgree(cfg, scripts, 'go');
  assert.equal(adk.status, 'input-required');
  assert.equal(native.status, 'input-required');
  assert.equal(native.models.last!.calls, 0);
  assert.ok(!native.events.some((e) => e.author === 'J'), 'no join event');
  assert.ok(native.events.some((e) => e.author === 'Graph' && (e.longRunningToolIds?.length ?? 0) > 0), "the workflow's pause record");
});
