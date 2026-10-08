/**
 * tests/workflowAgentNode.test.ts — an agent as a workflow node on the
 * native runtime (lib/workflow/agentNode.ts) and route derivation
 * (lib/workflow/route.ts), against ADK's Workflow on ADR 0030's routing
 * cases (ADR 0090).
 *
 * Each case runs one workflow syndicate with the same scripted models on
 * the engine's contract, through the shared harness
 * (tests/helpers/workflowParity.ts): on ADK (runSyndicateTurn, runtime
 * adk), on the native modules driven by hand (the scheduler with
 * agentNodeRuntime as its runNode and onEvent), and through the native
 * turn (runSyndicateTurn, runtime native, lib/workflow/turn.ts). Each native
 * side must store the same events as ADK's (ids and times aside), send
 * every model the same requests, take the same routes, end on the same
 * output, and publish the same progress lines, which name declared nodes
 * only. No network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnEvent } from '../lib/runtime/events.ts';
import type { TurnContent } from '../lib/runtime/events.ts';
import type { NativeAgent } from '../lib/runtime/native/request.ts';
import { NodeReportedError, asNodeAgent, eventOutput, nodeInputContent } from '../lib/workflow/agentNode.ts';
import { routeOf, routeStepEvent } from '../lib/workflow/route.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { z } from 'zod';
import { routeOf as configRouteOf } from '../lib/workflowConfig.ts';
import { answer, failure, requestTexts, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { agent, adkSide, bothAgree, comparable, onNative, onNativeTurn, workflowConfig as config } from './helpers/workflowParity.ts';
import type { Scripts } from './helpers/workflowParity.ts';
import { importGraph, specifiersOf } from './helpers/importGraph.ts';
import { adkReferences, runsAdk } from './helpers/adkReference.ts';

// ADK's side of each case is recorded (tests/fixtures/adk-reference/workflowagentnode); ADK runs only under ADK_REFERENCE=live|record.
const reference = adkReferences('workflowAgentNode');
if (runsAdk()) {
  const { LogLevel, setLogLevel } = await import('@google/adk');
  setLogLevel(LogLevel.ERROR);
}


// ── Route derivation ─────────────────────────────────────────────────────────

test('routeOf: the route_key property of an object, else the trimmed text, else empty; one function on both paths', () => {
  assert.equal(configRouteOf, routeOf, 'lib/workflowConfig.ts re-exports the one function the ADK path calls');
  assert.equal(routeOf({ route: ' bug ', x: 1 }), 'bug');
  assert.equal(routeOf({ kind: 'article' }, 'kind'), 'article');
  assert.equal(routeOf({ kind: 'article' }), '', 'an absent property is the empty route, which the default catches');
  assert.equal(routeOf({ kind: null }, 'kind'), '');
  assert.equal(routeOf({ kind: 2 }, 'kind'), '2');
  assert.equal(routeOf('  question \n'), 'question');
  assert.equal(routeOf('{"kind":"article"}', 'kind'), '{"kind":"article"}', 'JSON text is text: only an output schema parses it');
  assert.equal(routeOf(['a']), 'a');
  assert.equal(routeOf(true), 'true');
  assert.equal(routeOf(undefined), '');
  assert.equal(routeOf(`${' '.repeat(100_000)}x${'\t'.repeat(100_000)}`), 'x', 'a long run of whitespace trims in linear time');
});

test("routeStepEvent is the event ADK's route step stores", () => {
  const e = routeStepEvent({ name: 'Planner__route', path: 'Graph.Planner__route', branch: undefined, invocationId: 'e-1', output: { kind: 'a' }, route: 'a' });
  assert.deepEqual(
    { ...e, id: '<id>', timestamp: 0 },
    {
      author: 'Planner__route',
      invocationId: 'e-1',
      id: '<id>',
      timestamp: 0,
      actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {} },
      longRunningToolIds: [],
      branch: undefined,
      output: { kind: 'a' },
      route: 'a',
      nodeInfo: { path: 'Graph.Planner__route', outputFor: ['Graph.Planner__route'] },
    },
  );
});

// ── The node rules ───────────────────────────────────────────────────────────

test("a node's input becomes the user turn as ADK's toUserContent makes it", () => {
  assert.deepEqual(nodeInputContent('hi'), { role: 'user', parts: [{ text: 'hi' }] });
  assert.deepEqual(nodeInputContent({ kind: 'a' }), { role: 'user', parts: [{ text: '{"kind":"a"}' }] });
  assert.deepEqual(nodeInputContent({ role: 'model', parts: [{ text: 'x' }] }), { role: 'user', parts: [{ text: 'x' }] });
  assert.deepEqual(nodeInputContent(3), { role: 'user', parts: [{ text: '3' }] });
});

test('includeContents: none unless the agent set it, never for task mode, and the compiled agent is unchanged', () => {
  const plain: NativeAgent = { name: 'A', model: 'm' };
  const node = asNodeAgent(plain);
  assert.equal(node.includeContents, 'none');
  assert.equal(plain.includeContents, undefined, 'a copy');
  const explicit: NativeAgent = { name: 'A', model: 'm', includeContents: 'default' };
  assert.equal(asNodeAgent(explicit), explicit);
  const task: NativeAgent = { name: 'A', model: 'm', mode: 'task' };
  assert.equal(asNodeAgent(task).includeContents, undefined);
});

test("a node's output: the text without thoughts, JSON only with a schema, nothing for a call or a non-model event", () => {
  const ev = (parts: object[], role = 'model') => createTurnEvent({ author: 'A', content: { role, parts } as TurnContent });
  assert.equal(eventOutput({}, ev([{ text: 'thinking', thought: true }, { text: 'a' }, { text: 'b' }])), 'ab');
  assert.equal(eventOutput({}, ev([{ text: '{"k":1}' }])), '{"k":1}');
  assert.deepEqual(eventOutput({ outputSchema: { type: 'OBJECT' } }, ev([{ text: '{"k":1}' }])), { k: 1 });
  assert.equal(eventOutput({ outputSchema: { type: 'OBJECT' } }, ev([{ text: 'not json' }])), 'not json');
  assert.equal(eventOutput({}, ev([{ functionCall: { name: 't', args: {} } }])), undefined);
  assert.equal(eventOutput({}, ev([{ text: 'x' }], 'user')), undefined);
  assert.equal(eventOutput({}, ev([{ text: '' }])), '', "an empty answer is the empty string, as ADK's");
});

// ── ADR 0030's routing cases, both ways ──────────────────────────────────────

const lastText = (req: Parameters<ModelScript>[0]) => requestTexts(req).at(-1) ?? '';

const TEXT_ROUTE = config({ edges: [['START', 'Triage', { bug: 'Fixer', default: 'Other' }]] }, [agent('Fixer'), agent('Other')]);
const textScripts = (verdict: string): Scripts => ({
  triage: () => answer(`  ${verdict}\n`),
  fixer: (req) => answer(`fixed ${lastText(req)}`),
  other: (req) => answer(`other ${lastText(req)}`),
});

test('a chain routes on an agent\'s trimmed text: same events, requests, route and progress as ADK', async () => {
  const { native } = await bothAgree(reference, 'text-route-bug', TEXT_ROUTE, textScripts('bug'), 'it crashes');
  assert.deepEqual(native.routes, { Triage__route: 'bug' });
  assert.equal(native.output, 'fixed   bug\n', 'the next node gets the output as the agent wrote it; only the route is trimmed');
  assert.equal(native.models.other!.calls, 0);
  assert.deepEqual(native.progress, ['Running node: Triage', 'Running node: Fixer'], 'declared nodes only: never the root or the route step');
});

test('a route no key names takes the default edge, as on ADK', async () => {
  const { native } = await bothAgree(reference, 'text-route-default', TEXT_ROUTE, textScripts('weird'), 'hm');
  assert.deepEqual(native.routes, { Triage__route: 'weird' });
  assert.equal(native.models.fixer!.calls, 0);
  assert.deepEqual(native.progress, ['Running node: Triage', 'Running node: Other']);
});

const JSON_ROUTE = (planner: Record<string, unknown>) =>
  config({ edges: [['START', 'Planner', { article: 'Writer', default: 'Answerer' }]], nodes: { Planner: { route_key: 'kind' } } }, [agent('Writer'), agent('Answerer')], agent('Planner', planner));
const jsonScripts: Scripts = {
  planner: () => answer('{"kind":"article","brief":"on cats"}'),
  writer: (req) => answer(`wrote ${lastText(req)}`),
  answerer: () => answer('answered'),
};

test('a JSON output with an output schema routes on route_key and reaches the next node as JSON', async () => {
  const { native } = await bothAgree(reference, 'json-route-with-schema', JSON_ROUTE({ outputSchema: { type: 'OBJECT', properties: { kind: { type: 'STRING' }, brief: { type: 'STRING' } } } }), jsonScripts, 'write about cats');
  assert.deepEqual(native.routes, { Planner__route: 'article' });
  assert.equal(native.output, 'wrote {"kind":"article","brief":"on cats"}');
  const planner = native.events.find((e) => e.author === 'Planner')!;
  assert.deepEqual(planner.output, { kind: 'article', brief: 'on cats' });
  assert.deepEqual(planner.nodeInfo, { messageAsOutput: true, path: 'Graph.Planner', outputFor: ['Graph.Planner'] });
});

test('JSON text from an agent without an output schema is text: it routes on the whole text, to the default, as on ADK', async () => {
  const { native } = await bothAgree(reference, 'json-route-without-schema', JSON_ROUTE({}), jsonScripts, 'write about cats');
  assert.deepEqual(native.routes, { Planner__route: '{"kind":"article","brief":"on cats"}' });
  assert.equal(native.models.writer!.calls, 0);
  assert.equal(native.output, 'answered');
});

test('a task-mode node routes on its finish_task output; it gets no user turn and sees the history', async () => {
  const cfg = config(
    { edges: [['START', 'Lead', 'Extractor', { Lyon: 'Booker', default: 'Other' }]], nodes: { Extractor: { route_key: 'city' } } },
    [
      agent('Extractor', { mode: 'task', outputSchema: { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] } }),
      agent('Booker'),
      agent('Other'),
    ],
    agent('Lead'),
  );
  const scripts: Scripts = {
    lead: () => answer('two nights in Lyon please'),
    extractor: (_req, n) => (n === 1 ? toolCall('finish_task', { city: 'Lyon' }, 'c1') : answer('never asked')),
    booker: (req) => answer(`booked ${lastText(req)}`),
    other: () => answer('other'),
  };
  const { native } = await bothAgree(reference, 'task-mode-route', cfg, scripts, 'go');
  assert.equal(native.models.extractor!.calls, 1, 'the node ends on the successful answer');
  assert.deepEqual(native.routes, { Extractor__route: 'Lyon' });
  assert.equal(native.output, 'booked {"city":"Lyon"}');
  assert.ok(!native.events.some((e) => e.author === 'user' && e.content?.parts?.[0]?.text === 'two nights in Lyon please'), 'no user turn for a task node');
  assert.ok(requestTexts(native.models.extractor!.requests[0]!).some((t) => t.includes('two nights in Lyon please')), "the task node sees the Lead's answer in its history");
});

test("an agent that sets includeContents: default sees the conversation, retold, as on ADK", async () => {
  const cfg = config({ edges: [['START', 'Triage', 'Reader']] }, [agent('Reader', { includeContents: 'default' })]);
  const { native } = await bothAgree(reference, 'include-contents-default', cfg, { triage: () => answer('brief'), reader: (req) => answer(`read ${requestTexts(req).length}`) }, 'start');
  assert.ok(requestTexts(native.models.reader!.requests[0]!).length > 1, 'more than its input');
});

registerTool(
  'agent_node_lookup',
  defineTool({ name: 'agent_node_lookup', description: 'Look something up.', schema: z.object({ q: z.string() }), execute: async ({ q }) => `found ${q}` }),
  { override: true },
);

test('chained with the tool node runner: an agent routes, a tool node runs on its JSON, the next agent reads the result, as on ADK', async () => {
  const cfg = config(
    { edges: [['START', 'Planner', { look: 'Lookup', default: 'Reader' }], ['Lookup', 'Reader']], nodes: { Lookup: { tool: 'agent_node_lookup' } } },
    [agent('Reader')],
    agent('Planner', { outputSchema: { type: 'OBJECT', properties: { route: { type: 'STRING' }, q: { type: 'STRING' } } } }),
  );
  const scripts: Scripts = { planner: () => answer('{"route":"look","q":"cats"}'), reader: (req) => answer(`read ${lastText(req)}`) };
  const { native } = await bothAgree(reference, 'chained-tool-node', cfg, scripts, 'go');
  assert.deepEqual(native.routes, { Planner__route: 'look' });
  assert.equal(native.output, 'read {"result":"found cats"}');
  assert.ok(native.progress.includes('Running node: Lookup'), native.progress.join(' | '));
});

test("a node whose model fails, with no output, fails the walk with ADK's NodeReportedError message", async () => {
  const cfg = config({ edges: [['START', 'Triage', { bug: 'Fixer', default: 'Other' }]] }, [agent('Fixer'), agent('Other')]);
  const scripts: Scripts = { triage: () => failure({ code: 'SCRIPTED_DOWN', message: 'the model is down' }), fixer: () => answer('x'), other: () => answer('y') };
  const adk = await adkSide(reference, 'model-fails', cfg, scripts, 'go');
  const native = await onNative(cfg, scripts, 'go');
  assert.equal(native.status, 'failed');
  assert.equal(adk.status, 'failed');
  assert.equal(native.error, new NodeReportedError({ nodeName: 'Triage', errorCode: 'SCRIPTED_DOWN', errorMessage: 'the model is down' }).message);
  assert.match(adk.error ?? '', /Triage/);
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'the stored events up to the failure');
  assert.equal(native.models.fixer!.calls + native.models.other!.calls, 0);
  // Through the native turn: the same events, and the turn fails as ADK's does.
  const turn = await onNativeTurn(cfg, scripts, 'go');
  assert.deepEqual(comparable(turn.events), comparable(adk.events), 'the native turn stores the same events');
  assert.equal(turn.status, 'failed');
  assert.equal(turn.error, adk.error);
});

// ── No ADK ───────────────────────────────────────────────────────────────────

test('route.ts reaches nothing from @google; agentNode.ts names no @google package itself', () => {
  const reached = [...importGraph('lib/workflow/route.ts').values()].flat().filter((s) => !s.startsWith('.'));
  assert.deepEqual(reached.filter((s) => s.startsWith('@google/')), []);
  for (const file of ['lib/workflow/route.ts', 'lib/workflow/agentNode.ts']) {
    assert.deepEqual(specifiersOf(file).filter((s) => s.startsWith('@google/')), [], file);
  }
});
