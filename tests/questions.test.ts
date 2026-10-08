/**
 * tests/questions.test.ts — `ask_user` (lib/runtime/questions.ts): an agent
 * asks mid-turn, the turn ends input-required with the question, and the next
 * plain-text message resumes the agent that asked with the answer as the
 * call's result; in DELEGATE and PLAN-DISPATCH; and the schema's placement
 * rule.
 *
 * Every conversation runs on both runtimes (WS2-7b, ADR 0079): through
 * runSyndicateTurn on ADK, then on native, with the same scripted model
 * behind the ADK shim. The results, the stored events (ids and times aside)
 * and the model calls must match, and a question opened on one runtime is
 * answered on the other. Scripted models, in-memory sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import { z } from 'zod';

import type { ModelResponse } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/fallback.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { pendingQuestion } from '../lib/runtime/questions.ts';
import { describeInput } from '../lib/workflow.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

setLogLevel(LogLevel.ERROR);

type Runtime = 'adk' | 'native';
const RUNTIMES: Runtime[] = ['adk', 'native'];

registerTool(
  'questions_lookup',
  defineTool({ name: 'questions_lookup', description: 'Look a key up.', schema: z.object({ key: z.string() }), execute: async ({ key }) => `found ${key}` }),
  { override: true },
);

const lastResult = (req: Parameters<ModelScript>[0]) => JSON.stringify(lastToolResult(req)?.result ?? null);

/** One conversation: each turn's message on its runtime, one store, fresh models. */
async function converse(config: SyndicateYamlConfig, scripts: Record<string, ModelScript>, turns: Array<{ parts: any[]; runtime: Runtime }>) {
  resetCircuits();
  const models = Object.fromEntries(Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));
  const sessionService = new InMemorySessionService();
  const results: SyndicateTurnResult[] = [];
  for (const t of turns) {
    results.push(
      await runSyndicateTurn({
        config,
        parts: t.parts,
        appName: 'app',
        userId: 'u',
        sessionId: 's',
        sessionService,
        compile: { resolveModel: shimResolver(models), log: () => {} },
        trace: false,
        runtime: t.runtime,
      }),
    );
  }
  const session = await sessionService.getSession({ appName: 'app', userId: 'u', sessionId: 's' });
  return { results, models, events: JSON.parse(JSON.stringify(session?.events ?? [])) as any[] };
}

/** Event ids and times, invocation ids and ADK's own `adk-` call ids are minted per run; everything else must match. */
const comparable = (events: any[]): unknown =>
  JSON.parse(
    JSON.stringify(events.map((e) => ({ ...e, id: '<id>', timestamp: 0, invocationId: '<inv>' }))),
    (_key, v) => (typeof v === 'string' && v.startsWith('adk-') ? '<adk-id>' : v),
  );

/** What a surface reads from a result; the question's id is the call's, minted per run when the model gives none. */
const outcome = (r: SyndicateTurnResult): unknown => ({
  status: r.status,
  text: r.text,
  error: r.error,
  route: r.route,
  input: r.input ? { node: r.input.node, message: r.input.message, payload: r.input.payload } : undefined,
});

/**
 * The conversation on ADK, on native, and with its runtime switched at every
 * turn both ways: the results, the stored events and the model calls match.
 */
async function assertParity(config: SyndicateYamlConfig, scripts: Record<string, ModelScript>, messages: any[][]) {
  const on = (pick: (i: number) => Runtime) => converse(config, scripts, messages.map((parts, i) => ({ parts, runtime: pick(i) })));
  const adk = await on(() => 'adk');
  const runs = { native: await on(() => 'native'), adkThenNative: await on((i) => (i % 2 ? 'native' : 'adk')), nativeThenAdk: await on((i) => (i % 2 ? 'adk' : 'native')) };
  for (const [name, run] of Object.entries(runs)) {
    assert.deepEqual(run.results.map(outcome), adk.results.map(outcome), `${name}: the results`);
    assert.deepEqual(comparable(run.events), comparable(adk.events), `${name}: the stored events`);
    for (const key of Object.keys(scripts)) assert.equal(run.models[key]?.calls, adk.models[key]?.calls, `${name}: calls to ${key}`);
  }
  return { adk, ...runs };
}

