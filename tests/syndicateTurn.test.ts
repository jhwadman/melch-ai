/**
 * Offline tests of the turn runtime (lib/runtime/syndicateTurn.ts) driving
 * the engine's own loop with scripted models, on the engine's in-process
 * session store. No network. This is the boundary suite (ADR 0024): every
 * surface runs turns through runSyndicateTurn, so if a change to the loop
 * moves delegation, the step cap, cancellation, deadlines, session history,
 * plan-dispatch, fallback or approvals, a test here fails.
 *
 * `native` is the only runtime: `adk`, removed in 1.0.0 (ADR 0107), is
 * refused with RuntimeRemovedError before any model call. The last case holds
 * a three-turn conversation to the same conversation as ADK 2.2 ran it,
 * recorded in tests/fixtures/adk-reference/syndicateturn.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';

import { RuntimeRemovedError, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import type { CompileOptions } from '../lib/compile.ts';
import type { LlmRequest } from '../lib/models/genaiMapping.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, hangUntilAborted, scriptedResolver, sentTexts, text } from './helpers/scriptedLlm.ts';
import {
  ScriptedModel,
  answer,
  failure,
  lastToolResult,
  requestTexts,
  shimResolver,
  streamedAnswer,
  toolCall,
  untilAborted,
} from './helpers/scriptedModel.ts';
import { adkReferences, canonical } from './helpers/adkReference.ts';

// The all-ADK conversation the last case is held to, as ADK 2.2 recorded it
// (tests/fixtures/adk-reference/syndicateturn).
const reference = adkReferences('syndicateTurn');

const APP = 'test-app';
const USER = 'u1';

function delegateConfig(extra: Partial<SyndicateYamlConfig> = {}): SyndicateYamlConfig {
  return {
    syndicate_name: 'Test',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout.' },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
    ...extra,
  } as SyndicateYamlConfig;
}

function turn(config: SyndicateYamlConfig, models: Record<string, ScriptedLlm>, overrides: Record<string, unknown> = {}) {
  return runSyndicateTurn({
    config,
    parts: [{ text: 'find the thing' }],
    appName: APP,
    userId: USER,
    sessionId: 's1',
    sessionService: new InProcessSessionService(),
    compile: { resolveModel: scriptedResolver(models) },
    trace: false,
    ...overrides,
  });
}

test('delegate: the subagent receives the request argument and the relay ships', async () => {
  let scoutInput = '';
  const boss = new ScriptedLlm('scripted/boss', (_req, n) =>
    n === 1 ? call('Scout', { request: 'look in the attic' }) : text('Scout says: it is in the attic'),
  );
  const scout = new ScriptedLlm('scripted/scout', (req: LlmRequest) => {
    scoutInput = sentTexts(req).join(' ');
    return text('it is in the attic');
  });
  const r = await turn(delegateConfig(), { boss, scout });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'Scout says: it is in the attic');
  assert.match(scoutInput, /look in the attic/);
  assert.deepEqual(r.answer?.delegations, ['Scout']);
  assert.equal(r.relayFallback, false);
  assert.equal(r.llmCalls, 3);
});

test('delegate: a relay that returns no text falls back to the last tool result', async () => {
  const boss = new ScriptedLlm('scripted/boss', (_req, n) => (n === 1 ? call('Scout', { request: 'go' }) : text('')));
  const scout = new ScriptedLlm('scripted/scout', () => text('the full specialist report'));
  const r = await turn(delegateConfig(), { boss, scout });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'the full specialist report');
  assert.equal(r.relayFallback, true);
});

test('max_steps caps model calls across the whole turn, subagents included', async () => {
  // The orchestrator delegates forever; every delegation also costs the
  // subagent a call. The turn budget counts both.
  const boss = new ScriptedLlm('scripted/boss', () => call('Scout', { request: 'again' }));
  const scout = new ScriptedLlm('scripted/scout', () => text('still nothing'));
  const r = await turn(delegateConfig({ max_steps: 5 }), { boss, scout });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'STEP_LIMIT');
  assert.equal(r.stopReason, 'step_limit');
  assert.ok(boss.calls + scout.calls <= 5, `made ${boss.calls + scout.calls} calls`);
  assert.equal(r.llmCalls, 5);
});

test('without max_steps, a turn stops at DEFAULT_MAX_STEPS (50) model calls', async () => {
  const boss = new ScriptedLlm('scripted/boss', () => call('Scout', { request: 'again' }));
  const scout = new ScriptedLlm('scripted/scout', () => text('still nothing'));
  const config = delegateConfig();
  assert.equal(config.max_steps, undefined);
  const r = await turn(config, { boss, scout });
  assert.equal(r.error?.code, 'STEP_LIMIT');
  assert.equal(r.llmCalls, 50);
});

test('cancel: aborting the signal stops a hung provider call', async () => {
  const controller = new AbortController();
  const boss = new ScriptedLlm('scripted/boss', (_req, _n, signal) => hangUntilAborted(signal));
  const scout = new ScriptedLlm('scripted/scout', () => text('x'));
  setTimeout(() => controller.abort(), 30);
  const r = await turn(delegateConfig(), { boss, scout }, { signal: controller.signal });
  assert.equal(r.status, 'canceled');
  assert.equal(r.error?.code, 'CANCELED');
});

test('deadline: a turn that exceeds its time budget fails with DEADLINE_EXCEEDED', async () => {
  const boss = new ScriptedLlm('scripted/boss', (_req, _n, signal) => hangUntilAborted(signal));
  const scout = new ScriptedLlm('scripted/scout', () => text('x'));
  const started = Date.now();
  const r = await turn(delegateConfig(), { boss, scout }, { deadlineMs: 40 });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'DEADLINE_EXCEEDED');
  assert.ok(Date.now() - started < 2000);
});

test('session: the second turn sees the first turn in its history', async () => {
  const sessions = new InProcessSessionService();
  const boss = new ScriptedLlm('scripted/boss', (_req, n) => text(n === 1 ? 'first answer' : 'second answer'));
  const config = { syndicate_name: 'Solo', orchestrator: { name: 'Solo', model: 'scripted/boss', instruction: 'x' }, subagents: [] } as any;
  const run = (msg: string) =>
    runSyndicateTurn({
      config,
      parts: [{ text: msg }],
      appName: APP,
      userId: USER,
      sessionId: 'conv',
      sessionService: sessions,
      compile: { resolveModel: scriptedResolver({ boss }) },
      trace: false,
    });
  const first = await run('hello');
  const second = await run('again');
  assert.equal(first.resumedSession, false);
  assert.equal(second.resumedSession, true);
  const history = sentTexts(boss.requests[1]).join(' | ');
  assert.match(history, /hello/);
  assert.match(history, /first answer/);
  assert.match(history, /again/);
});

function dispatchConfig(): SyndicateYamlConfig {
  return {
    syndicate_name: 'Desk',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      { name: 'Research', model: 'scripted/research', instruction: 'Research.', description: 'research' },
    ],
    dispatch: {
      default_route: 'Chat',
      route_overrides: [{ pattern: 'x\\.com/', route: 'Research', reason: 'X link' }],
    },
  } as unknown as SyndicateYamlConfig;
}

test('dispatch: the classifier picks the route and the route answers directly', async () => {
  const router = new ScriptedLlm('scripted/router', () => text('{"route":"Research","reason":"needs sources"}'));
  const chat = new ScriptedLlm('scripted/chat', () => text('chat answer'));
  const research = new ScriptedLlm('scripted/research', () => text('research answer'));
  const progress: string[] = [];
  const r = await turn(dispatchConfig(), { router, chat, research }, { events: { onProgress: (t: string) => progress.push(t) } });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'research answer');
  assert.equal(r.route?.route, 'Research');
  assert.equal(r.route?.decidedBy, 'classifier');
  assert.equal(chat.calls, 0);
  assert.ok(progress.some((p) => p.startsWith('Routed to Research')));
});

test('dispatch: an override pins the route without calling the classifier', async () => {
  const router = new ScriptedLlm('scripted/router', () => text('{"route":"Chat"}'));
  const chat = new ScriptedLlm('scripted/chat', () => text('chat'));
  const research = new ScriptedLlm('scripted/research', () => text('research'));
  const r = await turn(dispatchConfig(), { router, chat, research }, { parts: [{ text: 'read https://x.com/a/status/1' }] });
  assert.equal(r.route?.route, 'Research');
  assert.equal(r.route?.decidedBy, 'override');
  assert.equal(router.calls, 0);
});

test('dispatch: a failing classifier falls back to default_route and still answers', async () => {
  const router = new ScriptedLlm('scripted/router', () => ({ errorCode: '503', errorMessage: 'overloaded' }) as any);
  const chat = new ScriptedLlm('scripted/chat', () => text('default answer'));
  const research = new ScriptedLlm('scripted/research', () => text('research'));
  const r = await turn(dispatchConfig(), { router, chat, research });
  assert.equal(r.status, 'completed');
  assert.equal(r.route?.route, 'Chat');
  assert.equal(r.route?.fellBack, true);
  assert.equal(r.text, 'default answer');
});

test('a model error fails the turn and names the stage', async () => {
  const boss = new ScriptedLlm('scripted/boss', () => ({ errorCode: '429', errorMessage: 'rate limited' }) as any);
  const scout = new ScriptedLlm('scripted/scout', () => text('x'));
  const r = await turn(delegateConfig(), { boss, scout });
  assert.equal(r.status, 'failed');
  assert.equal(r.failedStage, 'delegate');
  assert.equal(r.error?.code, '429');
});

test('includeContents: none keeps earlier turns out of the model request', async () => {
  const sessions = new InProcessSessionService();
  const boss = new ScriptedLlm('scripted/boss', (_req, n) => text(`answer ${n}`));
  const config = {
    syndicate_name: 'Stateless',
    orchestrator: { name: 'Stateless', model: 'scripted/boss', instruction: 'x', includeContents: 'none' },
    subagents: [],
  } as any;
  const run = (msg: string) =>
    runSyndicateTurn({
      config,
      parts: [{ text: msg }],
      appName: APP,
      userId: USER,
      sessionId: 'stateless',
      sessionService: sessions,
      compile: { resolveModel: scriptedResolver({ boss }) },
      trace: false,
    });
  await run('first document: SECRET-A');
  await run('second document');
  const history = sentTexts(boss.requests[1]).join(' | ');
  assert.doesNotMatch(history, /SECRET-A/);
  assert.match(history, /second document/);
});

test('a caller with no model resolver still gets the framework adapters (step cap, cancel)', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const r = await runSyndicateTurn({
    config: {
      syndicate_name: 'Plain',
      memory_system: 'internal-only',
      orchestrator: { name: 'Lead', model: 'gemini-3.5-flash-lite', instruction: 'Lead.' },
      subagents: [],
    } as SyndicateYamlConfig,
    parts: [{ text: 'hi' }],
    appName: 'test',
    userId: 'u',
    sessionId: 's-plain',
    sessionService: new InProcessSessionService(),
    signal: aborted.signal,
    trace: false,
  });
  assert.notEqual(r.status, 'completed');
  assert.equal(r.llmCalls, 0);
});

// ── A contract adapter (lib/models/contract.ts) ─────────────────────────────
// A ModelAdapter on the engine's own contract (ScriptedModel) runs each turn
// below: what it is sent, and what the turn makes of what it answers.

/** What a turn amounted to (call ids aside, see withoutIds). */
function outcome(r: SyndicateTurnResult) {
  return withoutIds({
    status: r.status,
    text: r.text,
    error: r.error?.code,
    failedStage: r.failedStage,
    stopReason: r.stopReason,
    llmCalls: r.llmCalls,
    approval: r.approval ? { agent: r.approval.agent, tool: r.approval.tool, args: r.approval.args } : undefined,
    delegations: r.answer?.delegations,
    toolCalls: r.answer?.toolCalls,
    relayFallback: r.relayFallback,
  });
}

