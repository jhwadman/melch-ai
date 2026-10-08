/**
 * tests/workflowGraph.test.ts — the engine-owned workflow graph
 * (lib/workflow/graph.ts) against today's ADK compile (lib/workflow.ts).
 *
 * Every workflow fixture of the suite (tests/workflow.test.ts and every
 * shipped syndicate with a `workflow:` block), plus a few shapes those do
 * not cover, builds the same node set (names, order) and edge set (from,
 * to, route, order) as the `Workflow` graph `compileWorkflow` hands ADK.
 * Every validation error today's path raises — the schema's rules
 * (validateSyndicateConfig) and ADK's graph rules (compileWorkflow) — is
 * raised by the graph builder with the same message. And the module
 * imports no ADK value. No models run, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROUTE, FunctionTool, setLogLevel, LogLevel } from '@google/adk';
import { z } from 'zod';

import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { compileWorkflow, isWorkflowSyndicate } from '../lib/workflow.ts';
import { SyndicateValidationError, validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { WorkflowGraphError, buildWorkflowGraph } from '../lib/workflow/graph.ts';
import type { EdgeRoute, WorkflowGraph } from '../lib/workflow/graph.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';

setLogLevel(LogLevel.ERROR);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

registerTool(
  'workflow_test_lookup',
  new FunctionTool({
    name: 'workflow_test_lookup',
    description: 'Look something up.',
    parameters: z.object({ q: z.string() }),
    execute: async ({ q }) => `found ${q}`,
  }),
  { override: true },
);

const MODEL = 'gemini-3.5-flash-lite';
const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: MODEL, instruction: `${name}.`, ...extra });
const raw = (workflow: Record<string, unknown>, subagents: Record<string, unknown>[], orchestrator: Record<string, unknown> = agent('Triage'), extra: Record<string, unknown> = {}) => ({
  syndicate_name: 'Graph',
  memory_system: 'internal-only',
  orchestrator,
  subagents,
  workflow,
  ...extra,
});
const valid = (r: Record<string, unknown>) => validateSyndicateConfig(structuredClone(r), 'test') as SyndicateYamlConfig;

/** A graph as comparable rows: node names in order, edges as `from -> to [route]`. */
type Shape = { nodes: string[]; edges: string[] };
const showRoute = (route: EdgeRoute) => (route.kind === 'always' ? '' : route.kind === 'default' ? ' [default]' : ` [${route.key}]`);
const graphShape = (g: WorkflowGraph): Shape => ({
  nodes: [...g.nodes.keys()],
  edges: g.edges.map((e) => `${e.from} -> ${e.to}${showRoute(e.route)}`),
});
/** What today's compile builds: ADK's own Graph inside the Workflow. */
async function adkShape(cfg: SyndicateYamlConfig): Promise<Shape> {
  const { workflow } = await compileWorkflow(cfg);
  const graph = (workflow as any).graph;
  return {
    nodes: graph.nodes.map((n: any) => n.name),
    edges: graph.edges.map((e: any) => {
      const r = e.route;
      const route = r === null || r === undefined ? '' : r === DEFAULT_ROUTE ? ' [default]' : ` [${String(r)}]`;
      return `${e.fromNode.name} -> ${e.toNode.name}${route}`;
    }),
  };
}

