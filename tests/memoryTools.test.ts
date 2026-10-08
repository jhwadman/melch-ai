/**
 * tests/memoryTools.test.ts — long-term memory's tools as the engine's own
 * (lib/tools/memoryTools.ts, ADR 0059) and the memory service on the
 * engine's MemoryService (lib/runtime/memoryService.ts, ADR 0052).
 *
 * Asserted:
 *   - On the ADK runtime the registry's load_memory and preload_memory leave
 *     the model's request exactly as ADK's LoadMemoryTool and
 *     PreloadMemoryTool left it: the same declaration, the same note, the
 *     same recalled block in the same place, the same result. Once tool by
 *     tool, and once through a whole turn (runSyndicateTurn) with each pair.
 *     As a FunctionTool, load_memory takes a require_approval gate.
 *   - Through the engine's own interface, with no ADK object in the path,
 *     the same tools read the same silo and write the same text.
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
import { Context, InMemorySessionService, LOAD_MEMORY, PRELOAD_MEMORY, LogLevel, setLogLevel } from '@google/adk';
import type { BaseMemoryService, LlmRequest } from '@google/adk';

import { namespacedMemoryService } from '../lib/memory/namespace.ts';
import { SupabaseVectorMemoryService } from '../lib/memory/supabaseMemoryService.ts';
import type { Embedder, MemoryExtractor } from '../lib/memory/providers.ts';
import type { FactRow, MemoryStore, NewFact } from '../lib/memory/store.ts';
import { contractToolDeclaration } from '../lib/models/schemaNormalize.ts';
import type { MemoryEntry, MemorySearchRequest, MemoryService } from '../lib/runtime/memoryService.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { registerTool, resolveTools } from '../lib/toolRegistry.ts';
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

setLogLevel(LogLevel.ERROR);

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

/** A memory service on ADK's interface that records every search it is asked. */
function recordingAdkMemory(memories: MemoryEntry[] | (() => never) = MEMORIES) {
  const searches: MemorySearchRequest[] = [];
  const service = {
    async searchMemory(request: MemorySearchRequest) {
      searches.push({ ...request });
      if (typeof memories === 'function') memories();
      return { memories: structuredClone(memories as MemoryEntry[]) };
    },
    async addSessionToMemory() {},
  };
  return { service: service as unknown as BaseMemoryService, searches };
}

/** An ADK Context for one request or call, over a session of `desk` / `scope-a`. */
function adkContext(opts: { memoryService?: BaseMemoryService; userContent?: unknown; functionCallId?: string } = {}): Context {
  const invocationContext = {
    invocationId: 'inv-1',
    userId: 'scope-a',
    appName: 'desk',
    session: { id: 's1', appName: 'desk', userId: 'scope-a', state: {}, events: [] },
    agent: { name: 'Boss' },
    userContent: opts.userContent,
    memoryService: opts.memoryService,
  };
  return new Context({ invocationContext: invocationContext as any, functionCallId: opts.functionCallId });
}

/** An empty request, optionally with an instruction and another tool already declared. */
function llmRequest(opts: { system?: string; declared?: boolean } = {}): LlmRequest {
  return {
    model: 'm',
    contents: [],
    config: {
      ...(opts.system ? { systemInstruction: opts.system } : {}),
      ...(opts.declared ? { tools: [{ functionDeclarations: [{ name: 'other', description: 'x' }] }] } : {}),
    },
    toolsDict: {},
    liveConnectConfig: {},
  } as unknown as LlmRequest;
}

/** What a request amounts to for the model: its config, and which tools it can call. */
function seen(request: LlmRequest) {
  return { config: structuredClone(request.config), callable: Object.keys(request.toolsDict).sort() };
}

const OWN_LOAD = resolveTools(['load_memory'])[0];
const OWN_PRELOAD = resolveTools(['preload_memory'])[0];

// ── The registry holds the engine's own tools ────────────────────────────────

test("the registry's memory tools are the engine's own", () => {
  assert.equal(toolOf(OWN_LOAD), loadMemoryTool);
  assert.notEqual(OWN_LOAD, LOAD_MEMORY);
  assert.equal(instructionToolOf(OWN_PRELOAD), preloadMemoryTool);
  assert.ok(isInstructionTool(preloadMemoryTool));
  assert.equal(toolOf(OWN_PRELOAD), undefined, 'preload_memory declares no function');
  assert.equal(contractToolDeclaration(OWN_PRELOAD), undefined);
  assert.equal(contractToolDeclaration(preloadMemoryTool), undefined, 'not as itself either');
});

// ── load_memory on the ADK runtime: what the model sees is ADK's ─────────────

