/**
 * tests/toolChoiceEffort.test.ts — the v2 keys for a tool choice and for the
 * effort words above `high` (ADR 0117).
 *
 *   - `tool_choice:` loads, folds into the engine form, and refuses its v1
 *     spelling beside it.
 *   - `reasoning: xhigh | max` reaches each provider as its own word, held
 *     at the model's ceiling where it has none (effortCeiling, effortWord).
 *   - The codemod identity on each provider's wire: every file in
 *     tests/fixtures/v1-tool-choice/ migrates with nothing left under
 *     generateContentConfig, and every agent posts the same request body to
 *     its provider before and after (captured over a stubbed fetch, no
 *     provider called).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

import { functionCallingConfigOf, toEngineAgent } from '../lib/agentDialect.ts';
import { compileSpec, compileSubagentSpec, type AgentSpec } from '../lib/compile.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { CAPABILITY_MATRIX, REASONING_ABOVE_HIGH, renderCapabilityMatrix } from '../lib/models/capabilities.ts';
import type { ModelRequest, ReasoningSetting } from '../lib/models/contract.ts';
import { toolChoiceOf } from '../lib/models/genaiMapping.ts';
import { providerForModel } from '../lib/models/providerMap.ts';
import { effortCeiling, effortWord } from '../lib/models/reasoning.ts';
import { buildModelRequest } from '../lib/runtime/native/request.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { SyndicateValidationError, validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { migrateYaml } from '../scripts/yaml_codemod.ts';
import { capture, geminiExchange, type AdapterRow } from './helpers/capabilityInputs.ts';

process.env.OTEL_CONSOLE_SPANS = 'false';

type Json = Record<string, any>;

const syndicate = (agent: Json, sub?: Json): Json => ({
  syndicate_name: 't',
  orchestrator: { name: 'a', model: 'gemini-3.8-flash', instruction: 'hi', ...agent },
  subagents: sub ? [{ name: 's', description: 'd', ...sub }] : [],
});

const problems = (raw: Json): string[] => {
  try {
    validateSyndicateConfig(raw, 'x.yaml');
    return [];
  } catch (err) {
    if (err instanceof SyndicateValidationError) return err.message.split('\n');
    throw err;
  }
};

// ── tool_choice: the key ─────────────────────────────────────────────────────

test('tool_choice folds into the function-calling config the engine reads', () => {
  const cases: Array<[unknown, Json, unknown]> = [
    ['auto', { mode: 'AUTO' }, undefined],
    ['none', { mode: 'NONE' }, 'none'],
    ['required', { mode: 'ANY' }, 'required'],
    [{ name: 'lookup' }, { mode: 'ANY', allowedFunctionNames: ['lookup'] }, { name: 'lookup' }],
  ];
  for (const [choice, fcc, read] of cases) {
    assert.deepEqual(functionCallingConfigOf(choice), fcc);
    const cfg = validateSyndicateConfig(syndicate({ tool_choice: choice, sampling: { temperature: 0 } }), 'x.yaml');
    const o = cfg.orchestrator as Json;
    assert.equal(o.tool_choice, undefined, 'the loader hands downstream the engine form');
    assert.deepEqual(o.generateContentConfig, { temperature: 0, toolConfig: { functionCallingConfig: fcc } });
    assert.deepEqual(toolChoiceOf(o.generateContentConfig).toolChoice, read);
  }
  // Beside other toolConfig keys, which it keeps; the caller's object is not written to.
  const agent = { name: 'a', tool_choice: 'none', generateContentConfig: { toolConfig: { includeServerSideToolInvocations: true } } };
  const engine = toEngineAgent(agent) as Json;
  assert.deepEqual(engine.generateContentConfig, { toolConfig: { includeServerSideToolInvocations: true, functionCallingConfig: { mode: 'NONE' } } });
  assert.deepEqual(agent.generateContentConfig, { toolConfig: { includeServerSideToolInvocations: true } });
  assert.equal(toEngineAgent(engine), engine, 'idempotent');
});

test('tool_choice is refused beside its v1 spelling, on a nested agent, and when misspelled', () => {
  const both = problems(syndicate({ tool_choice: 'none', generateContentConfig: { toolConfig: { functionCallingConfig: { mode: 'ANY' } } } }));
  assert.ok(both.some((p) => /orchestrator\.tool_choice — cannot be combined with generateContentConfig\.toolConfig\.functionCallingConfig/.test(p)), both.join('\n'));
  assert.throws(
    () => toEngineAgent({ name: 'a', tool_choice: 'none', generateContentConfig: { toolConfig: { functionCallingConfig: { mode: 'ANY' } } } }),
    /a: tool_choice cannot be combined with generateContentConfig\.toolConfig\.functionCallingConfig/,
  );

  const nested = problems(syndicate({}, { yaml_reference: 'other.yaml', tool_choice: 'none' }));
  assert.ok(nested.some((p) => /subagents\[0\]\.tool_choice — applies to an inline agent/.test(p)), nested.join('\n'));

  const typo = problems(syndicate({ tool_choice: 'requird' }));
  assert.ok(typo.some((p) => /must be one of auto \| none \| required, or \{ name: <tool> \} \(got "requird" — did you mean "required"\?\)/.test(p)), typo.join('\n'));
  for (const bad of [{ name: '' }, { only: ['a'] }, ['a'], 3]) assert.ok(problems(syndicate({ tool_choice: bad })).length > 0, JSON.stringify(bad));
});

// ── xhigh and max ────────────────────────────────────────────────────────────

test('each model has an effort ceiling, and a word above it is held there and reported', () => {
  const ceilings: Array<[string, string]> = [
    ['claude-opus-5-5', 'max'],
    ['claude-sonnet-4-6', 'max'], // the Claude adapter holds its budget generations itself
    ['kimi-k3', 'max'],
    ['gpt-5.4', 'xhigh'],
    ['gpt-5.2', 'xhigh'],
    ['gpt-6', 'xhigh'],
    ['gpt-5.1', 'high'],
    ['gpt-5-mini', 'high'],
    ['o4-mini', 'high'],
    ['grok-4.7', 'xhigh'],
    ['grok-4.5', 'high'],
    ['ollama/qwen3:8b', 'high'],
    ['gemini-3.8-flash', 'high'],
  ];
  for (const [model, top] of ceilings) assert.equal(effortCeiling(model), top, model);

  const word = (model: string, s: ReasoningSetting, ceiling?: 'high') => effortWord(model, s, ceiling);
  assert.deepEqual(word('gpt-5.4', 'max'), { word: 'xhigh', weakened: 'max' });
  assert.deepEqual(word('gpt-5.4', 'xhigh'), { word: 'xhigh' });
  assert.deepEqual(word('gpt-5-mini', 'xhigh'), { word: 'high', weakened: 'xhigh' });
  assert.deepEqual(word('kimi-k3', 'xhigh'), { word: 'max' }, 'K3 has no xhigh: it rounds up, which is not a weakening');
  assert.deepEqual(word('kimi-k3', 'max'), { word: 'max' });
  assert.deepEqual(word('kimi-k3', 'medium'), { word: 'high' });
  assert.deepEqual(word('claude-opus-5-5', 'max', 'high'), { word: 'high', weakened: 'max' }, 'the gateway holds every id at high');
  assert.deepEqual(word('gpt-5', 'none'), { word: 'minimal' }, 'the levels up to high are unchanged');
});

/** The fields that carry reasoning in each wire dialect. */
function effortOnWire(row: AdapterRow | 'gemini', body: Json): unknown {
  switch (row) {
    case 'anthropic':
      return { thinking: body.thinking, effort: body.output_config?.effort, budget: body.thinking?.budget_tokens };
    case 'openai':
    case 'xai':
      return body.reasoning?.effort;
    case 'gemini':
      return body.generationConfig?.thinkingConfig;
    default:
      return body.reasoning_effort;
  }
}

