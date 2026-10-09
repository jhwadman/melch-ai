/**
 * tests/agentDialect.test.ts — YAML schema v2 (ADR 0115): `sampling`,
 * `output` and `model_overrides`, the engine form they map to, the refusals,
 * and the loader's one-line deprecation warning for the v1 spellings.
 *
 * Offline: models resolve to their own ids, no provider is called.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { instructionFor, toEngineAgent, v1SpellingsOf } from '../lib/agentDialect.ts';
import { compileSpec, compileSubagentSpec } from '../lib/compile.ts';
import type { CompileOptions } from '../lib/compile.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { SyndicateValidationError, syndicateJsonSchema, validateSyndicateConfig } from '../lib/syndicateSchema.ts';

const OFFLINE: CompileOptions = { resolveModel: (m) => m, onUnknownTool: () => {} };
const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };

const syndicate = (orchestrator: Record<string, unknown>, subagents?: unknown[]) => ({
  syndicate_name: 'Dialect',
  orchestrator: { name: 'Agent', model: 'gemini-2.5-flash', instruction: 'Answer.', ...orchestrator },
  ...(subagents ? { subagents } : {}),
});

const v1Agent = {
  generateContentConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 512, stopSequences: ['END'], responseMimeType: 'application/json', topK: 40 },
  outputSchema: SCHEMA,
};
const v2Agent = {
  sampling: { temperature: 0.2, top_p: 0.9, max_output_tokens: 512, stop: ['END'] },
  output: { schema: SCHEMA, mime: 'application/json' },
  generateContentConfig: { topK: 40 },
};

/** The problems a config is refused with. */
function problems(raw: unknown): string[] {
  try {
    validateSyndicateConfig(raw, 'dialect.yaml');
  } catch (err) {
    assert.ok(err instanceof SyndicateValidationError);
    return err.issues;
  }
  return [];
}

// ── Mapping ──────────────────────────────────────────────────────────────────

test('a v2 agent validates to exactly the engine form of the same v1 agent', () => {
  const v1 = validateSyndicateConfig(syndicate(structuredClone(v1Agent)), 'v1.yaml');
  const v2 = validateSyndicateConfig(syndicate(structuredClone(v2Agent)), 'v2.yaml');
  assert.deepStrictEqual(v2, v1);
  assert.strictEqual('sampling' in v2.orchestrator, false);
  assert.strictEqual('output' in v2.orchestrator, false);
});

test('an inline v2 subagent maps too', () => {
  const sub = (fields: object) => ({ name: 'Helper', description: 'Helps', instruction: 'Help.', ...structuredClone(fields) });
  const v1 = validateSyndicateConfig(syndicate({}, [sub(v1Agent)]), 'v1.yaml');
  const v2 = validateSyndicateConfig(syndicate({}, [sub(v2Agent)]), 'v2.yaml');
  assert.deepStrictEqual(v2, v1);
});

test('compileSpec gives the same AgentSpec for the v1 and v2 spelling', async () => {
  const v1 = await compileSpec(validateSyndicateConfig(syndicate(structuredClone(v1Agent)), 'v1.yaml'), OFFLINE);
  const v2 = await compileSpec(validateSyndicateConfig(syndicate(structuredClone(v2Agent)), 'v2.yaml'), OFFLINE);
  assert.deepStrictEqual(v2, v1);
  // A config built in code, never validated: compile maps it itself.
  const coded = await compileSpec(syndicate(structuredClone(v2Agent), []) as unknown as SyndicateYamlConfig, OFFLINE);
  assert.deepStrictEqual(coded, v1);
  const sub = await compileSubagentSpec({ name: 'Agent', description: 'x', model: 'gemini-2.5-flash', instruction: 'Answer.', ...structuredClone(v2Agent) } as unknown as SubagentYamlConfig, OFFLINE);
  const subV1 = await compileSubagentSpec({ name: 'Agent', description: 'x', model: 'gemini-2.5-flash', instruction: 'Answer.', ...structuredClone(v1Agent) } as unknown as SubagentYamlConfig, OFFLINE);
  assert.deepStrictEqual(sub, subV1);
});

test('v2 keys mix with the v1 keys they do not replace', () => {
  const cfg = validateSyndicateConfig(syndicate({ sampling: { temperature: 0 }, generateContentConfig: { toolConfig: { functionCallingConfig: { mode: 'ANY' } } } }), 'mix.yaml');
  assert.deepStrictEqual(cfg.orchestrator.generateContentConfig, { toolConfig: { functionCallingConfig: { mode: 'ANY' } }, temperature: 0 });
});

test('toEngineAgent is idempotent, keeps model_overrides, and is the identity without v2 keys', () => {
  const plain = { name: 'A', instruction: 'x', generateContentConfig: { temperature: 1 } };
  assert.strictEqual(toEngineAgent(plain), plain);
  const once = toEngineAgent({ name: 'A', sampling: { temperature: 1 }, model_overrides: { anthropic: { instruction: 'y' } } });
  assert.deepStrictEqual(once, { name: 'A', generateContentConfig: { temperature: 1 }, model_overrides: { anthropic: { instruction: 'y' } } });
  assert.strictEqual(toEngineAgent(once), once);
});

