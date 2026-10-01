/**
 * tests/memoryRetention.test.ts — memory_retention_days (ADR 0020 item 7):
 * the schema demands a namespace for it, and the server prunes that
 * namespace when it loads the syndicate. The SQL is in migration 0008.
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
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';

const base = { syndicate_name: 'Desk', memory_system: 'long-term', orchestrator: { name: 'Desk', model: 'gemini-3.8-flash', instruction: 'Help.' } };

test('memory_retention_days needs its own memory_namespace', () => {
  assert.throws(() => validateSyndicateConfig({ ...base, memory_retention_days: 30 }), /memory_retention_days — needs memory_namespace/);
  assert.doesNotThrow(() => validateSyndicateConfig({ ...base, memory_namespace: 'desk.a1', memory_retention_days: 30 }));
  assert.throws(() => validateSyndicateConfig({ ...base, memory_namespace: 'desk.a1', memory_retention_days: 0 }));
  assert.doesNotThrow(() => validateSyndicateConfig({ ...base, memory_extraction_model: 'gemini-3.5-flash-lite' }));
});

test('the server prunes a syndicate namespace when it loads it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-retention-'));
  writeFileSync(join(dir, 'desk.yaml'), [
    'syndicate_name: Desk', 'memory_system: long-term', 'memory_namespace: desk.a1', 'memory_retention_days: 30',
    'orchestrator:', '  name: Desk', '  model: gemini-3.8-flash', '  instruction: Help.', 'subagents: []',
  ].join('\n'));
  process.env.MELCHIZEDEK_AGENTS_DIR = dir;
  const calls: Array<[string, number]> = [];
  const memoryService: any = {
    addSessionToMemory: async () => {},
    searchMemory: async () => ({ memories: [] }),
    pruneExpired: async (ns: string, days: number) => (calls.push([ns, days]), 3),
  };
  const app = await createA2AApp({
    defaultSyndicate: 'desk.yaml',
    serverSecret: 'test-secret-0123456789abcdef0123456789', // gitleaks:allow (test fixture)
    storage: { sessionService: new InMemorySessionService(), memoryService },
    log: () => {},
    warn: () => {},
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, [['desk.a1', 30]]);
  await app.shutdown(0);
});
