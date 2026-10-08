/**
 * tests/workflowApprovals.test.ts — approval gates on workflow nodes (WS4-7,
 * ADR 0098). A tool in a node agent's `require_approval` pauses the node and
 * the walk: the turn ends `input-required` with `result.approval`, and the
 * next message, the person's decision, resumes the node's own run, which
 * runs or refuses the pinned call through the loop's approval resume (ADR
 * 0077) and walks on. Native runs it; ADK, whose resume reruns the node from
 * its input and never runs the pinned call, refuses it before any model
 * call. The pausing turn stores what ADK's Workflow stores. Scripted models,
 * in-memory sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FunctionTool, InMemorySessionService, LogLevel, Runner, setLogLevel } from '@google/adk';
import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import { approvalResponsePart, pendingApproval } from '../lib/runtime/approvals.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { UnsupportedOnRuntimeError } from '../lib/runtime/runtimeFlag.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { SyndicateValidationError, validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { compileWorkflow } from '../lib/workflow.ts';
import { ScriptedModel, answer, lastToolResult, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { virtualClock } from './helpers/virtualClock.ts';
import { comparable } from './helpers/workflowParity.ts';

setLogLevel(LogLevel.ERROR);

/** The clock a slow script waits on: a finish order is the scripts' timeline, never a race of real timers (tests/helpers/virtualClock.ts). */
const clock = virtualClock();

const sent: string[] = [];
registerTool(
  'workflow_approval_send',
  new FunctionTool({
    name: 'workflow_approval_send',
    description: 'Send a note.',
    parameters: z.object({ to: z.string() }),
    execute: async ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  }),
  { override: true },
);

const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });
const gated = (name: string) => agent(name, { tools: ['workflow_approval_send'], require_approval: ['workflow_approval_send'] });

function config(workflow: Record<string, unknown>, subagents: Record<string, unknown>[]): SyndicateYamlConfig {
  return validateSyndicateConfig({ syndicate_name: 'Graph', memory_system: 'internal-only', orchestrator: agent('Plan'), subagents, workflow }, 'test') as SyndicateYamlConfig;
}

/** Plan → Send (gated) → Report. */
const chain = () => config({ edges: [['START', 'Plan', 'Send', 'Report']] }, [gated('Send'), agent('Report')]);

const lastText = (request: ModelRequest) => requestTexts(request).at(-1) ?? '';

function scripts(): Record<string, ModelScript> {
  return {
    plan: (request) => answer(`plan(${lastText(request)})`),
    send: (request, n) => (n === 1 ? toolCall('workflow_approval_send', { to: 'ops@acme.test' }, 'call-send-1') : answer(`send saw ${JSON.stringify(lastToolResult(request)?.result ?? null)}`)),
    report: (request) => answer(`report(${lastText(request)})`),
  };
}

function conversation(cfg: SyndicateYamlConfig, runtime: 'adk' | 'native' = 'native', script = scripts()) {
  const models = Object.fromEntries(Object.entries(script).map(([key, s]) => [key, new ScriptedModel(`scripted/${key}`, s)]));
  const sessionService = new InMemorySessionService();
  const turn = (parts: any[]) =>
    runSyndicateTurn({ runtime, config: cfg, parts, appName: 'app', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: shimResolver(models), log: () => {} }, trace: false });
  const events = async () => JSON.parse(JSON.stringify((await sessionService.getSession({ appName: 'app', userId: 'u', sessionId: 's' }))!.events)) as TurnEvent[];
  return { turn, models, events };
}

