/**
 * tests/yamlCodemod.test.ts — scripts/yaml_codemod.ts (ADR 0115).
 *
 * Unit cases for each v1 → v2 mapping, comments, idempotence, conflicts and
 * leftovers; then the identity test over the v1 corpus (tests/fixtures/v1/,
 * the shipped v1 files as of 1.0.3): every migrated file loads, every agent
 * compiles offline to the same AgentSpec and builds the same ModelRequest,
 * and migrating twice changes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

import { compileSpec, compileSubagentSpec, type AgentSpec } from '../lib/compile.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { reasoningOf } from '../lib/models/genaiMapping.ts';
import { buildModelRequest } from '../lib/runtime/native/request.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { main, migrateYaml } from '../scripts/yaml_codemod.ts';

type Json = Record<string, any>;

/** One agent under an orchestrator, so a case reads as the lines it is about. */
const syndicate = (agentLines: string) => `syndicate_name: t\norchestrator:\n  name: a\n  instruction: hi\n${agentLines}`;
const orchestratorOf = (text: string): Json => (parse(text) as Json).orchestrator;

// ── Mappings ─────────────────────────────────────────────────────────────────

test('sampling keys move under sampling: with their v2 names', () => {
  const r = migrateYaml(
    syndicate(`  model: ollama/qwen3:8b
  generateContentConfig:
    temperature: 0.4
    topP: 0.9
    maxOutputTokens: 2048
    stopSequences:
      - END
`),
  );
  assert.equal(r.changed, true);
  assert.deepEqual(r.notes, []);
  const a = orchestratorOf(r.text);
  assert.deepEqual(a.sampling, { temperature: 0.4, top_p: 0.9, max_output_tokens: 2048, stop: ['END'] });
  assert.equal(a.generateContentConfig, undefined);
});

test('outputSchema becomes output.schema, and a JSON or text MIME type output.mime', () => {
  const withSchema = migrateYaml(
    syndicate(`  outputSchema:
    type: object
    required: [answer]
  generateContentConfig:
    responseMimeType: application/json
`),
  );
  assert.deepEqual(orchestratorOf(withSchema.text).output, { schema: { type: 'object', required: ['answer'] }, mime: 'application/json' });
  assert.equal(orchestratorOf(withSchema.text).generateContentConfig, undefined);
  assert.equal(orchestratorOf(withSchema.text).outputSchema, undefined);
  // The flow sequence inside the schema keeps its spelling.
  assert.ok(withSchema.text.includes('      required: [answer]\n'));

  const mimeOnly = migrateYaml(syndicate(`  generateContentConfig:\n    responseMimeType: text/plain\n`));
  assert.deepEqual(orchestratorOf(mimeOnly.text).output, { mime: 'text/plain' });

  const other = migrateYaml(syndicate(`  generateContentConfig:\n    responseMimeType: text/x-enum\n`));
  assert.equal(other.changed, false);
  assert.deepEqual(other.notes, ['orchestrator.generateContentConfig.responseMimeType: no output.mime form for this value; left in place']);
});

test('a thinkingLevel on a Gemini 3 model becomes a level, and a budget { budget_tokens }', () => {
  const level = migrateYaml(
    syndicate(`  model: gemini-3.8-flash
  generateContentConfig:
    thinkingConfig:
      thinkingLevel: MEDIUM
      includeThoughts: false
`),
  );
  assert.equal(orchestratorOf(level.text).reasoning, 'medium');
  assert.equal(orchestratorOf(level.text).generateContentConfig, undefined);

  const budget = migrateYaml(
    syndicate(`  model: gemini-3.5-flash-lite
  generateContentConfig:
    thinkingConfig:
      thinkingBudget: 2048
`),
  );
  assert.deepEqual(orchestratorOf(budget.text).reasoning, { budget_tokens: 2048 });
  assert.ok(budget.text.includes('  reasoning: { budget_tokens: 2048 }\n'));

  const effort = migrateYaml(syndicate(`  model: gpt-5\n  generateContentConfig:\n    reasoningEffort: minimal\n`));
  assert.equal(orchestratorOf(effort.text).reasoning, 'none');
});

