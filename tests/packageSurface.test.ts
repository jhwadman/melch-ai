/**
 * tests/packageSurface.test.ts — the published package surface (WS1-12,
 * ADR 0068, ADR 0102): the `melchizedek-agents/model` entry loads no
 * @google/adk, every path in the exports map resolves after the package
 * build, and the build serves every shipped syndicate on the default
 * (native) runtime with @google/adk not installed.
 *
 * Three proofs for ./model, each stronger than the last:
 *   1. the source's runtime import graph (static imports that are not
 *      `import type`) names no @google/adk and reaches neither the compiler
 *      nor the ADK registry;
 *   2. a child process with @google/adk made unresolvable imports the entry,
 *      from source and from the build, and builds a Claude and an Ollama
 *      request through it (fetch is stubbed; nothing leaves the process);
 *   3. the built declaration files it exposes name no @google/adk either,
 *      so a TypeScript consumer without ADK sees whole types.
 *
 * The build goes to a temporary directory under the repo root (so the
 * compiled files resolve the repo's node_modules) and is removed after.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT, runtimeImportsOf } from './helpers/importGraph.ts';
import { everyExampleTurnScript, lastJson, runWithoutAdk } from './helpers/withoutAdk.ts';
import { GeminiAdapter, OllamaAdapter, ClaudeAdapter, resolveAdapter, resolveAdapterWithFallback, FallbackAdapter } from '../lib/model.ts';

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
  exports: Record<string, string>;
};

const isAdk = (spec: string): boolean => spec === '@google/adk' || spec.startsWith('@google/adk/');

/** The module a static import or export-from statement names. */
function specifierOf(statement: string): string {
  return /['"]([^'"]+)['"]\s*$/.exec(statement)![1];
}

/** Every module reachable from `entry` through runtime (non-type) static imports, with the specifiers each names. */
function runtimeGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [path.resolve(ROOT, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (graph.has(file)) continue;
    const specs = runtimeImportsOf(file).map(specifierOf);
    graph.set(file, specs);
    for (const s of specs) if (s.startsWith('.')) pending.push(path.resolve(path.dirname(file), s));
  }
  return graph;
}

// ── 1. The source's runtime import graph ─────────────────────────────────────

test('./model: no module in its runtime import graph names @google/adk', () => {
  const graph = runtimeGraph('lib/model.ts');
  const adk = [...graph].flatMap(([file, specs]) => specs.filter(isAdk).map((s) => `${path.relative(ROOT, file)} → ${s}`));
  assert.deepEqual(adk, []);
  const files = new Set([...graph.keys()].map((f) => path.relative(ROOT, f)));
  for (const unwanted of ['lib/compile.ts', 'lib/models/registry.ts', 'lib/models/adkGeminiAdapter.ts', 'lib/models/adkShim.ts', 'lib/tools/webSearchTool.ts', 'lib/adkPeer.ts']) {
    assert.ok(!files.has(unwanted), `${unwanted} is reached from lib/model.ts`);
  }
  for (const wanted of ['lib/models/claudeAdapter.ts', 'lib/models/grokAdapter.ts', 'lib/models/geminiAdapter.ts', 'lib/models/fallbackAdapter.ts', 'lib/tools/xaiSearchParams.ts']) {
    assert.ok(files.has(wanted), `${wanted} is not reached from lib/model.ts`);
  }
});

test('the graph walk sees ADK where it is (control)', () => {
  // ADK's values come through lib/adkPeer.ts, the one module that loads it (ADR 0102).
  const files = [...runtimeGraph('lib/models/registry.ts').keys()].map((f) => path.relative(ROOT, f));
  assert.ok(files.includes('lib/adkPeer.ts'), 'registry.ts reaches the module that loads @google/adk');
  assert.ok(runtimeImportsOf('lib/tools/webSearchTool.ts').map(specifierOf).includes('../adkPeer.ts'));
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'adkPeer.ts'), 'utf8'), /await import\('@google\/adk'\)/);
});

