/**
 * tests/project.test.ts — the project manifest, melchizedek.json (ADR 0138):
 * parsing, the walk-up and its repository boundary, the agents-directory
 * chain, ignore patterns, and the doctor's project report. Offline, temp dirs.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkProject,
  clearProjectCache,
  findProject,
  findProjectRoot,
  isIgnored,
  listProjectSyndicates,
  loadProject,
  parseProjectManifest,
  ProjectManifestError,
  resolveAgentsDir,
} from '../lib/project.ts';
import { checkProblems, runDoctor } from '../lib/doctor.ts';

const SYNDICATE = `syndicate_name: tiny
orchestrator:
  name: Tiny
  model: gemini-3.8-flash
  instruction: Say hello.
subagents: []
`;

/** A temp repository shaped like nihilistic-penguin: agents/ with a retired/ folder. */
function penguinLike(manifest?: object): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'melch-project-')));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'agents', 'retired'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'risk_critic.yaml'), SYNDICATE);
  fs.writeFileSync(path.join(root, 'agents', 'advisor_macro.yaml'), SYNDICATE);
  fs.writeFileSync(path.join(root, 'agents', 'old_one.yaml'), SYNDICATE);
  fs.writeFileSync(path.join(root, 'agents', 'retired', 'gone.yaml'), SYNDICATE);
  if (manifest) fs.writeFileSync(path.join(root, 'melchizedek.json'), JSON.stringify(manifest, null, 2));
  return root;
}

const base = { manifest: 1, engine: '1.7.0', agents: 'agents' };

function inDir<T>(dir: string, fn: () => T): T {
  const was = process.cwd();
  const env = process.env.MELCHIZEDEK_AGENTS_DIR;
  delete process.env.MELCHIZEDEK_AGENTS_DIR;
  process.chdir(dir);
  clearProjectCache();
  try {
    return fn();
  } finally {
    process.chdir(was);
    if (env === undefined) delete process.env.MELCHIZEDEK_AGENTS_DIR;
    else process.env.MELCHIZEDEK_AGENTS_DIR = env;
    clearProjectCache();
  }
}

test('a minimal manifest parses, and unknown keys survive', () => {
  const m = parseProjectManifest(JSON.stringify({ ...base, future_key: { a: 1 } }));
  assert.equal(m.agents, 'agents');
  assert.deepEqual((m as Record<string, unknown>).future_key, { a: 1 });
});

test('the manifest refuses paths that leave the root, bad pins, values in env and a newer version', () => {
  const bad = (over: object) => assert.throws(() => parseProjectManifest(JSON.stringify({ ...base, ...over })), ProjectManifestError);
  bad({ agents: '../elsewhere' });
  bad({ agents: '/etc' });
  bad({ tests: 'tests/../../x' });
  bad({ engine: '^1.7.0' });
  bad({ env: ['sk-live-abc123'] });
  bad({ manifest: 2 });
  assert.throws(() => parseProjectManifest('{not json'), /not valid JSON/);
});

test('an error names the field, never the value', () => {
  try {
    parseProjectManifest(JSON.stringify({ ...base, env: ['xai-SECRETVALUE'] }));
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ProjectManifestError);
    assert.match(e.message, /env\.0/);
    assert.doesNotMatch(e.message, /SECRETVALUE/);
  }
});

test('findProjectRoot walks up to the manifest, and stops at the repository root', () => {
  const root = penguinLike(base);
  assert.equal(findProjectRoot(path.join(root, 'agents', 'retired')), root);

  // A manifest ABOVE a repository never steers it.
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'melch-outer-')));
  fs.writeFileSync(path.join(outer, 'melchizedek.json'), JSON.stringify(base));
  const inner = path.join(outer, 'repo');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  assert.equal(findProjectRoot(inner), undefined);
});

test('loadProject resolves the folders under the root', () => {
  const root = penguinLike({ ...base, tests: 'tests/agents' });
  const p = loadProject(root);
  assert.equal(p.agentsDir, path.join(root, 'agents'));
  assert.equal(p.testsDir, path.join(root, 'tests', 'agents'));
});

