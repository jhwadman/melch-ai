/**
 * tests/reasoningKey.test.ts — the provider-neutral `reasoning:` key
 * (ADR 0047), from the YAML to the field each provider receives.
 *
 * Every case validates a one-agent syndicate, takes the agent's `reasoning:`
 * as the ModelRequest's `reasoning` (what the runtime hands the adapter),
 * and sends it through that provider's contract adapter, asserting the
 * request body on the wire. Gemini goes through the engine's GeminiAdapter.
 *
 * Offline: tests/helpers/capabilityInputs.ts stubs fetch to record the
 * request and answer 400, so no provider is called. Keys are fixture values
 * set only for the duration of each capture.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDoctor } from '../lib/doctor.ts';
import { requiredCapabilities } from '../lib/models/capabilities.ts';
import type { ModelRequest, ReasoningSetting } from '../lib/models/contract.ts';
import { GeminiAdapter } from '../lib/models/geminiAdapter.ts';
import { GrokAdapter } from '../lib/models/grokAdapter.ts';
import { reasoningOf } from '../lib/models/genaiMapping.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { capture, captureBody, FAKE_ENV } from './helpers/capabilityInputs.ts';
import type { AdapterRow } from './helpers/capabilityInputs.ts';

process.env.OTEL_CONSOLE_SPANS = 'false';

// ── Harness ──────────────────────────────────────────────────────────────────

/** The `reasoning:` an agent with this model declares, as the validated YAML holds it. */
function declared(model: string, reasoning?: unknown): ReasoningSetting | undefined {
  const raw = {
    syndicate_name: 'Reasoning',
    orchestrator: { name: 'Agent', model, instruction: 'Answer.', ...(reasoning === undefined ? {} : { reasoning }) },
  };
  return validateSyndicateConfig(raw, 'reasoning.yaml').orchestrator.reasoning as ReasoningSetting | undefined;
}

function request(model: string, reasoning: unknown): ModelRequest {
  const setting = declared(model, reasoning);
  return { model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], ...(setting !== undefined ? { reasoning: setting } : {}) };
}

/** The JSON body the row's contract adapter posts for an agent with this model and `reasoning:`. */
const wire = (row: AdapterRow, model: string, reasoning: unknown): Promise<any> => capture(row, request(model, reasoning));

/** The same through the contract's Gemini. */
const gemini = (model: string, reasoning: unknown): Promise<any> => {
  const req = request(model, reasoning);
  return captureBody('gemini', () => new GeminiAdapter({ model }).generate(req));
};

// ── One provider per test: the field on the wire ─────────────────────────────

test('Gemini 3: a level travels as generationConfig.thinkingConfig.thinkingLevel', async () => {
  const body = await gemini('gemini-3.8-flash', 'medium');
  assert.deepStrictEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'MEDIUM', includeThoughts: true });
  // The effort word the gateway would get never reaches Gemini.
  assert.ok(!JSON.stringify(body).includes('reasoningEffort'));

  assert.deepStrictEqual((await gemini('gemini-3.5-flash-lite', 'none')).generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });
  // An explicit budget is sent as one; 0 is `none`. The thinking is asked for back except under `none`.
  assert.deepStrictEqual((await gemini('gemini-3.8-flash', { budget_tokens: 3000 })).generationConfig.thinkingConfig, { thinkingBudget: 3000, includeThoughts: true });
  assert.deepStrictEqual((await gemini('gemini-3.8-flash', { budget_tokens: 0 })).generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });
});

test('Gemini 2.x: a level travels as a thinkingBudget, the only form those ids take', async () => {
  const body = await gemini('gemini-2.5-flash', 'low');
  assert.deepStrictEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 2048, includeThoughts: true });
});

