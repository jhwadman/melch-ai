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
import { join } from 'node:path';
import { FunctionTool, InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import { z } from 'zod';

import { compileGraph } from '../lib/compile.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { HarnessSkillToolset, loadSkillSuite, skillsInstruction } from '../lib/tools/skillToolset.ts';
import { SyndicateValidationError, validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

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
  const toolset = root.tools.find((t: unknown) => t instanceof HarnessSkillToolset) as HarnessSkillToolset;
  assert.ok(toolset, 'the toolset is among the agent tools');
  assert.deepEqual((await toolset.getTools()).map((t) => t.name), ['load_skill', 'load_skill_resource']);

  const local = (await compileGraph(harnessConfig({ scripts: 'local' }))) as any;
  assert.match(local.instruction, /waits for the user's approval/);
  const localToolset = local.tools.find((t: unknown) => t instanceof HarnessSkillToolset) as HarnessSkillToolset;
  assert.deepEqual((await localToolset.getTools()).map((t) => t.name), ['load_skill', 'load_skill_resource', 'run_skill_script']);

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
