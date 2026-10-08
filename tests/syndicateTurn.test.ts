/**
 * Offline tests of the turn runtime (lib/runtime/syndicateTurn.ts) driving
 * REAL ADK objects — Runner, LlmAgent, AgentTool, InMemorySessionService —
 * with scripted models. No network. These are the characterization suite for
 * the boundary between this framework and ADK: if an ADK upgrade or a
 * replacement of the loop changes delegation, the step cap, cancellation,
 * session history or plan-dispatch, a test here fails.
 *
 * Every case runs on both runtimes (tests/helpers/runtime.ts, WS2-12): the
 * ADK Runner and the engine's own loop must both pass it (ADR 0045, G2).
 * The last cases write a conversation on one runtime and continue it on the
 * other, both ways: a session native wrote resumes under adk, the rollback
 * path until 1.0.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { FunctionTool, InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import type { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';
import { z } from 'zod';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { providerErrorResponse } from '../lib/models/errorResponse.ts';
import { resetCircuits } from '../lib/models/fallback.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, hangUntilAborted, scriptedResolver, sentTexts, streamed, text } from './helpers/scriptedLlm.ts';
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
import { acrossRuntimes, forEachRuntime, runtimeOption } from './helpers/runtime.ts';
import type { RuntimeName } from './helpers/runtime.ts';
import { adkReferences, canonical } from './helpers/adkReference.ts';

// The all-ADK conversation the cross-runtime case is held to is recorded
// (tests/fixtures/adk-reference/syndicateturn); it runs only under ADK_REFERENCE=live|record.
const reference = adkReferences('syndicateTurn');

setLogLevel(LogLevel.ERROR);

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
    ...runtimeOption(),
    config,
    parts: [{ text: 'find the thing' }],
    appName: APP,
    userId: USER,
    sessionId: 's1',
    sessionService: new InMemorySessionService(),
    compile: { resolveModel: scriptedResolver(models) },
    trace: false,
    ...overrides,
  });
}

forEachRuntime('delegate: the subagent receives the request argument and the relay ships', async () => {
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

forEachRuntime('delegate: a relay that returns no text falls back to the last tool result', async () => {
  const boss = new ScriptedLlm('scripted/boss', (_req, n) => (n === 1 ? call('Scout', { request: 'go' }) : text('')));
  const scout = new ScriptedLlm('scripted/scout', () => text('the full specialist report'));
  const r = await turn(delegateConfig(), { boss, scout });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'the full specialist report');
  assert.equal(r.relayFallback, true);
});

forEachRuntime('max_steps caps model calls across the whole turn, subagents included', async () => {
  // The orchestrator delegates forever; every delegation also costs the
  // subagent a call. ADK's own per-Runner ceiling is 500 and resets inside
  // each AgentTool, so without the turn budget this would run ~1000 calls.
  const boss = new ScriptedLlm('scripted/boss', () => call('Scout', { request: 'again' }));
  const scout = new ScriptedLlm('scripted/scout', () => text('still nothing'));
  const r = await turn(delegateConfig({ max_steps: 5 }), { boss, scout });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'STEP_LIMIT');
  assert.equal(r.stopReason, 'step_limit');
  assert.ok(boss.calls + scout.calls <= 5, `made ${boss.calls + scout.calls} calls`);
  assert.equal(r.llmCalls, 5);
});

forEachRuntime('without max_steps, a turn stops at DEFAULT_MAX_STEPS (50) model calls', async () => {
  const boss = new ScriptedLlm('scripted/boss', () => call('Scout', { request: 'again' }));
  const scout = new ScriptedLlm('scripted/scout', () => text('still nothing'));
  const config = delegateConfig();
  assert.equal(config.max_steps, undefined);
  const r = await turn(config, { boss, scout });
  assert.equal(r.error?.code, 'STEP_LIMIT');
  assert.equal(r.llmCalls, 50);
});

forEachRuntime('cancel: aborting the signal stops a hung provider call', async () => {
  const controller = new AbortController();
  const boss = new ScriptedLlm('scripted/boss', (_req, _n, signal) => hangUntilAborted(signal));
  const scout = new ScriptedLlm('scripted/scout', () => text('x'));
  setTimeout(() => controller.abort(), 30);
  const r = await turn(delegateConfig(), { boss, scout }, { signal: controller.signal });
  assert.equal(r.status, 'canceled');
  assert.equal(r.error?.code, 'CANCELED');
});

forEachRuntime('deadline: a turn that exceeds its time budget fails with DEADLINE_EXCEEDED', async () => {
  const boss = new ScriptedLlm('scripted/boss', (_req, _n, signal) => hangUntilAborted(signal));
  const scout = new ScriptedLlm('scripted/scout', () => text('x'));
  const started = Date.now();
  const r = await turn(delegateConfig(), { boss, scout }, { deadlineMs: 40 });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'DEADLINE_EXCEEDED');
  assert.ok(Date.now() - started < 2000);
});

forEachRuntime('session: the second turn sees the first turn in its history', async () => {
  const sessions = new InMemorySessionService();
  const boss = new ScriptedLlm('scripted/boss', (_req, n) => text(n === 1 ? 'first answer' : 'second answer'));
  const config = { syndicate_name: 'Solo', orchestrator: { name: 'Solo', model: 'scripted/boss', instruction: 'x' }, subagents: [] } as any;
  const run = (msg: string) =>
    runSyndicateTurn({
      ...runtimeOption(),
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

forEachRuntime('dispatch: the classifier picks the route and the route answers directly', async () => {
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

forEachRuntime('dispatch: an override pins the route without calling the classifier', async () => {
  const router = new ScriptedLlm('scripted/router', () => text('{"route":"Chat"}'));
  const chat = new ScriptedLlm('scripted/chat', () => text('chat'));
  const research = new ScriptedLlm('scripted/research', () => text('research'));
  const r = await turn(dispatchConfig(), { router, chat, research }, { parts: [{ text: 'read https://x.com/a/status/1' }] });
  assert.equal(r.route?.route, 'Research');
  assert.equal(r.route?.decidedBy, 'override');
  assert.equal(router.calls, 0);
});

forEachRuntime('dispatch: a failing classifier falls back to default_route and still answers', async () => {
  const router = new ScriptedLlm('scripted/router', () => ({ errorCode: '503', errorMessage: 'overloaded' }) as any);
  const chat = new ScriptedLlm('scripted/chat', () => text('default answer'));
  const research = new ScriptedLlm('scripted/research', () => text('research'));
  const r = await turn(dispatchConfig(), { router, chat, research });
  assert.equal(r.status, 'completed');
  assert.equal(r.route?.route, 'Chat');
  assert.equal(r.route?.fellBack, true);
  assert.equal(r.text, 'default answer');
});

forEachRuntime('a model error fails the turn and names the stage', async () => {
  const boss = new ScriptedLlm('scripted/boss', () => ({ errorCode: '429', errorMessage: 'rate limited' }) as any);
  const scout = new ScriptedLlm('scripted/scout', () => text('x'));
  const r = await turn(delegateConfig(), { boss, scout });
  assert.equal(r.status, 'failed');
  assert.equal(r.failedStage, 'delegate');
  assert.equal(r.error?.code, '429');
});

forEachRuntime('includeContents: none keeps earlier turns out of the model request', async () => {
  const sessions = new InMemorySessionService();
  const boss = new ScriptedLlm('scripted/boss', (_req, n) => text(`answer ${n}`));
  const config = {
    syndicate_name: 'Stateless',
    orchestrator: { name: 'Stateless', model: 'scripted/boss', instruction: 'x', includeContents: 'none' },
    subagents: [],
  } as any;
  const run = (msg: string) =>
    runSyndicateTurn({
      ...runtimeOption(),
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

forEachRuntime('a caller with no model resolver still gets the framework adapters (step cap, cancel)', async () => {
  const { LLMRegistry } = await import('@google/adk');
  const { TracedGemini } = await import('../lib/models/registry.ts');
  const aborted = new AbortController();
  aborted.abort();
  const r = await runSyndicateTurn({
    ...runtimeOption(),
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
    sessionService: new InMemorySessionService(),
    signal: aborted.signal,
    trace: false,
  });
  assert.equal(LLMRegistry.resolve('gemini-3.5-flash-lite'), TracedGemini);
  assert.notEqual(r.status, 'completed');
  assert.equal(r.llmCalls, 0);
});

// ── The ADK shim (lib/models/adkShim.ts, ADR 0053) ───────────────────────────
// A ModelAdapter on the engine's own contract, behind the shim, runs each
// turn below under ADK. Every case runs twice: once with the scripted ADK
// model above, once with the scripted contract model, and the two turns must
// come out the same, down to the history stored in the session.

/** What a turn amounted to, for comparing two runs of it (call ids aside, see withoutIds). */
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

