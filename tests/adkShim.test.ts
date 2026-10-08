/**
 * tests/adkShim.test.ts — a ModelAdapter on the engine's own contract as an
 * ADK BaseLlm (lib/models/adkShim.ts, WS1-10, ADR 0053).
 *
 * The shim maps the LlmRequest in and each ModelResponse out, and does once
 * what every ADK-path adapter does at its own call site: it charges the call
 * against the turn, refuses it with the same LlmResponse when the turn is
 * spent or stopped, hands the adapter the turn's signal, and opens the one
 * llm.request span. The turn-level cases (delegation, streaming, fallback,
 * cancel, max_steps, approvals) are in the boundary suite,
 * tests/syndicateTurn.test.ts. Offline: scripted adapters, and the Gemini
 * adapter over a fake client.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseLlm, InMemorySessionService, LLMRegistry, isBaseLlm, setLogLevel, LogLevel } from '@google/adk';
import type { BaseLlmType, LlmRequest, LlmResponse } from '@google/adk';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { AdkShim, adkShim, adkShimClass } from '../lib/models/adkShim.ts';
import type { FinalModelResponse, ModelResponse } from '../lib/models/contract.ts';
import { llmRequestToModelRequest, modelResponseToLlmResponse } from '../lib/models/genaiMapping.ts';
import { ERROR_RETRYABLE_KEY, isRetryableErrorResponse } from '../lib/models/errorResponse.ts';
import { ClaudeLlm } from '../lib/models/claudeLlm.ts';
import { GptLlm } from '../lib/models/gptLlm.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { GeminiAdapter } from '../lib/models/geminiAdapter.ts';
import { flushTracing, onSpanEnd, setLlmSpanAttribute } from '../lib/observability/tracer.ts';
import { createTurnControl, runWithTurnControl } from '../lib/runtime/turnControl.ts';
import type { TurnStopReason } from '../lib/runtime/turnControl.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, text } from './helpers/scriptedLlm.ts';
import { ScriptedModel, answer, failure, untilAborted } from './helpers/scriptedModel.ts';

setLogLevel(LogLevel.ERROR);

const request = (extra: Partial<LlmRequest> = {}): LlmRequest =>
  ({
    model: 'scripted/one',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    config: { systemInstruction: 'Answer briefly.', temperature: 0.2 },
    toolsDict: {},
    liveConnectConfig: {},
    ...extra,
  }) as unknown as LlmRequest;

async function collect(gen: AsyncGenerator<LlmResponse, void>): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

// ── Construction ─────────────────────────────────────────────────────────────

test('the shim is an ADK BaseLlm under the adapter’s model id, or the id it is given', () => {
  const adapter = new ScriptedModel('scripted/one', () => answer('x'));
  const shim = adkShim(adapter);
  assert.ok(shim instanceof BaseLlm);
  assert.ok(isBaseLlm(shim));
  assert.equal(shim.model, 'scripted/one');
  assert.equal(shim.adapter, adapter);
  assert.equal(adkShim(adapter, 'scripted/alias').model, 'scripted/alias');
  assert.equal(new AdkShim(adapter, { model: 'scripted/alias' }).model, 'scripted/alias');
});

test('adkShimClass makes a class the LLMRegistry constructs per model id, with the adapter built for that id', () => {
  const built: string[] = [];
  const patterns = [/^shim-test-.+/];
  const Shim: BaseLlmType = adkShimClass(patterns, (model) => (built.push(model), new ScriptedModel(model, () => answer('x'))));
  assert.equal(Shim.supportedModels, patterns, 'the pattern instances themselves: the registry keys on them');

  LLMRegistry.register(Shim);
  const llm = LLMRegistry.newLlm('shim-test-1');
  assert.ok(llm instanceof AdkShim);
  assert.equal(llm.model, 'shim-test-1');
  assert.equal(llm.adapter.model, 'shim-test-1');
  assert.deepEqual(built, ['shim-test-1']);
});

test('connect() is refused, as on every adapter but Gemini’s own', async () => {
  const shim = adkShim(new ScriptedModel('scripted/one', () => answer('x')));
  await assert.rejects(shim.connect(request()), /does not support live bidirectional connections/);
});

// ── The mapping ──────────────────────────────────────────────────────────────

test('the LlmRequest goes through llmRequestToModelRequest with the shim’s model, the stream flag and ADK’s signal', async () => {
  const adapter = new ScriptedModel('scripted/one', () => answer('x'));
  const shim = adkShim(adapter);
  const adk = new AbortController();
  const req = request({ model: 'some-other-id' } as Partial<LlmRequest>);
  await collect(shim.generateContentAsync(req, true, adk.signal));

  const sent = adapter.requests[0];
  assert.equal(sent.signal, adk.signal, 'outside a turn, the signal ADK passed');
  assert.deepEqual(sent, llmRequestToModelRequest(req, { model: 'scripted/one', stream: true, signal: adk.signal }));
  assert.equal(sent.model, 'scripted/one', 'the shim’s id, not whatever the request names');
  assert.equal(sent.system, 'Answer briefly.');
  assert.deepEqual(sent.sampling, { temperature: 0.2 });

  await collect(shim.generateContentAsync(req));
  assert.equal(adapter.requests[1].stream, false, 'ADK’s default: not streamed');
  assert.equal(adapter.requests[1].signal, undefined, 'no signal outside a turn when ADK passes none');
});

test('every response goes through modelResponseToLlmResponse, in order: partials, then the final', async () => {
  const final: FinalModelResponse = {
    partial: false,
    parts: [{ type: 'text', text: 'Hello, world.' }],
    finishReason: 'stop',
    usage: { inputTokens: 40, outputTokens: 12, thinkingTokens: 5, cacheReadTokens: 8 },
    grounding: { searchQueries: [{ tool: 'web_search', query: 'hello' }], citations: [{ url: 'https://example.test/a', title: 'A' }] },
  };
  const script: ModelResponse[] = [
    { partial: true, parts: [{ type: 'thinking', text: 'Greeting.' }] },
    { partial: true, parts: [{ type: 'text', text: 'Hello, ' }] },
    { partial: true, parts: [{ type: 'text', text: 'world.' }] },
    final,
  ];
  const out = await collect(adkShim(new ScriptedModel('scripted/one', () => script)).generateContentAsync(request(), true));
  assert.deepEqual(out, script.map(modelResponseToLlmResponse));
  assert.deepEqual(out[0].content?.parts, [{ text: 'Greeting.', thought: true }]);
  assert.equal(out.at(-1)?.turnComplete, true);
});

test('a failed final carries the retry verdict FallbackLlm reads', async () => {
  const run = (retryable: boolean) =>
    collect(
      adkShim(new ScriptedModel('scripted/one', () => failure({ code: 'SCRIPTED_ERROR', message: 'overloaded', retryable, status: retryable ? 503 : 400 }))).generateContentAsync(request()),
    );
  const [retry] = await run(true);
  assert.equal(retry.errorCode, 'SCRIPTED_ERROR');
  assert.equal(retry.errorMessage, 'overloaded');
  assert.equal(isRetryableErrorResponse(retry), true);
  assert.equal(retry.customMetadata?.['error.status'], 503);
  const [plain] = await run(false);
  assert.equal(isRetryableErrorResponse(plain), false);
  assert.equal(plain.customMetadata?.[ERROR_RETRYABLE_KEY], false);
});

test('an adapter that breaks the contract by throwing reaches ADK as a throw, as Gemini’s does', async () => {
  const shim = adkShim(new ScriptedModel('scripted/one', () => {
    throw new Error('adapter bug');
  }));
  await assert.rejects(collect(shim.generateContentAsync(request())), /adapter bug/);
});

// ── The turn's controls ──────────────────────────────────────────────────────

/** A turn control already spent or stopped for `reason`. */
function stopped(reason: TurnStopReason) {
  const control = createTurnControl({ maxLlmCalls: 1 });
  if (reason === 'step_limit') control.llmCalls = 1;
  else control.stop(reason);
  return control;
}