// Every workflow block in tests/workflow.test.ts, by the test it comes from,
// then shapes that suite does not exercise.
const FIXTURES: Array<[string, Record<string, unknown>]> = [
  ['route on text with a default', raw({ edges: [['START', 'Triage', { bug: 'Fixer', default: 'Other' }]] }, [agent('Fixer'), agent('Other')])],
  [
    'route on a JSON key',
    raw(
      { edges: [['START', 'Planner', { article: 'Writer', default: 'Answerer' }]], nodes: { Planner: { route_key: 'kind' } } },
      [agent('Writer'), agent('Answerer')],
      agent('Planner'),
    ),
  ],
  [
    'fan-out and join',
    raw({ edges: [['START', 'Triage', ['Writer', 'Checker']], [['Writer', 'Checker'], 'Both', 'Editor']], nodes: { Both: { join: true } } }, [agent('Writer'), agent('Checker'), agent('Editor')]),
  ],
  ['map over a list', raw({ edges: [['START', 'Lister', 'Each', 'Merge']], nodes: { Each: { map: 'Summarizer', max_parallel: 2 } } }, [agent('Summarizer'), agent('Merge')], agent('Lister'))],
  ['tool node', raw({ edges: [['START', 'Triage', 'Lookup', 'Reader']], nodes: { Lookup: { tool: 'workflow_test_lookup' } } }, [agent('Reader')])],
  ['ask_user pause', raw({ edges: [['START', 'Triage', 'Confirm', 'Publisher']], nodes: { Confirm: { ask_user: 'Publish?' } } }, [agent('Publisher')])],
  ['retry on a node', raw({ edges: [['START', 'Triage', 'Fixer']], nodes: { Fixer: { retry: { max_attempts: 3, initial_delay: 0.01, max_delay: 0.02 } } } }, [agent('Fixer')])],
  ['a node that gives up', raw({ edges: [['START', 'Triage', 'Fixer']], nodes: { Fixer: { retry: { max_attempts: 1 } } } }, [agent('Fixer')])],
  ['schema base',raw({ edges: [['START', 'Lead', 'Sub']] }, [agent('Sub')], agent('Lead'))],
  [
    'a tool node routes; integer and boolean keys; fan-out on a route',
    raw(
      { edges: [['START', 'Triage', 'Lookup', { '1': ['Fixer', 'Other'], true: 'Reader' }]], nodes: { Lookup: { tool: 'workflow_test_lookup', route_key: 'r' } }, max_concurrency: 2 },
      [agent('Fixer'), agent('Other'), agent('Reader')],
    ),
  ],
  [
    'fan-in to fan-out, a routed loop back',
    raw({ edges: [['START', ['Triage', 'Other'], ['Fixer', 'Reader']], ['Reader', { again: 'Triage', default: 'Done' }]] }, [agent('Other'), agent('Fixer'), agent('Reader'), agent('Done')]),
  ],
];

/** Every shipped syndicate with a `workflow:` block. */
function shippedWorkflows(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(entry.name) && /^workflow:/m.test(fs.readFileSync(p, 'utf8'))) out.push(path.relative(path.join(ROOT, 'config/agents'), p));
    }
  };
  walk(path.join(ROOT, 'config/agents'));
  return out.filter((f) => f !== 'syndicateSchema.yaml');
}

for (const [name, r] of FIXTURES) {
  test(`same graph as the ADK compile: ${name}`, async () => {
    const cfg = valid(r);
    assert.deepEqual(graphShape(buildWorkflowGraph(cfg)), await adkShape(cfg));
  });
}

test('same graph as the ADK compile: every shipped workflow syndicate', async () => {
  const files = shippedWorkflows();
  assert.ok(files.includes('examples/pipeline.yaml'), files.join(', '));
  for (const file of files) {
    const cfg = loadSyndicate(file);
    assert.ok(isWorkflowSyndicate(cfg), file);
    assert.deepEqual(graphShape(buildWorkflowGraph(cfg)), await adkShape(cfg), file);
  }
});

test('the pipeline example as a model: node kinds, settings, routes, terminals', () => {
  const g = buildWorkflowGraph(loadSyndicate('examples/pipeline.yaml'));
  assert.equal(g.name, 'Editorial Pipeline');
  assert.deepEqual(
    [...g.nodes.values()].map((n) => `${n.name}:${n.kind}`),
    ['__START__:start', 'Planner:agent', 'Planner__route:route', 'Writer:agent', 'Checker:agent', 'Answerer:agent', 'Both:join', 'Editor:agent', 'Confirm:ask_user', 'Publisher:agent'],
  );
  assert.deepEqual(g.nodes.get('Planner__route'), { kind: 'route', name: 'Planner__route', source: 'Planner', routeKey: 'kind' });
  assert.deepEqual(g.nodes.get('Editor'), { kind: 'agent', name: 'Editor', settings: { retry: { max_attempts: 2, initial_delay: 1 } } });
  assert.equal((g.nodes.get('Confirm') as any).message, 'Publish this draft? Reply yes, or say what to change.');
  assert.deepEqual(
    g.edges.filter((e) => e.from === 'Planner__route').map((e) => [e.to, e.route]),
    [
      ['Writer', { kind: 'key', key: 'article' }],
      ['Checker', { kind: 'key', key: 'article' }],
      ['Answerer', { kind: 'default' }],
    ],
  );
  assert.deepEqual(g.terminals, ['Answerer', 'Publisher']);
  assert.deepEqual(g.agents, ['Planner', 'Writer', 'Checker', 'Editor', 'Publisher', 'Answerer']);
  assert.equal(g.maxConcurrency, undefined);
});

