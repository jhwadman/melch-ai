/**
 * Offline tests for lib/guards/augustin.ts. No model, no network: a fixture
 * web-researcher report carrying the verdicts block, a fixture X report, and
 * answers shaped the way the Arbiter writes them — including the shapes the
 * guard exists to correct. Each rule in the module header has a case here.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  applyGuard,
  canonicalWord,
  computeHeadline,
  computeWord,
  parseVerdicts,
  type Verdict,
} from '../lib/guards/augustin.ts';
import { resolveGuards } from '../lib/guards/index.ts';

const VERDICTS = {
  verdicts: [
    { id: 'C1', kind: 'FACT', grade: 'CONFIRMED', context: false, domains: 2, depth: 'page-read', sources: ['apnews.com', 'washingtonpost.com'] },
    { id: 'C2', kind: 'FACT', grade: 'MISLEADING', domains: 1, depth: 'snippet', sources: ['theguardian.com'] },
    { id: 'C3u', kind: 'FACT', grade: 'CONFIRMED', domains: 1, depth: 'page-read', sources: ['crooked.com'] },
    { id: 'C3', kind: 'ARGUMENT', grade: 'WEIGHED', for: 1, against: 1, sources: ['washingtonpost.com'] },
    { id: 'C4', kind: 'OPINION', grade: 'SKIPPED', sources: ['crooked.com'] },
    { id: 'C5', kind: 'FACT', grade: 'UNCHECKED' },
    { id: 'C6', kind: 'FACT', grade: 'CONFIRMED', context: true, sources: ['reuters.com'] },
    { id: 'C7', kind: 'FACT', grade: 'CONTRADICTED', sources: ['reuters.com'] },
    { id: 'C8', kind: 'ARGUMENT', grade: 'WEIGHED', for: 3, against: 0, sources: ['apnews.com'] },
    { id: 'C9', kind: 'ARGUMENT', grade: 'WEIGHED', for: 0, against: 0 },
  ],
  primary_read: false,
  primary: 'the episode itself (no transcript is published)',
  sources: ['apnews.com', 'washingtonpost.com', 'theguardian.com', 'crooked.com', 'reuters.com'],
};

const xReport = [
  'CLAIMS:',
  '1. "The mayor voted to sell the park" (@parkwatch · corroboration: single-source)',
  'SPECTRUM: supporters of the mayor cite cityhall.gov minutes.',
  'GAPS: nothing on the vote count.',
].join('\n');

const webReport = (block: unknown = VERDICTS) => [
  'ESTABLISHED:',
  '1. The council voted 7-2 on 2026-09-30 (apnews.com, wire, CONFIRMED)',
  'CLAIM CHECK:',
  'FACT — CONFIRMED — the vote happened — apnews.com',
  'SOURCES: apnews.com, washingtonpost.com',
  '```json',
  typeof block === 'string' ? block : JSON.stringify(block),
  '```',
].join('\n');

const tools = [xReport, webReport()];

// ── parse ────────────────────────────────────────────────────────────────────

test('parse takes the LAST fenced verdicts block across tool texts and tolerates missing fields', () => {
  const earlier = webReport({ verdicts: [{ id: 'C1', kind: 'FACT', grade: 'CONTRADICTED' }] });
  const block = parseVerdicts([earlier, xReport, webReport()]);
  assert.ok(block);
  assert.strictEqual(block.verdicts.length, 10);
  assert.strictEqual(block.verdicts[0]!.grade, 'CONFIRMED');
  assert.strictEqual(block.primary_read, false);
  assert.deepStrictEqual(block.verdicts[5]!.sources, []);
  assert.strictEqual(block.verdicts[3]!.for, 1);
});

test('parse skips a fence that is not JSON and returns null when no block carries verdicts', () => {
  assert.strictEqual(parseVerdicts(['```json\n{not json\n```', 'plain text']), null);
  assert.strictEqual(parseVerdicts(['```json\n{"sources":["a.com"]}\n```']), null);
  const block = parseVerdicts(['```json\n{"verdicts":[{"id":"C1","grade":"weighed","for":"2"}]}\n```']);
  assert.ok(block);
  assert.strictEqual(block.verdicts[0]!.kind, 'ARGUMENT', 'kind recovered from the grade');
  assert.strictEqual(block.verdicts[0]!.for, 2);
  assert.strictEqual(block.primary_read, undefined);
});

// ── computeWord ──────────────────────────────────────────────────────────────

const fact = (grade: string, extra: Partial<Verdict> = {}): Verdict => ({ id: 'C1', kind: 'FACT', grade, ...extra });
const argument = (f: number, a: number): Verdict => ({ id: 'C3', kind: 'ARGUMENT', grade: 'WEIGHED', for: f, against: a });

test('a FACT word follows its grade', () => {
  assert.strictEqual(computeWord(fact('CONFIRMED')).word, 'True');
  assert.strictEqual(computeWord(fact('CONFIRMED', { context: true })).word, 'Missing context');
  assert.strictEqual(computeWord(fact('MISLEADING'), 'True').word, 'Misleading');
  assert.strictEqual(computeWord(fact('CONTRADICTED')).word, 'False');
  assert.strictEqual(computeWord(fact('UNVERIFIED')).word, 'Unverified');
  const unchecked = computeWord(fact('UNCHECKED'));
  assert.deepStrictEqual([unchecked.word, unchecked.notReached], ['Unverified', true]);
  const odd = computeWord(fact('PLAUSIBLE'));
  assert.strictEqual(odd.word, 'Unverified');
  assert.match(odd.reason ?? '', /unknown/);
});

test('an ARGUMENT keeps a permitted weighing unless the counts forbid it', () => {
  assert.strictEqual(computeWord(argument(3, 0), 'Supported').word, 'Supported');
  assert.strictEqual(computeWord(argument(2, 1), 'Unsupported').word, 'Unsupported');
  const one = computeWord(argument(1, 1), 'Supported');
  assert.deepStrictEqual([one.word, one.reason], ['Unsupported', 'for=1']);
  const none = computeWord(argument(0, 0), 'Supported');
  assert.deepStrictEqual([none.word, none.reason], ['Unverified', 'for=0, against=0']);
  const stray = computeWord(argument(2, 1), 'True');
  assert.strictEqual(stray.word, 'Unverified');
  assert.ok(stray.reason);
  assert.strictEqual(computeWord(argument(2, 1), null).word, 'Unverified');
});

test('an OPINION is Opinion; a `u` id is ruled as a FACT whatever its kind', () => {
  assert.strictEqual(computeWord({ id: 'C4', kind: 'OPINION', grade: 'SKIPPED' }, 'True').word, 'Opinion');
  assert.strictEqual(computeWord({ id: 'C3u', kind: 'ARGUMENT', grade: 'CONFIRMED', for: 0, against: 0 }).word, 'True');
  assert.strictEqual(canonicalWord('missing  Context'), 'Missing context');
  assert.strictEqual(canonicalWord('Not checkable'), null);
});

// ── computeHeadline ──────────────────────────────────────────────────────────

test('the headline is arithmetic over the words', () => {
  assert.strictEqual(computeHeadline([]), null);
  assert.strictEqual(computeHeadline(['Misleading']), 'Misleading');
  assert.strictEqual(computeHeadline(['Missing context']), 'True, but missing context');
  assert.strictEqual(computeHeadline(['Opinion', 'Opinion']), 'Opinion');
  assert.strictEqual(computeHeadline(['True', 'True']), 'True');
  assert.strictEqual(computeHeadline(['True', 'Missing context']), 'True, but missing context');
  assert.strictEqual(computeHeadline(['False', 'False']), 'False');
  assert.strictEqual(computeHeadline(['Unverified', 'Unverified']), 'Unverified');
  assert.strictEqual(computeHeadline(['True', 'Misleading']), 'Mixed');
  assert.strictEqual(computeHeadline(['Supported', 'Supported']), 'Mixed', 'argument words carry no headline family');
  assert.strictEqual(computeHeadline(['True', 'Unsupported']), 'Mixed');
});

test('an Opinion beside any ruling word makes the headline Mixed, whatever the ruling family', () => {
  assert.strictEqual(computeHeadline(['True', 'Opinion']), 'Mixed');
  assert.strictEqual(computeHeadline(['True', 'True', 'Opinion']), 'Mixed');
  assert.strictEqual(computeHeadline(['Missing context', 'Opinion']), 'Mixed');
  assert.strictEqual(computeHeadline(['Misleading', 'Opinion']), 'Mixed');
  assert.strictEqual(computeHeadline(['False', 'False', 'Opinion']), 'Mixed');
  assert.strictEqual(computeHeadline(['Unverified', 'Unverified', 'Opinion']), 'Mixed');
  assert.strictEqual(computeHeadline(['Supported', 'Opinion']), 'Mixed');
  assert.strictEqual(computeHeadline(['Unsupported', 'Opinion']), 'Mixed');
  // Through the guard: facts that check out beside an opinion headline Mixed, not True.
  const t = [
    '**Fact check: True**',
    'The episode itself was not read.',
    '- True: the council voted 7-2 on 2026-09-30 (apnews.com) [C1]',
    '- Opinion: the host, that the vote was cowardly. Nothing in the record speaks to motive (crooked.com) [C4]',
  ].join('\n');
  const { text, notes } = applyGuard(t, tools);
  assert.strictEqual(text.split('\n')[0], '**Fact check: Mixed**');
  assert.deepStrictEqual(notes, ['headline True→Mixed']);
});

// ── applyGuard on a FACT CHECK answer ────────────────────────────────────────

const answer = [
  '**Fact check: True**',
  'The council did vote, but the piece misstates what on.',
  '- Confirmed: the council voted 7-2 on 2026-09-30 (apnews.com, washingtonpost.com) [C1]',
  "- True: the mayor 'voted to sell the park' — she voted against a bill banning its sale (theguardian.com) [C2]",
  '- Supported: the administration governs by voiding its own rules — one action was voided in court (washingtonpost.com) [C3]',
  '- Opinion: the host, that the vote was cowardly. Nothing in the record speaks to motive (crooked.com) [C4]',
  '- Unverified: the vote was scheduled a day early (nytimes.com) [C5]',
  '- Opinion: the guest, that the park is doomed. Not a claim of fact (crooked.com) [C4]',
  '- The episode aired on 2026-10-01 (cityhall.gov).',
].join('\n');

test('a FACT CHECK answer: words computed, opinions merged, headline recomputed, limit first, sources held, tags stripped', () => {
  const { text, notes } = applyGuard(answer, tools);
  const lines = text.split('\n');
  assert.strictEqual(lines[0], '**Fact check: Mixed**');
  assert.ok(lines[1]!.startsWith('The episode itself (no transcript is published) was not read; this rests on what could be found about it. The council did vote'), lines[1]);
  assert.strictEqual(lines[2], '- True: the council voted 7-2 on 2026-09-30 (apnews.com, washingtonpost.com)');
  assert.strictEqual(lines[3], "- Misleading: the mayor 'voted to sell the park' — she voted against a bill banning its sale (theguardian.com)");
  assert.strictEqual(lines[4], '- Unsupported: the administration governs by voiding its own rules — one action was voided in court (washingtonpost.com)');
  assert.strictEqual(lines[5], '- Opinion: the host, that the vote was cowardly. Nothing in the record speaks to motive; the guest, that the park is doomed. Not a claim of fact (crooked.com).');
  assert.strictEqual(lines[6], '- Unverified: the vote was scheduled a day early (not reached) (nytimes.com) [unsourced: nytimes.com]');
  assert.strictEqual(lines[7], '- The episode aired on 2026-10-01 (cityhall.gov).', 'a plain bullet is untouched; cityhall.gov is in the X report');
  assert.strictEqual(lines.length, 8, 'the second Opinion bullet is gone');
  assert.ok(!/\[C\d/.test(text), 'tags stripped');
  assert.deepStrictEqual(notes, [
    'C1 Confirmed→True',
    'C2 True→Misleading',
    'C3 Supported→Unsupported (for=1)',
    'opinion bullets merged (2)',
    'headline True→Mixed',
    'limit line inserted',
    'unsourced domain nytimes.com in C5',
  ]);
});

test('an answer already in the vocabulary passes with no notes', () => {
  const clean = [
    '**Fact check: True, but missing context**',
    'The episode itself was not read: no transcript is published. The figure is right; its base is not stated.',
    '- Missing context: unemployment "doubled" — from 2.1% to 4.2% over 2025 (reuters.com) [C6]',
    '- True: the council voted 7-2 on 2026-09-30 (apnews.com) [C1]',
  ].join('\n');
  const { text, notes } = applyGuard(clean, tools);
  assert.deepStrictEqual(notes, []);
  assert.strictEqual(text, clean.replace(/ \[C\d\]/g, ''));
});

test('a utterance id alone is ruled as a FACT; several ids resolve to the first non-u id', () => {
  const t = [
    '**Fact check: True**',
    'Limits: the episode itself was not read.',
    '- Unverified: Lewis said the theory is insane (crooked.com) [C3u]',
    '- Supported: the theory is insane (washingtonpost.com) [C3u, C3]',
  ].join('\n');
  const { text, notes } = applyGuard(t, tools);
  const lines = text.split('\n');
  assert.strictEqual(lines[2], '- True: Lewis said the theory is insane (crooked.com)');
  assert.strictEqual(lines[3], '- Unsupported: the theory is insane (washingtonpost.com)');
  assert.strictEqual(lines[0], '**Fact check: Mixed**');
  assert.ok(notes.includes('C3u Unverified→True'));
  assert.ok(notes.includes('C3 Supported→Unsupported (for=1)'));
  assert.strictEqual(notes.filter((n) => n.startsWith('limit line')).length, 0, 'a limit sentence in the model\'s own words stands');
});

test('an unknown id leaves the word and notes it; a stray word on an untagged bullet is only noted', () => {
  const t = [
    '**Fact check: False**',
    'The episode itself was not read.',
    '- False: the mayor resigned (reuters.com) [C7]',
    '- Confirmed: something the record never listed (reuters.com) [C42]',
    '- Not checkable: whether the mayor meant it (reuters.com)',
  ].join('\n');
  const { text, notes } = applyGuard(t, tools);
  const lines = text.split('\n');
  assert.strictEqual(lines[3], '- Confirmed: something the record never listed (reuters.com)');
  assert.strictEqual(lines[4], '- Not checkable: whether the mayor meant it (reuters.com)');
  assert.strictEqual(lines[0], '**Fact check: False**', 'headline over the one resolvable bullet');
  assert.ok(notes.some((n) => n.startsWith('C42 is not in the record')));
  assert.ok(notes.some((n) => n.includes('"Confirmed" is not a verdict word (C42)')));
  assert.ok(notes.some((n) => n.includes('"Not checkable" is not a verdict word (untagged bullet')));
});

test('a tagged bullet with no verdict word gains the computed one; an argument with nothing counted is Unverified', () => {
  const t = [
    '**Fact check: Supported**',
    'The episode itself was not read.',
    '- The agency acts in bad faith (apnews.com) [C9]',
    '- Supported: a pattern of voided actions, three in the record (apnews.com) [C8]',
  ].join('\n');
  const { text, notes } = applyGuard(t, tools);
  const lines = text.split('\n');
  assert.strictEqual(lines[2], '- Unverified: The agency acts in bad faith (apnews.com)');
  assert.strictEqual(lines[3], '- Supported: a pattern of voided actions, three in the record (apnews.com)');
  assert.strictEqual(lines[0], '**Fact check: Mixed**');
  assert.ok(notes.includes('C9 no verdict word→Unverified (for=0, against=0)'));
});

test('a verdict line is inserted when tagged bullets exist without one; the limit line goes under it', () => {
  const t = [
    'The council did vote.',
    '- True: the council voted 7-2 (apnews.com) [C1]',
  ].join('\n');
  const { text, notes } = applyGuard(t, tools);
  const lines = text.split('\n');
  assert.strictEqual(lines[0], '**Fact check: True**');
  assert.ok(lines[1]!.startsWith('The episode itself (no transcript is published) was not read;'));
  assert.ok(lines[1]!.endsWith('The council did vote.'));
  assert.strictEqual(lines[2], '- True: the council voted 7-2 (apnews.com)');
  assert.ok(notes.includes('headline inserted (True)'));
  assert.ok(notes.includes('limit line inserted'));
});

test('with bullets directly under the verdict line the limit sentence becomes its own line', () => {
  const t = ['**Fact check: True**', '- True: the council voted 7-2 (apnews.com) [C1]'].join('\n');
  const { text } = applyGuard(t, tools);
  assert.deepStrictEqual(text.split('\n'), [
    '**Fact check: True**',
    'The episode itself (no transcript is published) was not read; this rests on what could be found about it.',
    '- True: the council voted 7-2 (apnews.com)',
  ]);
});

test('primary_read true, or absent, adds no limit line; a missing primary defaults to "primary source"', () => {
  const read = [webReport({ ...VERDICTS, primary_read: true })];
  const t = ['**Fact check: True**', 'Short.', '- True: the council voted 7-2 (apnews.com) [C1]'].join('\n');
  assert.ok(!/not read/.test(applyGuard(t, read).text));
  const noPrimary = [webReport({ ...VERDICTS, primary: undefined })];
  assert.ok(applyGuard(t, noPrimary).text.includes('The primary source was not read;'));
});

test('the source set includes domains and @handles from any tool text; www. and paths normalize', () => {
  const t = [
    '**Fact check: True**',
    'The episode itself was not read.',
    '- True: the council voted 7-2 (www.apnews.com/article/x, @parkwatch, cityhall.gov) [C1]',
  ].join('\n');
  const { notes } = applyGuard(t, tools);
  assert.deepStrictEqual(notes, []);
});

// ── passthrough shapes ───────────────────────────────────────────────────────

test('OVERVIEW: no verdict line, bullets — only the limit line is prepended; nothing else moves', () => {
  const t = [
    'The mayor voted against a ban on selling the park; no sale is proposed.',
    '- The council voted 7-2 on 2026-09-30 (apnews.com)',
    '- Confirmed: the vote was contested — single-source (@parkwatch)',
  ].join('\n');
  const { text, notes } = applyGuard(t, tools);
  assert.strictEqual(text, `The episode itself (no transcript is published) was not read; this rests on what could be found about it.\n${t}`);
  assert.deepStrictEqual(notes, ['limit line inserted']);
  const read = applyGuard(t, [webReport({ ...VERDICTS, primary_read: true })]);
  assert.strictEqual(read.text, t);
  assert.deepStrictEqual(read.notes, []);
});

test('OVERVIEW whose lead already states the limit is untouched', () => {
  const t = 'The episode itself was not read; this rests on coverage.\n- The council voted 7-2 (apnews.com)';
  assert.deepStrictEqual(applyGuard(t, tools), { text: t, notes: [] });
});

test('CONVERSATIONAL: no bullets, no verdict line — untouched even when the primary was not read', () => {
  const t = 'No. Per AP the council voted 7-2 against the ban, not for a sale.';
  assert.deepStrictEqual(applyGuard(t, tools), { text: t, notes: [] });
});

// ── failure modes ────────────────────────────────────────────────────────────

test('no verdicts block: text unchanged but stray tags stripped, with the note', () => {
  const t = '**Fact check: Confirmed**\n- Confirmed: the vote happened (apnews.com) [C1]';
  const { text, notes } = applyGuard(t, [xReport, 'ESTABLISHED: nothing']);
  assert.strictEqual(text, '**Fact check: Confirmed**\n- Confirmed: the vote happened (apnews.com)');
  assert.deepStrictEqual(notes, ['no verdicts block; vocabulary not enforced']);
});

test('malformed JSON in the fence is the same as no block; garbage inputs never throw', () => {
  const t = '**Fact check: True**\n- True: x (apnews.com) [C1]';
  const { notes } = applyGuard(t, [webReport('{"verdicts": [}')]);
  assert.deepStrictEqual(notes, ['no verdicts block; vocabulary not enforced']);
  // Items that are not objects, ids that are not strings, nulls.
  const weird = webReport({ verdicts: [null, 7, { id: 1, kind: 'FACT', grade: 'CONFIRMED' }, { kind: 'FACT' }], sources: 'apnews.com' });
  const out = applyGuard(t, [weird]);
  assert.strictEqual(out.text, '**Fact check: True**\n- True: x (apnews.com)');
  assert.doesNotThrow(() => applyGuard(t, undefined as unknown as string[]));
  assert.doesNotThrow(() => applyGuard('', tools));
});

test('the guard resolves by name and runs the same function', async () => {
  const [guard] = resolveGuards(['augustin']);
  assert.ok(guard);
  assert.strictEqual(guard.name, 'augustin');
  const out = await guard.run(answer, tools);
  assert.deepStrictEqual(out, applyGuard(answer, tools));
});
