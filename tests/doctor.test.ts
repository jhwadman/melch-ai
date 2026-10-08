/**
 * tests/doctor.test.ts — the onboarding report, offline, against the real
 * starter pack. No network, no keys: the env is controlled per test.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  declaredTierOf,
  listSyndicateFiles,
  renderDoctor,
  runCommandFor,
  runDoctor,
  runtimeReport,
  tierOf,
} from '../lib/doctor.ts';

const AGENTS = path.join(process.cwd(), 'config', 'agents');
const ENV_KEYS = [
  'GOOGLE_GENAI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'MOONSHOT_API_KEY',
  'MODEL_GATEWAY',
  'MODEL_GATEWAY_API_KEY',
];

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('the providers line names each provider\'s own key when it is unset', () => {
  withEnv({}, () => {
    const text = renderDoctor(runDoctor({ agentsDir: AGENTS }));
    const line = text.split('\n').find((l) => l.startsWith('providers'))!;
    assert.match(line, /Moonshot Kimi MOONSHOT_API_KEY not set/);
    assert.match(line, /xAI Grok XAI_API_KEY not set/);
    assert.match(line, /Ollama \(local\) local/);
  });
});

test('listSyndicateFiles sees the root and examples/, never the schema or evals/', () => {
  const files = listSyndicateFiles(AGENTS);
  assert.ok(files.includes('examples/council.yaml'));
  assert.ok(!files.some((f) => f.includes('syndicateSchema')));
  assert.ok(!files.some((f) => f.startsWith('evals/')));
});

test('an empty env: every example is blocked or ready-local, and the Gemini key unlocks the most', () => {
  withEnv({}, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    const examples = result.syndicates.filter((s) => s.file.startsWith('examples/'));
    assert.ok(examples.length >= 16, `expected the starter pack, saw ${examples.length}`);
    for (const s of examples) {
      assert.ok(
        s.verdict.state === 'blocked' || s.verdict.state === 'ready-local',
        `${s.file} should not be ready with no keys, was ${s.verdict.state}`,
      );
      assert.equal(s.error, undefined, `${s.file}: ${s.error}`);
    }
    const local = examples.filter((s) => s.verdict.state === 'ready-local').map((s) => s.file);
    assert.deepEqual(local.sort(), ['examples/assistant.yaml', 'examples/council.yaml', 'examples/tutor.yaml']);
    assert.equal(result.unlocks[0]?.env, 'GOOGLE_GENAI_API_KEY');
    assert.ok(result.unlocks[0].syndicates.length >= 12);
    assert.equal(result.gateway, null);
  });
});

test('the Gemini key alone readies every Gemini-tier example', () => {
  withEnv({ GOOGLE_GENAI_API_KEY: 'g' }, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    const examples = result.syndicates.filter((s) => s.file.startsWith('examples/'));
    for (const s of examples) {
      if (s.tier === 'gemini') assert.equal(s.verdict.state, 'ready', s.file);
      if (s.tier === 'keyless') assert.equal(s.verdict.state, 'ready-local', s.file);
    }
    const zoo = examples.find((s) => s.file === 'examples/model_zoo.yaml')!;
    assert.equal(zoo.tier, 'multi-provider');
    assert.equal(zoo.verdict.state, 'blocked');
    assert.match(zoo.verdict.detail, /ANTHROPIC_API_KEY/);
  });
});

test('a gateway key alone readies every cloud example via the gateway and names what is lost', () => {
  withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k' }, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    assert.equal(result.counts.blocked, 0);
    assert.equal(result.gateway?.usable, true);
    const ares = result.syndicates.find((s) => s.file === 'examples/ares.yaml')!;
    assert.equal(ares.verdict.state, 'via-gateway');
    assert.match(ares.verdict.detail, /google_search lost/);
  });
});

test('adding the Gemini key beside the gateway moves Gemini agents back to direct with grounding', () => {
  withEnv({ GOOGLE_GENAI_API_KEY: 'g', MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k' }, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    const ares = result.syndicates.find((s) => s.file === 'examples/ares.yaml')!;
    assert.equal(ares.verdict.state, 'ready');
    assert.ok(ares.rows.every((r) => r.report.transport === 'direct'));
    const zoo = result.syndicates.find((s) => s.file === 'examples/model_zoo.yaml')!;
    assert.equal(zoo.verdict.state, 'via-gateway');
  });
});

test('declared tiers match the models in every example', () => {
  withEnv({}, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    for (const s of result.syndicates.filter((s) => s.file.startsWith('examples/'))) {
      assert.ok(s.declaredTier, `${s.file} has no "# tier:" header`);
      assert.equal(s.declaredTier, s.tier, `${s.file} header says ${s.declaredTier}, models say ${s.tier}`);
    }
  });
});

test('nested yaml_reference syndicates are walked and named under their parent', () => {
  // A fixture of its own, so the test does not depend on which syndicates
  // a checkout ships.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-nested-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'child.yaml'),
      [
        'syndicate_name: "Child"',
        'orchestrator:',
        '  name: "Kid"',
        '  model: "ollama/qwen3:8b"',
        '  instruction: "hi"',
        'subagents: []',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'parent.yaml'),
      [
        'syndicate_name: "Parent"',
        'orchestrator:',
        '  name: "Boss"',
        '  model: "gemini-3.8-flash"',
        '  instruction: "hi"',
        '  tools: ["web_search"]',
        'subagents:',
        '  - name: "child"',
        '    description: "the nested team"',
        '    yaml_reference: "child.yaml"',
        '',
      ].join('\n'),
    );
    withEnv({ GOOGLE_GENAI_API_KEY: 'g' }, () => {
      const result = runDoctor({ agentsDir: dir });
      const parent = result.syndicates.find((s) => s.file === 'parent.yaml')!;
      assert.deepEqual(
        parent.rows.map((r) => r.agent),
        ['Boss', 'child › Kid'],
      );
      assert.equal(parent.tier, 'multi-provider');
      assert.equal(parent.verdict.state, 'ready');
      assert.deepEqual(parent.rows[0].report.native, ['web_search']);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tierOf, declaredTierOf and runCommandFor', () => {
  assert.equal(tierOf([]), 'gemini');
  assert.equal(declaredTierOf(path.join(AGENTS, 'examples', 'council.yaml')), 'keyless');
  assert.equal(
    runCommandFor('examples/council.yaml', { 'syndicate:council': 'node x --syndicate council' }),
    'npm run syndicate:council',
  );
  assert.equal(runCommandFor('examples/style_council.yaml', { 'syndicate:council': 'node x --syndicate council' }), undefined);
});

test('renderDoctor never prints a key value', () => {
  withEnv({ GOOGLE_GENAI_API_KEY: 'sk-very-secret-value', MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'gw-secret' }, () => {
    const text = renderDoctor(runDoctor({ agentsDir: AGENTS }));
    assert.ok(!text.includes('sk-very-secret-value'));
    assert.ok(!text.includes('gw-secret'));
    assert.match(text, /ready/);
    assert.match(text, /Read-only/);
  });
});

test('capability gaps: each agent row names what its path cannot fully do (ADR 0019)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-gaps-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'thinker.yaml'),
      [
        'syndicate_name: Thinker',
        'orchestrator:',
        '  name: Lead',
        '  model: claude-sonnet-4-6',
        '  instruction: x',
        '  generateContentConfig:',
        '    thinkingConfig:',
        '      thinkingBudget: 2048',
        'subagents:',
        '  - name: Looker',
        '    description: looks at pictures',
        '    model: ollama/qwen3:8b',
        '    instruction: x',
        '    reasoning: low',
        '    tools: [load_memory]',
        '    outputSchema:',
        '      type: OBJECT',
        '      properties:',
        '        verdict: { type: STRING }',
        '  - name: Searcher',
        '    description: searches the web',
        '    model: ollama/qwen3:8b',
        '    instruction: x',
        '    tools: [web_search]',
        '  - name: Elsewhere',
        '    description: a remote agent',
        '    a2a_agent_url: https://agents.example.com/',
      ].join('\n'),
    );
    withEnv({ ANTHROPIC_API_KEY: 'fixture-ant-test-0123456789abcdef' }, () => {
      const result = runDoctor({ agentsDir: dir });
      const s = result.syndicates.find((x) => x.file === 'thinker.yaml')!;
      assert.ok(!s.error, s.error);
      const byAgent = Object.fromEntries(s.rows.map((r) => [r.agent, r]));

      // Claude delegating while thinking: signed thinking is replayed on the
      // tool loop (ADR 0046), so the path has no gap.
      assert.deepEqual(byAgent.Lead.gaps, []);
      // Ollama enforces the schema (json_schema, ADR 0096), so structured
      // output is no gap; a thinking model with tools re-reasons each step.
      assert.deepEqual(
        byAgent.Looker.gaps.map((g) => `${g.capability}:${g.support}`),
        ['thinking_with_tools:degraded'],
      );
      // A local model has no native search: the sentinel is dropped.
      assert.deepEqual(
        byAgent.Searcher.gaps.map((g) => `${g.capability}:${g.support}`),
        ['native_search:unsupported'],
      );
      // The remote agent has no local model, so no row borrows the orchestrator's.
      assert.ok(!('Elsewhere' in byAgent));
      // Gaps inform; they do not block.
      assert.equal(s.verdict.state, 'ready');

      const text = renderDoctor(result);
      assert.match(text, /native web search unsupported on ollama/);
      assert.doesNotMatch(text, /structured output \(outputSchema\)/);
      assert.match(text, /degraded on ollama/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan-dispatch orchestrators do not need delegation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-dispatch-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'router.yaml'),
      [
        'syndicate_name: Router',
        'dispatch:',
        '  default_route: Answer',
        'orchestrator:',
        '  name: Triage',
        '  model: ollama/qwen3:8b',
        '  instruction: x',
        'subagents:',
        '  - name: Answer',
        '    description: answers',
        '    model: ollama/qwen3:8b',
        '    instruction: x',
      ].join('\n'),
    );
    withEnv({}, () => {
      const s = runDoctor({ agentsDir: dir }).syndicates.find((x) => x.file === 'router.yaml')!;
      assert.ok(!s.error, s.error);
      assert.deepEqual(s.rows.flatMap((r) => r.gaps), []);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The runtime line (ADR 0102) ──────────────────────────────────────────────

const installed = () => true;
const absent = () => false;

test('the runtime line: native by default, where it came from, and whether @google/adk is installed', () => {
  assert.deepStrictEqual(runtimeReport({}, absent), { runtime: 'native', source: 'default', adk: { installed: false, needed: false } });
  const withAdk = runtimeReport({}, installed);
  assert.strictEqual(withAdk.adk.installed, true);
  assert.strictEqual(withAdk.adk.needed, false);
  assert.strictEqual(withAdk.problem, undefined);
  assert.deepStrictEqual(
    { ...runtimeReport({ MELCHIZEDEK_RUNTIME: 'native' }, absent) },
    { runtime: 'native', source: 'MELCHIZEDEK_RUNTIME', adk: { installed: false, needed: false } },
  );
  const adk = runtimeReport({ MELCHIZEDEK_RUNTIME: 'adk' }, installed);
  assert.strictEqual(adk.runtime, 'adk');
  assert.strictEqual(adk.source, 'MELCHIZEDEK_RUNTIME');
  assert.strictEqual(adk.adk.needed, true);
  assert.strictEqual(adk.problem, undefined);
});

test('the runtime line: adk without @google/adk, and a value no turn accepts, are problems --check fails on', () => {
  const missing = runtimeReport({ MELCHIZEDEK_RUNTIME: 'adk' }, absent);
  assert.strictEqual(missing.runtime, 'adk');
  assert.match(missing.problem ?? '', /needs @google\/adk, which is not installed: npm install @google\/adk@~2\.2\.0/);
  const invalid = runtimeReport({ MELCHIZEDEK_RUNTIME: 'langgraph' }, installed);
  assert.strictEqual(invalid.runtime, undefined);
  assert.match(invalid.problem ?? '', /MELCHIZEDEK_RUNTIME must be "adk" or "native"/);
});

test('renderDoctor prints the runtime line first, and the ADK version this checkout resolves', () => {
  withEnv({}, () => {
    const saved = process.env.MELCHIZEDEK_RUNTIME;
    delete process.env.MELCHIZEDEK_RUNTIME;
    try {
      const result = runDoctor({ agentsDir: AGENTS });
      assert.strictEqual(result.runtime.runtime, 'native');
      assert.strictEqual(result.runtime.source, 'default');
      // The repository installs @google/adk as a dev dependency.
      assert.strictEqual(result.runtime.adk.installed, true);
      assert.match(result.runtime.adk.version ?? '', /^\d+\.\d+\.\d+/);
      const lines = renderDoctor(result).split('\n');
      assert.match(lines[2] ?? '', /^runtime {5}✓ native \(the default\) · @google\/adk \d+\.\d+\.\d+\S* installed$/);
      const missing = renderDoctor({ ...result, runtime: runtimeReport({ MELCHIZEDEK_RUNTIME: 'adk' }, absent) }).split('\n')[2] ?? '';
      assert.match(missing, /^runtime {5}✗ adk \(MELCHIZEDEK_RUNTIME\) · MELCHIZEDEK_RUNTIME=adk needs @google\/adk/);
      const without = renderDoctor({ ...result, runtime: runtimeReport({}, absent) }).split('\n')[2] ?? '';
      assert.match(without, /@google\/adk not installed \(needed only for MELCHIZEDEK_RUNTIME=adk\)$/);
    } finally {
      if (saved !== undefined) process.env.MELCHIZEDEK_RUNTIME = saved;
    }
  });
});
