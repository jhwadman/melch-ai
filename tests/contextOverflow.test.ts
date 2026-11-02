/**
 * tests/contextOverflow.test.ts — compaction on by default, and the loop's
 * answer to a prompt that overflows the window anyway (ADR 0154).
 *
 * With no `context:` an agent compacts past 60% of its model's window; on a
 * provider's overflow refusal the loop forces one compaction (the tail
 * halved) and retries the step once, the refused call handed back unstored;
 * a second overflow ends the run on its error; `context: off` compacts and
 * masks nothing. Offline: scripted adapters only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { SUMMARY_INSTRUCTION } from '../lib/runtime/native/compaction.ts';
import { ScriptedModel, answer, failure } from './helpers/scriptedModel.ts';

const OVERFLOW = 'prompt is too long: 213463 tokens > 200000 maximum';
const SUMMARY = '## Intent\nchat\n## Stated facts\n(none)\n## Decisions\n(none)\n## Artifacts\n(none)\n## Open\n(none)\n## Last state\nchatting';

/** The model id decides the default threshold: a Claude id reads a 200k window, so 120k. The resolver hands every id the scripted adapter. */
function config(context?: unknown, model = 'claude-sonnet-5-5'): SyndicateYamlConfig {
  return {
    syndicate_name: 'Desk',
    orchestrator: { name: 'Desk', model, instruction: 'Chat.', ...(context !== undefined ? { context } : {}) },
    subagents: [],
    retries: { model_errors: 0, tool_errors: 0 },
  } as unknown as SyndicateYamlConfig;
}

async function chat(cfg: SyndicateYamlConfig, desk: ScriptedModel, turns: string[]) {
  const sessionService = new InProcessSessionService();
  const results = [];
  for (const text of turns) {
    results.push(
      await runSyndicateTurn({
        config: cfg,
        parts: [{ text }],
        appName: 'desk.a1',
        userId: 'u1',
        sessionId: 's1',
        sessionService,
        compile: { resolveModel: () => desk, log: () => {} },
        trace: false,
      }),
    );
  }
  const session = await sessionService.get({ appName: 'desk.a1', userId: 'u1', sessionId: 's1' });
  return { results, events: session?.events ?? [] };
}

const isSummary = (r: ModelRequest) => r.system === SUMMARY_INSTRUCTION;
const firstText = (r: ModelRequest): string => String((r.messages[0]?.parts[0] as { text?: string } | undefined)?.text ?? '');

test('an overflow forces one compaction with half the tail and the step runs again; the refused call is not stored', async () => {
  let overflowed = false;
  const desk = new ScriptedModel('scripted/desk', (request) => {
    if (isSummary(request)) return answer(SUMMARY);
    if (request.messages.length >= 7 && !overflowed) {
      overflowed = true;
      return failure({ code: 'PROVIDER_ERROR', message: OVERFLOW, status: 400 });
    }
    return answer(overflowed ? 'after' : 'ok');
  });
  const { results, events } = await chat(config(), desk, ['one', 'two', 'three', 'four']);
  assert.deepEqual(results.map((r) => r.status), ['completed', 'completed', 'completed', 'completed']);
  assert.equal(results[3]!.text, 'after');
  const summaries = desk.requests.filter(isSummary);
  assert.equal(summaries.length, 1, 'one forced summary');
  // The default tail is 6; forced, it is 3: of the seven raw events, the first four are summarized.
  assert.match(firstText(summaries[0]!), /\[Event 4 - Author: Desk\]\nok\n\n$/);
  const compacted = events.filter((e) => (e as { isCompacted?: boolean }).isCompacted);
  assert.equal(compacted.length, 1);
  assert.ok(!events.some((e) => e.errorCode), 'the refused call leaves no error event: the turn succeeded');
  const retry = desk.requests.at(-1)!;
  assert.match(firstText(retry), /^\[Previous Context Summary\]:\n## Intent/);
  assert.ok(retry.messages.length < 7, 'the retry reads the summary in place of the earlier turns');
});

test('a second overflow ends the run on its error, after one compaction', async () => {
  // Once the prompt is too long it stays too long: the compacted retry is refused too.
  let refusing = false;
  const desk = new ScriptedModel('scripted/desk', (request) => {
    if (isSummary(request)) return answer(SUMMARY);
    if (request.messages.length >= 5) refusing = true;
    if (refusing) return failure({ code: 'PROVIDER_ERROR', message: OVERFLOW, status: 400 });
    return answer('ok');
  });
  const { results, events } = await chat(config(), desk, ['one', 'two', 'three']);
  assert.notEqual(results[2]!.status, 'completed');
  assert.match(String(results[2]!.error?.message ?? results[2]!.text), /prompt is too long/);
  assert.equal(desk.requests.filter(isSummary).length, 1, 'compacted once, not in a loop');
  assert.equal(events.filter((e) => (e as { isCompacted?: boolean }).isCompacted).length, 1);
});

test('with no context key an agent compacts past 60% of the window its usage reports', async () => {
  // A Claude id: a 200k window, so the threshold is 120k; each answer reports 130k in.
  const desk = new ScriptedModel('scripted/desk', (request, n) => (isSummary(request) ? answer(SUMMARY) : answer(`a${n}`, { inputTokens: 130_000, outputTokens: 5 })));
  const { results, events } = await chat(config(), desk, ['one', 'two', 'three', 'four']);
  assert.ok(results.every((r) => r.status === 'completed'));
  assert.equal(desk.requests.filter(isSummary).length, 1, 'the fourth turn, with seven raw events, compacts');
  assert.equal(events.filter((e) => (e as { isCompacted?: boolean }).isCompacted).length, 1);
});

test('context: off compacts nothing, and compact_after_tokens: 0 compacts nothing', async () => {
  for (const context of ['off', { compact_after_tokens: 0 }]) {
    const desk = new ScriptedModel('scripted/desk', (request, n) => (isSummary(request) ? answer(SUMMARY) : answer(`a${n}`, { inputTokens: 130_000, outputTokens: 5 })));
    const { results, events } = await chat(config(context), desk, ['one', 'two', 'three', 'four']);
    assert.ok(results.every((r) => r.status === 'completed'));
    assert.equal(desk.requests.filter(isSummary).length, 0, JSON.stringify(context));
    assert.equal(events.filter((e) => (e as { isCompacted?: boolean }).isCompacted).length, 0);
  }
});
