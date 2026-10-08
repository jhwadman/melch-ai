/**
 * tests/kimiReasoningState.test.ts — Kimi's reasoning_content carried across
 * the steps of a tool loop (replaysReasoningContent in
 * lib/models/openAiCompatibleLlm.ts, ADR 0046).
 *
 * Offline: the chat-completions adapters talk to a fetch stub that answers in
 * Moonshot's wire format (JSON and SSE), and the subagent is scripted. Keys
 * are fixtures.
 *
 * What is proved here:
 *   - through a REAL ADK Runner, on both the streamed and the non-streamed
 *     path, Kimi writes the response's reasoning_content as providerState on
 *     the part that followed it, and the second request of the tool loop
 *     sends it back on the assistant message that holds the call;
 *   - each assistant message of the turn gets its own, earlier turns' get
 *     none, and only ids Moonshot documents as wanting it opt in;
 *   - only the reasoning_content field is carried, never <think> blocks or
 *     a `reasoning` field;
 *   - Ollama and the gateway (whose provider id for kimi-k3 IS moonshot)
 *     neither write nor send it;
 *   - a model switch between steps drops it.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { BaseLlm, InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { KimiLlm, wantsReasoningReplay } from '../lib/models/kimiLlm.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { GatewayLlm } from '../lib/models/gatewayLlm.ts';
import { REASONING_CONTENT_KIND } from '../lib/models/openAiCompatibleLlm.ts';
import { providerStateOf } from '../lib/models/providerState.ts';
import { ScriptedLlm, scriptedResolver, text } from './helpers/scriptedLlm.ts';
import { forEachRuntime } from './helpers/runtime.ts';

setLogLevel(LogLevel.ERROR);

const APP = 'test-app';
const USER = 'u1';
const MOONSHOT_KEY = 'fixture-moonshot-0123456789abcdef'; // gitleaks:allow (test fixture)
/** The gateway's env for a capture; undefined clears a developer's own value. */
const GATEWAY_ENV = {
  MODEL_GATEWAY: 'openrouter',
  MODEL_GATEWAY_API_KEY: 'fixture-gateway-0123456789abcdef', // gitleaks:allow (test fixture)
  MODEL_GATEWAY_BASE_URL: undefined,
  MODEL_GATEWAY_MODEL_MAP: undefined,
};

const REASONING_1 = 'Scout knows where it is; ask it.';
const REASONING_2 = 'Scout answered; say so.';

// ── Moonshot-shaped replies ──────────────────────────────────────────────────

type Reply = {
  content?: string;
  reasoning_content?: string;
  /** Ollama's name for the field, which no adapter carries. */
  reasoning?: string;
  tool_calls?: Array<{ id: string; name: string; args: unknown }>;
};

const callScout: Reply = { reasoning_content: REASONING_1, tool_calls: [{ id: 'call_1', name: 'Scout', args: { request: 'find it' } }] };
const answer: Reply = { reasoning_content: REASONING_2, content: 'It is in the attic.' };

/** A chat completion, as Moonshot returns one. */
function completion(r: Reply) {
  const tool_calls = r.tool_calls?.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'kimi-k3',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: r.content ?? '',
          ...(r.reasoning_content ? { reasoning_content: r.reasoning_content } : {}),
          ...(r.reasoning ? { reasoning: r.reasoning } : {}),
          ...(tool_calls ? { tool_calls } : {}),
        },
        finish_reason: tool_calls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  };
}

