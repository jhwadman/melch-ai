/**
 * tests/onboarding.test.ts — `melchizedek-setup` and its guides (lib/onboarding.ts).
 *
 * - every detectable level is detected from the doctor's own result;
 * - `--auto` picks the highest level from a fake environment and never
 *   prints a value (key-shaped fakes are planted and searched for);
 * - ONBOARDING.md is exactly what the generator renders;
 * - the guides name only variables the engine reads;
 * - `.env` is written only when git ignores it, never over an existing one,
 *   with every name blank;
 * - `melchizedek-skills` installs the onboarding skills to every target, and
 *   the repository's `.agents/skills/` copy matches `skills/`.
 *
 * Offline: no provider is called, every environment is set per test.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor } from '../lib/doctor.ts';
import {
  detectLevels,
  guideEnvNames,
  highestLevel,
  LEVELS,
  levelById,
  renderAuto,
  renderGuide,
  renderOnboardingDoc,
  shippedIndex,
  writeEnvForLevel,
} from '../lib/onboarding.ts';
import type { LevelId } from '../lib/onboarding.ts';
import { PLATFORMS_FOR } from '../lib/models/endpoints.ts';
import { PROVIDERS } from '../lib/models/providerMap.ts';
import type { ProviderId } from '../lib/models/providerMap.ts';
import { SKILL_TARGETS, agentsMdBlock, destinationsFor, installSkills, listSkills, resolveSkillsSource, writeAgentsMdPointer } from '../lib/skills.ts';
import { main as setupMain } from '../scripts/setup.ts';

const ROOT = process.cwd();
const AGENTS = join(ROOT, 'config', 'agents');

/** Every variable a level is detected from, cleared before each environment is set. */
const ENV_KEYS = [
  ...new Set([
    ...guideEnvNames(),
    'GEMINI_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'A2A_JWT_SECRET',
    'A2A_JWT_JWKS_URL',
    'MELCHIZEDEK_RUNTIME',
    'MELCHIZEDEK_DOTENV',
    'MELCHIZEDEK_AGENTS_DIR',
  ]),
];

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  let out: T;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (out instanceof Promise) return out.finally(restore) as T;
  restore();
  return out;
}

/** A key-shaped value assembled at run time, so no key-like literal sits in the source. */
function fakeKey(tag: string): string {
  return ['sk', tag, 'TESTONLY', randomBytes(18).toString('hex')].join('-');
}

const detected = (vars: Record<string, string>) =>
  withEnv(vars, () => detectLevels(runDoctor({ agentsDir: AGENTS })));

/** One environment per detectable level that turns that level, and no higher one, on. */
const ENV_FOR: Record<Exclude<LevelId, 'subscription-signin'>, Record<string, string>> = {
  local: {},
  'one-provider': { ANTHROPIC_API_KEY: 'test-only-anthropic' },
  'several-providers': { ANTHROPIC_API_KEY: 'test-only-anthropic', OPENAI_API_KEY: 'test-only-openai' },
  gateway: { MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'test-only-gateway' },
  'cloud-platform': { GEMINI_PLATFORM: 'vertex', GOOGLE_CLOUD_PROJECT: 'test-project', GOOGLE_CLOUD_LOCATION: 'global' },
  byok: { A2A_KEY_MODE: 'byok', A2A_SERVER_SECRET: 'test-only-secret-test-only-secret-0000' },
  'caller-tokens': { A2A_AUTH: 'callers', A2A_CALLERS: 'backend:' + '0'.repeat(64) },
  'oauth-grants': { MELCHIZEDEK_CREDENTIAL_KEY: 'test-only-credential-key' },
};

test('every detectable level is detected from the doctor\'s result, and is then the highest', () => {
  for (const level of LEVELS.filter((l) => l.detectable)) {
    const id = level.id as keyof typeof ENV_FOR;
    const d = detected(ENV_FOR[id]);
    assert.deepStrictEqual(d.map((x) => x.id), LEVELS.filter((l) => l.detectable).map((l) => l.id), 'one detection per detectable level, in menu order');
    assert.ok(d.find((x) => x.id === id)!.detected, `${id} is detected from its own environment`);
    assert.strictEqual(highestLevel(d).id, id, `${id} is the highest level for its environment`);
  }
  // The subscription entry is never detected: nothing reads a sign-in.
  assert.strictEqual(levelById('subscription-signin')!.detectable, false);
});

