/**
 * tests/kimiReasoningState.test.ts — Kimi's reasoning_content carried across
 * the steps of a tool loop (replaysReasoningContent in
 * lib/models/chatCompletionsAdapter.ts, KimiAdapter in lib/models/kimiAdapter.ts,
 * ADR 0046).
 *
 * Offline: the chat-completions adapters talk to a fetch stub that answers in
 * Moonshot's wire format (JSON and SSE), and the subagent is scripted. Keys
 * are fixtures.
 *
 * What is proved here:
 *   - through runSyndicateTurn on the native loop, on both the streamed and
 *     the non-streamed path, KimiAdapter writes the response's
 *     reasoning_content as providerState on the part that followed it, and
 *     the second request of the tool loop sends it back on the assistant
 *     message that holds the call;
 *   - only ids Moonshot documents as wanting it opt in;
 *   - Ollama neither writes nor sends it;
 *   - a model switch between steps drops it.
 * The request-body rules per message (which turn, which provider and model,
 * <think> blocks and the `reasoning` field, the gateway) are
 * tests/chatCompletionsAdapter.test.ts's.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { KimiAdapter, wantsReasoningReplay } from '../lib/models/kimiAdapter.ts';
import { OllamaAdapter } from '../lib/models/ollamaAdapter.ts';
import { REASONING_CONTENT_KIND } from '../lib/models/chatCompletionsAdapter.ts';
import { llmRequestToModelRequest } from '../lib/models/genaiMapping.ts';
import type { LlmRequest } from '../lib/models/genaiMapping.ts';
import { providerStateOf } from '../lib/models/providerState.ts';
import { ScriptedLlm, text } from './helpers/scriptedLlm.ts';

const APP = 'test-app';
const USER = 'u1';
const MOONSHOT_KEY = 'fixture-moonshot-0123456789abcdef'; // gitleaks:allow (test fixture)

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

// ── A syndicate whose boss is the adapter under test ─────────────────────────

const config: SyndicateYamlConfig = {
  syndicate_name: 'Test',
  orchestrator: { name: 'Boss', model: 'kimi-k3', instruction: 'Delegate to Scout.', generateContentConfig: { reasoningEffort: 'low' } },
  subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
} as SyndicateYamlConfig;

const scout = () => new ScriptedLlm('scripted/scout', () => text('in the attic'));
const kimi = (model = 'kimi-k3') => new KimiAdapter({ model, apiKey: MOONSHOT_KEY });

function turn(boss: ModelAdapter, sessionService = new InProcessSessionService(), streaming = false) {
  const subagent = scout();
  return runSyndicateTurn({
    config,
    parts: [{ text: 'find the thing' }],
    appName: APP,
    userId: USER,
    sessionId: 's1',
    sessionService,
    compile: { resolveModel: (id: string | undefined) => (id === 'scripted/scout' ? subagent : boss) },
    trace: false,
    streaming,
  });
}

/** The assistant messages of a chat-completions request body. */
const assistants = (body: any): any[] => (body.messages ?? []).filter((m: any) => m.role === 'assistant');

/** One model per step, in order: a model switch between steps, as a fallback makes one. */
class StepSwitch implements ModelAdapter {
  readonly model = 'scripted/switch';
  #calls = 0;
  #current: ModelAdapter;
  readonly #steps: ModelAdapter[];
  constructor(steps: ModelAdapter[]) {
    this.#steps = steps;
    this.#current = steps[0];
  }
  get provider(): string {
    return this.#current.provider;
  }
  generate(request: ModelRequest): AsyncIterable<ModelResponse> {
    this.#current = this.#steps[Math.min(this.#calls++, this.#steps.length - 1)];
    return this.#current.generate({ ...request, model: this.#current.model });
  }
}

// ── Through runSyndicateTurn on the native loop ──────────────────────────────

for (const streaming of [false, true]) {
  test(`native turn, kimi-k3 (${streaming ? 'SSE' : 'JSON'}): the second request of the tool loop sends reasoning_content back on the call's assistant message`, async () => {
    const sessions = new InProcessSessionService();
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
      const s = await sessions.get({ appName: APP, userId: USER, sessionId: 's1' });
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

test('native turn: a model switch between steps drops it: kimi-k3 then kimi-k2.6', async () => {
  await withMoonshot([callScout, answer], async (sent) => {
    const r = await turn(new StepSwitch([kimi('kimi-k3'), kimi('kimi-k2.6')]));
    assert.equal(r.status, 'completed', JSON.stringify(r.error));
    assert.equal(sent[1].model, 'kimi-k2.6');
    const [call] = assistants(sent[1]);
    assert.ok(call.tool_calls?.length, 'the call is still in the history');
    assert.equal(call.reasoning_content, undefined);
    assert.ok(!JSON.stringify(sent[1]).includes(REASONING_1));
  });
});

test('native turn: a provider switch drops it: kimi-k3 then Ollama', async () => {
  await withMoonshot([callScout, answer], async (sent) => {
    const r = await turn(new StepSwitch([kimi('kimi-k3'), new OllamaAdapter({ model: 'ollama/qwen3:8b' })]));
    assert.equal(r.status, 'completed', JSON.stringify(r.error));
    assert.equal(sent[1].model, 'qwen3:8b');
    assert.ok(!JSON.stringify(sent[1]).includes(REASONING_1));
  });
});

// ── The request a turn's history produces ────────────────────────────────────

const state = (payload: string, model = 'kimi-k3', provider = 'moonshot') => ({ provider, kind: REASONING_CONTENT_KIND, model, payload });

/** Two turns: the first a finished tool loop, the second mid-loop with two steps. */
function twoTurns(model: string): ModelRequest {
  return llmRequestToModelRequest({
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
  } as unknown as LlmRequest);
}

/** Every response an adapter yields for `request`. */
async function collect(adapter: ModelAdapter, request: ModelRequest): Promise<ModelResponse[]> {
  const out: ModelResponse[] = [];
  for await (const r of adapter.generate(request)) out.push(r);
  return out;
}

test('Ollama sends none and writes none', async () => {
  const ollama = () => new OllamaAdapter({ model: 'ollama/qwen3:8b' });
  for (const provider of ['ollama', 'moonshot']) {
    const request = twoTurns('ollama/qwen3:8b');
    for (const m of request.messages) for (const p of m.parts as any[]) if (p.providerState) p.providerState.provider = provider;
    const body = await withMoonshot([], async (sent) => {
      await collect(ollama(), request); // the 400 surfaces as an error final
      assert.equal(sent.length, 1);
      return sent[0];
    });
    assert.ok(body.messages.some((m: any) => m.tool_calls), 'the history reached the wire');
    assert.ok(!JSON.stringify(body).includes('reasoning_content'), `${provider} state reached Ollama's wire`);
  }
  await withMoonshot([callScout], async () => {
    const out = await collect(ollama(), twoTurns('ollama/qwen3:8b'));
    const final = out.find((r) => !r.partial)!;
    assert.ok(final.parts.length > 0, JSON.stringify(final));
    assert.ok(final.parts.every((p) => p.providerState === undefined), 'Ollama wrote reasoning state');
    assert.ok(out.some((r) => r.partial && r.parts[0]?.type === 'thinking'), 'the scratchpad is still displayed');
  });
});

test('the ids Moonshot documents as wanting reasoning_content back opt in, and only those', () => {
  for (const id of ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed']) assert.ok(wantsReasoningReplay(id), id);
  for (const id of ['kimi-k2-turbo-preview', 'kimi-k2.5', 'kimi-latest']) assert.ok(!wantsReasoningReplay(id), id);
});
