/**
 * tests/nativeStep.test.ts — one model step of the native loop
 * (lib/runtime/native/step.ts, lib/runtime/native/request.ts, WS2-5a,
 * ADR 0066).
 *
 * The parity cases read a syndicate's run as ADK 2.2 recorded it with a
 * scripted adapter behind the pre-1.0 shim (the request the shim handed it,
 * tests/fixtures/adk-reference/nativestep), then rebuild each of those calls
 * on the native step from the same session as it stood before the call: the
 * adapter must be handed the same request, and the step must store the same
 * event for the same answer. Then the
 * turn's controls (step limit, deadline, cancel), the span, streaming, and
 * the instruction's state placeholders. Offline: scripted adapters only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';

import { compileNativeGraph } from '../lib/compileNative.ts';
import type { ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { flushTracing, onSpanEnd } from '../lib/observability/tracer.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import type { TurnControl } from '../lib/runtime/turnControl.ts';
import type { TurnContent, TurnEvent } from '../lib/runtime/events.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { Session } from '../lib/runtime/sessions.ts';
import { buildModelRequest, injectSessionState } from '../lib/runtime/native/request.ts';
import type { NativeAgent } from '../lib/runtime/native/request.ts';
import { projectHistory } from '../lib/runtime/native/history.ts';
import { SelfCorrection } from '../lib/runtime/native/selfCorrection.ts';
import { runModelStep } from '../lib/runtime/native/step.ts';
import type { ModelStepOptions } from '../lib/runtime/native/step.ts';
import { registerTool, resolveTools } from '../lib/toolRegistry.ts';
import { instructionToolOf, toolOf } from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, failure, toolCall, untilAborted } from './helpers/scriptedModel.ts';
import { adkReferences } from './helpers/adkReference.ts';

// ADK's side of each parity case, as ADK 2.2 recorded it (tests/fixtures/adk-reference/nativestep).
const reference = adkReferences('nativeStep');

const APP = 'native-step';
const USER = 'u1';
const SKILLS = join(import.meta.dirname, 'fixtures', 'skills');

registerTool(
  'native_step_lookup',
  defineTool({
    name: 'native_step_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string().describe('What to look up.'), limit: z.number().int().default(3) }),
    execute: async ({ key }) => `found ${key}`,
  }),
  { override: true },
);
// The tool the release-notes fixture skill names in its allowed-tools.
registerTool(
  'harness_test_lookup',
  defineTool({ name: 'harness_test_lookup', description: 'Look something up.', schema: z.object({ key: z.string() }), execute: async ({ key }) => `looked up ${key}` }),
  { override: true },
);

// ── The ADK side: a syndicate's run, recorded ────────────────────────────────

/**
 * A one-agent syndicate, retries at their defaults: ADK's reflect-and-retry
 * model plugin declares its reflection tool (`adk_handle_model_error`) on
 * every request, and the native step declares it through self-correction's
 * model side (lib/runtime/native/selfCorrection.ts).
 */
function syndicate(orchestrator: Record<string, unknown>): SyndicateYamlConfig {
  return validateSyndicateConfig(
    { syndicate_name: APP, orchestrator: { model: 'scripted/boss', ...orchestrator }, subagents: [] },
    'test',
  ) as SyndicateYamlConfig;
}

/** Each call the adapter took in ADK's recorded run: the request it was handed (its signal aside) and what it answered. */
interface AdkCall {
  request: Omit<ModelRequest, 'signal'>;
  responses: ModelResponse[];
}

// ── The native side: the same agent, from the same YAML ──────────────────────

/** The registry's object as the native loop holds it: the own Tool or InstructionTool behind it, a marker as it is. */
const own = (tool: unknown): unknown => toolOf(tool) ?? instructionToolOf(tool) ?? tool;

/** The orchestrator as the native step runs it: the compile split's NativeAgent (lib/compileNative.ts). */
const nativeAgentOf = (config: SyndicateYamlConfig): Promise<NativeAgent> => compileNativeGraph(config, { log: () => {} });

