/**
 * tests/skillHarness.test.ts — an agent's `skills:` block (lib/tools/skillToolset.ts):
 * the frontmatter index injected into the instruction, the lean load_skill,
 * resources read one at a time, `allowed-tools` unlocking a registry tool only
 * after the skill is loaded, a script run that waits for approval and then
 * runs on the local executor, and the schema's placement rules. Scripted
 * models, in-memory sessions, fixture skills under tests/fixtures/skills.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { FunctionTool, InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import { z } from 'zod';

import { compileGraph } from '../lib/compile.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { toolsetOf } from '../lib/tools/tool.ts';
import { HarnessSkillToolset, loadSkillSuite, skillsInstruction } from '../lib/tools/skillToolset.ts';
import { SyndicateValidationError, validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';
import { ROOT, runtimeImportsOf, specifiersOf } from './helpers/importGraph.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';

setLogLevel(LogLevel.ERROR);

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'skills');

registerTool(
  'harness_test_lookup',
  new FunctionTool({
    name: 'harness_test_lookup',
    description: 'Look something up.',
    parameters: z.object({ key: z.string() }),
    execute: async ({ key }) => `looked up ${key}`,
  }),
  { override: true },
);

const lastResponse = (req: any) => JSON.stringify(req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response ?? null);
const declaredTools = (req: any): string[] => Object.keys(req.toolsDict ?? {}).sort();

function harnessConfig(skills: Record<string, unknown>, extra: Record<string, unknown> = {}): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Harness',
      orchestrator: { name: 'Harness', model: 'scripted/harness', instruction: 'Follow skills.', skills: { dir: FIXTURES, ...skills }, ...extra },
      subagents: [],
    },
    'test',
  ) as SyndicateYamlConfig;
}

function runner(config: SyndicateYamlConfig, models: Record<string, ScriptedLlm>) {
  const sessionService = new InMemorySessionService();
  return (parts: any[]) =>
    runSyndicateTurn({ config, parts, appName: 'app', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: scriptedResolver(models) }, trace: false });
}

test('the suite loads from the standard layout and allowed-tools becomes the activation list', async () => {
  const skills = await loadSkillSuite(FIXTURES);
  assert.deepEqual(Object.keys(skills).sort(), ['greeting', 'release-notes']);
  const notes = skills['release-notes']!;
  assert.deepEqual(notes.frontmatter.metadata?.adk_additional_tools, ['harness_test_lookup']);
  assert.deepEqual(Object.keys(notes.resources?.scripts ?? {}), ['version.sh']);
  assert.deepEqual(Object.keys(notes.resources?.references ?? {}), ['style.md']);
  assert.equal(skills.greeting!.frontmatter.metadata?.adk_additional_tools, undefined);
  await assert.rejects(loadSkillSuite(join(FIXTURES, 'does-not-exist')), /skills: directory not found/);
});

test('the frontmatter index is injected into the instruction; the toolset carries only what the mode allows', async () => {
  const root = (await compileGraph(harnessConfig({}))) as any;
  assert.match(root.instruction, /^Follow skills\.\n\n/);
  assert.match(root.instruction, /<available_skills>[\s\S]*<name>greeting<\/name>[\s\S]*<name>release-notes<\/name>[\s\S]*<\/available_skills>/);
  assert.match(root.instruction, /Greet a person by name/);
  assert.doesNotMatch(root.instruction, /House style|Write one sentence/, 'bodies are never injected');
  assert.match(root.instruction, /cannot run here/);
  const toolset = root.tools.map(toolsetOf).find((t: unknown) => t instanceof HarnessSkillToolset) as HarnessSkillToolset;
  assert.ok(toolset, 'the toolset is among the agent tools');
  assert.deepEqual((await toolset.getTools()).map((t: any) => t.name), ['load_skill', 'load_skill_resource']);

  const local = (await compileGraph(harnessConfig({ scripts: 'local' }))) as any;
  assert.match(local.instruction, /waits for the user's approval/);
  const localToolset = local.tools.map(toolsetOf).find((t: unknown) => t instanceof HarnessSkillToolset) as HarnessSkillToolset;
  assert.deepEqual((await localToolset.getTools()).map((t: any) => t.name), ['load_skill', 'load_skill_resource', 'run_skill_script']);

  const empty = skillsInstruction({}, { dir: 'x' });
  assert.match(empty, /<available_skills>\n<\/available_skills>/);
});

test('load_skill returns the procedure and file names, never file contents; load_skill_resource reads one file', async () => {
  const seen: string[] = [];
  const harness = new ScriptedLlm('scripted/harness', (req, n) => {
    if (n === 1) return call('load_skill', { name: 'release-notes' });
    seen.push(lastResponse(req));
    if (n === 2) return call('load_skill_resource', { skill_name: 'release-notes', path: 'references/style.md' });
    seen.push(lastResponse(req));
    return text('done');
  });
  const r = await runner(harnessConfig({}), { harness })([{ text: 'release notes please' }]);
  assert.equal(r.status, 'completed');
  const loaded = JSON.parse(seen[0]!);
  assert.equal(loaded.skill_name, 'release-notes');
  assert.match(loaded.instructions, /Read `references\/style.md`/);
  assert.deepEqual(loaded.files, ['assets/template.md', 'references/style.md', 'scripts/version.sh']);
  assert.equal(loaded.resources, undefined, 'no resource dump');
  assert.doesNotMatch(seen[0]!, /House style/);
  const resource = JSON.parse(seen[1]!);
  assert.match(resource.content, /House style: one sentence per change/);
});

test('an unknown skill is an error the model can read', async () => {
  let reply = '';
  const harness = new ScriptedLlm('scripted/harness', (req, n) => (n === 1 ? call('load_skill', { name: 'nope' }) : ((reply = lastResponse(req)), text('ok'))));
  const r = await runner(harnessConfig({}), { harness })([{ text: 'x' }]);
  assert.equal(r.status, 'completed');
  assert.match(reply, /Skill 'nope' not found\. Installed: greeting, release-notes/);
});

test('allowed-tools: a registry tool named by the skill is callable only after the skill is loaded', async () => {
  const harness = new ScriptedLlm('scripted/harness', (_req, n) => (n === 1 ? call('load_skill', { name: 'release-notes' }) : n === 2 ? call('harness_test_lookup', { key: 'k' }) : text('ok')));
  const r = await runner(harnessConfig({ tools: ['harness_test_lookup'] }), { harness })([{ text: 'x' }]);
  assert.equal(r.status, 'completed');
  assert.ok(!declaredTools(harness.requests[0]).includes('harness_test_lookup'), 'not offered before the load');
  assert.ok(declaredTools(harness.requests[1]).includes('harness_test_lookup'), 'offered once the skill is loaded');
  assert.match(lastResponse(harness.requests[2]), /looked up k/);

  // Without skills.tools the skill's allowed-tools unlocks nothing.
  const bare = new ScriptedLlm('scripted/harness', (_req, n) => (n === 1 ? call('load_skill', { name: 'release-notes' }) : text('ok')));
  await runner(harnessConfig({}), { harness: bare })([{ text: 'x' }]);
  assert.ok(!declaredTools(bare.requests[1]).includes('harness_test_lookup'));
});

test('a script run waits for approval, then runs on the local executor with its arguments', async () => {
  const harness = new ScriptedLlm('scripted/harness', (req, n) => (n === 1 ? call('run_skill_script', { skill_name: 'release-notes', script_path: 'scripts/version.sh', args: { tag: 'beta' } }) : text(`got ${lastResponse(req)}`)));
  const turn = runner(harnessConfig({ scripts: 'local' }), { harness });
  const first = await turn([{ text: 'release notes' }]);
  assert.equal(first.status, 'input-required');
  assert.equal(first.approval?.tool, 'run_skill_script');
  assert.deepEqual(first.approval?.args, { skill_name: 'release-notes', script_path: 'scripts/version.sh', args: { tag: 'beta' } });
  assert.equal(harness.calls, 1, 'nothing ran before the approval');

  const second = await turn([approvalResponsePart(first.approval!.id, true)]);
  assert.equal(second.status, 'completed');
  assert.match(second.text, /version=9\.9\.9 args=--tag beta/);
});

test('a refused script run never executes and the model is told', async () => {
  const harness = new ScriptedLlm('scripted/harness', (req, n) => (n === 1 ? call('run_skill_script', { skill_name: 'release-notes', script_path: 'scripts/version.sh' }) : text(`got ${lastResponse(req)}`)));
  const turn = runner(harnessConfig({ scripts: 'local' }), { harness });
  const first = await turn([{ text: 'x' }]);
  const second = await turn([approvalResponsePart(first.approval!.id, false)]);
  assert.equal(second.status, 'completed');
  assert.match(second.text, /rejected/);
  assert.doesNotMatch(second.text, /version=9\.9\.9/);
});

test('schema: scripts pause only where a pause can reach the caller; skills.tools cannot repeat tools', () => {
  const base = () => ({
    syndicate_name: 'S',
    orchestrator: { name: 'Lead', model: 'gemini-3.5-flash-lite', instruction: 'x' },
    subagents: [{ name: 'Sub', description: 'd', model: 'gemini-3.5-flash-lite', instruction: 'y', skills: { dir: FIXTURES, scripts: 'local' } }],
  });
  assert.throws(() => validateSyndicateConfig(base(), 't'), (e: unknown) => e instanceof SyndicateValidationError && /subagents\[0\]\.skills\.scripts.*cannot pause/.test(String(e.message)));
  const dispatching = { ...base(), dispatch: { default_route: 'Sub' } };
  assert.doesNotThrow(() => validateSyndicateConfig(dispatching, 't'));
  const overlap = { ...base(), subagents: [], orchestrator: { ...base().orchestrator, tools: ['web_extract'], skills: { dir: FIXTURES, tools: ['web_extract'] } } };
  assert.throws(() => validateSyndicateConfig(overlap, 't'), /already in this agent's tools/);
  assert.throws(() => validateSyndicateConfig({ ...base(), subagents: [], orchestrator: { ...base().orchestrator, skills: { dir: FIXTURES, scripts: 'docker' } } }, 't'), /scripts/);
});

// ── The harness has no ADK, and runs the same on both runtimes (WS3-3, ADR 0083) ──

const HARNESS_FILES = ['lib/tools/skillToolset.ts', 'lib/skills.ts', 'lib/tools/skills/frontmatter.ts', 'lib/tools/skills/loader.ts', 'lib/tools/skills/executor.ts', 'lib/tools/skills/tools.ts'];

test('no harness file imports ADK, and nothing it loads at run time does', () => {
  const isGoogle = (s: string) => s.startsWith('@google/');
  for (const file of HARNESS_FILES) {
    assert.deepEqual(specifiersOf(file).filter(isGoogle), [], `${file} names no @google/* module, not even for a type`);
    const reached = new Set<string>();
    const pending = [resolvePath(ROOT, file)];
    while (pending.length > 0) {
      const at = pending.pop()!;
      if (reached.has(at)) continue;
      reached.add(at);
      for (const statement of runtimeImportsOf(at)) {
        const quote = statement.slice(-1);
        const spec = statement.slice(statement.lastIndexOf(quote, statement.length - 2) + 1, -1);
        assert.ok(!isGoogle(spec), `${file} loads ${spec} through ${at}`);
        if (spec.startsWith('.')) pending.push(resolvePath(dirname(at), spec));
      }
    }
    assert.ok(reached.size >= 1);
  }
});

const PARITY = join(process.cwd(), 'tests', 'fixtures', 'skills-parity');

function nativeSyndicate(skills: Record<string, unknown>, dir = FIXTURES): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Harness',
      orchestrator: { name: 'Harness', model: 'scripted/boss', instruction: 'Follow skills.', skills: { dir, ...skills } },
      subagents: [],
    },
    'test',
  ) as SyndicateYamlConfig;
}

interface Turn {
  parts?: unknown[];
  answer?: (previous: SyndicateTurnResult) => unknown[];
  runtime?: 'adk' | 'native';
}

async function converse(runtime: 'adk' | 'native', config: SyndicateYamlConfig, scripts: Record<string, ModelScript>, turns: Turn[]) {
  const models = Object.fromEntries(Object.entries(scripts).map(([k, s]) => [k, new ScriptedModel(`scripted/${k}`, s)]));
  const sessionService = new InMemorySessionService();
  const results: SyndicateTurnResult[] = [];
  for (const t of turns) {
    results.push(
      await runSyndicateTurn({
        config,
        parts: (t.answer ? t.answer(results.at(-1)!) : (t.parts ?? [{ text: 'release notes please' }])) as any[],
        appName: 'app',
        userId: 'u',
        sessionId: 's',
        sessionService,
        compile: { resolveModel: shimResolver(models), log: () => {} },
        trace: false,
        runtime: t.runtime ?? runtime,
      }),
    );
  }
  const session = await sessionService.getSession({ appName: 'app', userId: 'u', sessionId: 's' });
  return { results, events: JSON.parse(JSON.stringify(session?.events ?? [])) as TurnEvent[], models };
}

/** The output directory a script result names is minted once per toolset, so per compile. */
const OUTPUT_DIR = /[^"\s]*melchizedek_skill_output_[A-Za-z0-9]+/g;
const withoutOutputDir = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value), (_k, v) => (typeof v === 'string' ? v.replace(OUTPUT_DIR, '<output-dir>') : v));

