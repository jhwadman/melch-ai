/**
 * tests/memoryTools.test.ts — long-term memory's tools as the engine's own
 * (lib/tools/memoryTools.ts, ADR 0059) and the memory service on the
 * engine's MemoryService (lib/runtime/memoryService.ts, ADR 0052).
 *
 * Asserted:
 *   - The registry's load_memory and preload_memory say what ADK 2.2's
 *     LoadMemoryTool and PreloadMemoryTool said (recorded in
 *     tests/fixtures/adk-reference/memorytools): the same declaration, the
 *     same note, the same recalled block in the same place, the same result
 *     from the same search. Once tool by tool, and once through a whole turn
 *     (runSyndicateTurn). load_memory takes a require_approval gate.
 *   - ADR 0020's contract through MemoryService: facts filed under
 *     `<namespace>/<userId>`, a subagent pinned to the root namespace, one
 *     user never reading another's silo, erase and retention.
 *   - memoryTools.ts loads nothing from @google/* at runtime.
 *
 * Offline: scripted models, a fake store and a fake embedder.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { namespacedMemoryService } from '../lib/memory/namespace.ts';
import { SupabaseVectorMemoryService } from '../lib/memory/supabaseMemoryService.ts';
import type { Embedder, MemoryExtractor } from '../lib/memory/providers.ts';
import type { FactRow, MemoryStore, NewFact } from '../lib/memory/store.ts';
import { contractToolDeclaration } from '../lib/models/schemaNormalize.ts';
import type { MemoryEntry, MemorySearchRequest, MemoryService } from '../lib/runtime/memoryService.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { resolveTools } from '../lib/toolRegistry.ts';
import {
  LOAD_MEMORY_INSTRUCTION,
  NO_MEMORY_SERVICE,
  loadMemoryTool,
  preloadMemoryInstruction,
  preloadMemoryTool,
} from '../lib/tools/memoryTools.ts';
import { createToolContext, instructionToolOf, isInstructionTool, toolOf } from '../lib/tools/tool.ts';
import { ROOT, runtimeImportsOf } from './helpers/importGraph.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';
import { adkReferences } from './helpers/adkReference.ts';

// ADK 2.2's LoadMemoryTool / PreloadMemoryTool and the all-ADK turn are recorded
// (tests/fixtures/adk-reference/memorytools).
const reference = adkReferences('memoryTools');
/** A plain JSON copy: what a recorded reference can hold (undefined-valued keys dropped). */
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Recalled memories covering every branch of ADK's formatting. */
const MEMORIES: MemoryEntry[] = [
  {
    content: { role: 'user', parts: [{ text: '[PREFERENCE | date: 2026-10-01 | source: user | status: active | keys: tea] The user prefers green tea.' }] },
    author: 'memory_service',
    timestamp: '2026-10-01T09:00:00.000Z',
  },
  // No author, no timestamp, two text parts.
  { content: { role: 'user', parts: [{ text: 'part one' }, { text: 'part two' }] } },
  // A part without text counts as empty; a time with no text keeps its line.
  { content: { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] }, author: 'memory_service', timestamp: '2026-09-30T08:00:00.000Z' },
  // No parts at all.
  { content: { role: 'user' }, author: 'someone' },
];

/** A memory service on the engine's interface that records every search it is asked. */
function recordingMemory(memories: MemoryEntry[] | (() => never) = MEMORIES) {
  const searches: MemorySearchRequest[] = [];
  const service: MemoryService = {
    async search(request: MemorySearchRequest) {
      searches.push({ ...request });
      if (typeof memories === 'function') memories();
      return { memories: structuredClone(memories as MemoryEntry[]) };
    },
    async ingest() {},
  };
  return { service, searches };
}

/** The engine's tool context for one request or call, over a session of `desk` / `scope-a`. */
function toolContext(opts: { memory?: MemoryService; userContent?: unknown; functionCallId?: string } = {}) {
  return createToolContext({
    invocationId: 'inv-1',
    userId: 'scope-a',
    appName: 'desk',
    sessionId: 's1',
    agentName: 'Boss',
    ...(opts.functionCallId ? { functionCallId: opts.functionCallId } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.userContent ? { userContent: opts.userContent as any } : {}),
  });
}

