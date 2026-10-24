/**
 * tests/memoryReembed.test.ts — re-embedding a memory store (ADR 0148), on a
 * fake store: pages in id order, vectors written back, the record written
 * last, a dry run writing nothing, and the refusals (an older store, a
 * column of another size). Nothing is printed but counts and models.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { reembedMemory } from '../lib/memory/reembed.ts';
import type { Embedder } from '../lib/memory/providers.ts';
import type { EmbedderRecord, MemoryStore } from '../lib/memory/store.ts';

/** A store of `n` facts with 3-dimension vectors, remembering every write. */
function fakeStore(n: number, record: EmbedderRecord | null = { provider: 'gemini', model: 'gemini-embedding-001', dimensions: 3 }) {
  const facts = Array.from({ length: n }, (_, i) => ({ id: String(100 + i), fact: `fact ${i}`, embedding: [0, 0, 0] as number[] }));
  const state = { record, updates: [] as string[][], setCalls: 0 };
  const store: MemoryStore = {
    async existingFacts() { return new Set(); },
    async match() { return []; },
    async insert() { return []; },
    async retire() {},
    async deleteUser() { return 0; },
    async embeddingDimensions() { return 3; },
    async embedderRecord() { return state.record; },
    async recordEmbedder() {},
    async setEmbedder(r) { state.record = r; state.setCalls++; },
    async listFacts(cursor, limit) { return facts.filter((f) => !cursor || f.id > cursor).slice(0, limit).map(({ id, fact }) => ({ id, fact })); },
    async updateEmbeddings(rows) {
      state.updates.push(rows.map((r) => r.id));
      for (const r of rows) facts.find((f) => f.id === r.id)!.embedding = r.embedding;
    },
  };
  return { store, state, facts };
}

const embedder = (model = 'text-embedding-3-small', dimensions = 3, fail?: (call: number) => boolean): Embedder & { calls: number } => {
  const e = {
    provider: 'openai',
    model,
    dimensions,
    calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      if (fail?.(e.calls)) throw new Error('embedder down');
      return texts.map((t, i) => [e.calls, i, t.length]);
    },
  };
  return e;
};

test('a dry run counts the facts and names the models, and writes nothing', async () => {
  const { store, state, facts } = fakeStore(5);
  const lines: string[] = [];
  const report = await reembedMemory(store, embedder(), { batch: 2, dryRun: true, log: (l) => lines.push(l) });
  assert.deepEqual([report.facts, report.written, report.dryRun], [5, 0, true]);
  assert.equal(state.updates.length, 0);
  assert.equal(state.setCalls, 0);
  assert.ok(facts.every((f) => f.embedding.every((x) => x === 0)), 'no vector changed');
  assert.match(lines[0]!, /gemini\/gemini-embedding-001 \(3d\) → openai\/text-embedding-3-small \(3d\)/);
  assert.match(lines.at(-1)!, /dry run: 5 facts would be re-embedded/);
  assert.ok(!lines.some((l) => l.includes('fact 0')), 'never a fact');
});

test('a run re-embeds every fact in id-ordered pages, then records the new embedder last', async () => {
  const { store, state, facts } = fakeStore(5);
  const e = embedder();
  const report = await reembedMemory(store, e, { batch: 2 });
  assert.deepEqual([report.facts, report.written, report.dryRun], [5, 5, false]);
  assert.deepEqual(state.updates, [['100', '101'], ['102', '103'], ['104']]);
  assert.equal(e.calls, 3);
  assert.deepEqual(facts[4]!.embedding, [3, 0, 6]);
  assert.deepEqual(state.record, { provider: 'openai', model: 'text-embedding-3-small', dimensions: 3 });
  assert.equal(state.setCalls, 1);
});

test('an interrupted run leaves the old record in place, so the service keeps refusing the new model', async () => {
  const { store, state } = fakeStore(5);
  await assert.rejects(reembedMemory(store, embedder('text-embedding-3-small', 3, (call) => call === 2), { batch: 2 }), /embedder down/);
  assert.equal(state.updates.length, 1, 'the first page was written');
  assert.equal(state.record?.model, 'gemini-embedding-001', 'the record is untouched');
});

test('refused: a column of another size, and a store that cannot list or update', async () => {
  const { store } = fakeStore(2);
  await assert.rejects(reembedMemory(store, embedder('text-embedding-3-large', 1536)), /holds 3-dimension vectors and openai\/text-embedding-3-large produces 1536.*cannot change the column/);
  const older: MemoryStore = { ...store, listFacts: undefined, updateEmbeddings: undefined };
  await assert.rejects(reembedMemory(older, embedder()), /lacks listFacts, updateEmbeddings/);
});

test('an empty store with no record is re-embedded as a no-op that still records the embedder', async () => {
  const { store, state } = fakeStore(0, null);
  const report = await reembedMemory(store, embedder());
  assert.deepEqual([report.before, report.facts, report.written], [null, 0, 0]);
  assert.equal(state.record?.model, 'text-embedding-3-small');
});