/** Ids, times and the output directory are minted per run; everything else must match. */
function comparable(events: TurnEvent[]): unknown {
  return withoutOutputDir(
    JSON.parse(
      JSON.stringify(events.map((e) => ({ ...e, id: '<id>', timestamp: 0, invocationId: '<inv>' }))),
      (_k, v) => (typeof v === 'string' && v.startsWith('adk-') ? '<adk-id>' : v),
    ),
  );
}

const outcome = (r: SyndicateTurnResult) =>
  withoutOutputDir({ status: r.status, text: r.text, error: r.error?.message ?? null, approval: r.approval ? { tool: r.approval.tool, args: r.approval.args } : null });

async function assertParity(config: SyndicateYamlConfig, scripts: Record<string, ModelScript>, turns: Turn[] = [{}]) {
  const adk = await converse('adk', config, scripts, turns);
  const native = await converse('native', config, scripts, turns);
  assert.deepEqual(native.results.map(outcome), adk.results.map(outcome), 'the results');
  assert.deepEqual(comparable(native.events), comparable(adk.events), 'the stored events');
  for (const key of Object.keys(scripts)) {
    assert.equal(native.models[key]?.calls, adk.models[key]?.calls, `calls to ${key}`);
    assert.deepEqual(
      withoutOutputDir(native.models[key]?.requests.map((r) => ({ system: r.system, tools: r.tools, messages: r.messages }))),
      withoutOutputDir(adk.models[key]?.requests.map((r) => ({ system: r.system, tools: r.tools, messages: r.messages }))),
      `what ${key} was sent`,
    );
  }
  return { adk, native };
}