test("load_memory declares exactly what ADK's LoadMemoryTool declared, on every path", () => {
  const adk = (LOAD_MEMORY as any)._getDeclaration();
  assert.deepEqual(OWN_LOAD._getDeclaration(), adk, 'the Gemini-dialect declaration, key order included');
  assert.equal(JSON.stringify(OWN_LOAD._getDeclaration()), JSON.stringify(adk));
  assert.deepEqual(loadMemoryTool.declaration(), contractToolDeclaration(LOAD_MEMORY), 'the model contract declaration');
  assert.deepEqual(contractToolDeclaration(OWN_LOAD), contractToolDeclaration(LOAD_MEMORY));
});

test("load_memory leaves the request as ADK's did: declared, and the memory note when the run has memory", async () => {
  for (const memory of [true, false]) {
    for (const system of [undefined, 'Answer from memory.']) {
      for (const declared of [false, true]) {
        const ctx = () => adkContext(memory ? { memoryService: recordingAdkMemory().service } : {});
        const theirs = llmRequest({ system, declared });
        const ours = llmRequest({ system, declared });
        await LOAD_MEMORY.processLlmRequest({ toolContext: ctx(), llmRequest: theirs });
        await OWN_LOAD.processLlmRequest({ toolContext: ctx(), llmRequest: ours });
        assert.deepEqual(seen(ours), seen(theirs), `memory=${memory} system=${system} declared=${declared}`);
      }
    }
  }
  const withMemory = llmRequest({ system: 'Base.' });
  await OWN_LOAD.processLlmRequest({ toolContext: adkContext({ memoryService: recordingAdkMemory().service }), llmRequest: withMemory });
  assert.equal(withMemory.config!.systemInstruction, `Base.\n\n${LOAD_MEMORY_INSTRUCTION}`);
});

test("a load_memory call returns what ADK's returned, from the same search", async () => {
  const theirs = recordingAdkMemory();
  const ours = recordingAdkMemory();
  const expected = await LOAD_MEMORY.runAsync({ args: { query: 'tea' }, toolContext: adkContext({ memoryService: theirs.service, functionCallId: 'c1' }) });
  const actual = await OWN_LOAD.runAsync({ args: { query: 'tea' }, toolContext: adkContext({ memoryService: ours.service, functionCallId: 'c1' }) });
  assert.deepEqual(actual, expected);
  assert.deepEqual(ours.searches, theirs.searches);
  assert.deepEqual(ours.searches, [{ appName: 'desk', userId: 'scope-a', query: 'tea' }]);
  assert.deepEqual((actual as any).memories[1], { content: 'part one part two', author: undefined, timestamp: undefined });
});

test('a load_memory failure carries the message ADK gave, inside FunctionTool\'s "Error in tool" wording', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    await assert.rejects(LOAD_MEMORY.runAsync({ args: { query: 'tea' }, toolContext: adkContext() }), { message: NO_MEMORY_SERVICE });
    await assert.rejects(OWN_LOAD.runAsync({ args: { query: 'tea' }, toolContext: adkContext() }), {
      message: `Error in tool 'load_memory': ${NO_MEMORY_SERVICE}`,
    });
    const failing = recordingAdkMemory(() => {
      throw new Error('Embedding failed (turns stay pending for retry): 429');
    });
    await assert.rejects(OWN_LOAD.runAsync({ args: { query: 'tea' }, toolContext: adkContext({ memoryService: failing.service }) }), {
      message: "Error in tool 'load_memory': Embedding failed (turns stay pending for retry): 429",
    });
  } finally {
    console.error = quiet;
  }
});

// ── preload_memory on the ADK runtime: the same block in the same place ─────

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
    for (const c of cases) {
      const theirs = recordingAdkMemory(c.memories);
      const ours = recordingAdkMemory(c.memories);
      const ctx = (m: ReturnType<typeof recordingAdkMemory>) =>
        adkContext({ ...(c.memory === false ? {} : { memoryService: m.service }), userContent: c.userContent });
      const theirRequest = llmRequest({ system: c.system });
      const ourRequest = llmRequest({ system: c.system });
      await PRELOAD_MEMORY.processLlmRequest({ toolContext: ctx(theirs), llmRequest: theirRequest });
      await OWN_PRELOAD.processLlmRequest({ toolContext: ctx(ours), llmRequest: ourRequest });
      assert.deepEqual(seen(ourRequest), seen(theirRequest), c.name);
      assert.deepEqual(ours.searches, theirs.searches, `${c.name}: the same search`);
    }
  } finally {
    console.warn = quiet;
  }
  const request = llmRequest({ system: 'Base.' });
  await OWN_PRELOAD.processLlmRequest({ toolContext: adkContext({ memoryService: recordingAdkMemory().service, userContent: hi }), llmRequest: request });
  assert.equal(
    request.config!.systemInstruction,
    'Base.\n\nThe following content is from your previous conversations with the user.\n'
      + "They may be useful for answering the user's current query.\n<PAST_CONVERSATIONS>\n"
      + 'Time: 2026-10-01T09:00:00.000Z\n'
      + 'memory_service: [PREFERENCE | date: 2026-10-01 | source: user | status: active | keys: tea] The user prefers green tea.\n'
      + 'part one part two\n'
      + 'Time: 2026-09-30T08:00:00.000Z\n'
      + '</PAST_CONVERSATIONS>\n',
  );
});

