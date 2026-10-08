/**
 * Memory ingestion is at-least-once: a failed extraction, embedding or
 * insert leaves the session's turns pending, and the next ingestion of the
 * same session retries them. Before 2026-10 every one of those failures was
 * swallowed and the watermark moved past turns that were never distilled.
 * Offline: a fake model client and a fake Supabase client.
 *
 * Every ingestion test runs twice (ADR 0020 item 6, ADR 0059): through ADK's
 * `addSessionToMemory`, which the ADK runtime and the A2A server call, and
 * through the engine's own `MemoryService.ingest`, which the native runtime
 * calls. Both must keep the same promise.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { SupabaseVectorMemoryService } from '../lib/memory/supabaseMemoryService.ts';
import type { Embedder, MemoryExtractor } from '../lib/memory/providers.ts';
import type { MemoryService } from '../lib/runtime/memoryService.ts';

/** One ingestion, through either interface. */
type Ingest = (svc: SupabaseVectorMemoryService, session: any, rules?: string, extractionModel?: string) => Promise<void>;
const VIA: Array<[string, Ingest]> = [
  ['ADK addSessionToMemory', (svc, s, rules, model) => svc.addSessionToMemory(s, rules, { extractionModel: model })],
  ['engine ingest', (svc, s, rules, model) => (svc as MemoryService).ingest(s, { extractionRules: rules, extractionModel: model })],
];

/** A memory service whose extractor and embedder are the given fakes. */
function service(client: unknown, extract: () => Promise<string>, embed: () => Promise<number[]>) {
  const extractor: MemoryExtractor = { model: 'fake-extractor', extract };
  const embedder: Embedder = {
    provider: 'fake',
    model: 'fake-embedder',
    dimensions: 768,
    embed: async (texts) => Promise.all(texts.map(() => embed())),
  };
  return new SupabaseVectorMemoryService({ apiKey: 'test', extractor, embedder }, client as any);
}
const VECTOR = () => new Array(768).fill(0.01);

/**
 * A fake Supabase client that models migration 0007: melchizedek_memory_commit
 * stores the rows and advances the session's marker together (or, when told
 * to fail, neither), and the marker table can be read back.
 */
function fakeSupabase(shared?: { markers: Map<string, number>; inserted: Array<Record<string, unknown>> }) {
  const inserted = shared?.inserted ?? [];
  const markers = shared?.markers ?? new Map<string, number>();
  const state = { failCommit: false, dims: 768 as number | null };
  const filters: Record<string, unknown> = {};
  const chain = (result: () => unknown) => {
    const c: any = {
      select: () => c,
      eq: (col: string, v: unknown) => ((filters[col] = v), c),
      in: () => c,
      maybeSingle: async () => result(),
      then: (resolve: (v: unknown) => void) => resolve(result()),
    };
    return c;
  };
  const client: any = {
    from: (table: string) => ({
      select: () =>
        table === 'melchizedek_memory_ingest'
          ? chain(() => {
              const n = markers.get(`${filters.user_key}::${filters.session_id}`);
              return { data: n === undefined ? null : { events_ingested: n }, error: null };
            })
          : chain(() => ({ data: [], error: null })),
      update: () => chain(() => ({ data: [], error: null })),
    }),
    rpc: async (fn: string, args: any) => {
      if (fn === 'melchizedek_memory_dimensions') return { data: state.dims, error: null };
      if (fn !== 'melchizedek_memory_commit') return { data: [], error: null };
      if (state.failCommit) return { data: null, error: { message: 'commit refused' } };
      const rows = args.p_rows as Array<Record<string, unknown>>;
      inserted.push(...rows);
      const key = `${args.p_user_key}::${args.p_session_id}`;
      markers.set(key, Math.max(markers.get(key) ?? 0, args.p_events));
      return { data: rows.map((r, i) => ({ new_id: `id-${inserted.length + i}`, new_fact: r.fact })), error: null };
    },
  };
  return { client, inserted, markers, state };
}

const RECORD = '[PREFERENCE | date: 2026-10-01 | source: user | keys: tea] The user prefers green tea.';

function session(events: number) {
  return {
    id: 's1',
    appName: 'app',
    userId: 'u1',
    events: Array.from({ length: events }, (_, i) => ({
      author: i % 2 ? 'agent' : 'user',
      content: { role: i % 2 ? 'model' : 'user', parts: [{ text: i % 2 ? 'Noted.' : 'I prefer green tea.' }] },
    })),
  } as any;
}