/** Ids are minted per run (by the scripts, and by the loop); everything else must match. */
const CALL_ID_KEYS = new Set(['id', 'functionCallId']);
const withoutIds = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value ?? null, (key, v) => (CALL_ID_KEYS.has(key) && typeof v === 'string' ? '<id>' : v)));

/** One conversation: its own session store, the given models, any number of turns. */
function conversation(config: SyndicateYamlConfig, resolveModel: NonNullable<CompileOptions['resolveModel']>) {
  const sessionService = new InProcessSessionService();
  const sessionId = 'adapter-turns';
  return {
    turn: (parts: any[] = [{ text: 'find the thing' }], overrides: Record<string, unknown> = {}) =>
      runSyndicateTurn({
        config,
        parts,
        appName: APP,
        userId: USER,
        sessionId,
        sessionService,
        compile: { resolveModel, log: () => {} },
        trace: false,
        ...overrides,
      }),
    /** The stored events, as author and content. */
    history: async () => {
      const session = await sessionService.get({ appName: APP, userId: USER, sessionId });
      return (session?.events ?? []).map((e) => withoutIds({ author: e.author, content: e.content }));
    },
  };
}

const soloConfig = (): SyndicateYamlConfig =>
  ({ syndicate_name: 'Solo', orchestrator: { name: 'Solo', model: 'scripted/boss', instruction: 'Answer briefly.' }, subagents: [] }) as any;