test('a refused call yields the same LlmResponse ClaudeLlm, GptLlm and OllamaLlm yield, and never reaches the adapter', async () => {
  const expected: Record<TurnStopReason, string> = { step_limit: 'STEP_LIMIT', deadline: 'DEADLINE_EXCEEDED', canceled: 'CANCELED' };
  for (const reason of ['step_limit', 'deadline', 'canceled'] as TurnStopReason[]) {
    const adapter = new ScriptedModel('scripted/one', () => answer('never'));
    const viaShim = await runWithTurnControl(stopped(reason), () => collect(adkShim(adapter).generateContentAsync(request())));
    assert.equal(adapter.calls, 0, `${reason}: the adapter was never called`);
    assert.equal(viaShim.length, 1);
    assert.equal(viaShim[0].errorCode, expected[reason]);

    for (const llm of [new ClaudeLlm({ model: 'claude-sonnet-4-6' }), new GptLlm({ model: 'gpt-5-mini' }), new OllamaLlm({ model: 'ollama/qwen3:8b' })]) {
      const today = await runWithTurnControl(stopped(reason), () => collect(llm.generateContentAsync(request())));
      assert.deepEqual(viaShim, today, `${reason}: ${llm.constructor.name}`);
    }
  }
});

test('one call is one charge: the turn counts the call and the final’s tokens', async () => {
  const control = createTurnControl({ maxLlmCalls: 10 });
  const adapter = new ScriptedModel('scripted/one', () => answer('x', { inputTokens: 100, outputTokens: 30, thinkingTokens: 10 }));
  await runWithTurnControl(control, () => collect(adkShim(adapter).generateContentAsync(request())));
  assert.equal(control.llmCalls, 1);
  // Gemini's meanings (usageToMetadata): output less thinking, and the thinking on its own.
  assert.deepEqual([control.inputTokens, control.outputTokens, control.thinkingTokens], [100, 20, 10]);
  control.dispose();
});