/** The same reply as Moonshot streams it: reasoning, content and arguments in fragments. */
function sse(r: Reply): string {
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: 'chatcmpl-1', choices: [{ index: 0, delta, finish_reason }] });
  const half = (s: string) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))];
  const chunks: unknown[] = [chunk({ role: 'assistant' })];
  if (r.reasoning_content) for (const piece of half(r.reasoning_content)) chunks.push(chunk({ reasoning_content: piece }));
  if (r.content) for (const piece of half(r.content)) chunks.push(chunk({ content: piece }));
  r.tool_calls?.forEach((c, index) => {
    const [a, b] = half(JSON.stringify(c.args));
    chunks.push(chunk({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: a } }] }));
    chunks.push(chunk({ tool_calls: [{ index, function: { arguments: b } }] }));
  });
  chunks.push(chunk({}, r.tool_calls ? 'tool_calls' : 'stop'));
  chunks.push({ id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/**
 * Replaces fetch for the test body: each chat-completions call takes the next
 * scripted reply (as SSE when the request streams), or a 400 when none is left.
 */
async function withMoonshot<T>(replies: Reply[], body: (sent: any[]) => Promise<T>): Promise<T> {
  const sent: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    sent.push(parsed);
    const reply = replies.shift();
    if (!reply) return new Response('{"error":{"message":"captured"}}', { status: 400, headers: { 'content-type': 'application/json' } });
    return parsed?.stream
      ? new Response(sse(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(completion(reply)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return await body(sent);
  } finally {
    globalThis.fetch = original;
  }
}

/** Sets (or, for undefined, clears) env vars for the body, restoring what was there. */
async function withEnv<T>(env: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── A syndicate whose boss is the adapter under test ─────────────────────────

const config: SyndicateYamlConfig = {
  syndicate_name: 'Test',
  orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout.', generateContentConfig: { reasoningEffort: 'low' } },
  subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
} as SyndicateYamlConfig;

const scout = () => new ScriptedLlm('scripted/scout', () => text('in the attic'));
const kimi = (model = 'kimi-k3') => new KimiLlm({ model, apiKey: MOONSHOT_KEY });

function turn(boss: BaseLlm, sessionService = new InMemorySessionService(), streaming = false) {
  return runSyndicateTurn({
    config,
    parts: [{ text: 'find the thing' }],
    appName: APP,
    userId: USER,
    sessionId: 's1',
    sessionService,
    compile: { resolveModel: scriptedResolver({ boss, scout: scout() } as any) },
    trace: false,
    streaming,
  });
}

/** The assistant messages of a chat-completions request body. */
const assistants = (body: any): any[] => (body.messages ?? []).filter((m: any) => m.role === 'assistant');

/**
 * A resolver that returns an ADK model class which is neither the shim nor
 * Gemini (StepSwitch here) is not run by the native runtime: it resolves the
 * id through the registry instead (ADR 0073, decision 6). Open question in
 * the WS2-12 PR; these cases run on ADK until it is decided.
 */
const ADK_MODEL_CLASS = {
  notOn: { native: { reason: 'a resolver returning an ADK model class that is not a shim is resolved by id on native (ADR 0073)', ticket: 'WS2-12 open question 2' } },
};

/** One model per step, in order: a model switch between steps, as a fallback makes one. */
class StepSwitch extends BaseLlm {
  private calls = 0;
  private readonly steps: BaseLlm[];
  constructor(steps: BaseLlm[]) {
    super({ model: 'scripted/switch' });
    this.steps = steps;
  }
  async *generateContentAsync(request: LlmRequest, stream?: boolean, signal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    const model = this.steps[Math.min(this.calls++, this.steps.length - 1)];
    yield* model.generateContentAsync(request, stream, signal);
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error('no live connections');
  }
}

// ── Through a real ADK Runner ────────────────────────────────────────────────

for (const streaming of [false, true]) {
  test(`kimi-k3 (${streaming ? 'SSE' : 'JSON'}): the second request of the tool loop sends reasoning_content back on the call's assistant message`, async () => {
    const sessions = new InMemorySessionService();
    await withMoonshot([callScout, answer], async (sent) => {
      const r = await turn(kimi(), sessions, streaming);
      assert.equal(r.status, 'completed', JSON.stringify(r.error));
      assert.equal(sent.length, 2, 'one request per step');
      assert.equal(sent[1].stream, streaming);

      // The first request has nothing to send back.
      assert.deepEqual(assistants(sent[0]), []);

      // The second carries the first step's reasoning on the message that holds the call.
      const [call] = assistants(sent[1]);
      assert.equal(call.reasoning_content, REASONING_1);
      assert.equal(call.tool_calls?.[0]?.function?.name, 'Scout');
      assert.equal(call.tool_calls?.[0]?.id, 'call_1');
      const wire = JSON.stringify(sent[1]);
      assert.ok(!wire.includes('providerState'), 'the convention never reaches the wire');
      assert.ok(!wire.includes(REASONING_2));

      // Stored on the call part, bound to the provider and the model.
      const s = await sessions.getSession({ appName: APP, userId: USER, sessionId: 's1' });
      const parts = (s?.events ?? []).flatMap((e) => e.content?.parts ?? []);
      const stored = parts.find((p: any) => p.functionCall?.name === 'Scout');
      assert.deepEqual(providerStateOf(stored, 'moonshot', REASONING_CONTENT_KIND, 'kimi-k3'), {
        provider: 'moonshot',
        kind: REASONING_CONTENT_KIND,
        model: 'kimi-k3',
        payload: REASONING_1,
      });
      // The final answer carries its own, for a later step that never came.
      const final = parts.find((p: any) => p.text === 'It is in the attic.');
      assert.equal(providerStateOf(final, 'moonshot', REASONING_CONTENT_KIND)?.payload, REASONING_2);
    });
  });
}

forEachRuntime('a model switch between steps drops it: kimi-k3 then kimi-k2.6', async () => {
  await withMoonshot([callScout, answer], async (sent) => {
    const r = await turn(new StepSwitch([kimi('kimi-k3'), kimi('kimi-k2.6')]));
    assert.equal(r.status, 'completed', JSON.stringify(r.error));
    assert.equal(sent[1].model, 'kimi-k2.6');
    const [call] = assistants(sent[1]);
    assert.ok(call.tool_calls?.length, 'the call is still in the history');
    assert.equal(call.reasoning_content, undefined);
    assert.ok(!JSON.stringify(sent[1]).includes(REASONING_1));
  });
}, ADK_MODEL_CLASS);

forEachRuntime('a provider switch drops it: kimi-k3 then Ollama', async () => {
  await withMoonshot([callScout, answer], async (sent) => {
    const r = await turn(new StepSwitch([kimi('kimi-k3'), new OllamaLlm({ model: 'ollama/qwen3:8b' })]));
    assert.equal(r.status, 'completed', JSON.stringify(r.error));
    assert.equal(sent[1].model, 'qwen3:8b');
    assert.ok(!JSON.stringify(sent[1]).includes(REASONING_1));
  });
}, ADK_MODEL_CLASS);

// ── The request a turn's history produces ────────────────────────────────────

const state = (payload: string, model = 'kimi-k3', provider = 'moonshot') => ({ provider, kind: REASONING_CONTENT_KIND, model, payload });

/** Two turns: the first a finished tool loop, the second mid-loop with two steps. */
function twoTurns(model: string): LlmRequest {
  return {
    model,
    contents: [
      { role: 'user', parts: [{ text: 'first question' }] },
      { role: 'model', parts: [{ functionCall: { id: 'old_1', name: 'Scout', args: {} }, providerState: state('old reasoning', model) }] },
      { role: 'user', parts: [{ functionResponse: { id: 'old_1', name: 'Scout', response: { result: 'x' } } }] },
      { role: 'model', parts: [{ text: 'first answer', providerState: state('old answer reasoning', model) }] },
      { role: 'user', parts: [{ text: 'second question' }] },
      { role: 'model', parts: [{ text: 'Checking.', providerState: state('step one', model) }, { functionCall: { id: 'c1', name: 'Scout', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'Scout', response: { result: 'y' } } }] },
      { role: 'model', parts: [{ functionCall: { id: 'c2', name: 'Scout', args: {} }, providerState: state('step two', model) }] },
      { role: 'user', parts: [{ functionResponse: { id: 'c2', name: 'Scout', response: { result: 'z' } } }] },
    ],
    liveConnectConfig: {},
    toolsDict: {},
    config: {},
  } as unknown as LlmRequest;
}

/** The body an adapter posts for `request` (the reply is a 400). */
async function bodyFor(llm: BaseLlm, request: LlmRequest): Promise<any> {
  return withMoonshot([], async (sent) => {
    for await (const _ of llm.generateContentAsync(request, false)) {
      // drain; the 400 surfaces as an error response
    }
    assert.equal(sent.length, 1);
    return sent[0];
  });
}

test("each assistant message of the turn's tool loop gets its own reasoning_content; earlier turns' get none", async () => {
  const messages = assistants(await bodyFor(kimi('kimi-k3'), twoTurns('kimi-k3')));
  assert.deepEqual(
    messages.map((m) => [m.content, m.tool_calls?.[0]?.id ?? null, m.reasoning_content ?? null]),
    [
      [null, 'old_1', null],
      ['first answer', null, null],
      ['Checking.', 'c1', 'step one'],
      [null, 'c2', 'step two'],
    ],
  );
});

test("another provider's or another model's state on the same part is skipped", async () => {
  const request = twoTurns('kimi-k3');
  const parts = (request.contents[7].parts ?? []) as any[];
  parts[0].providerState = state('step two', 'kimi-k2.6');
  (request.contents[5].parts as any[])[0].providerState = state('step one', 'kimi-k3', 'anthropic');
  const messages = assistants(await bodyFor(kimi('kimi-k3'), request));
  assert.ok(messages.every((m) => m.reasoning_content === undefined), JSON.stringify(messages));
});

test('Ollama sends none and writes none', async () => {
  const ollama = () => new OllamaLlm({ model: 'ollama/qwen3:8b' });
  for (const provider of ['ollama', 'moonshot']) {
    const request = twoTurns('ollama/qwen3:8b');
    for (const c of request.contents) for (const p of (c.parts ?? []) as any[]) if (p.providerState) p.providerState.provider = provider;
    const body = await bodyFor(ollama(), request);
    assert.ok(!JSON.stringify(body).includes('reasoning_content'), `${provider} state reached Ollama's wire`);
  }
  await withMoonshot([callScout], async () => {
    const out: LlmResponse[] = [];
    for await (const r of ollama().generateContentAsync(twoTurns('ollama/qwen3:8b'), false)) out.push(r);
    const final = out.find((r) => !r.partial)!;
    assert.ok(final.content?.parts?.every((p: any) => p.providerState === undefined), 'Ollama wrote reasoning state');
    assert.ok(out.some((r) => r.partial && (r.content?.parts?.[0] as any)?.thought), 'the scratchpad is still displayed');
  });
});

test('the gateway serving kimi-k3 sends none and writes none, though its provider id is moonshot', async () => {
  await withEnv(GATEWAY_ENV, async () => {
    const body = await bodyFor(new GatewayLlm({ model: 'kimi-k3' }), twoTurns('kimi-k3'));
    assert.equal(body.model, 'moonshotai/kimi-k3');
    assert.ok(!JSON.stringify(body).includes('reasoning_content'));
    await withMoonshot([callScout], async () => {
      const out: LlmResponse[] = [];
      for await (const r of new GatewayLlm({ model: 'kimi-k3' }).generateContentAsync(twoTurns('kimi-k3'), false)) out.push(r);
      const final = out.find((r) => !r.partial)!;
      assert.ok(final.content?.parts?.length, JSON.stringify(final));
      assert.ok(final.content!.parts!.every((p: any) => p.providerState === undefined), 'the gateway wrote reasoning state');
    });
  });
});

test('the ids Moonshot documents as wanting reasoning_content back opt in, and only those', () => {
  for (const id of ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed']) assert.ok(wantsReasoningReplay(id), id);
  for (const id of ['kimi-k2-turbo-preview', 'kimi-k2.5', 'kimi-latest']) assert.ok(!wantsReasoningReplay(id), id);
});

test('with no user content opening the turn, every assistant message is in it', async () => {
  const request = twoTurns('kimi-k3');
  request.contents = request.contents.slice(5); // [model(text + call), result, model(call), result]
  const messages = assistants(await bodyFor(kimi('kimi-k3'), request));
  assert.deepEqual(messages.map((m) => m.reasoning_content ?? null), ['step one', 'step two']);
});

test('only the reasoning_content field is carried: <think> blocks and a `reasoning` field are not', async () => {
  for (const reply of [
    { content: '<think>scratch</think>It is in the attic.' },
    { content: 'It is in the attic.', reasoning: 'scratch' },
  ]) {
    await withMoonshot([reply], async () => {
      const out: LlmResponse[] = [];
      for await (const r of kimi().generateContentAsync(twoTurns('kimi-k3'), false)) out.push(r);
      const final = out.find((r) => !r.partial)!;
      assert.deepEqual(final.content?.parts, [{ text: 'It is in the attic.' }], JSON.stringify(reply));
      assert.ok(out.some((r) => r.partial && (r.content?.parts?.[0] as any)?.thought), 'the scratchpad is still displayed');
    });
  }
});

test('kimi-k2.6 writes and replays its own, like K3', async () => {
  const messages = assistants(await bodyFor(kimi('kimi-k2.6'), twoTurns('kimi-k2.6')));
  assert.deepEqual(messages.map((m) => m.reasoning_content ?? null), [null, null, 'step one', 'step two']);
});
