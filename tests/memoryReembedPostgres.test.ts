/**
 * tests/memoryReembedPostgres.test.ts — the recorded embedder and a re-embed
 * on a real Postgres (embedded PGlite with pgvector), through the package's
 * own store (lib/storage/postgres/memoryStore.ts) and migration 0023:
 * record once, refuse another model, list in id-ordered pages, write vectors
 * back, overwrite the record last (ADR 0147, ADR 0148).
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

import { inProcessTurnLock, postgresMemoryStore, postgresStorage } from '../lib/storage/postgres/index.ts';
import type { PostgresStorage } from '../lib/storage/postgres/index.ts';
import { reembedMemory } from '../lib/memory/reembed.ts';
import { SupabaseVectorMemoryService } from '../lib/memory/supabaseMemoryService.ts';
import type { Embedder } from '../lib/memory/providers.ts';
import type { MemoryStore } from '../lib/memory/store.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';

setLogLevel('error');

const INSTALL = [...readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((f) => `db/migrations/${f}`), 'db/hardening.sql'];

let db: PGlite;
let server: PGLiteSocketServer;
let storage: PostgresStorage;
let store: MemoryStore;

before(async () => {
  db = await PGlite.create({ extensions: { vector } });
  for (const f of INSTALL) await db.exec(readFileSync(f, 'utf-8'));
  server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 8 });
  await server.start();
  const { port } = (server as unknown as { server: { address(): { port: number } } }).server.address();
  storage = postgresStorage({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`, poolConfig: { max: 2 }, turnLock: inProcessTurnLock() });
  store = postgresMemoryStore(storage.pool);
});

after(async () => {
  await storage.close();
  await server.stop();
  await db.close();
});

const vec = (seed: number) => Array.from({ length: 768 }, (_, i) => (i === 0 ? seed : 0));
const embedderOf = (provider: string, model: string): Embedder & { calls: number } => {
  const e = { provider, model, dimensions: 768, calls: 0, async embed(texts: string[]) { e.calls++; return texts.map((_, i) => vec(100 * e.calls + i)); } };
  return e;
};
const service = (embedder: Embedder) => new SupabaseVectorMemoryService({ apiKey: 'test', extractor: { model: 'x', extract: async () => '{}' }, embedder }, store);

test('the store records its embedder once, and the service refuses another model on this database', async () => {
  assert.equal(await store.embedderRecord!(), null);
  await store.recordEmbedder!({ provider: 'gemini', model: 'gemini-embedding-001', dimensions: 768 });
  await store.recordEmbedder!({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 768 });
  assert.deepEqual(await store.embedderRecord!(), { provider: 'gemini', model: 'gemini-embedding-001', dimensions: 768 }, 'a later record changes nothing');
  await service(embedderOf('gemini', 'google/gemini-embedding-001')).verifyEmbeddingDimensions();
  await assert.rejects(service(embedderOf('openai', 'text-embedding-3-small')).verifyEmbeddingDimensions(), /embedded with gemini\/gemini-embedding-001 \(768d\), but the embedder is now openai\/text-embedding-3-small/);
});

test('a re-embed walks the facts in id order, writes the vectors back, and overwrites the record last', async () => {
  const rows = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((fact, i) => ({ user_key: 'ns/u1', fact, embedding: vec(1 + i), tag: null, fact_date: null, source: null, status: 'active', keys: [] as string[] }));
  const inserted = await store.insert(rows);
  assert.equal(inserted.length, 5);
  const page = await store.listFacts!(null, 2);
  assert.equal(page.length, 2);
  const rest = await store.listFacts!(page[1]!.id, 10);
  assert.equal(rest.length, 3);
  assert.ok(rest.every((r) => r.id > page[1]!.id), 'pages are id-ordered and disjoint');

  const dry = await reembedMemory(store, embedderOf('openai', 'text-embedding-3-small'), { batch: 2, dryRun: true });
  assert.deepEqual([dry.facts, dry.written], [5, 0]);
  assert.equal((await store.embedderRecord!())?.model, 'gemini-embedding-001', 'a dry run leaves the record');

  const e = embedderOf('openai', 'text-embedding-3-small');
  const report = await reembedMemory(store, e, { batch: 2 });
  assert.deepEqual([report.facts, report.written, e.calls], [5, 5, 3]);
  assert.deepEqual(await store.embedderRecord!(), { provider: 'openai', model: 'text-embedding-3-small', dimensions: 768 });
  // The vectors now carry the new embedder's values: the first component is the call's seed.
  const first = await storage.pool.query('SELECT fact, embedding::text AS e FROM adk_memory_facts ORDER BY id');
  const seeds = first.rows.map((r) => Number(String(r.e).slice(1).split(',')[0]));
  assert.deepEqual(seeds, [100, 101, 200, 201, 300]);
  // And the service now accepts the new model, refusing the old one.
  await service(embedderOf('openai', 'openai/text-embedding-3-small')).verifyEmbeddingDimensions();
  await assert.rejects(service(embedderOf('gemini', 'gemini-embedding-001')).verifyEmbeddingDimensions(), /embedded with openai\/text-embedding-3-small/);
});

test('the hardening locks the embedder table like the facts', async () => {
  const r = await storage.pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'melchizedek_memory_embedder'");
  assert.equal(r.rows[0]?.relrowsecurity, true);
});