test('the request’s signal aborts when the turn stops, and when the signal ADK passed aborts', async () => {
  for (const stop of ['turn', 'adk'] as const) {
    const control = createTurnControl();
    const adk = new AbortController();
    const adapter = new ScriptedModel('scripted/one', (_req, _n, signal) => untilAborted(signal));
    const pending = runWithTurnControl(control, () => collect(adkShim(adapter).generateContentAsync(request(), false, adk.signal)));
    setTimeout(() => (stop === 'turn' ? control.stop('canceled') : adk.abort()), 5);
    const out = await pending;
    assert.equal(adapter.requests[0].signal?.aborted, true, stop);
    assert.equal(out.length, 1);
    assert.equal(out[0].errorCode, 'SCRIPTED_ERROR', 'the adapter’s own failure, as rule 4 says');
    assert.equal(isRetryableErrorResponse(out[0]), false, 'a cancellation is never retryable');
    control.dispose();
  }
});

// ── The span ─────────────────────────────────────────────────────────────────

async function spansDuring(model: string, fn: () => Promise<unknown>): Promise<ReadableSpan[]> {
  const spans: ReadableSpan[] = [];
  const off = onSpanEnd((span) => {
    if (span.name === 'llm.request' && span.attributes['llm.model'] === model) spans.push(span);
  });
  try {
    await fn();
    await flushTracing();
  } finally {
    off();
  }
  return spans;
}

