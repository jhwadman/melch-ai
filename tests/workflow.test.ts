/**
 * tests/workflow.test.ts — the `workflow:` block (lib/workflow.ts): chains,
 * routing by text and by a JSON key with a default, fan-out and join, a map
 * over a list, a tool node, the ask_user pause and its resume on the next
 * message, retries and a node that gives up, a turn the deadline stops,
 * what is refused before any model call, the schema's rules, and the
 * shipped example. Every turn-level case runs the engine's scheduler
 * (lib/workflow/turn.ts, ADR 0095). Scripted models, in-memory sessions,
 * no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { compileWorkflowSpec } from '../lib/compile.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { isWorkflowSyndicate, routeOf } from '../lib/workflow.ts';
import { buildWorkflowGraph } from '../lib/workflow/graph.ts';
import { SyndicateValidationError, validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import { UnsupportedOnRuntimeError } from '../lib/runtime/runtimeFlag.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedLlm, scriptedResolver, text } from './helpers/scriptedLlm.ts';
import { ScriptedModel, answer, shimResolver, streamedAnswer, untilAborted } from './helpers/scriptedModel.ts';

registerTool(
  'workflow_test_lookup',
  defineTool({
    name: 'workflow_test_lookup',
    description: 'Look something up.',
    schema: z.object({ q: z.string() }),
    execute: async ({ q }) => `found ${q}`,
  }),
  { override: true },
);

registerTool(
  'workflow_test_long',
  defineTool({ name: 'workflow_test_long', description: 'Starts something that finishes later.', schema: z.object({ q: z.string() }), longRunning: true, execute: async () => 'started' }),
  { override: true },
);

const lastText = (req: any) => (req.contents.at(-1)?.parts ?? []).map((p: any) => p.text ?? '').join('');
const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });

function config(workflow: Record<string, unknown>, subagents: Record<string, unknown>[], orchestrator: Record<string, unknown> = agent('Triage')): SyndicateYamlConfig {
  return validateSyndicateConfig({ syndicate_name: 'Graph', memory_system: 'internal-only', orchestrator, subagents, workflow }, 'test') as SyndicateYamlConfig;
}

function runner(cfg: SyndicateYamlConfig, models: Record<string, ScriptedLlm>, events: Record<string, unknown> = {}) {
  const sessionService = new InProcessSessionService();
  return (parts: any[]) =>
    runSyndicateTurn({ config: cfg, parts, appName: 'app', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: scriptedResolver(models) }, trace: false, events });
}

test('routeOf: a JSON key, else the trimmed text', () => {
  assert.equal(routeOf({ route: 'bug', x: 1 }), 'bug');
  assert.equal(routeOf({ kind: 'article' }, 'kind'), 'article');
  assert.equal(routeOf({ kind: 'article' }), '');
  assert.equal(routeOf('  question \n'), 'question');
  assert.equal(routeOf(true), 'true');
  assert.equal(routeOf(undefined), '');
});

test('a chain routes on an agent\'s text, with a default for what nothing matched', async () => {
  const cfg = config(
    { edges: [['START', 'Triage', { bug: 'Fixer', default: 'Other' }]] },
    [agent('Fixer'), agent('Other')],
  );
  let verdict = 'bug';
  const triage = new ScriptedLlm('scripted/triage', () => text(verdict));
  const fixer = new ScriptedLlm('scripted/fixer', (req) => text(`fixed ${lastText(req)}`));
  const other = new ScriptedLlm('scripted/other', (req) => text(`other ${lastText(req)}`));
  const progress: string[] = [];
  const turn = runner(cfg, { triage, fixer, other }, { onProgress: (t: string) => progress.push(t) });

  const r = await turn([{ text: 'it crashes' }]);
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'fixed bug');
  assert.equal(lastText(triage.requests[0]), 'it crashes', 'the first node gets the message');
  assert.equal(other.calls, 0);
  assert.ok(progress.includes('Running node: Triage') && progress.includes('Running node: Fixer'), progress.join(' | '));

  verdict = 'weird';
  const r2 = await runner(cfg, { triage, fixer, other })([{ text: 'hm' }]);
  assert.equal(r2.text, 'other weird');
});

test('a JSON output routes on route_key and reaches the next node as JSON', async () => {
  const cfg = config(
    { edges: [['START', 'Planner', { article: 'Writer', default: 'Answerer' }]], nodes: { Planner: { route_key: 'kind' } } },
    [agent('Writer'), agent('Answerer')],
    agent('Planner', { outputSchema: { type: 'OBJECT', properties: { kind: { type: 'STRING' }, brief: { type: 'STRING' } } } }),
  );
  const planner = new ScriptedLlm('scripted/planner', () => text('{"kind":"article","brief":"on cats"}'));
  const writer = new ScriptedLlm('scripted/writer', (req) => text(`wrote ${lastText(req)}`));
  const answerer = new ScriptedLlm('scripted/answerer', () => text('answered'));
  const r = await runner(cfg, { planner, writer, answerer })([{ text: 'write about cats' }]);
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'wrote {"kind":"article","brief":"on cats"}');
  assert.equal(answerer.calls, 0);
});

test('fan-out runs both, a join hands the next node every output by name', async () => {
  const cfg = config(
    { edges: [['START', 'Triage', ['Writer', 'Checker']], [['Writer', 'Checker'], 'Both', 'Editor']], nodes: { Both: { join: true } } },
    [agent('Writer'), agent('Checker'), agent('Editor')],
  );
  const triage = new ScriptedLlm('scripted/triage', () => text('brief'));
  const writer = new ScriptedLlm('scripted/writer', () => text('draft'));
  const checker = new ScriptedLlm('scripted/checker', () => text('claims'));
  const editor = new ScriptedLlm('scripted/editor', (req) => text(`edited ${lastText(req)}`));
  const r = await runner(cfg, { triage, writer, checker, editor })([{ text: 'go' }]);
  assert.equal(r.status, 'completed');
  assert.deepEqual(JSON.parse(r.text.replace(/^edited /, '')), { Writer: 'draft', Checker: 'claims' });
  assert.equal(editor.calls, 1, 'the join fires once');
});

test('a map node runs an agent per item under its YAML name and outputs the list', async () => {
  const cfg = config(
    { edges: [['START', 'Lister', 'Each', 'Merge']], nodes: { Each: { map: 'Summarizer', max_parallel: 2 } } },
    [agent('Summarizer'), agent('Merge')],
    agent('Lister', { outputSchema: { type: 'ARRAY', items: { type: 'STRING' } } }),
  );
  const lister = new ScriptedLlm('scripted/lister', () => text('["a","b","c"]'));
  const summarizer = new ScriptedLlm('scripted/summarizer', (req) => text(`s(${lastText(req)})`));
  const merge = new ScriptedLlm('scripted/merge', (req) => text(`merged ${lastText(req)}`));
  const seen: string[] = [];
  const r = await runner(cfg, { lister, summarizer, merge }, { onEvent: (e: any) => seen.push(e.author) })([{ text: 'go' }]);
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'merged ["s(a)","s(b)","s(c)"]');
  assert.equal(summarizer.calls, 3);
  assert.ok(seen.includes('Each'), `events name the map node: ${[...new Set(seen)].join(', ')}`);
});

test('a tool node runs a registry tool on the node input', async () => {
  const cfg = config({ edges: [['START', 'Triage', 'Lookup', 'Reader']], nodes: { Lookup: { tool: 'workflow_test_lookup' } } }, [agent('Reader')]);
  const triage = new ScriptedLlm('scripted/triage', () => text('{"q":"needle"}'));
  const reader = new ScriptedLlm('scripted/reader', (req) => text(`read ${lastText(req)}`));
  const r = await runner(cfg, { triage, reader })([{ text: 'go' }]);
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'read {"result":"found needle"}');
});

test('ask_user pauses the turn; the next message answers, and the next node gets reply and input', async () => {
  const cfg = config(
    { edges: [['START', 'Triage', 'Confirm', 'Publisher']], nodes: { Confirm: { ask_user: 'Publish?' } } },
    [agent('Publisher')],
  );
  const triage = new ScriptedLlm('scripted/triage', () => text('the draft'));
  const publisher = new ScriptedLlm('scripted/publisher', (req) => text(`published ${lastText(req)}`));
  const turn = runner(cfg, { triage, publisher });

  const first = await turn([{ text: 'go' }]);
  assert.equal(first.status, 'input-required');
  assert.equal(first.input?.node, 'Confirm');
  assert.equal(first.input?.message, 'Publish?');
  assert.equal(first.input?.payload, 'the draft');
  assert.ok(first.input?.id);
  assert.equal(first.text, 'Publish?');
  assert.equal(publisher.calls, 0);

  const second = await turn([{ text: 'yes' }]);
  assert.equal(second.status, 'completed');
  assert.deepEqual(JSON.parse(second.text.replace(/^published /, '')), { reply: 'yes', input: 'the draft' });
  assert.equal(triage.calls, 1, 'the graph resumed where it waited');

  // A later message starts the graph again.
  const third = await turn([{ text: 'again' }]);
  assert.equal(third.status, 'input-required');
  assert.equal(triage.calls, 2);
});

test('a node with retry recovers from a model error; the attempt is recorded, not fatal', async () => {
  const cfg = config({ edges: [['START', 'Triage', 'Fixer']], nodes: { Fixer: { retry: { max_attempts: 3, initial_delay: 0.01, max_delay: 0.02 } } } }, [agent('Fixer')]);
  const triage = new ScriptedLlm('scripted/triage', () => text('bug'));
  let attempts = 0;
  const fixer = new ScriptedLlm('scripted/fixer', () => (++attempts === 1 ? ({ errorCode: '503', errorMessage: 'overloaded' } as any) : text('fixed')));
  const r = await runner(cfg, { triage, fixer })([{ text: 'go' }]);
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'fixed');
  assert.equal(attempts, 2);
  assert.deepEqual(r.answer?.nodeErrors.map((e) => [e.node, e.code]), [['Fixer', '503']]);
});

test('a node that gives up fails the turn and names itself', async () => {
  const cfg = config({ edges: [['START', 'Triage', 'Fixer']], nodes: { Fixer: { retry: { max_attempts: 1 } } } }, [agent('Fixer')]);
  const triage = new ScriptedLlm('scripted/triage', () => text('bug'));
  const fixer = new ScriptedLlm('scripted/fixer', () => ({ errorCode: '500', errorMessage: 'down' }) as any);
  const r = await runner(cfg, { triage, fixer })([{ text: 'go' }]);
  assert.equal(r.status, 'failed');
  assert.equal(r.failedStage, 'workflow');
  assert.ok(r.error?.code === 'NODE_FAILED' || r.error?.code === '500', `${r.error?.code}: ${r.error?.message}`);
  assert.match(`${r.error?.message}`, /Fixer|down/);
});

test('streaming: a node agent\'s text reaches onTextDelta as it is written', async () => {
  const cfg = config({ edges: [['START', 'Triage', 'Fixer']] }, [agent('Fixer')]);
  const models = { triage: new ScriptedModel('scripted/triage', () => answer('bug')), fixer: new ScriptedModel('scripted/fixer', () => streamedAnswer('fi', 'xed')) };
  const deltas: string[] = [];
  const r = await runSyndicateTurn({ streaming: true, config: cfg, parts: [{ text: 'go' }], appName: 'app', userId: 'u', sessionId: 's', sessionService: new InProcessSessionService(), compile: { resolveModel: shimResolver(models), log: () => {} }, trace: false, events: { onTextDelta: (d: string) => deltas.push(d) } });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'fixed');
  assert.deepEqual(deltas, ['fi', 'xed']);
});

test('a deadline stops the walk: the turn fails with the stop reason, and no later node runs', async () => {
  const cfg = config({ edges: [['START', 'Triage', 'Fixer', 'Other']] }, [agent('Fixer'), agent('Other')]);
  const models = {
    triage: new ScriptedModel('scripted/triage', () => answer('bug')),
    fixer: new ScriptedModel('scripted/fixer', (_r, _n, signal) => untilAborted(signal)),
    other: new ScriptedModel('scripted/other', () => answer('never')),
  };
  const r = await runSyndicateTurn({ config: cfg, parts: [{ text: 'go' }], appName: 'app', userId: 'u', sessionId: 's', sessionService: new InProcessSessionService(), compile: { resolveModel: shimResolver(models), log: () => {} }, trace: false, deadlineMs: 150 });
  assert.equal(r.status, 'failed');
  assert.equal(r.stopReason, 'deadline');
  assert.equal(r.error?.code, 'DEADLINE_EXCEEDED');
  assert.equal(models.fixer.calls, 1);
  assert.equal(models.other.calls, 0);
});

test('a long-running tool node is refused before any model call, with ADK\'s message', async () => {
  const cfg = config({ edges: [['START', 'Triage', 'Wait', 'Reader']], nodes: { Wait: { tool: 'workflow_test_long' } } }, [agent('Reader')]);
  const triage = new ScriptedLlm('scripted/triage', () => text('{"q":"x"}'));
  const reader = new ScriptedLlm('scripted/reader', () => text('read'));
  await assert.rejects(runner(cfg, { triage, reader })([{ text: 'go' }]), /ToolNode does not support long-running tools yet \(tool 'workflow_test_long'\)/);
  assert.equal(triage.calls + reader.calls, 0);
});

test('native: an ask_user tool on a workflow node is refused by name before any model call (a config the schema did not check)', async () => {
  // validateSyndicateConfig refuses it; a caller that hands in an unchecked config is refused here.
  const cfg = { ...config({ edges: [['START', 'Triage', 'Fixer']] }, [agent('Fixer')]), subagents: [agent('Fixer', { tools: ['ask_user'] })] } as SyndicateYamlConfig;
  const triage = new ScriptedLlm('scripted/triage', () => text('bug'));
  await assert.rejects(
    runSyndicateTurn({ config: cfg, parts: [{ text: 'go' }], appName: 'app', userId: 'u', sessionId: 's', sessionService: new InProcessSessionService(), compile: { resolveModel: scriptedResolver({ triage }) }, trace: false }),
    (e: unknown) => e instanceof UnsupportedOnRuntimeError && /an ask_user tool on a workflow node \(Fixer; use an ask_user node\)/.test(e.message),
  );
  assert.equal(triage.calls, 0);
});

test('native: a pause raised inside an agent node fails the resume by name; the walk does not start afresh', async () => {
  const cfg = config({ edges: [['START', 'Triage', 'Fixer']] }, [agent('Fixer')]);
  const sessionService = new InProcessSessionService();
  const session = await sessionService.create({ appName: 'app', userId: 'u', sessionId: 's' });
  // As ADK 2.2 stored an OAuth consent raised inside the Triage node, then the workflow's own pause record.
  const stored = [
    createTurnEvent({ invocationId: 'e-1', author: 'user', content: { role: 'user', parts: [{ text: 'go' }] } }),
    { ...createTurnEvent({ invocationId: 'e-1', author: 'Triage', content: { role: 'model', parts: [{ functionCall: { name: 'adk_request_credential', id: 'q', args: {} } }] } }), longRunningToolIds: ['q'], nodeInfo: { path: 'Graph.Triage' } },
    { ...createTurnEvent({ invocationId: 'e-1', author: 'Graph' }), longRunningToolIds: ['q'], nodeInfo: { path: 'Graph' } },
  ];
  for (const event of stored) await sessionService.append(session, event as any);
  const triage = new ScriptedLlm('scripted/triage', () => text('bug'));
  const fixer = new ScriptedLlm('scripted/fixer', () => text('fixed'));
  const r = await runSyndicateTurn({ config: cfg, parts: [{ text: 'granted' }], appName: 'app', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: scriptedResolver({ triage, fixer }) }, trace: false });
  assert.equal(r.status, 'failed');
  assert.equal(r.failedStage, 'workflow');
  assert.equal(r.error?.code, 'RESUME_UNSUPPORTED');
  assert.match(r.error?.message ?? '', /'Graph\.Triage' was raised inside an agent node/);
  assert.equal(triage.calls + fixer.calls, 0, 'nothing ran: the person is not asked again');
  const after = await sessionService.get({ appName: 'app', userId: 'u', sessionId: 's' });
  assert.equal(after!.events.length, stored.length + 1, 'only the message is stored, before the walk');
});

test('schema: the rules a graph must keep', () => {
  const base = (workflow: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    syndicate_name: 'S',
    orchestrator: { name: 'Lead', model: 'gemini-3.5-flash-lite', instruction: 'x' },
    subagents: [{ name: 'Sub', description: 'd', model: 'gemini-3.5-flash-lite', instruction: 'y' }],
    workflow,
    ...extra,
  });
  const problems = (raw: Record<string, unknown>): string => {
    try {
      validateSyndicateConfig(raw, 't');
      return '';
    } catch (e) {
      assert.ok(e instanceof SyndicateValidationError);
      return e.message;
    }
  };
  assert.equal(problems(base({ edges: [['START', 'Lead', 'Sub']] })), '');
  assert.match(problems(base({ edges: [['START', 'Lead']] }, { dispatch: { default_route: 'Sub' } })), /not both/);
  assert.match(problems(base({ edges: [['START', 'Lead', 'Sbu']] })), /'Sbu' is not an agent or a declared node \(did you mean "Sub"\?\)/);
  assert.match(problems(base({ edges: [['Lead', 'START']] })), /START opens a chain/);
  assert.match(problems(base({ edges: [['Lead', 'Sub']] })), /no chain begins with START/);
  assert.match(problems(base({ edges: [['START', { a: 'Sub' }]] })), /routing map follows the name/);
  assert.match(problems(base({ edges: [['START', 'Lead', { a: 'Sub' }, 'Sub']] })), /ends its chain/);
  assert.match(problems(base({ edges: [['START', 'Lead', 'Ask', { a: 'Sub' }]], nodes: { Ask: { ask_user: 'q' } } })), /only an agent or a tool node emits a route/);
  assert.match(problems(base({ edges: [['START', 'Lead', 'X']], nodes: { X: { join: true, ask_user: 'q' } } })), /exactly one of/);
  assert.match(problems(base({ edges: [['START', 'Lead', 'X']], nodes: { X: {} } })), /exactly one of/);
  assert.match(problems(base({ edges: [['START', 'Lead']], nodes: { Lead: { join: true } } })), /is an agent; its node entry/);
  assert.match(problems(base({ edges: [['START', 'Lead', 'Each', 'Sub']], nodes: { Each: { map: 'Sub' } } })), /run by a map node/);
  assert.match(problems(base({ edges: [['START', 'Lead', 'Each']], nodes: { Each: { map: 'Nope' } } })), /'Nope' is not an agent/);
  assert.match(problems(base({ edges: [['START', 'Lead']], nodes: { X: { join: true } } })), /declared but used in no edge/);
  assert.match(problems(base({ edges: [['START', 'Lead', 'X']], nodes: { X: { tool: 't', schema: {} } } })), /schema applies to ask_user/);
  assert.match(problems(base({ edges: [['START', 'Lead']], nodes: { 'Lead__route': { join: true } } })), /reserved/);
  // A map item runs under its agent's own modifiers (ADR 0089, ADR 0103): the map entry's are refused, with where they belong.
  assert.match(
    problems(base({ edges: [['START', 'Lead', 'Each']], nodes: { Each: { map: 'Sub', retry: { max_attempts: 2 } } } })),
    /workflow\.nodes\.Each\.retry — retry on a map node is not applied: each item runs under its agent's own retry; set it on nodes\.Sub/,
  );
  assert.match(
    problems(base({ edges: [['START', 'Lead', 'Each']], nodes: { Each: { map: 'Sub', timeout: 30 } } })),
    /workflow\.nodes\.Each\.timeout — timeout on a map node is not applied: each item runs under its agent's own timeout; set it on nodes\.Sub/,
  );
  assert.equal(problems(base({ edges: [['START', 'Lead', 'Each']], nodes: { Each: { map: 'Sub' }, Sub: { retry: { max_attempts: 2 }, timeout: 30 } } })), '');
  // An approval gate pauses its agent node (ADR 0098), but not an item of a map.
  assert.equal(problems(base({ edges: [['START', 'Lead', 'Sub']] }, { orchestrator: { name: 'Lead', model: 'gemini-3.5-flash-lite', instruction: 'x', tools: ['web_extract'], require_approval: ['web_extract'] } })), '');
  assert.match(
    problems(base({ edges: [['START', 'Lead', 'Each']], nodes: { Each: { map: 'Sub' } } }, { subagents: [{ name: 'Sub', description: 'd', model: 'gemini-3.5-flash-lite', instruction: 'y', tools: ['web_extract'], require_approval: ['web_extract'] }] })),
    /subagents\[0\]\.require_approval — approval gates are not supported on an agent a map node runs: a map item cannot pause the walk/,
  );
  assert.match(
    problems(base({ edges: [['START', 'Lead', 'Sub']] }, { subagents: [{ name: 'Sub', description: 'd', a2a_agent_url: 'https://x.test' }] })),
    /remote agent cannot be a workflow node yet/,
  );
});

test('the shipped example is a graph: its spec and graph hold every node under its YAML name', async () => {
  const cfg = loadSyndicate('examples/pipeline.yaml');
  assert.ok(isWorkflowSyndicate(cfg));
  const spec = await compileWorkflowSpec(cfg);
  assert.equal(spec.name, 'Editorial Pipeline');
  assert.deepEqual(spec.agents.map((a) => a.yaml.name).sort(), ['Answerer', 'Checker', 'Editor', 'Planner', 'Publisher', 'Writer']);
  const graph = buildWorkflowGraph(cfg);
  assert.deepEqual([...graph.nodes.keys()].filter((n) => n !== '__START__' && !n.endsWith('__route')).sort(), ['Answerer', 'Both', 'Checker', 'Confirm', 'Editor', 'Planner', 'Publisher', 'Writer']);
  assert.equal((graph.nodes.get('Editor') as { settings?: { retry?: { max_attempts?: number } } }).settings?.retry?.max_attempts, 2, 'node modifiers reach the node');
  assert.equal(isWorkflowSyndicate(loadSyndicate('examples/council.yaml')), false);
});
