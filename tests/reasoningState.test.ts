/**
 * tests/reasoningState.test.ts — provider-opaque reasoning state from one
 * model step to the next (lib/models/providerState.ts, ADR 0046).
 *
 * Offline: models are scripted, and the Claude and chat-completions adapters
 * talk to a fetch stub that answers in the provider's own wire format, so the
 * real SDKs parse real-shaped responses (JSON and SSE). Keys are fixtures.
 *
 * What is proved here:
 *   - the field survives runSyndicateTurn on the native loop: from the
 *     model's event into the next request of the tool loop, and into storage
 *     (in process, and the serialized rows of the Supabase and Postgres
 *     services);
 *   - ClaudeAdapter writes its signed thinking blocks into it on both the
 *     streamed and the non-streamed path, and the second request of a tool
 *     loop opens the assistant message with them, verbatim, before its
 *     tool_use;
 *   - a model switch between steps drops the state in both directions, and
 *     no other adapter puts an anthropic state on its wire.
 * Which steps Claude replays (the current turn's, its own model's) is
 * tests/claudeAdapter.test.ts's.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelAdapter, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { ClaudeAdapter, THINKING_STATE_KIND } from '../lib/models/claudeAdapter.ts';
import { GptAdapter } from '../lib/models/gptAdapter.ts';
import { KimiAdapter } from '../lib/models/kimiAdapter.ts';
import { OllamaAdapter } from '../lib/models/ollamaAdapter.ts';
import { GeminiAdapter } from '../lib/models/geminiAdapter.ts';
import { providerStateOf, withProviderState } from '../lib/models/providerState.ts';
import type { ProviderState } from '../lib/models/providerState.ts';
import { projectTranscript, trimEventForStorage } from '../lib/session/transcript.ts';
import { SupabaseSessionService } from '../lib/session/supabaseSessionService.ts';
import { PostgresSessionService } from '../lib/storage/postgres/sessionService.ts';
import { ScriptedLlm, scriptedResolver, text } from './helpers/scriptedLlm.ts';
import type { LlmRequest, LlmResponse } from './helpers/scriptedLlm.ts';
const APP = 'test-app';
const USER = 'u1';
const FIXTURE_KEY = 'fixture-ant-test-0123456789abcdef'; // gitleaks:allow (test fixture)

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Signed blocks exactly as the Messages API returns them. */
const THINKING = { type: 'thinking', thinking: 'Scout knows where it is.', signature: 'sig-fixture-thinking-1' };
const REDACTED = { type: 'redacted_thinking', data: 'redacted-fixture-blob-1' };

/** The state a scripted model writes (any provider's shape will do here). */
const STATE: ProviderState = { provider: 'anthropic', kind: THINKING_STATE_KIND, payload: [THINKING] };

function delegateConfig(boss: { thinking?: boolean; model?: string } = {}): SyndicateYamlConfig {
  return {
    syndicate_name: 'Test',
    orchestrator: {
      name: 'Boss',
      model: boss.model ?? 'scripted/boss',
      instruction: 'Delegate to Scout.',
      ...(boss.thinking ? { generateContentConfig: { thinkingConfig: { thinkingBudget: 2048 } } } : {}),
    },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
  } as SyndicateYamlConfig;
}

/** A turn whose Boss is `models.boss` and whose Scout is `models.scout`, whatever ids the YAML names. */
function turn(config: SyndicateYamlConfig, models: { boss: ModelAdapter; scout: ModelAdapter }, sessionService = new InProcessSessionService(), streaming = false) {
  const scripted = scriptedResolver(models as any);
  return runSyndicateTurn({
    config,
    parts: [{ text: 'find the thing' }],
    appName: APP,
    userId: USER,
    sessionId: 's1',
    sessionService,
    compile: { resolveModel: (id: string | undefined) => (id === config.orchestrator.model ? models.boss : scripted(id)) },
    trace: false,
    streaming,
  });
}

/** Every part of the stored session's events. */
async function storedParts(sessions: InProcessSessionService): Promise<any[]> {
  const s = await sessions.get({ appName: APP, userId: USER, sessionId: 's1' });
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

const claude = () => new ClaudeAdapter({ model: 'claude-sonnet-4-6', apiKey: FIXTURE_KEY });

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

/** Every response an adapter yields for `request`. */
async function collect(adapter: ModelAdapter, request: ModelRequest): Promise<ModelResponse[]> {
  const out: ModelResponse[] = [];
  for await (const r of adapter.generate(request)) out.push(r);
  return out;
}

// ── The convention through runSyndicateTurn on the native loop ───────────────

test('convention (native turn): providerState on a functionCall part reaches the next request of the tool loop, and storage', async () => {
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
  const sessions = new InProcessSessionService();

  const r = await turn(delegateConfig(), { boss, scout }, sessions);
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'Scout says: it is in the attic');

  // Into the next request: the loop replays the event's content.
  const second = callContent(boss.requests[1]);
  assert.ok(second, 'the second request replays the call');
  const callPart = second.parts.find((p: any) => p.functionCall);
  assert.deepEqual(callPart.providerState, STATE);

  // Into storage: the in-process session, and the serialized copy both
  // durable services write (JSON, then the storage trim).
  const stored = (await storedParts(sessions)).find((p) => p.functionCall?.name === 'Scout');
  assert.deepEqual(stored.providerState, STATE);
  const event = (await sessions.get({ appName: APP, userId: USER, sessionId: 's1' }))!.events.find((e) =>
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
  } as unknown as TurnEvent;

  // Supabase: the whole events array, upserted.
  let upserted: any;
  const supabase = { from: () => ({ upsert: async (row: any) => ((upserted = row), { error: null }) }) };
  const supa = new SupabaseSessionService(supabase as any);
  await supa.append({ id: 's1', appName: APP, userId: USER, state: {}, events: [], lastUpdateTime: 0 } as any, event);
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
  const pg = new PostgresSessionService({ connect: async () => client, query: client.query } as any);
  await pg.append({ id: 's1', appName: APP, userId: USER, state: {}, events: [], lastUpdateTime: 0 } as any, event);
  assert.deepEqual(inserted.content.parts[0].providerState, STATE);
});

