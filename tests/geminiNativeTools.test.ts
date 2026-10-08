/**
 * tests/geminiNativeTools.test.ts — Gemini's server-side tools and the
 * memory tools on the engine's own path (WS3-2, ADR 0062, ADR 0059).
 *
 * The request is built by the native step (buildModelRequest,
 * lib/runtime/native/request.ts) from the registry's tools or from a
 * compiled syndicate, then sent by GeminiAdapter (lib/models/geminiAdapter.ts)
 * through the real @google/genai SDK over a stubbed fetch, so each case
 * asserts the body the Gemini API would receive:
 *   - google_search, web_search and url_context reach the adapter only as
 *     `nativeTools` entries, never as a function, and go on the wire as
 *     Gemini's `googleSearch` and `urlContext`; the ADK runtime still gets
 *     its own objects from the registry;
 *   - load_memory's declaration, load_memory's note and preload_memory's
 *     recalled block in the system instruction, and a two-step session in
 *     which the model calls load_memory and answers from its result;
 *   - the model zoo, the research example and Ares compile, and each of
 *     their Gemini agents' native requests carries the tools its YAML lists.
 * Offline: the fetch is stubbed, no provider is called.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { AgentTool, GOOGLE_SEARCH, LlmAgent, LogLevel, setLogLevel } from '@google/adk';
import { GoogleGenAI } from '@google/genai';
import type { GoogleGenAIOptions } from '@google/genai';

import { compileGraph, compileSubagent } from '../lib/compile.ts';
import { isDispatchSyndicate } from '../lib/dispatch.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { FinalModelResponse, ModelRequest } from '../lib/models/contract.ts';
import { GeminiAdapter } from '../lib/models/geminiAdapter.ts';
import { setRetryPolicyOverrides } from '../lib/models/retry.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import type { TurnContent } from '../lib/runtime/events.ts';
import type { MemoryEntry, MemorySearchRequest } from '../lib/runtime/memoryService.ts';
import { buildModelRequest } from '../lib/runtime/native/request.ts';
import type { NativeAgent } from '../lib/runtime/native/request.ts';
import { runModelStep } from '../lib/runtime/native/step.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { Session } from '../lib/runtime/sessions.ts';
import { resolveTools } from '../lib/toolRegistry.ts';
import { LOAD_MEMORY_INSTRUCTION } from '../lib/tools/memoryTools.ts';
import { createToolContext, instructionToolOf, toolOf } from '../lib/tools/tool.ts';
import { URL_CONTEXT } from '../lib/tools/urlContextTool.ts';
import { WEB_SEARCH } from '../lib/tools/webSearchTool.ts';

setLogLevel(LogLevel.ERROR);

const KEY = 'fixture-gemini-key-0123456789';
const MODEL = 'gemini-3.5-flash-lite';
const APP = 'gemini-native-tools';
const USER = 'u1';
const EXAMPLES = path.join(import.meta.dirname, '..', 'config', 'agents', 'examples');

const ENV_KEYS = [
  'GOOGLE_GENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_PLATFORM', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GEMINI_MODEL_MAP',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let restoreRetries: () => void = () => {};

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  restoreRetries = setRetryPolicyOverrides({ baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 50 });
});

afterEach(() => {
  restoreRetries();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── The real SDK over a stubbed fetch ────────────────────────────────────────

interface Captured {
  url: string;
  body: any;
}

/** Runs `fn` with fetch answering each call with the next of `replies`; returns what was sent. */
async function withFetch(replies: object[], fn: () => Promise<void>): Promise<Captured[]> {
  const real = globalThis.fetch;
  const seen: Captured[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const reply = replies[Math.min(seen.length, replies.length) - 1] ?? replies[0];
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}

const realClient = (options: GoogleGenAIOptions) => new GoogleGenAI(options);
const geminiAdapter = (model = MODEL) => new GeminiAdapter({ model, apiKey: KEY, endpoint: { platform: 'direct' }, clientFactory: realClient });

const replyText = (text: string) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } });
const replyCall = (name: string, args: object) => ({
  candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
});