const resultText = (req: ModelRequest) => JSON.stringify(lastToolResult(req)?.result ?? null);

test('parity: load_skill and load_skill_resource answer and store the same on native as on ADK', async () => {
  const { native } = await assertParity(nativeSyndicate({}), {
    boss: (req, n) =>
      n === 1
        ? toolCall('load_skill', { name: 'release-notes' }, 'call-load')
        : n === 2
          ? toolCall('load_skill_resource', { skill_name: 'release-notes', path: 'references/style.md' }, 'call-res')
          : n === 3
            ? toolCall('load_skill', { name: 'nope' }, 'call-nope')
            : answer(`done ${resultText(req)}`),
  });
  assert.equal(native.results[0]?.status, 'completed');
  assert.match(native.results[0]!.text, /Skill 'nope' not found\. Installed: greeting, release-notes/);
  assert.match(JSON.stringify(native.events), /House style: one sentence per change/);
  assert.match(JSON.stringify(native.events), /_adk_activated_skill_Harness/);
});

test('parity: allowed-tools unlocks the permitted tool after the load, on native as on ADK', async () => {
  const { native } = await assertParity(nativeSyndicate({ tools: ['harness_test_lookup'] }), {
    boss: (req, n) => (n === 1 ? toolCall('load_skill', { name: 'release-notes' }, 'call-load') : n === 2 ? toolCall('harness_test_lookup', { key: 'k' }, 'call-look') : answer(`got ${resultText(req)}`)),
  });
  const names = (i: number) => native.models.boss!.requests[i]!.tools?.map((t) => t.name) ?? [];
  assert.ok(!names(0).includes('harness_test_lookup'), 'not offered before the load');
  assert.ok(names(1).includes('harness_test_lookup'), 'offered once the skill is loaded');
  assert.equal(native.results[0]?.text, 'got "looked up k"');
});

