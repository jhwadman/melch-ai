/**
 * tests/reasoningState.test.ts — provider-opaque reasoning state from one
 * model step to the next (lib/models/providerState.ts, ADR 0046).
 *
 * Offline: models are scripted, and the Claude and chat-completions adapters
 * talk to a fetch stub that answers in the provider's own wire format, so the
 * real SDKs parse real-shaped responses (JSON and SSE). Keys are fixtures.
 *
 * What is proved here:
 *   - the field survives a REAL ADK Runner: from the model's event into the
 *     next LlmRequest.contents of the tool loop, and into storage (in memory,
 *     and the serialized rows of the Supabase and Postgres services);
 *   - Claude writes its signed thinking blocks into it on both the streamed
 *     and the non-streamed path, and the second request of a tool loop opens
 *     the assistant message with them, verbatim, before its tool_use;
 *   - a model switch between steps drops the state in both directions.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { BaseLlm, Gemini, InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';
import type { BaseLlmConnection, Event, LlmRequest, LlmResponse } from '@google/adk';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ClaudeLlm, THINKING_STATE_KIND } from '../lib/models/claudeLlm.ts';
import { GptLlm } from '../lib/models/gptLlm.ts';
import { KimiLlm } from '../lib/models/kimiLlm.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { providerStateOf, withProviderState } from '../lib/models/providerState.ts';
import type { ProviderState } from '../lib/models/providerState.ts';
import { projectTranscript, trimEventForStorage } from '../lib/session/transcript.ts';
import { SupabaseSessionService } from '../lib/session/supabaseSessionService.ts';
import { PostgresSessionService } from '../lib/storage/postgres/sessionService.ts';
import { ScriptedLlm, scriptedResolver, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const APP = 'test-app';
const USER = 'u1';
const FIXTURE_KEY = 'fixture-ant-test-0123456789abcdef'; // gitleaks:allow (test fixture)

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Signed blocks exactly as the Messages API returns them. */
const THINKING = { type: 'thinking', thinking: 'Scout knows where it is.', signature: 'sig-fixture-thinking-1' };
const REDACTED = { type: 'redacted_thinking', data: 'redacted-fixture-blob-1' };

/** The state a scripted model writes (any provider's shape will do here). */
const STATE: ProviderState = { provider: 'anthropic', kind: THINKING_STATE_KIND, payload: [THINKING] };

function delegateConfig(boss: { thinking?: boolean } = {}): SyndicateYamlConfig {
  return {
    syndicate_name: 'Test',
    orchestrator: {
      name: 'Boss',
      model: 'scripted/boss',
      instruction: 'Delegate to Scout.',
      ...(boss.thinking ? { generateContentConfig: { thinkingConfig: { thinkingBudget: 2048 } } } : {}),
    },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
  } as SyndicateYamlConfig;
}

function turn(config: SyndicateYamlConfig, models: Record<string, BaseLlm>, sessionService = new InMemorySessionService(), streaming = false) {
  return runSyndicateTurn({
    config,
    parts: [{ text: 'find the thing' }],
    appName: APP,
    userId: USER,
    sessionId: 's1',
    sessionService,
    compile: { resolveModel: scriptedResolver(models as any) },
    trace: false,
    streaming,
  });
}

/** Every part of the stored session's events. */
async function storedParts(sessions: InMemorySessionService): Promise<any[]> {
  const s = await sessions.getSession({ appName: APP, userId: USER, sessionId: 's1' });
  return (s?.events ?? []).flatMap((e) => e.content?.parts ?? []);
}

/** The model content that carries the Scout call, in a request the model received. */
function callContent(request: LlmRequest): any {
  return request.contents.find((c) => c.role === 'model' && (c.parts ?? []).some((p: any) => p.functionCall?.name === 'Scout'));
}

// ── A fetch stub that answers like the providers ─────────────────────────────

/** A Messages API reply. */
function message(content: unknown[], stop_reason = 'end_turn') {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7 },
  };
}

/** The same reply as the Messages API streams it. */
function sse(msg: ReturnType<typeof message>): string {
  const events: unknown[] = [{ type: 'message_start', message: { ...msg, content: [], stop_reason: null } }];
  msg.content.forEach((block: any, index) => {
    if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: block });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 7 } });
  events.push({ type: 'message_stop' });
  return events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** A chat-completions reply (Ollama, Kimi, gateways). */
function chatCompletion(content: string) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'qwen3:8b',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
  };
}