/** A store holding the session as ADK held it before the call: the events up to it, replayed. */
async function sessionBefore(events: TurnEvent[], upTo: number): Promise<{ session: Session; sessions: InProcessSessionService }> {
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: APP, userId: USER, sessionId: 's1' });
  for (const event of events.slice(0, upTo)) await sessions.append(session, structuredClone(event));
  return { session, sessions };
}

const withoutSignal = ({ signal, ...rest }: ModelRequest) => (assert.ok(signal instanceof AbortSignal, 'the request carries the turn’s signal'), rest);
const comparable = (event: TurnEvent | undefined) => JSON.parse(JSON.stringify({ ...event, id: '<id>', timestamp: 0 }));

/**
 * Reads the syndicate's recorded ADK run, then runs each of its model calls
 * on the native step: same request to the adapter, same event stored.
 * `_script` and `_messages` say what the recorded run's adapter answered and
 * what the user sent; the recording holds both. Returns the native requests,
 * for case-specific asserts.
 */
async function assertParity(
  name: string,
  orchestrator: Record<string, unknown>,
  _script: (request: ModelRequest, call: number) => ModelResponse | ModelResponse[],
  _messages: string[],
): Promise<ModelRequest[]> {
  const config = syndicate(orchestrator);
  const adk = await reference<{ calls: AdkCall[]; events: TurnEvent[] }>(name);
  const agent = await nativeAgentOf(config);
  const modelEvents = adk.events.map((e, i) => [e, i] as const).filter(([e]) => e.content?.role === 'model');
  assert.equal(modelEvents.length, adk.calls.length, 'one stored model event per call');

  const nativeRequests: ModelRequest[] = [];
  const selfCorrection = new SelfCorrection(config.retries);
  for (const [k, call] of adk.calls.entries()) {
    const [adkEvent, at] = modelEvents[k] as readonly [TurnEvent, number];
    const { session, sessions } = await sessionBefore(adk.events, at);
    const userEvent = adk.events.slice(0, at).findLast((e) => e.author === 'user' && e.invocationId === adkEvent.invocationId);
    const adapter = new ScriptedModel('scripted/boss', () => call.responses);
    const control = createTurnControl();
    const step = await runWithTurnControl(control, () =>
      runModelStep({
        agent,
        session,
        sessions,
        invocationId: adkEvent.invocationId,
        userContent: userEvent?.content as TurnContent,
        adapter,
        correction: selfCorrection.forModel(agent.name, adkEvent.invocationId),
      }),
    );
    control.dispose();
    assert.equal(adapter.calls, 1);
    assert.deepEqual(withoutSignal(adapter.requests[0] as ModelRequest), call.request, `call ${k + 1}: the request`);
    assert.equal(adapter.requests[0]?.signal, control.signal);
    assert.deepEqual(comparable(step.event), comparable(adkEvent), `call ${k + 1}: the stored event`);
    const stored = await sessions.get({ appName: APP, userId: USER, sessionId: 's1' });
    assert.deepEqual(comparable(stored?.events.at(-1)), comparable(adkEvent), `call ${k + 1}: the store holds it`);
    nativeRequests.push(adapter.requests[0] as ModelRequest);
  }
  return nativeRequests;
}

// ── Parity: three fixtures and a long-running call ───────────────────────────

test('parity: a plain agent over two turns sends the ADK request and stores the ADK event', async () => {
  const requests = await assertParity(
    'plain-agent-two-turns',
    {
      name: 'Solo',
      description: 'Answers questions',
      instruction: 'Answer briefly. Topic: {topic?}. Keep JSON such as { "a": 1 } as it is.',
      globalInstruction: 'Be kind.',
      reasoning: 'low',
      generateContentConfig: { temperature: 0.2, maxOutputTokens: 512, stopSequences: ['END'] },
    },
    (_req, n) => answer(n === 1 ? 'first answer' : 'second answer', { inputTokens: 12, outputTokens: 5 }),
    ['hello', 'again'],
  );
  const second = requests[1] as ModelRequest;
  assert.equal(
    second.system,
    'You are an agent. Your internal name is "Solo".\n\nThe description about you is "Answers questions"\n\nBe kind.\n\nAnswer briefly. Topic: . Keep JSON such as { "a": 1 } as it is.',
  );
  assert.deepEqual(
    second.messages.map((m) => [m.role, m.parts.map((p) => (p.type === 'text' ? p.text : p.type))]),
    [['user', ['hello']], ['assistant', ['first answer']], ['user', ['again']]],
  );
  assert.deepEqual(second.sampling, { temperature: 0.2, maxOutputTokens: 512, stop: ['END'] });
  assert.equal(second.stream, false);
  assert.ok(second.reasoning !== undefined, 'reasoning: low reaches the request');
});