test('thinking the engine would read differently under reasoning: is left, with a note', () => {
  // MINIMAL reads as `none`; on Claude, reasoning: none reads as a zero budget.
  const claude = migrateYaml(
    syndicate(`  model: claude-sonnet-4-6
  generateContentConfig:
    thinkingConfig:
      thinkingLevel: MINIMAL
      includeThoughts: false
`),
  );
  const a = orchestratorOf(claude.text);
  assert.equal(a.reasoning, undefined);
  assert.deepEqual(a.generateContentConfig, { thinkingConfig: { thinkingLevel: 'MINIMAL' } });
  assert.deepEqual(claude.notes, [
    'orchestrator.generateContentConfig.thinkingConfig: reasoning: would change what the engine reads for this model; left in place',
  ]);

  const noModel = migrateYaml(syndicate(`  generateContentConfig:\n    reasoningEffort: low\n`));
  assert.equal(noModel.changed, false);
  assert.match(noModel.notes[0]!, /^orchestrator\.generateContentConfig\.reasoningEffort: the agent names no model id/);
});

test('includeThoughts: false is dropped; true stays, and keeps the thinking where it is', () => {
  const kept = migrateYaml(
    syndicate(`  model: gemini-3.8-flash
  generateContentConfig:
    thinkingConfig:
      thinkingLevel: LOW
      includeThoughts: true
`),
  );
  assert.equal(kept.changed, false);
  assert.deepEqual(orchestratorOf(kept.text).generateContentConfig, { thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } });
  assert.ok(kept.notes.includes('orchestrator.generateContentConfig.thinkingConfig.includeThoughts: no v2 form; left in place'));

  const alone = migrateYaml(syndicate(`  model: claude-sonnet-4-6\n  generateContentConfig:\n    thinkingConfig:\n      includeThoughts: false\n`));
  assert.equal(orchestratorOf(alone.text).generateContentConfig, undefined);
});

// ── Comments, leftovers, conflicts ───────────────────────────────────────────

test('comments are kept: on moved keys, on the config, and on converted thinking', () => {
  const r = migrateYaml(
    syndicate(`  model: gemini-3.8-flash
  # tuned for short answers
  generateContentConfig:   # see ADR 0047
    # cap the reply
    maxOutputTokens: 2048  # tokens
    thinkingConfig:  # think a little
      # low is enough here
      thinkingLevel: LOW
      includeThoughts: false  # hidden
`),
  );
  assert.equal(
    r.text,
    syndicate(`  model: gemini-3.8-flash
  # tuned for short answers
  # see ADR 0047
  sampling:
    # cap the reply
    max_output_tokens: 2048  # tokens
  # think a little
  # low is enough here
  # hidden
  reasoning: low
`),
  );
});

test('a key with no v2 form stays under generateContentConfig with a note naming its path, never its value', () => {
  const r = migrateYaml(
    syndicate(`  model: gemini-3.8-flash
  generateContentConfig:
    maxOutputTokens: 1024
    # top-k
    topK: 40
    stopSequences: []
`),
  );
  const a = orchestratorOf(r.text);
  assert.deepEqual(a.sampling, { max_output_tokens: 1024 });
  assert.deepEqual(a.generateContentConfig, { topK: 40, stopSequences: [] });
  assert.ok(r.text.includes('  generateContentConfig:\n    # top-k\n    topK: 40\n'));
  assert.deepEqual(r.notes, [
    'orchestrator.generateContentConfig.stopSequences: this value has no sampling.stop form; left in place',
    'orchestrator.generateContentConfig.topK: no v2 form; left under generateContentConfig',
  ]);
  for (const note of r.notes) assert.ok(!note.includes('40') && !note.includes('[]'));
});

test('an agent that already has the v2 key is left for the loader, with a note', () => {
  const r = migrateYaml(
    syndicate(`  sampling:
    temperature: 0.2
  output:
    mime: application/json
  outputSchema:
    type: object
  generateContentConfig:
    temperature: 0.5
`),
  );
  assert.equal(r.changed, false);
  assert.deepEqual(r.notes, [
    'orchestrator.outputSchema: orchestrator.output is already set; left in place (the loader refuses both)',
    'orchestrator.generateContentConfig.temperature: orchestrator.sampling is already set; left in place (move it by hand)',
  ]);
});

