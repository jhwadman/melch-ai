/**
 * tests/reasoningKey.test.ts — the provider-neutral `reasoning:` key
 * (ADR 0047), from the YAML to the field each provider receives.
 *
 * Every case validates a one-agent syndicate, compiles it (lib/compile.ts),
 * and sends the compiled agent's generateContentConfig through that
 * provider's adapter, asserting the request body on the wire.
 *
 * Offline: globalThis.fetch is replaced by a stub that records the request
 * and answers 400, so no provider is called. Keys are fake values set only
 * for the duration of each capture.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { Gemini, LogLevel, setLogLevel } from '@google/adk';
import type { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compileGraph } from '../lib/compile.ts';
import { runDoctor } from '../lib/doctor.ts';
import { requiredCapabilities } from '../lib/models/capabilities.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { ClaudeLlm } from '../lib/models/claudeLlm.ts';
import { GptLlm } from '../lib/models/gptLlm.ts';
import { GrokLlm } from '../lib/models/grokLlm.ts';
import { KimiLlm } from '../lib/models/kimiLlm.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { GatewayLlm } from '../lib/models/gatewayLlm.ts';

setLogLevel(LogLevel.ERROR);
process.env.OTEL_CONSOLE_SPANS = 'false';

// ── Harness ──────────────────────────────────────────────────────────────────

/** The env vars a capture touches, cleared first so a developer's real keys never route a test. */
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'MOONSHOT_API_KEY',
  'MODEL_GATEWAY',
  'MODEL_GATEWAY_API_KEY',
  'MODEL_GATEWAY_BASE_URL',
  'MODEL_GATEWAY_MODEL_MAP',
];

/** The generateContentConfig the compiler gives an agent with this model and `reasoning:`. */
async function compiledConfig(model: string, reasoning?: unknown): Promise<Record<string, unknown>> {
  const raw = {
    syndicate_name: 'Reasoning',
    orchestrator: { name: 'Agent', model, instruction: 'Answer.', ...(reasoning === undefined ? {} : { reasoning }) },
  };
  const agent = await compileGraph(validateSyndicateConfig(raw, 'reasoning.yaml'));
  return agent.generateContentConfig as Record<string, unknown>;
}

/**
 * Sends one compiled agent's request through an adapter and returns the JSON
 * body it posted. The adapter is built inside the capture, because some read
 * their environment when constructed.
 */
