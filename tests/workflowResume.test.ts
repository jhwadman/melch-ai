/**
 * tests/workflowResume.test.ts — a paused workflow resumes on the engine's
 * own scheduler (lib/workflow/resume.ts, the scheduler's `resume` seam, the
 * ask_user rerun in lib/workflow/pause.ts) as ADK 2.2 resumes it (ADR 0094).
 *
 * Three layers:
 *
 *   1. THE FIXTURE. tests/fixtures/sessions/05-workflow-ask-user.json, the
 *      session ADK wrote when the walk paused at Confirm, resumes on the
 *      scheduler with real agent nodes (agentNodeRuntime on the native loop)
 *      and the scenario's scripts as engine models on both runtimes (the
 *      ADK side behind the shim): the events it stores after the reply
 *      are ADK's resume of the same session, event for event (ids, times and
 *      invocation ids aside), Triage is not called again, and Publisher sees
 *      both the reply and the draft. The other way round: a pause the
 *      scheduler opened stores the fixture's events, and resumes on ADK.
 *   2. THE WALK AROUND A RESUME. Graphs of stub agents, as
 *      tests/workflowPause.test.ts runs them: ADK's Runner on today's
 *      compileWorkflow, paused then answered, against the scheduler resumed
 *      from ADK's stored events and from its own.
 *   3. THE PORT. Each function of resume.ts against ADK's own
 *      (workflow/utils/rehydration_utils.js) on the same events.
 *
 * ADK's side of every comparison (its stored events, its requests, its
 * rehydration functions' outputs) is recorded in
 * tests/fixtures/adk-reference/workflowresume (tests/helpers/adkReference.ts);
 * ADK runs it live only under ADK_REFERENCE=live|record.
 *
 * No network, no provider calls. No timers: nothing here races.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Event, LlmAgent } from '@google/adk';

import { compileNativeSubagent } from '../lib/compileNative.ts';
import { compileWorkflow } from '../lib/workflow.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter } from '../lib/models/contract.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import type { TurnContent, TurnEvent } from '../lib/runtime/events.ts';
import type { NativeAgent } from '../lib/runtime/native/request.ts';
import { pendingWorkflowInput } from '../lib/runtime/questions.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { Session } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { agentNodeRuntime } from '../lib/workflow/agentNode.ts';
import { buildWorkflowGraph } from '../lib/workflow/graph.ts';
import { askUserNodeRunner, workflowPauseEvent } from '../lib/workflow/pause.ts';
import {
  eventsForCurrentRun,
  isFastForwardable,
  nodeNameFromPath,
  reconstructNodeRuns,
  reconstructNodeStates,
  resolvedInterruptResponses,
  resumeInputsFromPlainText,
  rerunsOnResume,
  unwrapResponse,
  workflowNodeInput,
  workflowResume,
} from '../lib/workflow/resume.ts';
import { UnsupportedWorkflowResumeError } from '../lib/workflow/resume.ts';
import type { StoredEvent } from '../lib/workflow/resume.ts';
import { runWorkflowGraph } from '../lib/workflow/scheduler.ts';
import type { NodeRun, SchedulerEvent, WorkflowRun } from '../lib/workflow/scheduler.ts';
import { joinNodeEvent, mapNodeEvent } from '../lib/workflow/nodeEvents.ts';
import { enrichNodeEvent } from '../lib/workflow/toolNode.ts';
import { APP, USER, scenario } from './fixtures/sessions/scenarios.ts';
import { conversation, loadFixture, pendingWorkflowInput as helperPendingWorkflowInput, seedSessions } from './helpers/sessionFixtures.ts';
import type { SessionFixture } from './helpers/sessionFixtures.ts';
import { ScriptedModel, answer, requestTexts, shimResolver } from './helpers/scriptedModel.ts';
import { requestsOf } from './helpers/workflowParity.ts';
import { adkReferences, canonical, runsAdk } from './helpers/adkReference.ts';

// ADK's side of each comparison is recorded (tests/fixtures/adk-reference/workflowresume); ADK runs only under ADK_REFERENCE=live|record.
const reference = adkReferences('workflowResume');
if (runsAdk()) {
  const { LogLevel, setLogLevel } = await import('@google/adk');
  setLogLevel(LogLevel.ERROR);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = '05-workflow-ask-user';

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Events as stored, compared without their id, time and invocation id, with
 * each interrupt id (raised in `earlier` or here) by its order of first
 * appearance, as tests/workflowPause.test.ts compares them.
 */
function comparable(events: readonly StoredEvent[], earlier: readonly StoredEvent[] = []): string[] {
  const names = new Map<string, string>();
  for (const e of [...earlier, ...events]) for (const id of e.longRunningToolIds ?? []) if (!names.has(id)) names.set(id, `<interrupt ${names.size + 1}>`);
  return events.map((event) => {
    const { id: _id, timestamp: _t, invocationId: _i, ...rest } = json(event) as TurnEvent;
    let out = JSON.stringify(rest);
    for (const [id, name] of names) out = out.split(id).join(name);
    return out;
  });
}

/** Key order aside: ADK and createTurnEvent write the same keys in different orders. */
const sorted = (lines: string[]) => lines.map((line) => JSON.stringify(sortKeys(JSON.parse(line))));
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  return value;
}

// ── 1. The fixture ───────────────────────────────────────────────────────────

/**
 * Fixture 05's scripts (tests/fixtures/sessions/scenarios.ts) as engine
 * models, so both runtimes call one adapter: ADK through the shim, the
 * native loop directly. (The scenario's ScriptedLlm hands ADK the script's
 * LlmResponse as written, without a finish reason, while the native loop
 * reads it through the contract and stores `STOP`: a property of the test
 * model, not of either runtime.)
 */
function fixtureModels(): Record<string, ScriptedModel> {
  return {
    triage: new ScriptedModel('scripted/triage', () => answer('the draft')),
    publisher: new ScriptedModel('scripted/publisher', (req) => answer(`published ${requestTexts(req).at(-1) ?? ''}`)),
  };
}

/** The frozen fixture was written by the scenario's ScriptedLlm, which stores no finish reason; see fixtureModels. */
const withoutFinishReason = (events: readonly StoredEvent[]): StoredEvent[] => events.map((e) => {
  const { finishReason: _f, ...rest } = e as TurnEvent;
  return rest;
});

