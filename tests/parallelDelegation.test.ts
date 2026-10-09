/**
 * tests/parallelDelegation.test.ts — a step's calls to subagents run at once
 * under the syndicate's `max_concurrency` (WS6-6, ADR 0116,
 * lib/runtime/native/delegate.ts DelegationGate).
 *
 * The shipped council Moderator asks for both subagents in one step; its
 * two subagents run on a virtual clock
 * (tests/helpers/virtualClock.ts), so "at once" is a time the test reads,
 * never a race between real timers. Then: the cap, two calls to one
 * subagent, the stored order, a pause in one of several running children,
 * two pauses in one step, the turn's cancel, max_steps, and the durable
 * run's step boundary. Through runSyndicateTurn, scripted models, in-memory
 * sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { z } from 'zod';

import type { FinalModelResponse, ModelRequest } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { getFunctionCalls, getFunctionResponses } from '../lib/runtime/events.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { DEFAULT_MAX_CONCURRENCY, DelegationGate } from '../lib/runtime/native/delegate.ts';
import { runDurableTurn } from '../lib/runtime/native/checkpoint.ts';
import type { RunCheckpoint } from '../lib/runtime/native/checkpoint.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { MessagePart, SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall, untilAborted } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { virtualClock } from './helpers/virtualClock.ts';
import type { VirtualClock } from './helpers/virtualClock.ts';

const COUNCIL = join(import.meta.dirname, '..', 'config', 'agents', 'examples', 'council.yaml');
const CLAIM = 'Four-day weeks raise output.';

const sent: string[] = [];
registerTool(
  'pd_send',
  defineTool({
    name: 'pd_send',
    description: 'Send a note.',
    schema: z.object({ to: z.string() }),
    execute: async ({ to }) => (sent.push(to), `sent to ${to}`),
  }),
  { override: true },
);

/** A model answer calling every `[name, id]` in one step. */
const calling = (...calls: Array<[string, string, string?]>): FinalModelResponse => ({
  partial: false,
  parts: calls.map(([name, id, request]) => ({ type: 'toolCall' as const, id, name, args: { request: request ?? `to ${name}` } })),
  finishReason: 'tool_call',
});

/** How many tool results the request's history holds. */
const toolResults = (req: ModelRequest): number => req.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts).length;

/** The council example with each model scripted by its agent's name. */
function council(extra: Partial<SyndicateYamlConfig> = {}): SyndicateYamlConfig {
  const config = loadSyndicate(COUNCIL);
  config.orchestrator.model = 'scripted/moderator';
  for (const s of config.subagents ?? []) s.model = `scripted/${s.name.toLowerCase()}`;
  return { ...config, ...extra };
}

/** A delegate syndicate: Boss over the named subagents, each on its own scripted model. */
function team(names: string[], extra: Record<string, unknown> = {}, sub: (name: string) => Record<string, unknown> = () => ({})): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Team',
      orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate.' },
      subagents: names.map((name) => ({ name, model: `scripted/${name.toLowerCase()}`, instruction: 'Answer.', description: `The ${name}`, ...sub(name) })),
      ...extra,
    },
    'parallel-delegation',
  ) as SyndicateYamlConfig;
}

/** One conversation: each message a turn on one store. */
function converse(cfg: SyndicateYamlConfig, scripts: Record<string, ModelScript>, signal?: () => AbortSignal) {
  resetCircuits();
  sent.length = 0;
  const models = Object.fromEntries(Object.entries(scripts).map(([k, s]) => [k, new ScriptedModel(`scripted/${k}`, s)]));
  const sessionService = new InProcessSessionService();
  const turn = (parts: MessagePart[]): Promise<SyndicateTurnResult> =>
    runSyndicateTurn({
      config: cfg,
      parts,
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      sessionService,
      compile: { resolveModel: shimResolver(models), log: () => {} },
      trace: false,
      ...(signal ? { signal: signal() } : {}),
    });
  const events = async (appName: string): Promise<TurnEvent[]> => (await sessionService.get({ appName, userId: 'u', sessionId: 's' }))?.events ?? [];
  return { turn, models, events };
}

