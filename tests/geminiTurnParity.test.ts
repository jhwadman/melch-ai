/**
 * tests/geminiTurnParity.test.ts — a Gemini agent's turn through the engine's
 * GeminiAdapter and the real Gemini SDK, over a stubbed fetch, held to ADK's
 * recorded turn (WS4-6b, ADR 0097).
 *
 * The other parity suites script their models behind the shim mark, which
 * reads the request's toolsDict. ADK's Gemini read only the request's
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
 *     replaced and answered with reflection guidance as in ADK's recording;
 *   - on native, the reflection call stored in a Gemini 3 model's place
 *     carries the replaced call's signature, or Gemini's placeholder after a
 *     MALFORMED_FUNCTION_CALL, so the next request passes Gemini 3's
 *     signature check; ADK stored it unsigned and got the 400 (ADR 0103).
 *
 * Each case runs on the engine's GeminiAdapter and holds it to ADK, the
 * stored events in full, turnComplete included (ADR 0100).
 *
 * ADK's side of each case is the recording ADK 2.2 wrote before 1.0.0
 * removed ADK (tests/fixtures/adk-reference/geminiturnparity, read through
 * tests/helpers/adkReference.ts).
 *
 * Offline: no provider is called, and the key is an obvious fixture.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { setRetryPolicyOverrides } from '../lib/models/retry.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { nativeAdapterFor } from '../lib/compileNative.ts';
import { GeminiAdapter, PLACEHOLDER_THOUGHT_SIGNATURE } from '../lib/models/geminiAdapter.ts';
import { ADK_HANDLE_MODEL_ERROR, declaresReflectionTool, reflectionSigning, servedThroughShim, standsForAdkGemini } from '../lib/runtime/native/selfCorrection.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { adkReferences } from './helpers/adkReference.ts';

const reference = adkReferences('geminiTurnParity');

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

/** One answer of the stubbed API for the n-th call (from 1): the candidate's parts, or its parts and finish reason. */
type Answer = object[] | { parts: object[]; finishReason: string };
type Script = (body: any, n: number) => Answer;