/** Ids are minted per run (by the scripts, and by ADK); everything else must match. */
const CALL_ID_KEYS = new Set(['id', 'functionCallId']);
const withoutIds = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value ?? null, (key, v) => (CALL_ID_KEYS.has(key) && typeof v === 'string' ? '<id>' : v)));

/** One conversation: its own session store, the given models, any number of turns. */
function conversation(config: SyndicateYamlConfig, resolveModel: (id: string | undefined) => BaseLlm) {
  const sessionService = new InMemorySessionService();
  const sessionId = 'shim-parity';
  return {
    turn: (parts: any[] = [{ text: 'find the thing' }], overrides: Record<string, unknown> = {}) =>
      runSyndicateTurn({
        ...runtimeOption(),
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
      const session = await sessionService.getSession({ appName: APP, userId: USER, sessionId });
      return (session?.events ?? []).map((e) => withoutIds({ author: e.author, content: e.content }));
    },
  };
}

const soloConfig = (): SyndicateYamlConfig =>
  ({ syndicate_name: 'Solo', orchestrator: { name: 'Solo', model: 'scripted/boss', instruction: 'Answer briefly.' }, subagents: [] }) as any;

forEachRuntime('shim: a plain answer is the same turn, and the adapter is sent the instruction and the message', async () => {
  const adk = conversation(soloConfig(), scriptedResolver({ boss: new ScriptedLlm('scripted/boss', () => text('the answer')) }));
  const boss = new ScriptedModel('scripted/boss', () => answer('the answer'));
  const shim = conversation(soloConfig(), shimResolver({ boss }));

  const [a, s] = [await adk.turn(), await shim.turn()];
  assert.equal(s.status, 'completed');
  assert.equal(s.text, 'the answer');
  assert.deepEqual(outcome(s), outcome(a));
  assert.deepEqual(await shim.history(), await adk.history());

  const req = boss.requests[0];
  assert.equal(req.model, 'scripted/boss');
  assert.equal(req.stream, false);
  assert.match(req.system ?? '', /Answer briefly\./);
  assert.deepEqual(requestTexts(req), ['find the thing']);
});

forEachRuntime('shim: the second turn sees the first in its history', async () => {
  const adk = conversation(soloConfig(), scriptedResolver({ boss: new ScriptedLlm('scripted/boss', (_r, n) => text(n === 1 ? 'first answer' : 'second answer')) }));
  const boss = new ScriptedModel('scripted/boss', (_r, n) => answer(n === 1 ? 'first answer' : 'second answer'));
  const shim = conversation(soloConfig(), shimResolver({ boss }));

  for (const msg of ['hello', 'again']) {
    const [a, s] = [await adk.turn([{ text: msg }]), await shim.turn([{ text: msg }])];
    assert.deepEqual(outcome(s), outcome(a));
  }
  assert.deepEqual(await shim.history(), await adk.history());
  assert.deepEqual(requestTexts(boss.requests[1]), ['hello', 'first answer', 'again']);
});

forEachRuntime('shim: a tool call and its result (delegation) is the same turn', async () => {
  const adk = conversation(
    delegateConfig(),
    scriptedResolver({
      boss: new ScriptedLlm('scripted/boss', (_req, n) => (n === 1 ? call('Scout', { request: 'look in the attic' }) : text('Scout says: it is in the attic'))),
      scout: new ScriptedLlm('scripted/scout', () => text('it is in the attic')),
    }),
  );
  const boss = new ScriptedModel('scripted/boss', (req, n) => {
    if (n === 1) return toolCall('Scout', { request: 'look in the attic' });
    const result = lastToolResult(req);
    return answer(`Scout says: ${result?.name === 'Scout' ? String(result.result) : '?'}`);
  });
  const scout = new ScriptedModel('scripted/scout', () => answer('it is in the attic'));
  const shim = conversation(delegateConfig(), shimResolver({ boss, scout }));

  const [a, s] = [await adk.turn(), await shim.turn()];
  assert.equal(s.status, 'completed');
  assert.equal(s.text, 'Scout says: it is in the attic');
  assert.deepEqual(s.answer?.delegations, ['Scout']);
  assert.equal(s.llmCalls, 3);
  assert.deepEqual(outcome(s), outcome(a));
  assert.deepEqual(await shim.history(), await adk.history());

  // The subagent was sent the request; the orchestrator's second call carried the call and its result.
  assert.match(requestTexts(scout.requests[0]).join(' '), /look in the attic/);
  const second = boss.requests[1];
  const asked = second.messages.find((m) => m.role === 'assistant')?.parts[0];
  assert.equal(asked?.type, 'toolCall');
  assert.deepEqual(lastToolResult(second)?.result, 'it is in the attic');
  assert.ok(second.tools?.some((t) => t.name === 'Scout'), 'the subagent is declared as a tool');
});

forEachRuntime('shim: streamed partials reach the caller as the same deltas, and the whole text is stored once', async () => {
  const adk = conversation(soloConfig(), scriptedResolver({ boss: new ScriptedLlm('scripted/boss', () => streamed('Hello', ', ', 'world.')) }));
  const boss = new ScriptedModel('scripted/boss', () => streamedAnswer('Hello', ', ', 'world.'));
  const shim = conversation(soloConfig(), shimResolver({ boss }));

  const deltas = { adk: [] as string[], shim: [] as string[] };
  const a = await adk.turn(undefined, { streaming: true, events: { onTextDelta: (d: string) => deltas.adk.push(d) } });
  const s = await shim.turn(undefined, { streaming: true, events: { onTextDelta: (d: string) => deltas.shim.push(d) } });
  assert.equal(s.text, 'Hello, world.');
  assert.deepEqual(deltas.shim, ['Hello', ', ', 'world.']);
  assert.deepEqual(deltas.shim, deltas.adk);
  assert.deepEqual(outcome(s), outcome(a));
  assert.deepEqual(await shim.history(), await adk.history());
  assert.equal(boss.requests[0].stream, true);
});

const fallbackConfig = (): SyndicateYamlConfig =>
  ({
    syndicate_name: 'S',
    orchestrator: { name: 'Main', model: 'scripted/primary', fallback_model: 'scripted/backup', instruction: 'Answer.' },
    subagents: [],
  }) as any;
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

forEachRuntime('shim: FallbackLlm answers a retryable error from the fallback, and passes a non-retryable one on', async () => {
  for (const status of [503, 400]) {
    resetCircuits();
    const adkPrimary = new ScriptedLlm('scripted/primary', () => providerErrorResponse(httpError(status), 'SCRIPTED_ERROR'));
    const adkBackup = new ScriptedLlm('scripted/backup', () => text('from the backup'));
    const a = await conversation(fallbackConfig(), scriptedResolver({ primary: adkPrimary, backup: adkBackup })).turn();

    resetCircuits();
    const retryable = status === 503;
    const primary = new ScriptedModel('scripted/primary', () => failure({ code: 'SCRIPTED_ERROR', message: `HTTP ${status}`, retryable, status }));
    const backup = new ScriptedModel('scripted/backup', () => answer('from the backup'));
    const s = await conversation(fallbackConfig(), shimResolver({ primary, backup })).turn();

    assert.deepEqual(outcome(s), outcome(a), `HTTP ${status}`);
    assert.deepEqual([primary.calls, backup.calls], [adkPrimary.calls, adkBackup.calls]);
    if (retryable) {
      assert.equal(s.status, 'completed');
      assert.equal(s.text, 'from the backup');
      assert.equal(backup.requests[0].model, 'scripted/backup', 'the fallback gets its own model id');
    } else {
      assert.equal(s.status, 'failed');
      assert.equal(s.error?.code, 'SCRIPTED_ERROR');
      assert.equal(backup.calls, 0, 'a 400 is never redirected');
    }
  }
  resetCircuits();
});

forEachRuntime('shim: a model error with no fallback fails the turn and names the stage', async () => {
  const a = await conversation(
    delegateConfig(),
    scriptedResolver({
      boss: new ScriptedLlm('scripted/boss', () => ({ errorCode: '429', errorMessage: 'rate limited' }) as LlmResponse),
      scout: new ScriptedLlm('scripted/scout', () => text('x')),
    }),
  ).turn();
  const boss = new ScriptedModel('scripted/boss', () => failure({ code: '429', message: 'rate limited' }));
  const s = await conversation(delegateConfig(), shimResolver({ boss, scout: new ScriptedModel('scripted/scout', () => answer('x')) })).turn();
  assert.equal(s.status, 'failed');
  assert.equal(s.failedStage, 'delegate');
  assert.equal(s.error?.code, '429');
  assert.deepEqual(outcome(s), outcome(a));
});

forEachRuntime('shim: cancel aborts the signal the adapter was given, and the turn is canceled', async () => {
  const run = async (resolveModel: (id: string | undefined) => BaseLlm) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    return conversation(delegateConfig(), resolveModel).turn(undefined, { signal: controller.signal });
  };
  const a = await run(
    scriptedResolver({
      boss: new ScriptedLlm('scripted/boss', (_req, _n, signal) => hangUntilAborted(signal)),
      scout: new ScriptedLlm('scripted/scout', () => text('x')),
    }),
  );
  let seen: AbortSignal | undefined;
  const boss = new ScriptedModel('scripted/boss', (_req, _n, signal) => ((seen = signal), untilAborted(signal)));
  const s = await run(shimResolver({ boss, scout: new ScriptedModel('scripted/scout', () => answer('x')) }));

  assert.equal(s.status, 'canceled');
  assert.equal(s.error?.code, 'CANCELED');
  assert.equal(seen?.aborted, true, 'the request carried the turn signal');
  assert.deepEqual(outcome(s), outcome(a));
});