/** A subagent's script: records its start and end on the clock, sleeps `ms`, answers `text`. */
function timed(clock: VirtualClock, log: string[], name: string, ms: number, text = `${name} answers`): ModelScript {
  return async () => {
    log.push(`${name}:start@${clock.now}`);
    await clock.sleep(ms);
    log.push(`${name}:end@${clock.now}`);
    return answer(text);
  };
}

/** The responses the caller stored for its delegations, in stored order. */
async function responses(events: TurnEvent[]): Promise<Array<[string | undefined, unknown]>> {
  return events.flatMap((e) => getFunctionResponses(e).map((r): [string | undefined, unknown] => [r.name, r.response]));
}

// ── The council's two subagents, at once ────────────────────────────────────

test('council: the Advocate and the Skeptic run at once, and their responses are stored in call order', async () => {
  const clock = virtualClock();
  const log: string[] = [];
  const c = converse(council(), {
    moderator: (req) => (toolResults(req) === 0 ? calling(['Advocate', 'call-advocate', CLAIM], ['Skeptic', 'call-skeptic', CLAIM]) : answer('THE VERDICT: unclear.')),
    advocate: timed(clock, log, 'advocate', 300, '1. Rested people.'),
    skeptic: timed(clock, log, 'skeptic', 100, '1. Coverage gaps.'),
  });
  const r = await c.turn([{ text: CLAIM }]);
  assert.equal(r.status, 'completed', r.error?.message);
  assert.deepEqual(log, ['advocate:start@0', 'skeptic:start@0', 'skeptic:end@100', 'advocate:end@300'], 'both start at 0; the turn waits only as long as the slower one');
  assert.equal(clock.now, 300);
  // The Skeptic finished first; the stored response holds the Advocate's first, as the Moderator called them.
  const stored = await c.events('app');
  assert.deepEqual(await responses(stored), [
    ['Advocate', { result: '1. Rested people.' }],
    ['Skeptic', { result: '1. Coverage gaps.' }],
  ]);
  assert.equal(stored.filter((e) => getFunctionResponses(e).length > 0).length, 1, 'one response event for the step');
  // The next request pairs each call with its own answer.
  const second = c.models.moderator!.requests[1]!;
  const results = second.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts) as Array<{ name?: string; result?: unknown }>;
  assert.deepEqual(results.map((p) => p.name), ['Advocate', 'Skeptic']);
});

test('council: the shipped Moderator asks for both subagents in one step, and its first request still declares both', async () => {
  const config = council();
  const instruction = config.orchestrator.instruction ?? '';
  assert.match(instruction, /in a single step/);
  assert.match(instruction, /both function calls in the same response/);
  assert.match(instruction, /full claim verbatim/);
  assert.doesNotMatch(instruction, /first the 'Advocate'.*then the 'Skeptic'/s, 'no ordering across steps');
  const c = converse(config, {
    moderator: (req) => (toolResults(req) === 0 ? calling(['Advocate', 'call-advocate', CLAIM], ['Skeptic', 'call-skeptic', CLAIM]) : answer('THE VERDICT: unclear.')),
    advocate: () => answer('1. Rested people.'),
    skeptic: () => answer('1. Coverage gaps.'),
  });
  const r = await c.turn([{ text: CLAIM }]);
  assert.equal(r.status, 'completed', r.error?.message);
  const first = c.models.moderator!.requests[0]!;
  assert.ok(first.system?.includes(instruction), 'the first request carries the shipped instruction');
  const declared = (first.tools ?? []).map((t) => t.name);
  assert.ok(declared.includes('Advocate') && declared.includes('Skeptic'), `both subagent tools declared: ${declared.join(', ')}`);
  assert.equal(c.models.moderator!.calls, 2, 'one step for both delegations, one for the verdict');
  const stored = await c.events('app');
  assert.deepEqual(
    stored.map(getFunctionCalls).filter((calls) => calls.length > 0).map((calls) => calls.map((call) => [call.name, call.args])),
    [[['Advocate', { request: CLAIM }], ['Skeptic', { request: CLAIM }]]],
    'both calls in one event, each with the full claim',
  );
});