test('adapter: a plain answer completes the turn, and the adapter is sent the instruction and the message', async () => {
  const boss = new ScriptedModel('scripted/boss', () => answer('the answer'));
  const chat = conversation(soloConfig(), shimResolver({ boss }));

  const s = await chat.turn();
  assert.equal(s.status, 'completed');
  assert.equal(s.text, 'the answer');
  assert.deepEqual(await chat.history(), [
    { author: 'user', content: { role: 'user', parts: [{ text: 'find the thing' }] } },
    { author: 'Solo', content: { role: 'model', parts: [{ text: 'the answer' }] } },
  ]);

  const req = boss.requests[0];
  assert.equal(req.model, 'scripted/boss');
  assert.equal(req.stream, false);
  assert.match(req.system ?? '', /Answer briefly\./);
  assert.deepEqual(requestTexts(req), ['find the thing']);
});

test('adapter: the second turn sees the first in its history', async () => {
  const boss = new ScriptedModel('scripted/boss', (_r, n) => answer(n === 1 ? 'first answer' : 'second answer'));
  const chat = conversation(soloConfig(), shimResolver({ boss }));

  for (const msg of ['hello', 'again']) assert.equal((await chat.turn([{ text: msg }])).status, 'completed');
  assert.equal((await chat.history()).length, 4);
  assert.deepEqual(requestTexts(boss.requests[1]), ['hello', 'first answer', 'again']);
});

