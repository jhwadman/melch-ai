/**
 * The parity harness (scripts/parity_check.ts) tested on itself, offline:
 * --scripted swaps every provider's models for scripted ones, so the full
 * path — the fixture, runSyndicateTurn, the checks, the table, the report
 * file, the exit code — runs with no key and no network.
 *
 * Each check is proven to be able to fail: a fault makes the scripted models
 * break one behaviour, and exactly that check must fail. A check that cannot
 * fail would pass every later gate for nothing.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHECKS, exitCodeFor, parseArgs, renderReport, requestedRuntime, runParity, UsageError } from '../scripts/parity_check.ts';
import type { ParityReport } from '../scripts/parity_check.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { REDACTION_PATTERNS } from '../lib/observability/redact.ts';

/** Key-shaped strings (the ledger's own patterns), and header or body markers. */
const SECRET_SHAPES = new RegExp(`${REDACTION_PATTERNS.secret.source}|x-api-key|authorization|"messages"|"contents"`, 'i');

function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--disable-warning=DEP0040', '--experimental-strip-types', 'scripts/parity_check.ts', ...args],
    { encoding: 'utf-8', env: { ...process.env, OTEL_CONSOLE_SPANS: 'false', ...env }, timeout: 60_000 },
  );
}

test('the fixture loads with a model id per binding', () => {
  const config = loadSyndicate('parity.yaml', { agentsDir: 'tests/fixtures', bindings: { orchestrator_model: 'gemini-x', subagent_model: 'claude-x' } });
  assert.equal(config.orchestrator.model, 'gemini-x');
  assert.deepEqual(config.subagents.map((s) => [s.name, s.model]), [['Echo', 'claude-x'], ['Recorder', 'claude-x']]);
  assert.deepEqual(config.orchestrator.tools, ['parity_lookup']);
  assert.ok(config.subagents.find((s) => s.name === 'Recorder')?.outputSchema);
});

test('scripted: every check passes on every provider', async () => {
  const report = await runParity({ scripted: true });
  assert.equal(report.mode, 'scripted');
  assert.deepEqual(report.providers.map((p) => p.provider), ['gemini', 'anthropic', 'openai', 'xai', 'moonshot', 'ollama']);
  for (const p of report.providers) {
    for (const c of p.checks) assert.ok(c.pass, `${p.provider} · ${c.id}: ${c.detail}`);
    assert.deepEqual(p.turns.map((t) => t.name), ['delegate', 'tool', 'structured', 'followup']);
    assert.ok(p.turns.every((t) => t.status === 'completed' && t.inputTokens > 0 && t.outputTokens > 0));
  }
  assert.equal(report.pass, true);
  assert.equal(exitCodeFor(report), 0);
  assert.deepEqual(report.runtime, { requested: 'native', ran: 'native' });
});

for (const fault of CHECKS) {
  test(`scripted: a broken ${fault} fails that check and only that one`, async () => {
    const report = await runParity({ scripted: true, providers: ['anthropic'], faults: [fault] });
    const [p] = report.providers;
    assert.ok(p);
    const failed = p.checks.filter((c) => !c.pass).map((c) => c.id);
    assert.deepEqual(failed, [fault], p.checks.map((c) => `${c.id}: ${c.detail}`).join('\n'));
    assert.equal(report.pass, false);
    assert.equal(exitCodeFor(report), 1);
  });
}