test('parity: an agent with tools and an output schema (set_model_response) sends and stores what ADK does', async () => {
  const requests = await assertParity(
    'tools-and-output-schema',
    {
      name: 'Grader',
      instruction: 'Look the key up, then grade.',
      tools: ['native_step_lookup', 'web_search', 'load_memory'],
      outputSchema: { type: 'object', properties: { verdict: { type: 'string' }, score: { type: 'integer' } }, required: ['verdict'] },
    },
    (_req, n) =>
      n === 1
        ? toolCall('native_step_lookup', { key: 'alpha' }, 'call-lookup-1')
        : { ...toolCall('set_model_response', { verdict: 'pass', score: 3 }, 'call-smr-1'), usage: { inputTokens: 40, outputTokens: 9, thinkingTokens: 2 } },
    ['grade alpha'],
  );
  const [first, second] = requests as [ModelRequest, ModelRequest];
  assert.deepEqual(first.tools?.map((t) => t.name), ['native_step_lookup', 'load_memory', 'set_model_response', 'adk_handle_model_error']);
  assert.deepEqual(first.nativeTools, ['web_search'], 'web_search, on a model the prefix table reads as Gemini');
  assert.equal(first.outputSchema, undefined, 'beside tools the schema is the set_model_response tool');
  assert.match(first.system ?? '', /call the "set_model_response" function/);
  assert.deepEqual(
    second.messages.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
});

test('parity: an agent with examples and a skill sends and stores what ADK does, the skill’s tool unlocked once loaded', async () => {
  const requests = await assertParity(
    'examples-and-skill',
    {
      name: 'Harness',
      instruction: 'Follow skills.',
      examples: [
        { input: 'notes for 1.2', output: 'Release 1.2: faster.' },
        { input: 'notes please', output: 'Which version?' },
      ],
      skills: { dir: SKILLS, tools: ['harness_test_lookup'] },
    },
    (_req, n) => (n === 1 ? toolCall('load_skill', { name: 'release-notes' }, 'call-skill-1') : answer('Release 2.0: smaller.')),
    ['write release notes for 2.0'],
  );
  const [first, second] = requests as [ModelRequest, ModelRequest];
  assert.match(first.system ?? '', /<available_skills>/);
  assert.match(first.system ?? '', /<EXAMPLES>[\s\S]*notes for 1\.2[\s\S]*<EXAMPLES>$/);
  assert.deepEqual(first.tools?.map((t) => t.name), ['load_skill', 'load_skill_resource', 'adk_handle_model_error']);
  assert.deepEqual(second.tools?.map((t) => t.name), ['load_skill', 'load_skill_resource', 'harness_test_lookup', 'adk_handle_model_error']);
});

test('parity: a call to a long-running tool is listed in longRunningToolIds, as ADK lists it', async () => {
  await assertParity(
    'long-running-call',
    { name: 'Asker', instruction: 'Ask when unsure.', tools: ['ask_user'] },
    () => toolCall('ask_user', { question: 'Which year?' }, 'call-ask-1'),
    ['what happened then?'],
  );
});

test('includeContents none: only the current turn, as ADK projects it', async () => {
  await assertParity(
    'include-contents-none',
    { name: 'Intake', instruction: 'Read the document.', includeContents: 'none' },
    (_req, n) => answer(`read ${n}`),
    ['doc one', 'doc two'],
  );
});

// ── The step on its own ──────────────────────────────────────────────────────

const plainAgent = (extra: Partial<NativeAgent> = {}): NativeAgent => ({ name: 'Solo', model: 'scripted/solo', instruction: 'Answer.', ...extra });

async function freshSession(text = 'hello'): Promise<{ session: Session; sessions: InProcessSessionService; userContent: TurnContent }> {
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: APP, userId: USER, sessionId: 'step' });
  const userContent = { role: 'user', parts: [{ text }] };
  await sessions.append(session, { id: 'u0000001', invocationId: 'e-1', author: 'user', content: userContent, actions: {}, timestamp: 1 });
  return { session, sessions, userContent };
}

