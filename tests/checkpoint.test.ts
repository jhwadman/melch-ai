/**
 * Offline tests of durable runs (lib/runtime/native/checkpoint.ts, ADR 0113):
 * a run checkpoints its sessions at every step boundary, and a run killed
 * mid-step resumes from the last checkpoint on a fresh store, making only
 * the model calls it had not made, to the same stored history as a run that
 * was never interrupted. Scripted models, the engine's in-process store, no
 * network.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';

import { checkpointingSessions, openingHashOf, runDurableTurn } from '../lib/runtime/native/checkpoint.ts';
import type { CheckpointSink, DurableTurnOptions, RunCheckpoint } from '../lib/runtime/native/checkpoint.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall, untilAborted } from './helpers/scriptedModel.ts';

const APP = 'ckpt-app';
const USER = 'u1';
const MESSAGE = [{ text: 'look up a and b' }];

registerTool(
  'ckpt_lookup',
  defineTool({
    name: 'ckpt_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }) => `value of ${key}`,
  }),
  { override: true },
);

const soloConfig = (): SyndicateYamlConfig =>
  ({ syndicate_name: 'Solo', orchestrator: { name: 'Solo', model: 'scripted/boss', instruction: 'Look things up.', tools: ['ckpt_lookup'] }, subagents: [] }) as any;

const delegateConfig = (): SyndicateYamlConfig =>
  ({
    syndicate_name: 'Team',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Look up, then ask Scout.', tools: ['ckpt_lookup'] },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
  }) as any;

const dispatchConfig = (): SyndicateYamlConfig =>
  ({
    syndicate_name: 'Desk',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [{ name: 'Chat', model: 'scripted/boss', instruction: 'Look things up.', description: 'lookups', tools: ['ckpt_lookup'] }],
    dispatch: { default_route: 'Chat' },
  }) as any;

/** How many tool results the request's history holds: the scripts are stateless, so a resumed run asks what a fresh one would. */
const toolResults = (req: ModelRequest): number => req.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts).length;

/** Looks up a, then b, then answers; `onThird` stands in for the third step when given. */
function lookupModel(onThird?: (signal?: AbortSignal) => ReturnType<typeof untilAborted>) {
  return new ScriptedModel('scripted/boss', (req, _n, signal) => {
    const done = toolResults(req);
    if (done === 0) return toolCall('ckpt_lookup', { key: 'a' }, 'call-a');
    if (done === 1) return toolCall('ckpt_lookup', { key: 'b' }, 'call-b');
    if (onThird) return onThird(signal);
    return answer(`done: ${lastToolResult(req)?.result}`);
  });
}

/** Looks a up, asks Scout, then answers. */
function bossModel(onThird?: (signal?: AbortSignal) => ReturnType<typeof untilAborted>) {
  return new ScriptedModel('scripted/boss', (req, _n, signal) => {
    const done = toolResults(req);
    if (done === 0) return toolCall('ckpt_lookup', { key: 'a' }, 'call-a');
    if (done === 1) return toolCall('Scout', { request: 'search the attic' }, 'call-scout');
    if (onThird) return onThird(signal);
    return answer(`Scout says: ${lastToolResult(req)?.result}`);
  });
}

/** A sink kept in memory, each checkpoint stored as JSON (as a table or a file keeps it). */
function memorySink(initial: RunCheckpoint | null = null, save?: (cp: RunCheckpoint) => Promise<boolean>) {
  const saved: RunCheckpoint[] = [];
  let latest: string | null = initial ? JSON.stringify(initial) : null;
  const sink: CheckpointSink = {
    load: async () => (latest ? (JSON.parse(latest) as RunCheckpoint) : null),
    save:
      save ??
      (async (cp) => {
        latest = JSON.stringify(cp);
        saved.push(JSON.parse(latest) as RunCheckpoint);
        return true;
      }),
  };
  return { sink, saved, latest: () => (latest ? (JSON.parse(latest) as RunCheckpoint) : null) };
}