test('native: a gated call on a workflow node pauses the walk, and the approval runs it once and walks on', async () => {
  sent.length = 0;
  const { turn, models, events } = conversation(chain());
  const first = await turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required');
  assert.equal(first.approval?.agent, 'Send');
  assert.equal(first.approval?.tool, 'workflow_approval_send');
  assert.deepEqual(first.approval?.args, { to: 'ops@acme.test' });
  assert.match(first.text, /Approval needed: Send wants to run workflow_approval_send/);
  assert.deepEqual(sent, [], 'nothing ran before the approval');
  assert.equal(models.report!.calls, 0, 'the walk waits on the node');

  const second = await turn([approvalResponsePart(first.approval!.id, true)]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test'], 'the pinned call ran once');
  assert.equal(models.plan!.calls, 1, 'a finished node is not run again');
  assert.equal(models.send!.calls, 2);
  // The node's own run continued: its input, its call and the call's answer, never its input a second time.
  const resumed = models.send!.requests[1]!;
  assert.deepEqual(requestTexts(resumed), ['plan(tell ops)']);
  assert.deepEqual(lastToolResult(resumed)?.result, 'sent to ops@acme.test');
  assert.equal(second.text, 'report(send saw "sent to ops@acme.test")');
  const stored = await events();
  assert.equal(stored.filter((e) => e.author === 'user' && e.content?.parts?.[0]?.text === 'plan(tell ops)').length, 1, 'the node input is stored once');
});

test('native: a refusal never runs the pinned call; the node is told and the walk goes on', async () => {
  sent.length = 0;
  const { turn } = conversation(chain());
  const first = await turn([{ text: 'tell ops' }]);
  const second = await turn([approvalResponsePart(first.approval!.id, false)]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, []);
  assert.match(second.text, /^report\(send saw .*rejected/);
});

test('native: a plain-text message while the approval waits repeats the request; nothing is stored and nothing runs', async () => {
  sent.length = 0;
  const { turn, models, events } = conversation(chain());
  const first = await turn([{ text: 'tell ops' }]);
  const before = (await events()).length;
  const second = await turn([{ text: 'hm, what?' }]);
  assert.equal(second.status, 'input-required');
  assert.equal((await events()).length, before, 'the message is not stored');
  assert.equal(second.approval?.id, first.approval?.id, 'the same request still waits');
  assert.equal(models.send!.calls, 1, 'the node did not run again');
  assert.equal(models.report!.calls, 0);
  const third = await turn([approvalResponsePart(first.approval!.id, true)]);
  assert.equal(third.status, 'completed', third.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);
});

test('native: a sibling node’s input stored after the request does not hide it; the join waits for the approved node', async () => {
  sent.length = 0;
  // Send and Slow fan out; Slow's successor Late starts (its input stored) after Send asked; Both joins Send and Late.
  const cfg = config(
    { edges: [['START', 'Plan', ['Send', 'Slow']], ['Slow', 'Late'], [['Send', 'Late'], 'Both', 'Report']], nodes: { Both: { join: true } } },
    [gated('Send'), agent('Slow'), agent('Late'), agent('Report')],
  );
  const { turn, models, events } = conversation(cfg, 'native', {
    ...scripts(),
    slow: async (request) => {
      await clock.sleep(30);
      return answer(`slow(${lastText(request)})`);
    },
    late: (request) => answer(`late(${lastText(request)})`),
  });
  const first = await turn([{ text: 'go' }]);
  assert.equal(first.status, 'input-required');
  const stored = await events();
  const requestAt = stored.findIndex((e) => e.content?.parts?.some((p) => p.functionCall?.name === 'adk_request_confirmation'));
  const lateInputAt = stored.findIndex((e) => e.author === 'user' && e.content?.parts?.[0]?.text === 'slow(plan(go))');
  assert.ok(requestAt >= 0 && lateInputAt > requestAt, 'a node input follows the request');
  assert.equal(pendingApproval(stored as any)?.id, first.approval?.id, 'the pause record names the request');
  assert.equal(models.late!.calls, 1);
  assert.equal(models.report!.calls, 0);

  const second = await turn([approvalResponsePart(first.approval!.id, true)]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(models.slow!.calls + models.late!.calls, 2, 'the finished branch is not run again');
  assert.equal(second.text, 'report({"Send":"send saw \\"sent to ops@acme.test\\"","Late":"late(slow(plan(go)))"})');
});

test('native: two gated nodes pause at once; each decision resumes its own node, the other waits, and neither runs twice', async () => {
  sent.length = 0;
  const cfg = config(
    { edges: [['START', 'Plan', ['Send', 'Mail']], [['Send', 'Mail'], 'Both', 'Report']], nodes: { Both: { join: true } } },
    [gated('Send'), gated('Mail'), agent('Report')],
  );
  const { turn, models } = conversation(cfg, 'native', {
    ...scripts(),
    mail: async (request, n) => {
      if (n > 1) return answer(`mail saw ${JSON.stringify(lastToolResult(request)?.result ?? null)}`);
      await clock.sleep(30);
      return toolCall('workflow_approval_send', { to: 'pr@acme.test' }, 'call-mail-1');
    },
  });
  const first = await turn([{ text: 'go' }]);
  assert.equal(first.status, 'input-required');
  const firstAgent = first.approval!.agent;
  const otherAgent = firstAgent === 'Send' ? 'Mail' : 'Send';

  const second = await turn([approvalResponsePart(first.approval!.id, true)]);
  assert.equal(second.status, 'input-required', second.error?.message);
  assert.equal(second.approval?.agent, otherAgent, 'the other request still waits');
  assert.equal(sent.length, 1);
  assert.equal(models.report!.calls, 0);

  const third = await turn([approvalResponsePart(second.approval!.id, true)]);
  assert.equal(third.status, 'completed', third.error?.message);
  assert.deepEqual([...sent].sort(), ['ops@acme.test', 'pr@acme.test'], 'each pinned call ran once');
  assert.equal(models.send!.calls, 2, 'Send asked once and answered once');
  assert.equal(models.mail!.calls, 2, 'Mail asked once and answered once');
  assert.equal(models.report!.calls, 1);
  assert.equal(third.text, 'report({"Send":"send saw \\"sent to ops@acme.test\\"","Mail":"mail saw \\"sent to pr@acme.test\\""})');
});

test('native: the pausing turn stores what ADK’s Workflow stores for a gated node', async () => {
  sent.length = 0;
  const cfg = chain();
  const { turn, events } = conversation(cfg);
  await turn([{ text: 'tell ops' }]);
  const native = await events();

  // ADK pauses the node the same way; it is its resume that cannot run the pinned call, so the turn runner refuses it.
  const models = Object.fromEntries(Object.entries(scripts()).map(([key, s]) => [key, new ScriptedModel(`scripted/${key}`, s)]));
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({ appName: 'app', userId: 'u', sessionId: 's' });
  const { workflow } = await compileWorkflow(cfg, { resolveModel: shimResolver(models), log: () => {} });
  const runner = new Runner({ agent: workflow as any, appName: 'app', sessionService });
  for await (const _ of runner.runAsync({ userId: 'u', sessionId: 's', newMessage: { role: 'user', parts: [{ text: 'tell ops' }] } }));
  const adk = JSON.parse(JSON.stringify((await sessionService.getSession({ appName: 'app', userId: 'u', sessionId: 's' }))!.events)) as TurnEvent[];
  assert.deepEqual(comparable(native), comparable(adk));
  assert.deepEqual(sent, []);
});

test('adk: a gate on a workflow node is refused before any model call, naming the runtime that runs it', async () => {
  const { turn, models } = conversation(chain(), 'adk');
  await assert.rejects(
    turn([{ text: 'tell ops' }]),
    (e: unknown) => e instanceof UnsupportedOnRuntimeError && /Graph: an approval gate \(require_approval\) on a workflow node is not supported on the adk runtime yet\. Run it on the native runtime/.test((e as Error).message),
  );
  assert.equal(models.plan!.calls, 0);
});

test('schema: require_approval is allowed on a workflow node, not on an agent a map runs; skill scripts stay refused', () => {
  assert.doesNotThrow(() => chain());
  assert.doesNotThrow(() => validateSyndicateConfig({ syndicate_name: 'G', orchestrator: gated('Plan'), subagents: [agent('Report')], workflow: { edges: [['START', 'Plan', 'Report']] } }));
  assert.throws(
    () => config({ edges: [['START', 'Plan', 'Fan']], nodes: { Fan: { map: 'Send' } } }, [gated('Send')]),
    (e: unknown) => e instanceof SyndicateValidationError && /subagents\[0\]\.require_approval — approval gates are not supported on an agent a map node runs/.test((e as Error).message),
  );
  assert.throws(
    () => config({ edges: [['START', 'Plan', 'Send']] }, [agent('Send', { skills: { scripts: 'local' } })]),
    (e: unknown) => e instanceof SyndicateValidationError && /skill scripts \(an approval pause\) are not supported inside a workflow yet/.test((e as Error).message),
  );
});