/** Sends `request` through GeminiAdapter on the real SDK; returns the body on the wire and the final. */
async function send(request: ModelRequest): Promise<{ body: any; final: FinalModelResponse }> {
  let final: FinalModelResponse | undefined;
  const seen = await withFetch([replyText('ok')], async () => {
    for await (const response of geminiAdapter(request.model).generate(request)) if (!response.partial) final = response;
  });
  assert.equal(seen.length, 1, 'one call on the wire');
  assert.ok(final && !final.error, `the call answered: ${JSON.stringify(final?.error)}`);
  assert.ok(!seen[0]!.url.includes(KEY), 'the key is not in the URL');
  return { body: seen[0]!.body, final };
}

const declaredNames = (body: any): string[] =>
  (body.tools ?? []).flatMap((t: any) => (t.functionDeclarations ?? []).map((d: any) => d.name));
const geminiOwnTools = (body: any): object[] => (body.tools ?? []).filter((t: any) => !t.functionDeclarations);
const systemOf = (body: any): string => (body.systemInstruction?.parts ?? []).map((p: any) => p.text).join('\n');

// ── Sessions and agents ──────────────────────────────────────────────────────

const userContent = (text: string): TurnContent => ({ role: 'user', parts: [{ text }] });

/** A store holding a session whose run has begun with `text`. */
async function sessionWith(text: string): Promise<{ session: Session; sessions: InProcessSessionService }> {
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: APP, userId: USER, sessionId: 's1' });
  await sessions.append(session, createTurnEvent({ invocationId: 'e-1', author: 'user', content: userContent(text) }));
  return { session, sessions };
}

/** The registry's object as the native loop holds it: the own Tool or InstructionTool behind it, a marker as it is. */
const own = (tool: unknown): unknown => toolOf(tool) ?? instructionToolOf(tool) ?? tool;

/** A memory service that records each search and recalls `memories`. */
function memoryOf(memories: MemoryEntry[]) {
  const searches: MemorySearchRequest[] = [];
  return {
    searches,
    search: async (request: MemorySearchRequest) => {
      searches.push(request);
      return { memories };
    },
  };
}

const FACT: MemoryEntry = {
  content: { role: 'user', parts: [{ text: 'Creatinine was 1.4 mg/dL on 2026-03-12.' }] },
  author: 'memory_service',
  timestamp: '2026-03-12T09:00:00Z',
};

// ── Server-side tools as request flags ───────────────────────────────────────

test('google_search, web_search and url_context reach GeminiAdapter as nativeTools only, and go on the wire as googleSearch and urlContext', async () => {
  const cases: Array<{ yaml: string[]; nativeTools: string[]; wire: object[] }> = [
    { yaml: ['google_search'], nativeTools: ['web_search'], wire: [{ googleSearch: {} }] },
    { yaml: ['web_search'], nativeTools: ['web_search'], wire: [{ googleSearch: {} }] },
    { yaml: ['url_context'], nativeTools: ['url_context'], wire: [{ urlContext: {} }] },
    { yaml: ['url_context', 'google_search'], nativeTools: ['url_context', 'web_search'], wire: [{ googleSearch: {} }, { urlContext: {} }] },
  ];
  for (const { yaml, nativeTools, wire } of cases) {
    const { session } = await sessionWith('What changed this week?');
    const agent: NativeAgent = { name: 'searcher', model: MODEL, instruction: 'Search.', tools: resolveTools(yaml).map(own) };
    const { request, tools } = await buildModelRequest(agent, { session, invocationId: 'e-1' });
    assert.deepEqual(request.nativeTools, nativeTools, `${yaml}: the request flags`);
    assert.equal(request.tools, undefined, `${yaml}: no function is declared for a server-side tool`);
    assert.equal(tools.size, 0, `${yaml}: nothing for the loop to run`);

    const { body } = await send(request);
    assert.deepEqual(body.tools, wire, `${yaml}: Gemini's own tools on the wire`);
    assert.equal(body.toolConfig, undefined, 'native tools alone ask for no server-side invocations');
  }
});