test('the table: one row per provider, one column per check, failures named', async () => {
  const report = await runParity({ scripted: true, providers: ['gemini', 'openai'], faults: ['structured'] });
  const out = renderReport(report, 'outputs/x.json');
  const lines = out.split('\n');
  const header = lines.find((l) => l.startsWith('provider'));
  assert.ok(header);
  for (const label of ['delegation', 'client tool', 'structured output', 'streaming', 'second turn', 'token usage', 'time']) assert.ok(header.includes(label), label);
  assert.ok(lines.some((l) => l.startsWith('gemini ') && l.includes('gemini-')));
  assert.ok(lines.some((l) => l.startsWith('openai ') && l.includes('gpt-')));
  assert.match(out, /✗ gemini · structured output — Recorder's output does not match its schema \(count: /);
  assert.match(out, /FAIL {2}2 of 12 checks failed/);
  assert.match(out, /report {2}outputs\/x\.json/);
});

test('no provider ran: the run fails', () => {
  const empty: ParityReport = {
    harness: 'parity', version: 1, mode: 'live', runtime: { requested: 'native', ran: 'native' },
    startedAt: '', finishedAt: '', durationMs: 0, providers: [], skipped: [{ provider: 'xai', reason: 'XAI_API_KEY not set' }], pass: false,
  };
  assert.equal(exitCodeFor(empty), 1);
  assert.match(renderReport(empty), /FAIL {2}no provider ran/);
  assert.match(renderReport(empty), /xai — XAI_API_KEY not set/);
});

test('MELCHIZEDEK_RUNTIME: native by default and when named, adk or anything else a usage error', async () => {
  assert.equal(requestedRuntime({}), 'native');
  assert.equal(requestedRuntime({ MELCHIZEDEK_RUNTIME: 'NATIVE' }), 'native');
  assert.throws(() => requestedRuntime({ MELCHIZEDEK_RUNTIME: 'adk' }), UsageError);
  assert.throws(() => requestedRuntime({ MELCHIZEDEK_RUNTIME: 'langgraph' }), UsageError);
  const report = await runParity({ scripted: true, runtime: 'native' });
  assert.deepEqual(report.runtime, { requested: 'native', ran: 'native' });
  assert.match(renderReport(report), /^parity · scripted · runtime native · /);
  for (const p of report.providers) for (const c of p.checks) assert.ok(c.pass, `native · ${p.provider} · ${c.id}: ${c.detail}`);
  assert.equal(report.pass, true);
});

test('arguments: bad ids, a misrouted --model and a live --fault are usage errors', () => {
  assert.throws(() => parseArgs(['--providers', 'nope']), UsageError);
  assert.throws(() => parseArgs(['--model', 'anthropic=gpt-5-mini']), /routes to openai/);
  assert.throws(() => parseArgs(['--fault', 'tool']), /--scripted/);
  assert.throws(() => parseArgs(['--scripted', '--fault', 'vibes']), UsageError);
  assert.throws(() => parseArgs(['--timeout', '0']), UsageError);
  const ok = parseArgs(['--', '--scripted', '--fault', 'tool,usage', '--model', 'anthropic=claude-haiku-4-5', '--timeout', '5']);
  assert.deepEqual(ok.faults, ['tool', 'usage']);
  assert.equal(ok.models?.anthropic, 'claude-haiku-4-5');
  assert.equal(ok.turnTimeoutMs, 5000);
});

test('CLI --scripted: exit 0, the table on stdout, a dated JSON report, nothing secret-shaped', () => {
  const out = mkdtempSync(join(tmpdir(), 'melch-parity-'));
  const r = cli(['--scripted', '--out', out]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /^provider +model +delegation/m);
  assert.match(r.stdout, /PASS {2}36 checks on 6 providers/);
  assert.doesNotMatch(r.stdout, SECRET_SHAPES);
  const files = readdirSync(out);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^parity-scripted-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/);
  const raw = readFileSync(join(out, files[0]!), 'utf-8');
  assert.doesNotMatch(raw, SECRET_SHAPES);
  const report = JSON.parse(raw) as ParityReport;
  assert.equal(report.pass, true);
  assert.equal(report.providers.length, 6);
});

test('CLI --scripted with a deliberately failing check: exit non-zero', () => {
  const out = mkdtempSync(join(tmpdir(), 'melch-parity-'));
  const r = cli(['--scripted', '--providers', 'ollama', '--fault', 'streaming', '--out', out]);
  assert.equal(r.status, 1, r.stderr || r.stdout);
  assert.match(r.stdout, /✗ ollama · streaming — the streamed turn yielded no text deltas/);
  assert.match(r.stdout, /FAIL {2}1 of 6 checks failed/);
});

test('CLI: a usage error exits 2', () => {
  assert.equal(cli(['--bogus']).status, 2);
  assert.equal(cli(['--scripted'], { MELCHIZEDEK_RUNTIME: 'other' }).status, 2);
  assert.equal(cli(['--scripted'], { MELCHIZEDEK_RUNTIME: 'adk' }).status, 2);
});
