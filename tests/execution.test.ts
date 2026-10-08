/**
 * tests/execution.test.ts — the agent keys of ADR 0033: `context:` compacts a
 * long delegate conversation into a summary (and the summary survives the
 * storage trim), `mode: task` makes a workflow node's output its finish_task
 * arguments, `code_execution: gemini` compiles to Gemini's server-side
 * executor, and the schema puts each where it means something. Then the
 * same keys on the native runtime (WS3-5, ADR 0081): code execution and
 * task mode store the same events and return the same result on ADK and
 * native; a task-mode node's run ends on finish_task's answer with the
 * output ADK's workflow stores. Scripted models, in-memory sessions, no
 * network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltInCodeExecutor, InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import { z } from 'zod';

import { compileGraph } from '../lib/compile.ts';
import { compileNativeSubagent } from '../lib/compileNative.ts';
import type { ModelAdapter } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/fallback.ts';
import { CARRIED_PARTS_KIND } from '../lib/models/geminiAdapter.ts';
import type { TurnContent, TurnEvent } from '../lib/runtime/events.ts';
import { runAgentLoop } from '../lib/runtime/native/agentLoop.ts';
import type { AgentLoopEnd } from '../lib/runtime/native/agentLoop.ts';
import { FINISH_TASK_INSTRUCTION } from '../lib/runtime/native/taskMode.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { UnsupportedOnRuntimeError, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { trimEventForStorage } from '../lib/session/transcript.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';
import { ScriptedModel, answer, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

setLogLevel(LogLevel.ERROR);

const contents = (req: any): string[] => (req.contents ?? []).map((c: any) => (c.parts ?? []).map((p: any) => p.text ?? '').join(''));

test('context: past the threshold, earlier turns become one summary and the recent ones stay verbatim', async () => {
  const config = validateSyndicateConfig(
    {
      syndicate_name: 'Chat',
      orchestrator: { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', context: { compact_after_tokens: 1000, keep_recent_events: 2, summary_model: 'scripted/sum' } },
      subagents: [],
    },
    't',
  ) as SyndicateYamlConfig;
  let n = 0;
  const chat = new ScriptedLlm('scripted/chat', () => ({ content: { role: 'model', parts: [{ text: `answer ${++n}` }] }, usageMetadata: { promptTokenCount: n * 400 }, turnComplete: true }) as any);
  const sum = new ScriptedLlm('scripted/sum', () => text('SUMMARY: the person asked three questions about trains.'));
  const sessionService = new InMemorySessionService();
  const turn = (t: string) => runSyndicateTurn({ config, parts: [{ text: t }], appName: 'a', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: scriptedResolver({ chat, sum }) }, trace: false });

  for (let i = 1; i <= 3; i++) await turn(`question ${i}`);
  assert.equal(sum.calls, 0, 'under the threshold nothing is summarized');
  assert.equal(contents(chat.requests[2]).length, 5, 'the third request carries the whole history');

  const fourth = await turn('question 4');
  assert.equal(fourth.status, 'completed');
  assert.equal(sum.calls, 1, 'the summarizer ran once');
  const seen = contents(chat.requests[3]);
  assert.match(seen[0]!, /SUMMARY: the person asked three questions/);
  assert.equal(seen.at(-1), 'question 4');
  assert.ok(seen.length < 5, `the request shrank: ${seen.length} contents`);

  const session = await sessionService.getSession({ appName: 'a', userId: 'u', sessionId: 's' });
  const compacted = session!.events.find((e: any) => e.isCompacted === true)!;
  assert.ok(compacted, 'the summary is an event in the session; the full history stays stored');
  assert.equal((trimEventForStorage(compacted) as any).isCompacted, true, 'the storage trim keeps the marker');
});

test('mode: task — a workflow node works with its tools, then its finish_task arguments are its output', async () => {
  const config = validateSyndicateConfig(
    {
      syndicate_name: 'Desk',
      orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Pass it on.' },
      subagents: [
        {
          name: 'Extractor',
          description: 'extracts',
          model: 'scripted/extractor',
          instruction: 'Extract.',
          mode: 'task',
          outputSchema: { type: 'OBJECT', properties: { city: { type: 'STRING' }, nights: { type: 'INTEGER' } }, required: ['city', 'nights'] },
        },
        { name: 'Booker', description: 'books', model: 'scripted/booker', instruction: 'Book.' },
      ],
      workflow: { edges: [['START', 'Lead', 'Extractor', 'Booker']] },
    },
    't',
  ) as SyndicateYamlConfig;
  const lead = new ScriptedLlm('scripted/lead', () => text('two nights in Lyon please'));
  const extractor = new ScriptedLlm('scripted/extractor', (_req, n) => (n === 1 ? call('finish_task', { city: 'Lyon', nights: 2 }) : text('done')));
  const booker = new ScriptedLlm('scripted/booker', (req) => text(`booked ${contents(req).at(-1)}`));
  const r = await runSyndicateTurn({ config, parts: [{ text: 'go' }], appName: 'a', userId: 'u', sessionId: 's', sessionService: new InMemorySessionService(), compile: { resolveModel: scriptedResolver({ lead, extractor, booker }) }, trace: false });
  assert.equal(r.status, 'completed', r.error?.message);
  assert.deepEqual(JSON.parse(r.text.replace(/^booked /, '')), { city: 'Lyon', nights: 2 });
});

test('code_execution: gemini compiles to Gemini\'s server-side executor', async () => {
  const config = validateSyndicateConfig(
    { syndicate_name: 'Calc', orchestrator: { name: 'Calc', model: 'gemini-3.5-flash-lite', instruction: 'Compute.', code_execution: 'gemini' }, subagents: [] },
    't',
  ) as SyndicateYamlConfig;
  const root = (await compileGraph(config)) as any;
  assert.ok(root.codeExecutor instanceof BuiltInCodeExecutor);
});

test('schema: each key where it means something', () => {
  const base = (orchestrator: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    syndicate_name: 'S',
    orchestrator: { name: 'Lead', model: 'gemini-3.5-flash-lite', instruction: 'x', ...orchestrator },
    subagents: [{ name: 'Sub', description: 'd', model: 'gemini-3.5-flash-lite', instruction: 'y' }],
    ...extra,
  });
  assert.throws(() => validateSyndicateConfig(base({ model: 'claude-sonnet-4-6', code_execution: 'gemini' }), 't'), /needs a gemini-\* model/);
  assert.doesNotThrow(() => validateSyndicateConfig(base({ context: { compact_after_tokens: 50000 } }), 't'));
  assert.throws(() => validateSyndicateConfig(base({ context: { compact_after_tokens: 50000 } }, { dispatch: { default_route: 'Sub' } }), 't'), /delegate syndicate/);
  assert.throws(() => validateSyndicateConfig(base({ context: { compact_after_tokens: 50 } }), 't'), /compact_after_tokens/);
  assert.throws(() => validateSyndicateConfig(base({ mode: 'task' }), 't'), /mode: task applies to workflow nodes/);
  assert.doesNotThrow(() => validateSyndicateConfig(base({ mode: 'task' }, { workflow: { edges: [['START', 'Lead', 'Sub']] } }), 't'));
});

// ── The same keys on the native runtime (WS3-5) ──────────────────────────────

registerTool(
  'execution_lookup',
  defineTool({ name: 'execution_lookup', description: 'Look a city up.', schema: z.object({ city: z.string() }), execute: async ({ city }) => `${city} is in France` }),
  { override: true },
);

type Scripts = Record<string, ModelScript>;

interface Conversation {
  results: SyndicateTurnResult[];
  events: TurnEvent[];
  models: Record<string, ScriptedModel>;
}

/** One conversation through runSyndicateTurn on `runtime`; each model `<key>` is a ScriptedModel under that id (Gemini's provider for a gemini- id). */
async function converse(runtime: 'adk' | 'native', config: SyndicateYamlConfig, scripts: Scripts, turns: string[], seed: TurnEvent[] = []): Promise<Conversation> {
  resetCircuits();
  const models = Object.fromEntries(
    Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(key, script, key.startsWith('gemini-') ? 'gemini' : 'scripted')]),
  );
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({ appName: 'x', userId: 'u', sessionId: 's' });
  for (const event of seed) await sessionService.appendEvent({ session, event: structuredClone(event) as any });
  const results: SyndicateTurnResult[] = [];
  for (const t of turns) {
    results.push(
      await runSyndicateTurn({ config, parts: [{ text: t }], appName: 'x', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: shimResolver(models), log: () => {} }, trace: false, runtime }),
    );
  }
  const stored = await sessionService.getSession({ appName: 'x', userId: 'u', sessionId: 's' });
  return { results, events: JSON.parse(JSON.stringify(stored?.events ?? [])) as TurnEvent[], models };
}