/** An instruction with a tool's text appended after a blank line, as the request builder (and ADK) appends it. */
const withInstruction = (system: string | undefined, written: string | undefined): string | undefined =>
  written ? (system ? `${system}\n\n${written}` : written) : system;

const OWN_LOAD = resolveTools(['load_memory'])[0];
const OWN_PRELOAD = resolveTools(['preload_memory'])[0];

// ── The registry holds the engine's own tools ────────────────────────────────

test("the registry's memory tools are the engine's own", async () => {
  assert.equal(toolOf(OWN_LOAD), loadMemoryTool);
  assert.equal(instructionToolOf(OWN_PRELOAD), preloadMemoryTool);
  assert.ok(isInstructionTool(preloadMemoryTool));
  assert.equal(toolOf(OWN_PRELOAD), undefined, 'preload_memory declares no function');
  assert.equal(contractToolDeclaration(OWN_PRELOAD), undefined);
  assert.equal(contractToolDeclaration(preloadMemoryTool), undefined, 'not as itself either');
});

// ── load_memory: what the model sees is what ADK's tool showed it ────────────

test("load_memory declares exactly what ADK's LoadMemoryTool declared", async () => {
  const adk = await reference<{ gemini: string; contract: unknown }>('load-memory-declaration');
  assert.deepEqual(loadMemoryTool.declaration(), adk.contract, 'the model contract declaration');
  assert.deepEqual(contractToolDeclaration(OWN_LOAD), adk.contract);
  // ADK sent it in the Gemini dialect; the name and description are the same words.
  const gemini = JSON.parse(adk.gemini) as { name: string; description: string };
  assert.equal(gemini.name, loadMemoryTool.declaration().name);
  assert.equal(gemini.description, loadMemoryTool.declaration().description);
});

test("load_memory says what ADK's did: declared, and the memory note when the run has memory", async () => {
  const variants = [true, false].flatMap((memory) =>
    [undefined, 'Answer from memory.'].flatMap((system) => [false, true].map((declared) => ({ memory, system, declared, label: `memory=${memory} system=${system} declared=${declared}` }))),
  );
  // What ADK's LoadMemoryTool left of each request.
  const theirs = await reference<Array<{ label: string; seen: { config: any; callable: string[] } }>>('load-memory-request');
  assert.deepEqual(theirs.map((t) => t.label), variants.map((v) => v.label), 'one recorded request per variant');
  for (const [i, { memory, system, label }] of variants.entries()) {
    const note = await loadMemoryTool.instruction!(toolContext(memory ? { memory: recordingMemory().service } : {}));
    const recorded = theirs[i]!.seen;
    assert.equal(withInstruction(system, note), recorded.config.systemInstruction, `${label}: the instruction`);
    assert.deepEqual(recorded.callable, ['load_memory'], `${label}: callable`);
    const declared = (recorded.config.tools as Array<{ functionDeclarations: Array<{ name: string; description?: string }> }>)
      .flatMap((t) => t.functionDeclarations)
      .find((d) => d.name === 'load_memory');
    assert.equal(declared?.description, loadMemoryTool.declaration().description, `${label}: declared`);
  }
  assert.equal(withInstruction('Base.', await loadMemoryTool.instruction!(toolContext({ memory: recordingMemory().service }))), `Base.\n\n${LOAD_MEMORY_INSTRUCTION}`);
});

test("a load_memory call returns what ADK's returned, from the same search", async () => {
  // ADK's result and the search it made.
  const theirs = await reference<{ result: unknown; searches: MemorySearchRequest[] }>('load-memory-call');
  const ours = recordingMemory();
  const actual = await loadMemoryTool.execute({ query: 'tea' }, toolContext({ memory: ours.service, functionCallId: 'c1' }));
  assert.deepEqual(asJson(actual), theirs.result);
  assert.deepEqual(ours.searches, theirs.searches);
  assert.deepEqual(ours.searches, [{ appName: 'desk', userId: 'scope-a', query: 'tea' }]);
  assert.deepEqual((actual as any).memories[1], { content: 'part one part two', author: undefined, timestamp: undefined });
});