/** Every agent of the syndicate compiled for native, by YAML name. */
async function nativeAgents(cfg: SyndicateYamlConfig): Promise<Map<string, NativeAgent>> {
  const agents = new Map<string, NativeAgent>();
  for (const sub of [{ description: '', ...cfg.orchestrator } as SubagentYamlConfig, ...(cfg.subagents ?? [])]) agents.set(sub.name, await compileNativeSubagent(sub, { log: () => {} }));
  return agents;
}

interface NativeTurn {
  run: WorkflowRun;
  /** The events the turn stored, the message first. */
  stored: TurnEvent[];
  walk: SchedulerEvent[];
}

/**
 * One workflow turn on the scheduler, stored as WS4-6 will store it: the
 * message as the Runner stores it, then the walk (agent nodes on the native
 * loop, ask_user nodes, a resume rebuilt from the session when `resume`),
 * then the workflow's own record when the walk ends paused.
 */
async function nativeTurn(cfg: SyndicateYamlConfig, models: Record<string, ScriptedModel>, sessions: InProcessSessionService, session: Session, text: string, resume: boolean): Promise<NativeTurn> {
  const invocationId = `e-${randomUUID()}`;
  const userContent: TurnContent = { role: 'user', parts: [{ text }] };
  const before = session.events.length;
  await sessions.append(session, createTurnEvent({ invocationId, author: 'user', content: userContent }));
  const runtime = agentNodeRuntime({
    agents: await nativeAgents(cfg),
    session,
    sessions,
    invocationId,
    userContent,
    loop: { adapterFor: (model) => models[model.replace(/^scripted\//, '')] as ModelAdapter, stream: false, log: () => {} },
  });
  const start = resume
    ? workflowResume({ events: session.events, invocationId, userContent, workflowPath: cfg.syndicate_name })
    : { input: workflowNodeInput(userContent), resume: undefined };
  const walk: SchedulerEvent[] = [];
  const run = await runWorkflowGraph(buildWorkflowGraph(cfg), {
    input: start.input,
    ...(start.resume ? { resume: start.resume } : {}),
    runNode: askUserNodeRunner({ invocationId, onEvent: (e) => void runtime.store(e) }, runtime.runNode),
    onEvent: (e) => {
      walk.push(e);
      runtime.onEvent(e);
    },
  });
  await runtime.settled();
  if (run.interruptIds.length > 0) await sessions.append(session, workflowPauseEvent({ name: cfg.syndicate_name, invocationId, input: start.input, interruptIds: run.interruptIds }));
  return { run, stored: json(session.events.slice(before)), walk };
}

/** A native session holding the fixture's stored events, as a store hands them back. */
async function seedNative(f: SessionFixture): Promise<{ sessions: InProcessSessionService; session: Session }> {
  const row = conversation(f);
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: row.appName, userId: row.userId, sessionId: row.sessionId });
  for (const event of json(row.events) as unknown as TurnEvent[]) await sessions.append(session, event);
  return { sessions, session };
}

/** ADK's resume of a session holding `events`, live: the events it stores after them, and the turn's result. Only inside a reference. */
async function liveAdkResume(events: readonly StoredEvent[], text: string) {
  const s = scenario(FIXTURE);
  const models = fixtureModels();
  const sessionService = await seedSessions({ ...loadFixture(FIXTURE), sessions: [{ ...conversation(loadFixture(FIXTURE)), events: json(events) as unknown as Event[] }] });
  const result = await runSyndicateTurn({
    runtime: 'adk',
    config: s.config,
    parts: [{ text }],
    appName: APP,
    userId: USER,
    sessionId: s.sessionId,
    sessionService,
    compile: { resolveModel: shimResolver(models), log: () => {} },
    trace: false,
  });
  const after = await sessionService.getSession({ appName: APP, userId: USER, sessionId: s.sessionId });
  return { result, models, stored: json(after!.events.slice(events.length)) as unknown as TurnEvent[] };
}

/**
 * ADK's resume of a session holding `events`, as recorded: the turn's
 * status, error and text, the requests each model received, the calls each
 * took, and the session (`before`, the events it was seeded with, then
 * `stored`, those ADK stored after them). The seeded events are recorded
 * with ADK's, so the ids the reference renumbers stay one set (an
 * interrupt id in ADK's events is the one in `before`).
 */
async function adkResume(name: string, events: readonly StoredEvent[], text: string) {
  const r = await reference(name, async () => {
    const { result, models, stored } = await liveAdkResume(events, text);
    return {
      status: result.status,
      ...(result.error ? { error: result.error.message } : {}),
      text: result.text,
      requests: Object.fromEntries(Object.entries(models).map(([key, m]) => [key, requestsOf(m)])),
      calls: Object.fromEntries(Object.entries(models).map(([key, m]) => [key, m.calls])),
      session: [...json(events), ...stored] as unknown as TurnEvent[],
    };
  });
  return { ...r, before: r.session.slice(0, events.length) as StoredEvent[], stored: r.session.slice(events.length) };
}

test('fixture 05, written by ADK, resumes on the scheduler: ADK\'s stored events, and the next node sees the reply and the draft', async () => {
  const f = loadFixture(FIXTURE);
  const stored = conversation(f).events as unknown as StoredEvent[];
  const adk = await adkResume('fixture-05-resume', stored, 'yes');
  assert.equal(adk.status, 'completed', adk.error);

  const s = scenario(FIXTURE);
  const models = fixtureModels();
  const { sessions, session } = await seedNative(f);
  const native = await nativeTurn(s.config, models, sessions, session, 'yes', true);

  assert.deepEqual(sorted(comparable(native.stored, stored)), sorted(comparable(adk.stored, adk.before)), 'the events stored after the reply');
  // The walk's events in ADK's key order too (the message is the caller's to store, WS4-6).
  assert.deepEqual(comparable(native.stored.slice(1), stored), comparable(adk.stored.slice(1), adk.before), 'in ADK\'s key order too');
  assert.equal(models.triage!.calls, 0, 'Triage completed from its stored output');
  assert.equal(models.publisher!.calls, 1);
  assert.deepEqual(models.publisher!.requests.map(requestTexts), [['{"reply":"yes","input":"the draft"}']], 'Publisher sees the reply and the draft');
  assert.deepEqual(requestsOf(models.publisher!), adk.requests.publisher, 'the request Publisher received, as on ADK');
  assert.deepEqual(native.run.interruptIds, []);
  assert.equal(native.run.output, 'published {"reply":"yes","input":"the draft"}');
  assert.equal(native.run.output, adk.text);
  assert.deepEqual(native.run.order, ['Triage', 'Confirm', 'Publisher']);
  assert.deepEqual(
    native.walk.map((e) => `${e.type} ${'node' in e ? e.node : ''}`),
    ['node_resumed Triage', 'node_start Confirm', 'node_end Confirm', 'node_start Publisher', 'node_end Publisher'],
  );
  assert.equal((native.walk[1] as Extract<SchedulerEvent, { type: 'node_start' }>).input, 'the draft', 'Confirm reruns on the input it recorded, not the new message');
  assert.equal(pendingWorkflowInput((await sessions.get({ appName: APP, userId: USER, sessionId: s.sessionId }))!.events as unknown as Event[]), undefined, 'answered');
});

test('a pause the scheduler opened stores the fixture\'s events, and resumes on ADK and on the scheduler alike', async () => {
  const f = loadFixture(FIXTURE);
  const s = scenario(FIXTURE);
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: APP, userId: USER, sessionId: s.sessionId });
  const paused = await nativeTurn(s.config, fixtureModels(), sessions, session, 'write the release note', false);
  assert.equal(paused.run.interruptIds.length, 1);
  assert.deepEqual(sorted(comparable(withoutFinishReason(paused.stored))), sorted(comparable(conversation(f).events as unknown as StoredEvent[])), 'the fixture ADK wrote');
  const pending = pendingWorkflowInput(paused.stored as unknown as Event[]);
  assert.deepEqual({ ...pending, id: '-' }, { id: '-', node: 'Confirm', message: 'Publish?', payload: 'the draft' });

  // On ADK: the stored shape is all ADK needs.
  const adk = await adkResume('scheduler-pause-resumed-on-adk', paused.stored, 'yes');
  assert.equal(adk.status, 'completed', adk.error);
  assert.equal(adk.text, 'published {"reply":"yes","input":"the draft"}');
  assert.equal(adk.calls.triage, 0);

  // On the scheduler, from its own session: the same events ADK stored.
  const models = fixtureModels();
  const resumed = await nativeTurn(s.config, models, sessions, session, 'yes', true);
  assert.deepEqual(sorted(comparable(resumed.stored, paused.stored)), sorted(comparable(adk.stored, adk.before)));
  assert.equal(resumed.run.output, adk.text);
  assert.equal(models.triage!.calls, 0);
});