/**
 * Replaces fetch for the test body: Anthropic calls take the next scripted
 * Messages reply (as SSE when the request streams); every other call is a
 * chat completion saying `otherText`, or a 400 when `otherText` is absent.
 */
async function withProviders<T>(
  anthropicReplies: Array<ReturnType<typeof message>>,
  body: (sent: { anthropic: any[]; other: Array<{ url: string; body: any }> }) => Promise<T>,
  otherText?: string,
): Promise<T> {
  const sent = { anthropic: [] as any[], other: [] as Array<{ url: string; body: any }> };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    if (/anthropic/.test(url)) {
      sent.anthropic.push(parsed);
      const reply = anthropicReplies.shift();
      if (!reply) return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"no reply scripted"}}', { status: 400 });
      return parsed?.stream
        ? new Response(sse(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    sent.other.push({ url, body: parsed });
    return otherText === undefined
      ? new Response('{"error":{"message":"captured"}}', { status: 400, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify(chatCompletion(otherText)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return await body(sent);
  } finally {
    globalThis.fetch = original;
  }
}

const claude = () => new ClaudeLlm({ model: 'claude-sonnet-4-6', apiKey: FIXTURE_KEY });

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

// ── The convention through a real ADK Runner ─────────────────────────────────

test('convention: providerState on a functionCall part reaches the next request of the tool loop, and storage', async () => {
  const boss = new ScriptedLlm('scripted/boss', (_req, n) =>
    n === 1
      ? ({
          content: {
            role: 'model',
            parts: [withProviderState({ functionCall: { name: 'Scout', args: { request: 'look in the attic' }, id: 'call-scout-1' } }, STATE)],
          },
        } as LlmResponse)
      : text('Scout says: it is in the attic'),
  );
  const scout = new ScriptedLlm('scripted/scout', () => text('it is in the attic'));
  const sessions = new InMemorySessionService();

  const r = await turn(delegateConfig(), { boss, scout }, sessions);
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'Scout says: it is in the attic');

  // Into the next request: ADK copies event.content (deep clone) into contents.
  const second = callContent(boss.requests[1]);
  assert.ok(second, 'the second request replays the call');
  const callPart = second.parts.find((p: any) => p.functionCall);
  assert.deepEqual(callPart.providerState, STATE);

  // Into storage: the in-memory session, and the serialized copy both
  // durable services write (JSON, then the storage trim).
  const stored = (await storedParts(sessions)).find((p) => p.functionCall?.name === 'Scout');
  assert.deepEqual(stored.providerState, STATE);
  const event = (await sessions.getSession({ appName: APP, userId: USER, sessionId: 's1' }))!.events.find((e) =>
    (e.content?.parts ?? []).some((p: any) => p.functionCall?.name === 'Scout'),
  )!;
  const row = trimEventForStorage(JSON.parse(JSON.stringify(event)));
  assert.deepEqual((row.content!.parts![0] as any).providerState, STATE);
});

test('convention: the durable session services write the field into their rows', async () => {
  const event = {
    id: 'e1',
    invocationId: 'i1',
    author: 'Boss',
    timestamp: 1,
    actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {} },
    // A tool result big enough to be elided sits beside the state: the trim
    // replaces the payload and keeps the state.
    content: {
      role: 'model',
      parts: [
        withProviderState({ functionCall: { name: 'Scout', args: {}, id: 'c1' } }, STATE),
        { functionResponse: { name: 'Scout', id: 'c0', response: { result: 'x'.repeat(5_000) } } },
      ],
    },
  } as unknown as Event;

  // Supabase: the whole events array, upserted.
  let upserted: any;
  const supabase = { from: () => ({ upsert: async (row: any) => ((upserted = row), { error: null }) }) };
  const supa = new SupabaseSessionService(supabase as any);
  await supa.appendEvent({ session: { id: 's1', appName: APP, userId: USER, state: {}, events: [], lastUpdateTime: 0 } as any, event });
  assert.deepEqual(upserted.events[0].content.parts[0].providerState, STATE);
  assert.match(JSON.stringify(upserted.events[0].content.parts[1]), /elided/);

  // Postgres: one row per event, as jsonb text.
  let inserted: any;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      // The append itself (the legacy import inserts with one parameter).
      if (sql.includes('INSERT INTO adk_session_events') && params.length === 3) inserted = JSON.parse(params[2] as string);
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined,
  };
  const pg = new PostgresSessionService({ connect: async () => client } as any);
  await pg.appendEvent({ session: { id: 's1', appName: APP, userId: USER, state: {}, events: [], lastUpdateTime: 0 } as any, event });
  assert.deepEqual(inserted.content.parts[0].providerState, STATE);
});

