/**
 * tests/promptPrefix.test.ts — the prefix every provider caches is the same
 * request to request (ADR 0151).
 *
 * A provider caches a prompt as a prefix: the tools, then the system
 * prompt, then the history. A word that changes in the system prompt
 * misses the whole history behind it, so text for one step alone (the
 * facts preload_memory recalls for this message) rides after the history
 * in `ModelRequest.turnNotes`, and the system prompt and tool declarations
 * of an agent are byte-identical from one turn to the next.
 *
 * Offline: a scripted adapter on the contract records what the loop sends.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { MemoryEntry, MemoryService } from '../lib/runtime/memoryService.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer } from './helpers/scriptedModel.ts';

registerTool(
  'prefix_lookup',
  defineTool({
    name: 'prefix_lookup',
    description: 'Look a key up.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }) => `found ${key}`,
    // A stable note: the same words on every request.
    instruction: async () => 'prefix_lookup answers from the record.',
  }),
);

const CONFIG = {
  syndicate_name: 'Desk',
  memory_system: 'long-term',
  orchestrator: {
    name: 'Desk',
    model: 'scripted/desk',
    instruction: 'Answer from memory.',
    tools: ['preload_memory', 'prefix_lookup', 'load_memory'],
  },
  subagents: [],
} as unknown as SyndicateYamlConfig;

/** A memory whose recall names the query, so every turn's block differs. */
function memoryFor(): MemoryService {
  return {
    async search({ query }) {
      const memories: MemoryEntry[] = [{ content: { role: 'user', parts: [{ text: `recalled for: ${query}` }] }, author: 'memory_service', timestamp: '2026-10-01T09:00:00.000Z' }];
      return { memories };
    },
    async ingest() {},
  };
}

test('the system prompt and tools are byte-identical across turns; the recall for each message rides after the history', async () => {
  const desk = new ScriptedModel('scripted/desk', () => answer('Green tea.'));
  const sessionService = new InProcessSessionService();
  const turn = (message: string) =>
    runSyndicateTurn({
      config: CONFIG,
      parts: [{ text: message }],
      appName: 'desk.a1',
      userId: 'scope-a',
      sessionId: 's1',
      sessionService,
      memoryService: memoryFor(),
      compile: { resolveModel: () => desk },
      trace: false,
    });
  assert.equal((await turn('what tea do I like?')).status, 'completed');
  assert.equal((await turn('and coffee?')).status, 'completed');
  assert.equal(desk.requests.length, 2);
  const [first, second] = desk.requests as [typeof desk.requests[0], typeof desk.requests[0]];

  // The cached prefix: the same bytes on both turns.
  assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools), 'tool declarations');
  assert.equal(first.system, second.system, 'the system prompt');
  assert.ok(first.system?.includes('Answer from memory.'));
  assert.ok(first.system?.includes('prefix_lookup answers from the record.'), 'a stable tool note is in the system prompt');
  assert.ok(first.system?.includes('load_memory'), 'load_memory’s note is stable too');
  assert.ok(!first.system?.includes('<PAST_CONVERSATIONS>'), 'the recall is not in the system prompt');

  // The step's own text, after the history, different each turn.
  assert.match(first.turnNotes ?? '', /<PAST_CONVERSATIONS>\n[\s\S]*recalled for: what tea do I like\?\n<\/PAST_CONVERSATIONS>/);
  assert.match(second.turnNotes ?? '', /recalled for: and coffee\?/);
  assert.notEqual(first.turnNotes, second.turnNotes);
  // The history grows by the first turn's exchange and nothing else is reordered.
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 3);
  assert.deepEqual(second.messages.slice(0, 1), first.messages, 'the first turn’s message is the same bytes in the second request');
});

test('without a volatile tool the request carries no turnNotes', async () => {
  const desk = new ScriptedModel('scripted/desk', () => answer('ok'));
  const config = structuredClone(CONFIG) as any;
  config.memory_system = 'session-only';
  config.orchestrator.tools = ['prefix_lookup'];
  const r = await runSyndicateTurn({
    config,
    parts: [{ text: 'hi' }],
    appName: 'desk.a1',
    userId: 'scope-a',
    sessionId: 's2',
    sessionService: new InProcessSessionService(),
    compile: { resolveModel: () => desk },
    trace: false,
  });
  assert.equal(r.status, 'completed');
  assert.equal(desk.requests[0]?.turnNotes, undefined);
  assert.ok(desk.requests[0]?.system?.includes('prefix_lookup answers from the record.'));
});
