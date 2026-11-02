/**
 * tests/compactionProbes.test.ts — what a compaction keeps (ADR 0153).
 *
 * Facts planted in early turns (a value with its unit, a corrected value,
 * a path, a URL, an open question, a tool result's handle) must reach the
 * summarizer and, on a real model, survive two compactions by exact match.
 *
 * Offline: the summarizer's input carries every probe, the previous
 * summary rides under its heading, and the instruction names the six
 * sections. Live, when COMPACTION_PROBE_MODEL names a model the
 * environment funds: two anchored summaries over the planted session, each
 * probe found in the second, the corrected value marked superseded, and
 * the summary under budget. Skipped otherwise.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAdapter } from '../lib/models/registry.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import {
  NEW_EVENTS_HEADING,
  PREVIOUS_SUMMARY_HEADING,
  SUMMARY_INSTRUCTION,
  SUMMARY_SECTIONS,
  SUMMARY_WORD_BUDGET,
  summarize,
  summaryInput,
  summaryRequest,
} from '../lib/runtime/native/compaction.ts';
import type { CompactedEvent } from '../lib/runtime/native/history.ts';

/** What must survive: each probe's words, as a person would check for them. */
const PROBES = {
  weight: '82.5 kg',
  corrected: '81.9 kg',
  path: 'reports/q3/margins.xlsx',
  url: 'https://example.org/trials/NCT0481',
  open: 'the refund from the March invoice',
  handle: 'read_file',
};

let t = 0;
const ev = (author: string, role: 'user' | 'model', parts: TurnEvent['content'] extends infer C ? (C extends { parts?: infer P } ? P : never) : never): TurnEvent => ({
  ...createTurnEvent({ author, content: { role, parts } }),
  timestamp: 1_000 + t++,
});

/** The first span: the planted facts. */
const firstSpan: TurnEvent[] = [
  ev('user', 'user', [{ text: `I weigh ${PROBES.weight} this morning. I want to get the Q3 margins file into shape before Friday.` }]),
  ev('Desk', 'model', [{ functionCall: { id: 'c1', name: PROBES.handle, args: { path: PROBES.path } } }]),
  ev('Desk', 'user', [{ functionResponse: { id: 'c1', name: PROBES.handle, response: { result: 'Q3 margins: 12.4% gross, 3.1% net. ' + 'x'.repeat(2_500) } } }]),
  ev('Desk', 'model', [{ text: `The file ${PROBES.path} shows 12.4% gross and 3.1% net margin for Q3.` }]),
  ev('user', 'user', [{ text: `Also, I still have not heard back about ${PROBES.open}. And the trial is at ${PROBES.url}.` }]),
  ev('Desk', 'model', [{ text: 'Noted both. I will keep the trial link and the open refund in mind.' }]),
];

/** The second span: a correction and a decision. */
const secondSpan: TurnEvent[] = [
  ev('user', 'user', [{ text: `Correction: the scale was off, I weigh ${PROBES.corrected}, not ${PROBES.weight}. Let's decide: we cut the net margin target to 3.0%.` }]),
  ev('Desk', 'model', [{ text: 'Recorded: 81.9 kg, and the Q3 net margin target is now 3.0%.' }]),
];

test('the summarizer is handed every planted fact, the tool handle and the cut result', () => {
  const input = summaryInput(firstSpan);
  // The correction is planted in the second span.
  for (const [name, probe] of Object.entries(PROBES)) if (name !== 'corrected') assert.ok(input.includes(probe), `${name}: ${probe}`);
  assert.ok(summaryInput(secondSpan).includes(PROBES.corrected));
  assert.ok(input.includes(`[called ${PROBES.handle} with {"path":"${PROBES.path}"}]`), 'the call as JSON');
  assert.match(input, /\[read_file returned: \{"result":"Q3 margins: 12\.4% gross, 3\.1% net\. x+… \[\d+ characters; cut\]\]/, 'the result, cut');
  assert.ok(input.startsWith(`${NEW_EVENTS_HEADING}\n\n[Event 1 - Author: user]\n`));
  for (const section of SUMMARY_SECTIONS) assert.ok(SUMMARY_INSTRUCTION.includes(`## ${section}\n`), `the instruction names ${section}`);
  assert.ok(SUMMARY_INSTRUCTION.includes(`Stay under ${SUMMARY_WORD_BUDGET} words.`));
  const request = summaryRequest(firstSpan, 'any/model');
  assert.equal(request.system, SUMMARY_INSTRUCTION);
  assert.equal(request.messages.length, 1);
});

test('an anchored second input carries the previous summary under its heading and the new span alone', () => {
  const previous: CompactedEvent = {
    ...createTurnEvent({ author: 'system', content: { role: 'model', parts: [{ text: '## Intent\nfix the margins file' }] } }),
    isCompacted: true,
    compactedContent: '## Intent\nfix the margins file',
    startTime: firstSpan[0]!.timestamp,
    endTime: firstSpan.at(-1)!.timestamp,
  };
  const input = summaryInput([previous, ...secondSpan]);
  assert.ok(input.startsWith(`${PREVIOUS_SUMMARY_HEADING}\n## Intent\nfix the margins file\n\n${NEW_EVENTS_HEADING}\n\n[Event 1 - Author: user]\nCorrection:`));
  assert.ok(!input.includes(PROBES.path), 'the first span is not rendered again');
});

const LIVE = process.env.COMPACTION_PROBE_MODEL;

test('live: every probe survives two compactions, the correction supersedes, the summary stays under budget', { skip: LIVE ? false : 'set COMPACTION_PROBE_MODEL to a funded model id' }, async () => {
  const model = LIVE as string;
  const adapter = resolveAdapter(model);
  const first = await summarize(firstSpan, adapter, model);
  const second = await summarize([first, ...secondSpan], adapter, model);
  const summary = second.compactedContent ?? '';
  for (const section of SUMMARY_SECTIONS) assert.ok(summary.includes(`## ${section}`), `${section} is present`);
  for (const [name, probe] of Object.entries(PROBES)) assert.ok(summary.includes(probe), `${name} survived: ${probe}\n\n${summary}`);
  assert.match(summary, /superseded/i, 'the old weight is marked superseded');
  assert.match(summary, /3\.0%/, 'the decision');
  assert.ok(summary.split(/\s+/).length <= SUMMARY_WORD_BUDGET, `under ${SUMMARY_WORD_BUDGET} words`);
});