function durable(config: SyndicateYamlConfig, models: Record<string, ScriptedModel>, sink: CheckpointSink, extra: Partial<DurableTurnOptions> = {}) {
  resetCircuits();
  const sessions = new InProcessSessionService();
  const run = runDurableTurn({
    config,
    parts: MESSAGE,
    appName: APP,
    userId: USER,
    runId: 'owner:job-1',
    checkpoints: sink,
    sessions,
    compile: { resolveModel: shimResolver(models), log: () => {} },
    trace: false,
    ...extra,
  });
  return { run, sessions };
}

/** A session's events as the comparison reads them: who wrote what, and what it wrote into state. */
async function history(sessions: InProcessSessionService, appName: string, sessionId: string) {
  const session = await sessions.get({ appName, userId: USER, sessionId });
  return (session?.events ?? []).map((e: TurnEvent) => ({ author: e.author, content: e.content, stateDelta: e.actions?.stateDelta ?? {} }));
}

/** Aborts the run while its third model step is in flight. */
function killOnThird(controller: AbortController) {
  return (signal?: AbortSignal) => {
    controller.abort();
    return untilAborted(signal);
  };
}

test('a run records one checkpoint per tool step, each holding the run so far', async () => {
  const boss = lookupModel();
  const { sink, saved } = memorySink();
  const { run } = durable(soloConfig(), { boss }, sink);
  const r = await run;
  assert.equal(r.status, 'completed', r.error?.message);
  assert.equal(r.text, 'done: value of b');
  assert.equal(r.resumedFromStep, 0);
  assert.equal(r.lostClaim, false);
  assert.equal(boss.calls, 3);
  assert.deepEqual(saved.map((c) => c.steps), [1, 2]);
  for (const cp of saved) {
    assert.equal(cp.version, 1);
    assert.equal(cp.runId, 'owner:job-1');
    assert.equal(cp.sessionId, r.sessionId);
    assert.equal(cp.openingHash, openingHashOf(MESSAGE));
    assert.equal(cp.sessions.length, 1);
    assert.equal(cp.sessions[0]!.opening, true);
  }
  // The first checkpoint: the message, the call, its response; the second adds the next call and response.
  assert.deepEqual(saved.map((c) => c.sessions[0]!.events.length), [3, 5]);
});

test('kill mid-step: the resumed run makes only the remaining model calls and stores what an uninterrupted run stores', async () => {
  // Run 1: killed while the third model step is in flight, after two checkpoints.
  const controller = new AbortController();
  const boss1 = lookupModel(killOnThird(controller));
  const store = memorySink();
  const r1 = await durable(soloConfig(), { boss: boss1 }, store.sink, { signal: controller.signal }).run;
  assert.equal(r1.status, 'canceled');
  assert.equal(boss1.calls, 3);
  assert.equal(store.saved.length, 2);

  // Run 2: a new store, restored from the saved checkpoint.
  const boss2 = lookupModel();
  const resumed = durable(soloConfig(), { boss: boss2 }, store.sink);
  const r2 = await resumed.run;
  assert.equal(r2.status, 'completed', r2.error?.message);
  assert.equal(r2.resumedFromStep, 2);
  assert.equal(r2.sessionId, r1.sessionId);
  assert.equal(r2.resumedSession, false, 'the runner sees a fresh session, as on a fresh run');
  assert.equal(boss2.calls, 1, 'only the step that was in flight runs again');
  assert.equal(r2.text, 'done: value of b');

  // Run 3: never interrupted.
  const boss3 = lookupModel();
  const fresh = durable(soloConfig(), { boss: boss3 }, memorySink().sink);
  const r3 = await fresh.run;
  assert.equal(boss3.calls, 3);
  assert.equal(r3.text, r2.text);

  const resumedEvents = await history(resumed.sessions, APP, r2.sessionId);
  assert.deepEqual(resumedEvents, await history(fresh.sessions, APP, r3.sessionId));
  assert.equal(resumedEvents.filter((e) => e.author === 'user').length, 1, 'the opening message is stored once');
  // The last request saw the whole history, as on the uninterrupted run.
  assert.deepEqual(boss2.requests[0]!.messages, boss3.requests[2]!.messages);
});