test('beside a function tool, the server-side tools ask Gemini for its server-side invocations', async () => {
  const { session } = await sessionWith('Read https://example.org and remember it.');
  const agent: NativeAgent = { name: 'reader', model: MODEL, instruction: 'Read.', tools: resolveTools(['url_context', 'load_memory', 'web_search']).map(own) };
  const { request } = await buildModelRequest(agent, { session, invocationId: 'e-1' });
  assert.deepEqual(request.nativeTools, ['url_context', 'web_search']);
  assert.deepEqual(request.tools?.map((t) => t.name), ['load_memory']);

  const { body } = await send(request);
  assert.deepEqual(declaredNames(body), ['load_memory']);
  assert.deepEqual(geminiOwnTools(body), [{ googleSearch: {} }, { urlContext: {} }]);
  assert.equal(body.toolConfig?.includeServerSideToolInvocations, true);
});

test('url_context and google_search are Gemini-only: another model gets no flag for url_context, and google_search is refused as ADK refuses it', async () => {
  const { session } = await sessionWith('hi');
  const claude: NativeAgent = { name: 'reader', model: 'claude-sonnet-4-6', tools: resolveTools(['url_context']).map(own) };
  const { request } = await buildModelRequest(claude, { session, invocationId: 'e-1' });
  assert.equal(request.nativeTools, undefined);
  assert.equal(request.tools, undefined);
  await assert.rejects(
    buildModelRequest({ ...claude, tools: resolveTools(['google_search']).map(own) }, { session, invocationId: 'e-1' }),
    /Google search tool is not supported for model claude-sonnet-4-6/,
  );
});

test('the ADK runtime still receives its own objects from the registry', () => {
  const [webSearch, urlContext, googleSearch] = resolveTools(['web_search', 'url_context', 'google_search']);
  assert.equal(webSearch, WEB_SEARCH, 'web_search: the shared sentinel');
  assert.equal(urlContext, URL_CONTEXT, 'url_context: the shared sentinel');
  assert.equal(googleSearch, GOOGLE_SEARCH, "google_search: ADK's own GOOGLE_SEARCH");
});

// ── Memory tools through GeminiAdapter ───────────────────────────────────────

test('load_memory is declared to Gemini as written, and the system instruction carries its note and the preloaded facts', async () => {
  const { session } = await sessionWith('What was my creatinine in March?');
  const memory = memoryOf([FACT]);
  const agent: NativeAgent = { name: 'advocate', model: MODEL, instruction: 'Answer from the record.', tools: resolveTools(['preload_memory', 'load_memory']).map(own) };
  const { request } = await buildModelRequest(agent, { session, invocationId: 'e-1', userContent: userContent('What was my creatinine in March?'), memory });
  assert.deepEqual(memory.searches, [{ appName: APP, userId: USER, query: 'What was my creatinine in March?' }], 'preload_memory recalls for the run’s message');

  const { body } = await send(request);
  assert.deepEqual(body.tools, [
    {
      functionDeclarations: [
        {
          name: 'load_memory',
          description: 'Loads the memory for the current user.\n\nNOTE: Currently this tool only uses text part from the memory.',
          parametersJsonSchema: request.tools?.[0]?.parameters,
        },
      ],
    },
  ]);
  const parameters = body.tools[0].functionDeclarations[0].parametersJsonSchema;
  assert.equal(parameters.type, 'object', 'lowercase JSON Schema, as written');
  assert.deepEqual(parameters.required, ['query']);
  assert.equal(parameters.properties.query.type, 'string');

  const system = systemOf(body);
  assert.ok(system.includes('Answer from the record.'));
  assert.ok(system.includes(LOAD_MEMORY_INSTRUCTION), 'load_memory’s note');
  assert.ok(
    system.includes('<PAST_CONVERSATIONS>\nTime: 2026-03-12T09:00:00Z\nmemory_service: Creatinine was 1.4 mg/dL on 2026-03-12.\n</PAST_CONVERSATIONS>'),
    'preload_memory’s recalled block',
  );
  assert.ok(system.indexOf('<PAST_CONVERSATIONS>') < system.indexOf(LOAD_MEMORY_INSTRUCTION), 'in the agent’s tool order');
});

test('without memory, neither memory tool writes into the system instruction', async () => {
  const { session } = await sessionWith('Anything saved?');
  const agent: NativeAgent = { name: 'advocate', model: MODEL, instruction: 'Answer.', tools: resolveTools(['preload_memory', 'load_memory']).map(own) };
  const { request } = await buildModelRequest(agent, { session, invocationId: 'e-1', userContent: userContent('Anything saved?') });
  const { body } = await send(request);
  assert.equal(systemOf(body), 'You are an agent. Your internal name is "advocate".\n\nAnswer.');
  assert.deepEqual(declaredNames(body), ['load_memory']);
});