async function step(control: TurnControl, adapter: ScriptedModel, extra: Partial<ModelStepOptions> = {}) {
  const { session, sessions, userContent } = await freshSession();
  const result = await runWithTurnControl(control, () =>
    runModelStep({ agent: plainAgent(), session, sessions, invocationId: 'e-1', userContent, adapter, ...extra }),
  );
  return { result, session };
}

test('the step limit: a spent turn gets no call and no event', async () => {
  const control = createTurnControl({ maxLlmCalls: 1 });
  const adapter = new ScriptedModel('scripted/solo', () => answer('ok'));
  const first = await step(control, adapter);
  assert.equal(first.result.text, 'ok');
  const second = await step(control, adapter);
  assert.deepEqual(second.result.stopped, { code: 'STEP_LIMIT', message: 'The turn reached its limit of 1 model calls (max_steps) and was stopped.' });
  assert.equal(adapter.calls, 1, 'the refused call never reached the adapter');
  assert.equal(second.result.event, undefined);
  assert.equal(second.session.events.length, 1, 'only the user event');
  assert.equal(control.llmCalls, 1);
  control.dispose();
});

test('the deadline: a hung call is aborted, and no event is stored for it', async () => {
  const control = createTurnControl({ deadlineMs: 20 });
  const adapter = new ScriptedModel('scripted/solo', (_req, _n, signal) => untilAborted(signal));
  const { result, session } = await step(control, adapter);
  assert.equal(result.stopped?.code, 'DEADLINE_EXCEEDED');
  assert.equal(adapter.requests[0]?.signal?.aborted, true);
  assert.equal(session.events.length, 1);
  control.dispose();
});

test('cancel: a canceled turn makes no call at all', async () => {
  const outer = new AbortController();
  outer.abort();
  const control = createTurnControl({ signal: outer.signal });
  const adapter = new ScriptedModel('scripted/solo', () => answer('never'));
  const { result, session } = await step(control, adapter);
  assert.deepEqual(result.stopped, { code: 'CANCELED', message: 'The task was canceled.' });
  assert.equal(adapter.calls, 0);
  assert.equal(control.llmCalls, 0, 'nothing charged');
  assert.equal(session.events.length, 1);
  control.dispose();
});

test('a failed call is stored as ADK stores it, with the error on the result', async () => {
  const control = createTurnControl();
  const adapter = new ScriptedModel('scripted/solo', () => failure({ code: 'SCRIPTED_ERROR', message: 'overloaded', retryable: true, status: 503 }));
  const { result } = await step(control, adapter);
  assert.equal(result.error?.code, 'SCRIPTED_ERROR');
  assert.equal(result.event?.errorCode, 'SCRIPTED_ERROR');
  assert.deepEqual(result.event?.customMetadata, { 'error.retryable': true, 'error.status': 503 });
  control.dispose();
});

test('streaming: partials reach the caller and are never stored; thinking is parsed from them', async () => {
  const control = createTurnControl();
  const adapter = new ScriptedModel('scripted/solo', () => [
    { partial: true, parts: [{ type: 'thinking', text: 'considering' }] },
    { partial: true, parts: [{ type: 'text', text: 'Hel' }] },
    { partial: true, parts: [{ type: 'text', text: 'lo' }] },
    answer('Hello'),
  ]);
  const partials: TurnEvent[] = [];
  const { result, session } = await step(control, adapter, { stream: true, onPartial: (e) => partials.push(e) });
  assert.equal(adapter.requests[0]?.stream, true);
  assert.equal(partials.length, 3);
  assert.ok(partials.every((e) => e.partial === true && e.author === 'Solo' && e.invocationId === 'e-1'));
  assert.equal(new Set([...partials, result.event].map((e) => e?.id)).size, 4, 'each event its own id');
  assert.deepEqual(partials[0]?.content?.parts, [{ text: 'considering', thought: true }]);
  assert.equal(result.thinking, 'considering');
  assert.equal(result.text, 'Hello');
  assert.deepEqual(session.events.map((e) => e.author), ['user', 'Solo'], 'only the final is stored');
  control.dispose();
});