forEachRuntime('shim: max_steps refuses the call past the budget before it reaches the adapter', async () => {
  const adkBoss = new ScriptedLlm('scripted/boss', () => call('Scout', { request: 'again' }));
  const adkScout = new ScriptedLlm('scripted/scout', () => text('still nothing'));
  const a = await conversation(delegateConfig({ max_steps: 5 }), scriptedResolver({ boss: adkBoss, scout: adkScout })).turn();

  const boss = new ScriptedModel('scripted/boss', () => toolCall('Scout', { request: 'again' }));
  const scout = new ScriptedModel('scripted/scout', () => answer('still nothing'));
  const s = await conversation(delegateConfig({ max_steps: 5 }), shimResolver({ boss, scout })).turn();

  assert.equal(s.status, 'failed');
  assert.equal(s.error?.code, 'STEP_LIMIT');
  assert.equal(s.stopReason, 'step_limit');
  assert.equal(s.llmCalls, 5);
  assert.equal(boss.calls + scout.calls, 5, 'the refused sixth call never reached an adapter');
  assert.deepEqual([boss.calls, scout.calls], [adkBoss.calls, adkScout.calls]);
  assert.deepEqual(outcome(s), outcome(a));
});

// A gated tool for the approval case (ADR 0028).
const shimSent: string[] = [];
registerTool(
  'shim_test_send',
  new FunctionTool({
    name: 'shim_test_send',
    description: 'Send a note.',
    parameters: z.object({ to: z.string() }),
    execute: async ({ to }) => {
      shimSent.push(to);
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
const lastFunctionResponse = (req: LlmRequest) =>
  (req.contents ?? []).flatMap((c) => c.parts ?? []).reverse().find((p) => p.functionResponse)?.functionResponse?.response as any;

forEachRuntime('shim: an approval pauses the turn, and the approval resumes it', async () => {
  shimSent.length = 0;
  const adk = conversation(
    gatedConfig(),
    scriptedResolver({
      boss: new ScriptedLlm('scripted/boss', (req, n) => (n === 1 ? call('shim_test_send', { to: 'ops@acme.test' }) : text(`done: ${lastFunctionResponse(req)?.result}`))),
    }),
  );
  const a1 = await adk.turn([{ text: 'tell ops' }]);
  const a2 = await adk.turn([approvalResponsePart(a1.approval!.id, true)]);
  assert.deepEqual(shimSent, ['ops@acme.test']);

  shimSent.length = 0;
  const boss = new ScriptedModel('scripted/boss', (req, n) => (n === 1 ? toolCall('shim_test_send', { to: 'ops@acme.test' }) : answer(`done: ${lastToolResult(req)?.result}`)));
  const shim = conversation(gatedConfig(), shimResolver({ boss }));
  const s1 = await shim.turn([{ text: 'tell ops' }]);
  assert.equal(s1.status, 'input-required');
  assert.equal(s1.approval?.tool, 'shim_test_send');
  assert.deepEqual(s1.approval?.args, { to: 'ops@acme.test' });
  assert.deepEqual(shimSent, [], 'nothing ran before the approval');

  const s2 = await shim.turn([approvalResponsePart(s1.approval!.id, true)]);
  assert.equal(s2.status, 'completed', s2.error?.message);
  assert.equal(s2.text, 'done: sent to ops@acme.test');
  assert.deepEqual(shimSent, ['ops@acme.test']);

  assert.deepEqual(outcome(s1), outcome(a1));
  assert.deepEqual(outcome(s2), outcome(a2));
  assert.deepEqual(await shim.history(), await adk.history());
});

// ── Written on one runtime, continued on the other ───────────────────────────

registerTool(
  'cross_runtime_lookup',
  new FunctionTool({
    name: 'cross_runtime_lookup',
    description: 'Look a key up.',
    parameters: z.object({ key: z.string() }),
    execute: async ({ key }) => `value of ${key}`,
  }),
  { override: true },
);

/** Three turns of a DELEGATE syndicate with a tool, each on the runtime `on(i)` names; one store, fresh models. */
async function crossConversation(on: (turn: number) => RuntimeName) {
  resetCircuits();
  const config = delegateConfig({ orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout.', tools: ['cross_runtime_lookup'] } } as any);
  const boss = new ScriptedModel('scripted/boss', (req, n) => {
    if (n === 1) return toolCall('cross_runtime_lookup', { key: 'attic' }, 'call-look');
    if (n === 2) return toolCall('Scout', { request: `search ${lastToolResult(req)?.result}` }, 'call-scout');
    if (n === 3) return answer(`Scout says: ${lastToolResult(req)?.result}`);
    return answer(`turn ${n}: I remember ${requestTexts(req).filter((t) => t.startsWith('Scout says')).join('; ')}`);
  });
  const scout = new ScriptedModel('scripted/scout', (req) => answer(`found it (${requestTexts(req).at(-1)})`));
  const sessionService = new InMemorySessionService();
  const results: SyndicateTurnResult[] = [];
  for (const [i, message] of ['find the thing', 'what did Scout say?', 'and now?'].entries()) {
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
        runtime: on(i),
      }),
    );
  }
  const session = await sessionService.getSession({ appName: APP, userId: USER, sessionId: 'cross' });
  const events = (session?.events ?? []).map((e) => withoutIds({ ...e, id: '<id>', timestamp: 0, invocationId: '<inv>' }));
  return { results, events, boss, scout };
}

/** What the cross-runtime case compares of a conversation. */
const crossComparable = (c: Awaited<ReturnType<typeof crossConversation>>) => ({
  results: c.results.map(outcome),
  events: c.events,
  bossCalls: c.boss.calls,
  bossRequests: c.boss.requests.map((r) => withoutIds(r.messages)),
});

/** The same three turns all on ADK: the reference both directions are held to, recorded once. */
let allAdk: Promise<ReturnType<typeof crossComparable>> | undefined;
const allAdkConversation = () => (allAdk ??= reference('cross-conversation-all-adk', async () => crossComparable(await crossConversation(() => 'adk'))));

acrossRuntimes('a conversation written on one runtime continues on the other: the results, the stored events and the history match', async (writer, reader) => {
  const adk = await allAdkConversation();
  // The first turn (a tool call and a delegation) is written by `writer`; the next two read it on `reader`, then back.
  const run = await crossConversation((i) => (i === 1 ? reader : writer));
  // The reference's canonical form (adkReference.ts), applied to this run too: its events' ids are already '<id>'.
  const got = canonical(crossComparable(run));
  assert.deepEqual(got.results, adk.results, 'the results');
  assert.deepEqual(got.events, adk.events, 'the stored events');
  assert.equal(got.bossCalls, adk.bossCalls);
  assert.deepEqual(got.bossRequests, adk.bossRequests, 'every request saw the same history');
  assert.equal(run.results[1]?.text, 'turn 4: I remember Scout says: found it (search value of attic)');
});