test('a scripted session: Gemini calls load_memory, the result goes back as its function response, and the answer comes from it', async () => {
  const question = 'What was my creatinine in March?';
  const { session, sessions } = await sessionWith(question);
  const memory = memoryOf([FACT]);
  const agent: NativeAgent = { name: 'advocate', model: MODEL, instruction: 'Answer from the record.', tools: resolveTools(['load_memory']).map(own) };
  const step = { agent, session, sessions, invocationId: 'e-1', userContent: userContent(question), memory };

  const seen = await withFetch([replyCall('load_memory', { query: 'creatinine March 2026' }), replyText('Your creatinine was 1.4 mg/dL on 2026-03-12.')], async () => {
    // Step 1: the model asks for its memory.
    const first = await runModelStep({ ...step, adapter: geminiAdapter() });
    assert.equal(first.error, undefined);
    assert.equal(first.toolCalls.length, 1);
    const call = first.toolCalls[0]!;
    assert.equal(call.name, 'load_memory');
    assert.deepEqual(call.args, { query: 'creatinine March 2026' });

    // The loop's next step (WS2-5b) runs the call; here the own Tool runs it, as that step will.
    const loadMemory = toolOf(resolveTools(['load_memory'])[0]);
    assert.ok(loadMemory);
    const ctx = createToolContext({ invocationId: 'e-1', agentName: agent.name, userId: USER, appName: APP, sessionId: session.id, state: session.state, memory });
    const result = await loadMemory.execute(call.args, ctx);
    await sessions.append(
      session,
      createTurnEvent({ invocationId: 'e-1', author: agent.name, content: { role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: result as Record<string, unknown> } }] } }),
    );

    // Step 2: the model answers from the result.
    const second = await runModelStep({ ...step, adapter: geminiAdapter() });
    assert.equal(second.error, undefined);
    assert.equal(second.text, 'Your creatinine was 1.4 mg/dL on 2026-03-12.');
    assert.deepEqual(second.toolCalls, []);
  });

  assert.equal(seen.length, 2, 'two calls on the wire');
  assert.deepEqual(memory.searches, [{ appName: APP, userId: USER, query: 'creatinine March 2026' }], 'the model’s query, in this user’s silo');
  for (const { body } of seen) assert.deepEqual(declaredNames(body), ['load_memory']);
  assert.deepEqual(seen[1]!.body.contents, [
    { role: 'user', parts: [{ text: question }] },
    { role: 'model', parts: [{ functionCall: { name: 'load_memory', args: { query: 'creatinine March 2026' } } }] },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'load_memory',
            response: { memories: [{ content: 'Creatinine was 1.4 mg/dL on 2026-03-12.', author: 'memory_service', timestamp: '2026-03-12T09:00:00Z' }] },
          },
        },
      ],
    },
  ], 'the engine’s minted call id stays off the wire');
});

// ── The shipped syndicates' Gemini agents ────────────────────────────────────

/**
 * A compiled LlmAgent as a NativeAgent: its fields read back as compiled
 * (instruction, tools, config, output schema, code executor). The compile
 * split (WS2-10) will build NativeAgents directly; this reads what ADK runs.
 */
function nativeAgentOf(agent: LlmAgent, model: string): NativeAgent {
  assert.equal(typeof agent.instruction, 'string', `${agent.name}: a compiled instruction is a string`);
  return {
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    model,
    instruction: agent.instruction as string,
    tools: (agent.tools ?? []).map(own),
    ...(agent.outputSchema ? { outputSchema: agent.outputSchema as unknown as Record<string, unknown> } : {}),
    generateContentConfig: (agent.generateContentConfig ?? {}) as Record<string, unknown>,
    includeContents: agent.includeContents,
    disallowTransferToParent: agent.disallowTransferToParent,
    disallowTransferToPeers: agent.disallowTransferToPeers,
    ...(agent.codeExecutor ? { codeExecution: 'gemini' as const } : {}),
  };
}

