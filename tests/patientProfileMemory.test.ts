/**
 * tests/patientProfileMemory.test.ts — the Patient Advocate's whole-person
 * profile and the engine pieces it rests on: standing preload queries
 * (ADR 0156), the extractor's truncation guard and thinking level, and the
 * profile contract in the example's YAML. Offline: scripted models and an
 * in-memory search.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { modelExtractor } from '../lib/memory/providers.ts';
import type { MemoryEntry, MemorySearchRequest, MemoryService } from '../lib/runtime/memoryService.ts';
import { PRELOAD_PER_STANDING_QUERY, mergePreload, nativeMemory } from '../lib/runtime/nativeTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { createToolContext } from '../lib/tools/tool.ts';
import { preloadMemoryTool } from '../lib/tools/memoryTools.ts';
import { ScriptedModel, answer } from './helpers/scriptedModel.ts';

process.env.OTEL_CONSOLE_SPANS = 'false';

const entry = (text: string, id = text): MemoryEntry => ({ id, content: { role: 'user', parts: [{ text }] } });

/** A search that answers each query from a table and records every request. */
function tableMemory(table: Record<string, string[]>): MemoryService & { requests: MemorySearchRequest[] } {
  const requests: MemorySearchRequest[] = [];
  return {
    requests,
    async ingest() {},
    async search(request) {
      requests.push(request);
      if (request.query === 'broken') throw new Error('store down');
      return { memories: (table[request.query] ?? []).map((t) => entry(t)) };
    },
  };
}

const SILO = { appName: 'patient_advocate.test', userId: 'u1' };

// ── Standing preload queries (ADR 0156) ──────────────────────────────────────

test('a preload brings each standing query\'s records after the message\'s own; a plain search does not', async () => {
  const base = tableMemory({
    'is grapefruit ok with her statin': ['medications: atorvastatin 40 mg', 'nutrition: grapefruit juice daily'],
    'allergies': ['allergies: penicillin, hives', 'allergies: latex', 'allergies: a third record'],
    'communication': ['communication: plain verdicts, few numbers', 'medications: atorvastatin 40 mg'],
  });
  const memory = nativeMemory(base, ['allergies', 'communication'])!;

  const preload = await memory.search({ ...SILO, query: 'is grapefruit ok with her statin', purpose: 'preload' });
  assert.deepEqual(preload.memories.map((m) => m.id), [
    'medications: atorvastatin 40 mg',
    'nutrition: grapefruit juice daily',
    'allergies: penicillin, hives',
    'allergies: latex',
    'communication: plain verdicts, few numbers',
  ], `the message's own first, then at most ${PRELOAD_PER_STANDING_QUERY} new records per standing query, no repeats`);

  const recall = await memory.search({ ...SILO, query: 'allergies' });
  assert.equal(recall.memories.length, 3, 'load_memory gets the query\'s records alone');
  assert.ok(base.requests.every((r) => !('purpose' in r)), 'the store never sees the purpose');
});

test('standing queries run once per silo per turn, and a failing one costs only its own records', async () => {
  const base = tableMemory({ q: ['own'], allergies: ['allergies: latex'] });
  const memory = nativeMemory(base, ['allergies', 'broken'])!;
  await memory.search({ ...SILO, query: 'q', purpose: 'preload' });
  const second = await memory.search({ ...SILO, query: 'q', purpose: 'preload' });
  assert.deepEqual(second.memories.map((m) => m.id), ['own', 'allergies: latex']);
  assert.equal(base.requests.filter((r) => r.query === 'allergies').length, 1, 'cached for the turn');
  await memory.search({ appName: SILO.appName, userId: 'u2', query: 'q', purpose: 'preload' });
  assert.equal(base.requests.filter((r) => r.query === 'allergies').length, 2, 'another silo searches its own');
  assert.ok(base.requests.filter((r) => r.query === 'allergies').every((r) => r.appName === SILO.appName));
});

test('without standing queries a preload is the message\'s search alone', async () => {
  const base = tableMemory({ q: ['own'] });
  const memory = nativeMemory(base)!;
  const out = await memory.search({ ...SILO, query: 'q', purpose: 'preload' });
  assert.deepEqual(out.memories.map((m) => m.id), ['own']);
  assert.deepEqual(base.requests, [{ ...SILO, query: 'q' }]);
});

test('records match by id, or by text when they carry none', () => {
  const noId = (t: string): MemoryEntry => ({ content: { role: 'user', parts: [{ text: t }] } });
  assert.deepEqual(mergePreload([noId('a')], [[noId('a'), noId('b')]]).map((m) => m.content.parts![0]!.text), ['a', 'b']);
});