test('after a resume, a node\'s workflow placeholders read what ADK\'s read: the input, and the outputs stored in this invocation only', async () => {
  const f = loadFixture(FIXTURE);
  const s = scenario(FIXTURE);
  // ADR 0093's placeholders: {x.reply} from the input, <x.input from Confirm> from Confirm's output in this invocation,
  // <x.draft from Triage> from a node whose output was stored in the paused invocation (none on ADK, so left as written).
  const cfg = { ...s.config, subagents: s.config.subagents!.map((sub) => ({ ...sub, instruction: 'Publish {x.reply}: <x.input from Confirm> / <x.draft from Triage>.' })) } as SyndicateYamlConfig;
  const stored = conversation(f).events as unknown as StoredEvent[];

  // ADK's side, recorded: the turn's status, its session (the fixture's events, then ADK's), the requests Publisher received.
  const adk = await reference('placeholders-after-resume', async () => {
    const adkModels = fixtureModels();
    const sessionService = await seedSessions(f);
    const r = await runSyndicateTurn({ runtime: 'adk', config: cfg, parts: [{ text: 'yes' }], appName: APP, userId: USER, sessionId: s.sessionId, sessionService, compile: { resolveModel: shimResolver(adkModels), log: () => {} }, trace: false });
    const session = json((await sessionService.getSession({ appName: APP, userId: USER, sessionId: s.sessionId }))!.events) as unknown as TurnEvent[];
    return { status: r.status, ...(r.error ? { error: r.error.message } : {}), session, publisher: requestsOf(adkModels.publisher!) };
  });
  assert.equal(adk.status, 'completed', adk.error);
  const adkBefore = adk.session.slice(0, stored.length) as StoredEvent[];
  const adkStored = adk.session.slice(stored.length);

  const models = fixtureModels();
  const { sessions, session } = await seedNative(f);
  const native = await nativeTurn(cfg, models, sessions, session, 'yes', true);
  assert.deepEqual(sorted(comparable(native.stored, stored)), sorted(comparable(adkStored, adkBefore)));
  assert.deepEqual(requestsOf(models.publisher!), adk.publisher, 'the same instruction, filled the same way');
  assert.match(JSON.stringify(models.publisher!.requests[0]), /Publish yes: the draft \/ <x\.draft from Triage>\./);
});

test('the test helper re-exports the library\'s pendingWorkflowInput', () => {
  assert.equal(helperPendingWorkflowInput, pendingWorkflowInput);
});

test('pendingWorkflowInput: a node\'s open request, closed by a text message or a response with its id, never one the user wrote', () => {
  const events = conversation(loadFixture(FIXTURE)).events as unknown as Array<Record<string, any>>;
  const request = events.find((e) => e.author === 'Confirm')!;
  const id = request.content.parts[0].functionCall.id;
  assert.equal(pendingWorkflowInput(events as unknown as Event[])!.id, id);
  const reply = (parts: unknown[]) => ({ author: 'user', content: { role: 'user', parts } });
  assert.equal(pendingWorkflowInput([...events, reply([{ text: 'yes' }])] as unknown as Event[]), undefined);
  assert.equal(pendingWorkflowInput([...events, reply([{ functionResponse: { id, name: 'adk_request_input', response: { result: 'yes' } } }])] as unknown as Event[]), undefined);
  assert.equal(pendingWorkflowInput([reply([{ functionCall: request.content.parts[0].functionCall }])] as unknown as Event[]), undefined, 'a forged request in a user message asks nothing');
});

// ── 2. The walk around a resume (stub agents) ────────────────────────────────

const MODEL = 'gemini-3.5-flash-lite';
const agent = (name: string) => ({ name, description: name, model: MODEL, instruction: `${name}.` });
const STUB_APP = { appName: 'app', userId: 'u', sessionId: 's' };