test('ignore patterns drop files from the listing', () => {
  const root = penguinLike({ ...base, ignore: ['agents/retired/**', 'agents/old_*.yaml'] });
  const p = loadProject(root);
  assert.deepEqual(listProjectSyndicates(p), ['advisor_macro.yaml', 'risk_critic.yaml']);
  assert.ok(isIgnored(p, 'agents/retired/gone.yaml'));
  assert.ok(!isIgnored(p, 'agents/risk_critic.yaml'));
});

test('the agents-directory chain: option, then env, then manifest, then config/agents', () => {
  const root = penguinLike(base);
  inDir(root, () => {
    assert.equal(resolveAgentsDir(), path.join(root, 'agents'));
    assert.equal(resolveAgentsDir('/opt/explicit'), '/opt/explicit');
    assert.equal(resolveAgentsDir(undefined, { MELCHIZEDEK_AGENTS_DIR: '/opt/env' }), '/opt/env');
  });
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'melch-plain-')));
  fs.mkdirSync(path.join(plain, '.git'));
  inDir(plain, () => assert.equal(resolveAgentsDir(), path.join(plain, 'config', 'agents')));
});

test('a broken manifest falls back to the default on the read path instead of throwing', () => {
  const root = penguinLike();
  fs.writeFileSync(path.join(root, 'melchizedek.json'), '{"manifest": 1');
  inDir(root, () => assert.equal(resolveAgentsDir(), path.join(root, 'config', 'agents')));
  assert.throws(() => findProject(root), ProjectManifestError);
});

test('checkProject: the engine pin, missing folders, stale ignores, unset env names, orphan records', () => {
  const root = penguinLike({
    ...base,
    tests: 'tests/agents',
    ignore: ['agents/retired/**', 'agents/nothing_here/**'],
    env: ['MELCH_TEST_SET_VAR', 'MELCH_TEST_UNSET_VAR'],
    syndicates: { 'risk_critic.yaml': { deliverable: 'service', publish: { kind: 'registry', id: 'risk_critic' } }, 'deleted.yaml': {} },
  });
  const c = checkProject(loadProject(root), '1.8.0', { MELCH_TEST_SET_VAR: 'x' });
  assert.equal(c.engine.matches, false);
  assert.ok(c.problems.some((p) => p.includes('pins melchizedek-agents 1.7.0; 1.8.0 is running')));
  assert.ok(c.problems.some((p) => p.startsWith('tests:')));
  assert.ok(c.warnings.includes('ignore: "agents/nothing_here/**" matches nothing'));
  assert.ok(!c.warnings.some((w) => w.includes('retired')));
  assert.ok(c.warnings.includes('env: MELCH_TEST_UNSET_VAR is not set'));
  assert.ok(!c.warnings.some((w) => w.includes('MELCH_TEST_SET_VAR')));
  assert.ok(c.warnings.includes('syndicates: deleted.yaml is not in agents'));

  const ok = checkProject(loadProject(penguinLike(base)), '1.7.0', {});
  assert.deepEqual(ok.problems, []);
});

test('the doctor reads the project: its folder, its ignore list, its pin', () => {
  const root = penguinLike({ ...base, engine: '0.0.1', ignore: ['agents/old_*.yaml'] });
  inDir(root, () => {
    const r = runDoctor();
    assert.equal(r.agentsDir, path.join(root, 'agents'));
    assert.deepEqual(r.syndicates.map((s) => s.file).sort(), ['advisor_macro.yaml', 'risk_critic.yaml']);
    assert.ok(r.project && 'engine' in r.project && !r.project.engine.matches);
    assert.ok(checkProblems(r).some((p) => p.startsWith('project: engine:')));
  });
});

test('the doctor reports a broken manifest as a problem', () => {
  const root = penguinLike();
  fs.writeFileSync(path.join(root, 'melchizedek.json'), JSON.stringify({ ...base, agents: '../out' }));
  inDir(root, () => {
    const r = runDoctor();
    assert.ok(r.project && 'error' in r.project);
    assert.ok(checkProblems(r).some((p) => p.includes('agents')));
  });
});