const hello = (model: string, reasoning: ReasoningSetting): ModelRequest => ({
  model,
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
  reasoning,
});

async function wire(model: string, req: ModelRequest, row: AdapterRow | 'gemini' = rowOf(model)): Promise<Json> {
  return row === 'gemini' ? (await geminiExchange(req)).body : capture(row, req, false, model);
}

function rowOf(model: string): AdapterRow | 'gemini' {
  const p = providerForModel(model);
  return p as AdapterRow | 'gemini';
}

test('reasoning: xhigh and max on the wire of every provider', async () => {
  const cases: Array<[string, ReasoningSetting, unknown, (AdapterRow | 'gemini')?]> = [
    ['claude-opus-5-5', 'max', { thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } }, effort: 'max', budget: undefined }],
    ['claude-opus-5-5', 'xhigh', { thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } }, effort: 'xhigh', budget: undefined }],
    ['claude-sonnet-4-6', 'max', { thinking: { type: 'enabled', budget_tokens: 16384 }, effort: undefined, budget: 16384 }],
    ['gpt-5.4', 'max', 'xhigh'],
    ['gpt-5.4', 'xhigh', 'xhigh'],
    ['gpt-5-mini', 'max', 'high'],
    ['grok-4.7', 'xhigh', 'xhigh'],
    ['grok-4.7', 'max', 'xhigh'],
    ['grok-4.5', 'max', 'high'],
    ['kimi-k3', 'max', 'max'],
    ['kimi-k3', 'xhigh', 'max'],
    ['ollama/qwen3:8b', 'max', 'high'],
    ['claude-sonnet-4-6', 'max', 'high', 'gateway'],
    ['kimi-k3', 'max', 'high', 'gateway'],
    ['gemini-3.8-flash', 'max', { thinkingLevel: 'HIGH', includeThoughts: true }],
    ['gemini-2.5-flash', 'xhigh', { thinkingBudget: 16384, includeThoughts: true }],
  ];
  for (const [model, setting, expected, via] of cases) {
    const row = via ?? rowOf(model);
    const body = await wire(model, hello(model, setting), row);
    assert.deepEqual(effortOnWire(row, body), expected, `${model} ${setting} via ${row}`);
  }
});

