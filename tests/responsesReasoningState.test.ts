/**
 * tests/responsesReasoningState.test.ts — GPT and Grok (the Responses API
 * adapters) carry their reasoning across the steps of a tool loop
 * (lib/models/gptLlm.ts, lib/models/grokLlm.ts, ADR 0046).
 *
 * Offline: the adapters talk to a fetch stub that answers in the Responses
 * API's own wire format (JSON, or SSE when the request streams), so the real
 * openai SDK parses real-shaped responses. Keys are fixtures.
 *
 * What is proved here:
 *   - reasoning ids send `store: false` and ask for encrypted reasoning;
 *     other ids send neither;
 *   - through a REAL ADK Runner, the reasoning item a step returned rides on
 *     its function call and goes back verbatim, immediately before that
 *     function_call, on the next request of the loop (streamed and not);
 *   - a model switch between steps drops it, within a provider and across;
 *   - only the current turn's tool loop replays, and a run of reasoning that
 *     a server-side tool call followed is not carried;
 *   - the guarded 400 retry drops the reasoning additions and keeps
 *     `store: false`;
 *   - the shared turn-start rule (currentTurnStart), including -1 when no
 *     user content opens the turn, as GPT's and Kimi's requests show it.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { BaseLlm, InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { GptLlm, REASONING_STATE_KIND, buildResponsesInput } from '../lib/models/gptLlm.ts';
import { GrokLlm } from '../lib/models/grokLlm.ts';
import { KimiLlm } from '../lib/models/kimiLlm.ts';
import { REASONING_CONTENT_KIND } from '../lib/models/openAiCompatibleLlm.ts';
import { currentTurnStart, withProviderState } from '../lib/models/providerState.ts';
import type { ProviderState } from '../lib/models/providerState.ts';
import { ScriptedLlm, text } from './helpers/scriptedLlm.ts';
import { assertRefusesModelClass, forEachRuntime } from './helpers/runtime.ts';

setLogLevel(LogLevel.ERROR);

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

const gpt = (model = 'gpt-5-mini') => new GptLlm({ model, apiKey: OPENAI_KEY });
const grok = (model = 'grok-4.7') => new GrokLlm({ model, apiKey: XAI_KEY });

function delegateConfig(): SyndicateYamlConfig {
  return {
    syndicate_name: 'Test',
    orchestrator: { name: 'Boss', model: 'boss', instruction: 'Delegate to Scout.', reasoning: 'low' },
    subagents: [{ name: 'Scout', model: 'scout', instruction: 'Answer.', description: 'Finds things' }],
  } as SyndicateYamlConfig;
}

function turn(models: Record<string, BaseLlm>, sessions = new InMemorySessionService(), streaming = false) {
  return runSyndicateTurn({
    config: delegateConfig(),
    parts: [{ text: 'find the thing' }],
    appName: APP,
    userId: USER,
    sessionId: 's1',
    sessionService: sessions,
    compile: {
      resolveModel: (id: string | undefined) => {
        const m = models[id ?? ''];
        if (!m) throw new Error(`no model '${id}'`);
        return m;
      },
    },
    trace: false,
    streaming,
  });
}

/**
 * A resolver that returns an ADK model class which is neither the shim nor
 * Gemini (StepSwitch here) is refused on native before any model call
 * (ADR 0088): these cases run on ADK, and on native assert the refusal.
 */
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

const scout = () => new ScriptedLlm('scout', () => text('it is in the attic'));

/** The index of the function_call item for `callId` in a request's input. */
const callIndex = (input: any[], callId: string) => input.findIndex((i) => i.type === 'function_call' && i.call_id === callId);

// ── What a request asks for ──────────────────────────────────────────────────