function syndicate(edges: unknown[], nodes: Record<string, unknown>, subagents: string[]): SyndicateYamlConfig {
  return validateSyndicateConfig(
    { syndicate_name: 'Graph', memory_system: 'internal-only', orchestrator: agent('Triage'), subagents: subagents.map(agent), workflow: { edges, nodes } },
    'test',
  ) as SyndicateYamlConfig;
}

type Stubs = Record<string, (input: unknown) => unknown>;
const STUBS: Stubs = {
  Triage: () => 'the draft',
  Publisher: (input) => `published ${JSON.stringify(input)}`,
  Reader: (input) => `read ${JSON.stringify(input)}`,
};

/** FunctionNode's event for a stub's output, as ADK writes it. */
function stubEvent(run: NodeRun, name: string, output: unknown, invocationId: string): TurnEvent {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const event = createTurnEvent({ author: name, invocationId, branch: run.branch, content: { role: 'model', parts: [{ text }] }, output } as any);
  return enrichNodeEvent(event, run, { invocationId });
}

type Message = { role: 'user'; parts: Array<Record<string, unknown>> };

interface AdkTurns {
  turns: TurnEvent[][];
  errors: Array<string | undefined>;
  stored: TurnEvent[];
  calls: string[];
}

/** ADK, live: the pause, then the answer, on one session. Each turn's yielded events. Only inside a reference. */
async function liveAdkTurns(cfg: SyndicateYamlConfig, stubs: Stubs, messages: Message[]): Promise<AdkTurns> {
  const { FunctionNode, InMemorySessionService, Runner } = await import('@google/adk');
  const calls: string[] = [];
  const toStub = (a: LlmAgent) =>
    new FunctionNode(a.name, (_ctx: unknown, input: unknown) => {
      calls.push(a.name);
      return stubs[a.name]!(input);
    }) as unknown as LlmAgent;
  const { workflow } = await compileWorkflow(cfg, {}, toStub);
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({ ...STUB_APP });
  const runner = new Runner({ agent: workflow as any, appName: STUB_APP.appName, sessionService });
  const turns: TurnEvent[][] = [];
  const errors: Array<string | undefined> = [];
  for (const newMessage of messages) {
    const events: TurnEvent[] = [];
    let error: string | undefined;
    try {
      for await (const ev of runner.runAsync({ userId: STUB_APP.userId, sessionId: STUB_APP.sessionId, newMessage: newMessage as any })) events.push(json(ev) as unknown as TurnEvent);
    } catch (e) {
      error = (e as Error).message;
    }
    turns.push(events);
    errors.push(error);
  }
  const stored = json((await sessionService.getSession({ ...STUB_APP }))!.events) as unknown as TurnEvent[];
  return { turns, errors, stored, calls };
}

/** ADK's turns of case `name`: recorded, or (ADK_REFERENCE=live|record) run on ADK's Runner. A turn that did not fail records no error (JSON's null read back as undefined). */
async function adkTurns(name: string, cfg: SyndicateYamlConfig, stubs: Stubs, messages: Message[]): Promise<AdkTurns> {
  const r = await reference(name, () => liveAdkTurns(cfg, stubs, messages));
  return { ...r, errors: r.errors.map((e) => e ?? undefined) };
}

/**
 * The scheduler: one turn on a session's events (`history`, ADK's or its
 * own), resumed from them. Returns the events the walk wrote (the yielded
 * ones; the message is the caller's) and the stubs it called.
 */
async function nativeTurnOnEvents(cfg: SyndicateYamlConfig, stubs: Stubs, history: readonly StoredEvent[], message: Message) {
  const invocationId = `e-${randomUUID()}`;
  const calls: string[] = [];
  const events: TurnEvent[] = [];
  const userEvent = createTurnEvent({ invocationId, author: 'user', content: message });
  const start = workflowResume({ events: [...history, userEvent], invocationId, userContent: message, workflowPath: cfg.syndicate_name });
  let error: string | undefined;
  const run = await runWorkflowGraph(buildWorkflowGraph(cfg), {
    input: start.input,
    resume: start.resume,
    runNode: askUserNodeRunner({ invocationId, onEvent: (e) => events.push(e) }, async (r) => {
      const name = r.target.kind === 'map_item' ? r.target.agent : r.target.name;
      calls.push(name);
      const output = stubs[name]!(r.input);
      if (output !== undefined) events.push(stubEvent(r, name, output, invocationId));
      return { output };
    }),
    // The events ADK stores for a join and a map (lib/workflow/nodeEvents.ts), as agentNodeRuntime stores them on node_end.
    onEvent: (e) => {
      if (e.type !== 'node_end') return;
      const run = { name: e.node, path: e.path, branch: e.branch, invocationId, output: e.output };
      const event = e.kind === 'join' ? joinNodeEvent(run) : e.kind === 'map' ? mapNodeEvent(run) : undefined;
      if (event) events.push(event);
    },
  }).catch((e: Error) => {
    error = e.message;
    return undefined;
  });
  if (run && run.interruptIds.length > 0) events.push(workflowPauseEvent({ name: cfg.syndicate_name, invocationId, input: start.input, interruptIds: run.interruptIds }));
  return { run: run ?? { output: undefined, outputs: new Map(), order: [], nodeErrors: [], interruptIds: [] }, error, events: json(events), calls, userEvent };
}

/**
 * Pause on ADK, answer on ADK; then answer the same pause on the scheduler,
 * from ADK's stored events and from the scheduler's own pause. All three
 * answers write the same events and call the same stubs.
 */
async function resumesAlike(name: string, cfg: SyndicateYamlConfig, stubs: Stubs, answer: Message) {
  const go: Message = { role: 'user', parts: [{ text: 'go' }] };
  const adk = await adkTurns(name, cfg, stubs, [go, answer]);
  const [firstAdk, secondAdk] = adk.turns as [TurnEvent[], TurnEvent[]];
  const adkPaused = adk.stored.slice(0, adk.stored.length - secondAdk.length - 1);

  // From ADK's session.
  const fromAdk = await nativeTurnOnEvents(cfg, stubs, adkPaused, answer);
  assert.deepEqual(comparable(fromAdk.events, adkPaused), comparable(secondAdk, adkPaused), 'resumed from ADK\'s session: the events ADK wrote');

  // From the scheduler's own pause.
  const own = await nativeTurnOnEvents(cfg, stubs, [], go);
  assert.deepEqual(comparable(own.events), comparable(firstAdk), 'the pause');
  const ownPaused = [own.userEvent, ...own.events];
  const fromOwn = await nativeTurnOnEvents(cfg, stubs, ownPaused, answer);
  assert.deepEqual(comparable(fromOwn.events, ownPaused), comparable(secondAdk, adkPaused), 'resumed from its own session: the events ADK wrote');

  assert.equal(fromAdk.error, adk.errors[1], 'the resume ends as ADK\'s does');
  assert.equal(fromOwn.error, adk.errors[1]);
  const adkSecondCalls = adk.calls.slice(own.calls.length);
  assert.deepEqual(fromAdk.calls, adkSecondCalls, 'the agents the resume ran');
  assert.deepEqual(fromOwn.calls, adkSecondCalls);
  return { adk: secondAdk, native: fromAdk };
}

