/**
 * tests/workflowSubagent.test.ts — a workflow syndicate as another
 * syndicate's subagent (WS4-7, ADR 0098): a delegated `yaml_reference` to a
 * workflow syndicate runs the whole graph as the subagent tool, and the
 * graph's last event's text is the tool's answer. On ADK the Workflow is
 * wrapped in ADK's own AgentTool (lib/compileAdk.ts); on native the call
 * walks the graph with the engine's scheduler on the child session
 * (lib/runtime/native/delegate.ts, lib/compileNative.ts). Every case runs on
 * both runtimes, and the parity case holds the native sessions and requests
 * to ADK's. Scripted models, in-memory sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';

import { compileSpec } from '../lib/compile.ts';
import { compileNative } from '../lib/compileNative.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { workflowSubagentOf } from '../lib/runtime/native/delegate.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { forEachRuntime, runtimeOption } from './helpers/runtime.ts';
import { ScriptedModel, answer, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { comparable } from './helpers/workflowParity.ts';

setLogLevel(LogLevel.ERROR);

const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });

/** The nested workflow: a planner fans out to a writer and a checker, a join hands both to an editor. */
function pipeline(nodes: Record<string, unknown> = {}): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Pipeline',
      memory_system: 'internal-only',
      orchestrator: agent('Plan'),
      subagents: [agent('Write'), agent('Check'), agent('Edit')],
      workflow: { edges: [['START', 'Plan', ['Write', 'Check']], [['Write', 'Check'], 'Both', 'Edit']], nodes: { Both: { join: true }, ...nodes } },
    },
    'pipeline.yaml',
  ) as SyndicateYamlConfig;
}

/** The caller: a DELEGATE orchestrator whose one subagent is the nested workflow, named Writer. */
function caller(): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Desk',
      memory_system: 'internal-only',
      orchestrator: agent('Boss'),
      subagents: [{ name: 'Writer', description: 'Writes an article.', yaml_reference: 'pipeline.yaml' }],
    },
    'desk.yaml',
  ) as SyndicateYamlConfig;
}

const lastText = (request: ModelRequest) => requestTexts(request).at(-1) ?? '';

/** Scripts whose finish times stay at least 20 ms apart where a fan-out runs two nodes at once. */
function scripts(): Record<string, ModelScript> {
  return {
    boss: (request, n) => (n === 1 ? toolCall('Writer', { request: 'an article on cats' }, 'call-writer-1') : answer(`Boss relays: ${JSON.stringify(request.messages.at(-1)?.parts.at(-1))}`)),
    plan: (request) => answer(`plan(${lastText(request)})`),
    write: async (request) => answer(`draft(${lastText(request)})`),
    check: async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return answer(`claims(${lastText(request)})`);
    },
    edit: (request) => answer(`edited(${lastText(request)})`),
  };
}

interface Run {
  result: SyndicateTurnResult;
  models: Record<string, ScriptedModel>;
  callerEvents: TurnEvent[];
  childEvents: TurnEvent[];
}

async function runDesk(nested: SyndicateYamlConfig = pipeline(), runtime?: 'adk' | 'native'): Promise<Run> {
  const models = Object.fromEntries(Object.entries(scripts()).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));
  const sessionService = new InMemorySessionService();
  const result = await runSyndicateTurn({
    ...(runtime ? { runtime } : runtimeOption()),
    config: caller(),
    parts: [{ text: 'write me something on cats' }],
    appName: 'app',
    userId: 'u',
    sessionId: 's',
    sessionService,
    compile: { resolveModel: shimResolver(models), loadNested: () => nested, log: () => {} },
    trace: false,
  });
  const read = async (appName: string) => JSON.parse(JSON.stringify((await sessionService.getSession({ appName, userId: 'u', sessionId: 's' }))?.events ?? [])) as TurnEvent[];
  return { result, models, callerEvents: await read('app'), childEvents: await read('Writer') };
}