test('store: false and encrypted reasoning are sent for reasoning ids, and neither for other ids', async () => {
  const bodyOf = async (llm: GptLlm) =>
    withResponses([400, 400], async (sent) => {
      const req = { model: llm.model, contents: [{ role: 'user', parts: [{ text: 'hello' }] }], toolsDict: {}, config: {}, liveConnectConfig: {} };
      for await (const _ of llm.generateContentAsync(req as unknown as LlmRequest, false)) {
        // drain; the 400 surfaces as an error response
      }
      return sent[0].body;
    });

  for (const llm of [gpt('gpt-5-mini'), gpt('gpt-5.1'), gpt('o4-mini'), grok('grok-4.5'), grok('grok-4.7')]) {
    const body = await bodyOf(llm);
    assert.strictEqual(body.store, false, `${llm.model}: store`);
    assert.deepStrictEqual(body.include, INCLUDE, `${llm.model}: include`);
    assert.ok(body.reasoning, `${llm.model}: the reasoning param stays`);
  }
  for (const llm of [gpt('gpt-4o'), gpt('gpt-4.1-mini'), grok('grok-4-1-fast-reasoning'), grok('grok-3')]) {
    const body = await bodyOf(llm);
    assert.ok(!('store' in body), `${llm.model} sent store`);
    assert.ok(!('include' in body), `${llm.model} sent include`);
  }
});

// ── The tool loop through a real ADK Runner ──────────────────────────────────

for (const streaming of [false, true]) {
  test(`gpt (${streaming ? 'streamed' : 'non-streamed'}): the second request carries the reasoning item immediately before its function_call`, async () => {
    const sessions = new InMemorySessionService();
    await withResponses(
      [responseOf([R1, functionCall('call_1')]), responseOf([outputMessage('Scout says: it is in the attic')])],
      async (sent) => {
        const r = await turn({ boss: gpt(), scout: scout() }, sessions, streaming);
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
        const session = await sessions.getSession({ appName: APP, userId: USER, sessionId: 's1' });
        const stored = (session?.events ?? []).flatMap((e) => e.content?.parts ?? []).find((p: any) => p.functionCall?.name === 'Scout') as any;
        assert.deepStrictEqual(stored.providerState, { provider: 'openai', kind: REASONING_STATE_KIND, model: 'gpt-5-mini', payload: [R1] });
      },
    );
  });
}

test('grok: the same loop replays under the xai provider id', async () => {
  const sessions = new InMemorySessionService();
  await withResponses(
    [responseOf([R1, functionCall('call_1')], 'grok-4.7'), responseOf([outputMessage('Scout says: it is in the attic')], 'grok-4.7')],
    async (sent) => {
      const r = await turn({ boss: grok('grok-4.7'), scout: scout() }, sessions);
      assert.equal(r.status, 'completed', JSON.stringify(r.error));
      assert.ok(sent.every((s) => s.host === 'api.x.ai'));
      const second = sent[1].body;
      assert.strictEqual(second.store, false);
      assert.deepStrictEqual(second.include, INCLUDE);
      assert.deepStrictEqual(second.input[callIndex(second.input, 'call_1') - 1], R1);
      const session = await sessions.getSession({ appName: APP, userId: USER, sessionId: 's1' });
      const stored = (session?.events ?? []).flatMap((e) => e.content?.parts ?? []).find((p: any) => p.functionCall) as any;
      assert.equal(stored.providerState.provider, 'xai');
      assert.equal(stored.providerState.model, 'grok-4.7');
    },
  );
});

// ── A model switch between steps drops the state ─────────────────────────────

forEachRuntime('model switch: another GPT model, or Grok, gets the call without the reasoning item', async (runtime) => {
  for (const [label, next, host] of [
    ['gpt-5-mini → gpt-5', gpt('gpt-5'), 'api.openai.com'],
    ['gpt-5-mini → grok-4.7', grok('grok-4.7'), 'api.x.ai'],
  ] as const) {
    await withResponses(
      [responseOf([R1, functionCall('call_1')]), responseOf([outputMessage('Scout says: it is in the attic')])],
      async (sent) => {
        const boss = new StepSwitch([gpt('gpt-5-mini'), next]);
        if (runtime === 'native') {
          await assertRefusesModelClass(turn({ boss, scout: scout() }), 'StepSwitch');
          assert.equal(sent.length, 0, `${label}: no model was called`);
          return;
        }
        const r = await turn({ boss, scout: scout() });
        assert.equal(r.status, 'completed', `${label}: ${JSON.stringify(r.error)}`);
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
  // Another provider's state in the history is ignored, and a reasoning item
  // in a gpt-4o reply (it should not return one) is not carried.
  const state: ProviderState = { provider: 'openai', kind: REASONING_STATE_KIND, model: 'gpt-4o', payload: [R1] };
  await withResponses([responseOf([reasoningItem(2), outputMessage('done')], 'gpt-4o')], async (sent) => {
    const req = {
      model: 'gpt-4o',
      contents: [
        { role: 'user', parts: [{ text: 'find it' }] },
        { role: 'model', parts: [withProviderState({ functionCall: { id: 'call_1', name: 'Scout', args: {} } }, state)] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'Scout', response: { result: 'found' } } }] },
      ],
      toolsDict: {},
      config: {},
      liveConnectConfig: {},
    } as unknown as LlmRequest;
    const out: LlmResponse[] = [];
    for await (const r of gpt('gpt-4o').generateContentAsync(req, false)) out.push(r);
    assert.ok(!sent[0].body.input.some((i: any) => i.type === 'reasoning'));
    const final = out.find((r) => r.turnComplete)!;
    assert.ok(!(final.content!.parts![0] as any).providerState);
  });
});