test('a load_memory failure carries the message ADK gave', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    // ADK's LoadMemoryTool without a memory service: the message it rejected with.
    const adkFailure = await reference<{ rejected: boolean; message?: string }>('load-memory-failure');
    assert.deepEqual(adkFailure, { rejected: true, message: NO_MEMORY_SERVICE });
    await assert.rejects(loadMemoryTool.execute({ query: 'tea' }, toolContext()), { message: NO_MEMORY_SERVICE });
    const failing = recordingMemory(() => {
      throw new Error('Embedding failed (turns stay pending for retry): 429');
    });
    await assert.rejects(loadMemoryTool.execute({ query: 'tea' }, toolContext({ memory: failing.service })), {
      message: 'Embedding failed (turns stay pending for retry): 429',
    });
  } finally {
    console.error = quiet;
  }
});

// ── preload_memory: the same block in the same place ────────────────────────

test("preload_memory writes ADK's PreloadMemoryTool's block, word for word, in every case", async () => {
  const hi = { role: 'user', parts: [{ text: 'what tea do I like?' }] };
  const cases: Array<{ name: string; memories?: MemoryEntry[] | (() => never); memory?: boolean; userContent?: unknown; system?: string }> = [
    { name: 'recalled facts after the instruction', userContent: hi, system: 'Answer from memory.' },
    { name: 'recalled facts as the whole instruction', userContent: hi },
    { name: 'no memory service', userContent: hi, memory: false, system: 'Base.' },
    { name: 'no user content', system: 'Base.' },
    { name: 'a first part without text', userContent: { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }, { text: 'hi' }] } },
    { name: 'nothing recalled', userContent: hi, memories: [] },
    { name: 'recalled entries without text or time', userContent: hi, memories: [{ content: { role: 'user', parts: [{ text: '' }] } }] },
    { name: 'a failed search', userContent: hi, system: 'Base.', memories: () => { throw new Error('boom'); } },
  ];
  const quiet = console.warn;
  console.warn = () => {};
  try {
    // What ADK's PreloadMemoryTool left of each request, and what it searched.
    const recorded = await reference<Array<{ name: string; seen: { config: any; callable: string[] }; searches: MemorySearchRequest[] }>>('preload-memory-block');
    assert.deepEqual(recorded.map((r) => r.name), cases.map((c) => c.name), 'one recorded request per case');
    for (const [i, c] of cases.entries()) {
      const ours = recordingMemory(c.memories);
      const block = await preloadMemoryTool.instruction(toolContext({ ...(c.memory === false ? {} : { memory: ours.service }), userContent: c.userContent }));
      assert.equal(withInstruction(c.system, block), recorded[i]!.seen.config.systemInstruction, c.name);
      assert.deepEqual(recorded[i]!.seen.callable, [], `${c.name}: nothing callable`);
      assert.deepEqual(asJson(ours.searches), recorded[i]!.searches, `${c.name}: the same search`);
    }
  } finally {
    console.warn = quiet;
  }
  const block = await preloadMemoryTool.instruction(toolContext({ memory: recordingMemory().service, userContent: hi }));
  assert.equal(
    withInstruction('Base.', block),
    'Base.\n\nThe following content is from your previous conversations with the user.\n'
      + "They may be useful for answering the user's current query.\n<PAST_CONVERSATIONS>\n"
      + 'Time: 2026-10-01T09:00:00.000Z\n'
      + 'memory_service: [PREFERENCE | date: 2026-10-01 | source: user | status: active | keys: tea] The user prefers green tea.\n'
      + 'part one part two\n'
      + 'Time: 2026-09-30T08:00:00.000Z\n'
      + '</PAST_CONVERSATIONS>\n',
  );
});

