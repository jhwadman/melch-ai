/**
 * tests/workflowSkillScripts.test.ts — skill scripts on a workflow node (ADR
 * 0106). A `run_skill_script` call by a node agent whose skills set
 * `scripts: local` pauses the node and the walk on the same approval a gated
 * tool raises (ADR 0098): the turn ends `input-required` with
 * `result.approval`, and the person's decision resumes the node's own run,
 * which runs the script once or refuses it, and walks on. The script runs
 * with ADR 0086's minimal environment, unchanged. Scripted models, in-memory
 * sessions, a real script on disk.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { SyndicateValidationError, validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { ScriptedModel, answer, lastToolResult, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';

const FAKE = 'fake-value-not-a-credential';
/** The script: one mark in the tally file per run, and what it can see of the environment. */
const TALLY_SCRIPT = `const fs = process.getBuiltinModule('node:fs'); fs.appendFileSync(process.env.FUC_TALLY, 'x'); console.log(JSON.stringify({ ran: true, key: process.env.OPENAI_API_KEY ?? 'unset' }));`;

/** A skills shelf with one skill whose script marks a tally file. */
function shelf(): { dir: string; tally: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fu-c-skills-'));
  mkdirSync(join(dir, 'tally', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'tally', 'SKILL.md'), '---\nname: tally\ndescription: Marks a tally.\n---\nRun scripts/mark.js.\n');
  writeFileSync(join(dir, 'tally', 'scripts', 'mark.js'), TALLY_SCRIPT);
  return { dir, tally: join(dir, 'tally.txt') };
}

const marks = (tally: string): number => (existsSync(tally) ? readFileSync(tally, 'utf8').length : 0);

const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });

/** Plan → Run (skill scripts) → Report. */
function chain(dir: string, run: Record<string, unknown> = {}): SyndicateYamlConfig {
  return validateSyndicateConfig(
    {
      syndicate_name: 'Graph',
      memory_system: 'internal-only',
      orchestrator: agent('Plan'),
      subagents: [agent('Run', { skills: { dir, scripts: 'local', env: ['FUC_TALLY'] }, ...run }), agent('Report')],
      workflow: { edges: [['START', 'Plan', 'Run', 'Report']] },
    },
    'test',
  ) as SyndicateYamlConfig;
}

const lastText = (request: ModelRequest) => requestTexts(request).at(-1) ?? '';

function conversation(cfg: SyndicateYamlConfig) {
  const models = {
    plan: new ScriptedModel('scripted/plan', (request) => answer(`plan(${lastText(request)})`)),
    run: new ScriptedModel('scripted/run', (request, n) =>
      n === 1 ? toolCall('run_skill_script', { skill_name: 'tally', script_path: 'scripts/mark.js' }, 'call-mark-1') : answer(`run saw ${JSON.stringify(lastToolResult(request)?.result ?? null)}`),
    ),
    report: new ScriptedModel('scripted/report', (request) => answer(`report(${lastText(request)})`)),
  };
  const sessionService = new InProcessSessionService();
  const turn = (parts: any[]) =>
    runSyndicateTurn({ config: cfg, parts, appName: 'app', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: shimResolver(models), log: () => {} }, trace: false });
  return { turn, models, sessionService };
}

/** Runs `body` with the tally variable set and a provider key the script must never see, and puts both back. */
async function withEnv(tally: string, body: () => Promise<void>): Promise<void> {
  const saved = { key: process.env.OPENAI_API_KEY, tally: process.env.FUC_TALLY };
  process.env.OPENAI_API_KEY = FAKE;
  process.env.FUC_TALLY = tally;
  try {
    await body();
  } finally {
    for (const [name, value] of [['OPENAI_API_KEY', saved.key], ['FUC_TALLY', saved.tally]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('native: a skill script on a workflow node pauses for approval, runs once after it, and the walk goes on', async () => {
  const { dir, tally } = shelf();
  try {
    await withEnv(tally, async () => {
      const { turn, models } = conversation(chain(dir));
      const first = await turn([{ text: 'count' }]);
      assert.equal(first.status, 'input-required', first.error?.message);
      assert.equal(first.approval?.agent, 'Run');
      assert.equal(first.approval?.tool, 'run_skill_script');
      assert.equal(marks(tally), 0, 'nothing ran before the approval');
      assert.equal(models.report.calls, 0, 'the walk waits on the node');

      const second = await turn([approvalResponsePart(first.approval!.id, true)]);
      assert.equal(second.status, 'completed', second.error?.message);
      assert.equal(marks(tally), 1, 'the script ran once');
      assert.equal(models.plan.calls, 1, 'a finished node is not run again');
      assert.equal(models.run.calls, 2);
      const seen = JSON.stringify(lastToolResult(models.run.requests[1]!)?.result ?? null);
      assert.ok(seen.includes('\\"ran\\":true'), seen);
      assert.ok(seen.includes('\\"key\\":\\"unset\\"'), 'the minimal environment holds on a node (ADR 0086)');
      assert.ok(!seen.includes(FAKE));
      assert.match(second.text, /^report\(run saw /);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native: a refused skill script never runs; the node is told and the walk goes on', async () => {
  const { dir, tally } = shelf();
  try {
    await withEnv(tally, async () => {
      const { turn, models } = conversation(chain(dir));
      const first = await turn([{ text: 'count' }]);
      assert.equal(first.status, 'input-required', first.error?.message);
      const second = await turn([approvalResponsePart(first.approval!.id, false)]);
      assert.equal(second.status, 'completed', second.error?.message);
      assert.equal(marks(tally), 0, 'the script never ran');
      assert.match(second.text, /^report\(run saw .*rejected/);
      assert.equal(models.report.calls, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native: a plain-text message while the script waits repeats the request and runs nothing', async () => {
  const { dir, tally } = shelf();
  try {
    await withEnv(tally, async () => {
      const { turn, models } = conversation(chain(dir));
      const first = await turn([{ text: 'count' }]);
      const second = await turn([{ text: 'what is it doing?' }]);
      assert.equal(second.status, 'input-required');
      assert.equal(second.approval?.id, first.approval?.id);
      assert.equal(marks(tally), 0);
      assert.equal(models.run.calls, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema: skill scripts are allowed on a workflow node, not on an agent a map runs', () => {
  assert.doesNotThrow(() => chain('skills'));
  assert.throws(
    () =>
      validateSyndicateConfig({
        syndicate_name: 'G',
        orchestrator: agent('Plan'),
        subagents: [agent('Run', { skills: { dir: 'skills', scripts: 'local' } })],
        workflow: { edges: [['START', 'Plan', 'Each']], nodes: { Each: { map: 'Run' } } },
      }),
    (e: unknown) => e instanceof SyndicateValidationError && /subagents\[0\]\.skills\.scripts — skill scripts \(an approval pause\) are not supported on an agent a map node runs/.test((e as Error).message),
  );
});