test('council: max_concurrency: 1 runs them one after another, and stores the same events', async () => {
  const run = async (extra: Partial<SyndicateYamlConfig>) => {
    const clock = virtualClock();
    const log: string[] = [];
    const c = converse(council(extra), {
      moderator: (req) => (toolResults(req) === 0 ? calling(['Advocate', 'call-advocate', CLAIM], ['Skeptic', 'call-skeptic', CLAIM]) : answer('THE VERDICT: unclear.')),
      advocate: timed(clock, log, 'advocate', 300, '1. Rested people.'),
      skeptic: timed(clock, log, 'skeptic', 100, '1. Coverage gaps.'),
    });
    const r = await c.turn([{ text: CLAIM }]);
    assert.equal(r.status, 'completed', r.error?.message);
    const strip = (events: TurnEvent[]) => events.map((e) => ({ author: e.author, content: e.content, stateDelta: e.actions.stateDelta }));
    return { log, now: clock.now, app: strip(await c.events('app')), advocate: strip(await c.events('app/Moderator/Advocate')), skeptic: strip(await c.events('app/Moderator/Skeptic')) };
  };
  const serial = await run({ max_concurrency: 1 });
  assert.deepEqual(serial.log, ['advocate:start@0', 'advocate:end@300', 'skeptic:start@300', 'skeptic:end@400']);
  assert.equal(serial.now, 400);
  const parallel = await run({});
  assert.equal(parallel.now, 300);
  // Which order the children ran in changes nothing stored.
  assert.deepEqual(parallel.app, serial.app);
  assert.deepEqual(parallel.advocate, serial.advocate);
  assert.deepEqual(parallel.skeptic, serial.skeptic);
});

// ── The cap ──────────────────────────────────────────────────────────────────

test('max_concurrency caps the calls running at once; the rest start in call order as slots free up', async () => {
  const clock = virtualClock();
  const log: string[] = [];
  const names = ['A', 'B', 'C', 'D'];
  const ms: Record<string, number> = { A: 100, B: 300, C: 100, D: 100 };
  const scripts: Record<string, ModelScript> = {
    boss: (req) => (toolResults(req) === 0 ? calling(...names.map((n): [string, string] => [n, `call-${n}`])) : answer('all in')),
  };
  for (const n of names) scripts[n.toLowerCase()] = timed(clock, log, n, ms[n]!);
  const c = converse(team(names, { max_concurrency: 2 }), scripts);
  const r = await c.turn([{ text: 'go' }]);
  assert.equal(r.status, 'completed', r.error?.message);
  assert.deepEqual(log, ['A:start@0', 'B:start@0', 'A:end@100', 'C:start@100', 'C:end@200', 'D:start@200', 'B:end@300', 'D:end@300']);
  let running = 0;
  let most = 0;
  for (const entry of log) {
    running += entry.includes(':start') ? 1 : -1;
    most = Math.max(most, running);
  }
  assert.equal(most, 2, 'never more than max_concurrency at once');
  assert.deepEqual((await responses(await c.events('app'))).map(([name]) => name), names, 'stored in call order');
});

test('without max_concurrency, four calls run at once (the default), and a fifth waits for a slot', async () => {
  assert.equal(DEFAULT_MAX_CONCURRENCY, 4);
  const clock = virtualClock();
  const log: string[] = [];
  const names = ['A', 'B', 'C', 'D', 'E'];
  const scripts: Record<string, ModelScript> = {
    boss: (req) => (toolResults(req) === 0 ? calling(...names.map((n): [string, string] => [n, `call-${n}`])) : answer('all in')),
  };
  for (const n of names) scripts[n.toLowerCase()] = timed(clock, log, n, 100);
  const r = await converse(team(names), scripts).turn([{ text: 'go' }]);
  assert.equal(r.status, 'completed', r.error?.message);
  assert.deepEqual(log.filter((e) => e.includes(':start')), ['A:start@0', 'B:start@0', 'C:start@0', 'D:start@0', 'E:start@100']);
});

