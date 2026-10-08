/**
 * tests/responsesReasoningState.test.ts — GPT and Grok (the Responses API
 * adapters) carry their reasoning across the steps of a tool loop
 * (lib/models/gptAdapter.ts, lib/models/grokAdapter.ts, ADR 0046).
 *
 * Offline: the adapters talk to a fetch stub that answers in the Responses
 * API's own wire format (JSON, or SSE when the request streams), so the real
 * openai SDK parses real-shaped responses. Keys are fixtures.
 *
 * What is proved here:
 *   - through runSyndicateTurn on the native loop, the reasoning item a step
 *     returned rides on its function call and goes back verbatim,
 *     immediately before that function_call, on the next request of the
 *     loop (streamed and not);
 *   - a model switch between steps drops it, within a provider and across;
 *   - a non-reasoning id neither replays nor writes it, and a run of
 *     reasoning that a server-side tool call followed is not carried;
 *   - the shared turn-start rule (currentTurnStart), including -1 when no
 *     user content opens the turn, as GPT's and Kimi's requests show it.
 * What a request asks for (store: false, encrypted reasoning), the replay's
 * placement and scope, and the guarded 400 retry are
 * tests/responsesAdapter.test.ts's.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { Message, ModelAdapter, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { GptAdapter, REASONING_STATE_KIND } from '../lib/models/gptAdapter.ts';
import { GrokAdapter } from '../lib/models/grokAdapter.ts';
import { KimiAdapter } from '../lib/models/kimiAdapter.ts';
import { REASONING_CONTENT_KIND } from '../lib/models/chatCompletionsAdapter.ts';
import { currentTurnStart } from '../lib/models/providerState.ts';
import type { ProviderState } from '../lib/models/providerState.ts';
import { ScriptedLlm, text } from './helpers/scriptedLlm.ts';

const APP = 'test-app';
const USER = 'u1';
const OPENAI_KEY = 'fixture-openai-0123456789abcdef'; // gitleaks:allow (test fixture)
const XAI_KEY = 'fixture-xai-0123456789abcdef'; // gitleaks:allow (test fixture)
const MOONSHOT_KEY = 'fixture-moonshot-0123456789abcdef'; // gitleaks:allow (test fixture)
const INCLUDE = ['reasoning.encrypted_content'];

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A reasoning output item exactly as the Responses API returns it with the encrypted content included. */
function reasoningItem(n: number) {
  return {
    id: `rs_fixture_${n}`,
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: `Scout knows where it is (${n}).` }],
    encrypted_content: `enc-fixture-${n}`,
  };
}

const R1 = reasoningItem(1);

function functionCall(callId: string, args: Record<string, unknown> = { request: 'look in the attic' }) {
  return { id: `fc_${callId}`, type: 'function_call', status: 'completed', call_id: callId, name: 'Scout', arguments: JSON.stringify(args) };
}

function outputMessage(t: string) {
  return { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: t, annotations: [] }] };
}

/** A Responses API reply. */
function responseOf(output: unknown[], model = 'gpt-5-mini') {
  return {
    id: `resp_${Math.random().toString(36).slice(2, 8)}`,
    object: 'response',
    created_at: 0,
    model,
    status: 'completed',
    output,
    usage: { input_tokens: 12, output_tokens: 7, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 19 },
  };
}