const delegate = (): SyndicateYamlConfig =>
  validateSyndicateConfig(
    { syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Help.', tools: ['ask_user', 'questions_lookup'] }, subagents: [] },
    't',
  ) as SyndicateYamlConfig;

test('delegate: the orchestrator asks, the turn pauses with the question, the next message answers it, on both runtimes', async () => {
  const boss: ModelScript = (req, n) =>
    n === 1 ? toolCall('ask_user', { question: 'Which account?', options: ['personal', 'work'] }, 'call-ask') : answer(n === 2 ? `using ${lastResult(req)}` : `ok: ${requestTexts(req).at(-1)}`);
  const runs = await assertParity(delegate(), { boss }, [[{ text: 'pay the invoice' }], [{ text: 'work' }], [{ text: 'thanks' }]]);

  for (const runtime of RUNTIMES) {
    const { results, models, events } = runs[runtime];
    const [first, second, third] = results as [SyndicateTurnResult, SyndicateTurnResult, SyndicateTurnResult];
    assert.equal(first.status, 'input-required', runtime);
    assert.equal(first.input?.node, 'Boss');
    assert.equal(first.input?.id, 'call-ask');
    assert.equal(first.input?.message, 'Which account?');
    assert.deepEqual(first.input?.payload, { options: ['personal', 'work'] });
    assert.equal(first.text, 'Which account?');
    assert.equal(describeInput(first.input!), 'Boss asks: Which account? (personal / work)');

    assert.equal(second.status, 'completed', second.error?.message);
    assert.equal(second.text, 'using "work"');
    // The answer is the call's response, stored as the person's message.
    const answerEvent = events.find((e) => e.author === 'user' && e.content?.parts?.[0]?.functionResponse);
    assert.deepEqual(answerEvent?.content?.parts, [{ functionResponse: { id: 'call-ask', name: 'ask_user', response: { result: 'work' } } }]);
    assert.equal(pendingQuestion(events), undefined);

    // Answered: the next message is an ordinary message again.
    assert.equal(third.status, 'completed');
    assert.equal(third.text, 'ok: thanks');
    assert.equal(models.boss?.calls, 3, `${runtime}: the agent resumed once, with the answer as the call result`);
  }
});

test('a question asked beside another call: the other call is answered at once, the question by the next message', async () => {
  const boss: ModelScript = (req, n): ModelResponse =>
    n === 1
      ? {
          partial: false,
          parts: [
            { type: 'toolCall', id: 'c-look', name: 'questions_lookup', args: { key: 'invoice' } },
            { type: 'toolCall', id: 'c-ask', name: 'ask_user', args: { question: 'Which account?' } },
          ],
          finishReason: 'tool_call',
        }
      : answer(`saw ${lastResult(req)}`);
  const { native } = await assertParity(delegate(), { boss }, [[{ text: 'pay the invoice' }], [{ text: 'personal' }]]);
  assert.equal(native.results[0]?.status, 'input-required');
  assert.equal(native.results[0]?.input?.id, 'c-ask');
  assert.equal(native.results[1]?.status, 'completed', native.results[1]?.error?.message);
  assert.equal(native.results[1]?.text, 'saw "personal"');
});

test('dispatch: a route asks; the answer resumes that route without the classifier, on both runtimes', async () => {
  const config = validateSyndicateConfig(
    {
      syndicate_name: 'Desk',
      orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
      subagents: [
        { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
        { name: 'Orders', model: 'scripted/orders', instruction: 'Orders.', description: 'orders', tools: ['ask_user'] },
      ],
      dispatch: { default_route: 'Chat' },
    },
    't',
  ) as SyndicateYamlConfig;
  const runs = await assertParity(
    config,
    {
      router: () => answer('{"route":"Orders","reason":"an order"}'),
      chat: () => answer('chat'),
      orders: (req, n) => (n === 1 ? toolCall('ask_user', { question: 'Order number?' }, 'call-order') : answer(`order ${lastResult(req)}`)),
    },
    [[{ text: 'where is my order' }], [{ text: 'A-1042' }]],
  );
  for (const runtime of RUNTIMES) {
    const { results, models } = runs[runtime];
    const [first, second] = results as [SyndicateTurnResult, SyndicateTurnResult];
    assert.equal(first.status, 'input-required', runtime);
    assert.equal(first.input?.node, 'Orders');
    assert.equal(first.input?.payload, undefined);
    assert.equal(second.status, 'completed', second.error?.message);
    assert.equal(second.route?.route, 'Orders');
    assert.equal(second.route?.decidedBy, 'answer');
    assert.equal(second.text, 'order "A-1042"');
    assert.equal(models.router?.calls, 1, `${runtime}: the classifier did not run for the answer`);
    assert.equal(models.chat?.calls, 0);
  }
});

test('schema: ask_user only where a pause can reach the person', () => {
  const sub = (extra: Record<string, unknown> = {}) => ({
    syndicate_name: 'S',
    orchestrator: { name: 'Lead', model: 'gemini-3.5-flash-lite', instruction: 'x' },
    subagents: [{ name: 'Sub', description: 'd', model: 'gemini-3.5-flash-lite', instruction: 'y', tools: ['ask_user'] }],
    ...extra,
  });
  assert.throws(() => validateSyndicateConfig(sub(), 't'), /ask_user pauses the turn, which only the orchestrator or a plan-dispatch route can do/);
  assert.doesNotThrow(() => validateSyndicateConfig(sub({ dispatch: { default_route: 'Sub' } }), 't'));
  assert.doesNotThrow(() => validateSyndicateConfig(delegate(), 't'));
  assert.throws(
    () => validateSyndicateConfig(sub({ workflow: { edges: [['START', 'Lead', 'Sub']] } }), 't'),
    /ask_user is not supported on a workflow node yet/,
  );
});