// ── Placement and scope ──────────────────────────────────────────────────────

const stateOf = (items: unknown[], model = 'gpt-5-mini'): ProviderState => ({ provider: 'openai', kind: REASONING_STATE_KIND, model, payload: items });
const fc = (id: string, items?: unknown[], model?: string) => {
  const part = { functionCall: { id, name: 'Scout', args: {} } };
  return items ? withProviderState(part, stateOf(items, model)) : part;
};
const fr = (id: string) => ({ functionResponse: { id, name: 'Scout', response: { result: 'found' } } });
/** The input items for `contents`, replaying as gpt-5-mini does; `null` builds without replay. */
const inputOf = (contents: unknown[], replay: { provider: string; model: string } | null = { provider: 'openai', model: 'gpt-5-mini' }) =>
  buildResponsesInput({ model: 'gpt-5-mini', contents, toolsDict: {}, config: {}, liveConnectConfig: {} } as unknown as LlmRequest, replay ?? undefined).input;

test('only the current turn\'s tool loop replays; earlier turns, other models and other providers do not', () => {
  const R0 = reasoningItem(0);
  const input = inputOf([
    { role: 'user', parts: [{ text: 'first question' }] },
    { role: 'model', parts: [fc('c0', [R0])] },
    { role: 'user', parts: [fr('c0')] },
    { role: 'model', parts: [withProviderState({ text: 'First answer.' }, stateOf([reasoningItem(9)]))] },
    { role: 'user', parts: [{ text: 'second question' }] },
    { role: 'model', parts: [fc('c1', [R1])] },
    { role: 'user', parts: [fr('c1')] },
    { role: 'model', parts: [fc('c2', [reasoningItem(2)], 'gpt-5')] },
    { role: 'user', parts: [fr('c2')] },
    { role: 'model', parts: [withProviderState(fc('c3'), { provider: 'xai', kind: REASONING_STATE_KIND, model: 'gpt-5-mini', payload: [reasoningItem(3)] })] },
    { role: 'user', parts: [fr('c3')] },
  ]);
  const reasoning = input.filter((i) => i.type === 'reasoning').map((i) => i.id);
  assert.deepStrictEqual(reasoning, ['rs_fixture_1'], 'only this turn, this model, this provider');
  assert.deepStrictEqual(input[callIndex(input, 'c1') - 1], R1);
  // Without `replay` nothing is sent back at all.
  assert.ok(!inputOf([{ role: 'user', parts: [{ text: 'q' }] }, { role: 'model', parts: [fc('c1', [R1])] }, { role: 'user', parts: [fr('c1')] }], null).some((i) => i.type === 'reasoning'));
});

test('a reasoning run before text keeps the model\'s order of message and call', () => {
  const R2 = reasoningItem(2);
  const input = inputOf([
    { role: 'user', parts: [{ text: 'find it' }] },
    { role: 'model', parts: [withProviderState({ text: 'Let me ask Scout.' }, stateOf([R1])), fc('c1', [R2])] },
    { role: 'user', parts: [fr('c1')] },
  ]);
  assert.deepStrictEqual(
    input.map((i) => i.type ?? i.role),
    ['user', 'reasoning', 'assistant', 'reasoning', 'function_call', 'function_call_output'],
  );
  assert.deepStrictEqual(input[1], R1);
  assert.equal(input[2].content[0].text, 'Let me ask Scout.');
  assert.deepStrictEqual(input[3], R2);
});