// ── The Gemini choice through ./model ────────────────────────────────────────

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('./model resolves a Gemini id to GeminiAdapter, and refuses `adk` by name', async () => {
  await withEnv({ GOOGLE_GENAI_API_KEY: 'fixture-gemini', GEMINI_ADAPTER: undefined, MODEL_GATEWAY: undefined }, () => {
    assert.ok(resolveAdapter('gemini-3.5-flash') instanceof GeminiAdapter);
    assert.ok(resolveAdapter('gemini-3.5-flash', { gemini: 'engine' }) instanceof GeminiAdapter);
    assert.throws(() => resolveAdapter('gemini-3.5-flash', { gemini: 'adk' }), /melchizedek-agents\/models\/registry/);
  });
  await withEnv({ GOOGLE_GENAI_API_KEY: 'fixture-gemini', GEMINI_ADAPTER: 'adk', ANTHROPIC_API_KEY: 'fixture-anthropic', MODEL_GATEWAY: undefined }, () => {
    assert.throws(() => resolveAdapter('gemini-3.5-flash'), /not available from melchizedek-agents\/model/);
    assert.ok(resolveAdapter('gemini-3.5-flash', { gemini: 'engine' }) instanceof GeminiAdapter, 'the option wins over the environment');
    assert.ok(resolveAdapter('claude-sonnet-4-6') instanceof ClaudeAdapter, 'GEMINI_ADAPTER touches only Gemini ids');
  });
  await withEnv({ GOOGLE_GENAI_API_KEY: 'fixture-gemini', GEMINI_ADAPTER: 'genai', MODEL_GATEWAY: undefined }, () => {
    assert.throws(() => resolveAdapter('gemini-3.5-flash'), /GEMINI_ADAPTER must be "adk" or "engine"/);
  });
});

test('./model resolves the other prefixes and a fallback pair', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'fixture-anthropic', GOOGLE_GENAI_API_KEY: 'fixture-gemini', GEMINI_ADAPTER: undefined, MODEL_GATEWAY: undefined }, () => {
    assert.ok(resolveAdapter('ollama/qwen3:8b') instanceof OllamaAdapter);
    assert.ok(resolveAdapter('claude-sonnet-4-6') instanceof ClaudeAdapter);
    const pair = resolveAdapterWithFallback('claude-sonnet-4-6', 'gemini-3.5-flash');
    assert.ok(pair instanceof FallbackAdapter);
  });
});

// ── 2 and 3. The build ───────────────────────────────────────────────────────

let out = '';

before(() => {
  out = fs.mkdtempSync(path.join(ROOT, '.pkgsurface-'));
  const tsc = path.join(ROOT, 'node_modules', '.bin', 'tsc');
  execFileSync(tsc, ['-p', path.join(ROOT, 'tsconfig.build.json'), '--outDir', out], { cwd: ROOT, stdio: 'pipe' });
});

after(() => {
  if (out) fs.rmSync(out, { recursive: true, force: true });
});

test('every path in the exports map resolves after the build', () => {
  assert.equal(PKG.exports['./model'], './dist/lib/model.js');
  const missing: string[] = [];
  for (const [key, target] of Object.entries(PKG.exports)) {
    if (!target.startsWith('./dist/')) {
      if (!fs.existsSync(path.join(ROOT, target))) missing.push(`${key} → ${target}`);
      continue;
    }
    const built = path.join(out, target.slice('./dist/'.length));
    if (built.includes('*')) {
      const dir = path.dirname(built);
      const suffix = path.basename(built).replaceAll('*', '');
      const matches = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(suffix)) : [];
      if (matches.length === 0) missing.push(`${key} → ${target}`);
    } else {
      if (!fs.existsSync(built)) missing.push(`${key} → ${target}`);
      if (built.endsWith('.js') && !fs.existsSync(built.replace(/\.js$/, '.d.ts'))) missing.push(`${key} → ${target} (no .d.ts)`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the built ./model declarations name no @google/adk', () => {
  const seen = new Set<string>();
  const pending = [path.join(out, 'lib', 'model.d.ts')];
  const adk: string[] = [];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const statement of runtimeImportsOf(file).concat(typeImportsOf(file))) {
      const spec = specifierOf(statement);
      if (isAdk(spec)) adk.push(`${path.relative(out, file)} → ${spec}`);
      if (spec.startsWith('.')) pending.push(path.resolve(path.dirname(file), spec.replace(/\.(?:ts|js)$/, '.d.ts')));
    }
  }
  assert.ok(seen.size > 10, `walked ${seen.size} declaration files`);
  assert.deepEqual(adk, []);
});

/** The `import type` / `export type ... from` statements in a file (runtimeImportsOf leaves these out). */
function typeImportsOf(file: string): string[] {
  const code = fs.readFileSync(file, 'utf8');
  return code.match(/^\s*(?:import|export)\s+type\b[^;]*?\bfrom\s*['"][^'"]+['"]/gm) ?? [];
}