const chain = () => syndicate([['START', 'Triage', 'Confirm', 'Publisher']], { Confirm: { ask_user: 'Publish?' } }, ['Publisher']);

test('the chain: a plain-text answer reruns Confirm on its input and Publisher runs, as on ADK', async () => {
  const { native } = await resumesAlike('chain-plain-text-answer', chain(), STUBS, { role: 'user', parts: [{ text: 'yes' }] });
  assert.deepEqual(native.calls, ['Publisher'], 'Triage did not run again');
  assert.equal(native.run.output, 'published {"reply":"yes","input":"the draft"}');
});

test('an answer as a function response with the interrupt id: unwrapped from { result }, as on ADK', async () => {
  const cfg = chain();
  const go: Message = { role: 'user', parts: [{ text: 'go' }] };
  const replyTo = (raised: string): Message => ({ role: 'user', parts: [{ functionResponse: { id: raised, name: 'adk_request_input', response: { result: 'yes' } } }] });
  // ADK's side, recorded: the paused session, and the events ADK yields for the answer.
  const { paused, adkSecond } = await reference('function-response-answer', async () => {
    const { FunctionNode, InMemorySessionService, Runner } = await import('@google/adk');
    const toStub = (a: LlmAgent) => new FunctionNode(a.name, (_c: unknown, input: unknown) => STUBS[a.name]!(input)) as unknown as LlmAgent;
    const { workflow } = await compileWorkflow(cfg, {}, toStub);
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({ ...STUB_APP });
    const runner = new Runner({ agent: workflow as any, appName: STUB_APP.appName, sessionService });
    for await (const _ of runner.runAsync({ userId: 'u', sessionId: 's', newMessage: go as any }));
    const paused = json((await sessionService.getSession({ ...STUB_APP }))!.events) as unknown as TurnEvent[];
    const raised = paused.flatMap((e) => e.longRunningToolIds ?? [])[0]!;
    const adkSecond: TurnEvent[] = [];
    for await (const ev of runner.runAsync({ userId: 'u', sessionId: 's', newMessage: replyTo(raised) as any })) adkSecond.push(json(ev) as unknown as TurnEvent);
    return { paused, adkSecond };
  });
  const reply = replyTo(paused.flatMap((e) => e.longRunningToolIds ?? [])[0]!);

  const native = await nativeTurnOnEvents(cfg, STUBS, paused, reply);
  assert.deepEqual(comparable(native.events, paused), comparable(adkSecond, paused));
  assert.deepEqual(native.calls, ['Publisher']);
  assert.equal(native.run.output, 'published {"reply":"yes","input":"the draft"}');
});

test('a pause on one branch of a fan-out: the finished branch is not rerun, the paused one resumes on its branch, and two terminal outputs fail it, as on ADK', async () => {
  const cfg = syndicate([['START', 'Triage', ['Confirm', 'Reader']], ['Confirm', 'Publisher']], { Confirm: { ask_user: 'Publish?' } }, ['Publisher', 'Reader']);
  const { native } = await resumesAlike('fan-out-branch-pause', cfg, STUBS, { role: 'user', parts: [{ text: 'yes' }] });
  assert.deepEqual(native.calls, ['Publisher']);
  assert.equal(native.error, 'Workflow Graph: multiple terminal nodes produced output (2). A workflow must have at most one terminal output.', 'Reader\'s stored output counts as a terminal output, as on ADK');
  assert.equal(native.events[0]!.branch, 'Confirm@1', 'Confirm answers on the branch it asked on');
  assert.equal(native.events[1]!.branch, 'Confirm@1', 'Publisher inherits it');
});

test('a join after the paused node: the finished predecessor feeds the join from its stored output, as on ADK', async () => {
  const cfg = syndicate(
    [['START', 'Triage', ['Confirm', 'Reader']], ['Confirm', 'Both'], ['Reader', 'Both'], ['Both', 'Publisher']],
    { Confirm: { ask_user: 'Publish?' }, Both: { join: true } },
    ['Publisher', 'Reader'],
  );
  const { native } = await resumesAlike('join-after-paused-node', cfg, STUBS, { role: 'user', parts: [{ text: 'yes' }] });
  assert.deepEqual(native.calls, ['Publisher']);
  assert.deepEqual(JSON.parse(String(native.run.output).replace(/^published /, '')), { Confirm: { reply: 'yes', input: 'the draft' }, Reader: 'read "the draft"' });
});

test('a map on the finished branch: completed from its stored list, no map event written again, and the join gets it, as on ADK', async () => {
  const cfg = syndicate(
    [['START', 'Triage', ['Confirm', 'Fan']], ['Confirm', 'Both'], ['Fan', 'Both'], ['Both', 'Publisher']],
    { Confirm: { ask_user: 'Publish?' }, Fan: { map: 'Reader' }, Both: { join: true } },
    ['Publisher', 'Reader'],
  );
  const { native } = await resumesAlike('map-on-finished-branch', cfg, STUBS, { role: 'user', parts: [{ text: 'yes' }] });
  assert.deepEqual(native.calls, ['Publisher'], 'no map item ran again');
  assert.deepEqual(JSON.parse(String(native.run.output).replace(/^published /, '')), { Confirm: { reply: 'yes', input: 'the draft' }, Fan: ['read "the draft"'] });
});

test('two ask_user nodes in a row: the second takes the first answer without asking, as ADK\'s compiled handler does', async () => {
  const cfg = syndicate([['START', 'Triage', 'Confirm', 'Again', 'Publisher']], { Confirm: { ask_user: 'Publish?' }, Again: { ask_user: 'Sure?' } }, ['Publisher']);
  const { native } = await resumesAlike('two-ask-user-nodes', cfg, STUBS, { role: 'user', parts: [{ text: 'yes' }] });
  assert.deepEqual(native.run.interruptIds, [], 'ADK asks once: every answer reaches every ask_user node of the resumed walk');
  assert.deepEqual(JSON.parse(String(native.run.output).replace(/^published /, '')), { reply: 'yes', input: { reply: 'yes', input: 'the draft' } });
});