test('convention: the transcript projection drops the state with the rest of a past turn', () => {
  const events = [
    { author: 'user', content: { role: 'user', parts: [{ text: 'find it' }] } },
    { author: 'Boss', content: { role: 'model', parts: [withProviderState({ text: 'It is in the attic.' }, STATE)] } },
  ] as Event[];
  const projected = projectTranscript(events, 'Boss');
  assert.equal(projected.length, 2);
  assert.deepEqual(projected[1].content!.parts, [{ text: 'It is in the attic.' }]);
});

test('providerStateOf reads only the named provider, kind and (when both name one) model', () => {
  const part = withProviderState({ text: 'x' }, STATE);
  assert.deepEqual(providerStateOf(part, 'anthropic', THINKING_STATE_KIND), STATE);
  const bound = withProviderState({ text: 'x' }, { ...STATE, model: 'claude-opus-4-6' });
  assert.ok(providerStateOf(bound, 'anthropic', THINKING_STATE_KIND, 'claude-opus-4-6'));
  assert.equal(providerStateOf(bound, 'anthropic', THINKING_STATE_KIND, 'claude-sonnet-4-6'), undefined);
  assert.ok(providerStateOf(bound, 'anthropic', THINKING_STATE_KIND), 'no model asked for: any model');
  assert.equal(providerStateOf(part, 'openai', THINKING_STATE_KIND), undefined);
  assert.equal(providerStateOf(part, 'anthropic', 'reasoning_items'), undefined);
  assert.equal(providerStateOf({ text: 'x' }, 'anthropic', THINKING_STATE_KIND), undefined);
  assert.equal(providerStateOf({ providerState: 'garbage' }, 'anthropic', THINKING_STATE_KIND), undefined);
});

// ── Claude: thinking with tool use, end to end ───────────────────────────────

for (const streaming of [false, true]) {
  test(`claude (${streaming ? 'streamed' : 'non-streamed'}): the second request opens the assistant message with the signed blocks, then the tool_use`, async () => {
    const scout = new ScriptedLlm('scripted/scout', () => text('it is in the attic'));
    const sessions = new InMemorySessionService();
    await withProviders(
      [
        message([THINKING, REDACTED, { type: 'tool_use', id: 'toolu_01', name: 'Scout', input: { request: 'look in the attic' } }], 'tool_use'),
        message([{ type: 'text', text: 'Scout says: it is in the attic' }]),
      ],
      async (sent) => {
        const r = await turn(delegateConfig({ thinking: true }), { boss: claude(), scout }, sessions, streaming);
        assert.equal(r.status, 'completed', JSON.stringify(r.error));
        assert.equal(r.text, 'Scout says: it is in the attic');

        assert.equal(sent.anthropic.length, 2);
        const second = sent.anthropic[1];
        assert.equal(second.stream === true, streaming);
        assert.deepEqual(second.thinking, { type: 'enabled', budget_tokens: 2048 });
        const assistant = second.messages.find((m: any) => m.role === 'assistant');
        assert.deepEqual(assistant.content, [
          THINKING,
          REDACTED,
          { type: 'tool_use', id: 'toolu_01', name: 'Scout', input: { request: 'look in the attic' } },
        ]);
        const answer = second.messages[second.messages.indexOf(assistant) + 1];
        assert.equal(answer.role, 'user');
        assert.equal(answer.content[0].type, 'tool_result');
        assert.equal(answer.content[0].tool_use_id, 'toolu_01');

        // No display-only thought text and no stash anywhere else.
        assert.ok(!JSON.stringify(second.messages).includes('"thought"'));
        const stored = (await storedParts(sessions)).find((p) => p.functionCall?.name === 'Scout');
        assert.deepEqual(stored.providerState, {
          provider: 'anthropic',
          kind: THINKING_STATE_KIND,
          model: 'claude-sonnet-4-6',
          payload: [THINKING, REDACTED],
        });
      },
    );
  });
}

/** The body ClaudeLlm sends for `contents` (the stub answers 400; only the body matters). */
async function claudeBody(contents: LlmRequest['contents'], thinking = true): Promise<any> {
  return withProviders([], async (sent) => {
    const req = {
      model: 'claude-sonnet-4-6',
      contents,
      liveConnectConfig: {},
      toolsDict: {},
      config: thinking ? { thinkingConfig: { thinkingBudget: 2048 } } : {},
    } as unknown as LlmRequest;
    for await (const _ of claude().generateContentAsync(req, false)) {
      // drain
    }
    return sent.anthropic[0];
  });
}