test('dispatch: a checkpoint taken inside an agent route is not resumed; the run starts fresh, classifies again and stores what an uninterrupted run stores', async () => {
  const route = () => new ScriptedModel('scripted/router', () => answer('{"route":"Chat","reason":"lookups"}'));
  const controller = new AbortController();
  const router1 = route();
  const boss1 = lookupModel(killOnThird(controller));
  const store = memorySink();
  const r1 = await durable(dispatchConfig(), { router: router1, boss: boss1 }, store.sink, { signal: controller.signal }).run;
  assert.equal(r1.status, 'canceled');
  assert.equal(store.saved.length, 2, 'the route checkpoints its steps');

  const router2 = route();
  const boss2 = lookupModel();
  const resumed = durable(dispatchConfig(), { router: router2, boss: boss2 }, store.sink);
  const r2 = await resumed.run;
  assert.equal(r2.status, 'completed', r2.error?.message);
  assert.equal(r2.resumedFromStep, 0);
  assert.notEqual(r2.sessionId, r1.sessionId);
  assert.equal(r2.route?.route, 'Chat');
  assert.equal(router2.calls, 1, 'the classifier runs again');
  assert.equal(boss2.calls, 3, 'the route starts over: its history is read through the projection');

  const router3 = route();
  const boss3 = lookupModel();
  const fresh = durable(dispatchConfig(), { router: router3, boss: boss3 }, memorySink().sink);
  const r3 = await fresh.run;
  assert.equal(r3.text, r2.text);
  assert.deepEqual(await history(resumed.sessions, APP, r2.sessionId), await history(fresh.sessions, APP, r3.sessionId));
});

test('dispatch: a checkpoint whose run session holds only the message (as a workflow route leaves it) is restored, the message stored once, and the classifier runs again', async () => {
  // A checkpoint as a workflow route leaves one: the run's session holds only the message.
  const sessionId = 'resume-dispatch';
  const message: TurnEvent = { id: 'open0001', invocationId: 'e-1', author: 'user', content: { role: 'user', parts: MESSAGE }, actions: {}, timestamp: 1 };
  const cp: RunCheckpoint = {
    version: 1,
    runId: 'owner:job-1',
    sessionId,
    openingHash: openingHashOf(MESSAGE),
    steps: 1,
    savedAt: new Date(0).toISOString(),
    sessions: [{ appName: APP, userId: USER, id: sessionId, createdState: {}, events: [message], opening: true }],
  };
  const router = new ScriptedModel('scripted/router', () => answer('{"route":"Chat"}'));
  const boss = lookupModel();
  const resumed = durable(dispatchConfig(), { router, boss }, memorySink(cp).sink);
  const r = await resumed.run;
  assert.equal(r.status, 'completed', r.error?.message);
  assert.equal(r.resumedFromStep, 1);
  assert.equal(r.sessionId, sessionId);
  assert.equal(router.calls, 1);
  const events = await history(resumed.sessions, APP, sessionId);
  assert.equal(events.filter((e) => e.author === 'user').length, 1, 'the opening message is stored once');
  assert.equal((await resumed.sessions.get({ appName: APP, userId: USER, sessionId }))?.events[0]?.id, 'open0001', 'the stored message keeps its id');
});