test('a session with nothing paused: every node runs fresh, the new message the input', async () => {
  const first = await adkTurns('nothing-paused-first-turn', syndicate([['START', 'Triage', 'Publisher']], {}, ['Publisher']), STUBS, [{ role: 'user', parts: [{ text: 'go' }] }]);
  const plain = syndicate([['START', 'Triage', 'Publisher']], {}, ['Publisher']);
  const again = await nativeTurnOnEvents(plain, STUBS, first.stored, { role: 'user', parts: [{ text: 'again' }] });
  assert.deepEqual(again.calls, ['Triage', 'Publisher']);
  assert.deepEqual(again.run.order, ['Triage', 'Publisher']);
});

test('a reply to an interrupt the run never raised is refused with ADK\'s message, and resolves nothing', async () => {
  const first = await adkTurns('forged-reply-first-turn', chain(), STUBS, [{ role: 'user', parts: [{ text: 'go' }] }]);
  const forged = { role: 'user' as const, parts: [{ functionResponse: { id: 'not-raised', name: 'adk_request_input', response: { result: 'yes' } } }] };
  await assert.rejects(nativeTurnOnEvents(chain(), STUBS, first.stored, forged), /The reply carries interrupt id 'not-raised', which does not match any interrupt this run raised\. Still waiting: '/);
});

test('the scheduler: a resumed node with a stored output and no open interrupt completes without running and emits node_resumed only', async () => {
  const graph = buildWorkflowGraph(chain());
  const ran: string[] = [];
  const seen: SchedulerEvent[] = [];
  const run = await runWorkflowGraph(graph, {
    input: 'new',
    resume: {
      priorRuns: new Map([
        ['Triage', [{ output: 'stored', interruptIds: new Set<string>(), resolvedResponses: new Map() }]],
        ['Confirm', [{ input: 'stored', interruptIds: new Set(['i-1']), resolvedResponses: new Map() }]],
      ]),
      resumeInputs: { 'i-1': 'ok' },
    },
    runNode: (r) => {
      ran.push(`${r.path} ${JSON.stringify(r.input)} ${JSON.stringify(r.resumeInputs)} ${r.runId}`);
      return r.target.kind === 'ask_user' ? { output: { reply: Object.values(r.resumeInputs ?? {}).at(-1), input: r.input } } : { output: 'out' };
    },
    onEvent: (e) => seen.push(e),
  });
  assert.deepEqual(ran, ['Graph.Confirm "stored" {"i-1":"ok"} 1', 'Graph.Publisher {"reply":"ok","input":"stored"} {"i-1":"ok"} 1']);
  assert.deepEqual(seen[0], { type: 'node_resumed', node: 'Triage', kind: 'agent', path: 'Graph.Triage', branch: undefined, output: 'stored', from: 'stored' });
  assert.equal(run.output, 'out');
});

test('the scheduler: a paused node that does not rerun on resume completes with its answers', async () => {
  const cfg = syndicate([['START', 'Triage', 'Lookup', 'Publisher']], { Lookup: { tool: 'fixture_lookup' } }, ['Publisher']);
  const graph = buildWorkflowGraph(cfg);
  assert.equal(rerunsOnResume(graph.nodes.get('Lookup')!), false);
  const ran: string[] = [];
  const seen: SchedulerEvent[] = [];
  const run = await runWorkflowGraph(graph, {
    input: 'x',
    resume: {
      priorRuns: new Map([
        ['Triage', [{ output: 'd', interruptIds: new Set<string>(), resolvedResponses: new Map() }]],
        ['Lookup', [{ input: 'd', interruptIds: new Set(['a', 'b']), resolvedResponses: new Map() }]],
      ]),
      resumeInputs: { a: 1, b: 2 },
    },
    runNode: (r) => {
      ran.push(r.path);
      return { output: r.input };
    },
    onEvent: (e) => seen.push(e),
  });
  assert.deepEqual(ran, ['Graph.Publisher']);
  assert.deepEqual(run.output, [1, 2]);
  assert.deepEqual(seen.filter((e) => e.type === 'node_resumed').map((e) => (e as { from: string }).from), ['stored', 'answers']);
});

test('rerunsOnResume is ADK\'s per kind: agents, ask_user and maps rerun; tools, joins and route steps do not', () => {
  const kinds = { agent: true, ask_user: true, map: true, tool: false, join: false, route: false, start: false } as const;
  for (const [kind, reruns] of Object.entries(kinds)) assert.equal(rerunsOnResume({ kind } as any), reruns, kind);
});

// ── 3. The port, against ADK's own functions ─────────────────────────────────

/** ADK's own rehydration functions. Live only (inside a reference). */
const adkRehydration = async () => import(pathToFileURL(path.join(ROOT, 'node_modules/@google/adk/dist/esm/workflow/utils/rehydration_utils.js')).href);

/** Event lists that exercise every branch the port reads. */
function eventCases(): Array<[string, StoredEvent[], string]> {
  const fixture = conversation(loadFixture(FIXTURE)).events as unknown as StoredEvent[];
  const id = fixture.flatMap((e) => e.longRunningToolIds ?? [])[0]!;
  const ev = (init: StoredEvent): StoredEvent => ({ actions: {}, longRunningToolIds: [], ...init });
  const answerText = ev({ author: 'user', invocationId: 'e-2', content: { role: 'user', parts: [{ text: 'yes' }] } });
  const answerFr = (rid: string, response: Record<string, unknown>) => ev({ author: 'user', invocationId: 'e-2', content: { role: 'user', parts: [{ functionResponse: { id: rid, name: 'adk_request_input', response } }] } });
  const schemaReq = ev({
    author: 'Ask',
    invocationId: 'e-1',
    content: { role: 'model', parts: [{ functionCall: { name: 'adk_request_input', id: 'k', args: { interruptId: 'k', payload: null, message: 'm', response_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } } }] },
    longRunningToolIds: ['k'],
    nodeInfo: { path: 'G.Ask' },
  });
  return [
    ['the fixture, answered in text', [...fixture, answerText], 'e-2'],
    ['the fixture, answered by id', [...fixture, answerFr(id, { result: 'yes' })], 'e-2'],
    ['the fixture, answered by id with an object', [...fixture, answerFr(id, { ok: true })], 'e-2'],
    ['the fixture, still running in its own invocation', fixture, 'e-00000000-0000-4000-8000-000000000001'],
    ['a finished run before a new one', [ev({ author: 'A', invocationId: 'e-0', output: 'x', nodeInfo: { path: 'G.A' } }), ev({ author: 'user', invocationId: 'e-1', content: { role: 'user', parts: [{ text: 'hi' }] } })], 'e-1'],
    ['a structured reply that matches the schema', [schemaReq, answerFr('k', { ok: true })], 'e-2'],
    ['a JSON string reply, parsed', [schemaReq, answerFr('k', { result: '{"ok":false}' })], 'e-2'],
    [
      'two runs of one node, paths with run suffixes, a route, an event without an invocation id',
      [
        ev({ author: 'R', invocationId: 'e-1', route: 'a', nodeInfo: { path: 'G.R@1' } }),
        ev({ author: 'R', output: 'o', branch: 'b@1', nodeInfo: { path: 'G.R@2' } }),
        ev({ author: 'Deep', invocationId: 'e-1', output: 'no', nodeInfo: { path: 'G.Sub.Deep' } }),
        ev({ author: 'Ask', invocationId: 'e-1', content: { role: 'model', parts: [{ functionCall: { name: 'adk_request_credential', args: { function_call_id: 'c' } } }] }, longRunningToolIds: ['c'], nodeInfo: { path: 'G.Ask' } }),
        answerText,
      ],
      'e-2',
    ],
  ];
}

/**
 * A value of the port's as a reference holds it: a Map as its entries, a Set
 * as its members, in JSON's form, then the reference's canonical form
 * (tests/helpers/adkReference.ts), which the recorded ADK value is in. Equal
 * values stay equal; ids the canonical form renumbers are renumbered alike.
 */
const plain = (v: unknown): unknown =>
  v instanceof Map
    ? { map: [...v].map(([k, x]) => [k, plain(x)]) }
    : v instanceof Set
      ? { set: [...v].map(plain) }
      : Array.isArray(v)
        ? v.map(plain)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
          : v;
const asRecorded = <T>(v: T): unknown => canonical(plain(v));

const PARENTS = [undefined, 'G', 'Workflow Fixture'];

/** What the four functions return for one event case: the run's events, the runs and states under each parent, the answers, and whether each run under G fast-forwards. */
function rehydrated(
  fns: Pick<typeof import('../lib/workflow/resume.ts'), 'eventsForCurrentRun' | 'reconstructNodeRuns' | 'reconstructNodeStates' | 'resolvedInterruptResponses' | 'isFastForwardable'>,
  events: StoredEvent[],
  invocationId: string,
) {
  // The runs whose fast-forward is asked are the port's own, as the comparison has always handed both sides the same run.
  const ownRuns = [...reconstructNodeRuns(eventsForCurrentRun(events, invocationId), 'G').values()].flat();
  const runEvents = eventsForCurrentRun(events, invocationId);
  return {
    current: fns.eventsForCurrentRun(events, invocationId),
    parents: PARENTS.map((parent) => ({ runs: fns.reconstructNodeRuns(runEvents, parent), states: fns.reconstructNodeStates(runEvents, parent) })),
    answers: fns.resolvedInterruptResponses(runEvents),
    fastForward: ownRuns.map((run) => fns.isFastForwardable(run)),
  };
}

test('eventsForCurrentRun, reconstructNodeRuns, reconstructNodeStates and resolvedInterruptResponses are ADK\'s, case for case', async () => {
  const cases = eventCases();
  const port = { eventsForCurrentRun, reconstructNodeRuns, reconstructNodeStates, resolvedInterruptResponses, isFastForwardable };
  const theirs = (await reference('rehydration-functions', async () => {
    const adk = await adkRehydration();
    return plain(cases.map(([, events, invocationId]) => rehydrated(adk, events, invocationId)));
  })) as Array<ReturnType<typeof rehydrated>>;
  const ours = asRecorded(cases.map(([, events, invocationId]) => rehydrated(port, events, invocationId))) as Array<ReturnType<typeof rehydrated>>;
  assert.equal(theirs.length, cases.length);
  cases.forEach(([label], i) => {
    const [o, t] = [ours[i]!, theirs[i]!];
    assert.deepEqual(o.current, t.current, `${label}: the run's events`);
    PARENTS.forEach((parent, k) => {
      assert.deepEqual(o.parents[k]!.runs, t.parents[k]!.runs, `${label}: runs under ${parent}`);
      assert.deepEqual(o.parents[k]!.states, t.parents[k]!.states, `${label}: states under ${parent}`);
    });
    assert.deepEqual(o.answers, t.answers, `${label}: the answers`);
    assert.deepEqual(o.fastForward, t.fastForward, label);
  });
});

test('a refused reply throws ADK\'s message: an unknown id, an id answered before, a structured reply the schema refuses', async () => {
  const fixture = conversation(loadFixture(FIXTURE)).events as unknown as StoredEvent[];
  const id = fixture.flatMap((e) => e.longRunningToolIds ?? [])[0]!;
  const reply = (rid: string, response: Record<string, unknown>, invocationId = 'e-2'): StoredEvent => ({ author: 'user', invocationId, actions: {}, content: { role: 'user', parts: [{ functionResponse: { id: rid, name: 'adk_request_input', response } }] } });
  const schemaReq: StoredEvent = {
    author: 'Ask',
    invocationId: 'e-1',
    actions: {},
    content: { role: 'model', parts: [{ functionCall: { name: 'adk_request_input', id: 'k', args: { response_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } } }] },
    longRunningToolIds: ['k'],
  };
  const cases: StoredEvent[][] = [
    [...fixture, reply('nope', { result: 'x' })],
    [...fixture, reply(id, { result: 'x' }, 'e-2'), reply(id, { result: 'y' }, 'e-3')],
    [schemaReq, reply('k', { ok: 'not a boolean' })],
  ];
  /** What each case throws (its message), or '' when it does not throw. */
  const refusals = (resolve: (events: StoredEvent[]) => unknown): string[] =>
    cases.map((events) => {
      try {
        resolve(events);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    });
  const theirs = await reference('refused-replies', async () => {
    const adk = await adkRehydration();
    return refusals((events) => adk.resolvedInterruptResponses(events));
  });
  const ours = asRecorded(refusals((events) => resolvedInterruptResponses(events))) as string[];
  cases.forEach((_, i) => {
    assert.ok(theirs[i], 'ADK refuses it');
    assert.equal(ours[i], theirs[i], `case ${i + 1}: the same message`);
  });
});

test('unwrapResponse and nodeNameFromPath are ADK\'s', async () => {
  const schemas = [undefined, { type: 'string' }, { type: ['null', 'string'] }, { anyOf: [{ type: 'number' }, { type: 'string' }] }, { type: 'object' }];
  const responses = [{ result: 'yes' }, { result: '{"a":1}' }, { result: '[1' }, { result: 3 }, { result: 'x', other: 1 }, { a: 1 }, 'bare', null];
  const paths = ['G.A', 'G.A@2', 'G', 'G.M.Agent@0', 'a/b@1', '', 'x@', '.', 'G.A.B@3@4'];
  const pairs = schemas.flatMap((schema) => responses.map((response) => [response, schema] as const));
  /** Each unwrapped response (as { value }, so undefined survives JSON as no key), and each path's node name. */
  const outputs = (fns: { unwrapResponse: (r: unknown, s?: unknown) => unknown; nodeNameFromPath: (p: string) => string }) => ({
    unwrapped: pairs.map(([response, schema]) => ({ value: fns.unwrapResponse(response, schema) })),
    names: paths.map((p) => fns.nodeNameFromPath(p)),
  });
  const theirs = await reference('unwrap-and-node-names', async () => outputs(await adkRehydration()));
  const ours = asRecorded(outputs({ unwrapResponse, nodeNameFromPath })) as typeof theirs;
  pairs.forEach((pair, i) => assert.deepEqual(ours.unwrapped[i], theirs.unwrapped[i], JSON.stringify(pair)));
  paths.forEach((p, i) => assert.equal(ours.names[i], theirs.names[i], p));
});

test('the plain-text answer goes to the one open interrupt, and to none when several or none are open', () => {
  const fixture = conversation(loadFixture(FIXTURE)).events as unknown as StoredEvent[];
  const id = fixture.flatMap((e) => e.longRunningToolIds ?? [])[0]!;
  const text: TurnContent = { role: 'user', parts: [{ text: 'ye' }, { text: 's' }] };
  const withMessage = [...fixture, { author: 'user', invocationId: 'e-2', content: text }];
  assert.deepEqual(resumeInputsFromPlainText(text, withMessage, 'e-2'), { [id]: 'yes' });
  assert.deepEqual(resumeInputsFromPlainText({ role: 'user', parts: [{ text: 'a' }, { inlineData: { mimeType: 'image/png', data: '' } }] }, withMessage, 'e-2'), {}, 'not plain text');
  const twoOpen = [...fixture, { author: 'Other', invocationId: 'e-00000000-0000-4000-8000-000000000001', longRunningToolIds: ['other'], nodeInfo: { path: 'Workflow Fixture.Other' } }];
  assert.deepEqual(resumeInputsFromPlainText(text, [...twoOpen, { author: 'user', invocationId: 'e-2', content: text }], 'e-2'), {});
  assert.deepEqual(workflowNodeInput(text), 'yes');
  const media: TurnContent = { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: '' } }] };
  assert.equal(workflowNodeInput(media), media, 'no text: the message itself, as ADK hands it');
  assert.equal(workflowNodeInput(undefined), undefined);
});