const call = (id: string, state?: ProviderState) =>
  state ? withProviderState({ functionCall: { id, name: 'Scout', args: {} } }, state) : { functionCall: { id, name: 'Scout', args: {} } };
const result = (id: string) => ({ functionResponse: { id, name: 'Scout', response: { result: 'ok' } } });
const signed = (n: number): ProviderState => ({
  provider: 'anthropic',
  kind: THINKING_STATE_KIND,
  payload: [{ type: 'thinking', thinking: `step ${n}`, signature: `sig-${n}` }],
});

test('claude: every step of the current tool loop is replayed, in order; earlier turns are not', async () => {
  const body = await claudeBody([
    { role: 'user', parts: [{ text: 'first question' }] },
    { role: 'model', parts: [{ text: 'old thought', thought: true } as any, call('t1', signed(0))] },
    { role: 'user', parts: [result('t1')] },
    { role: 'model', parts: [{ text: 'first answer' }] },
    { role: 'user', parts: [{ text: 'second question' }] },
    { role: 'model', parts: [call('c1', signed(1))] },
    { role: 'user', parts: [result('c1')] },
    { role: 'model', parts: [withProviderState({ text: 'Asking again.' }, signed(2)), call('c2')] },
    { role: 'user', parts: [result('c2')] },
  ]);
  const assistants = body.messages.filter((m: any) => m.role === 'assistant');
  // The earlier turn's tool_use goes without its blocks (dropped from the front).
  assert.deepEqual(assistants[0].content.map((b: any) => b.type), ['tool_use']);
  assert.deepEqual(assistants[2].content.map((b: any) => b.signature ?? b.type), ['sig-1', 'tool_use']);
  // A block that preceded text stays before that text.
  assert.deepEqual(assistants[3].content.map((b: any) => b.signature ?? b.type), ['sig-2', 'text', 'tool_use']);
  assert.ok(body.thinking);
  assert.ok(!JSON.stringify(body).includes('old thought'), 'display-only thought parts stay out of the request');
});

test('claude: another provider\'s state is ignored, and a step answering an unsigned tool call omits thinking', async () => {
  const foreign: ProviderState = { provider: 'openai', kind: 'reasoning_items', payload: [{ type: 'reasoning', encrypted_content: 'enc-openai-1' }] };
  const body = await claudeBody([
    { role: 'user', parts: [{ text: 'find it' }] },
    { role: 'model', parts: [call('c1', foreign)] },
    { role: 'user', parts: [result('c1')] },
  ]);
  const assistant = body.messages.find((m: any) => m.role === 'assistant');
  assert.deepEqual(assistant.content.map((b: any) => b.type), ['tool_use']);
  assert.ok(!JSON.stringify(body).includes('enc-openai-1'));
  // Anthropic rejects thinking on a loop whose tool call carries no signed block.
  assert.equal(body.thinking, undefined);

  // A plain new turn after it thinks again.
  const next = await claudeBody([{ role: 'user', parts: [{ text: 'next question' }] }]);
  assert.ok(next.thinking);
});

test('claude: another Claude model\'s signed blocks are dropped, and the step runs without thinking', async () => {
  // Signed thinking is bound to the model that produced it: a fallback from
  // one Claude model to another starts the loop's thinking afresh.
  const body = await claudeBody([
    { role: 'user', parts: [{ text: 'find it' }] },
    { role: 'model', parts: [call('c1', { ...signed(1), model: 'claude-opus-4-6' })] },
    { role: 'user', parts: [result('c1')] },
  ]);
  const assistant = body.messages.find((m: any) => m.role === 'assistant');
  assert.deepEqual(assistant.content.map((b: any) => b.type), ['tool_use']);
  assert.equal(body.thinking, undefined);

  // The same state from this adapter's own model is replayed.
  const own = await claudeBody([
    { role: 'user', parts: [{ text: 'find it' }] },
    { role: 'model', parts: [call('c1', { ...signed(1), model: 'claude-sonnet-4-6' })] },
    { role: 'user', parts: [result('c1')] },
  ]);
  assert.equal(own.messages.find((m: any) => m.role === 'assistant').content[0].signature, 'sig-1');
  assert.ok(own.thinking);
});

test('claude: without a thinking budget, a stored state is still replayed and nothing else changes', async () => {
  const body = await claudeBody(
    [
      { role: 'user', parts: [{ text: 'find it' }] },
      { role: 'model', parts: [call('c1', signed(1))] },
      { role: 'user', parts: [result('c1')] },
    ],
    false,
  );
  assert.equal(body.thinking, undefined);
  const assistant = body.messages.find((m: any) => m.role === 'assistant');
  assert.deepEqual(assistant.content.map((b: any) => b.signature ?? b.type), ['sig-1', 'tool_use']);
});