// ── A whole turn ─────────────────────────────────────────────────────────────

/** A long-term syndicate whose one agent preloads, then calls load_memory once. */
const MEMORY_CONFIG = {
  syndicate_name: 'Desk',
  memory_system: 'long-term',
  orchestrator: { name: 'Desk', model: 'scripted/desk', instruction: 'Answer from memory.', tools: ['preload_memory', 'load_memory'] },
  subagents: [],
} as unknown as SyndicateYamlConfig;

/** One turn: what the model was sent on each call, what was searched, and what the session stored. */
async function memoryTurn() {
  const sessionService = new InProcessSessionService();
  const sent: Array<{ system: unknown; tools: unknown }> = [];
  const desk = new ScriptedLlm('scripted/desk', (req, n) => {
    sent.push({ system: req.config?.systemInstruction, tools: structuredClone(req.config?.tools) });
    return n === 1 ? call('load_memory', { query: 'tea' }) : text('Green tea.');
  });
  const memory = recordingMemory();
  const result = await runSyndicateTurn({
    config: MEMORY_CONFIG,
    parts: [{ text: 'what tea do I like?' }],
    appName: 'desk.a1',
    userId: 'scope-a',
    sessionId: 's1',
    sessionService,
    memoryService: namespacedMemoryService(memory.service, 'desk.a1'),
    compile: { resolveModel: scriptedResolver({ desk }) },
    trace: false,
  });
  const session = await sessionService.get({ appName: 'desk.a1', userId: 'scope-a', sessionId: 's1' });
  const responses = (session?.events ?? [])
    .flatMap((e) => e.content?.parts ?? [])
    .filter((p) => p.functionResponse)
    .map((p) => ({ name: p.functionResponse!.name, response: p.functionResponse!.response }));
  return { status: result.status, text: result.text, sent, searches: memory.searches, responses };
}

test("a turn recalls with the engine's memory tools as the recorded ADK turn did: the block, the search, the result", async () => {
  const run = await memoryTurn();
  assert.equal(run.status, 'completed');
  assert.equal(run.sent.length, 2);
  assert.match(String(run.sent[0].system), /<PAST_CONVERSATIONS>[\s\S]*green tea[\s\S]*<\/PAST_CONVERSATIONS>/);
  assert.ok(String(run.sent[0].system).includes(LOAD_MEMORY_INSTRUCTION));
  assert.equal(run.responses.length, 1);
  assert.equal((run.responses[0].response as any).memories.length, MEMORIES.length);
  for (const s of run.searches) assert.equal(s.appName, 'desk.a1', 'every search is pinned to the namespace');

  // The all-ADK turn (ADK 2.2's runtime and session store), recorded.
  const onAdk = await reference<Awaited<ReturnType<typeof memoryTurn>>>('turn-on-adk');
  assert.equal(run.text, onAdk.text);
  assert.deepEqual(run.sent.map((s) => s.system), onAdk.sent.map((s) => s.system), 'the instruction, preloaded block and memory note');
  assert.deepEqual(run.searches, onAdk.searches);
  assert.deepEqual(asJson(run.responses), onAdk.responses);
});

test('require_approval gates load_memory as it gates any registry function tool', async () => {
  const desk = new ScriptedLlm('scripted/desk', (_req, n) => (n === 1 ? call('load_memory', { query: 'tea' }) : text('x')));
  const memory = recordingMemory();
  const config = structuredClone(MEMORY_CONFIG) as any;
  config.orchestrator.require_approval = ['load_memory'];
  const r = await runSyndicateTurn({
    config,
    parts: [{ text: 'what tea do I like?' }],
    appName: 'desk.a1',
    userId: 'scope-a',
    sessionId: 's1',
    sessionService: new InProcessSessionService(),
    memoryService: memory.service,
    compile: { resolveModel: scriptedResolver({ desk }) },
    trace: false,
  });
  assert.equal(r.status, 'input-required');
  assert.equal(r.approval?.tool, 'load_memory');
  assert.deepEqual(r.approval?.args, { query: 'tea' });
  assert.deepEqual(memory.searches.filter((s) => s.query === 'tea'), [], 'nothing is recalled before the approval');
});