const candidate = (answer: Answer) => {
  const { parts, finishReason } = Array.isArray(answer) ? { parts: answer, finishReason: 'STOP' } : answer;
  return {
    candidates: [{ ...(parts.length ? { content: { role: 'model', parts } } : {}), finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
};

/**
 * Gemini 3's signature check, as the stub plays it: a request whose contents
 * hold a function call without a thoughtSignature gets the 400 Gemini sends.
 */
const unsignedCall = (body: any): boolean => (body.contents ?? []).some((c: any) => (c?.parts ?? []).some((p: any) => p.functionCall && !p.thoughtSignature));
const MISSING_SIGNATURE = {
  error: { code: 400, message: 'Function call is missing a thought_signature in functionCall parts.', status: 'INVALID_ARGUMENT' },
};

interface Side {
  status: string;
  error?: string;
  /** Each request body that reached the Gemini API. */
  bodies: any[];
  events: TurnEvent[];
}

async function runTurn(config: SyndicateYamlConfig, script: Script, text = 'Announce that the office is closed next Friday.', strict = false): Promise<Side> {
  const real = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    assert.equal(new URL(String(url)).host, 'generativelanguage.googleapis.com', 'only the Gemini API is called');
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (strict && unsignedCall(body)) return new Response(JSON.stringify(MISSING_SIGNATURE), { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(candidate(script(body, bodies.length))), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const sessionService = new InProcessSessionService();
    const r = await runSyndicateTurn({
      config,
      parts: [{ text }],
      appName: 'app',
      userId: 'u',
      sessionId: 's',
      sessionService,
      compile: { log: () => {} },
      trace: false,
    });
    const session = await sessionService.get({ appName: 'app', userId: 'u', sessionId: 's' });
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
 * dialect, the tools in one order. Two more differences are read
 * out, each a deliberate choice that changes nothing Gemini does (ADR 0100):
 *   - the system instruction's role: ADK's Gemini sends `role: 'user'` on
 *     it, the engine none; Gemini reads neither;
 *   - `includeServerSideToolInvocations`: ADK's path sets it on every Gemini
 *     agent, the engine only where server-side tools sit beside function
 *     declarations (ADR 0065), the one place it changes a response.
 */
function sameRequests(bodies: any[]): unknown {
  // The tools in one order: ADK's code executor puts codeExecution first, the
  // native request after the function declarations; Gemini reads them as a set.
  const ordered = bodies.map((body) =>
    body.tools ? { ...body, tools: [...body.tools].sort((a: object, b: object) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : body,
  );
  const read = ordered.map((body) => {
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

/** ADK's side per case, read once. */
const adkRuns = new Map<string, Promise<Side>>();

/** ADK's recorded side of case `name`, then the turn on the engine's GeminiAdapter. */
async function bothRuntimes(name: string, config: SyndicateYamlConfig, script: Script, strict = false): Promise<{ adk: Side; native: Side }> {
  const text = 'Announce that the office is closed next Friday.';
  if (!adkRuns.has(name)) adkRuns.set(name, reference<Side>(name));
  const adk = await adkRuns.get(name)!;
  const native = await runTurn(config, script, text, strict);
  return { adk, native };
}

// ── Thought signatures ───────────────────────────────────────────────────────

/** A first answer that calls the reserved reflection tool, signed as Gemini 3 signs a call. */
const reservedCall: Script = (_body, n) => (n === 1 ? [{ functionCall: { name: ADK_HANDLE_MODEL_ERROR, args: {} }, thoughtSignature: SIGNATURE }] : [{ text: 'Done.' }]);

/** Events or request bodies with the reflection call's signature taken off: what ADK stores and sends. */
const unsigned = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && v.functionCall?.name === ADK_HANDLE_MODEL_ERROR ? (({ thoughtSignature: _s, ...rest }) => rest)(v) : v)));

const signedCall: Script = (_body, n) =>
  n === 1 ? [{ functionCall: { name: 'gemini_parity_lookup', args: { key: 'friday' } }, thoughtSignature: SIGNATURE }] : [{ text: 'The office is closed next Friday.' }];

test(`a Gemini call's thoughtSignature is stored on its part and replayed on the next request, as on ADK`, async () => {
  const { adk, native } = await bothRuntimes('signed-call', solo(), signedCall);
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
  assert.deepEqual(sameRequests(native.bodies), sameRequests(adk.bodies), 'native sends what ADK sends');
  // turnComplete included: the native step stores none for ADK's Gemini's stand-in (ADR 0100).
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'native stores what ADK stores');
  for (const event of native.events) assert.equal(event.turnComplete, undefined, 'no turnComplete, as ADK stores none');
});

// ── The reflection tool ────────────────────────────────────────────────────

test(`retries at their defaults: the reflection tool is never declared to Gemini, on the engine or in ADK's recording`, async () => {
  const { adk, native } = await bothRuntimes('signed-call', solo(), signedCall);
  for (const side of [adk, native]) {
    for (const body of side.bodies) assert.deepEqual(declared(body), ['gemini_parity_lookup']);
  }
});

test(`a Gemini call to the reserved tool is still replaced and answered with reflection guidance, as on ADK but signed`, async () => {
  const { adk, native } = await bothRuntimes('reserved-call', solo(), reservedCall);
  for (const side of [adk, native]) {
    assert.equal(side.status, 'completed', side.error);
    const answers = side.events.flatMap((e) => (e.content?.parts ?? []).filter((p: any) => p.functionResponse)).map((p: any) => p.functionResponse);
    assert.equal(answers.length, 1);
    assert.equal(answers[0].name, ADK_HANDLE_MODEL_ERROR);
    assert.match(String(answers[0].response?.reflection_guidance), /The call to the model failed/, 'the reflection tool ran, though it was not declared');
  }
  // The one difference (ADR 0103): native's reflection call carries the replaced call's signature, ADK's none.
  assert.deepEqual(callPartsOf(native.events.map((e) => e.content)).map((p) => p.thoughtSignature), [SIGNATURE]);
  assert.deepEqual(callPartsOf(adk.events.map((e) => e.content)).map((p) => p.thoughtSignature), [undefined]);
  assert.deepEqual(comparable(unsigned(native.events)), comparable(adk.events), 'otherwise native stores what ADK stores');
  assert.deepEqual(sameRequests(unsigned(native.bodies)), sameRequests(adk.bodies), 'otherwise native sends what ADK sends');
});

test(`Gemini 3 checks signatures: native's reflection call carries the reserved call's, and the turn completes; ADK's gets the 400`, async () => {
  const { adk, native } = await bothRuntimes('reserved-call-strict', solo(), reservedCall, true);
  assert.equal(native.status, 'completed', native.error);
  assert.equal(native.bodies.length, 2);
  assert.deepEqual(callPartsOf(native.bodies[1].contents).map((p) => [p.functionCall.name, p.thoughtSignature]), [[ADK_HANDLE_MODEL_ERROR, SIGNATURE]], 'the next request sends it signed');
  // ADK's plugin stored the call unsigned: the gap ADR 0097 recorded.
  assert.notEqual(adk.status, 'completed');
  assert.match(String(adk.error), /thought_signature/);
});

test(`Gemini 3 checks signatures: a MALFORMED_FUNCTION_CALL retry's reflection call carries Gemini's placeholder on native; ADK's gets the 400`, async () => {
  const malformed: Script = (_body, n) => (n === 1 ? { parts: [], finishReason: 'MALFORMED_FUNCTION_CALL' } : [{ text: 'The office is closed next Friday.' }]);
  const { adk, native } = await bothRuntimes('malformed-strict', solo(), malformed, true);
  assert.equal(native.status, 'completed', native.error);
  const stored = callPartsOf(native.events.map((e) => e.content));
  assert.deepEqual(stored.map((p) => [p.functionCall.name, p.functionCall.args?.finish_reason, p.thoughtSignature]), [[ADK_HANDLE_MODEL_ERROR, 'MALFORMED_FUNCTION_CALL', PLACEHOLDER_THOUGHT_SIGNATURE]]);
  assert.deepEqual(callPartsOf(native.bodies[1].contents).map((p) => p.thoughtSignature), [PLACEHOLDER_THOUGHT_SIGNATURE], 'the next request sends the placeholder');
  assert.notEqual(adk.status, 'completed');
  assert.match(String(adk.error), /thought_signature/);
});

test(`a workflow node agent on Gemini: no reflection tool is declared, and native sends what ADK sends`, async () => {
  await workflowNodeParity();
});

async function workflowNodeParity(): Promise<void> {
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
  const { adk, native } = await bothRuntimes('workflow-node', config, script);
  for (const side of [adk, native]) {
    assert.equal(side.status, 'completed', side.error);
    assert.equal(side.bodies.length, 2);
    for (const body of side.bodies) assert.ok(!declared(body).includes(ADK_HANDLE_MODEL_ERROR), 'no reflection tool on a node agent');
  }
  assert.deepEqual(sameRequests(native.bodies), sameRequests(adk.bodies), 'native sends what ADK sends');
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'native stores what ADK stores');
}

// ── Code execution (ADR 0065, ADR 0100) ──────────────────────────────────────

const CODE = { executableCode: { language: 'PYTHON', code: 'print(6 * 7)' }, thoughtSignature: 'Y29kZS1zaWc=' };
const CODE_RESULT = { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '42\n' } };

/** Every code execution part a run's stored events hold. */
const codePartsOf = (events: TurnEvent[]): any[] =>
  events.flatMap((e) => (e.content?.parts ?? []).filter((p: any) => p.executableCode || p.codeExecutionResult));

test(`code execution: the code and its result are stored as Gemini sent them, as on ADK`, async () => {
  const script: Script = () => [CODE, CODE_RESULT, { text: 'The product is 42.' }];
  const { adk, native } = await bothRuntimes('code-execution', solo({ tools: [], code_execution: 'gemini' }), script);
  for (const side of [adk, native]) {
    assert.equal(side.status, 'completed', side.error);
    assert.deepEqual(codePartsOf(side.events), [CODE, CODE_RESULT], 'both parts stored whole, the signature with the code');
  }
  assert.deepEqual(sameRequests(native.bodies), sameRequests(adk.bodies), 'native sends what ADK sends');
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'native stores what ADK stores');
});

test(`code execution beside a function tool: the parts are stored, and replayed before the signed call on the next step, as on ADK`, async () => {
  const script: Script = (_body, n) =>
    n === 1
      ? [CODE, CODE_RESULT, { functionCall: { name: 'gemini_parity_lookup', args: { key: 'friday' } }, thoughtSignature: SIGNATURE }]
      : [{ text: 'The office is closed next Friday.' }];
  const { adk, native } = await bothRuntimes('code-execution-beside-tool', solo({ code_execution: 'gemini' }), script);
  for (const side of [adk, native]) {
    assert.equal(side.status, 'completed', side.error);
    assert.equal(side.bodies.length, 2);
    assert.deepEqual(codePartsOf(side.events), [CODE, CODE_RESULT]);
    const model = side.bodies[1].contents.find((c: any) => c.role === 'model');
    assert.deepEqual(model.parts.slice(0, 2), [CODE, CODE_RESULT], 'the code and its result go back before the call');
    assert.equal(model.parts[2]?.thoughtSignature, SIGNATURE);
  }
  assert.deepEqual(sameRequests(native.bodies), sameRequests(adk.bodies), 'native sends what ADK sends');
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'native stores what ADK stores');
});

test('declaresReflectionTool: a Gemini adapter stands for ADK\'s Gemini unless a caller handed it over behind the shim', () => {
  assert.equal(declaresReflectionTool({ provider: 'anthropic' }), true);
  assert.equal(declaresReflectionTool({ provider: 'scripted' }), true);
  assert.equal(declaresReflectionTool({ provider: 'gemini' }), false);
  // The registry's id: it stands for ADK's own Gemini, so not declared.
  assert.equal(declaresReflectionTool(nativeAdapterFor({})(MODEL)), false);
  // A Gemini contract adapter marked as served through the shim: the shim declared the toolsDict, so declared.
  const own = new GeminiAdapter({ model: MODEL, apiKey: KEY });
  const behindShim = nativeAdapterFor({ resolveModel: () => servedThroughShim(own) })(MODEL);
  assert.equal(behindShim, own);
  assert.equal(declaresReflectionTool(behindShim), true);
  // The same adapters, read the other way: which stand for ADK's Gemini, and so store no turnComplete (ADR 0100).
  assert.equal(standsForAdkGemini({ provider: 'gemini' }), true);
  assert.equal(standsForAdkGemini(nativeAdapterFor({})(MODEL)), true);
  assert.equal(standsForAdkGemini(behindShim), false);
  assert.equal(standsForAdkGemini({ provider: 'anthropic' }), false);
});

test('reflectionSigning: a Gemini adapter signs the reflection call, with the placeholder on Gemini 3 only; any other provider stores it unsigned, as ADK does', () => {
  const gemini = { provider: 'gemini' };
  assert.deepEqual(reflectionSigning(gemini, MODEL), { placeholder: PLACEHOLDER_THOUGHT_SIGNATURE });
  assert.deepEqual(reflectionSigning(gemini, 'publishers/google/models/gemini-3.5-flash-lite'), { placeholder: PLACEHOLDER_THOUGHT_SIGNATURE });
  assert.deepEqual(reflectionSigning(gemini, 'gemini-2.5-flash'), {}, 'a carried signature only: Gemini 2.5 does not check');
  assert.equal(reflectionSigning({ provider: 'anthropic' }, 'claude-sonnet-4-6'), undefined);
  assert.equal(reflectionSigning({ provider: 'gateway' }, 'gemini-3.8-flash'), undefined, "a gateway model is the gateway's");
});