async function wire(
  makeAdapter: () => BaseLlm,
  model: string,
  reasoning: unknown,
  env: Record<string, string> = {},
): Promise<any> {
  const config = await compiledConfig(model, reasoning);
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (input: any, init: any) => {
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    if (body === undefined && typeof raw === 'string') body = JSON.parse(raw);
    return new Response(JSON.stringify({ error: { code: 400, message: 'captured', type: 'invalid_request_error' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  try {
    const request = {
      model,
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      liveConnectConfig: {},
      toolsDict: {},
      config,
    } as unknown as LlmRequest;
    try {
      for await (const _ of makeAdapter().generateContentAsync(request, false) as AsyncGenerator<LlmResponse, void>) {
        // drain; the 400 surfaces as an error response, which is expected
      }
    } catch {
      // ADK's Gemini rethrows the 400; the body was already captured
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  assert.ok(body, `${model}: the adapter sent no request`);
  return body;
}

const FAKE = {
  gemini: 'fixture-gemini-0123456789abcdef', // gitleaks:allow (test fixture)
  anthropic: { ANTHROPIC_API_KEY: 'fixture-ant-test-0123456789abcdef' }, // gitleaks:allow (test fixture)
  openai: { OPENAI_API_KEY: 'fixture-openai-0123456789abcdef' }, // gitleaks:allow (test fixture)
  xai: { XAI_API_KEY: 'fixture-xai-0123456789abcdef' }, // gitleaks:allow (test fixture)
  moonshot: { MOONSHOT_API_KEY: 'fixture-moonshot-0123456789abcdef' }, // gitleaks:allow (test fixture)
  gateway: { MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'fixture-gateway-0123456789abcdef' }, // gitleaks:allow (test fixture)
};

const gemini = (model: string) => new Gemini({ model, apiKey: FAKE.gemini });

// ── One provider per test: the field on the wire ─────────────────────────────

test('Gemini 3: a level travels as generationConfig.thinkingConfig.thinkingLevel', async () => {
  const body = await wire(() => gemini('gemini-3.8-flash'), 'gemini-3.8-flash', 'medium');
  assert.deepStrictEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'MEDIUM' });
  // The effort word compiled for the gateway never reaches Gemini.
  assert.ok(!JSON.stringify(body).includes('reasoningEffort'));

  assert.deepStrictEqual((await wire(() => gemini('gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite', 'none')).generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });
  // An explicit budget is sent as one; 0 is `none`.
  assert.deepStrictEqual((await wire(() => gemini('gemini-3.8-flash'), 'gemini-3.8-flash', { budget_tokens: 3000 })).generationConfig.thinkingConfig, { thinkingBudget: 3000 });
  assert.deepStrictEqual((await wire(() => gemini('gemini-3.8-flash'), 'gemini-3.8-flash', { budget_tokens: 0 })).generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });
});

test('Gemini 2.x: a level travels as a thinkingBudget, the only form those ids take', async () => {
  const body = await wire(() => gemini('gemini-2.5-flash'), 'gemini-2.5-flash', 'low');
  assert.deepStrictEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 2048 });
});

test('Claude: a level travels as the extended-thinking budget', async () => {
  const body = await wire(() => new ClaudeLlm({ model: 'claude-sonnet-4-6' }), 'claude-sonnet-4-6', 'medium', FAKE.anthropic);
  assert.deepStrictEqual(body.thinking, { type: 'enabled', budget_tokens: 8192 });

  assert.deepStrictEqual((await wire(() => new ClaudeLlm({ model: 'claude-sonnet-4-6' }), 'claude-sonnet-4-6', { budget_tokens: 5000 }, FAKE.anthropic)).thinking, { type: 'enabled', budget_tokens: 5000 });
  assert.ok(!('thinking' in (await wire(() => new ClaudeLlm({ model: 'claude-sonnet-4-6' }), 'claude-sonnet-4-6', 'none', FAKE.anthropic))));
});

test('GPT: a level travels as reasoning.effort beside the summary', async () => {
  const body = await wire(() => new GptLlm({ model: 'gpt-5-mini' }), 'gpt-5-mini', 'high', FAKE.openai);
  assert.deepStrictEqual(body.reasoning, { summary: 'auto', effort: 'high' });

  const effort = async (model: string, reasoning: unknown) => (await wire(() => new GptLlm({ model }), model, reasoning, FAKE.openai)).reasoning;
  // `none` in each generation's own word.
  assert.strictEqual((await effort('gpt-5-mini', 'none')).effort, 'minimal');
  assert.strictEqual((await effort('gpt-5.4', 'none')).effort, 'none');
  assert.strictEqual((await effort('o4-mini', 'none')).effort, 'low');
  // A budget rounds up to the level that covers it.
  assert.strictEqual((await effort('gpt-5-mini', { budget_tokens: 3000 })).effort, 'medium');
  // Unset: the summary alone, as before.
  assert.deepStrictEqual(await effort('gpt-5-mini', undefined), { summary: 'auto' });
});

test('Grok: a level replaces the pinned effort; unset keeps the pin', async () => {
  const body = await wire(() => new GrokLlm({ model: 'grok-4.7' }), 'grok-4.7', 'high', FAKE.xai);
  assert.deepStrictEqual(body.reasoning, { effort: 'high' });

  assert.deepStrictEqual((await wire(() => new GrokLlm({ model: 'grok-4.7' }), 'grok-4.7', undefined, FAKE.xai)).reasoning, { effort: 'medium' });
  // Grok 4.5/4.7 cannot stop reasoning: `none` is its lowest effort.
  assert.deepStrictEqual((await wire(() => new GrokLlm({ model: 'grok-4.5' }), 'grok-4.5', 'none', FAKE.xai)).reasoning, { effort: 'low' });
  // So is the older spelling's `none`, which xAI would reject.
  const older = (new GrokLlm({ model: 'grok-4.7' }) as any).reasoningParam({ config: { reasoningEffort: 'none' } });
  assert.deepStrictEqual(older, { effort: 'low' });
});

test('Kimi: a level travels as reasoning_effort on K3, as the thinking switch on K2.x', async () => {
  const body = await wire(() => new KimiLlm({ model: 'kimi-k3' }), 'kimi-k3', 'low', FAKE.moonshot);
  assert.strictEqual(body.reasoning_effort, 'low');

  // K3 has low | high | max: medium is sent as its nearest setting above.
  assert.strictEqual((await wire(() => new KimiLlm({ model: 'kimi-k3' }), 'kimi-k3', 'medium', FAKE.moonshot)).reasoning_effort, 'high');
  const k2 = await wire(() => new KimiLlm({ model: 'kimi-k2.6' }), 'kimi-k2.6', 'none', FAKE.moonshot);
  assert.deepStrictEqual(k2.thinking, { type: 'disabled' });
  assert.ok(!('reasoning_effort' in k2));
});

test('Ollama: a level travels as reasoning_effort', async () => {
  const body = await wire(() => new OllamaLlm({ model: 'ollama/qwen3:8b' }), 'ollama/qwen3:8b', 'none');
  assert.strictEqual(body.reasoning_effort, 'none');
});

test('Gateway: any id carries its level as reasoning_effort, Claude included', async () => {
  // A thinking budget has no chat-completions form; the effort word is what travels.
  const body = await wire(() => new GatewayLlm({ model: 'claude-sonnet-4-6' }), 'claude-sonnet-4-6', 'medium', FAKE.gateway);
  assert.strictEqual(body.reasoning_effort, 'medium');
  assert.ok(!('thinking' in body));
});

// ── What the key asks of the model (the capability matrix, ADR 0019) ────────

test('requiredCapabilities reads reasoning: an agent with tools that thinks needs thinking with tools', () => {
  const thinksWithTools = (reasoning: any) => requiredCapabilities({ tools: ['web_extract'], reasoning }).includes('thinking_with_tools');
  assert.ok(thinksWithTools('low'));
  assert.ok(thinksWithTools({ budget_tokens: 1024 }));
  assert.ok(!thinksWithTools('none'));
  assert.ok(!thinksWithTools({ budget_tokens: 0 }));
  assert.deepStrictEqual(requiredCapabilities({ reasoning: 'high' }), [], 'no tools, nothing to lose');
});

test('the doctor reports the gap for a thinking Claude agent declared with reasoning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-reasoning-'));
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    fs.writeFileSync(
      path.join(dir, 'thinker.yaml'),
      ['syndicate_name: Thinker', 'orchestrator:', '  name: Lead', '  model: claude-sonnet-4-6', '  instruction: x', '  reasoning: medium', '  tools: [web_extract]'].join('\n'),
    );
    process.env.ANTHROPIC_API_KEY = FAKE.anthropic.ANTHROPIC_API_KEY;
    const row = runDoctor({ agentsDir: dir }).syndicates.find((s) => s.file === 'thinker.yaml')!.rows[0];
    assert.deepStrictEqual(row.gaps.map((g) => `${g.capability}:${g.support}`), ['thinking_with_tools:unsupported']);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