test('two calls to one subagent in a step run one after another on its one session; another subagent runs beside them', async () => {
  const clock = virtualClock();
  const log: string[] = [];
  let n = 0;
  const c = converse(team(['Scout', 'Other']), {
    boss: (req) => (toolResults(req) === 0 ? calling(['Scout', 'call-1', 'first'], ['Other', 'call-2'], ['Scout', 'call-3', 'second']) : answer('done')),
    scout: async (req) => {
      const i = ++n;
      log.push(`scout${i}:start@${clock.now}`);
      await clock.sleep(100);
      log.push(`scout${i}:end@${clock.now}`);
      return answer(`scout saw ${req.messages.filter((m) => m.role === 'user').length} messages`);
    },
    other: timed(clock, log, 'other', 50),
  });
  const r = await c.turn([{ text: 'go' }]);
  assert.equal(r.status, 'completed', r.error?.message);
  // Which of two children that start at the same moment logs first is not what this asserts: the times are.
  assert.deepEqual([...log].sort(), ['other:end@50', 'other:start@0', 'scout1:end@100', 'scout1:start@0', 'scout2:end@200', 'scout2:start@100']);
  const scout = await c.events('app/Boss/Scout');
  assert.deepEqual(scout.map((e) => [e.author, e.content?.parts?.[0]?.text]), [
    ['user', 'first'],
    ['Scout', 'scout saw 1 messages'],
    ['user', 'second'],
    ['Scout', 'scout saw 2 messages'],
  ]);
  assert.deepEqual(await responses(await c.events('app')), [
    ['Scout', { result: 'scout saw 1 messages' }],
    ['Other', { result: 'other answers' }],
    ['Scout', { result: 'scout saw 2 messages' }],
  ]);
});

// ── Pauses ───────────────────────────────────────────────────────────────────

/** Calls `name` with `args` the first time; once a tool result is in the history, answers with it. */
const delegating =
  (label: string, tool: string, args: Record<string, unknown>, id: string): ModelScript =>
  (req) => {
    const r = lastToolResult(req);
    return r ? answer(`${label}: ${JSON.stringify(r.result)}`) : toolCall(tool, args, id);
  };

