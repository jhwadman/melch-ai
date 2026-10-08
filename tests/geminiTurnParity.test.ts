/**
 * tests/geminiTurnParity.test.ts — a Gemini agent's turn on both runtimes,
 * through ADK's own Gemini and the real @google/genai SDK, over a stubbed
 * fetch (WS4-6b, ADR 0097).
 *
 * The other parity suites script their models behind the ADK shim, which
 * reads the request's toolsDict. ADK's Gemini reads only the request's
 * config, so these cases hold the JSON that would reach the Gemini API, and
 * the events stored, to ADK's for a Gemini model with retries at their
 * defaults:
 *
 *   - a function call's thoughtSignature is stored on its part and replayed
 *     on the next request, as ADK stores and sends it;
 *   - the reflection tool (adk_handle_model_error) is never declared to
 *     Gemini, on a plain agent or a workflow node agent, since ADK's
 *     reflect-and-retry plugin adds it to the toolsDict alone;
 *   - a call Gemini makes to the reserved tool all the same is still
 *     replaced and answered with reflection guidance on both runtimes.
 *
 * Each case runs native twice: on the wrapper over ADK's Gemini (the
 * default until gate G3) and on the engine's own GeminiAdapter
 * (GEMINI_ADAPTER=engine), and holds both to ADK, the stored events in full,
 * turnComplete included (ADR 0100).
 *
 * Offline: no provider is called, and the key is an obvious fixture.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';
import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { setRetryPolicyOverrides } from '../lib/models/retry.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { nativeAdapterFor } from '../lib/compileNative.ts';
import { adkShim } from '../lib/models/adkShim.ts';
import { GeminiAdapter } from '../lib/models/geminiAdapter.ts';
import { TracedGemini } from '../lib/models/tracedGemini.ts';
import { ADK_HANDLE_MODEL_ERROR, declaresReflectionTool, standsForAdkGemini } from '../lib/runtime/native/selfCorrection.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { RuntimeName } from '../lib/runtime/runtimeFlag.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';

setLogLevel(LogLevel.ERROR);

const KEY = 'fixture-gemini-key-0123456789';
const MODEL = 'gemini-3.8-flash';
const SIGNATURE = 'c2lnLWZpeHR1cmUtMQ==';

registerTool(
  'gemini_parity_lookup',
  defineTool({
    name: 'gemini_parity_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string().describe('What to look up.') }),
    execute: async ({ key }) => `found ${key}`,
  }),
  { override: true },
);

const ENV_KEYS = [
  'GOOGLE_GENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_PLATFORM', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GEMINI_MODEL_MAP', 'GEMINI_ADAPTER', 'MODEL_GATEWAY', 'MODEL_RETRY_MAX_ATTEMPTS',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let restoreRetries: () => void = () => {};

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GOOGLE_GENAI_API_KEY = KEY;
  restoreRetries = setRetryPolicyOverrides({ baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 50 });
});

afterEach(() => {
  restoreRetries();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── The stubbed Gemini API ───────────────────────────────────────────────────

/** One answer of the stubbed API: the candidate's parts, for the n-th call (from 1). */
type Script = (body: any, n: number) => object[];

const candidate = (parts: object[]) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
});

interface Side {
  status: string;
  error?: string;
  /** Each request body that reached the Gemini API. */
  bodies: any[];
  events: TurnEvent[];
}

async function runTurn(runtime: RuntimeName, config: SyndicateYamlConfig, script: Script, text = 'Announce that the office is closed next Friday.'): Promise<Side> {
  const real = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    assert.equal(new URL(String(url)).host, 'generativelanguage.googleapis.com', 'only the Gemini API is called');
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return new Response(JSON.stringify(candidate(script(body, bodies.length))), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const sessionService = new InMemorySessionService();
    const r = await runSyndicateTurn({
      config,
      parts: [{ text }],
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      sessionService,
      compile: { log: () => {} },
      trace: false,
      runtime,
    });
    const session = await sessionService.getSession({ appName: 'app', userId: 'u', sessionId: 's' });
    return { status: r.status, ...(r.error ? { error: r.error.message } : {}), bodies, events: JSON.parse(JSON.stringify(session?.events ?? [])) as TurnEvent[] };
  } finally {
    globalThis.fetch = real;
  }
}

/** What differs per run: ids, times, the run's id. */
function comparable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (key === 'id' || key === 'timestamp' || key === 'invocationId') return '<run>';
      if (typeof v === 'string' && (v.startsWith('adk-') || v.startsWith(`${ADK_HANDLE_MODEL_ERROR}_`))) return '<call-id>';
      return v;
    }),
  );
}

