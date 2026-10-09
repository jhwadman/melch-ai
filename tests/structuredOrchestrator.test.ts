/**
 * tests/structuredOrchestrator.test.ts — an orchestrator that delegates and
 * answers in its own outputSchema (ADR 0109), the critic as one agent
 * (tests/fixtures/structured-critic.yaml).
 *
 * Offline: the orchestrator runs on the real ClaudeAdapter and GptAdapter
 * against a fetch stub that answers in each provider's wire format, and the
 * Drafter it delegates to is scripted. Keys are fixtures; every other
 * provider or gateway variable is cleared for the run.
 *
 * What is proved here, through runSyndicateTurn on the native loop:
 *   - on Claude's current generations and on GPT, every request of the
 *     orchestrator's tool loop carries the delegation tool AND the schema in
 *     the provider's own structured-output field (output_config.format,
 *     text.format), with no set_model_response; the model delegates, then
 *     answers in the schema, and that JSON is the turn's answer and its
 *     outputKey;
 *   - on Claude 4.6 (no output_config.format) the same YAML runs with a
 *     set_model_response tool beside the delegation tool, and the turn ends
 *     on its arguments;
 *   - a fallback_model on a path that cannot take both sends set_model_response;
 *   - the YAML validates with no dispatch block, and the doctor's gaps name
 *     the degraded paths only.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { ModelAdapter } from '../lib/models/contract.ts';
import { ClaudeAdapter } from '../lib/models/claudeAdapter.ts';
import { GptAdapter } from '../lib/models/gptAdapter.ts';
import { capabilityGaps } from '../lib/models/capabilities.ts';
import { ScriptedLlm, text } from './helpers/scriptedLlm.ts';

const ANTHROPIC_KEY = 'fixture-ant-test-0123456789abcdef'; // gitleaks:allow (test fixture)
const OPENAI_KEY = 'fixture-openai-0123456789abcdef'; // gitleaks:allow (test fixture)

const DRAFT = 'Water boils at 100 °C at sea level.';
const REVIEW = { message: DRAFT, confidence: 92, issues: [] as string[] };

/** The variables that route a model; cleared for each run so a developer's own keys or gateway never decide it. */
const ROUTING_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_PLATFORM',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_PLATFORM',
  'OPENAI_BASE_URL',
  'MODEL_GATEWAY',
  'MODEL_GATEWAY_API_KEY',
  'MODEL_GATEWAY_BASE_URL',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE',
];

function critic(criticModel: string, extra: Partial<SyndicateYamlConfig['orchestrator']> = {}): SyndicateYamlConfig {
  const config = loadSyndicate('structured-critic.yaml', {
    agentsDir: 'tests/fixtures',
    bindings: { critic_model: criticModel, drafter_model: 'scripted/drafter' },
  });
  Object.assign(config.orchestrator, extra);
  return config;
}

/**
 * Runs one turn of the critic with `boss` as its model, `env` as the only
 * routing variables, and fetch answering each orchestrator request with the
 * next of `replies` (a 400 once they run out). Returns what was posted and
 * the turn's result.
 */
