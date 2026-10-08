/**
 * tests/workflowSubagent.test.ts — a workflow syndicate as another
 * syndicate's subagent (WS4-7, ADR 0098): a delegated `yaml_reference` to a
 * workflow syndicate runs the whole graph as the subagent tool, and the
 * graph's last event's text is the tool's answer. The call walks the graph
 * with the engine's scheduler on the child session
 * (lib/runtime/native/delegate.ts, lib/compileNative.ts). The parity case
 * holds the sessions and requests to ADK's, as ADK 2.2 recorded them in
 * tests/fixtures/adk-reference/workflowsubagent (tests/helpers/adkReference.ts).
 * Scripted models, in-memory sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileSpec } from '../lib/compile.ts';
import { compileNative } from '../lib/compileNative.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { workflowSubagentOf } from '../lib/runtime/native/delegate.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { adkReferences } from './helpers/adkReference.ts';
import { ScriptedModel, answer, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { virtualClock } from './helpers/virtualClock.ts';
import { comparable, requestsOf } from './helpers/workflowParity.ts';

// ADK's side of the parity case is recorded (tests/fixtures/adk-reference/workflowsubagent).
const reference = adkReferences('workflowSubagent');

/** The clock a slow script waits on: a finish order is the scripts' timeline, never a race of real timers (tests/helpers/virtualClock.ts). */
const clock = virtualClock();

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

/** Scripts whose finish times stay 30 ms apart on the virtual clock where a fan-out runs two nodes at once. */
function scripts(): Record<string, ModelScript> {
  return {
    boss: (request, n) => (n === 1 ? toolCall('Writer', { request: 'an article on cats' }, 'call-writer-1') : answer(`Boss relays: ${JSON.stringify(request.messages.at(-1)?.parts.at(-1))}`)),
    plan: (request) => answer(`plan(${lastText(request)})`),
    write: async (request) => answer(`draft(${lastText(request)})`),
    check: async (request) => {
      await clock.sleep(30);
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

async function runDesk(nested: SyndicateYamlConfig = pipeline()): Promise<Run> {
  const models = Object.fromEntries(Object.entries(scripts()).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));
  const sessionService = new InProcessSessionService();
  const result = await runSyndicateTurn({
    config: caller(),
    parts: [{ text: 'write me something on cats' }],
    appName: 'app',
    userId: 'u',
    sessionId: 's',
    sessionService,
    compile: { resolveModel: shimResolver(models), loadNested: () => nested, log: () => {} },
    trace: false,
  });
  const read = async (appName: string) => JSON.parse(JSON.stringify((await sessionService.get({ appName, userId: 'u', sessionId: 's' }))?.events ?? [])) as TurnEvent[];
  return { result, models, callerEvents: await read('app'), childEvents: await read('Writer') };
}

test('a delegated yaml_reference to a workflow syndicate runs the whole graph; its last output is the tool’s answer', async () => {
  const { result, models, childEvents } = await runDesk();
  assert.equal(result.status, 'completed', result.error?.message);
  const final = 'edited({"Write":"draft(plan(an article on cats))","Check":"claims(plan(an article on cats))"})';
  assert.ok(result.text.startsWith('Boss relays: '), result.text);
  assert.ok(result.text.includes(JSON.stringify(final).slice(1, -1)), `the boss received the graph's last output: ${result.text}`);
  for (const key of ['plan', 'write', 'check', 'edit']) assert.equal(models[key]!.calls, 1, `${key} ran once`);
  assert.equal(lastText(models.plan!.requests[0]!), 'an article on cats', 'the first node gets the call’s request');
  // The child session is the entry's; every node path is rooted at the entry's name.
  const paths = [...new Set(childEvents.map((e) => e.nodeInfo?.path).filter(Boolean))];
  assert.deepEqual(paths.sort(), ['Writer.Both', 'Writer.Check', 'Writer.Edit', 'Writer.Plan', 'Writer.Write']);
  assert.equal(childEvents.filter((e) => e.output !== undefined).at(-1)?.output, final);
});

test('the nested workflow stores the same sessions and sends the same requests as ADK recorded', async () => {
  const adk = await reference<{ status: string; text: string; childEvents: TurnEvent[]; callerEvents: TurnEvent[]; requests: Record<string, unknown> }>('nested-workflow-sessions-and-requests');
  const native = await runDesk(pipeline());
  assert.equal(native.result.status, adk.status);
  assert.equal(native.result.text, adk.text);
  assert.deepEqual(comparable(native.childEvents), comparable(adk.childEvents), 'the child session');
  assert.deepEqual(comparable(native.callerEvents), comparable(adk.callerEvents), 'the caller session');
  for (const key of Object.keys(adk.requests)) {
    assert.deepEqual(requestsOf(native.models[key]!), adk.requests[key], `the requests ${key} received`);
  }
});

test('a nested workflow with an ask_user node is refused by name before any model call', async () => {
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
  await assert.rejects(runDesk(nested), /pipeline\.yaml: the ask_user node 'Confirm' pauses for a person, which a workflow nested in another syndicate \(Writer\) cannot carry to its caller/);
});

test('compile: the nested workflow is one tool, under the entry’s name and description', async () => {
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