// ── The engine's own interface, with no ADK object in the path ──────────────

/** A 768-d embedding: identical for the same statement (its header ignored), near-orthogonal otherwise. */
function vec(textIn: string): number[] {
  const v = new Array(768).fill(0);
  let h = 2166136261;
  for (const ch of textIn.replace(/^\[[^\]]*\]\s*/, '').toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  v[h % 768] = 1;
  v[(h >>> 10) % 768] += 0.5;
  return v;
}
const embedder: Embedder = { provider: 'fake', model: 'fake', dimensions: 768, embed: async (t) => t.map(vec) };
const extractor = (lines: string): MemoryExtractor => ({ model: 'fake', extract: async () => lines });

/** A MemoryStore in process: the five operations, the atomic commit, the marker and the prune. */
function storeInProcess() {
  type Row = NewFact & { id: string; created_at: string; superseded_by?: string };
  const rows: Row[] = [];
  const markers = new Map<string, number>();
  const pruned: Array<[string, number]> = [];
  const cos = (a: number[], b: number[]) => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) ((dot += a[i] * b[i]), (na += a[i] * a[i]), (nb += b[i] * b[i]));
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };
  const insert = async (newRows: NewFact[]) =>
    newRows.map((r) => {
      const row = { ...r, id: `f${rows.length + 1}`, created_at: `2026-10-0${Math.min(rows.length + 1, 9)}T00:00:00.000Z` };
      rows.push(row);
      return { id: row.id, fact: row.fact };
    });
  const retire = async (userKey: string, id: string, by: string) => {
    const row = rows.find((r) => r.id === id && r.user_key === userKey);
    if (row) ((row.status = 'superseded'), (row.superseded_by = by));
  };
  const store: MemoryStore = {
    async existingFacts(userKey, facts) {
      return new Set(rows.filter((r) => r.user_key === userKey && facts.includes(r.fact)).map((r) => r.fact));
    },
    async match(userKey, embedding, count): Promise<FactRow[]> {
      return rows
        .filter((r) => r.user_key === userKey)
        .map((r) => ({ ...r, similarity: cos(r.embedding, embedding) }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, count);
    },
    insert,
    retire,
    async deleteUser(userKey) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_key === userKey) rows.splice(i, 1);
      return before - rows.length;
    },
    async commit(userKey, marker, newRows, retiring) {
      const inserted = await insert(newRows);
      for (const r of retiring) await retire(userKey, r.id, inserted.find((i) => i.fact === r.byFact)!.id);
      if (marker) markers.set(`${userKey}::${marker.sessionId}`, marker.events);
      return inserted;
    },
    async ingestedEvents(userKey, sessionId) {
      return markers.get(`${userKey}::${sessionId}`) ?? 0;
    },
    async embeddingDimensions() {
      return 768;
    },
    async pruneNamespace(namespace, days) {
      pruned.push([namespace, days]);
      return 2;
    },
  };
  return { store, rows, markers, pruned };
}

function engineService(lines: string, store: MemoryStore): MemoryService & SupabaseVectorMemoryService {
  const quiet = console.log;
  console.log = () => {};
  try {
    return new SupabaseVectorMemoryService({ apiKey: '', extractor: extractor(lines), embedder }, store);
  } finally {
    console.log = quiet;
  }
}

/** A session in the engine's own shape. */
function session(id: string, appName: string, userId: string, said = 'I prefer green tea.') {
  return {
    id,
    appName,
    userId,
    state: {},
    lastUpdateTime: 1,
    events: [
      { id: 'e1', invocationId: 'i1', author: 'user', timestamp: 1, actions: {}, content: { role: 'user', parts: [{ text: said }] } },
      { id: 'e2', invocationId: 'i1', author: 'Desk', timestamp: 2, actions: {}, content: { role: 'model', parts: [{ text: 'Noted.' }] } },
    ],
  };
}