test('a pause ADK raised inside a map item or an agent node is refused by name, not rerun: only ADK resumes those', () => {
  const user = { author: 'user', invocationId: 'e-2', content: { role: 'user', parts: [{ text: 'yes' }] } };
  const record = { author: 'G', invocationId: 'e-1', longRunningToolIds: ['q'], nodeInfo: { path: 'G' } };
  // An OAuth consent (ADR 0085) inside an agent: ADK's adk_request_credential, which its rehydration treats as a pause.
  const consent = (path: string) => ({ author: 'Agent', invocationId: 'e-1', content: { role: 'model', parts: [{ functionCall: { name: 'adk_request_credential', id: 'q', args: {} } }] }, longRunningToolIds: ['q'], nodeInfo: { path } });
  const resume = (events: StoredEvent[]) => workflowResume({ events, invocationId: 'e-2', userContent: user.content, workflowPath: 'G' });
  assert.throws(() => resume([consent('G.Fan.Agent@0'), record, user]), (e: Error) => e instanceof UnsupportedWorkflowResumeError && /'G\.Fan\.Agent@0' was raised inside a nested node \(a map item\)/.test(e.message));
  assert.throws(() => resume([consent('G.Agent'), record, user]), (e: Error) => e instanceof UnsupportedWorkflowResumeError && /'G\.Agent' was raised inside an agent node/.test(e.message));
  // An ask_user TOOL call is no pause to ADK's rehydration (requiresUserInput reads only ADK's request calls): ADK walks afresh, and so does this.
  const askTool = { ...consent('G.Agent'), content: { role: 'model', parts: [{ functionCall: { name: 'ask_user', id: 'q', args: { question: '?' } } }] } };
  const fresh = resume([askTool, record, user]);
  assert.deepEqual([...fresh.resume.priorRuns.keys()], [], 'nothing to resume: the walk starts afresh, as on ADK');
  const fixture = conversation(loadFixture(FIXTURE)).events as unknown as StoredEvent[];
  assert.doesNotThrow(() => workflowResume({ events: [...fixture, user], invocationId: 'e-2', userContent: user.content, workflowPath: 'Workflow Fixture' }), 'an ask_user node\'s pause resumes');
});

// ── No ADK ───────────────────────────────────────────────────────────────────

test('lib/workflow/resume.ts reaches ADK through no value import', () => {
  const visited = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const [statement] of src.matchAll(/^import\s[^;]*;/gm)) {
      if (/^import\s+type\s/.test(statement)) continue;
      const spec = /from\s+'([^']*)'/.exec(statement)?.[1] ?? '';
      if (spec.startsWith('@google/adk') || spec.startsWith('@google/genai')) offenders.push(`${path.relative(ROOT, file)}: ${spec}`);
      if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), spec));
    }
  };
  visit(path.join(ROOT, 'lib/workflow/resume.ts'));
  assert.deepEqual(offenders, []);
});