test('the capability matrix states the levels above high for every row, and renders them', () => {
  assert.deepEqual(Object.keys(REASONING_ABOVE_HIGH).sort(), Object.keys(CAPABILITY_MATRIX).sort());
  const md = renderCapabilityMatrix();
  assert.match(md, /\*\*Reasoning above high\*\* \(ADR 0117\)/);
  for (const text of Object.values(REASONING_ABOVE_HIGH)) assert.ok(md.includes(text), text);
});

// ── The codemod identity, on each provider's wire ────────────────────────────

const CORPUS = join(process.cwd(), 'tests', 'fixtures', 'v1-tool-choice');
const corpusFiles = readdirSync(CORPUS).filter((f) => f.endsWith('.yaml')).sort();

const OFFLINE = { resolveModel: (m: string | undefined) => m, onUnknownTool: () => {} };

/** Two tools, so a forced or named choice has something to choose. */
const TOOLS: ModelRequest['tools'] = [
  { name: 'lookup', description: 'Look a thing up.', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'fetch', description: 'Fetch a page.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];

/** The ModelRequest the engine builds for a spec, with the two tools beside it. */
async function requestOf(spec: AgentSpec): Promise<ModelRequest> {
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: 'codemod', userId: 'u', sessionId: 's' });
  const agent = { name: spec.name, model: spec.modelId!, generateContentConfig: spec.generateContentConfig };
  const built = await buildModelRequest(agent, { session, invocationId: 'e-1' });
  return { ...built.request, messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], tools: TOOLS };
}