forEachRuntime('a delegated yaml_reference to a workflow syndicate runs the whole graph; its last output is the tool’s answer', async () => {
  const { result, models, childEvents } = await runDesk();
  assert.equal(result.status, 'completed', result.error?.message);
  const final = 'edited({"Write":"draft(plan(an article on cats))","Check":"claims(plan(an article on cats))"})';
  assert.ok(result.text.startsWith('Boss relays: '), result.text);
  assert.ok(result.text.includes(JSON.stringify(final).slice(1, -1)), `the boss received the graph's last output: ${result.text}`);
  for (const key of ['plan', 'write', 'check', 'edit']) assert.equal(models[key]!.calls, 1, `${key} ran once`);
  assert.equal(lastText(models.plan!.requests[0]!), 'an article on cats', 'the first node gets the call’s request');
  // The child session is the entry's, as ADK's AgentTool keeps it; every node path is rooted at the entry's name.
  const paths = [...new Set(childEvents.map((e) => e.nodeInfo?.path).filter(Boolean))];
  assert.deepEqual(paths.sort(), ['Writer.Both', 'Writer.Check', 'Writer.Edit', 'Writer.Plan', 'Writer.Write']);
  assert.equal(childEvents.filter((e) => e.output !== undefined).at(-1)?.output, final);
});

test('the nested workflow stores the same sessions and sends the same requests on both runtimes', async () => {
  const adk = await runDesk(pipeline(), 'adk');
  const native = await runDesk(pipeline(), 'native');
  assert.equal(native.result.status, adk.result.status);
  assert.equal(native.result.text, adk.result.text);
  assert.deepEqual(comparable(native.childEvents), comparable(adk.childEvents), 'the child session');
  assert.deepEqual(comparable(native.callerEvents), comparable(adk.callerEvents), 'the caller session');
  for (const key of Object.keys(adk.models)) {
    const strip = (m: ScriptedModel) => m.requests.map(({ signal: _s, ...r }) => r);
    assert.deepEqual(strip(native.models[key]!), strip(adk.models[key]!), `the requests ${key} received`);
  }
});

forEachRuntime('a nested workflow with an ask_user node is refused by name before any model call', async () => {
  const nested = validateSyndicateConfig(
    {
      syndicate_name: 'Pipeline',
      memory_system: 'internal-only',
      orchestrator: agent('Plan'),
      subagents: [agent('Edit')],
      workflow: { edges: [['START', 'Plan', 'Confirm', 'Edit']], nodes: { Confirm: { ask_user: 'Publish?' } } },
    },
    'pipeline.yaml',
  ) as SyndicateYamlConfig;
  await assert.rejects(runDesk(nested), /pipeline\.yaml: the ask_user node 'Confirm' pauses for a person, which a workflow nested as a subagent \(Writer\) cannot carry to its caller/);
});

test('compile: the nested workflow is one tool, under the entry’s name and description, on both runtimes', async () => {
  const models = Object.fromEntries(Object.keys(scripts()).map((key) => [key, new ScriptedModel(`scripted/${key}`, () => answer(''))]));
  const spec = await compileSpec(caller(), { resolveModel: shimResolver(models), loadNested: () => pipeline(), log: () => {} });
  const entry = spec.tools.find((t) => t.kind === 'workflow');
  assert.ok(entry && entry.kind === 'workflow');
  assert.equal(entry.workflow.name, 'Writer');
  assert.equal(entry.workflow.description, 'Writes an article.');
  assert.equal(entry.workflow.config.syndicate_name, 'Writer');
  assert.deepEqual(entry.workflow.agents.map((a) => a.yaml.name), ['Plan', 'Write', 'Check', 'Edit']);
  const native = compileNative(spec);
  const tool = (native.tools ?? []).map((t) => workflowSubagentOf(t)).find(Boolean);
  assert.equal(tool?.name, 'Writer');
  assert.equal(tool?.description, 'Writes an article.');
});