test('adapter: a tool call and its result (delegation) complete the turn', async () => {
  const boss = new ScriptedModel('scripted/boss', (req, n) => {
    if (n === 1) return toolCall('Scout', { request: 'look in the attic' });
    const result = lastToolResult(req);
    return answer(`Scout says: ${result?.name === 'Scout' ? String(result.result) : '?'}`);
  });
  const scout = new ScriptedModel('scripted/scout', () => answer('it is in the attic'));
  const chat = conversation(delegateConfig(), shimResolver({ boss, scout }));

  const s = await chat.turn();
  assert.equal(s.status, 'completed');
  assert.equal(s.text, 'Scout says: it is in the attic');
  assert.deepEqual(s.answer?.delegations, ['Scout']);
  assert.equal(s.llmCalls, 3);
  assert.equal(s.relayFallback, false);

  // The subagent was sent the request; the orchestrator's second call carried the call and its result.
  assert.match(requestTexts(scout.requests[0]).join(' '), /look in the attic/);
  const second = boss.requests[1];
  const asked = second.messages.find((m) => m.role === 'assistant')?.parts[0];
  assert.equal(asked?.type, 'toolCall');
  assert.deepEqual(lastToolResult(second)?.result, 'it is in the attic');
  assert.ok(second.tools?.some((t) => t.name === 'Scout'), 'the subagent is declared as a tool');
});

test('adapter: streamed partials reach the caller as deltas, and the whole text is stored once', async () => {
  const boss = new ScriptedModel('scripted/boss', () => streamedAnswer('Hello', ', ', 'world.'));
  const chat = conversation(soloConfig(), shimResolver({ boss }));

  const deltas: string[] = [];
  const s = await chat.turn(undefined, { streaming: true, events: { onTextDelta: (d: string) => deltas.push(d) } });
  assert.equal(s.text, 'Hello, world.');
  assert.deepEqual(deltas, ['Hello', ', ', 'world.']);
  const history = await chat.history();
  assert.equal(history.length, 2);
  assert.deepEqual(history.at(-1), { author: 'Solo', content: { role: 'model', parts: [{ text: 'Hello, world.' }] } });
  assert.equal(boss.requests[0].stream, true);
});

const fallbackConfig = (): SyndicateYamlConfig =>
  ({
    syndicate_name: 'S',
    orchestrator: { name: 'Main', model: 'scripted/primary', fallback_model: 'scripted/backup', instruction: 'Answer.' },
    subagents: [],
  }) as any;