/** The same reply as the Responses API streams it: summary and text deltas, then response.completed. */
function sse(reply: ReturnType<typeof responseOf>): string {
  const events: any[] = [{ type: 'response.created', response: { ...reply, status: 'in_progress', output: [] } }];
  for (const item of reply.output as any[]) {
    for (const s of item.type === 'reasoning' ? item.summary : []) events.push({ type: 'response.reasoning_summary_text.delta', delta: s.text });
    for (const c of item.type === 'message' ? item.content : []) events.push({ type: 'response.output_text.delta', delta: c.text });
  }
  events.push({ type: 'response.completed', response: reply });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/**
 * Replaces fetch for the test body: every Responses call (OpenAI's or xAI's)
 * takes the next scripted reply, as SSE when the request streams; a `400`
 * entry answers with a 400, and an exhausted script answers 400 too.
 */
async function withResponses<T>(
  replies: Array<ReturnType<typeof responseOf> | 400>,
  body: (sent: Array<{ host: string; body: any }>) => Promise<T>,
): Promise<T> {
  const sent: Array<{ host: string; body: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    sent.push({ host: url.host, body: parsed });
    const reply = replies.shift();
    if (reply === undefined || reply === 400) {
      return new Response('{"error":{"message":"captured","type":"invalid_request_error"}}', { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return parsed?.stream
      ? new Response(sse(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return await body(sent);
  } finally {
    globalThis.fetch = original;
  }
}

const gpt = (model = 'gpt-5-mini') => new GptAdapter({ model, apiKey: OPENAI_KEY });
const grok = (model = 'grok-4.7') => new GrokAdapter({ model, apiKey: XAI_KEY });

function delegateConfig(bossModel: string): SyndicateYamlConfig {
  return {
    syndicate_name: 'Test',
    orchestrator: { name: 'Boss', model: bossModel, instruction: 'Delegate to Scout.', reasoning: 'low' },
    subagents: [{ name: 'Scout', model: 'scout', instruction: 'Answer.', description: 'Finds things' }],
  } as SyndicateYamlConfig;
}

function turn(boss: ModelAdapter, sessions = new InProcessSessionService(), streaming = false) {
  const subagent = scout();
  return runSyndicateTurn({
    config: delegateConfig(boss.model),
    parts: [{ text: 'find the thing' }],
    appName: APP,
    userId: USER,
    sessionId: 's1',
    sessionService: sessions,
    compile: { resolveModel: (id: string | undefined) => (id === 'scout' ? subagent : boss) },
    trace: false,
    streaming,
  });
}

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

const scout = () => new ScriptedLlm('scout', () => text('it is in the attic'));

/** The index of the function_call item for `callId` in a request's input. */
const callIndex = (input: any[], callId: string) => input.findIndex((i) => i.type === 'function_call' && i.call_id === callId);

/** Every response an adapter yields for `request`. */
async function collect(adapter: ModelAdapter, request: ModelRequest): Promise<ModelResponse[]> {
  const out: ModelResponse[] = [];
  for await (const r of adapter.generate(request)) out.push(r);
  return out;
}

const finalOf = (out: ModelResponse[]) => {
  const final = out.find((r) => !r.partial);
  assert.ok(final && !final.partial, 'a final');
  return final;
};

// ── The tool loop through runSyndicateTurn on the native loop ────────────────

for (const streaming of [false, true]) {
  test(`native turn, gpt (${streaming ? 'streamed' : 'non-streamed'}): the second request carries the reasoning item immediately before its function_call`, async () => {
    const sessions = new InProcessSessionService();
    await withResponses(
      [responseOf([R1, functionCall('call_1')]), responseOf([outputMessage('Scout says: it is in the attic')])],
      async (sent) => {
        const r = await turn(gpt(), sessions, streaming);
        assert.equal(r.status, 'completed', JSON.stringify(r.error));
        assert.equal(r.text, 'Scout says: it is in the attic');

        assert.equal(sent.length, 2);
        assert.ok(sent.every((s) => s.host === 'api.openai.com'));
        const [first, second] = sent.map((s) => s.body);
        assert.equal(second.stream === true, streaming);
        for (const body of [first, second]) {
          assert.strictEqual(body.store, false);
          assert.deepStrictEqual(body.include, INCLUDE);
        }
        assert.ok(!first.input.some((i: any) => i.type === 'reasoning'), 'nothing to replay on the first step');

        // Verbatim, immediately before the call it preceded, then the result.
        const at = callIndex(second.input, 'call_1');
        assert.ok(at > 0, 'the call is replayed');
        assert.deepStrictEqual(second.input[at - 1], R1);
        assert.equal(second.input[at + 1].type, 'function_call_output');
        assert.equal(second.input[at + 1].call_id, 'call_1');
        assert.equal(second.input.filter((i: any) => i.type === 'reasoning').length, 1);
        assert.ok(!JSON.stringify(second.input).includes('providerState'));

        // Stored with the event, on the call part.
        const session = await sessions.get({ appName: APP, userId: USER, sessionId: 's1' });
        const stored = (session?.events ?? []).flatMap((e) => e.content?.parts ?? []).find((p: any) => p.functionCall?.name === 'Scout') as any;
        assert.deepStrictEqual(stored.providerState, { provider: 'openai', kind: REASONING_STATE_KIND, model: 'gpt-5-mini', payload: [R1] });
      },
    );
  });
}

test('native turn, grok: the same loop replays under the xai provider id', async () => {
  const sessions = new InProcessSessionService();
  await withResponses(
    [responseOf([R1, functionCall('call_1')], 'grok-4.7'), responseOf([outputMessage('Scout says: it is in the attic')], 'grok-4.7')],
    async (sent) => {
      const r = await turn(grok('grok-4.7'), sessions);
      assert.equal(r.status, 'completed', JSON.stringify(r.error));
      assert.ok(sent.every((s) => s.host === 'api.x.ai'));
      const second = sent[1].body;
      assert.strictEqual(second.store, false);
      assert.deepStrictEqual(second.include, INCLUDE);
      assert.deepStrictEqual(second.input[callIndex(second.input, 'call_1') - 1], R1);
      const session = await sessions.get({ appName: APP, userId: USER, sessionId: 's1' });
      const stored = (session?.events ?? []).flatMap((e) => e.content?.parts ?? []).find((p: any) => p.functionCall) as any;
      assert.equal(stored.providerState.provider, 'xai');
      assert.equal(stored.providerState.model, 'grok-4.7');
    },
  );
});

// ── A model switch between steps drops the state ─────────────────────────────

test('native turn, model switch: another GPT model, or Grok, gets the call without the reasoning item', async () => {
  for (const [label, next, host] of [
    ['gpt-5-mini → gpt-5', gpt('gpt-5'), 'api.openai.com'],
    ['gpt-5-mini → grok-4.7', grok('grok-4.7'), 'api.x.ai'],
  ] as const) {
    await withResponses(
      [responseOf([R1, functionCall('call_1')]), responseOf([outputMessage('Scout says: it is in the attic')])],
      async (sent) => {
        const r = await turn(new StepSwitch([gpt('gpt-5-mini'), next]));
        assert.equal(r.status, 'completed', `${label}: ${JSON.stringify(r.error)}`);
        assert.equal(sent[0].host, 'api.openai.com', label);
        assert.equal(sent[1].host, host, label);
        const second = sent[1].body;
        assert.ok(callIndex(second.input, 'call_1') >= 0, `${label}: the call itself is replayed`);
        assert.ok(!second.input.some((i: any) => i.type === 'reasoning'), `${label}: reasoning item replayed`);
        assert.ok(!JSON.stringify(second).includes('enc-fixture-1'), `${label}: encrypted content leaked`);
        // The next model still asks for its own reasoning, statelessly.
        assert.strictEqual(second.store, false, label);
      },
    );
  }
});

test('a non-reasoning id neither replays nor writes reasoning state', async () => {
  // Another model's state in the history is ignored, and a reasoning item
  // in a gpt-4o reply (it should not return one) is not carried.
  const state: ProviderState = { provider: 'openai', kind: REASONING_STATE_KIND, model: 'gpt-4o', payload: [R1] };
  await withResponses([responseOf([reasoningItem(2), outputMessage('done')], 'gpt-4o')], async (sent) => {
    const out = await collect(gpt('gpt-4o'), {
      model: 'gpt-4o',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'find it' }] },
        { role: 'assistant', parts: [{ type: 'toolCall', id: 'call_1', name: 'Scout', args: {}, providerState: state }] },
        { role: 'tool', parts: [{ type: 'toolResult', id: 'call_1', name: 'Scout', result: 'found' }] },
      ],
    });
    assert.ok(callIndex(sent[0].body.input, 'call_1') >= 0, 'the call is sent');
    assert.ok(!sent[0].body.input.some((i: any) => i.type === 'reasoning'));
    const final = finalOf(out);
    assert.ok(final.parts.length > 0, JSON.stringify(final));
    assert.ok(final.parts.every((p) => p.providerState === undefined));
  });
});

// ── Writing the state ────────────────────────────────────────────────────────

test('each run rides on the part right after it; a run a server-side tool call followed is dropped', async () => {
  const R2 = reasoningItem(2);
  // A searched step: reasoning, a server-side search, narration, more
  // reasoning, then a client tool call (the live grok-4.7 shape, ADR 0046).
  const output = [
    R1,
    { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'attic' } },
    outputMessage('Searching done.'),
    R2,
    functionCall('call_1'),
  ];
  await withResponses([responseOf(output, 'grok-4.7')], async () => {
    const out = await collect(grok('grok-4.7'), { model: 'grok-4.7', messages: [{ role: 'user', parts: [{ type: 'text', text: 'find it' }] }] });
    const parts = finalOf(out).parts as any[];
    assert.equal(parts[0].text, 'Searching done.');
    assert.ok(!parts[0].providerState, 'the run before the search is not carried');
    assert.deepStrictEqual(parts[1].providerState, { provider: 'xai', kind: REASONING_STATE_KIND, model: 'grok-4.7', payload: [R2] });
    // The summary still surfaces as display-only thinking.
    assert.ok(out.some((r) => r.partial && r.parts[0]?.type === 'thinking'));
  });
});

// ── The shared turn-start rule ───────────────────────────────────────────────

test('currentTurnStart: the last user content that is not purely tool results', () => {
  const fr = (id: string) => ({ functionResponse: { id, name: 'Scout', response: { result: 'found' } } });
  const u = (t: string) => ({ role: 'user', parts: [{ text: t }] });
  const m = { role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] };
  const r = { role: 'user', parts: [{ functionResponse: { name: 'f', response: {} } }] };
  // No user content opens the turn: -1, so every content is this turn's.
  assert.equal(currentTurnStart([]), -1);
  assert.equal(currentTurnStart([m, r]), -1);
  assert.equal(currentTurnStart([u('a'), m, r]), 0);
  assert.equal(currentTurnStart([u('a'), m, r, u('b'), m, r]), 3);
  // A user content mixing a tool result with text starts a turn.
  assert.equal(currentTurnStart([u('a'), m, { role: 'user', parts: [fr('x'), { text: 'and also' }] }, m, r]), 2);
  // An empty user content does not.
  assert.equal(currentTurnStart([u('a'), m, { role: 'user', parts: [] }]), 0);
});