test('every v1 tool-choice fixture converts fully, and each agent sends its provider the same request', async (t) => {
  assert.equal(corpusFiles.length, 3);
  for (const file of corpusFiles) {
    await t.test(file, async () => {
      const v1Text = readFileSync(join(CORPUS, file), 'utf8');
      const migrated = migrateYaml(v1Text);
      assert.equal(migrated.changed, true);
      const again = migrateYaml(migrated.text);
      assert.deepEqual({ text: again.text, changed: again.changed, notes: again.notes }, { text: migrated.text, changed: false, notes: [] }, 'idempotent');
      for (const note of migrated.notes) assert.match(note, /includeThoughts: read by nothing|allowedFunctionNames: several names/, note);

      const v2Raw = parse(migrated.text) as Json;
      for (const agent of [v2Raw.orchestrator, ...(v2Raw.subagents ?? [])] as Json[]) {
        assert.equal(agent.generateContentConfig, undefined, `${agent.name}: converted fully`);
      }

      const v1 = validateSyndicateConfig(parse(v1Text), file) as SyndicateYamlConfig;
      const v2 = validateSyndicateConfig(v2Raw, file) as SyndicateYamlConfig;
      const pairs: Array<[AgentSpec, AgentSpec]> = [[await compileSpec(v1, { ...OFFLINE }), await compileSpec(v2, { ...OFFLINE })]];
      for (const [i, sub] of (v1.subagents ?? []).entries()) {
        pairs.push([await compileSubagentSpec(sub as SubagentYamlConfig, { ...OFFLINE }), await compileSubagentSpec(v2.subagents![i] as SubagentYamlConfig, { ...OFFLINE })]);
      }
      for (const [before, after] of pairs) {
        const where = `${file} ${before.name} (${before.modelId})`;
        const [reqBefore, reqAfter] = [await requestOf(before), await requestOf(after)];
        assert.deepStrictEqual(reqAfter, reqBefore, `${where}: model request`);
        assert.deepStrictEqual(await wire(before.modelId!, reqAfter), await wire(before.modelId!, reqBefore), `${where}: wire body`);
      }
    });
  }
});

test('the fixtures reach the wire as they say: tool choice and effort per provider', async () => {
  const sent = async (file: string, name: string) => {
    const cfg = validateSyndicateConfig(parse(migrateYaml(readFileSync(join(CORPUS, file), 'utf8')).text), file) as SyndicateYamlConfig;
    const yaml = [cfg.orchestrator, ...(cfg.subagents ?? [])].find((a) => a.name === name)!;
    const spec = yaml === cfg.orchestrator ? await compileSpec(cfg, { ...OFFLINE }) : await compileSubagentSpec(yaml as SubagentYamlConfig, { ...OFFLINE });
    const model = spec.modelId!;
    const row = rowOf(model);
    return { row, body: await wire(model, await requestOf(spec)) };
  };

  const desk = await sent('gemini.yaml', 'Desk');
  assert.deepEqual(desk.body.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] } });
  assert.deepEqual(effortOnWire('gemini', desk.body), { thinkingLevel: 'HIGH', includeThoughts: true });
  const summary = await sent('gemini.yaml', 'Summary');
  assert.deepEqual(summary.body.toolConfig, { functionCallingConfig: { mode: 'NONE' } });

  const planner = await sent('claude.yaml', 'Planner');
  assert.equal(planner.body.output_config?.effort, 'max');
  assert.equal(planner.body.tool_choice, undefined, 'auto is the default');
  const checker = await sent('claude.yaml', 'Checker');
  assert.deepEqual(checker.body.thinking, { type: 'enabled', budget_tokens: 16384 }, 'Sonnet 4.6 takes a budget: xhigh goes as high\'s');

  const lead = await sent('effort.yaml', 'Lead');
  assert.equal(lead.body.reasoning_effort, 'max', 'Kimi K3 is sent max again (ADR 0117)');
  assert.equal(lead.body.tool_choice, 'required', 'K3 refuses a named tool while it thinks: the choice goes as required');
  const coder = await sent('effort.yaml', 'Coder');
  assert.equal(coder.body.reasoning?.effort, 'xhigh');
  assert.equal(coder.body.tool_choice, 'none');
  assert.equal((await sent('effort.yaml', 'Older')).body.reasoning?.effort, 'high');
  const scout = await sent('effort.yaml', 'Scout');
  assert.equal(scout.body.reasoning?.effort, 'xhigh');
  assert.equal(scout.body.tool_choice, 'required');
  assert.equal((await sent('effort.yaml', 'Local')).body.reasoning_effort, 'high');
});