/**
 * A request body with the schemas in one dialect. ADK's Gemini sends a
 * tool's parameters and the output schema as Gemini's Schema (`parameters`,
 * `responseSchema`, upper-case types); the native step's mapping sends the
 * same schema as JSON Schema (`parametersJsonSchema`, `responseJsonSchema`).
 * Gemini reads both alike, nothing stored depends on it, and the engine keeps
 * JSON Schema (ADR 0100).
 */
function oneDialect(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body, function (key, v) {
      if (key === 'type' && typeof v === 'string') return v.toLowerCase();
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const out: Record<string, unknown> = {};
        for (const [k, inner] of Object.entries(v)) out[k === 'parameters' ? 'parametersJsonSchema' : k === 'responseSchema' ? 'responseJsonSchema' : k] = inner;
        return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
      }
      return v;
    }),
  );
}

/** The Gemini tools that run on Google's side. */
const SERVER_SIDE = ['googleSearch', 'urlContext', 'codeExecution', 'googleSearchRetrieval'];

/**
 * A run's request bodies as compared: ids and times out, the schemas in one
 * dialect, the tools in one order. Under the engine's GeminiAdapter two more differences are read
 * out, each a deliberate choice that changes nothing Gemini does (ADR 0100):
 *   - the system instruction's role: ADK's Gemini sends `role: 'user'` on
 *     it, the engine none; Gemini reads neither;
 *   - `includeServerSideToolInvocations`: ADK's path sets it on every Gemini
 *     agent, the engine only where server-side tools sit beside function
 *     declarations (ADR 0065), the one place it changes a response.
 */