test('adapter: fallback_model answers a retryable error, and a non-retryable one fails the turn', async () => {
  for (const status of [503, 400]) {
    resetCircuits();
    const retryable = status === 503;
    const primary = new ScriptedModel('scripted/primary', () => failure({ code: 'SCRIPTED_ERROR', message: `HTTP ${status}`, retryable, status }));
    const backup = new ScriptedModel('scripted/backup', () => answer('from the backup'));
    const s = await conversation(fallbackConfig(), shimResolver({ primary, backup })).turn();

    assert.equal(primary.calls, 1, `HTTP ${status}`);
    if (retryable) {
      assert.equal(s.status, 'completed');
      assert.equal(s.text, 'from the backup');
      assert.equal(backup.calls, 1);
      assert.equal(backup.requests[0].model, 'scripted/backup', 'the fallback gets its own model id');
    } else {
      assert.equal(s.status, 'failed');
      assert.equal(s.error?.code, 'SCRIPTED_ERROR');
      assert.equal(backup.calls, 0, 'a 400 is never redirected');
    }
  }
  resetCircuits();
});

test('adapter: a model error with no fallback fails the turn and names the stage', async () => {
  const boss = new ScriptedModel('scripted/boss', () => failure({ code: '429', message: 'rate limited' }));
  const s = await conversation(delegateConfig(), shimResolver({ boss, scout: new ScriptedModel('scripted/scout', () => answer('x')) })).turn();
  assert.equal(s.status, 'failed');
  assert.equal(s.failedStage, 'delegate');
  assert.equal(s.error?.code, '429');
});

test('adapter: cancel aborts the signal the adapter was given, and the turn is canceled', async () => {
  let seen: AbortSignal | undefined;
  const boss = new ScriptedModel('scripted/boss', (_req, _n, signal) => ((seen = signal), untilAborted(signal)));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const s = await conversation(delegateConfig(), shimResolver({ boss, scout: new ScriptedModel('scripted/scout', () => answer('x')) })).turn(undefined, {
    signal: controller.signal,
  });

  assert.equal(s.status, 'canceled');
  assert.equal(s.error?.code, 'CANCELED');
  assert.equal(seen?.aborted, true, 'the request carried the turn signal');
});

test('adapter: max_steps refuses the call past the budget before it reaches the adapter', async () => {
  const boss = new ScriptedModel('scripted/boss', () => toolCall('Scout', { request: 'again' }));
  const scout = new ScriptedModel('scripted/scout', () => answer('still nothing'));
  const s = await conversation(delegateConfig({ max_steps: 5 }), shimResolver({ boss, scout })).turn();

  assert.equal(s.status, 'failed');
  assert.equal(s.error?.code, 'STEP_LIMIT');
  assert.equal(s.stopReason, 'step_limit');
  assert.equal(s.llmCalls, 5);
  assert.equal(boss.calls + scout.calls, 5, 'the refused sixth call never reached an adapter');
});

// A gated tool for the approval case (ADR 0028).
const gatedSent: string[] = [];
registerTool(
  'shim_test_send',
  defineTool({
    name: 'shim_test_send',
    description: 'Send a note.',
    schema: z.object({ to: z.string() }),
    execute: async ({ to }) => {
      gatedSent.push(to);
      return `sent to ${to}`;
    },
  }),
  { override: true },
);
const gatedConfig = (): SyndicateYamlConfig =>
  ({
    syndicate_name: 'Mailer',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Send notes.', tools: ['shim_test_send'], require_approval: ['shim_test_send'] },
    subagents: [],
  }) as any;

test('adapter: an approval pauses the turn, and the approval resumes it', async () => {
  gatedSent.length = 0;
  const boss = new ScriptedModel('scripted/boss', (req, n) => (n === 1 ? toolCall('shim_test_send', { to: 'ops@acme.test' }) : answer(`done: ${lastToolResult(req)?.result}`)));
  const chat = conversation(gatedConfig(), shimResolver({ boss }));
  const s1 = await chat.turn([{ text: 'tell ops' }]);
  assert.equal(s1.status, 'input-required');
  assert.equal(s1.approval?.tool, 'shim_test_send');
  assert.deepEqual(s1.approval?.args, { to: 'ops@acme.test' });
  assert.deepEqual(gatedSent, [], 'nothing ran before the approval');

  const s2 = await chat.turn([approvalResponsePart(s1.approval!.id, true)]);
  assert.equal(s2.status, 'completed', s2.error?.message);
  assert.equal(s2.text, 'done: sent to ops@acme.test');
  assert.deepEqual(gatedSent, ['ops@acme.test']);
  assert.equal(boss.calls, 2);
});

// ── The runtime option ───────────────────────────────────────────────────────