test('parity: a script run pauses for approval and runs, or is refused, on native as on ADK', async () => {
  const script: ModelScript = (req, n) =>
    n === 1 ? toolCall('run_skill_script', { skill_name: 'release-notes', script_path: 'scripts/version.sh', args: { tag: 'beta' } }, 'call-run') : answer(`got ${resultText(req)}`);
  for (const approved of [true, false]) {
    const { native } = await assertParity(nativeSyndicate({ scripts: 'local' }), { boss: script }, [
      { parts: [{ text: 'release notes' }] },
      { answer: (r) => [approvalResponsePart(r.approval!.id, approved)] },
    ]);
    assert.equal(native.results[0]?.status, 'input-required');
    assert.equal(native.results[0]?.approval?.tool, 'run_skill_script');
    assert.equal(native.results[1]?.status, 'completed', native.results[1]?.error?.message);
    if (approved) assert.match(native.results[1]!.text, /version=9\.9\.9 args=--tag beta/);
    else assert.equal(native.results[1]!.text, 'got "This script run was rejected."');
  }
});

test('a script approval opened on one runtime resumes on the other', async () => {
  const script: ModelScript = (req, n) => (n === 1 ? toolCall('run_skill_script', { skill_name: 'release-notes', script_path: 'scripts/version.sh' }, 'call-run') : answer(`got ${resultText(req)}`));
  for (const [opens, resumes] of [['native', 'adk'], ['adk', 'native']] as const) {
    const run = await converse(opens, nativeSyndicate({ scripts: 'local' }), { boss: script }, [
      { parts: [{ text: 'x' }] },
      { answer: (r) => [approvalResponsePart(r.approval!.id, true)], runtime: resumes },
    ]);
    assert.equal(run.results[0]?.status, 'input-required');
    assert.equal(run.results[1]?.status, 'completed', run.results[1]?.error?.message);
    assert.match(run.results[1]!.text, /version=9\.9\.9/, `opened on ${opens}, resumed on ${resumes}`);
  }
});