/** Ids, times and invocation ids are minted per run; everything else must match. */
const comparable = (events: TurnEvent[]): unknown =>
  JSON.parse(
    JSON.stringify(events.map((e) => ({ ...e, id: '<id>', timestamp: 0, invocationId: '<inv>' }))),
    (_key, v) => (typeof v === 'string' && v.startsWith('adk-') ? '<adk-id>' : v),
  );

const outcome = (r: SyndicateTurnResult) => ({ status: r.status, text: r.text, error: r.error, usage: r.usage });

/** Runs both ways; the results, the stored events and each model's requests must match. */
async function assertParity(config: SyndicateYamlConfig, scripts: Scripts, turns: string[], seed: TurnEvent[] = []): Promise<{ adk: Conversation; native: Conversation }> {
  const adk = await converse('adk', config, scripts, turns, seed);
  const native = await converse('native', config, scripts, turns, seed);
  assert.deepEqual(native.results.map(outcome), adk.results.map(outcome), 'the results');
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'the stored events');
  for (const key of Object.keys(scripts)) {
    const strip = (m: ScriptedModel) => m.requests.map(({ signal: _s, ...r }) => r);
    assert.deepEqual(strip(native.models[key]!), strip(adk.models[key]!), `the requests ${key} received`);
  }
  return { adk, native };
}