test('preload_memory asks for a preload; the tool context passes it to the search', async () => {
  const seen: MemorySearchRequest[] = [];
  const ctx = createToolContext({
    appName: 'desk',
    userId: 'u1',
    userContent: { role: 'user', parts: [{ text: 'tea?' }] },
    memory: { search: async (r) => (seen.push(r), { memories: [] }) },
  });
  await preloadMemoryTool.instruction(ctx);
  assert.deepEqual(seen, [{ appName: 'desk', userId: 'u1', query: 'tea?', purpose: 'preload' }]);
});

test('memory_preload_queries needs long-term memory and holds at most 8 queries', () => {
  const base = { syndicate_name: 'S', orchestrator: { name: 'A', model: 'gemini-3.8-flash', instruction: 'x' } };
  assert.throws(() => validateSyndicateConfig({ ...base, memory_preload_queries: ['allergies'] }), /needs memory_system: long-term/);
  assert.throws(() => validateSyndicateConfig({ ...base, memory_system: 'long-term', memory_preload_queries: Array(9).fill('q') }));
  assert.doesNotThrow(() => validateSyndicateConfig({ ...base, memory_system: 'long-term', memory_preload_queries: ['allergies'] }));
});

// ── The extractor ────────────────────────────────────────────────────────────

test('an extraction cut off by its cap drops the unfinished last record and says so', async () => {
  const warnings: string[] = [];
  const adapter = new ScriptedModel('gemini-3.8-flash', () => ({
    ...answer('[FACT | keys: a] medications: one whole record\n[FACT | keys: b] medications: atorvastatin 40 mg'),
    finishReason: 'max_tokens',
  }));
  const extractor = modelExtractor({ resolve: () => adapter, onTruncated: (m) => warnings.push(m) });
  assert.equal(await extractor.extract('PROMPT'), '[FACT | keys: a] medications: one whole record');
  assert.match(warnings[0] ?? '', /16384-token cap; the last record was dropped/);
});

test('extraction thinks at low effort unless told otherwise', async () => {
  const adapter = new ScriptedModel('gemini-3.8-flash', () => answer('NO_FACTS_EXTRACTED'));
  await modelExtractor({ resolve: () => adapter }).extract('x');
  await modelExtractor({ resolve: () => adapter, reasoning: 'medium' }).extract('x');
  assert.deepEqual(adapter.requests.map((r) => r.reasoning), ['low', 'medium']);
  assert.equal(adapter.requests[0]!.sampling?.maxOutputTokens, 16384);
});

// ── The Patient Advocate's profile contract ──────────────────────────────────

const DOMAINS = [
  'identity', 'conditions', 'medications', 'allergies', 'results', 'care-plan', 'care-team',
  'symptoms', 'nutrition', 'lifestyle', 'psychology', 'values', 'support', 'communication',
];

test('the Patient Advocate files every record under a profile domain its agent also knows', async () => {
  const cfg = await loadSyndicate('examples/patient_advocate.yaml');
  const rules = cfg.memory_extraction_rules ?? '';
  const instruction = cfg.orchestrator.instruction;
  for (const domain of DOMAINS) {
    assert.match(rules, new RegExp(`^\\s*- ${domain}: `, "m"), `the extractor files ${domain}`);
    assert.match(instruction, new RegExp(`^\\s*- ${domain}: `, "m"), `Asclepius knows ${domain}`);
  }
  // The domain opens the record's text and is never a key: a key every
  // record in a domain shares would let one correction retire them all.
  assert.match(rules, /record text opens with the domain word/);
  assert.match(rules, /ONE THING PER RECORD/, 'a bundled record loses its other facts to one correction');
  assert.match(rules, /A key is never the domain word, never the patient's or the user's name/);
  assert.match(rules, /Never store a diagnosis, a personality type or a judgment/);
  assert.match(instruction, /NEVER KEPT: insurance member or policy numbers/);
  assert.match(rules, /Never store: insurance member or policy numbers/);
  assert.doesNotMatch(rules + instruction, /\{\{/, 'every variable resolved');

  const standing = cfg.memory_preload_queries ?? [];
  for (const domain of ['allergies', 'medications', 'communication', 'values', 'support', 'psychology']) {
    assert.ok(standing.some((q) => q.startsWith(`${domain}: `)), `${domain} is preloaded with every message`);
  }
});