const TEA = '[PREFERENCE | date: 2026-10-01 | source: user | status: active | keys: tea] The user prefers green tea.';

/** Runs `fn` with the service's console lines silenced. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

test('MemoryService: ingest files facts under <namespace>/<userId>, and search reads that silo alone', async () => {
  const { store, rows, markers } = storeInProcess();
  const memory = engineService(TEA, store);
  const pinned = namespacedMemoryService<MemoryService>(memory, 'desk.a1');

  // A DELEGATE subagent ingests and searches under its own agent name; the pin files and reads under the root's.
  await quietly(() => pinned.ingest(session('s1', 'Scout', 'scope-a'), { extractionRules: 'Never store a quote.' }));
  assert.deepEqual(rows.map((r) => [r.user_key, r.fact]), [['desk.a1/scope-a', TEA]]);
  assert.equal(markers.get('desk.a1/scope-a::s1'), 2, 'the marker advanced with the facts');

  const found = await quietly(() => pinned.search({ appName: 'Scout', userId: 'scope-a', query: 'which tea?' }));
  assert.equal(found.memories.length, 1);
  assert.deepEqual(found.memories[0].content, { role: 'user', parts: [{ text: TEA }] });
  assert.equal(found.memories[0].author, 'memory_service');

  const other = await quietly(() => pinned.search({ appName: 'Scout', userId: 'scope-b', query: 'which tea?' }));
  assert.deepEqual(other.memories, [], "another user's silo holds nothing of this user's");
  const unpinned = await quietly(() => memory.search({ appName: 'Scout', userId: 'scope-a', query: 'which tea?' }));
  assert.deepEqual(unpinned.memories, [], 'without the pin a subagent name is its own (empty) silo');

  // A second ingestion of the same turns distils nothing new.
  await quietly(() => pinned.ingest(session('s1', 'Scout', 'scope-a')));
  assert.equal(rows.length, 1);
});

test('MemoryService: erase, retention and the dimension check keep the A2A server\'s names', async () => {
  const { store, rows, pruned } = storeInProcess();
  const memory = engineService(TEA, store);
  const pinned = namespacedMemoryService<MemoryService>(memory, 'desk.a1');
  await quietly(() => pinned.ingest(session('s1', 'Desk', 'scope-a')));
  await quietly(() => pinned.ingest(session('s2', 'Desk', 'scope-b', 'I prefer black tea.')));
  assert.equal(rows.length, 2);

  assert.equal(await quietly(() => pinned.deleteUserMemory!('desk.a1/scope-a')), 1, 'erase names its key; the pin leaves it alone');
  assert.deepEqual(rows.map((r) => r.user_key), ['desk.a1/scope-b'], "only that user's facts");
  assert.deepEqual((await quietly(() => pinned.search({ appName: 'Desk', userId: 'scope-a', query: 'tea' }))).memories, []);

  assert.equal(await quietly(() => pinned.pruneExpired!('desk.a1', 30)), 2);
  assert.deepEqual(pruned, [['desk.a1', 30]], 'retention names its namespace; the pin leaves it alone');
  await pinned.verifyEmbeddingDimensions!();

  const noPrune = engineService(TEA, { ...store, pruneNamespace: undefined });
  assert.equal(await noPrune.pruneExpired('desk.a1', 30), null, 'a store that cannot prune says so');
});

test('the memory tools run on the engine interface alone, reading the run\'s own silo', async () => {
  const { store } = storeInProcess();
  const memory = namespacedMemoryService<MemoryService>(engineService(TEA, store), 'desk.a1');
  await quietly(() => memory.ingest(session('s1', 'Desk', 'scope-a')));

  const asked = { role: 'user', parts: [{ text: 'which tea do I like?' }] };
  const ctx = (userId: string) => createToolContext({ appName: 'Scout', userId, sessionId: 's2', memory, userContent: asked });

  // load_memory: the result shape ADK's LoadMemoryTool returned.
  const loaded = (await quietly(() => loadMemoryTool.execute({ query: 'tea' }, ctx('scope-a')))) as any;
  assert.equal(loaded.memories.length, 1);
  assert.equal(loaded.memories[0].content, TEA);
  assert.equal(loaded.memories[0].author, 'memory_service');
  assert.deepEqual(await quietly(() => loadMemoryTool.execute({ query: 'tea' }, ctx('scope-b'))), { memories: [] }, 'another user recalls nothing');
  assert.equal(await loadMemoryTool.instruction!(ctx('scope-a')), LOAD_MEMORY_INSTRUCTION);

  // Arguments are validated before any search.
  assert.match(String(await loadMemoryTool.execute({}, ctx('scope-a'))), /^Error: invalid arguments for load_memory: query/);

  // preload_memory: the block ADK's tool would write for these memories.
  const recalled = await quietly(() => memory.search({ appName: 'Desk', userId: 'scope-a', query: 'which tea do I like?' }));
  const block = await quietly(() => preloadMemoryTool.instruction(ctx('scope-a')));
  assert.equal(block, preloadMemoryInstruction(recalled.memories));
  assert.match(block!, /<PAST_CONVERSATIONS>\nTime: .*\nmemory_service: \[PREFERENCE[^\n]*green tea\.\n<\/PAST_CONVERSATIONS>\n$/);
  assert.equal(await quietly(() => preloadMemoryTool.instruction(ctx('scope-b'))), undefined, 'nothing recalled, nothing written');

  // The same block ADK's PreloadMemoryTool wrote from the same memories (recorded).
  const adkBlock = await reference<string | null>('preload-memory-engine-memories');
  assert.equal(adkBlock, block);
});

test('without memory, or without knowing whose, the tools recall nothing and say why', async () => {
  const none = createToolContext({ appName: 'desk', userId: 'scope-a', userContent: { role: 'user', parts: [{ text: 'hi' }] } });
  assert.equal(none.searchMemory, undefined);
  await assert.rejects(loadMemoryTool.execute({ query: 'tea' }, none), { message: NO_MEMORY_SERVICE });
  assert.equal(await loadMemoryTool.instruction!(none), undefined, 'a run without memory is not told it has some');
  assert.equal(await preloadMemoryTool.instruction(none), undefined);

  let searched = false;
  const memory = { search: async () => ((searched = true), { memories: MEMORIES }) };
  const anonymous = createToolContext({ appName: 'desk', memory });
  await assert.rejects(anonymous.searchMemory!('tea'), /needs the app name and user id/);
  assert.equal(searched, false, 'no search under an unknown user');

  const bound = createToolContext({ appName: 'desk', userId: 'scope-a', memory: { search: async (r) => ((searched = true), assert.deepEqual(r, { appName: 'desk', userId: 'scope-a', query: 'tea' }), { memories: [] }) } });
  await bound.searchMemory!('tea');
  assert.equal(searched, true);
});

// ── No ADK in the memory tools ───────────────────────────────────────────────

/** Every module `entry` loads at run time, with the specifiers each names. */
function runtimeGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [path.resolve(ROOT, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (graph.has(file)) continue;
    const specs = runtimeImportsOf(path.relative(ROOT, file)).map((s) => /['"]([^'"]+)['"]\s*$/.exec(s)![1]);
    graph.set(file, specs);
    for (const s of specs) if (s.startsWith('.')) pending.push(path.resolve(path.dirname(file), s));
  }
  return graph;
}

test('memoryTools.ts loads nothing from @google/* at runtime', () => {
  const graph = runtimeGraph('lib/tools/memoryTools.ts');
  const packages = [...new Set([...graph.values()].flat().filter((s) => !s.startsWith('.')))].sort();
  assert.deepEqual(packages, ['zod']);
  assert.ok(!packages.some((s) => s.startsWith('@google/')), 'no @google/ package');
  assert.ok(runtimeImportsOf('lib/models/geminiAdapter.ts').some((s) => s.includes("'@google/genai'")), 'control: the Gemini adapter does load @google/genai');
});