test('a map node names its agent, which is not a graph node; max_concurrency carries over', () => {
  const g = buildWorkflowGraph(valid(raw({ edges: [['START', 'Lister', 'Each', 'Merge']], nodes: { Each: { map: 'Summarizer', max_parallel: 2 } }, max_concurrency: 3 }, [agent('Summarizer'), agent('Merge')], agent('Lister'))));
  assert.deepEqual(g.nodes.get('Each'), { kind: 'map', name: 'Each', agent: 'Summarizer', maxParallel: 2, settings: {}, agentSettings: {} });
  assert.equal(g.nodes.has('Summarizer'), false);
  assert.ok(g.agents.includes('Summarizer'));
  assert.equal(g.maxConcurrency, 3);
});

test('routing-map keys stay verbatim in the model', () => {
  const g = buildWorkflowGraph(valid(raw({ edges: [['START', 'Triage', { '01': 'Fixer', default: 'Other' }]] }, [agent('Fixer'), agent('Other')])));
  assert.deepEqual(g.edges.find((e) => e.to === 'Fixer')?.route, { kind: 'key', key: '01' });
});

// ── Validation: the schema's rules ───────────────────────────────────────────

const base = (workflow: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  syndicate_name: 'S',
  orchestrator: { name: 'Lead', model: MODEL, instruction: 'x' },
  subagents: [{ name: 'Sub', description: 'd', model: MODEL, instruction: 'y' }],
  workflow,
  ...extra,
});

// Every case of the schema test in tests/workflow.test.ts, plus the rules it
// does not reach.
const SCHEMA_CASES: Array<Record<string, unknown>> = [
  base({ edges: [['START', 'Lead']] }, { dispatch: { default_route: 'Sub' } }),
  base({ edges: [['START', 'Lead', 'Sbu']] }),
  base({ edges: [['Lead', 'START']] }),
  base({ edges: [['Lead', 'Sub']] }),
  base({ edges: [['START', { a: 'Sub' }]] }),
  base({ edges: [['START', 'Lead', { a: 'Sub' }, 'Sub']] }),
  base({ edges: [['START', 'Lead', 'Ask', { a: 'Sub' }]], nodes: { Ask: { ask_user: 'q' } } }),
  base({ edges: [['START', 'Lead', 'X']], nodes: { X: { join: true, ask_user: 'q' } } }),
  base({ edges: [['START', 'Lead', 'X']], nodes: { X: {} } }),
  base({ edges: [['START', 'Lead']], nodes: { Lead: { join: true } } }),
  base({ edges: [['START', 'Lead', 'Each', 'Sub']], nodes: { Each: { map: 'Sub' } } }),
  base({ edges: [['START', 'Lead', 'Each']], nodes: { Each: { map: 'Nope' } } }),
  base({ edges: [['START', 'Lead']], nodes: { X: { join: true } } }),
  base({ edges: [['START', 'Lead', 'X']], nodes: { X: { tool: 't', schema: {} } } }),
  base({ edges: [['START', 'Lead']], nodes: { Lead__route: { join: true } } }),
  base({ edges: [['START', 'Lead', 'Each']], nodes: { Each: { map: 'Sub' } } }, { subagents: [{ name: 'Sub', description: 'd', model: MODEL, instruction: 'y', tools: ['web_extract'], require_approval: ['web_extract'] }] }),
  base({ edges: [['START', 'Lead', 'Sub']] }, { subagents: [{ name: 'Sub', description: 'd', a2a_agent_url: 'https://x.test' }] }),
  // Not reached by the schema test.
  base({ edges: [['START', 'Lead', 'Sub']] }, { subagents: [{ name: 'Sub__route', description: 'd', model: MODEL, instruction: 'y' }] }),
  base({ edges: [['START', 'Lead', 'X']], nodes: { X: { join: true, max_parallel: 2 }, START: { join: true } } }),
  base({ edges: [['START', 'Lead', 'Sub']] }, { orchestrator: { name: 'Lead', model: MODEL, instruction: 'x', skills: { scripts: 'local' } } }),
  base({ edges: [['START', 'Lead', 'Sbu', { a: 'Lead' }, 'START'], ['Sub', 'Lead']] }, { dispatch: { default_route: 'Sub' } }),
];

