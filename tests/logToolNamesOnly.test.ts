/**
 * tests/logToolNamesOnly.test.ts — the server-side log names a tool, the agent
 * that called it, its argument key names and their size; never an argument
 * value, a tool result, a question's text or the router's reason. Arguments
 * are model-chosen and routinely carry the person's words. The `log` and
 * `warn` sinks of runSyndicateTurn are what the A2A server, melchizedek-mcp
 * and the worker print, so they are captured and searched for marker values.
 * Scripted models, in-memory sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { resolveRoute } from '../lib/dispatch.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

const ARG_MARK = 'my-diagnosis-is-PRIVATE-ARG';
const RESULT_MARK = 'account-balance-PRIVATE-RESULT';
const QUESTION_MARK = 'PRIVATE-QUESTION-about-the-divorce';
const REASON_MARK = 'PRIVATE-REASON-the-user-said-x';
const MESSAGE_MARK = 'PRIVATE-USER-MESSAGE';

registerTool(
  'fu3c_lookup',
  defineTool({
    name: 'fu3c_lookup',
    description: 'Look a note up.',
    schema: z.object({ note: z.string(), depth: z.number() }),
    execute: async () => `found ${RESULT_MARK}`,
  }),
  { override: true },
);

const config = (raw: Record<string, unknown>): SyndicateYamlConfig => validateSyndicateConfig(raw, 'fu3c') as SyndicateYamlConfig;

async function turn(cfg: SyndicateYamlConfig, scripts: Record<string, ModelScript>, text: string) {
  resetCircuits();
  const models = Object.fromEntries(Object.entries(scripts).map(([key, script]) => [key, new ScriptedModel(`scripted/${key}`, script)]));
  const lines: string[] = [];
  const progress: string[] = [];
  const result = await runSyndicateTurn({
    config: cfg,
    parts: [{ text }],
    appName: 'app',
    userId: 'u',
    sessionId: 's',
    sessionService: new InProcessSessionService(),
    compile: { resolveModel: shimResolver(models), log: (m: string) => lines.push(m) },
    events: { log: (m) => lines.push(m), warn: (m) => lines.push(m), onProgress: (m) => progress.push(m) },
    publishToolStatus: true,
    trace: false,
  } as Parameters<typeof runSyndicateTurn>[0]);
  return { result, lines, progress };
}

function assertNoValues(lines: string[], ...marks: string[]) {
  const all = lines.join('\n');
  for (const s of marks) assert.ok(!all.includes(s), `a log line carries "${s}":\n${all}`);
}

test('a tool call is logged by name, agent, key names and size; never its argument values or its result', async () => {
  const boss: ModelScript = (req) =>
    lastToolResult(req) ? answer('done') : toolCall('fu3c_lookup', { note: ARG_MARK, depth: 3 }, 'call-1');
  const { result, lines } = await turn(
    config({ syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Help.', tools: ['fu3c_lookup'] }, subagents: [] }),
    { boss },
    MESSAGE_MARK,
  );
  assert.equal(result.status, 'completed', result.error?.message);
  const call = lines.find((l) => l.startsWith('→ Tool: fu3c_lookup'));
  assert.ok(call, `no tool line in:\n${lines.join('\n')}`);
  assert.match(call, /^→ Tool: fu3c_lookup by Boss — args: note, depth \(\d[\d,]* bytes\)$/);
  assert.ok(lines.some((l) => /^← Result: fu3c_lookup — \d[\d,]* chars$/.test(l)), 'the result line names the tool and the size');
  assertNoValues(lines, ARG_MARK, RESULT_MARK, MESSAGE_MARK);
});

test('a question the agent asks is logged as who asks, never what', async () => {
  const boss: ModelScript = () => toolCall('ask_user', { question: QUESTION_MARK, options: [`${QUESTION_MARK}-a`, 'b'] }, 'call-ask');
  const { result, lines } = await turn(
    config({ syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Help.', tools: ['ask_user'] }, subagents: [] }),
    { boss },
    MESSAGE_MARK,
  );
  assert.equal(result.status, 'input-required');
  assert.equal(result.input?.message, QUESTION_MARK, 'the result still carries the question for the person');
  assert.ok(lines.some((l) => l.includes('Boss asks a question')), lines.join('\n'));
  assertNoValues(lines, QUESTION_MARK, MESSAGE_MARK);
});

test('a dispatch route is logged without the classifier reason; the progress line keeps it for the caller', async () => {
  const router: ModelScript = () => answer(JSON.stringify({ route: 'Ops', reason: REASON_MARK }));
  const ops: ModelScript = (req) =>
    lastToolResult(req) ? answer('ok') : toolCall('fu3c_lookup', { note: ARG_MARK, depth: 1 }, 'call-ops');
  const { result, lines, progress } = await turn(
    config({
      syndicate_name: 'Front',
      orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
      subagents: [
        { name: 'Chat', description: 'Chat', model: 'scripted/chat', instruction: 'Chat.' },
        { name: 'Ops', description: 'Ops', model: 'scripted/ops', instruction: 'Ops.', tools: ['fu3c_lookup'] },
      ],
      dispatch: { default_route: 'Chat' },
    }),
    { router, ops, chat: () => answer('chat') },
    MESSAGE_MARK,
  );
  assert.equal(result.status, 'completed', result.error?.message);
  assert.ok(lines.includes('⇄ Route: Ops'), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('→ Tool: fu3c_lookup by Ops — args: note, depth')), lines.join('\n'));
  assert.ok(progress.some((p) => p.includes(REASON_MARK)), 'the caller still sees why it was routed');
  assertNoValues(lines, REASON_MARK, ARG_MARK, RESULT_MARK, MESSAGE_MARK);
});

test('a router fallback reason measures model text instead of quoting it', () => {
  const cfg = config({
    syndicate_name: 'Front',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [{ name: 'Chat', description: 'Chat', model: 'scripted/chat', instruction: 'Chat.' }],
    dispatch: { default_route: 'Chat' },
  }) as Parameters<typeof resolveRoute>[1];

  const notJson = resolveRoute(`Sure! ${MESSAGE_MARK}`, cfg);
  assert.equal(notJson.fellBack, true);
  assert.match(notJson.fallbackReason, /^router output was not JSON \(\d+ chars\)$/);

  const prose = resolveRoute(JSON.stringify({ route: `the user wants ${MESSAGE_MARK}` }), cfg);
  assert.match(prose.fallbackReason, /^router chose an unknown route \(\d+ chars\)$/);

  // A route-shaped value is a name, not a person's words: it stays legible.
  const named = resolveRoute(JSON.stringify({ route: 'Billing' }), cfg);
  assert.equal(named.fallbackReason, "router chose unknown route 'Billing'");
});