test('toEngineAgent throws on a conflict, naming both keys', () => {
  assert.throws(
    () => toEngineAgent({ name: 'A', sampling: { temperature: 1 }, generateContentConfig: { temperature: 0.5 } }),
    /A: sampling\.temperature cannot be combined with generateContentConfig\.temperature/,
  );
  assert.throws(() => toEngineAgent({ name: 'A', output: { schema: {} }, outputSchema: {} }), /output\.schema cannot be combined with outputSchema/);
});

// ── Refusals ─────────────────────────────────────────────────────────────────

test('each v2 key next to the v1 key it replaces is refused, naming both', () => {
  const pairs: Array<[Record<string, unknown>, string, string]> = [
    [{ sampling: { temperature: 1 }, generateContentConfig: { temperature: 1 } }, 'sampling.temperature', 'generateContentConfig.temperature'],
    [{ sampling: { top_p: 1 }, generateContentConfig: { topP: 1 } }, 'sampling.top_p', 'generateContentConfig.topP'],
    [{ sampling: { max_output_tokens: 9 }, generateContentConfig: { maxOutputTokens: 9 } }, 'sampling.max_output_tokens', 'generateContentConfig.maxOutputTokens'],
    [{ sampling: { stop: ['x'] }, generateContentConfig: { stopSequences: ['x'] } }, 'sampling.stop', 'generateContentConfig.stopSequences'],
    [{ output: { schema: SCHEMA }, outputSchema: SCHEMA }, 'output.schema', 'outputSchema'],
    [{ output: { mime: 'text/plain' }, generateContentConfig: { responseMimeType: 'text/plain' } }, 'output.mime', 'generateContentConfig.responseMimeType'],
  ];
  for (const [fields, v2, v1] of pairs) {
    assert.deepStrictEqual(problems(syndicate(fields)), [`orchestrator.${v2} — cannot be combined with ${v1}; ${v2} replaces it, so keep one (ADR 0115)`]);
  }
});

test('v2 keys on a yaml_reference or a2a_agent_url subagent are refused', () => {
  for (const [key, value] of [['sampling', { temperature: 1 }], ['output', { mime: 'text/plain' }], ['model_overrides', { gemini: { instruction: 'x' } }]] as const) {
    for (const ref of [{ yaml_reference: 'research.yaml' }, { a2a_agent_url: 'https://agent.example.com' }]) {
      const out = problems(syndicate({}, [{ name: 'Nested', description: 'Nested', ...ref, [key]: value }]));
      assert.deepStrictEqual(out, [`subagents[0].${key} — applies to an inline agent; a nested syndicate (yaml_reference) or a remote agent (a2a_agent_url) sets its own`]);
    }
  }
});

test('the v2 blocks are strict, non-empty, and suggest the key meant', () => {
  assert.deepStrictEqual(problems(syndicate({ sampling: { topP: 0.5 } })), ['orchestrator.sampling.topP — unknown key (did you mean "top_p"?)']);
  assert.deepStrictEqual(problems(syndicate({ output: { shema: {} } })), ['orchestrator.output.shema — unknown key (did you mean "schema"?)']);
  assert.deepStrictEqual(problems(syndicate({ model_overrides: { antropic: { instruction: 'x' } } })), ['orchestrator.model_overrides.antropic — unknown key (did you mean "anthropic"?)']);
  assert.deepStrictEqual(problems(syndicate({ model_overrides: { xai: { instructions: 'x' } } })).slice(0, 1), ['orchestrator.model_overrides.xai.instructions — unknown key (did you mean "instruction"?)']);
  assert.ok(problems(syndicate({ sampling: {} }))[0]?.startsWith('orchestrator.sampling — must set at least one'));
  assert.ok(problems(syndicate({ output: {} }))[0]?.startsWith('orchestrator.output — must set schema or mime'));
  assert.ok(problems(syndicate({ output: { mime: 'text/html' } }))[0]?.startsWith('orchestrator.output.mime — must be one of application/json | text/plain'));
  assert.deepStrictEqual(problems(syndicate({ model_overrides: { openai: { instruction: 'a', instruction_append: 'b' } } })), ['orchestrator.model_overrides.openai — exactly one of instruction or instruction_append']);
});

test('the JSON Schema documents the v2 keys and marks the v1 spellings deprecated', () => {
  const orch = (syndicateJsonSchema() as any).properties.orchestrator.properties;
  assert.strictEqual(orch.generateContentConfig.deprecated, true);
  assert.match(orch.generateContentConfig.description, /sampling/);
  assert.strictEqual(orch.outputSchema.deprecated, true);
  assert.match(orch.outputSchema.description, /output\.schema/);
  assert.deepStrictEqual(Object.keys(orch.sampling.properties), ['temperature', 'top_p', 'max_output_tokens', 'stop']);
  assert.deepStrictEqual(Object.keys(orch.model_overrides.properties), ['gemini', 'anthropic', 'openai', 'xai', 'moonshot', 'ollama']);
});