test('a reasoning item without encrypted content is not replayed (store: false keeps nothing to point at)', () => {
  const bare = { id: 'rs_bare', type: 'reasoning', summary: [] };
  const input = inputOf([
    { role: 'user', parts: [{ text: 'find it' }] },
    { role: 'model', parts: [fc('c1', [bare, R1])] },
    { role: 'user', parts: [fr('c1')] },
  ]);
  assert.deepStrictEqual(input.filter((i) => i.type === 'reasoning'), [R1]);
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
    const req = { model: 'grok-4.7', contents: [{ role: 'user', parts: [{ text: 'find it' }] }], toolsDict: {}, config: {}, liveConnectConfig: {} };
    const out: LlmResponse[] = [];
    for await (const r of grok('grok-4.7').generateContentAsync(req as unknown as LlmRequest, false)) out.push(r);
    const parts = out.find((r) => r.turnComplete)!.content!.parts as any[];
    assert.equal(parts[0].text, 'Searching done.');
    assert.ok(!parts[0].providerState, 'the run before the search is not carried');
    assert.deepStrictEqual(parts[1].providerState, { provider: 'xai', kind: REASONING_STATE_KIND, model: 'grok-4.7', payload: [R2] });
    // The summary still surfaces as display-only thinking.
    assert.ok(out.some((r) => r.partial && (r.content?.parts?.[0] as any)?.thought));
  });
});

// ── The guarded retry ────────────────────────────────────────────────────────

test('a 400 is retried once without the reasoning additions, and store: false stays', async () => {
  await withResponses([400, responseOf([outputMessage('done')])], async (sent) => {
    const req = {
      model: 'gpt-5-mini',
      contents: [
        { role: 'user', parts: [{ text: 'find it' }] },
        { role: 'model', parts: [fc('c1', [R1])] },
        { role: 'user', parts: [fr('c1')] },
      ],
      toolsDict: {},
      config: {},
      liveConnectConfig: {},
    } as unknown as LlmRequest;
    const out: LlmResponse[] = [];
    for await (const r of gpt().generateContentAsync(req, false)) out.push(r);
    assert.equal(sent.length, 2);
    assert.deepStrictEqual(sent[0].body.input[callIndex(sent[0].body.input, 'c1') - 1], R1);
    const retry = sent[1].body;
    assert.ok(!('reasoning' in retry) && !('include' in retry));
    assert.ok(!retry.input.some((i: any) => i.type === 'reasoning'));
    assert.ok(callIndex(retry.input, 'c1') >= 0, 'the call itself stays');
    assert.strictEqual(retry.store, false);
    assert.equal((out.find((r) => r.turnComplete)!.content!.parts![0] as any).text, 'done');
  });
});

// ── The shared turn-start rule ───────────────────────────────────────────────

test('currentTurnStart: the last user content that is not purely tool results', () => {
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
  const result = { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'Scout', response: { result: 'x' } } }] };
  const loop = (model: string, state: ProviderState) =>
    ({
      model,
      contents: [{ role: 'model', parts: [withProviderState({ functionCall: { id: 'c1', name: 'Scout', args: {} } }, state)] }, result],
      liveConnectConfig: {},
      toolsDict: {},
      config: {},
    }) as unknown as LlmRequest;
  const firstBody = (llm: BaseLlm, request: LlmRequest) =>
    withResponses([], async (sent) => {
      for await (const _ of llm.generateContentAsync(request, false)) {
        // drain; the 400 surfaces as an error response
      }
      return sent[0].body;
    });

  const gptBody = await firstBody(gpt(), loop('gpt-5-mini', { provider: 'openai', kind: REASONING_STATE_KIND, model: 'gpt-5-mini', payload: [R1] }));
  assert.deepStrictEqual(gptBody.input[callIndex(gptBody.input, 'c1') - 1], R1);

  const kimi = new KimiLlm({ model: 'kimi-k3', apiKey: MOONSHOT_KEY });
  const kimiBody = await firstBody(kimi, loop('kimi-k3', { provider: 'moonshot', kind: REASONING_CONTENT_KIND, model: 'kimi-k3', payload: 'step one' }));
  const assistant = kimiBody.messages.find((m: any) => m.role === 'assistant');
  assert.equal(assistant.reasoning_content, 'step one');
  assert.equal(assistant.tool_calls?.[0]?.id, 'c1');
});
