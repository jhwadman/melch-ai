/**
 * tests/questions.test.ts — `ask_user` (lib/runtime/questions.ts): an agent
 * asks mid-turn, the turn ends input-required with the question, and the next
 * plain-text message resumes the agent that asked with the answer as the
 * call's result; in DELEGATE and PLAN-DISPATCH; and the schema's placement
 * rule. Scripted models, in-memory sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { pendingQuestion } from '../lib/runtime/questions.ts';
import { describeInput } from '../lib/workflow.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const lastResponse = (req: any) => JSON.stringify(req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response ?? null);
const lastText = (req: any) => (req.contents.at(-1)?.parts ?? []).map((p: any) => p.text ?? '').join('');

function runner(config: SyndicateYamlConfig, models: Record<string, ScriptedLlm>) {
  const sessionService = new InMemorySessionService();
  const turn = (parts: any[]) =>
    runSyndicateTurn({ config, parts, appName: 'app', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: scriptedResolver(models) }, trace: false });
  return { turn, sessionService };
}

const delegate = (): SyndicateYamlConfig =>
  validateSyndicateConfig(
    { syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Help.', tools: ['ask_user'] }, subagents: [] },
    't',
  ) as SyndicateYamlConfig;

test('delegate: the orchestrator asks, the turn pauses with the question, the next message answers it', async () => {
  const boss = new ScriptedLlm('scripted/boss', (req, n) =>
    n === 1 ? call('ask_user', { question: 'Which account?', options: ['personal', 'work'] }) : text(`using ${lastResponse(req)}`),
  );
  const { turn, sessionService } = runner(delegate(), { boss });

  const first = await turn([{ text: 'pay the invoice' }]);
  assert.equal(first.status, 'input-required');
  assert.equal(first.input?.node, 'Boss');
  assert.equal(first.input?.message, 'Which account?');
  assert.deepEqual(first.input?.payload, { options: ['personal', 'work'] });
  assert.equal(first.text, 'Which account?');
  assert.equal(describeInput(first.input!), 'Boss asks: Which account? (personal / work)');
  const session = await sessionService.getSession({ appName: 'app', userId: 'u', sessionId: 's' });
  assert.equal(pendingQuestion(session!.events)?.id, first.input?.id);

  const second = await turn([{ text: 'work' }]);
  assert.equal(second.status, 'completed');
  assert.equal(second.text, 'using {"result":"work"}');
  assert.equal(boss.calls, 2, 'the agent resumed once, with the answer as the call result');

  // Answered: the next message is an ordinary message again.
  const after = await sessionService.getSession({ appName: 'app', userId: 'u', sessionId: 's' });
  assert.equal(pendingQuestion(after!.events), undefined);
  const third = await turn([{ text: 'thanks' }]);
  assert.equal(third.status, 'completed');
  assert.equal(lastText(boss.requests[2]), 'thanks');
});

test('dispatch: a route asks; the answer resumes that route without the classifier', async () => {
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
  let routed = 0;
  const router = new ScriptedLlm('scripted/router', () => (routed++, text('{"route":"Orders","reason":"an order"}')));
  const chat = new ScriptedLlm('scripted/chat', () => text('chat'));
  const orders = new ScriptedLlm('scripted/orders', (req, n) => (n === 1 ? call('ask_user', { question: 'Order number?' }) : text(`order ${lastResponse(req)}`)));
  const { turn } = runner(config, { router, chat, orders });

  const first = await turn([{ text: 'where is my order' }]);
  assert.equal(first.status, 'input-required');
  assert.equal(first.input?.node, 'Orders');
  assert.equal(first.input?.payload, undefined);
  const second = await turn([{ text: 'A-1042' }]);
  assert.equal(second.status, 'completed');
  assert.equal(second.route?.route, 'Orders');
  assert.equal(second.route?.decidedBy, 'answer');
  assert.equal(second.text, 'order {"result":"A-1042"}');
  assert.equal(routed, 1, 'the classifier did not run for the answer');
  assert.equal(chat.calls, 0);
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
