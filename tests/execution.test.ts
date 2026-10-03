/**
 * tests/execution.test.ts — the agent keys of ADR 0033: `context:` compacts a
 * long delegate conversation into a summary (and the summary survives the
 * storage trim), `mode: task` makes a workflow node's output its finish_task
 * arguments, `code_execution: gemini` compiles to Gemini's server-side
 * executor, and the schema puts each where it means something. Scripted
 * models, in-memory sessions, no network.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltInCodeExecutor, InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';

import { compileGraph } from '../lib/compile.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { trimEventForStorage } from '../lib/session/transcript.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const contents = (req: any): string[] => (req.contents ?? []).map((c: any) => (c.parts ?? []).map((p: any) => p.text ?? '').join(''));

test('context: past the threshold, earlier turns become one summary and the recent ones stay verbatim', async () => {
  const config = validateSyndicateConfig(
    {
      syndicate_name: 'Chat',
      orchestrator: { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', context: { compact_after_tokens: 1000, keep_recent_events: 2, summary_model: 'scripted/sum' } },
      subagents: [],
    },
    't',
  ) as SyndicateYamlConfig;
  let n = 0;
  const chat = new ScriptedLlm('scripted/chat', () => ({ content: { role: 'model', parts: [{ text: `answer ${++n}` }] }, usageMetadata: { promptTokenCount: n * 400 }, turnComplete: true }) as any);
  const sum = new ScriptedLlm('scripted/sum', () => text('SUMMARY: the person asked three questions about trains.'));
  const sessionService = new InMemorySessionService();
  const turn = (t: string) => runSyndicateTurn({ config, parts: [{ text: t }], appName: 'a', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: scriptedResolver({ chat, sum }) }, trace: false });

  for (let i = 1; i <= 3; i++) await turn(`question ${i}`);
  assert.equal(sum.calls, 0, 'under the threshold nothing is summarized');
  assert.equal(contents(chat.requests[2]).length, 5, 'the third request carries the whole history');

  const fourth = await turn('question 4');
  assert.equal(fourth.status, 'completed');
  assert.equal(sum.calls, 1, 'the summarizer ran once');
  const seen = contents(chat.requests[3]);
  assert.match(seen[0]!, /SUMMARY: the person asked three questions/);
  assert.equal(seen.at(-1), 'question 4');
  assert.ok(seen.length < 5, `the request shrank: ${seen.length} contents`);

  const session = await sessionService.getSession({ appName: 'a', userId: 'u', sessionId: 's' });
  const compacted = session!.events.find((e: any) => e.isCompacted === true)!;
  assert.ok(compacted, 'the summary is an event in the session; the full history stays stored');
  assert.equal((trimEventForStorage(compacted) as any).isCompacted, true, 'the storage trim keeps the marker');
});

test('mode: task — a workflow node works with its tools, then its finish_task arguments are its output', async () => {
  const config = validateSyndicateConfig(
    {
      syndicate_name: 'Desk',
      orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Pass it on.' },
      subagents: [
        {
          name: 'Extractor',
          description: 'extracts',
          model: 'scripted/extractor',
          instruction: 'Extract.',
          mode: 'task',
          outputSchema: { type: 'OBJECT', properties: { city: { type: 'STRING' }, nights: { type: 'INTEGER' } }, required: ['city', 'nights'] },
        },
        { name: 'Booker', description: 'books', model: 'scripted/booker', instruction: 'Book.' },
      ],
      workflow: { edges: [['START', 'Lead', 'Extractor', 'Booker']] },
    },
    't',
  ) as SyndicateYamlConfig;
  const lead = new ScriptedLlm('scripted/lead', () => text('two nights in Lyon please'));
  const extractor = new ScriptedLlm('scripted/extractor', (_req, n) => (n === 1 ? call('finish_task', { city: 'Lyon', nights: 2 }) : text('done')));
  const booker = new ScriptedLlm('scripted/booker', (req) => text(`booked ${contents(req).at(-1)}`));
  const r = await runSyndicateTurn({ config, parts: [{ text: 'go' }], appName: 'a', userId: 'u', sessionId: 's', sessionService: new InMemorySessionService(), compile: { resolveModel: scriptedResolver({ lead, extractor, booker }) }, trace: false });
  assert.equal(r.status, 'completed', r.error?.message);
  assert.deepEqual(JSON.parse(r.text.replace(/^booked /, '')), { city: 'Lyon', nights: 2 });
});

test('code_execution: gemini compiles to Gemini\'s server-side executor', async () => {
  const config = validateSyndicateConfig(
    { syndicate_name: 'Calc', orchestrator: { name: 'Calc', model: 'gemini-3.5-flash-lite', instruction: 'Compute.', code_execution: 'gemini' }, subagents: [] },
    't',
  ) as SyndicateYamlConfig;
  const root = (await compileGraph(config)) as any;
  assert.ok(root.codeExecutor instanceof BuiltInCodeExecutor);
});

test('schema: each key where it means something', () => {
  const base = (orchestrator: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    syndicate_name: 'S',
    orchestrator: { name: 'Lead', model: 'gemini-3.5-flash-lite', instruction: 'x', ...orchestrator },
    subagents: [{ name: 'Sub', description: 'd', model: 'gemini-3.5-flash-lite', instruction: 'y' }],
    ...extra,
  });
  assert.throws(() => validateSyndicateConfig(base({ model: 'claude-sonnet-4-6', code_execution: 'gemini' }), 't'), /needs a gemini-\* model/);
  assert.doesNotThrow(() => validateSyndicateConfig(base({ context: { compact_after_tokens: 50000 } }), 't'));
  assert.throws(() => validateSyndicateConfig(base({ context: { compact_after_tokens: 50000 } }, { dispatch: { default_route: 'Sub' } }), 't'), /delegate syndicate/);
  assert.throws(() => validateSyndicateConfig(base({ context: { compact_after_tokens: 50 } }), 't'), /compact_after_tokens/);
  assert.throws(() => validateSyndicateConfig(base({ mode: 'task' }), 't'), /mode: task applies to workflow nodes/);
  assert.doesNotThrow(() => validateSyndicateConfig(base({ mode: 'task' }, { workflow: { edges: [['START', 'Lead', 'Sub']] } }), 't'));
});