const CODE = { executableCode: { language: 'PYTHON', code: 'print(6 * 7)' } };
const RESULT = { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '42\n' } };
const GEMINI = 'gemini-3.5-flash';
const carried = (before: object[]) => ({ provider: 'gemini', kind: CARRIED_PARTS_KIND, model: GEMINI, payload: { before } });

test('native: code_execution: gemini asks for the code tool, and the code and its result are stored and replayed as on ADK', async () => {
  const config = validateSyndicateConfig(
    { syndicate_name: 'Calc', orchestrator: { name: 'Calc', model: GEMINI, instruction: 'Compute.', code_execution: 'gemini', tools: ['execution_lookup'] }, subagents: [] },
    't',
  ) as SyndicateYamlConfig;
  // What the Gemini adapter returns for code it ran (ADR 0065): the code and its result ride on the next part.
  const { native } = await assertParity(
    config,
    {
      [GEMINI]: (_req, n) =>
        n === 1
          ? { partial: false, parts: [{ type: 'text', text: 'The product is 42.', providerState: carried([CODE, RESULT]) }], finishReason: 'stop' }
          : answer('You are welcome.'),
    },
    ['What is 6 times 7?', 'Thanks.'],
  );
  assert.equal(native.results[0]?.text, 'The product is 42.');
  const [first, second] = native.models[GEMINI]!.requests;
  assert.deepEqual(first?.nativeTools, ['code_execution']);
  assert.deepEqual(first?.tools?.map((t) => t.name), ['execution_lookup', 'adk_handle_model_error'], 'the code tool is never a declared function');
  assert.ok(JSON.stringify(second?.messages).includes(CARRIED_PARTS_KIND), 'the next turn hands the carried parts back to the adapter, which decides what Gemini sees');
});

test('native: a history holding raw executableCode and codeExecutionResult parts reaches the model as ADK converts it', async () => {
  const config = validateSyndicateConfig(
    { syndicate_name: 'Calc', orchestrator: { name: 'Calc', model: GEMINI, instruction: 'Compute.', code_execution: 'gemini' }, subagents: [] },
    't',
  ) as SyndicateYamlConfig;
  // As ADK's own Gemini class stores a code-execution answer.
  const seed = [
    { id: 'u0', invocationId: 'e-0', author: 'user', content: { role: 'user', parts: [{ text: 'compute' }] }, actions: {}, timestamp: 1 },
    { id: 'm0', invocationId: 'e-0', author: 'Calc', content: { role: 'model', parts: [{ text: 'Running it.' }, CODE] }, actions: {}, timestamp: 2 },
    { id: 'm1', invocationId: 'e-0', author: 'Calc', content: { role: 'model', parts: [RESULT] }, actions: {}, timestamp: 3 },
    { id: 'm2', invocationId: 'e-0', author: 'Calc', content: { role: 'model', parts: [{ text: 'It is 42.' }] }, actions: {}, timestamp: 4 },
  ] as unknown as TurnEvent[];
  const { native } = await assertParity(config, { [GEMINI]: () => answer('Still 42.') }, ['again?'], seed);
  const texts = native.models[GEMINI]!.requests[0]!.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [`${m.role}: ${p.text}`] : [])));
  assert.ok(texts.includes('assistant: ```tool_code\nprint(6 * 7)\n```'), texts.join(' | '));
  assert.ok(texts.includes('user: ```tool_output\n42\n\n```'), texts.join(' | '));
});