test('currentTurnStart -1 on the wire: with no user content opening the turn, GPT and Kimi replay the first model content', async () => {
  const loop = (model: string, state: ProviderState): ModelRequest => ({
    model,
    messages: [
      { role: 'assistant', parts: [{ type: 'toolCall', id: 'c1', name: 'Scout', args: {}, providerState: state }] },
      { role: 'tool', parts: [{ type: 'toolResult', id: 'c1', name: 'Scout', result: 'x' }] },
    ] satisfies Message[],
  });
  const firstBody = (adapter: ModelAdapter, request: ModelRequest) =>
    withResponses([], async (sent) => {
      await collect(adapter, request); // the 400 surfaces as an error final
      return sent[0].body;
    });

  const gptBody = await firstBody(gpt(), loop('gpt-5-mini', { provider: 'openai', kind: REASONING_STATE_KIND, model: 'gpt-5-mini', payload: [R1] }));
  assert.deepStrictEqual(gptBody.input[callIndex(gptBody.input, 'c1') - 1], R1);

  const kimi = new KimiAdapter({ model: 'kimi-k3', apiKey: MOONSHOT_KEY });
  const kimiBody = await firstBody(kimi, loop('kimi-k3', { provider: 'moonshot', kind: REASONING_CONTENT_KIND, model: 'kimi-k3', payload: 'step one' }));
  const assistant = kimiBody.messages.find((m: any) => m.role === 'assistant');
  assert.equal(assistant.reasoning_content, 'step one');
  assert.equal(assistant.tool_calls?.[0]?.id, 'c1');
});