// ── A whole turn on the ADK runtime, with ADK's tools and with ours ─────────

/** A long-term syndicate whose one agent preloads, then calls load_memory once. */
const MEMORY_CONFIG = {
  syndicate_name: 'Desk',
  memory_system: 'long-term',
  orchestrator: { name: 'Desk', model: 'scripted/desk', instruction: 'Answer from memory.', tools: ['preload_memory', 'load_memory'] },
  subagents: [],
} as unknown as SyndicateYamlConfig;

/** One turn: what the model was sent on each call, what was searched, and what the session stored. */
async function memoryTurn() {
  const sent: Array<{ system: unknown; tools: unknown }> = [];
  const desk = new ScriptedLlm('scripted/desk', (req, n) => {
    sent.push({ system: req.config?.systemInstruction, tools: structuredClone(req.config?.tools) });
    return n === 1 ? call('load_memory', { query: 'tea' }) : text('Green tea.');
  });
  const memory = recordingAdkMemory();
  const sessionService = new InMemorySessionService();
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
  const session = await sessionService.getSession({ appName: 'desk.a1', userId: 'scope-a', sessionId: 's1' });
  const responses = (session?.events ?? [])
    .flatMap((e) => e.content?.parts ?? [])
    .filter((p) => p.functionResponse)
    .map((p) => ({ name: p.functionResponse!.name, response: p.functionResponse!.response }));
  return { status: result.status, text: result.text, sent, searches: memory.searches, responses };
}

test("a turn on the ADK runtime runs the same with the engine's memory tools as with ADK's", async () => {
  const ours = await memoryTurn();
  assert.equal(ours.status, 'completed');
  assert.equal(ours.sent.length, 2);
  assert.match(String(ours.sent[0].system), /<PAST_CONVERSATIONS>[\s\S]*green tea[\s\S]*<\/PAST_CONVERSATIONS>/);
  assert.ok(String(ours.sent[0].system).includes(LOAD_MEMORY_INSTRUCTION));
  assert.equal(ours.responses.length, 1);
  assert.equal((ours.responses[0].response as any).memories.length, MEMORIES.length);
  for (const s of ours.searches) assert.equal(s.appName, 'desk.a1', 'every search is pinned to the namespace');

  // The same turn with ADK's own tools registered under the same names.
  registerTool('load_memory', LOAD_MEMORY, { override: true });
  registerTool('preload_memory', PRELOAD_MEMORY, { override: true });
  try {
    const theirs = await memoryTurn();
    assert.deepEqual(ours, theirs);
  } finally {
    registerTool('load_memory', loadMemoryTool, { override: true });
    registerTool('preload_memory', preloadMemoryTool, { override: true });
  }
  assert.equal(toolOf(resolveTools(['load_memory'])[0]), loadMemoryTool);
  assert.equal(instructionToolOf(resolveTools(['preload_memory'])[0]), preloadMemoryTool);
});

test('require_approval gates load_memory as it gates any registry function tool', async () => {
  const desk = new ScriptedLlm('scripted/desk', (_req, n) => (n === 1 ? call('load_memory', { query: 'tea' }) : text('x')));
  const memory = recordingAdkMemory();
  const config = structuredClone(MEMORY_CONFIG) as any;
  config.orchestrator.require_approval = ['load_memory'];
  const r = await runSyndicateTurn({
    config,
    parts: [{ text: 'what tea do I like?' }],
    appName: 'desk.a1',
    userId: 'scope-a',
    sessionId: 's1',
    sessionService: new InMemorySessionService(),
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

  // The ADK name reaches the same logic and returns the same JSON.
  const viaAdk = await quietly(() => (pinned as unknown as BaseMemoryService).searchMemory({ appName: 'Scout', userId: 'scope-a', query: 'which tea?' }));
  assert.deepEqual(viaAdk, found);

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

  // load_memory: the same result shape the ADK path returns.
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

  // The same block ADK's PreloadMemoryTool writes from the same memories.
  const adkRequest = llmRequest();
  await PRELOAD_MEMORY.processLlmRequest({
    toolContext: adkContext({ memoryService: recordingAdkMemory(recalled.memories).service, userContent: asked }),
    llmRequest: adkRequest,
  });
  assert.equal(adkRequest.config!.systemInstruction, block);
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
  assert.ok(runtimeImportsOf('lib/tools/adkTool.ts').some((s) => s.includes('@google/adk')), 'control: the boundary module does');
});