const TRIP = { type: 'OBJECT', properties: { city: { type: 'STRING' }, nights: { type: 'INTEGER' } }, required: ['city', 'nights'] };

/** A task-mode agent outside a workflow (the schema refuses that, so unvalidated): only the loop and the request are under test. */
const taskSolo = (orchestrator: Record<string, unknown>) =>
  ({ syndicate_name: 'Desk', orchestrator: { name: 'Extractor', model: 'extractor', instruction: 'Extract.', mode: 'task', ...orchestrator }, subagents: [] }) as SyndicateYamlConfig;

test("native: mode: task declares finish_task as ADK does, answers a missing key with ADK's error, and stores the same events", async () => {
  const { native } = await assertParity(
    taskSolo({ outputSchema: TRIP, tools: ['execution_lookup'], outputKey: 'trip' }),
    {
      extractor: (_req, n) =>
        [toolCall('execution_lookup', { city: 'Lyon' }, 'c1'), toolCall('finish_task', { city: 'Lyon' }, 'c2'), toolCall('finish_task', { city: 'Lyon', nights: 2 }, 'c3'), answer('{"city":"Lyon","nights":2}')][n - 1]!,
    },
    ['two nights in Lyon'],
  );
  const request = native.models.extractor!.requests[0]!;
  assert.deepEqual(request.tools?.map((t) => t.name), ['execution_lookup', 'finish_task', 'adk_handle_model_error'], "after the agent's tools, before the reflection tool");
  assert.equal(request.outputSchema, undefined, "the output schema is finish_task's parameters, never the response schema");
  assert.ok(request.system?.includes(FINISH_TASK_INSTRUCTION));
  const responses = native.events.flatMap((e) => (e.content?.parts ?? []).flatMap((p) => (p.functionResponse?.name === 'finish_task' ? [p.functionResponse.response] : [])));
  assert.match(String((responses[0] as any).error), /missing required parameters: nights/);
  assert.deepEqual(responses[1], { result: 'Task completed.' });
  assert.equal(native.results[0]?.text, '{"city":"Lyon","nights":2}', 'outside a workflow the loop goes on after finish_task, as LlmAgent.runAsync does');
});

test('native: mode: task with no output schema, or a lowercase one, declares finish_task as ADK does', async () => {
  await assertParity(taskSolo({}), { extractor: (_r, n) => (n === 1 ? toolCall('finish_task', { result: 'did it' }, 'c1') : answer('ok')) }, ['go']);
  const lower = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  const { native } = await assertParity(taskSolo({ outputSchema: lower }), { extractor: (_r, n) => (n === 1 ? toolCall('finish_task', { result: { city: 'Lyon' } }, 'c1') : answer('ok')) }, ['go']);
  assert.deepEqual((native.models.extractor!.requests[0]!.tools?.[0]?.parameters as any).required, ['result'], 'ADK wraps a schema whose type is not OBJECT under result');
});