for (const [via, ingest] of VIA) test(`a failed extraction leaves the turns pending and the next ingestion stores them (${via})`, async () => {
  const { client, inserted } = fakeSupabase();
  let fail = true;
  let calls = 0;
  const svc = service(
    client,
    async () => {
      calls += 1;
      if (fail) throw new Error('503 overloaded');
      return RECORD;
    },
    async () => VECTOR(),
  );

  await assert.rejects(ingest(svc, session(2)), /extraction failed/i);
  assert.strictEqual(inserted.length, 0);

  fail = false;
  await ingest(svc, session(2));
  assert.strictEqual(inserted.length, 1, 'the same turns are retried and stored');

  // Now the watermark has advanced: the same events are not re-extracted.
  calls = 0;
  await ingest(svc, session(2));
  assert.strictEqual(calls, 0);
});

for (const [via, ingest] of VIA) test(`a failed embedding also leaves the turns pending (${via})`, async () => {
  const { client, inserted } = fakeSupabase();
  let embedFails = true;
  const svc = service(
    client,
    async () => RECORD,
    async () => {
      if (embedFails) throw new Error('429');
      return VECTOR();
    },
  );
  await assert.rejects(ingest(svc, session(2)), /Embedding failed/);
  embedFails = false;
  await ingest(svc, session(2));
  assert.strictEqual(inserted.length, 1);
});

for (const [via, ingest] of VIA) test(`the processed marker survives a restart: a new process does not re-extract (${via})`, async () => {
  const shared = { markers: new Map<string, number>(), inserted: [] as Array<Record<string, unknown>> };
  let calls = 0;
  const first = service(fakeSupabase(shared).client, async () => ((calls += 1), RECORD), async () => VECTOR());
  await ingest(first, session(2));
  assert.strictEqual(shared.inserted.length, 1);

  // A fresh service over the same database: the durable marker says done.
  const restarted = service(fakeSupabase(shared).client, async () => ((calls += 1), RECORD), async () => VECTOR());
  calls = 0;
  await ingest(restarted, session(2));
  assert.strictEqual(calls, 0, 'nothing re-extracted after the restart');
  await ingest(restarted, session(4));
  assert.strictEqual(calls, 1, 'only the new turns are extracted');
});

for (const [via, ingest] of VIA) test(`a failed commit leaves facts and marker untouched, and the turns pending (${via})`, async () => {
  const fake = fakeSupabase();
  const svc = service(fake.client, async () => RECORD, async () => VECTOR());
  fake.state.failCommit = true;
  await assert.rejects(ingest(svc, session(2)), /turns stay pending/);
  assert.strictEqual(fake.inserted.length, 0);
  assert.strictEqual(fake.markers.size, 0);
  fake.state.failCommit = false;
  await ingest(svc, session(2));
  assert.strictEqual(fake.inserted.length, 1);
});

test('an embedder that does not fit the stored column is refused at boot', async () => {
  const fake = fakeSupabase();
  const svc = service(fake.client, async () => RECORD, async () => VECTOR());
  await svc.verifyEmbeddingDimensions();
  fake.state.dims = 1536;
  await assert.rejects(svc.verifyEmbeddingDimensions(), /stores 1536-dimension embeddings.*produces 768.*never drop the table/);
  fake.state.dims = null;
  await svc.verifyEmbeddingDimensions();
});

for (const [via, ingest] of VIA) test(`a syndicate's memory_extraction_model distils its turns; others use the deployment's (${via})`, async () => {
  const fake = fakeSupabase();
  const used: string[] = [];
  const svc = new SupabaseVectorMemoryService(
    {
      apiKey: 'test',
      extractor: { model: 'deployment-model', extract: async () => (used.push('deployment-model'), RECORD) },
      embedder: { provider: 'fake', model: 'fake-embedder', dimensions: 768, embed: async (t) => t.map(() => VECTOR()) },
      extractorFor: (model) => ({ model, extract: async () => (used.push(model), RECORD) }),
    },
    fake.client,
  );
  await ingest(svc, { ...session(2), id: 'a' }, undefined, 'cheap-model');
  await ingest(svc, { ...session(2), id: 'b' });
  await ingest(svc, { ...session(2), id: 'c' }, undefined, 'deployment-model');
  assert.deepStrictEqual(used, ['cheap-model', 'deployment-model', 'deployment-model']);
});

for (const [via, ingest] of VIA) test(`a syndicate's memory_extraction_rules reach its own extraction prompt only (${via})`, async () => {
  const fake = fakeSupabase();
  const prompts: string[] = [];
  const svc = new SupabaseVectorMemoryService(
    {
      apiKey: 'test',
      extractor: { model: 'm', extract: async (prompt) => (prompts.push(prompt), RECORD) },
      embedder: { provider: 'fake', model: 'fake-embedder', dimensions: 768, embed: async (t) => t.map(() => VECTOR()) },
    },
    fake.client,
  );
  await ingest(svc, { ...session(2), id: 'a' }, 'Never store a market quote.');
  await ingest(svc, { ...session(2), id: 'b' });
  assert.match(prompts[0], /DOMAIN RULES — [^\n]*\nNever store a market quote\.\n\nNow distill/);
  assert.doesNotMatch(prompts[1], /DOMAIN RULES|market quote/);
});