test('parity: a binary resource reaches the next request as inline data on both runtimes', async () => {
  const { native } = await assertParity(nativeSyndicate({}, PARITY), {
    boss: (_req, n) => (n === 1 ? toolCall('load_skill_resource', { skill_name: 'kit', path: 'assets/logo.png' }, 'call-bin') : answer('seen')),
  });
  const logo = readFileSync(join(PARITY, 'kit', 'assets', 'logo.png')).toString('base64');
  const second = JSON.stringify(native.models.boss!.requests[1]!.messages);
  assert.ok(second.includes(logo), 'the file is in the request');
  assert.match(second, /The content of binary file 'assets\/logo.png' is:/);
  assert.ok(!JSON.stringify(native.events).includes(logo), 'and never stored');
});

test('the harness.yaml example runs under runtime native with a scripted model, storing what ADK stores', async () => {
  const config = loadSyndicate(join(process.cwd(), 'config', 'agents', 'examples', 'harness.yaml'), { bindings: { skills_dir: FIXTURES } });
  const { native } = await assertParity(config, {
    'gemini-3.8-flash': (req, n) =>
      n === 1
        ? toolCall('load_skill', { name: 'release-notes' }, 'call-load')
        : n === 2
          ? toolCall('load_skill_resource', { skill_name: 'release-notes', path: 'assets/template.md' }, 'call-res')
          : n === 3
            ? toolCall('Checker', { request: 'RULES: one sentence per change. REQUEST: notes. DELIVERABLE: - Fixed a bug.' }, 'call-check')
            : answer(`- Fixed a bug.\n\nFollowed: release-notes. (${resultText(req)})`),
    'gemini-3.5-flash-lite': () => answer('PASS'),
  });
  assert.equal(native.results[0]?.status, 'completed', native.results[0]?.error?.message);
  assert.match(native.results[0]!.text, /Followed: release-notes\. \("PASS"\)/);
  assert.match(native.models['gemini-3.8-flash']!.requests[0]!.system ?? '', /<available_skills>[\s\S]*<name>release-notes<\/name>/);
  // adk_handle_model_error is self-correction's reflection tool, on an agent with retries.
  assert.deepEqual(
    native.models['gemini-3.8-flash']!.requests[0]!.tools?.map((t) => t.name).filter((n) => n !== 'adk_handle_model_error'),
    ['Checker', 'load_skill', 'load_skill_resource'],
  );
});