// ── Deprecation warning ──────────────────────────────────────────────────────

const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialect-'));
function writeYaml(file: string, body: string): void {
  fs.writeFileSync(path.join(agentsDir, file), body);
}

test('a v1 file warns once, with paths and no values', () => {
  writeYaml(
    'v1.yaml',
    [
      'syndicate_name: V1',
      'orchestrator:',
      '  name: Lead',
      '  model: gemini-2.5-flash',
      '  instruction: SECRET-PROMPT',
      '  generateContentConfig: { temperature: 0.123 }',
      'subagents:',
      '  - name: Helper',
      '    description: Helps',
      '    instruction: Help.',
      '  - name: Grader',
      '    description: Grades',
      '    instruction: Grade.',
      '    outputSchema: { type: object, title: SCHEMA-TITLE }',
    ].join('\n'),
  );
  const warnings: string[] = [];
  loadSyndicate('v1.yaml', { agentsDir, onWarning: (m) => warnings.push(m) });
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /v1\.yaml: generateContentConfig and outputSchema are v1 spellings, deprecated \(ADR 0115\): orchestrator\.generateContentConfig, subagents\[1\]\.outputSchema\. Run npx melchizedek-codemod .*v1\.yaml to rewrite them\./);
  for (const value of ['SECRET-PROMPT', '0.123', 'SCHEMA-TITLE']) assert.ok(!warnings[0].includes(value), value);
  loadSyndicate('v1.yaml', { agentsDir, onWarning: (m) => warnings.push(m) });
  assert.strictEqual(warnings.length, 1, 'the same label warns once per process');
});

test('a v2-only file does not warn', () => {
  writeYaml(
    'v2.yaml',
    ['syndicate_name: V2', 'orchestrator:', '  name: Lead', '  model: gemini-2.5-flash', '  instruction: Lead.', '  sampling: { temperature: 0.1 }', '  output: { mime: application/json }'].join('\n'),
  );
  const warnings: string[] = [];
  const cfg = loadSyndicate('v2.yaml', { agentsDir, onWarning: (m) => warnings.push(m) });
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(cfg.orchestrator.generateContentConfig, { temperature: 0.1, responseMimeType: 'application/json' });
});

test('v1SpellingsOf lists the deprecated paths in file order', () => {
  assert.deepStrictEqual(v1SpellingsOf(syndicate({ outputSchema: {} }, [{ name: 'a' }, { name: 'b', generateContentConfig: {} }])), ['orchestrator.outputSchema', 'subagents[1].generateContentConfig']);
  assert.deepStrictEqual(v1SpellingsOf(syndicate({ sampling: { temperature: 1 } })), []);
});

// ── model_overrides ──────────────────────────────────────────────────────────

test('model_overrides replaces or appends for the provider of the model, and only for it', () => {
  const agent = {
    instruction: 'Base.',
    model_overrides: { anthropic: { instruction: 'Claude prompt.' }, openai: { instruction_append: 'Be terse.' } },
  };
  assert.strictEqual(instructionFor(agent, 'claude-sonnet-4-5'), 'Claude prompt.');
  assert.strictEqual(instructionFor(agent, 'gpt-5'), 'Base.\n\nBe terse.');
  assert.strictEqual(instructionFor(agent, 'gemini-2.5-flash'), 'Base.');
  assert.strictEqual(instructionFor(agent, undefined), 'Base.');
});

test('compile applies model_overrides for the agent model, before the skills index', async () => {
  const skills = { dir: path.join(process.cwd(), 'tests', 'fixtures', 'skills') };
  const build = (model: string, overrides?: object) =>
    compileSpec(validateSyndicateConfig(syndicate({ model, instruction: 'Base.', skills, ...(overrides ? { model_overrides: overrides } : {}) }), 'mo.yaml'), OFFLINE);
  const plain = await build('claude-sonnet-4-5');
  assert.ok(plain.instruction.startsWith('Base.\n\n'), 'the skills index follows the instruction');
  const replaced = await build('claude-sonnet-4-5', { anthropic: { instruction: 'Claude prompt.' } });
  assert.strictEqual(replaced.instruction, plain.instruction.replace('Base.', 'Claude prompt.'));
  const appended = await build('claude-sonnet-4-5', { anthropic: { instruction_append: 'More.' } });
  assert.strictEqual(appended.instruction, plain.instruction.replace('Base.', 'Base.\n\nMore.'));
  const other = await build('gemini-2.5-flash', { anthropic: { instruction: 'Claude prompt.' } });
  assert.strictEqual(other.instruction, (await build('gemini-2.5-flash')).instruction);
  // A subagent with no model of its own takes the resolver's model id.
  const sub = await compileSubagentSpec(
    { name: 'Sub', description: 'x', instruction: 'Base.', model_overrides: { xai: { instruction_append: 'Grok.' } } } as SubagentYamlConfig,
    { ...OFFLINE, resolveModel: () => 'grok-4' },
  );
  assert.strictEqual(sub.instruction, 'Base.\n\nGrok.');
});