// ── A model switch between steps drops the state ─────────────────────────────

test('model switch: Claude then a chat-completions model — the signed blocks never reach the other provider', async () => {
  const scout = new ScriptedLlm('scripted/scout', () => text('it is in the attic'));
  await withProviders(
    [message([THINKING, { type: 'tool_use', id: 'toolu_01', name: 'Scout', input: { request: 'look' } }], 'tool_use')],
    async (sent) => {
      const boss = new StepSwitch([claude(), new OllamaLlm({ model: 'ollama/qwen3:8b' })]);
      const r = await turn(delegateConfig({ thinking: true }), { boss, scout });
      assert.equal(r.status, 'completed', JSON.stringify(r.error));
      assert.equal(r.text, 'Scout says: it is in the attic');
      assert.equal(sent.other.length, 1);
      const wire = JSON.stringify(sent.other[0].body);
      assert.ok(wire.includes('look'), 'the tool call itself is replayed');
      assert.ok(!wire.includes(THINKING.signature) && !wire.includes('providerState'));
    },
    'Scout says: it is in the attic',
  );
});

test('model switch: another provider then Claude — Claude replays nothing foreign and runs the step without thinking', async () => {
  const scout = new ScriptedLlm('scripted/scout', () => text('it is in the attic'));
  const gptLike = new ScriptedLlm('scripted/gpt', () => ({
    content: {
      role: 'model',
      parts: [
        withProviderState(
          { functionCall: { name: 'Scout', args: { request: 'look' }, id: 'call-gpt-1' } },
          { provider: 'openai', kind: 'reasoning_items', payload: [{ type: 'reasoning', encrypted_content: 'enc-openai-1' }] },
        ),
      ],
    },
  }) as LlmResponse);
  await withProviders([message([{ type: 'text', text: 'Scout says: it is in the attic' }])], async (sent) => {
    const boss = new StepSwitch([gptLike, claude()]);
    const r = await turn(delegateConfig({ thinking: true }), { boss, scout });
    assert.equal(r.status, 'completed', JSON.stringify(r.error));
    const body = sent.anthropic[0];
    const assistant = body.messages.find((m: any) => m.role === 'assistant');
    assert.deepEqual(assistant.content.map((b: any) => b.type), ['tool_use']);
    assert.ok(!JSON.stringify(body).includes('enc-openai-1'));
    assert.equal(body.thinking, undefined);
  });
});

test('other adapters ignore an anthropic state on the wire (Responses, chat-completions, Gemini)', async () => {
  const req = (model: string) =>
    ({
      model,
      contents: [
        { role: 'user', parts: [{ text: 'find it' }] },
        { role: 'model', parts: [call('c1', signed(7))] },
        { role: 'user', parts: [result('c1')] },
      ],
      liveConnectConfig: {},
      toolsDict: {},
      config: {},
    }) as unknown as LlmRequest;
  const adapters: Array<[string, BaseLlm]> = [
    ['gpt-5-mini', new GptLlm({ model: 'gpt-5-mini', apiKey: 'fixture-openai-0123456789abcdef' })], // gitleaks:allow (test fixture)
    ['kimi-k3', new KimiLlm({ model: 'kimi-k3', apiKey: 'fixture-moonshot-0123456789abcdef' })], // gitleaks:allow (test fixture)
    ['ollama/qwen3:8b', new OllamaLlm({ model: 'ollama/qwen3:8b' })],
    ['gemini-3.5-flash-lite', new Gemini({ model: 'gemini-3.5-flash-lite', apiKey: 'fixture-gemini-0123456789abcdef' })], // gitleaks:allow (test fixture)
  ];
  for (const [model, llm] of adapters) {
    await withProviders([], async (sent) => {
      try {
        for await (const _ of llm.generateContentAsync(req(model), false)) {
          // drain; the 400 surfaces as an error response or a throw
        }
      } catch {
        // Gemini throws on a 400; the body is already captured
      }
      assert.equal(sent.other.length >= 1, true, `${model}: no request was sent`);
      const wire = JSON.stringify(sent.other[0].body);
      assert.ok(wire.length > 0 && !wire.includes('sig-7') && !wire.includes('providerState'), `${model} leaked the state: ${wire.slice(0, 300)}`);
    });
  }
});