test('detection agrees with the doctor\'s own lines', () => {
  withEnv({ ANTHROPIC_API_KEY: 'test-only-a', MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'test-only-g', ANTHROPIC_PLATFORM: 'bedrock' }, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    const d = Object.fromEntries(detectLevels(result).map((x) => [x.id, x]));
    // Claude on Bedrock with no AWS_REGION: the doctor's endpoint problem is the level's problem.
    const bedrock = result.endpoints.find((e) => e.provider === 'anthropic')!;
    assert.strictEqual(bedrock.platform, 'bedrock');
    assert.ok(d['cloud-platform'].detected);
    for (const p of bedrock.problems) assert.ok(d['cloud-platform'].problems.includes(p));
    // A provider on a cloud platform is not a direct key; the gateway serves the rest.
    assert.strictEqual(d['one-provider'].detected, false);
    assert.strictEqual(d.gateway.detected, result.gateway!.usable);
    const gemini = result.providers.find((p) => p.provider === 'gemini')!;
    assert.strictEqual(gemini.transport, 'gateway');
  });
  // A serving problem the server would stop on is reported by name.
  const jwt = detected({ A2A_AUTH: 'jwt' });
  const serving = jwt.find((x) => x.id === 'caller-tokens')!;
  assert.ok(serving.detected);
  assert.ok(serving.problems.some((p) => p.includes('A2A_JWT_ISSUER')));
});

test('the guides cover every provider and platform the engine routes to, and name only variables it reads', () => {
  const one = levelById('one-provider')!.env.map((e) => e.name);
  for (const p of Object.keys(PROVIDERS) as ProviderId[]) {
    if (PROVIDERS[p].keyEnv) assert.ok(one.includes(PROVIDERS[p].keyEnv!), `level 2 names ${PROVIDERS[p].keyEnv}`);
  }
  const cloud = levelById('cloud-platform')!;
  const cloudText = renderGuide(cloud, 'package');
  for (const [provider, platforms] of Object.entries(PLATFORMS_FOR)) {
    for (const platform of platforms.filter((x) => x !== 'direct')) {
      assert.ok(cloudText.includes(`${provider.toUpperCase()}_PLATFORM`), `level 5 names ${provider.toUpperCase()}_PLATFORM`);
      assert.ok(cloudText.includes(platform), `level 5 names the ${platform} platform`);
    }
  }
  const template = readFileSync(join(ROOT, '.env.example'), 'utf-8');
  for (const name of guideEnvNames()) {
    assert.match(template, new RegExp(`\\b${name}\\b`), `${name} is documented in .env.example`);
  }
});

