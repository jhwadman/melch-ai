/**
 * tests/memoryRetention.test.ts — memory_retention_days (ADR 0020 item 7):
 * the schema demands a namespace for it, and the server prunes that
 * namespace when it loads the syndicate. The SQL is in migration 0008.
 * The server reaches `pruneExpired` by name, the name the engine's
 * MemoryService gives it (ADR 0052): once on a stand-in, once on the real
 * service over a store.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionService } from '@google/adk';

import { createA2AApp } from '../lib/a2a/app.ts';
import { SupabaseVectorMemoryService } from '../lib/memory/supabaseMemoryService.ts';
import type { MemoryStore } from '../lib/memory/store.ts';
import type { MemoryService } from '../lib/runtime/memoryService.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';

const base = { syndicate_name: 'Desk', memory_system: 'long-term', orchestrator: { name: 'Desk', model: 'gemini-3.8-flash', instruction: 'Help.' } };

test('memory_retention_days needs its own memory_namespace', () => {
  assert.throws(() => validateSyndicateConfig({ ...base, memory_retention_days: 30 }), /memory_retention_days — needs memory_namespace/);
  assert.doesNotThrow(() => validateSyndicateConfig({ ...base, memory_namespace: 'desk.a1', memory_retention_days: 30 }));
  assert.throws(() => validateSyndicateConfig({ ...base, memory_namespace: 'desk.a1', memory_retention_days: 0 }));
  assert.doesNotThrow(() => validateSyndicateConfig({ ...base, memory_extraction_model: 'gemini-3.5-flash-lite' }));
});

/** A server over one long-term syndicate that keeps its namespace's facts 30 days. */
async function serveDesk(memoryService: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'melch-retention-'));
  writeFileSync(join(dir, 'desk.yaml'), [
    'syndicate_name: Desk', 'memory_system: long-term', 'memory_namespace: desk.a1', 'memory_retention_days: 30',
    'orchestrator:', '  name: Desk', '  model: gemini-3.8-flash', '  instruction: Help.', 'subagents: []',
  ].join('\n'));
  process.env.MELCHIZEDEK_AGENTS_DIR = dir;
  const app = await createA2AApp({
    defaultSyndicate: 'desk.yaml',
    serverSecret: 'test-secret-0123456789abcdef0123456789', // gitleaks:allow (test fixture)
    storage: { sessionService: new InMemorySessionService(), memoryService: memoryService as any },
    log: () => {},
    warn: () => {},
  });
  await new Promise((r) => setTimeout(r, 20));
  return app;
}

test('the server prunes a syndicate namespace when it loads it', async () => {
  const calls: Array<[string, number]> = [];
  const memoryService = {
    addSessionToMemory: async () => {},
    searchMemory: async () => ({ memories: [] }),
    ingest: async () => {},
    search: async () => ({ memories: [] }),
    pruneExpired: async (ns: string, days: number) => (calls.push([ns, days]), 3),
  } satisfies MemoryService & Record<string, unknown>;
  const app = await serveDesk(memoryService);
  assert.deepEqual(calls, [['desk.a1', 30]]);
  await app.shutdown(0);
});

test("the server prunes through the real memory service's pruneExpired, down to its store", async () => {
  const pruned: Array<[string, number]> = [];
  const store = {
    existingFacts: async () => new Set<string>(),
    match: async () => [],
    insert: async () => [],
    retire: async () => {},
    deleteUser: async () => 0,
    pruneNamespace: async (ns: string, days: number) => (pruned.push([ns, days]), 4),
  } satisfies MemoryStore;
  const embedder = { provider: 'fake', model: 'fake', dimensions: 768, embed: async (t: string[]) => t.map(() => new Array(768).fill(0)) };
  const log = console.log;
  console.log = () => {};
  let memoryService: MemoryService;
  try {
    memoryService = new SupabaseVectorMemoryService({ apiKey: '', extractor: { model: 'fake', extract: async () => '' }, embedder }, store);
  } finally {
    console.log = log;
  }
  const app = await serveDesk(memoryService);
  assert.deepEqual(pruned, [['desk.a1', 30]], 'the namespace and the days the syndicate declares, unpinned');
  await app.shutdown(0);
});