test('the shim opens one llm.request span, with the attributes every ADK-path adapter’s span carries', async () => {
  const adapter = new ScriptedModel(
    'scripted/span',
    () => {
      setLlmSpanAttribute('llm.test.marker', 'from the adapter');
      return answer('x', { inputTokens: 9, outputTokens: 4 });
    },
    'anthropic',
  );
  const [span, ...more] = await spansDuring('scripted/span', () => collect(adkShim(adapter).generateContentAsync(request())));
  assert.ok(span, 'a span');
  assert.equal(more.length, 0, 'exactly one');
  assert.equal(span.attributes['llm.provider'], 'anthropic', 'the adapter’s provider');
  assert.equal(span.attributes['gen_ai.system'], 'anthropic');
  assert.equal(span.attributes['gen_ai.request.model'], 'scripted/span');
  assert.equal(span.attributes['llm.tokens.input'], 9);
  assert.equal(span.attributes['llm.tokens.output'], 4);
  assert.equal(span.attributes['llm.test.marker'], 'from the adapter', 'the adapter decorates the open span');

  // The same attribute names as a span opened by an ADK-path model, extras aside.
  const [today] = await spansDuring('scripted/span-today', () =>
    collect(new ScriptedLlm('scripted/span-today', () => ({ ...text('x'), usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } }) as LlmResponse).generateContentAsync(request())),
  );
  const names = (s: ReadableSpan) => Object.keys(s.attributes).filter((k) => k !== 'llm.test.marker').sort();
  assert.deepEqual(names(span), names(today));
});

test('a failed call marks its span with the error and the request, as on the ADK path', async () => {
  const adapter = new ScriptedModel('scripted/span-error', () => failure({ code: 'SCRIPTED_ERROR', message: 'overloaded', retryable: true, status: 503 }));
  const [span] = await spansDuring('scripted/span-error', () => collect(adkShim(adapter).generateContentAsync(request())));
  assert.equal(span.attributes['llm.error_code'], 'SCRIPTED_ERROR');
  assert.equal(span.attributes['llm.error_message'], 'overloaded');
  assert.deepEqual(
    JSON.parse(String(span.attributes['llm.payload.request'])),
    {
      model: 'scripted/span-error',
      system: 'Answer briefly.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      sampling: { temperature: 0.2 },
      stream: false,
    },
    'the ModelRequest the adapter was given, less its signal',
  );
  assert.match(String(span.attributes['llm.payload.response']), /error\.retryable/);
});

// ── A real adapter ───────────────────────────────────────────────────────────

test('the Gemini contract adapter behind the shim runs a tool loop under ADK', async () => {
  const sent: any[] = [];
  const replies = [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Scout', args: { request: 'look in the attic' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Scout found it in the attic.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 7 } },
  ];
  const client = {
    models: {
      generateContent: async (params: unknown) => (sent.push(params), replies.shift() as any),
      generateContentStream: async () => {
        throw new Error('not streamed in this test');
      },
    },
  };
  const gemini = new GeminiAdapter({ model: 'gemini-3-flash', apiKey: 'fixture-gemini-key-0123456789', endpoint: { platform: 'direct' }, clientFactory: () => client });
  const scout = new ScriptedModel('scripted/scout', () => answer('it is in the attic'));
  const config = {
    syndicate_name: 'Real',
    orchestrator: { name: 'Boss', model: 'gemini-3-flash', instruction: 'Delegate to Scout.' },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
  } as unknown as SyndicateYamlConfig;

  const r = await runSyndicateTurn({
    config,
    parts: [{ text: 'find the thing' }],
    appName: 'a',
    userId: 'u',
    sessionId: 's',
    sessionService: new InMemorySessionService(),
    compile: { resolveModel: (id) => adkShim(id === 'gemini-3-flash' ? gemini : scout) },
    trace: false,
  });
  assert.equal(r.status, 'completed', r.error?.message);
  assert.equal(r.text, 'Scout found it in the attic.');
  assert.deepEqual(r.answer?.delegations, ['Scout']);
  assert.equal(r.llmCalls, 3);
  assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens], [50, 12], 'both Gemini calls are charged; the scout reported none');

  assert.equal(sent.length, 2);
  assert.match(sent[0].config.systemInstruction.parts.map((p: any) => p.text).join(' '), /Delegate to Scout\./);
  const results = sent[1].contents.flatMap((c: any) => c.parts).filter((p: any) => p.functionResponse);
  assert.deepEqual(results.map((p: any) => [p.functionResponse.name, p.functionResponse.response]), [['Scout', { result: 'it is in the attic' }]]);
});