/** The child process for ./model: @google/adk unresolvable, a fixture Anthropic key. */
const withoutAdk = (script: string) => runWithoutAdk(script, { env: { ANTHROPIC_API_KEY: 'fixture-anthropic' } });

/** Imports the entry, stubs fetch, and builds one Claude and one Ollama request through it. */
function buildRequestsScript(entry: string): string {
  return `
    const m = await import(${JSON.stringify(pathToFileURL(entry).href)});
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'stubbed' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    };
    const req = { model: '', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] };
    const finals = [];
    for (const adapter of [new m.ClaudeAdapter({ model: 'claude-sonnet-4-6' }), new m.OllamaAdapter({ model: 'ollama/qwen3:8b', baseUrl: 'http://127.0.0.1:9/v1' })]) {
      for await (const r of adapter.generate({ ...req, model: adapter.model })) if (r.partial === false) finals.push(r.error?.code ?? 'ok');
    }
    let blocked = false;
    try { await import('@google/adk'); } catch { blocked = true; }
    console.log(JSON.stringify({ blocked, calls: calls.map((c) => ({ host: new URL(c.url).host, path: new URL(c.url).pathname, model: c.body.model })), finals }));
  `;
}

function assertBuiltRequests(stdout: string): void {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  const got = JSON.parse(line) as { blocked: boolean; calls: Array<{ host: string; path: string; model: string }>; finals: string[] };
  assert.equal(got.blocked, true, 'the hook makes @google/adk unresolvable');
  assert.equal(got.finals.length, 2, 'each adapter ends its call with one final');
  const claude = got.calls.find((c) => c.host === 'api.anthropic.com');
  assert.ok(claude, `a Claude request was built: ${line}`);
  assert.equal(claude.path, '/v1/messages');
  assert.equal(claude.model, 'claude-sonnet-4-6');
  const ollama = got.calls.find((c) => c.host === '127.0.0.1:9');
  assert.ok(ollama, `an Ollama request was built: ${line}`);
  assert.equal(ollama.path, '/v1/chat/completions');
  assert.equal(ollama.model, 'qwen3:8b');
}

test('./model loads and builds Claude and Ollama requests with @google/adk unresolvable (source)', () => {
  const r = withoutAdk(buildRequestsScript(path.join(ROOT, 'lib', 'model.ts')));
  assert.equal(r.status, 0, r.stderr);
  assertBuiltRequests(r.stdout);
});

test('./model loads and builds Claude and Ollama requests with @google/adk unresolvable (build)', () => {
  const r = withoutAdk(buildRequestsScript(path.join(out, 'lib', 'model.js')));
  assert.equal(r.status, 0, r.stderr);
  assertBuiltRequests(r.stdout);
});

// ── The build without @google/adk (ADR 0102) ────────────────────────────────

/** Every syndicate the package ships, as loadSyndicate names it. */
const SHIPPED = fs
  .readdirSync(path.join(ROOT, 'config', 'agents'), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.yaml') && !f.endsWith('syndicateSchema.yaml'))
  .sort();

test('the build serves every shipped syndicate on the default runtime with @google/adk not installed, and names the package for adk', () => {
  assert.ok(SHIPPED.length >= 30, `${SHIPPED.length} syndicates`);
  const r = runWithoutAdk(everyExampleTurnScript(out, '.js', SHIPPED));
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const got = lastJson<{ blocked: boolean; installed: boolean; defaultRuntime: string; calls: number; turns: Record<string, string>; adkError: string }>(r.stdout);
  assert.equal(got.blocked, true, 'the hook makes @google/adk unresolvable');
  assert.equal(got.installed, false);
  assert.equal(got.defaultRuntime, 'native');
  assert.deepEqual(Object.keys(got.turns), SHIPPED);
  const notServed = Object.entries(got.turns).filter(([, status]) => status !== 'completed');
  assert.deepEqual(notServed, [], 'every syndicate completes a turn');
  assert.ok(got.calls >= SHIPPED.length, 'every turn called the scripted model');
  assert.match(got.adkError, /^AdkNotInstalledError: The adk runtime .*needs @google\/adk, which is not installed/);
});

test('the control: an installed @google/adk that fails to load is an error, not an absent package', () => {
  const r = runWithoutAdk(`await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'models', 'registry.ts')).href)});`, {
    failWith: 'adk is broken here',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /adk is broken here/);
});
