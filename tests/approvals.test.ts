/**
 * tests/approvals.test.ts — approval gates (ADR 0028): a tool listed in an
 * agent's require_approval runs only after the next message approves the
 * exact call. Scripted models, in-memory sessions, no provider calls.
 * tests/nativeApprovals.test.ts resumes an approval ADK 2.2 stored (session
 * fixture 03).
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import type { TurnEvent as Event } from '../lib/runtime/events.ts';
import { z } from 'zod';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { approvalResponsePart, pendingApproval } from '../lib/runtime/approvals.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { SKIP_SIGNATURE, trimEventForStorage } from '../lib/session/transcript.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

const sent: string[] = [];
registerTool(
  'approval_test_send',
  defineTool({
    name: 'approval_test_send',
    description: 'Send a note.',
    schema: z.object({ to: z.string() }),
    execute: async ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  }),
  { override: true },
);

const lastResponse = (req: any) => JSON.stringify(req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response ?? null);

function delegateConfig(): SyndicateYamlConfig {
  return {
    syndicate_name: 'Mailer',
    orchestrator: {
      name: 'Boss',
      model: 'scripted/boss',
      instruction: 'Send notes.',
      tools: ['approval_test_send'],
      require_approval: ['approval_test_send'],
    },
    subagents: [],
  } as unknown as SyndicateYamlConfig;
}

function runner(config: SyndicateYamlConfig, models: Record<string, ScriptedLlm>) {
  const sessionService = new InProcessSessionService();
  return (parts: any[]) =>
    runSyndicateTurn({
      config,
      parts,
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      sessionService,
      compile: { resolveModel: scriptedResolver(models) },
      trace: false,
    });
}

test('delegate: the gated call waits, then runs once approved', async () => {
  sent.length = 0;
  const boss = new ScriptedLlm('scripted/boss', (req, n) => (n === 1 ? call('approval_test_send', { to: 'ops@acme.test' }) : text(`done ${lastResponse(req)}`)));
  const turn = runner(delegateConfig(), { boss });

  const first = await turn([{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required');
  assert.equal(first.approval?.agent, 'Boss');
  assert.equal(first.approval?.tool, 'approval_test_send');
  assert.deepEqual(first.approval?.args, { to: 'ops@acme.test' });
  assert.match(first.text, /Approval needed: Boss wants to run approval_test_send\(\{"to":"ops@acme.test"\}\)/);
  assert.deepEqual(sent, [], 'nothing ran before the approval');

  const second = await turn([approvalResponsePart(first.approval!.id, true)]);
  assert.equal(second.status, 'completed');
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.match(second.text, /done \{"result":"sent to ops@acme.test"\}/);
});

test('delegate: a refusal never runs the call and the model is told', async () => {
  sent.length = 0;
  const boss = new ScriptedLlm('scripted/boss', (req, n) => (n === 1 ? call('approval_test_send', { to: 'x@acme.test' }) : text(`saw ${lastResponse(req)}`)));
  const turn = runner(delegateConfig(), { boss });
  const first = await turn([{ text: 'tell x' }]);
  const second = await turn([approvalResponsePart(first.approval!.id, false)]);
  assert.equal(second.status, 'completed');
  assert.deepEqual(sent, []);
  assert.match(second.text, /rejected/);
});

test('an answer that names no open request fails without running anything', async () => {
  const boss = new ScriptedLlm('scripted/boss', () => text('hi'));
  const r = await runner(delegateConfig(), { boss })([approvalResponsePart('adk-nope', true)]);
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'NO_PENDING_APPROVAL');
  assert.equal(boss.calls ?? 0, 0);
});

test('dispatch: the resume skips the classifier and runs the route that asked', async () => {
  sent.length = 0;
  const config = {
    syndicate_name: 'Desk',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      {
        name: 'Outreach',
        model: 'scripted/outreach',
        instruction: 'Send.',
        description: 'sends notes',
        tools: ['approval_test_send'],
        require_approval: ['approval_test_send'],
      },
    ],
    dispatch: { default_route: 'Chat' },
  } as unknown as SyndicateYamlConfig;
  let routed = 0;
  const router = new ScriptedLlm('scripted/router', () => (routed++, text('{"route":"Outreach","reason":"a send"}')));
  const chat = new ScriptedLlm('scripted/chat', () => text('chat'));
  const outreach = new ScriptedLlm('scripted/outreach', (req, n) => (n === 1 ? call('approval_test_send', { to: 'pr@acme.test' }) : text(`sent ${lastResponse(req)}`)));
  const turn = runner(config, { router, chat, outreach });

  const first = await turn([{ text: 'email pr' }]);
  assert.equal(first.status, 'input-required');
  assert.equal(first.approval?.agent, 'Outreach');
  const second = await turn([approvalResponsePart(first.approval!.id, true)]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.equal(second.route?.decidedBy, 'approval');
  assert.equal(routed, 1, 'the classifier ran once, for the original message');
  assert.deepEqual(sent, ['pr@acme.test']);
});

test('a request the user moved on from is no longer pending', () => {
  const request = {
    author: 'Boss',
    content: { role: 'user', parts: [{ functionCall: { id: 'adk-1', name: 'adk_request_confirmation', args: { originalFunctionCall: { name: 't', args: {} } } } }] },
  } as unknown as Event;
  assert.equal(pendingApproval([request])?.id, 'adk-1');
  const moved = { author: 'user', content: { role: 'user', parts: [{ text: 'never mind' }] } } as unknown as Event;
  assert.equal(pendingApproval([request, moved]), undefined);
});

test('the schema: gates only on tools the agent has, on a delegated subagent too (ADR 0110, ADR 0118)', () => {
  const base = delegateConfig() as any;
  assert.doesNotThrow(() => validateSyndicateConfig(structuredClone(base), 'ok'));
  const unknown = structuredClone(base);
  unknown.orchestrator.require_approval = ['web_extract'];
  assert.throws(() => validateSyndicateConfig(unknown, 'x'), /'web_extract' is not in this agent's tools/);
  const delegated = structuredClone(base);
  delegated.subagents = [{ name: 'Helper', description: 'd', model: 'm', instruction: 'i', tools: ['approval_test_send'], require_approval: ['approval_test_send'] }];
  assert.doesNotThrow(() => validateSyndicateConfig(delegated, 'x'));
  // Skill scripts on a delegated subagent pause the turn as its gates do (ADR 0118).
  delegated.subagents[0].skills = { dir: 'skills', scripts: 'local' };
  assert.doesNotThrow(() => validateSyndicateConfig(delegated, 'x'));
});

test('storage keeps a stored function call replayable with Gemini\'s skip signature', () => {
  const event = {
    author: 'Boss',
    content: { role: 'model', parts: [{ text: 'thinking', thoughtSignature: 'A'.repeat(5000) }, { functionCall: { name: 'x', args: {} }, thoughtSignature: 'B'.repeat(5000) }] },
  } as unknown as Event;
  const parts = trimEventForStorage(event).content!.parts as any[];
  assert.equal(parts[0].thoughtSignature, undefined);
  assert.equal(parts[1].thoughtSignature, SKIP_SIGNATURE);
});