test('delegation: a run killed after its subagent answered resumes with the child session restored', async () => {
  const controller = new AbortController();
  const boss1 = bossModel(killOnThird(controller));
  const scout1 = new ScriptedModel('scripted/scout', () => answer('found it'));
  const store = memorySink();
  const r1 = await durable(delegateConfig(), { boss: boss1, scout: scout1 }, store.sink, { signal: controller.signal }).run;
  assert.equal(r1.status, 'canceled');
  assert.equal(store.saved.length, 2, 'the lookup step and the delegation step; the child run inside the delegation is no boundary');
  const last = store.latest()!;
  const child = last.sessions.find((s) => s.appName === 'Scout');
  assert.ok(child, 'the child session is in the checkpoint');
  assert.equal(child.opening, false);
  assert.equal(child.events.length, 2);

  const boss2 = bossModel();
  const scout2 = new ScriptedModel('scripted/scout', () => answer('found it'));
  const resumed = durable(delegateConfig(), { boss: boss2, scout: scout2 }, store.sink);
  const r2 = await resumed.run;
  assert.equal(r2.status, 'completed', r2.error?.message);
  assert.equal(r2.resumedFromStep, 2);
  assert.equal(r2.text, 'Scout says: found it');
  assert.equal(boss2.calls, 1);
  assert.equal(scout2.calls, 0, 'the subagent is not asked again');

  const boss3 = bossModel();
  const scout3 = new ScriptedModel('scripted/scout', () => answer('found it'));
  const fresh = durable(delegateConfig(), { boss: boss3, scout: scout3 }, memorySink().sink);
  const r3 = await fresh.run;
  assert.equal(r3.text, r2.text);
  assert.deepEqual(await history(resumed.sessions, APP, r2.sessionId), await history(fresh.sessions, APP, r3.sessionId));
  const restoredChild = await history(resumed.sessions, 'Scout', r2.sessionId);
  assert.equal(restoredChild.length, 2);
  assert.deepEqual(restoredChild, await history(fresh.sessions, 'Scout', r3.sessionId));
});

test('a checkpoint for another message, or another run, is ignored: the run starts fresh', async () => {
  const other = memorySink();
  await durable(soloConfig(), { boss: lookupModel() }, other.sink, { parts: [{ text: 'something else' }] }).run;
  const foreign = other.latest()!;
  assert.notEqual(foreign.openingHash, openingHashOf(MESSAGE));

  const boss = lookupModel();
  const r = await durable(soloConfig(), { boss }, memorySink(foreign).sink).run;
  assert.equal(r.status, 'completed', r.error?.message);
  assert.equal(r.resumedFromStep, 0);
  assert.notEqual(r.sessionId, foreign.sessionId);
  assert.equal(boss.calls, 3);

  const sameMessage = memorySink();
  await durable(soloConfig(), { boss: lookupModel() }, sameMessage.sink).run;
  const boss2 = lookupModel();
  const r2 = await durable(soloConfig(), { boss: boss2 }, memorySink(sameMessage.latest()).sink, { runId: 'owner:job-2' }).run;
  assert.equal(r2.resumedFromStep, 0);
  assert.equal(boss2.calls, 3);

  // The wrapper alone refuses it too.
  const wrapper = checkpointingSessions({ runId: 'owner:job-1', sessionId: foreign.sessionId, parts: MESSAGE, from: foreign, save: async () => true });
  assert.equal(wrapper.restored, false);
  assert.equal(wrapper.steps, 0);
});

test('a save that resolves false stops the run: lostClaim, and no further model call', async () => {
  const boss = lookupModel();
  let lost = 0;
  let saves = 0;
  const { sink } = memorySink(null, async () => {
    saves += 1;
    return false;
  });
  const r = await durable(soloConfig(), { boss }, sink, { onLost: () => (lost += 1) }).run;
  assert.equal(r.lostClaim, true);
  assert.equal(r.status, 'canceled');
  assert.equal(lost, 1);
  assert.equal(saves, 1);
  assert.equal(boss.calls, 1, 'the step after the lost save never reached the model');
});

test('a save that throws is reported and the run completes', async () => {
  const boss = lookupModel();
  const errors: unknown[] = [];
  const { sink } = memorySink(null, async () => {
    throw new Error('disk full');
  });
  const r = await durable(soloConfig(), { boss }, sink, { onSaveError: (e) => errors.push(e) }).run;
  assert.equal(r.status, 'completed', r.error?.message);
  assert.equal(r.lostClaim, false);
  assert.equal(boss.calls, 3);
  assert.equal(errors.length, 2);
  assert.match(String((errors[0] as Error).message), /disk full/);
});