test("native: a task-mode node ends on finish_task's answer, which carries the output, the outputKey and messageAsOutput as ADK's workflow stores them", async () => {
  const extractorYaml = { name: 'Extractor', description: 'extracts', model: 'scripted/extractor', instruction: 'Extract.', mode: 'task' as const, outputKey: 'trip', outputSchema: TRIP };
  const script: ModelScript = (_req, n) => (n === 1 ? toolCall('finish_task', { city: 'Lyon' }, 'c1') : n === 2 ? toolCall('finish_task', { city: 'Lyon', nights: 2 }, 'c2') : answer('never asked'));

  // ADK: the workflow case above, its Extractor node scripted on the engine's contract.
  const config = validateSyndicateConfig(
    {
      syndicate_name: 'Desk',
      orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Pass it on.' },
      subagents: [extractorYaml, { name: 'Booker', description: 'books', model: 'scripted/booker', instruction: 'Book.' }],
      workflow: { edges: [['START', 'Lead', 'Extractor', 'Booker']] },
    },
    't',
  ) as SyndicateYamlConfig;
  const adkModels = {
    lead: new ScriptedModel('scripted/lead', () => answer('two nights in Lyon please')),
    extractor: new ScriptedModel('scripted/extractor', script),
    booker: new ScriptedModel('scripted/booker', () => answer('booked')),
  };
  const adkSessions = new InMemorySessionService();
  const r = await runSyndicateTurn({ config, parts: [{ text: 'go' }], appName: 'x', userId: 'u', sessionId: 's', sessionService: adkSessions, compile: { resolveModel: shimResolver(adkModels), log: () => {} }, trace: false });
  assert.equal(r.status, 'completed', r.error?.message);
  const adkEvents = JSON.parse(JSON.stringify((await adkSessions.getSession({ appName: 'x', userId: 'u', sessionId: 's' }))!.events)) as TurnEvent[];
  const adkNode = adkEvents.filter((e) => e.author === 'Extractor');

  // Native: the node's agent on the history the node saw, run as a task node.
  const agent = await compileNativeSubagent(extractorYaml as any, { log: () => {} });
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: 'x', userId: 'u', sessionId: 's' });
  const before = adkEvents.slice(0, adkEvents.indexOf(adkNode[0]!));
  for (const e of before) await sessions.append(session, structuredClone(e));
  const extractor = new ScriptedModel('scripted/extractor', script);
  const loop = runAgentLoop(agent, {
    session,
    sessions,
    invocationId: adkNode[0]!.invocationId,
    userContent: before[0]!.content as TurnContent,
    stream: false,
    taskNode: true,
    adapterFor: () => extractor as ModelAdapter,
    log: () => {},
  });
  let end: AgentLoopEnd | undefined;
  for (;;) {
    const next = await loop.next();
    if (next.done) {
      end = next.value;
      break;
    }
  }
  assert.equal(end?.reason, 'final');
  assert.deepEqual(end?.output, { city: 'Lyon', nights: 2 });
  assert.equal(extractor.calls, 2, 'the node stops on the successful answer, never asking the model again');
  const { signal: _a, ...nativeRequest } = extractor.requests[0]!;
  const { signal: _b, ...adkRequest } = adkModels.extractor.requests[0]!;
  assert.deepEqual(nativeRequest, adkRequest, 'the node sent the same first request');

  // The workflow adds its own node path (WS4); everything else is the loop's and must match.
  const nodeFields = (events: TurnEvent[]) =>
    comparable(events.map(({ nodeInfo, branch: _br, ...e }) => ({ ...e, ...(nodeInfo?.messageAsOutput ? { messageAsOutput: true } : {}) })));
  const nativeNode = JSON.parse(JSON.stringify((await sessions.get({ appName: 'x', userId: 'u', sessionId: 's' }))!.events.filter((e) => e.author === 'Extractor'))) as TurnEvent[];
  assert.deepEqual(nodeFields(nativeNode), nodeFields(adkNode));
  assert.deepEqual(nativeNode.at(-1)?.actions.stateDelta, { trip: { city: 'Lyon', nights: 2 } });
});

test('native: the mode: task workflow case is refused as a workflow (WS4), never as task mode', async () => {
  const config = validateSyndicateConfig(
    {
      syndicate_name: 'Desk',
      orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Pass it on.' },
      subagents: [
        { name: 'Extractor', description: 'extracts', model: 'scripted/extractor', instruction: 'Extract.', mode: 'task', outputSchema: TRIP },
        { name: 'Booker', description: 'books', model: 'scripted/booker', instruction: 'Book.' },
      ],
      workflow: { edges: [['START', 'Lead', 'Extractor', 'Booker']] },
    },
    't',
  ) as SyndicateYamlConfig;
  const lead = new ScriptedModel('scripted/lead', () => answer('x'));
  const refused = await runSyndicateTurn({
    config,
    parts: [{ text: 'go' }],
    appName: 'x',
    userId: 'u',
    sessionId: 's',
    sessionService: new InMemorySessionService(),
    compile: { resolveModel: shimResolver({ lead }) },
    trace: false,
    runtime: 'native',
  }).catch((e: unknown) => e);
  assert.ok(refused instanceof UnsupportedOnRuntimeError, String(refused));
  assert.match((refused as Error).message, /workflow/);
  assert.doesNotMatch((refused as Error).message, /task mode/);
  assert.equal(lead.calls, 0);
});