test("runtime 'adk' and MELCHIZEDEK_RUNTIME=adk are refused with RuntimeRemovedError naming 1.0.0, before any model call; 'native' is accepted", async () => {
  const boss = new ScriptedModel('scripted/boss', () => answer('the answer'));
  const chat = conversation(soloConfig(), shimResolver({ boss }));
  const removed = (e: unknown) => e instanceof RuntimeRemovedError && e.runtime === 'adk' && e.message.includes('1.0.0');

  await assert.rejects(chat.turn(undefined, { runtime: 'adk' }), removed);
  assert.equal(boss.calls, 0, 'no model call');

  const had = Object.hasOwn(process.env, 'MELCHIZEDEK_RUNTIME');
  const saved = process.env.MELCHIZEDEK_RUNTIME;
  process.env.MELCHIZEDEK_RUNTIME = 'adk';
  try {
    await assert.rejects(chat.turn(), removed);
    assert.equal(boss.calls, 0, 'no model call');
  } finally {
    if (had) process.env.MELCHIZEDEK_RUNTIME = saved;
    else delete process.env.MELCHIZEDEK_RUNTIME;
  }
  assert.deepEqual(await chat.history(), [], 'nothing was stored');

  const ok = await chat.turn(undefined, { runtime: 'native' });
  assert.equal(ok.status, 'completed');
  assert.equal(ok.text, 'the answer');
  assert.equal(boss.calls, 1);
});

// ── Held to ADK's recording ──────────────────────────────────────────────────

registerTool(
  'cross_runtime_lookup',
  defineTool({
    name: 'cross_runtime_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }) => `value of ${key}`,
  }),
  { override: true },
);

/** Three turns of a DELEGATE syndicate with a tool; one store, fresh models. */
async function crossConversation() {
  resetCircuits();
  const config = delegateConfig({ orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout.', tools: ['cross_runtime_lookup'] } } as any);
  const boss = new ScriptedModel('scripted/boss', (req, n) => {
    if (n === 1) return toolCall('cross_runtime_lookup', { key: 'attic' }, 'call-look');
    if (n === 2) return toolCall('Scout', { request: `search ${lastToolResult(req)?.result}` }, 'call-scout');
    if (n === 3) return answer(`Scout says: ${lastToolResult(req)?.result}`);
    return answer(`turn ${n}: I remember ${requestTexts(req).filter((t) => t.startsWith('Scout says')).join('; ')}`);
  });
  const scout = new ScriptedModel('scripted/scout', (req) => answer(`found it (${requestTexts(req).at(-1)})`));
  const sessionService = new InProcessSessionService();
  const results: SyndicateTurnResult[] = [];
  for (const message of ['find the thing', 'what did Scout say?', 'and now?']) {
    results.push(
      await runSyndicateTurn({
        config,
        parts: [{ text: message }],
        appName: APP,
        userId: USER,
        sessionId: 'cross',
        sessionService,
        compile: { resolveModel: shimResolver({ boss, scout }), log: () => {} },
        trace: false,
      }),
    );
  }
  const session = await sessionService.get({ appName: APP, userId: USER, sessionId: 'cross' });
  const events = (session?.events ?? []).map((e) => withoutIds({ ...e, id: '<id>', timestamp: 0, invocationId: '<inv>' }));
  return { results, events, boss, scout };
}

/** What the case compares of a conversation. */
const crossComparable = (c: Awaited<ReturnType<typeof crossConversation>>) => ({
  results: c.results.map(outcome),
  events: c.events,
  bossCalls: c.boss.calls,
  bossRequests: c.boss.requests.map((r) => withoutIds(r.messages)),
});

test('a three-turn conversation with a tool and a delegation: the results, the stored events and the history match the recorded all-ADK conversation', async () => {
  // The same three turns all on ADK, as recorded.
  const adk = await reference<ReturnType<typeof crossComparable>>('cross-conversation-all-adk');
  const run = await crossConversation();
  // The reference's canonical form (adkReference.ts), applied to this run too: its events' ids are already '<id>'.
  const got = canonical(crossComparable(run));
  assert.deepEqual(got.results, adk.results, 'the results');
  assert.deepEqual(got.events, adk.events, 'the stored events');
  assert.equal(got.bossCalls, adk.bossCalls);
  assert.deepEqual(got.bossRequests, adk.bossRequests, 'every request saw the same history');
  assert.equal(run.results[1]?.text, 'turn 4: I remember Scout says: found it (search value of attic)');
});