test('a yaml_reference entry is not rewritten; subagents get their own key paths', () => {
  const r = migrateYaml(`syndicate_name: t
orchestrator:
  name: a
  instruction: hi
subagents:
  - name: inline
    description: d
    instruction: x
    generateContentConfig:
      maxOutputTokens: 512
  - name: nested
    description: d
    yaml_reference: other.yaml
    generateContentConfig:
      maxOutputTokens: 512
`);
  const subs = (parse(r.text) as Json).subagents;
  assert.deepEqual(subs[0].sampling, { max_output_tokens: 512 });
  assert.deepEqual(subs[1].generateContentConfig, { maxOutputTokens: 512 });
  assert.deepEqual(r.notes, ['subagents[1].generateContentConfig: a yaml_reference or a2a_agent_url entry brings its own config; left in place']);
});

test('the rewrite is idempotent, keeps CRLF line ends, and leaves other lines byte for byte', () => {
  const text = syndicate(`  model: gemini-3.8-flash
  tools:   [a,b]      # odd spacing kept
  generateContentConfig:
    maxOutputTokens: 1024
    topK: 3
`);
  const once = migrateYaml(text);
  const twice = migrateYaml(once.text);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
  assert.ok(once.text.includes('  tools:   [a,b]      # odd spacing kept\n'));
  const crlf = migrateYaml(text.replaceAll('\n', '\r\n'));
  assert.equal(crlf.text, once.text.replaceAll('\n', '\r\n'));
});