async function run(boss: ModelAdapter, replies: unknown[], env: Record<string, string>, config = critic(boss.model)) {
  const saved = Object.fromEntries(ROUTING_ENV.map((k) => [k, process.env[k]]));
  for (const k of ROUTING_ENV) delete process.env[k];
  Object.assign(process.env, env);
  const sent: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    sent.push(typeof raw === 'string' ? JSON.parse(raw) : undefined);
    const reply = replies.shift();
    if (reply === undefined) {
      return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"captured"}}', { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const sessions = new InProcessSessionService();
  const drafter = new ScriptedLlm('scripted/drafter', () => text(DRAFT));
  try {
    const result = await runSyndicateTurn({
      config,
      parts: [{ text: 'At what temperature does water boil?' }],
      appName: 'structured-critic',
      userId: 'u1',
      sessionId: 's1',
      sessionService: sessions,
      compile: { resolveModel: (id: string | undefined) => (id === 'scripted/drafter' ? drafter : boss) },
      trace: false,
    });
    const session = await sessions.get({ appName: 'structured-critic', userId: 'u1', sessionId: 's1' });
    return { sent, result, state: session?.state ?? {}, drafter };
  } finally {
    globalThis.fetch = original;
    for (const k of ROUTING_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── Claude (Messages API) ────────────────────────────────────────────────────

const claudeMessage = (model: string, content: unknown[], stop_reason: string) => ({
  id: 'msg_fixture',
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 30, output_tokens: 12 },
});

const askDrafter = (model: string) =>
  claudeMessage(model, [{ type: 'tool_use', id: 'toolu_1', name: 'DrafterAgent', input: { request: 'At what temperature does water boil?' } }], 'tool_use');

/** The function tools a request declares, less self-correction's reflection tool, which every step declares last (ADR 0097). */
const toolNames = (body: any): string[] =>
  (body.tools ?? []).map((t: any) => t.name ?? t.function?.name).filter((name: string) => name !== 'adk_handle_model_error');

test('Claude (current generation): the critic delegates and answers in its schema, with output_config.format beside the tools in every request', async () => {
  const model = 'claude-opus-5-5';
  const { sent, result, state, drafter } = await run(
    new ClaudeAdapter({ model, apiKey: ANTHROPIC_KEY }),
    [askDrafter(model), claudeMessage(model, [{ type: 'text', text: JSON.stringify(REVIEW) }], 'end_turn')],
    { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
  );
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(sent.length, 2, 'two orchestrator steps: delegate, then answer');
  for (const [i, body] of sent.entries()) {
    assert.deepEqual(toolNames(body), ['DrafterAgent'], `request ${i + 1}: the delegation tool, and no set_model_response`);
    const format = body.output_config?.format;
    assert.equal(format?.type, 'json_schema', `request ${i + 1}: the schema in output_config.format`);
    assert.deepEqual(Object.keys(format.schema.properties).sort(), ['confidence', 'issues', 'message']);
    assert.equal(body.tool_choice, undefined, 'nothing forced');
    assert.doesNotMatch(body.system ?? '', /set_model_response/);
  }
  // The second request carries the Drafter's answer back as the tool result.
  assert.ok(JSON.stringify(sent[1].messages).includes('Water boils at 100'), 'the Drafter answer goes back');
  assert.equal(drafter.calls, 1, 'the Drafter ran once');
  assert.deepEqual(JSON.parse(result.text), REVIEW);
  assert.deepEqual(state.review, REVIEW, 'outputKey holds the parsed review');
});

test('Claude 4.6 (no output_config.format): the same YAML answers through set_model_response beside the delegation tool', async () => {
  const model = 'claude-sonnet-4-6';
  const { sent, result, state } = await run(
    new ClaudeAdapter({ model, apiKey: ANTHROPIC_KEY }),
    [askDrafter(model), claudeMessage(model, [{ type: 'tool_use', id: 'toolu_2', name: 'set_model_response', input: REVIEW }], 'tool_use')],
    { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
  );
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(sent.length, 2);
  for (const body of sent) {
    assert.deepEqual(toolNames(body), ['DrafterAgent', 'set_model_response']);
    assert.deepEqual(Object.keys(body.tools[1].input_schema.properties).sort(), ['confidence', 'issues', 'message']);
    assert.equal(body.output_config?.format, undefined, 'no schema field');
    assert.match(body.system ?? '', /call the "set_model_response" function/);
  }
  assert.deepEqual(JSON.parse(result.text), REVIEW);
  assert.deepEqual(state.review, REVIEW);
});

// ── GPT (Responses API) ──────────────────────────────────────────────────────

const response = (output: unknown[]) => ({
  id: 'resp_fixture',
  object: 'response',
  created_at: 0,
  model: 'gpt-5-mini',
  status: 'completed',
  output,
  usage: { input_tokens: 30, output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 42 },
});

test('GPT: the critic delegates and answers in its schema, with text.format beside the tools in every request', async () => {
  const model = 'gpt-5-mini';
  const { sent, result, state, drafter } = await run(
    new GptAdapter({ model, apiKey: OPENAI_KEY }),
    [
      response([
        { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'DrafterAgent', arguments: JSON.stringify({ request: 'At what temperature does water boil?' }) },
      ]),
      response([
        { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(REVIEW), annotations: [] }] },
      ]),
    ],
    { OPENAI_API_KEY: OPENAI_KEY },
  );
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(sent.length, 2, 'two orchestrator steps: delegate, then answer');
  for (const [i, body] of sent.entries()) {
    assert.deepEqual(toolNames(body), ['DrafterAgent'], `request ${i + 1}: the delegation tool, and no set_model_response`);
    const format = body.text?.format;
    assert.equal(format?.type, 'json_schema', `request ${i + 1}: the schema in text.format`);
    assert.equal(format.strict, true);
    assert.deepEqual(Object.keys(format.schema.properties).sort(), ['confidence', 'issues', 'message']);
    assert.doesNotMatch(body.instructions ?? '', /set_model_response/);
  }
  assert.ok(sent[1].input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call_1'), 'the Drafter answer goes back');
  assert.equal(drafter.calls, 1);
  assert.deepEqual(JSON.parse(result.text), REVIEW);
  assert.deepEqual(state.review, REVIEW);
});

test('a fallback_model whose path cannot take a schema beside tools keeps set_model_response for the step', async () => {
  const model = 'gpt-5-mini';
  const { sent } = await run(new GptAdapter({ model, apiKey: OPENAI_KEY }), [], { OPENAI_API_KEY: OPENAI_KEY }, critic(model, { fallback_model: 'ollama/qwen3:8b' }));
  assert.ok(sent.length >= 1);
  assert.deepEqual(toolNames(sent[0]), ['DrafterAgent', 'set_model_response']);
  assert.equal(sent[0].text?.format, undefined);
});

test('the critic needs no dispatch block, and the doctor names only the paths that degrade it', () => {
  const config = critic('claude-opus-5-5');
  assert.equal(config.dispatch, undefined);
  assert.ok(config.orchestrator.outputSchema && (config.subagents ?? []).length === 1, 'a schema on an orchestrator that delegates');
  const needs = { outputSchema: config.orchestrator.outputSchema, delegates: true };
  const saved = Object.fromEntries(ROUTING_ENV.map((k) => [k, process.env[k]]));
  for (const k of ROUTING_ENV) delete process.env[k];
  try {
    assert.deepEqual(capabilityGaps('claude-opus-5-5', needs), []);
    assert.deepEqual(capabilityGaps('gpt-5-mini', needs), []);
    assert.deepEqual(
      capabilityGaps('gemini-3.8-flash', needs).map((g) => `${g.capability}:${g.support}`),
      ['structured_output_with_tools:degraded'],
    );
  } finally {
    for (const k of ROUTING_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