test('--auto picks the highest level and never prints a planted value', async () => {
  const planted: Record<string, string> = {
    GOOGLE_GENAI_API_KEY: fakeKey('gem'),
    ANTHROPIC_API_KEY: fakeKey('ant'),
    OPENAI_API_KEY: fakeKey('proj'),
    XAI_API_KEY: fakeKey('xai'),
    MOONSHOT_API_KEY: fakeKey('moon'),
    MODEL_GATEWAY: 'openrouter',
    MODEL_GATEWAY_API_KEY: fakeKey('or'),
    A2A_AUTH: 'secret',
    A2A_SERVER_SECRET: fakeKey('a2a'),
    MELCHIZEDEK_CREDENTIAL_KEY: fakeKey('seal'),
    MELCHIZEDEK_DOTENV: 'off',
  };
  const secrets = Object.entries(planted).filter(([k]) => !['MODEL_GATEWAY', 'A2A_AUTH', 'MELCHIZEDEK_DOTENV'].includes(k)).map(([, v]) => v);

  // The library function.
  const text = withEnv(planted, () => renderAuto(runDoctor({ agentsDir: AGENTS }), 'package'));
  assert.match(text, /Highest level detected: 8\. OAuth tool grants/);
  assert.match(text, /direct key set: .*ANTHROPIC_API_KEY/);
  for (const s of secrets) {
    assert.ok(!text.includes(s), 'a planted value appears in the --auto output');
    assert.ok(!text.includes(s.slice(-12)), 'a fragment of a planted value appears in the --auto output');
  }

  // The bin's own entry point, output captured.
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  let code: number;
  try {
    code = await withEnv({ ...planted, MELCHIZEDEK_AGENTS_DIR: AGENTS }, () => setupMain(['--auto', '--package']));
  } finally {
    console.log = log;
  }
  assert.strictEqual(code, 0);
  const printed = out.join('\n');
  assert.match(printed, /Highest level detected: 8\./);
  for (const s of secrets) assert.ok(!printed.includes(s), 'melchizedek-setup --auto printed a planted value');

  // One key alone: level 2.
  const single = withEnv({ OPENAI_API_KEY: fakeKey('proj') }, () => renderAuto(runDoctor({ agentsDir: AGENTS }), 'clone'));
  assert.match(single, /Highest level detected: 2\. One provider's API key/);
  assert.match(single, /npm run doctor/, 'the clone spelling is used for a clone');
});

test('--auto does not echo a value pasted into the wrong variable', () => {
  const misplaced = fakeKey('wrongplace');
  for (const name of ['MODEL_GATEWAY', 'A2A_AUTH', 'A2A_KEY_MODE']) {
    const text = withEnv({ [name]: misplaced }, () => renderAuto(runDoctor({ agentsDir: AGENTS }), 'package'));
    assert.ok(!text.toLowerCase().includes(misplaced.toLowerCase()), `${name}: the value is echoed`);
  }
});

test('ONBOARDING.md is exactly the generated guides', () => {
  const doc = readFileSync(join(ROOT, 'ONBOARDING.md'), 'utf-8');
  assert.strictEqual(doc, renderOnboardingDoc(), 'ONBOARDING.md drifted: regenerate with `npm run setup -- --markdown > ONBOARDING.md`');
  const shipped = shippedIndex();
  for (const level of LEVELS) assert.ok(doc.includes(renderGuide(level, 'package', shipped)), `${level.id}: the menu's guide is in the doc`);
});

test('the shipped index reads tiers from the doctor: keyless files are local, a Gemini key runs the templates', () => {
  const s = shippedIndex();
  assert.ok(s.byTier.keyless?.some((x) => x.startsWith('conversational')));
  assert.ok(s.byTier.gemini?.some((x) => x.startsWith('research_brief')));
  assert.ok(s.byTier['multi-provider']?.some((x) => x.startsWith('model_zoo')));
  assert.ok(s.templates.includes('support_triage'));
  // Every first command's template exists.
  for (const level of LEVELS) {
    for (const cmd of [...level.first.package, ...level.first.clone]) {
      const m = cmd.match(/--template (\S+)/);
      if (m) assert.ok(existsSync(join(AGENTS, 'templates', `${m[1]}.yaml`)) || existsSync(join(AGENTS, 'examples', `${m[1]}.yaml`)), `${level.id}: ${m[1]} ships`);
    }
  }
});

test('writeEnvForLevel: only when git ignores .env, never over a file, every name blank, mode 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-setup-'));
  try {
    const level = levelById('gateway')!;
    const refused = writeEnvForLevel(level, { cwd: dir, checkIgnored: () => ({ ignored: false, reason: 'not ignored' }) });
    assert.strictEqual(refused.status, 'not-ignored');
    assert.ok(!existsSync(join(dir, '.env')));

    const r = writeEnvForLevel(level, { cwd: dir, checkIgnored: () => ({ ignored: true, reason: 'ok' }) });
    assert.strictEqual(r.status, 'written');
    const text = readFileSync(join(dir, '.env'), 'utf-8');
    assert.ok(text.startsWith(readFileSync(join(ROOT, '.env.example'), 'utf-8')), 'the template, verbatim, first');
    for (const name of level.env.map((e) => e.name)) assert.match(text, new RegExp(`^${name}=$`, 'm'), `${name} is present and blank`);
    assert.strictEqual(statSync(join(dir, '.env')).mode & 0o777, 0o600);

    writeFileSync(join(dir, '.env'), 'MINE=1\n');
    assert.strictEqual(writeEnvForLevel(level, { cwd: dir, checkIgnored: () => ({ ignored: true, reason: 'ok' }) }).status, 'exists');
    assert.strictEqual(readFileSync(join(dir, '.env'), 'utf-8'), 'MINE=1\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeEnvForLevel asks git: refused outside a repository and without an ignore rule, written with one', () => {
  const git = spawnSync('git', ['--version'], { stdio: 'ignore' });
  if (git.status !== 0) return; // no git here: the injected check above covers the logic
  const dir = mkdtempSync(join(tmpdir(), 'melch-setup-git-'));
  try {
    const level = levelById('local')!;
    assert.strictEqual(writeEnvForLevel(level, { cwd: dir }).status, 'not-ignored', 'not a git repository');
    spawnSync('git', ['init', '-q'], { cwd: dir });
    assert.strictEqual(writeEnvForLevel(level, { cwd: dir }).status, 'not-ignored', 'no ignore rule');
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    assert.strictEqual(writeEnvForLevel(level, { cwd: dir }).status, 'written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ONBOARDING_SKILLS = [...new Set(['melchizedek-onboard', ...LEVELS.map((l) => l.skill)])].sort();

test('every level names a shipped onboarding skill, and the triage skill routes to each', () => {
  const shipped = listSkills(resolveSkillsSource()).map((s) => s.name);
  for (const name of ONBOARDING_SKILLS) assert.ok(shipped.includes(name), `${name} ships in skills/`);
  const triage = readFileSync(join(resolveSkillsSource(), 'melchizedek-onboard', 'SKILL.md'), 'utf-8');
  for (const level of LEVELS) {
    assert.ok(triage.includes(`\`${level.id}\``), `the triage table names ${level.id}`);
    assert.ok(triage.includes(level.skill) || level.skill === 'melchizedek-onboard', `the triage table routes to ${level.skill}`);
  }
});

test('melchizedek-skills installs the onboarding skills to every target directory, project and global', () => {
  const proj = mkdtempSync(join(tmpdir(), 'melch-onboard-proj-'));
  const home = mkdtempSync(join(tmpdir(), 'melch-onboard-home-'));
  try {
    const targets = Object.keys(SKILL_TARGETS) as (keyof typeof SKILL_TARGETS)[];
    for (const opts of [{ projectRoot: proj, targets }, { global: true, home, targets }]) {
      const results = installSkills(opts);
      assert.deepStrictEqual(results.map((r) => r.destination), destinationsFor(opts));
      for (const r of results) {
        for (const name of ONBOARDING_SKILLS) {
          assert.ok(existsSync(join(r.destination, name, 'SKILL.md')), `${name} in ${r.destination}`);
        }
      }
    }
    // The default install reaches Claude Code and the shared .agents/skills location.
    assert.deepStrictEqual(destinationsFor({ projectRoot: proj }), [join(proj, '.claude/skills'), join(proj, '.agents/skills')]);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the AGENTS.md pointer: created, appended beside the owner\'s text, rewritten only between its markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-agentsmd-'));
  try {
    const dests = [join(dir, '.claude/skills'), join(dir, '.agents/skills')];
    assert.strictEqual(writeAgentsMdPointer(dir, dests).status, 'created');
    assert.strictEqual(writeAgentsMdPointer(dir, dests).status, 'unchanged');
    writeFileSync(join(dir, 'AGENTS.md'), '# Mine\n\nKeep this.\n');
    assert.strictEqual(writeAgentsMdPointer(dir, dests).status, 'appended');
    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
    assert.ok(text.startsWith('# Mine\n\nKeep this.\n'));
    assert.ok(text.includes(agentsMdBlock(dests, dir)));
    writeFileSync(join(dir, 'AGENTS.md'), text + '\nAfter.\n');
    assert.strictEqual(writeAgentsMdPointer(dir, [dests[1]]).status, 'updated');
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
    assert.ok(after.startsWith('# Mine\n\nKeep this.\n') && after.endsWith('\nAfter.\n'));
    assert.ok(!after.includes('.claude/skills'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every bin, melchizedek-setup among them, is compiled by the package build and ONBOARDING.md ships', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const build = JSON.parse(readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf-8'));
  assert.strictEqual(pkg.bin['melchizedek-setup'], './dist/scripts/setup.js');
  assert.ok(pkg.scripts.setup.includes('scripts/setup.ts'));
  for (const [bin, target] of Object.entries(pkg.bin as Record<string, string>)) {
    const source = target.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts');
    assert.ok(build.include.includes(source), `${bin}: ${source} is in tsconfig.build.json include`);
  }
  assert.ok(pkg.files.includes('ONBOARDING.md'));
  assert.ok(pkg.files.includes('skills'));
});

test('the repository\'s .agents/skills/ copy of the onboarding skills matches skills/', () => {
  const source = resolveSkillsSource();
  for (const name of ONBOARDING_SKILLS) {
    const copy = join(ROOT, '.agents', 'skills', name, 'SKILL.md');
    assert.ok(existsSync(copy), `${copy} exists (npm run skills:install -- --for agents --only ${ONBOARDING_SKILLS.join(',')})`);
    assert.strictEqual(readFileSync(copy, 'utf-8'), readFileSync(join(source, name, 'SKILL.md'), 'utf-8'), `${name}: .agents/skills drifted from skills/`);
  }
  // And the root AGENTS.md carries the installer's own pointer block.
  const agentsMd = readFileSync(join(ROOT, 'AGENTS.md'), 'utf-8');
  assert.ok(agentsMd.includes(agentsMdBlock([join(ROOT, '.agents', 'skills')], ROOT)));
});