test('a tool call without an id gets ADK’s adk- id, and the result lists the call as stored', async () => {
  const control = createTurnControl();
  const adapter = new ScriptedModel('scripted/solo', () => ({
    partial: false,
    parts: [{ type: 'toolCall', id: 'genai-noid-0-0', name: 'native_step_lookup', args: { key: 'x' } }],
    finishReason: 'tool_call',
  }));
  const { result } = await step(control, adapter, { agent: plainAgent({ tools: resolveTools(['native_step_lookup']).map(own) }) });
  assert.equal(result.toolCalls.length, 1);
  assert.match(result.toolCalls[0]?.id ?? '', /^adk-[0-9a-f-]{36}$/);
  assert.equal(result.event?.content?.parts?.[0]?.functionCall?.id, result.toolCalls[0]?.id);
  assert.deepEqual(result.longRunningToolIds, []);
  control.dispose();
});

async function spansDuring(model: string, fn: () => Promise<unknown>): Promise<ReadableSpan[]> {
  const spans: ReadableSpan[] = [];
  const off = onSpanEnd((span) => {
    if (span.name === 'llm.request' && span.attributes['llm.model'] === model) spans.push(span);
  });
  try {
    await fn();
    await flushTracing();
  } finally {
    off();
  }
  return spans;
}

test('the step opens one llm.request span and charges the turn', async () => {
  const control = createTurnControl();
  const adapter = new ScriptedModel('scripted/span-native', () => answer('x', { inputTokens: 9, outputTokens: 4, thinkingTokens: 1 }), 'anthropic');
  const [span, ...more] = await spansDuring('scripted/span-native', () =>
    step(control, adapter, { agent: plainAgent({ model: 'scripted/span-native' }) }),
  );
  assert.ok(span, 'a span');
  assert.equal(more.length, 0, 'exactly one');
  assert.equal(span.attributes['llm.provider'], 'anthropic');
  assert.equal(span.attributes['gen_ai.request.model'], 'scripted/span-native');
  assert.equal(span.attributes['llm.tokens.input'], 9);
  assert.equal(span.attributes['llm.tokens.output'], 3, 'Gemini’s meaning: output less thinking');
  assert.equal(span.attributes['llm.tokens.thinking'], 1);
  assert.deepEqual([control.llmCalls, control.inputTokens, control.outputTokens, control.thinkingTokens], [1, 9, 3, 1]);
  control.dispose();
});

// ── The instruction and the history, on their own ────────────────────────────

test('state placeholders: filled from state, optional ones emptied, others left, a missing one refused', () => {
  const state = { topic: 'tides', count: 3, obj: { a: 1 }, 'user:name': 'Ada' };
  assert.equal(injectSessionState('{topic} x{count} {obj} {user:name} {missing?} {{topic}}', state), 'tides x3 {"a":1} Ada  tides');
  assert.equal(injectSessionState('{ "a": 1 } {not valid} {a:b:c} {', state), '{ "a": 1 } {not valid} {a:b:c} {');
  assert.throws(() => injectSessionState('{absent}', state), /Context variable not found: `absent`\./);
  assert.throws(() => injectSessionState('{artifact.notes}', state), /Artifact service is not initialized\./);
  assert.equal(injectSessionState('{constructor?}', state), '', 'own keys only');
  // A long run of braces is scanned once (no backtracking pattern on the instruction).
  const braces = '{'.repeat(50_000);
  const started = performance.now();
  assert.equal(injectSessionState(braces, state), braces);
  assert.ok(performance.now() - started < 1000);
});