test('the CLI: --check exits 1 and writes nothing; a write run rewrites in place; a directory recurses', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'yaml-codemod-'));
  try {
    const file = join(dir, 'nested', 'a.yaml');
    const text = syndicate(`  generateContentConfig:\n    maxOutputTokens: 64\n`);
    writeFileSync(join(dir, 'skip.txt'), 'x');
    mkdirSync(join(dir, 'nested'));
    writeFileSync(file, text);
    assert.equal(main(['--check', dir]), 1);
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.equal(main([dir]), 0);
    assert.deepEqual(orchestratorOf(readFileSync(file, 'utf8')).sampling, { max_output_tokens: 64 });
    assert.equal(main(['--check', dir]), 0);
    assert.ok(log.mock.calls.some((c) => String(c.arguments[0]).startsWith('migrated: ')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The identity test over the v1 corpus ─────────────────────────────────────

const CORPUS = join(process.cwd(), 'tests', 'fixtures', 'v1');
const corpusFiles = readdirSync(CORPUS, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.yaml'))
  .sort();

/** Keys the codemod never touches that would need the network or other files to compile. */
const AGENT_NEUTRALIZED = ['mcp_server_url', 'mcp_tools', 'mcp_auth', 'openapi', 'skills'];

/** Removes what cannot compile offline from a parsed syndicate, returning what was removed. */
function neutralize(cfg: Json): Json {
  const removed: Json = { workflow: cfg.workflow, agents: [] as Json[], nested: [] as Json[] };
  delete cfg.workflow;
  const agents = [cfg.orchestrator, ...(cfg.subagents ?? [])] as Json[];
  for (const agent of agents) {
    const own: Json = {};
    for (const k of AGENT_NEUTRALIZED) {
      if (agent[k] !== undefined) own[k] = agent[k];
      delete agent[k];
    }
    removed.agents.push(own);
  }
  if (cfg.subagents) {
    removed.nested = (cfg.subagents as Json[]).filter((s) => s.yaml_reference);
    cfg.subagents = (cfg.subagents as Json[]).filter((s) => !s.yaml_reference);
  }
  return removed;
}

const OFFLINE = { resolveModel: (m: string | undefined) => m, onUnknownTool: () => {} };

/** A spec with its delegated agents reduced to their names: each one is compared on its own. */
function shallow(spec: AgentSpec): Json {
  return { ...spec, tools: spec.tools.map((t: Json) => (t.kind === 'agent' ? { kind: 'agent', name: t.agent.name } : t)) };
}

const THINKING = ['thinkingConfig', 'reasoningEffort'];
const without = (cfg: Json, keys: string[]) => Object.fromEntries(Object.entries(cfg).filter(([k]) => !keys.includes(k)));

/** The ModelRequest the engine builds for a spec's model, config and output schema. */
async function requestOf(spec: AgentSpec): Promise<unknown> {
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: 'codemod', userId: 'u', sessionId: 's' });
  const agent = {
    name: spec.name,
    model: spec.modelId ?? 'gemini-3.8-flash',
    generateContentConfig: spec.generateContentConfig,
    ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
  };
  const built = await buildModelRequest(agent, { session, invocationId: 'e-1' });
  return built.request;
}

async function assertSameAgent(where: string, v1Agent: Json, before: AgentSpec, after: AgentSpec): Promise<void> {
  const thinking = THINKING.some((k) => v1Agent.generateContentConfig?.[k] !== undefined);
  if (!thinking) {
    assert.deepStrictEqual(shallow(after), shallow(before), where);
  } else {
    // reasoning: always adds the gateway's effort word (ADR 0047 §3), which
    // the engine never reads beside a thinkingConfig: compare the config
    // through the engine's reading, and everything else strictly.
    assert.deepStrictEqual(reasoningOf(after.generateContentConfig as never), reasoningOf(before.generateContentConfig as never), `${where}: reasoning`);
    assert.deepStrictEqual(without(after.generateContentConfig, THINKING), without(before.generateContentConfig, THINKING), `${where}: config`);
    assert.deepStrictEqual({ ...shallow(after), generateContentConfig: null }, { ...shallow(before), generateContentConfig: null }, where);
  }
  assert.deepStrictEqual(await requestOf(after), await requestOf(before), `${where}: model request`);
}

test('every v1 corpus file migrates to the same agents (the identity test)', async (t) => {
  assert.ok(corpusFiles.length >= 30, `corpus has ${corpusFiles.length} files`);
  for (const file of corpusFiles) {
    await t.test(file, async () => {
      const v1Text = readFileSync(join(CORPUS, file), 'utf8');
      const migrated = migrateYaml(v1Text);
      assert.equal(migrated.changed, true, 'a corpus file always has something to migrate');
      assert.deepEqual(migrateYaml(migrated.text), { text: migrated.text, changed: false, notes: migrated.notes }, 'idempotent');

      // No v1 spelling survives unless a note names it.
      const v2Raw = parse(migrated.text) as Json;
      const v2Agents: Array<[string, Json]> = [['orchestrator', v2Raw.orchestrator], ...((v2Raw.subagents ?? []) as Json[]).map((s, i): [string, Json] => [`subagents[${i}]`, s])];
      for (const [path, agent] of v2Agents) {
        for (const key of ['generateContentConfig', 'outputSchema']) {
          if (agent[key] === undefined) continue;
          assert.ok(migrated.notes.some((n) => n.startsWith(`${path}.${key}`)), `${path}.${key} kept without a note`);
        }
      }

      const v1Raw = parse(v1Text) as Json;
      const v1 = validateSyndicateConfig(structuredClone(v1Raw), file) as unknown as Json;
      const v2 = validateSyndicateConfig(structuredClone(v2Raw), file) as unknown as Json;
      assert.deepStrictEqual(neutralize(v2), neutralize(v1), 'the keys the codemod never touches');

      const v1Spec = await compileSpec(v1 as SyndicateYamlConfig, { ...OFFLINE });
      const v2Spec = await compileSpec(v2 as SyndicateYamlConfig, { ...OFFLINE });
      await assertSameAgent(`${file} orchestrator`, v1Raw.orchestrator, v1Spec, v2Spec);
      const v1Subs = (v1.subagents ?? []) as Json[];
      const v2Subs = (v2.subagents ?? []) as Json[];
      assert.equal(v2Subs.length, v1Subs.length);
      for (const [i, sub] of v1Subs.entries()) {
        if (sub.a2a_agent_url) continue;
        const v1Agent = ((v1Raw.subagents ?? []) as Json[]).find((s) => s.name === sub.name)!;
        const before = await compileSubagentSpec(sub as SubagentYamlConfig, { ...OFFLINE });
        const after = await compileSubagentSpec(v2Subs[i] as SubagentYamlConfig, { ...OFFLINE });
        await assertSameAgent(`${file} ${sub.name}`, v1Agent, before, after);
      }
    });
  }
});