test('Claude: a level travels as the extended-thinking budget', async () => {
  const body = await wire('anthropic', 'claude-sonnet-4-6', 'medium');
  assert.deepStrictEqual(body.thinking, { type: 'enabled', budget_tokens: 8192 });

  assert.deepStrictEqual((await wire('anthropic', 'claude-sonnet-4-6', { budget_tokens: 5000 })).thinking, { type: 'enabled', budget_tokens: 5000 });
  assert.ok(!('thinking' in (await wire('anthropic', 'claude-sonnet-4-6', 'none'))));
});

test('GPT: a level travels as reasoning.effort beside the summary', async () => {
  const body = await wire('openai', 'gpt-5-mini', 'high');
  assert.deepStrictEqual(body.reasoning, { summary: 'auto', effort: 'high' });

  const effort = async (model: string, reasoning: unknown) => (await wire('openai', model, reasoning)).reasoning;
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
  const body = await wire('xai', 'grok-4.7', 'high');
  assert.deepStrictEqual(body.reasoning, { effort: 'high' });

  assert.deepStrictEqual((await wire('xai', 'grok-4.7', undefined)).reasoning, { effort: 'medium' });
  // Grok 4.5/4.7 cannot stop reasoning: `none` is its lowest effort.
  assert.deepStrictEqual((await wire('xai', 'grok-4.5', 'none')).reasoning, { effort: 'low' });
  // So is the older spelling's `none`, which xAI would reject: reasoningOf reads it as `none`.
  const older = new GrokAdapter({ model: 'grok-4.7', apiKey: FAKE_ENV.xai.XAI_API_KEY }).reasoningParam(reasoningOf({ reasoningEffort: 'none' } as any));
  assert.deepStrictEqual(older, { effort: 'low' });
});

test('Kimi: a level travels as reasoning_effort on K3, as the thinking switch on K2.x', async () => {
  const body = await wire('moonshot', 'kimi-k3', 'low');
  assert.strictEqual(body.reasoning_effort, 'low');

  // K3 has low | high | max: medium is sent as its nearest setting above.
  assert.strictEqual((await wire('moonshot', 'kimi-k3', 'medium')).reasoning_effort, 'high');
  const k2 = await wire('moonshot', 'kimi-k2.6', 'none');
  assert.deepStrictEqual(k2.thinking, { type: 'disabled' });
  assert.ok(!('reasoning_effort' in k2));
});

test('Ollama: a level travels as reasoning_effort', async () => {
  const body = await wire('ollama', 'ollama/qwen3:8b', 'none');
  assert.strictEqual(body.reasoning_effort, 'none');
});

test('Gateway: any id carries its level as reasoning_effort, Claude included', async () => {
  // A thinking budget has no chat-completions form; the effort word is what travels.
  const body = await wire('gateway', 'claude-sonnet-4-6', 'medium');
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

test('the doctor reads reasoning: a thinking agent with tools gets its path\'s gap', () => {
  // The doctor must see `reasoning:` as thinking. Ollama's chat-completions
  // path keeps thinking with tools degraded, so the gap shows there; Claude
  // replays signed thinking on the tool loop (ADR 0046), so the same agent on
  // Claude has none.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-reasoning-'));
  const saved = process.env.ANTHROPIC_API_KEY;
  const agent = (model: string) =>
    ['syndicate_name: Thinker', 'orchestrator:', '  name: Lead', `  model: ${model}`, '  instruction: x', '  reasoning: medium', '  tools: [web_extract]'].join('\n');
  try {
    fs.writeFileSync(path.join(dir, 'local.yaml'), agent('ollama/qwen3:8b'));
    fs.writeFileSync(path.join(dir, 'claude.yaml'), agent('claude-sonnet-4-6'));
    process.env.ANTHROPIC_API_KEY = FAKE_ENV.anthropic.ANTHROPIC_API_KEY;
    const rows = runDoctor({ agentsDir: dir }).syndicates;
    const gaps = (file: string) => rows.find((s) => s.file === file)!.rows[0].gaps.map((g) => `${g.capability}:${g.support}`);
    assert.deepStrictEqual(gaps('local.yaml'), ['thinking_with_tools:degraded']);
    assert.deepStrictEqual(gaps('claude.yaml'), []);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