test('a pause in one of several running children: the others finish and are stored, the paused call stays open', async () => {
  const clock = virtualClock();
  const log: string[] = [];
  const cfg = team(['Gated', 'Slow'], {}, (name) => (name === 'Gated' ? { tools: ['pd_send'], require_approval: ['pd_send'] } : {}));
  const c = converse(cfg, {
    boss: (req) => (toolResults(req) === 0 ? calling(['Gated', 'call-gated'], ['Slow', 'call-slow']) : answer(`done (${toolResults(req)} results)`)),
    gated: delegating('Gated', 'pd_send', { to: 'ops@acme.test' }, 'call-send'),
    slow: timed(clock, log, 'slow', 200, 'slow report'),
  });
  const first = await c.turn([{ text: 'go' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.deepEqual(first.approval?.path, ['Boss', 'Gated']);
  assert.deepEqual(log, ['slow:start@0', 'slow:end@200'], 'the other child ran to its end while the first waited');
  const stored = await c.events('app');
  assert.deepEqual(await responses(stored), [['Slow', { result: 'slow report' }]], 'the finished call is stored; the paused one has no response');
  const open = stored.flatMap(getFunctionCalls).map((call) => call.id);
  assert.deepEqual(open, ['call-gated', 'call-slow']);

  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(sent, ['ops@acme.test']);
  assert.equal(second.text, 'done (2 results)');
  assert.equal(c.models.slow!.calls, 1, 'the finished child is not run again');
  assert.equal(c.models.boss!.calls, 2);
});

test('two children pause in one step: both run at once, and the pending calls are listed in call order whatever order they paused in', async () => {
  const clock = virtualClock();
  const cfg = team(['ScoutA', 'ScoutB'], {}, () => ({ tools: ['pd_send'], require_approval: ['pd_send'] }));
  const late = (inner: ModelScript): ModelScript => async (req, n, s) => {
    if (n === 1) await clock.sleep(100);
    return inner(req, n, s);
  };
  const c = converse(cfg, {
    boss: (req) => (toolResults(req) === 0 ? calling(['ScoutA', 'call-a'], ['ScoutB', 'call-b']) : answer(`done (${toolResults(req)} results)`)),
    // A pauses after B.
    scouta: late(delegating('A', 'pd_send', { to: 'a@acme.test' }, 'call-send-a')),
    scoutb: delegating('B', 'pd_send', { to: 'b@acme.test' }, 'call-send-b'),
  });
  const first = await c.turn([{ text: 'go' }]);
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.equal(c.models.scouta!.calls, 1);
  assert.equal(c.models.scoutb!.calls, 1, 'both children ran their first step in the first turn');
  assert.deepEqual(first.approval?.path, ['Boss', 'ScoutA'], 'the first open call in call order is raised first');
  const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
  assert.equal(second.status, 'input-required', second.error?.message);
  assert.deepEqual(second.approval?.path, ['Boss', 'ScoutB']);
  const third = await c.turn([approvalResponsePart(second.approval!.id, true) as MessagePart]);
  assert.equal(third.status, 'completed', third.error?.message);
  assert.deepEqual(sent, ['a@acme.test', 'b@acme.test']);
  assert.equal(third.text, 'done (2 results)');
  assert.equal(c.models.boss!.calls, 2);
});

// ── Cancel and budget ────────────────────────────────────────────────────────

test('cancel aborts every running child; a call still waiting for a slot never starts; nothing is stored for the step', async () => {
  const aborted: string[] = [];
  const waiting = (name: string): ModelScript => async (_r, _n, signal) => {
    const out = await untilAborted(signal);
    aborted.push(name);
    return out;
  };
  let controller!: AbortController;
  const c = converse(
    team(['A', 'B', 'C'], { max_concurrency: 2 }),
    { boss: (req) => (toolResults(req) === 0 ? calling(['A', 'call-a'], ['B', 'call-b'], ['C', 'call-c']) : answer('never')), a: waiting('A'), b: waiting('B'), c: waiting('C') },
    () => {
      controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      return controller.signal;
    },
  );
  const r = await c.turn([{ text: 'go' }]);
  assert.equal(r.status, 'canceled', r.error?.message);
  assert.deepEqual(aborted.sort(), ['A', 'B'], 'both running children saw the abort');
  assert.equal(c.models.c!.calls, 0, 'the third call never started');
  assert.equal(c.models.boss!.calls, 1);
  assert.deepEqual(await responses(await c.events('app')), [], 'no response is stored for a step the turn stopped');
});

test('max_steps counts every child\'s model call: the call that would pass it stops the turn, the earlier calls in call order run', async () => {
  const c = converse(team(['A', 'B', 'C'], { max_steps: 3 }), {
    boss: (req) => (toolResults(req) === 0 ? calling(['A', 'call-a'], ['B', 'call-b'], ['C', 'call-c']) : answer('never')),
    a: () => answer('a'),
    b: () => answer('b'),
    c: () => answer('c'),
  });
  const r = await c.turn([{ text: 'go' }]);
  assert.equal(r.error?.code, 'STEP_LIMIT', r.error?.message);
  assert.deepEqual([c.models.boss!.calls, c.models.a!.calls, c.models.b!.calls, c.models.c!.calls], [1, 1, 1, 0]);
});

// ── Durable runs ─────────────────────────────────────────────────────────────

test('a durable run reaches a step boundary only once every concurrent call has answered', async () => {
  const clock = virtualClock();
  const log: string[] = [];
  const saved: RunCheckpoint[] = [];
  const models = {
    boss: new ScriptedModel('scripted/boss', (req) => (toolResults(req) === 0 ? calling(['A', 'call-a'], ['B', 'call-b']) : answer('both in'))),
    a: new ScriptedModel('scripted/a', timed(clock, log, 'A', 300)),
    b: new ScriptedModel('scripted/b', timed(clock, log, 'B', 100)),
  };
  resetCircuits();
  const r = await runDurableTurn({
    config: team(['A', 'B']),
    parts: [{ text: 'go' }],
    appName: 'app',
    userId: 'u',
    runId: 'owner:job-1',
    checkpoints: {
      load: async () => null,
      save: async (cp) => {
        saved.push(JSON.parse(JSON.stringify(cp)) as RunCheckpoint);
        return true;
      },
    },
    sessions: new InProcessSessionService(),
    compile: { resolveModel: shimResolver(models), log: () => {} },
    trace: false,
  });
  assert.equal(r.status, 'completed', r.error?.message);
  assert.deepEqual(log, ['A:start@0', 'B:start@0', 'B:end@100', 'A:end@300']);
  // B's child finished at 100 while A still ran: no boundary then. The one boundary is the caller's stored response.
  assert.equal(saved.length, 1);
  const cp = saved[0]!;
  const all = cp.sessions.flatMap((s) => s.events);
  const answered = new Set(all.flatMap(getFunctionResponses).map((resp) => resp.id));
  assert.deepEqual(all.flatMap(getFunctionCalls).filter((call) => !answered.has(call.id)), [], 'every call in the checkpoint has its response');
  assert.deepEqual(cp.sessions.map((s) => s.appName).sort(), ['app', 'app/Boss/A', 'app/Boss/B']);
});

// ── The schema and the gate ──────────────────────────────────────────────────

test('the schema: max_concurrency is a positive integer up to 32 on a delegate syndicate, refused beside workflow: and dispatch:', () => {
  const base = { syndicate_name: 'T', orchestrator: { name: 'Boss', model: 'gemini-3.5-flash', instruction: 'x' }, subagents: [{ name: 'S', instruction: 'y', description: 'z' }] };
  assert.equal((validateSyndicateConfig({ ...base, max_concurrency: 2 }, 't') as SyndicateYamlConfig).max_concurrency, 2);
  for (const bad of [0, -1, 1.5, 33, '2']) assert.throws(() => validateSyndicateConfig({ ...base, max_concurrency: bad }, 't'), /max_concurrency/);
  assert.throws(() => validateSyndicateConfig({ ...base, max_concurrency: 2, dispatch: { default_route: 'S' } }, 't'), /dispatch syndicate's classifier delegates nothing/);
  assert.throws(
    () => validateSyndicateConfig({ ...base, max_concurrency: 2, workflow: { edges: [['START', 'Boss', 'S']] } }, 't'),
    /workflow bounds its nodes with workflow\.max_concurrency/,
  );
});

test('DelegationGate: entry order, the cap, one lane per key, a failure frees its slot and its lane', async () => {
  const gate = new DelegationGate(2);
  const order: string[] = [];
  const release: Record<string, () => void> = {};
  const job = (name: string, fail = false) => () =>
    new Promise<string>((resolve, reject) => {
      order.push(`${name}:start`);
      release[name] = () => (fail ? reject(new Error(name)) : resolve(name));
    });
  const settle = () => new Promise((r) => setImmediate(r));
  const x1 = gate.run('x', job('x1', true));
  const y = gate.run('y', job('y'));
  const x2 = gate.run('x', job('x2'));
  const z = gate.run('z', job('z'));
  await settle();
  assert.deepEqual(order, ['x1:start', 'y:start'], 'two at once');
  release.x1!();
  await assert.rejects(x1, /x1/);
  await settle();
  assert.deepEqual(order, ['x1:start', 'y:start', 'x2:start'], 'x2 takes the freed slot, after x1 failed');
  release.y!();
  await settle();
  assert.deepEqual(order.at(-1), 'z:start');
  release.x2!();
  release.z!();
  assert.deepEqual(await Promise.all([y, x2, z]), ['y', 'x2', 'z']);
  assert.equal(new DelegationGate(0).limit, DEFAULT_MAX_CONCURRENCY);
});
