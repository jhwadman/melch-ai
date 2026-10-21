/**
 * Offline tests of the engine's code sandbox (lib/sandbox/, ADR 0137 Part A)
 * and the run_code tool (lib/tools/runCodeTool.ts). The sandbox needs no
 * model: QuickJS in wasm on a worker thread, run for real. The turn cases
 * drive runSyndicateTurn with scripted models.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { after, test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CodeSandboxOffError, SandboxHalt, codeSandboxEnabled, refuseWithoutSandbox, runInSandbox } from '../lib/sandbox/sandbox.ts';
import { runCodeTool } from '../lib/tools/runCodeTool.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { resolveTools } from '../lib/toolRegistry.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall } from './helpers/scriptedModel.ts';

const withSandbox = async <T>(on: boolean, fn: () => Promise<T>): Promise<T> => {
  const before = process.env.MELCHIZEDEK_CODE_SANDBOX;
  if (on) process.env.MELCHIZEDEK_CODE_SANDBOX = 'on';
  else delete process.env.MELCHIZEDEK_CODE_SANDBOX;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.MELCHIZEDEK_CODE_SANDBOX;
    else process.env.MELCHIZEDEK_CODE_SANDBOX = before;
  }
};

// ── The sandbox ──────────────────────────────────────────────────────────────

test('sandbox: the default export runs on the input; console output comes back as logs', async () => {
  const r = await runInSandbox({ source: 'export default ({ xs }) => { console.log("n =", xs.length); return xs.reduce((a, b) => a + b, 0) }', value: { xs: [1, 2, 3.5] } });
  assert.equal(r.ok, true);
  assert.equal(r.result, 6.5);
  assert.equal(r.logs, 'n = 3');
});

test('sandbox: async code, top-level await, and undefined returning as null', async () => {
  assert.equal((await runInSandbox({ source: 'const k = await Promise.resolve(2); export default async (x) => x * k' , value: 21 })).result, 42);
  const r = await runInSandbox({ source: 'export default () => undefined' });
  assert.equal(r.ok, true);
  assert.equal(r.result, null);
});

test('sandbox: nothing of the host is reachable, and the clock and randomness are masked', async () => {
  const r = await runInSandbox({ source: 'export default () => [typeof fetch, typeof process, typeof require, typeof setTimeout, typeof __host, typeof __log, new Date(0).toISOString()]' });
  assert.deepEqual(r.result, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', '1970-01-01T00:00:00.000Z']);
  for (const source of ['export default () => Math.random()', 'export default () => Date.now()', 'export default () => new Date()']) {
    const masked = await runInSandbox({ source });
    assert.equal(masked.ok, false, source);
    assert.equal(masked.error?.code, 'CODE_ERROR');
    assert.match(masked.error!.message, /not available in the sandbox/);
  }
  const imported = await runInSandbox({ source: "import fs from 'fs'; export default () => 1" });
  assert.equal(imported.ok, false);
  assert.match(imported.error!.message, /could not load module/);
});

test('sandbox: a process that ran sandboxes exits on its own (no worker left unable to exit, ADR 0142)', async () => {
  // With heap caps on the worker, a GC that a background compile job asked for while the
  // worker was exiting deadlocked Node's task drain: the worker never exited and held its
  // process open. One process hung about one time in four; eight make a regression loud.
  // The sandbox runs as .js, as the package ships it: its worker then runs without type
  // stripping, the case that hung. The copy sits under node_modules so its imports resolve.
  const fixture = fileURLToPath(new URL('./fixtures/sandbox/exitAfterRuns.ts', import.meta.url));
  const dir = fileURLToPath(new URL(`../node_modules/.cache/sandbox-exit-${process.pid}/`, import.meta.url));
  mkdirSync(dir, { recursive: true });
  for (const name of ['sandbox', 'worker']) {
    writeFileSync(join(dir, `${name}.js`), stripTypeScriptTypes(readFileSync(new URL(`../lib/sandbox/${name}.ts`, import.meta.url), 'utf8')));
  }
  const compiled = pathToFileURL(join(dir, 'sandbox.js')).href;
  after(() => rmSync(dir, { recursive: true, force: true }));
  const one = () =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', fixture, compiled, '2'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(`still running after 45 s: ${out.trim()}`);
      }, 45_000);
      child.on('exit', (code) => {
        clearTimeout(deadline);
        resolve(code === 0 && out.includes('ran') ? 'exited' : `exit ${code}: ${out.trim()}`);
      });
    });
  const outcomes = await Promise.all(Array.from({ length: 8 }, one));
  assert.deepEqual(outcomes, Array(8).fill('exited'));
});

test('sandbox: the CPU budget, the stack limit and a thrown error each end the run by name', async () => {
  const spin = await runInSandbox({ source: 'export default () => { for (;;) {} }', limits: { cpuMs: 200 } });
  assert.equal(spin.error?.code, 'CPU_LIMIT');
  const deep = await runInSandbox({ source: 'const r = () => r(); export default () => r()' });
  assert.equal(deep.error?.code, 'STACK_LIMIT');
  const thrown = await runInSandbox({ source: 'export default () => { throw new TypeError("bad input") }' });
  assert.deepEqual(thrown.error, { code: 'CODE_ERROR', message: 'TypeError: bad input' });
  const syntax = await runInSandbox({ source: 'export default (' });
  assert.equal(syntax.error?.code, 'CODE_ERROR');
  const noExport = await runInSandbox({ source: 'export const x = 1' });
  assert.match(noExport.error!.message, /export default/);
});

test('sandbox: a result past its bound is refused, and time awaiting the host is not charged', async () => {
  const big = await runInSandbox({ source: 'export default () => "x".repeat(5000)', limits: { maxResultChars: 1000 } });
  assert.equal(big.error?.code, 'RESULT_TOO_LARGE');
  // 400 ms of waiting on the host under a 200 ms CPU budget: the wait is not compute.
  const waited = await runInSandbox({
    source: 'export default async ({ wait }) => { await wait(); return "done" }',
    mode: 'api',
    functions: { wait: () => new Promise((r) => setTimeout(r, 400)) },
    limits: { cpuMs: 200 },
  });
  assert.equal(waited.ok, true, JSON.stringify(waited.error));
  assert.equal(waited.result, 'done');
});

test('sandbox: host functions cross as JSON, a host error is catchable, and parallel keeps call order', async () => {
  const r = await runInSandbox({
    source: `export default async ({ tag, echo, fail, parallel }) => {
      let caught = '';
      try { await fail() } catch (e) { caught = e.message }
      const xs = await parallel([3, 1, 2].map((n) => () => echo({ n })), { max: 2 });
      return { tag, caught, xs };
    }`,
    mode: 'api',
    value: { tag: 'T' },
    functions: {
      echo: async ([arg]) => {
        const { n } = arg as { n: number };
        await new Promise((res) => setTimeout(res, n * 20));
        return { got: n };
      },
      fail: async () => {
        throw new Error('the host refused');
      },
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.result, { tag: 'T', caught: 'the host refused', xs: [{ got: 3 }, { got: 1 }, { got: 2 }] });
});

test('sandbox: SandboxHalt ends the run on purpose, and the signal cancels it', async () => {
  const halted = await runInSandbox({
    source: 'export default async ({ ask }) => { await ask(); return "never" }',
    mode: 'api',
    functions: { ask: async () => { throw new SandboxHalt('waiting for a person', { id: 'q1' }); } },
  });
  assert.equal(halted.ok, false);
  assert.equal(halted.error?.code, 'HALTED');
  assert.deepEqual(halted.halt?.detail, { id: 'q1' });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const canceled = await runInSandbox({ source: 'export default async ({ hang }) => hang()', mode: 'api', functions: { hang: () => new Promise(() => {}) }, signal: ac.signal });
  assert.equal(canceled.error?.code, 'CANCELED');
});

// ── The switch ───────────────────────────────────────────────────────────────

test('switch: off by default; a syndicate that runs code is refused naming MELCHIZEDEK_CODE_SANDBOX', async () => {
  assert.equal(codeSandboxEnabled({}), false);
  assert.equal(codeSandboxEnabled({ MELCHIZEDEK_CODE_SANDBOX: 'on' }), true);
  const config = { syndicate_name: 'Calc', orchestrator: { name: 'Calc', model: 'm', instruction: 'x', tools: ['run_code'] }, subagents: [] };
  assert.throws(() => refuseWithoutSandbox(config, {}), (err: unknown) => err instanceof CodeSandboxOffError && /MELCHIZEDEK_CODE_SANDBOX=on/.test(err.message) && /Calc's run_code tool/.test(err.message));
  assert.doesNotThrow(() => refuseWithoutSandbox(config, { MELCHIZEDEK_CODE_SANDBOX: 'on' }));
  await withSandbox(false, async () => {
    const out = (await runCodeTool.execute({ code: 'export default () => 1' })) as { error: string };
    assert.match(out.error, /MELCHIZEDEK_CODE_SANDBOX=on/);
  });
});

// ── run_code ─────────────────────────────────────────────────────────────────

test('run_code: a registry tool returning { result, logs, error }', async () => {
  assert.equal(resolveTools(['run_code']).length, 1);
  await withSandbox(true, async () => {
    assert.deepEqual(await runCodeTool.execute({ code: 'export default ({ a, b }) => { console.log(a); return a * b }', input: { a: 6, b: 7 } }), { result: 42, logs: '6', error: null });
    const failed = (await runCodeTool.execute({ code: 'export default () => { throw new Error("nope") }' })) as { error: string };
    assert.equal(failed.error, 'CODE_ERROR: Error: nope');
    const invalid = await runCodeTool.execute({ code: '' });
    assert.match(String(invalid), /invalid arguments for run_code/);
  });
});

test('schema: run_code: needs run_code in tools, and belongs to an inline agent', () => {
  const base = { syndicate_name: 'S', orchestrator: { name: 'A', model: 'gemini-3.5-flash', instruction: 'x' } };
  assert.doesNotThrow(() => validateSyndicateConfig({ ...base, orchestrator: { ...base.orchestrator, tools: ['run_code'], run_code: { attach: true } } }));
  assert.throws(() => validateSyndicateConfig({ ...base, orchestrator: { ...base.orchestrator, run_code: { attach: true } } }), /add run_code to tools/);
  assert.throws(() => validateSyndicateConfig({ ...base, orchestrator: { ...base.orchestrator, tools: ['run_code'], run_code: { attatch: true } } }), /attatch/);
});

function calcConfig(attach: boolean): SyndicateYamlConfig {
  return {
    syndicate_name: 'Calc',
    orchestrator: { name: 'Calc', model: 'scripted/calc', instruction: 'Compute.', tools: ['run_code'], ...(attach ? { run_code: { attach: true } } : {}) },
    subagents: [],
  } as SyndicateYamlConfig;
}

test('turn: an agent rests its answer on run_code; attach puts the code and result on the reply', async () => {
  await withSandbox(true, async () => {
    const code = 'export default ({ xs }) => xs.reduce((a, b) => a + b, 0) / xs.length';
    const calc = new ScriptedModel('calc', (req, n) => {
      if (n === 1) return toolCall('run_code', { code, input: { xs: [2, 4, 9] } });
      const result = lastToolResult(req) as { response?: { result?: unknown } } | undefined;
      return answer(`The mean is ${JSON.stringify(result?.response?.result ?? (result as any)?.result)}.`);
    });
    for (const attach of [true, false]) {
      calc.calls = 0;
      const r = await runSyndicateTurn({
        config: calcConfig(attach),
        parts: [{ text: 'mean of 2, 4, 9?' }],
        appName: 'calc',
        userId: 'u',
        sessionId: `s-${attach}`,
        sessionService: new InProcessSessionService(),
        compile: { resolveModel: shimResolver({ calc }) },
        trace: false,
      });
      assert.equal(r.status, 'completed', JSON.stringify(r.error));
      assert.match(r.text, /5/);
      if (attach) assert.deepEqual(r.codeRuns, [{ type: 'code_run', agent: 'Calc', code, result: 5 }]);
      else assert.equal(r.codeRuns, undefined);
    }
  });
});

test('turn: a syndicate listing run_code is refused before any model call while the sandbox is off', async () => {
  await withSandbox(false, async () => {
    const calc = new ScriptedModel('calc', () => answer('never'));
    await assert.rejects(
      runSyndicateTurn({
        config: calcConfig(false),
        parts: [{ text: 'hi' }],
        appName: 'calc',
        userId: 'u',
        sessionId: 's-off',
        sessionService: new InProcessSessionService(),
        compile: { resolveModel: shimResolver({ calc }) },
        trace: false,
      }),
      CodeSandboxOffError,
    );
    assert.equal(calc.calls, 0);
  });
});