test('history: another agent’s turn is retold as context, and ADK’s own call ids are removed', () => {
  const events = [
    { id: 'a', invocationId: 'e', author: 'user', content: { role: 'user', parts: [{ text: 'hi' }] }, actions: {}, timestamp: 1 },
    { id: 'b', invocationId: 'e', author: 'Other', content: { role: 'model', parts: [{ text: 'I said this' }, { functionCall: { id: 'adk-1', name: 't', args: { q: 1 } } }] }, actions: {}, timestamp: 2 },
    { id: 'c', invocationId: 'e', author: 'Me', content: { role: 'model', parts: [{ functionCall: { id: 'adk-2', name: 'u', args: {} } }] }, actions: {}, timestamp: 3 },
    { id: 'd', invocationId: 'e', author: 'Me', content: { role: 'user', parts: [{ functionResponse: { id: 'adk-2', name: 'u', response: { result: 'ok' } } }] }, actions: {}, timestamp: 4 },
    { id: 'e', invocationId: 'e', author: 'Me', content: { role: 'user', parts: [{ functionCall: { id: 'adk-3', name: 'adk_request_confirmation', args: {} } }] }, actions: {}, timestamp: 5 },
  ] as TurnEvent[];
  assert.deepEqual(projectHistory(events, { agentName: 'Me' }), [
    { role: 'user', parts: [{ text: 'hi' }] },
    { role: 'user', parts: [{ text: 'For context:' }, { text: '[Other] said: I said this' }, { text: '[Other] called tool `t` with parameters: {"q":1}' }] },
    { role: 'model', parts: [{ functionCall: { id: undefined, name: 'u', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { id: undefined, name: 'u', response: { result: 'ok' } } }] },
  ]);
  assert.equal(events[2]?.content?.parts?.[0]?.functionCall?.id, 'adk-2', 'the stored event is untouched');
});

test('a Gemini-only tool on another model is refused, as ADK refuses it', async () => {
  const { session } = await freshSession();
  await assert.rejects(
    buildModelRequest(plainAgent({ model: 'claude-sonnet-4-6', tools: resolveTools(['google_search']).map(own) }), { session, invocationId: 'e-1' }),
    /Google search tool is not supported for model claude-sonnet-4-6/,
  );
  await assert.rejects(
    buildModelRequest(plainAgent({ model: 'claude-sonnet-4-6', codeExecution: 'gemini' }), { session, invocationId: 'e-1' }),
    /Gemini code execution tool is not supported/,
  );
  const gemini = await buildModelRequest(plainAgent({ model: 'gemini-3.5-flash', codeExecution: 'gemini', tools: resolveTools(['url_context', 'web_search']).map(own) }), {
    session,
    invocationId: 'e-1',
  });
  assert.deepEqual(gemini.request.nativeTools, ['code_execution', 'url_context', 'web_search']);
});

test('an ADK tool from a toolset or in extraTools is refused, naming 1.0.0', async () => {
  const { session } = await freshSession();
  const adkTool = { name: 'legacy_lookup', description: 'Look up.', runAsync: async () => 'never' };
  const refused = /model request: 'legacy_lookup' is an ADK tool, which melchizedek-agents 1\.0\.0 no longer runs \(ADR 0107\); define it with defineTool/;
  const toolset = { name: 'legacy_set', getTools: async () => [adkTool] };
  await assert.rejects(buildModelRequest(plainAgent({ tools: [toolset] }), { session, invocationId: 'e-1' }), refused);
  await assert.rejects(buildModelRequest(plainAgent(), { session, invocationId: 'e-1', extraTools: [adkTool] }), refused);
  // An own toolset's own Tool still builds.
  const ownSet = { name: 'own_set', getTools: async () => resolveTools(['native_step_lookup']).map(own) };
  const built = await buildModelRequest(plainAgent({ tools: [ownSet] }), { session, invocationId: 'e-1' });
  assert.deepEqual(built.request.tools?.map((t) => t.name), ['native_step_lookup']);
});