function sameRequests(bodies: any[], gemini: NativeGemini): unknown {
  // The tools in one order: ADK's code executor puts codeExecution first, the
  // native request after the function declarations; Gemini reads them as a set.
  const ordered = bodies.map((body) =>
    body.tools ? { ...body, tools: [...body.tools].sort((a: object, b: object) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : body,
  );
  const read = gemini === 'adk' ? ordered : ordered.map((body) => {
    const { systemInstruction, toolConfig, ...rest } = body;
    const serverSide = (body.tools ?? []).some((t: object) => SERVER_SIDE.some((k) => k in t));
    const functions = (body.tools ?? []).some((t: any) => t.functionDeclarations?.length);
    const { includeServerSideToolInvocations, ...config } = toolConfig ?? {};
    const keptConfig = serverSide && functions && includeServerSideToolInvocations !== undefined ? { ...config, includeServerSideToolInvocations } : config;
    const { role: _role, ...instruction } = systemInstruction ?? {};
    return {
      ...rest,
      ...(systemInstruction ? { systemInstruction: instruction } : {}),
      ...(Object.keys(keptConfig).length ? { toolConfig: keptConfig } : {}),
    };
  });
  return oneDialect(comparable(read));
}

/** The function names a request declared to Gemini. */
const declared = (body: any): string[] => (body.tools ?? []).flatMap((t: any) => (t.functionDeclarations ?? []).map((d: any) => d.name));

/** Every function-call part in a request's contents, or a stored session's events. */
const callPartsOf = (contents: any[]): any[] => contents.flatMap((c) => (c?.parts ?? []).filter((p: any) => p.functionCall));

const solo = (orchestrator: Record<string, unknown> = {}): SyndicateYamlConfig =>
  validateSyndicateConfig(
    { syndicate_name: 'Gemini', memory_system: 'internal-only', orchestrator: { name: 'Boss', model: MODEL, instruction: 'Help.', tools: ['gemini_parity_lookup'], ...orchestrator }, subagents: [] },
    'test',
  ) as SyndicateYamlConfig;

/**
 * The Gemini adapters the native runtime can serve a Gemini id with
 * (GEMINI_ADAPTER): the wrapper over ADK's Gemini (the default until gate G3)
 * and the engine's own GeminiAdapter (ADR 0100). Each is held to ADK.
 */
const NATIVE_GEMINI = ['adk', 'engine'] as const;
type NativeGemini = (typeof NATIVE_GEMINI)[number];

async function bothRuntimes(config: SyndicateYamlConfig, script: Script, gemini: NativeGemini = 'adk'): Promise<{ adk: Side; native: Side }> {
  const adk = await runTurn('adk', config, script);
  process.env.GEMINI_ADAPTER = gemini;
  try {
    const native = await runTurn('native', config, script);
    return { adk, native };
  } finally {
    delete process.env.GEMINI_ADAPTER;
  }
}

// ── Thought signatures ───────────────────────────────────────────────────────

const signedCall: Script = (_body, n) =>
  n === 1 ? [{ functionCall: { name: 'gemini_parity_lookup', args: { key: 'friday' } }, thoughtSignature: SIGNATURE }] : [{ text: 'The office is closed next Friday.' }];

for (const gemini of NATIVE_GEMINI) {
  test(`a Gemini call's thoughtSignature is stored on its part and replayed on the next request, as on ADK (native Gemini: ${gemini})`, async () => {
    const { adk, native } = await bothRuntimes(solo(), signedCall, gemini);
    for (const side of [adk, native]) {
      assert.equal(side.status, 'completed', side.error);
      assert.equal(side.bodies.length, 2);
      const stored = callPartsOf(side.events.map((e) => e.content));
      assert.equal(stored.length, 1);
      assert.equal(stored[0].thoughtSignature, SIGNATURE, 'the stored call keeps its signature');
      const replayed = callPartsOf(side.bodies[1].contents);
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0].thoughtSignature, SIGNATURE, 'the next request replays it on the call');
    }
    assert.deepEqual(sameRequests(native.bodies, gemini), sameRequests(adk.bodies, gemini), 'native sends what ADK sends');
    // turnComplete included: the native step stores none for ADK's Gemini's stand-in (ADR 0100).
    assert.deepEqual(comparable(native.events), comparable(adk.events), 'native stores what ADK stores');
    for (const event of native.events) assert.equal(event.turnComplete, undefined, 'no turnComplete, as ADK stores none');
  });

  // ── The reflection tool ────────────────────────────────────────────────────

  test(`retries at their defaults: the reflection tool is never declared to Gemini, on either runtime (native Gemini: ${gemini})`, async () => {
    const { adk, native } = await bothRuntimes(solo(), signedCall, gemini);
    for (const side of [adk, native]) {
      for (const body of side.bodies) assert.deepEqual(declared(body), ['gemini_parity_lookup']);
    }
  });

  test(`a Gemini call to the reserved tool is still replaced and answered with reflection guidance, as on ADK (native Gemini: ${gemini})`, async () => {
    const reserved: Script = (_body, n) => (n === 1 ? [{ functionCall: { name: ADK_HANDLE_MODEL_ERROR, args: {} }, thoughtSignature: SIGNATURE }] : [{ text: 'Done.' }]);
    const { adk, native } = await bothRuntimes(solo(), reserved, gemini);
    for (const side of [adk, native]) {
      assert.equal(side.status, 'completed', side.error);
      const answers = side.events.flatMap((e) => (e.content?.parts ?? []).filter((p: any) => p.functionResponse)).map((p: any) => p.functionResponse);
      assert.equal(answers.length, 1);
      assert.equal(answers[0].name, ADK_HANDLE_MODEL_ERROR);
      assert.match(String(answers[0].response?.reflection_guidance), /The call to the model failed/, 'the reflection tool ran, though it was not declared');
    }
    assert.deepEqual(comparable(native.events), comparable(adk.events));
    assert.deepEqual(sameRequests(native.bodies, gemini), sameRequests(adk.bodies, gemini));
  });

  test(`a workflow node agent on Gemini: no reflection tool is declared, and native sends what ADK sends (native Gemini: ${gemini})`, async () => {
    await workflowNodeParity(gemini);
  });
}

async function workflowNodeParity(gemini: NativeGemini): Promise<void> {
  const config = validateSyndicateConfig(
    {
      syndicate_name: 'Pipeline',
      memory_system: 'internal-only',
      workflow: {
        edges: [['START', 'Planner', { article: 'Writer', default: 'Answerer' }]],
        nodes: { Planner: { route_key: 'kind' } },
      },
      orchestrator: {
        name: 'Planner',
        model: MODEL,
        instruction: 'Answer with one JSON object: {"kind": "article" | "answer", "brief": "<text>"}.',
        generateContentConfig: { responseMimeType: 'application/json', maxOutputTokens: 512 },
        outputSchema: { type: 'OBJECT', properties: { kind: { type: 'STRING', enum: ['article', 'answer'] }, brief: { type: 'STRING' } }, required: ['kind', 'brief'] },
      },
      subagents: [
        { name: 'Writer', description: 'Writes.', model: MODEL, instruction: 'Write the piece.' },
        { name: 'Answerer', description: 'Answers.', model: MODEL, instruction: 'Answer the brief.' },
      ],
    },
    'test',
  ) as SyndicateYamlConfig;
  const script: Script = (_body, n) => (n === 1 ? [{ text: '{"kind": "answer", "brief": "Say the office is closed next Friday."}' }] : [{ text: 'The office is closed next Friday.' }]);
  const { adk, native } = await bothRuntimes(config, script, gemini);
  for (const side of [adk, native]) {
    assert.equal(side.status, 'completed', side.error);
    assert.equal(side.bodies.length, 2);
    for (const body of side.bodies) assert.ok(!declared(body).includes(ADK_HANDLE_MODEL_ERROR), 'no reflection tool on a node agent');
  }
  assert.deepEqual(sameRequests(native.bodies, gemini), sameRequests(adk.bodies, gemini), 'native sends what ADK sends');
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'native stores what ADK stores');
}

