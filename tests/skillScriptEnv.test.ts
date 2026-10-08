/**
 * tests/skillScriptEnv.test.ts — a skill script runs with a minimal
 * environment and capped output (WS3-3b, ADR 0086).
 *
 * Offline: scripted models, no provider call. Every value set here is an
 * obvious fake, and no test prints a variable's value: the assertions
 * compare what the script printed with a fake, or with "unset".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';

import { LocalScriptExecutor } from '../lib/tools/skills/executor.ts';
import { BASE_ENV_NAMES, CappedText, SCRIPT_OUTPUT_CHAR_LIMIT, isSecretShapedEnvName, scriptEnvironment } from '../lib/tools/skills/env.ts';
import { HarnessSkillToolset, loadSkillSuite } from '../lib/tools/skillToolset.ts';
import { SyndicateValidationError, validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall } from './helpers/scriptedModel.ts';

setLogLevel(LogLevel.ERROR);

const FAKE = 'fake-value-not-a-credential';
const PRINT_ENV = `console.log(JSON.stringify({ key: process.env.OPENAI_API_KEY ?? 'unset', db: process.env.DATABASE_URL ?? 'unset', allowed: process.env.WS3_3B_ALLOWED ?? 'unset', home: process.env.HOME ?? process.env.USERPROFILE ?? 'unset', path: process.env.PATH ? 'set' : 'unset', lc: process.env.LC_WS3_3B ?? 'unset' }));`;

async function printedEnv(executor: LocalScriptExecutor): Promise<Record<string, string>> {
  const result = await executor.run({ code: PRINT_ENV, language: 'javascript' });
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

const SOURCE = { PATH: process.env.PATH, HOME: '/home/fake', OPENAI_API_KEY: FAKE, DATABASE_URL: FAKE, WS3_3B_ALLOWED: 'yes', LC_WS3_3B: 'C' };

// ── The environment ──────────────────────────────────────────────────────────

test('a script that prints a provider key or the database URL gets nothing', async () => {
  const env = await printedEnv(new LocalScriptExecutor({ sourceEnv: SOURCE }));
  assert.equal(env.key, 'unset');
  assert.equal(env.db, 'unset');
  assert.equal(env.allowed, 'unset', 'an unlisted name does not cross either');
  assert.equal(env.path, 'set', 'the base allowlist still reaches the interpreter');
  assert.equal(env.home, '/home/fake');
  assert.equal(env.lc, 'C', 'every LC_* crosses');
});

test('a name the YAML lists reaches the script; a secret one only when listed', async () => {
  assert.equal((await printedEnv(new LocalScriptExecutor({ sourceEnv: SOURCE, envNames: ['WS3_3B_ALLOWED'] }))).allowed, 'yes');
  assert.equal((await printedEnv(new LocalScriptExecutor({ sourceEnv: SOURCE, envNames: ['OPENAI_API_KEY'] }))).key, FAKE);
  assert.equal((await printedEnv(new LocalScriptExecutor({ sourceEnv: SOURCE, envNames: ['NOT_SET_ANYWHERE'] }))).allowed, 'unset');
});

test('the default executor reads process.env, and still withholds what is not listed', async () => {
  const had = Object.hasOwn(process.env, 'OPENAI_API_KEY');
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = FAKE;
  process.env.WS3_3B_ALLOWED = 'yes';
  try {
    const env = await printedEnv(new LocalScriptExecutor({ envNames: ['WS3_3B_ALLOWED'] }));
    assert.equal(env.key, 'unset');
    assert.equal(env.allowed, 'yes');
  } finally {
    if (had) process.env.OPENAI_API_KEY = saved;
    else delete process.env.OPENAI_API_KEY;
    delete process.env.WS3_3B_ALLOWED;
  }
});

test('scriptEnvironment copies only the allowlist, LC_* and the listed names', () => {
  const env = scriptEnvironment(['EXTRA'], { PATH: '/bin', EXTRA: 'x', ANTHROPIC_API_KEY: FAKE, A2A_SERVER_SECRET: FAKE, LC_ALL: 'C', NODE_OPTIONS: '--x' });
  assert.deepEqual(Object.keys(env).sort(), ['EXTRA', 'LC_ALL', 'PATH']);
  for (const name of BASE_ENV_NAMES) assert.equal(isSecretShapedEnvName(name), false, `${name} is in the base allowlist`);
});

test('secret-shaped names: every credential in .env.example, and not the ordinary ones', () => {
  for (const name of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_GENAI_API_KEY',
    'XAI_API_KEY',
    'MODEL_GATEWAY_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'DATABASE_URL',
    'A2A_REDIS_URL',
    'A2A_SERVER_SECRET',
    'A2A_JWT_SECRET',
    'A2A_METRICS_TOKEN',
    'MCP_BEARER_TOKENS',
    'MELCHIZEDEK_CREDENTIAL_KEY',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'GITHUBTOKEN',
    'DB_PASSWORD',
    'aws_secret_access_key',
  ]) {
    assert.ok(isSecretShapedEnvName(name), name);
  }
  for (const name of ['OLLAMA_BASE_URL', 'WEB_EXTRACT_CHAR_LIMIT', 'MY_TOOL_HOME', 'PORT', 'REPORT_FORMAT']) assert.ok(!isSecretShapedEnvName(name), name);
});

// ── The output cap ───────────────────────────────────────────────────────────

test('stdout and stderr over the cap are cut, with a marker the model reads', async () => {
  const executor = new LocalScriptExecutor({ sourceEnv: SOURCE });
  const n = SCRIPT_OUTPUT_CHAR_LIMIT + 5_000;
  const result = await executor.run({ code: `process.stdout.write('a'.repeat(${n})); process.stderr.write('b'.repeat(${n})); process.exitCode = 3;`, language: 'javascript' });
  assert.equal(result.stdout, `${'a'.repeat(SCRIPT_OUTPUT_CHAR_LIMIT)}\n[stdout truncated: 5000 more characters not shown (the limit is ${SCRIPT_OUTPUT_CHAR_LIMIT})]`);
  assert.equal(result.stderr, `${'b'.repeat(SCRIPT_OUTPUT_CHAR_LIMIT)}\n[stderr truncated: 5000 more characters not shown (the limit is ${SCRIPT_OUTPUT_CHAR_LIMIT})]`);
});

test('output under the cap is returned whole, multi-byte characters intact', async () => {
  const executor = new LocalScriptExecutor({ sourceEnv: SOURCE, maxOutputChars: 50 });
  const result = await executor.run({ code: `process.stdout.write('é'.repeat(40));`, language: 'javascript' });
  assert.equal(result.stdout, 'é'.repeat(40));
});

test('the timeout line follows the capped stderr', async () => {
  const executor = new LocalScriptExecutor({ sourceEnv: SOURCE, maxOutputChars: 10, timeoutSeconds: 1 });
  const result = await executor.run({ code: `process.stderr.write('x'.repeat(100)); setInterval(() => {}, 1000);`, language: 'javascript' });
  assert.match(result.stderr, /^x{10}\n\[stderr truncated: 90 more characters not shown \(the limit is 10\)\]\nCode execution timed out after 1 seconds\.$/);
});

test('CappedText counts chunks that arrive after the cap', () => {
  const capped = new CappedText(5);
  for (const chunk of ['abc', 'def', 'ghi']) capped.push(chunk);
  assert.equal(capped.text('stdout'), 'abcde\n[stdout truncated: 4 more characters not shown (the limit is 5)]');
});

// ── The YAML ─────────────────────────────────────────────────────────────────

const config = (skills: Record<string, unknown>) => ({
  syndicate_name: 'S',
  orchestrator: { name: 'Lead', model: 'gemini-3.5-flash-lite', instruction: 'x', skills: { dir: 'skills', scripts: 'local', ...skills } },
  subagents: [],
});

test('schema: env takes names only, refuses a secret-shaped one, and secret_env admits it', () => {
  assert.doesNotThrow(() => validateSyndicateConfig(config({ env: ['MY_TOOL_HOME'], secret_env: ['MY_API_TOKEN'] }), 't'));
  assert.throws(
    () => validateSyndicateConfig(config({ env: ['MY_TOOL_HOME', 'OPENAI_API_KEY'] }), 't'),
    (e: unknown) => e instanceof SyndicateValidationError && /skills\.env\[1\]/.test(e.message) && /secret_env/.test(e.message),
  );
  assert.throws(() => validateSyndicateConfig(config({ env: ['MY_TOOL_HOME=1'] }), 't'), /environment variable name/);
  assert.throws(() => validateSyndicateConfig(config({ env: ['my_tool_home'] }), 't'), /environment variable name/);
  assert.throws(() => validateSyndicateConfig(config({ scripts: 'none', env: ['MY_TOOL_HOME'] }), 't'), /scripts: "local"/);
});

test('the harness hands the YAML names to its executor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws3-3b-'));
  try {
    const toolset = new HarnessSkillToolset(await loadSkillSuite(join(process.cwd(), 'tests', 'fixtures', 'skills')), { dir, scripts: 'local', env: ['MY_TOOL_HOME'], secret_env: ['MY_API_TOKEN'] });
    assert.deepEqual(toolset.executor?.envNames, ['MY_TOOL_HOME', 'MY_API_TOKEN']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── End to end, on both runtimes ─────────────────────────────────────────────

function shelf(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws3-3b-shelf-'));
  mkdirSync(join(dir, 'env-probe', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'env-probe', 'SKILL.md'), '---\nname: env-probe\ndescription: Reports which variables a script can see.\n---\nRun scripts/probe.js.\n');
  writeFileSync(join(dir, 'env-probe', 'scripts', 'probe.js'), PRINT_ENV);
  return dir;
}

for (const runtime of ['adk', 'native'] as const) {
  test(`an approved run on ${runtime} sees the listed name and never the key`, async () => {
    const dir = shelf();
    const had = Object.hasOwn(process.env, 'OPENAI_API_KEY');
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = FAKE;
    process.env.WS3_3B_ALLOWED = 'yes';
    try {
      const cfg = validateSyndicateConfig(
        {
          syndicate_name: 'Probe',
          orchestrator: { name: 'Probe', model: 'scripted/probe', instruction: 'x', skills: { dir, scripts: 'local', env: ['WS3_3B_ALLOWED'] } },
          subagents: [],
        },
        't',
      ) as SyndicateYamlConfig;
      let seen = '';
      const model = new ScriptedModel('scripted/probe', (req, n) => {
        if (n === 1) return toolCall('run_skill_script', { skill_name: 'env-probe', script_path: 'scripts/probe.js' }, 'call-probe');
        seen = JSON.stringify(lastToolResult(req) ?? null);
        return answer('done');
      });
      const sessionService = new InMemorySessionService();
      const turn = (parts: any[]) =>
        runSyndicateTurn({ config: cfg, parts, appName: 'app', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: shimResolver({ probe: model }), log: () => {} }, trace: false, runtime });
      const first = await turn([{ text: 'probe' }]);
      assert.equal(first.status, 'input-required');
      const second = await turn([approvalResponsePart(first.approval!.id, true)]);
      assert.equal(second.status, 'completed');
      assert.ok(seen.includes('\\"allowed\\":\\"yes\\"'), 'the listed name reached the script');
      assert.ok(seen.includes('\\"key\\":\\"unset\\"'), 'the provider key did not');
      assert.ok(!seen.includes(FAKE));
    } finally {
      if (had) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
      delete process.env.WS3_3B_ALLOWED;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