test('convention: the transcript projection drops the state with the rest of a past turn', () => {
  const events = [
    { author: 'user', content: { role: 'user', parts: [{ text: 'find it' }] } },
    { author: 'Boss', content: { role: 'model', parts: [withProviderState({ text: 'It is in the attic.' }, STATE)] } },
  ] as TurnEvent[];
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
  test(`native turn, claude (${streaming ? 'streamed' : 'non-streamed'}): the second request opens the assistant message with the signed blocks, then the tool_use`, async () => {
    const scout = new ScriptedLlm('scripted/scout', () => text('it is in the attic'));
    const sessions = new InProcessSessionService();
    await withProviders(
      [
        message([THINKING, REDACTED, { type: 'tool_use', id: 'toolu_01', name: 'Scout', input: { request: 'look in the attic' } }], 'tool_use'),
        message([{ type: 'text', text: 'Scout says: it is in the attic' }]),
      ],
      async (sent) => {
        const r = await turn(delegateConfig({ thinking: true, model: 'claude-sonnet-4-6' }), { boss: claude(), scout }, sessions, streaming);
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

const signed = (n: number): ProviderState => ({
  provider: 'anthropic',
  kind: THINKING_STATE_KIND,
  payload: [{ type: 'thinking', thinking: `step ${n}`, signature: `sig-${n}` }],
});

/** A tool loop whose one call carries `state`, as a contract request. */
const loopRequest = (model: string, state: ProviderState): ModelRequest => ({
  model,
  messages: [
    { role: 'user', parts: [{ type: 'text', text: 'find it' }] },
    { role: 'assistant', parts: [{ type: 'toolCall', id: 'c1', name: 'Scout', args: {}, providerState: state }] },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'c1', name: 'Scout', result: 'ok' }] },
  ],
});

test('claude: without a thinking budget, a stored state is still replayed and nothing else changes', async () => {
  const body = await withProviders([], async (sent) => {
    await collect(claude(), loopRequest('claude-sonnet-4-6', signed(1))); // the 400 surfaces as an error final
    return sent.anthropic[0];
  });
  assert.equal(body.thinking, undefined);
  const assistant = body.messages.find((m: any) => m.role === 'assistant');
  assert.deepEqual(assistant.content.map((b: any) => b.signature ?? b.type), ['sig-1', 'tool_use']);
});

// ── A model switch between steps drops the state ─────────────────────────────

test('native turn, model switch: Claude then a chat-completions model — the signed blocks never reach the other provider', async () => {
  const scout = new ScriptedLlm('scripted/scout', () => text('it is in the attic'));
  await withProviders(
    [message([THINKING, { type: 'tool_use', id: 'toolu_01', name: 'Scout', input: { request: 'look' } }], 'tool_use')],
    async (sent) => {
      const boss = new StepSwitch([claude(), new OllamaAdapter({ model: 'ollama/qwen3:8b' })]);
      const r = await turn(delegateConfig({ thinking: true }), { boss, scout });
      assert.equal(r.status, 'completed', JSON.stringify(r.error));
      assert.equal(r.text, 'Scout says: it is in the attic');
      assert.equal(sent.anthropic.length, 1);
      assert.equal(sent.other.length, 1);
      const wire = JSON.stringify(sent.other[0].body);
      assert.ok(wire.includes('look'), 'the tool call itself is replayed');
      assert.ok(!wire.includes(THINKING.signature) && !wire.includes('providerState'));
    },
    'Scout says: it is in the attic',
  );
});

test('native turn, model switch: another provider then Claude — Claude replays nothing foreign and runs the step without thinking', async () => {
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
    assert.equal(gptLike.calls, 1);
    const body = sent.anthropic[0];
    const assistant = body.messages.find((m: any) => m.role === 'assistant');
    assert.deepEqual(assistant.content.map((b: any) => b.type), ['tool_use']);
    assert.ok(!JSON.stringify(body).includes('enc-openai-1'));
    assert.equal(body.thinking, undefined);
  });
});

test('other adapters ignore an anthropic state on the wire (Responses, chat-completions, Gemini)', async () => {
  const adapters: ModelAdapter[] = [
    new GptAdapter({ model: 'gpt-5-mini', apiKey: 'fixture-openai-0123456789abcdef' }), // gitleaks:allow (test fixture)
    new KimiAdapter({ model: 'kimi-k3', apiKey: 'fixture-moonshot-0123456789abcdef' }), // gitleaks:allow (test fixture)
    new OllamaAdapter({ model: 'ollama/qwen3:8b' }),
    new GeminiAdapter({ model: 'gemini-3.5-flash-lite', apiKey: 'fixture-gemini-0123456789abcdef', endpoint: { platform: 'direct' } }), // gitleaks:allow (test fixture)
  ];
  for (const adapter of adapters) {
    await withProviders([], async (sent) => {
      await collect(adapter, loopRequest(adapter.model, signed(7))); // the 400 surfaces as an error final
      assert.equal(sent.other.length >= 1, true, `${adapter.model}: no request was sent`);
      const wire = JSON.stringify(sent.other[0].body);
      assert.ok(wire.includes('Scout'), `${adapter.model}: the call itself is sent`);
      assert.ok(!wire.includes('sig-7') && !wire.includes('providerState'), `${adapter.model} leaked the state: ${wire.slice(0, 300)}`);
    });
  }
});