// ── Code execution (ADR 0065, ADR 0100) ──────────────────────────────────────

const CODE = { executableCode: { language: 'PYTHON', code: 'print(6 * 7)' }, thoughtSignature: 'Y29kZS1zaWc=' };
const CODE_RESULT = { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '42\n' } };

/** Every code execution part a run's stored events hold. */
const codePartsOf = (events: TurnEvent[]): any[] =>
  events.flatMap((e) => (e.content?.parts ?? []).filter((p: any) => p.executableCode || p.codeExecutionResult));

for (const gemini of NATIVE_GEMINI) {
  test(`code execution: the code and its result are stored as Gemini sent them, as on ADK (native Gemini: ${gemini})`, async () => {
    const script: Script = () => [CODE, CODE_RESULT, { text: 'The product is 42.' }];
    const { adk, native } = await bothRuntimes(solo({ tools: [], code_execution: 'gemini' }), script, gemini);
    for (const side of [adk, native]) {
      assert.equal(side.status, 'completed', side.error);
      assert.deepEqual(codePartsOf(side.events), [CODE, CODE_RESULT], 'both parts stored whole, the signature with the code');
    }
    assert.deepEqual(sameRequests(native.bodies, gemini), sameRequests(adk.bodies, gemini), 'native sends what ADK sends');
    assert.deepEqual(comparable(native.events), comparable(adk.events), 'native stores what ADK stores');
  });

  test(`code execution beside a function tool: the parts are stored, and replayed before the signed call on the next step, as on ADK (native Gemini: ${gemini})`, async () => {
    const script: Script = (_body, n) =>
      n === 1
        ? [CODE, CODE_RESULT, { functionCall: { name: 'gemini_parity_lookup', args: { key: 'friday' } }, thoughtSignature: SIGNATURE }]
        : [{ text: 'The office is closed next Friday.' }];
    const { adk, native } = await bothRuntimes(solo({ code_execution: 'gemini' }), script, gemini);
    for (const side of [adk, native]) {
      assert.equal(side.status, 'completed', side.error);
      assert.equal(side.bodies.length, 2);
      assert.deepEqual(codePartsOf(side.events), [CODE, CODE_RESULT]);
      const model = side.bodies[1].contents.find((c: any) => c.role === 'model');
      assert.deepEqual(model.parts.slice(0, 2), [CODE, CODE_RESULT], 'the code and its result go back before the call');
      assert.equal(model.parts[2]?.thoughtSignature, SIGNATURE);
    }
    assert.deepEqual(sameRequests(native.bodies, gemini), sameRequests(adk.bodies, gemini), 'native sends what ADK sends');
    assert.deepEqual(comparable(native.events), comparable(adk.events), 'native stores what ADK stores');
  });
}

test('declaresReflectionTool: a Gemini adapter stands for ADK\'s Gemini unless a caller handed it over behind the shim', () => {
  assert.equal(declaresReflectionTool({ provider: 'anthropic' }), true);
  assert.equal(declaresReflectionTool({ provider: 'scripted' }), true);
  assert.equal(declaresReflectionTool({ provider: 'gemini' }), false);
  // The registry's id, and an ADK Gemini a BYOK resolver returns: ADK's Gemini on ADK, so not declared.
  assert.equal(declaresReflectionTool(nativeAdapterFor({})(MODEL)), false);
  assert.equal(declaresReflectionTool(nativeAdapterFor({ resolveModel: (m) => new TracedGemini({ model: String(m), apiKey: KEY }) })(MODEL)), false);
  // A shim over a Gemini contract adapter: ADK's shim declares the toolsDict, so declared.
  const own = new GeminiAdapter({ model: MODEL, apiKey: KEY });
  const behindShim = nativeAdapterFor({ resolveModel: () => adkShim(own) })(MODEL);
  assert.equal(behindShim, own);
  assert.equal(declaresReflectionTool(behindShim), true);
  // The same adapters, read the other way: which stand for ADK's Gemini, and so store no turnComplete (ADR 0100).
  assert.equal(standsForAdkGemini({ provider: 'gemini' }), true);
  assert.equal(standsForAdkGemini(nativeAdapterFor({})(MODEL)), true);
  assert.equal(standsForAdkGemini(behindShim), false);
  assert.equal(standsForAdkGemini({ provider: 'anthropic' }), false);
});