/** Every agent of a shipped syndicate, compiled, with its YAML model id. */
async function compiledAgents(file: string): Promise<Array<{ agent: LlmAgent; model: string }>> {
  const config = loadSyndicate(path.join(EXAMPLES, file));
  const root = await compileGraph(config, { log: () => {} });
  const out = [{ agent: root, model: config.orchestrator.model as string }];
  for (const sub of config.subagents ?? []) {
    // compileGraph wraps this same compileSubagent in an AgentTool (delegate) or leaves it to the dispatcher.
    const compiled = await compileSubagent(sub, { log: () => {} });
    if (!isDispatchSyndicate(config)) assert.ok(root.tools.some((t) => t instanceof AgentTool && t.name === sub.name), `${file}: ${sub.name} is the root's AgentTool`);
    out.push({ agent: compiled, model: sub.model as string });
  }
  return out;
}

/** Each Gemini agent's native request on the wire, by agent name. */
async function geminiBodies(file: string, memory?: ReturnType<typeof memoryOf>): Promise<Map<string, any>> {
  const bodies = new Map<string, any>();
  for (const { agent, model } of await compiledAgents(file)) {
    if (!model.startsWith('gemini-')) continue;
    const { session } = await sessionWith('What is a confidence interval?');
    const { request } = await buildModelRequest(nativeAgentOf(agent, model), {
      session,
      invocationId: 'e-1',
      userContent: userContent('What is a confidence interval?'),
      ...(memory ? { memory } : {}),
    });
    bodies.set(agent.name, (await send(request)).body);
  }
  return bodies;
}

test('model zoo: the Zookeeper declares its six explainers, and the gemini explainer sends no tools', async () => {
  const bodies = await geminiBodies('model_zoo.yaml');
  assert.deepEqual([...bodies.keys()], ['Zookeeper', 'gemini']);
  assert.deepEqual(declaredNames(bodies.get('Zookeeper')), ['qwen_local', 'claude', 'grok', 'gpt', 'gemini', 'kimi']);
  assert.deepEqual(geminiOwnTools(bodies.get('Zookeeper')), []);
  assert.equal(bodies.get('gemini').tools, undefined);
  assert.ok(systemOf(bodies.get('gemini')).includes('At most three paragraphs'), 'the shared explainer instruction');
});

test('research: triage answers in its schema with no tools; lookup and landscape declare their evidence tools', async () => {
  const bodies = await geminiBodies('research.yaml');
  assert.deepEqual([...bodies.keys()], ['Triage', 'define', 'lookup', 'landscape']);
  const triage = bodies.get('Triage');
  assert.equal(triage.tools, undefined);
  assert.equal(triage.generationConfig?.responseMimeType, 'application/json');
  assert.deepEqual(triage.generationConfig?.responseJsonSchema?.required, ['route', 'reason', 'subject']);
  assert.equal(bodies.get('define').tools, undefined);
  assert.deepEqual(declaredNames(bodies.get('lookup')), ['resolve_identifier', 'search_trials', 'search_literature', 'check_retraction', 'cited_by']);
  assert.deepEqual(declaredNames(bodies.get('landscape')), [
    'search_trials', 'search_literature', 'search_preprints', 'resolve_identifier', 'cited_by', 'survey_field', 'check_retraction',
  ]);
  for (const body of bodies.values()) assert.deepEqual(geminiOwnTools(body), [], 'no server-side tool in research');
});

test('Ares: the orchestrator declares WarScribe and load_memory with the preloaded facts; WarScribe sends googleSearch alone', async () => {
  const memory = memoryOf([FACT]);
  const bodies = await geminiBodies('ares.yaml', memory);
  assert.deepEqual([...bodies.keys()], ['Ares', 'WarScribe']);
  const ares = bodies.get('Ares');
  assert.deepEqual(declaredNames(ares), ['WarScribe', 'load_memory']);
  assert.deepEqual(geminiOwnTools(ares), []);
  assert.ok(systemOf(ares).includes('<PAST_CONVERSATIONS>'), 'preload_memory wrote the recalled facts');
  assert.ok(systemOf(ares).includes(LOAD_MEMORY_INSTRUCTION));
  const scribe = bodies.get('WarScribe');
  assert.deepEqual(scribe.tools, [{ googleSearch: {} }], 'google_search as a request flag, declared as no function');
  assert.equal(scribe.toolConfig, undefined);
});