const schemaIssues = (r: Record<string, unknown>): string[] => {
  try {
    validateSyndicateConfig(structuredClone(r), 't');
    return [];
  } catch (e) {
    assert.ok(e instanceof SyndicateValidationError);
    return e.issues;
  }
};
const graphIssues = (r: Record<string, unknown>): string[] => {
  try {
    buildWorkflowGraph(structuredClone(r) as unknown as SyndicateYamlConfig);
    return [];
  } catch (e) {
    assert.ok(e instanceof WorkflowGraphError, String(e));
    return e.problems;
  }
};

/**
 * A schema line from the workflow block's rules. The schema also checks the
 * agents themselves (their tools, skills, dispatch routes); the graph owns
 * only the block's rules.
 */
const isWorkflowRule = (line: string) =>
  line.startsWith('workflow') ||
  line.endsWith(' — approval gates are not supported on an agent a map node runs: a map item cannot pause the walk') ||
  line.endsWith(' — skill scripts (an approval pause) are not supported inside a workflow yet') ||
  line.endsWith(' — a remote agent cannot be a workflow node yet');

test('validation: every rule the schema enforces on a workflow block, with the same path, message and order', () => {
  SCHEMA_CASES.forEach((r, i) => {
    const expected = schemaIssues(r).filter(isWorkflowRule);
    assert.ok(expected.length > 0, `case ${i} breaks a workflow rule under the schema: ${schemaIssues(r).join(' | ')}`);
    assert.deepEqual(graphIssues(r), expected, `case ${i}`);
  });
  // The thrown message reads as the schema's does, without the file.
  const r = base({ edges: [['START', 'Lead', 'Sbu']] });
  assert.throws(() => buildWorkflowGraph(r as unknown as SyndicateYamlConfig), { message: `workflow.edges[0][2] — 'Sbu' is not an agent or a declared node (did you mean "Sub"?)` });
});

test('validation: no workflow block, with compileWorkflow\'s message', async () => {
  const cfg = valid({ syndicate_name: 'Plain', orchestrator: { name: 'Lead', model: MODEL, instruction: 'x' } });
  await assert.rejects(compileWorkflow(cfg), { message: 'Plain: no workflow block' });
  assert.throws(() => buildWorkflowGraph(cfg), { message: 'Plain: no workflow block' });
});

// ── Validation: ADK's graph rules ────────────────────────────────────────────

const GRAPH_CASES: Array<[string, Record<string, unknown>]> = [
  ['unreachable from START', base({ edges: [['START', 'Lead'], ['Sub', 'Lead']] })],
  ['an unconditional cycle', base({ edges: [['START', 'Lead', 'Sub', 'Lead']] })],
  ['a duplicate unconditional edge', base({ edges: [['START', 'Lead', 'Sub'], ['Lead', 'Sub']] })],
  ['a duplicate routed edge through key normalization', base({ edges: [['START', 'Lead', { '1': 'Sub', '01': 'Sub' }]] })],
  ['a default to two nodes', raw({ edges: [['START', 'Triage', { default: ['Fixer', 'Other'] }]] }, [agent('Fixer'), agent('Other')])],
  ['two defaults from two chains', raw({ edges: [['START', 'Triage', { a: 'Fixer', default: 'Other' }], ['Triage', { default: 'Fixer' }]] }, [agent('Fixer'), agent('Other')])],
  // The route step is shared, so the second map repeats the node's edge to it.
  ['one node routed by two chains', raw({ edges: [['START', 'Triage', { a: 'Fixer' }], ['Triage', { b: 'Other', default: 'Fixer' }]] }, [agent('Fixer'), agent('Other')])],
  ['an empty routing map',base({ edges: [['START', 'Lead', {}], ['Lead', 'Sub']] })],
];

for (const [name, r] of GRAPH_CASES) {
  test(`validation: ${name}, with the ADK compile's message`, async () => {
    const cfg = valid(r);
    let expected = '';
    await compileWorkflow(cfg).then(
      () => assert.fail('the ADK compile accepts it'),
      (e: Error) => {
        expected = e.message;
      },
    );
    assert.match(expected, /Graph validation failed|Routing map must not be empty/);
    assert.throws(() => buildWorkflowGraph(cfg), (e: unknown) => e instanceof WorkflowGraphError && e.message === expected && e.problems[0] === expected);
  });
}

// ── No ADK ───────────────────────────────────────────────────────────────────

test('lib/workflow/graph.ts reaches ADK through no value import', () => {
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
  visit(path.join(ROOT, 'lib/workflow/graph.ts'));
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'lib/workflow/graph.ts'), 'utf8'), /@google\/adk/);
});
