/**
 * Cross-agent transcript sharing — fully offline, no API keys, no network.
 *
 * These assertions are written against a real production failure. Session
 * `discord-…-5787e017` (2026-08-15) held a complete four-turn thread across
 * three routes, and replaying it through ADK's own content processor showed
 * the Conversationalist receiving 118,013 bytes in which EVERY content had
 * `role: "user"` — the previous routes' answers, their private chain-of-
 * thought, and 35 KB of raw tool JSON, all indistinguishable from something
 * the human had typed. The session was shared; the conversation was not.
 *
 * The last cases run a two-route conversation through runSyndicateTurn on
 * both runtimes (tests/helpers/runtime.ts): the next route must read the
 * previous route's answer the same way on each, and across them.
 *
 * So the load-bearing assertion below is the boring one: a past agent turn
 * must come out as `role: "model"`. Everything else follows from it.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { InMemorySessionService } from '@google/adk';
import type { Event } from '@google/adk';
import { ProjectedSessionService, projectTranscript, renderTranscriptDigest, trimEventForStorage } from '../lib/session/transcript.ts';
import { SupabaseSessionService } from '../lib/session/supabaseSessionService.ts';
import { asSessionService } from '../lib/runtime/adkSessionBridge.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import type { TurnEvent, TurnEventInit } from '../lib/runtime/events.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import type { SessionService } from '../lib/runtime/sessions.ts';
import { fakeSupabase } from './helpers/fakeSupabase.ts';
import { z } from 'zod';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import { acrossRuntimes, forEachRuntime, runtimeOption } from './helpers/runtime.ts';
import type { RuntimeName } from './helpers/runtime.ts';

const user = (text: string): Event => ({ author: 'user', content: { role: 'user', parts: [{ text }] } } as Event);
const agent = (author: string, parts: unknown[]): Event =>
  ({ author, content: { role: 'model', parts } } as Event);

/** The shape the 2026-08-15 session actually stored. */
const THREAD: Event[] = [
  user('[System Context: Current Date is August 15, 2026] Should I buy MU on Monday?'),
  agent('Analyst', [
    { text: '**My Micron Monday Decision Strategy** Okay, so the question is…', thought: true },
    { functionCall: { name: 'load_memory', args: { query: 'MU' } } },
  ]),
  agent('Analyst', [
    { functionResponse: { name: 'load_memory', response: { memories: 'x'.repeat(23_000) } } },
  ]),
  agent('Analyst', [{ text: 'MU: accumulate under $130. Stop at $118.' }]),
  user('[System Context: Current Date is August 15, 2026] You are neglecting AI and security.'),
];

test('a past agent turn survives as a model turn, not as user text', () => {
  const projected = projectTranscript(THREAD, 'Conversationalist');
  const answer = projected.find(e => (e.content?.parts?.[0] as { text?: string })?.text?.includes('accumulate under $130'));
  assert.ok(answer, 'the previous route’s answer must reach the next route');
  assert.equal(answer!.content!.role, 'model');
});

test('a foreign turn is re-authored to the running agent so ADK keeps it as a model turn', () => {
  // ADK's getContents rewrites any event whose author differs from the
  // running agent into `role: "user"` prefixed "For context:". Re-authoring
  // is the whole mechanism — if this regresses, the prompt silently flattens.
  for (const event of projectTranscript(THREAD, 'Conversationalist')) {
    if (event.author !== 'user') assert.equal(event.author, 'Conversationalist');
  }
});

test('the speaking desk stays visible as a label', () => {
  const projected = projectTranscript(THREAD, 'Conversationalist');
  const answer = projected.find(e => (e.content?.parts?.[0] as { text?: string })?.text?.includes('accumulate'));
  assert.match((answer!.content!.parts![0] as { text: string }).text, /^\[Analyst\] /);
});

test('an agent reading its own past turns sees them unlabelled', () => {
  const projected = projectTranscript(THREAD, 'Analyst');
  const answer = projected.find(e => (e.content?.parts?.[0] as { text?: string })?.text?.includes('accumulate'));
  assert.equal((answer!.content!.parts![0] as { text: string }).text, 'MU: accumulate under $130. Stop at $118.');
});

test('private reasoning never reaches the next route', () => {
  // ADK's convertForeignEvent clones unrecognised parts verbatim, which put
  // the previous route's `thought: true` monologue into the prompt as USER
  // speech. Nothing carrying it may survive projection.
  const dumped = JSON.stringify(projectTranscript(THREAD, 'Conversationalist'));
  assert.ok(!dumped.includes('My Micron Monday Decision Strategy'));
  assert.ok(!dumped.includes('"thought"'));
});

test('tool calls and their payloads are dropped together', () => {
  const dumped = JSON.stringify(projectTranscript(THREAD, 'Conversationalist'));
  assert.ok(!dumped.includes('load_memory'));
  assert.ok(!dumped.includes('xxxxx'), 'a 23 KB tool payload must not be inlined into the prompt');
  // Dropping a call without its response (or the reverse) would leave ADK's
  // function-response pairing with a widowed half, which throws.
  assert.ok(!dumped.includes('functionCall') && !dumped.includes('functionResponse'));
});

test('user turns pass through untouched', () => {
  const projected = projectTranscript(THREAD, 'Conversationalist');
  const first = projected[0];
  assert.equal(first.author, 'user');
  assert.equal(first.content!.role, 'user');
});

test('camelCase toolCall/toolResponse parts are dropped too', () => {
  // Some providers emit these; ADK's `part.functionCall` checks miss them, so
  // they survived its conversion as empty noise.
  const events = [agent('XScout', [{ toolCall: { name: 'x_search' }, thoughtSignature: 'sig' }])];
  assert.deepEqual(projectTranscript(events, 'Conversationalist'), []);
});

test('an event that said nothing out loud disappears', () => {
  const events = [agent('XScout', [{ functionCall: { name: 'x_search', args: {} } }])];
  assert.deepEqual(projectTranscript(events, 'Conversationalist'), []);
});

test('history is bounded, and it is the OLDEST context that goes', () => {
  const long: Event[] = [];
  for (let i = 0; i < 40; i++) {
    long.push(user(`question ${i}`));
    long.push(agent('Analyst', [{ text: `answer ${i} ${'y'.repeat(2_000)}` }]));
  }
  const projected = projectTranscript(long, 'Conversationalist', { maxHistoryChars: 10_000 });
  const dumped = JSON.stringify(projected);
  assert.ok(dumped.includes('answer 39'), 'the newest exchange must always survive');
  assert.ok(!dumped.includes('answer 0'), 'the oldest exchange is what the budget drops');
});

test('a single oversized turn is elided, not dropped', () => {
  const events = [agent('XScout', [{ text: 'X RECON: ' + 'z'.repeat(9_000) }])];
  const [only] = projectTranscript(events, 'Conversationalist', { maxTurnChars: 500 });
  const text = (only.content!.parts![0] as { text: string }).text;
  assert.ok(text.startsWith('[XScout] X RECON: '));
  assert.ok(text.endsWith('[…turn truncated]'));
  assert.ok(text.length < 700);
});

test('projection is non-destructive — the stored events are untouched', () => {
  const before = JSON.stringify(THREAD);
  projectTranscript(THREAD, 'Conversationalist');
  assert.equal(JSON.stringify(THREAD), before);
});

test('turns are capped as well as characters', () => {
  // A character budget is not a bound on prompt SHAPE: a thread of short
  // exchanges fits 43 turns inside 40,000 chars, and 43 turns of history to
  // answer one question is attention tax no byte budget describes.
  const long: Event[] = [];
  for (let i = 0; i < 40; i++) {
    long.push(user(`q${i}`));
    long.push(agent('Analyst', [{ text: `a${i}` }]));
  }
  const projected = projectTranscript(long, 'Conversationalist', { maxHistoryTurns: 6 });
  assert.equal(projected.length, 6);
  const dumped = JSON.stringify(projected);
  assert.ok(dumped.includes('a39'), 'the newest exchange must always survive');
  assert.ok(!dumped.includes('"q0"'));
});

test('whichever ceiling binds first wins', () => {
  const long: Event[] = [];
  for (let i = 0; i < 40; i++) long.push(agent('XScout', [{ text: 'z'.repeat(1_000) }]));
  // chars bind long before the turn cap does
  assert.equal(projectTranscript(long, 'X', { maxHistoryChars: 3_500, maxHistoryTurns: 30 }).length, 4);
  // turns bind long before the char cap does
  assert.equal(projectTranscript(long, 'X', { maxHistoryChars: 999_999, maxHistoryTurns: 3 }).length, 3);
});

// ── What reaches durable storage ─────────────────────────────────────────

const toolEvent = (key: 'functionResponse' | 'toolResponse', body: unknown): Event =>
  ({ author: 'XScout', content: { role: 'user', parts: [{ [key]: { id: 'abc123', name: 'x_search', response: body } }] } } as unknown as Event);

test('thoughtSignature never reaches storage — it is 73% of every byte', () => {
  // The dominant cost in the stored record, and never read back: the
  // projection drops thought parts and tool traffic before any prompt, and
  // the memory service walks part.text alone. Measured across 128 live
  // sessions at 14.14 MB, one part of it reaching 115 KB.
  const e = { author: 'XScout', content: { role: 'model', parts: [
    { text: 'X RECON: …' },
    { toolCall: { name: 'x_search' }, thoughtSignature: 'B'.repeat(80_000) },
  ] } } as unknown as Event;
  const trimmed = trimEventForStorage(e);
  const dumped = JSON.stringify(trimmed);
  assert.ok(!dumped.includes('thoughtSignature'));
  assert.ok(!dumped.includes('BBBBB'));
  assert.ok(dumped.includes('X RECON'), 'the conversation itself must survive');
});

test('an oversized tool result is elided before it is stored', () => {
  const trimmed = trimEventForStorage(toolEvent('functionResponse', { html: 'x'.repeat(50_000) }));
  const dumped = JSON.stringify(trimmed);
  assert.ok(!dumped.includes('xxxxx'));
  assert.match(dumped, /chars dropped before storage/);
});

test('the elided size is grouped en-US whatever the server locale', (t) => {
  // Node takes its default locale from the environment at startup, so a
  // German server is a child process with LC_ALL set.
  const transcript = new URL('../lib/session/transcript.ts', import.meta.url).href;
  const script = `const { trimEventForStorage } = await import(${JSON.stringify(transcript)});
const event = { author: 'a', content: { role: 'user', parts: [{ functionResponse: { id: 'i', name: 'n', response: { s: 'x'.repeat(2550) } } }] } };
console.log(JSON.stringify([(2563).toLocaleString(), trimEventForStorage(event).content.parts[0].functionResponse.response.elided]));`;
  const run = spawnSync(
    process.execPath,
    ['--disable-warning=DEP0040', '--experimental-strip-types', '--input-type=module', '-e', script],
    { env: { ...process.env, LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' }, encoding: 'utf-8' },
  );
  assert.equal(run.status, 0, run.stderr);
  const [local, elided] = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
  if (local !== '2.563') return t.skip(`this Node ignores LC_ALL (2563 formats as ${local})`);
  // {"s":"x…"} is 2,558 characters.
  assert.match(elided, /^2,558 chars dropped before storage/);
});

test('the camelCase toolResponse shape is trimmed too — it is the larger share', () => {
  const trimmed = trimEventForStorage(toolEvent('toolResponse', { search_suggestions: '<style>' + 'y'.repeat(40_000) }));
  assert.ok(!JSON.stringify(trimmed).includes('yyyyy'));
});

test('an elided result is still a result — id and name survive', () => {
  // ADK pairs calls to responses by id and throws on a widowed half
  // (rearrangeEventsForLatestFunctionResponse), so the shape must hold.
  const trimmed = trimEventForStorage(toolEvent('functionResponse', { big: 'x'.repeat(9_000) }));
  const part = (trimmed.content!.parts as any[])[0].functionResponse;
  assert.equal(part.id, 'abc123');
  assert.equal(part.name, 'x_search');
  assert.ok(part.response, 'the response must remain present, only smaller');
});

test('a small tool result passes through untouched', () => {
  const small = toolEvent('functionResponse', { price: 217.5 });
  assert.equal(trimEventForStorage(small), small);
});

test('conversation text is never trimmed', () => {
  const answer = agent('Analyst', [{ text: 'MU: '.repeat(5_000) }]);
  assert.equal(trimEventForStorage(answer), answer);
});

test('provider reasoning state is stored whole beside a trimmed signature and payload (ADR 0046)', () => {
  // Resuming an interrupted turn replays its stored events raw, and a Claude
  // tool call continued with thinking on needs its signed blocks back.
  const state = { provider: 'anthropic', kind: 'thinking_blocks', payload: [{ type: 'thinking', thinking: 'plan', signature: 'sig-1' }] };
  const e = agent('Analyst', [
    { functionCall: { id: 'c1', name: 'load_memory', args: {} }, thoughtSignature: 'B'.repeat(10_000), providerState: state },
    { functionResponse: { id: 'c0', name: 'load_memory', response: { memories: 'x'.repeat(9_000) } }, providerState: state },
  ]);
  const parts = trimEventForStorage(e).content!.parts as any[];
  assert.equal(parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.deepEqual(parts[0].providerState, state);
  assert.match(JSON.stringify(parts[1].functionResponse), /chars dropped before storage/);
  assert.deepEqual(parts[1].providerState, state);
});

test('trimming does not mutate the live event — the tool loop still reads it', () => {
  // The caller applies this to the serialized copy only. If it mutated the
  // in-memory event, the running agent would lose its own tool result
  // mid-turn.
  const live = toolEvent('functionResponse', { html: 'x'.repeat(50_000) });
  const before = JSON.stringify(live);
  trimEventForStorage(live);
  assert.equal(JSON.stringify(live), before);
});

// ── The classifier's digest ──────────────────────────────────────────────

test('the digest carries BOTH sides of the exchange', () => {
  // The router lane held only user messages and the router's own verdicts,
  // so a challenge to an answer it had never seen read as small talk.
  const digest = renderTranscriptDigest(THREAD);
  assert.match(digest, /^user: Should I buy MU on Monday\?$/m);
  assert.match(digest, /^Analyst: MU: accumulate under \$130/m);
});

test('the digest is oldest-first and ends on the message being reacted to', () => {
  const lines = renderTranscriptDigest(THREAD).split('\n');
  assert.match(lines[0], /Should I buy MU/);
  assert.match(lines[lines.length - 1], /neglecting AI and security/);
});

test('the digest strips the harness date marker', () => {
  assert.ok(!renderTranscriptDigest(THREAD).includes('[System Context:'));
});

test('the digest carries no reasoning or tool payloads', () => {
  const digest = renderTranscriptDigest(THREAD);
  assert.ok(!digest.includes('My Micron Monday Decision Strategy'));
  assert.ok(!digest.includes('load_memory'));
});

test('the digest keeps only the newest maxTurns lines', () => {
  const long: Event[] = [];
  for (let i = 0; i < 20; i++) long.push(user(`message ${i}`));
  const lines = renderTranscriptDigest(long, { maxTurns: 3 }).split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines, ['user: message 17', 'user: message 18', 'user: message 19']);
});

test('an empty session yields an empty digest, so the router sees no block at all', () => {
  assert.equal(renderTranscriptDigest([]), '');
});

// ── The projection as the engine's session store (ADR 0058) ───────────────

const KEY = { appName: 'desk', userId: 'u1', sessionId: 'thread' };

/** THREAD as stored events: ids, timestamps and actions, as a store holds them. */
function storedThread(): TurnEvent[] {
  return THREAD.map((e, i) => createTurnEvent({ ...(structuredClone(e) as unknown as TurnEventInit), id: `t${i}`, timestamp: 100 + i }));
}

/** Seeds KEY with THREAD through a store's engine face. */
async function seeded(store: SessionService): Promise<void> {
  const session = await store.create(KEY);
  for (const event of storedThread()) await store.append(session, event);
}

for (const [name, make] of [
  ['an engine store', () => new InProcessSessionService()],
  ['an ADK store', () => new InMemorySessionService()],
  ['a store with both faces', () => new SupabaseSessionService(fakeSupabase().client)],
] as const) {
  test(`the projection is an engine store over ${name}: get projects history, append lands in both views`, async () => {
    const inner = make();
    const store = asSessionService(inner);
    await seeded(store);
    const projected: SessionService = new ProjectedSessionService(inner, 'Conversationalist');

    const view = (await projected.get(KEY))!;
    assert.deepEqual(view.events.map((e) => e.author), ['user', 'Conversationalist', 'user'], 'tool traffic and thoughts are gone');
    assert.match((view.events[1]!.content!.parts![0] as { text: string }).text, /^\[Analyst\] MU: accumulate/);

    // The running agent's own tool call must stay visible to it, unprojected.
    const inFlight = createTurnEvent({
      id: 'c1',
      timestamp: 200,
      invocationId: 'e-2',
      author: 'Conversationalist',
      content: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'load_memory', args: {} } }] },
      actions: { stateDelta: { route: 'Conversationalist', 'temp:t': 1 } },
    });
    const stored = await projected.append(view, inFlight);
    assert.deepEqual(stored.actions.stateDelta, { route: 'Conversationalist' });
    assert.equal(view.events.at(-1)!.id, 'c1', 'the projected view holds the new event');
    assert.equal(view.state.route, 'Conversationalist');

    const real = (await store.get(KEY))!;
    assert.deepEqual(real.events.map((e) => e.id), ['t0', 't1', 't2', 't3', 't4', 'c1'], 'the real session keeps every event, once');
    assert.ok(JSON.stringify(real.events[1]).includes('My Micron Monday'), 'the durable record keeps the thought');
    assert.equal(real.state.route, 'Conversationalist');
    assert.equal(real.lastUpdateTime, 200);

    // A partial event goes nowhere; create, list and delete reach the store.
    assert.equal((await projected.append(view, { ...inFlight, id: 'p', partial: true })).partial, true);
    assert.equal((await store.get(KEY))!.events.length, 6);
    assert.equal((await projected.create(KEY)).events.length, 6, 'a second create keeps the conversation');
    assert.deepEqual((await projected.list({ appName: KEY.appName })).sessions.map((s) => s.id), ['thread']);
    await projected.delete(KEY);
    assert.equal(await store.get(KEY), undefined);
  });
}

test('the engine face replays the interrupted turn raw, as the ADK face does', async () => {
  const store = new InProcessSessionService();
  await seeded(store);
  const projected = new ProjectedSessionService(store, 'Analyst', { rawFrom: () => 1 });
  const viaEngine = (await projected.get(KEY))!;
  const viaAdk = (await projected.getSession(KEY))!;
  assert.equal(JSON.stringify(viaEngine.events), JSON.stringify(viaAdk.events));
  assert.ok(JSON.stringify(viaEngine.events).includes('load_memory'), 'the raw tail keeps its tool call');
  assert.equal(viaEngine.events[0]!.author, 'user');
});

// ── Through a turn, on both runtimes ─────────────────────────────────────────

registerTool(
  'transcript_quotes',
  defineTool({ name: 'transcript_quotes', description: 'Quotes for a ticker.', schema: z.object({ ticker: z.string() }), execute: async () => 'x'.repeat(23_000) }),
  { override: true },
);

const deskConfig = (): SyndicateYamlConfig =>
  ({
    syndicate_name: 'Desk',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Analyst', model: 'scripted/analyst', instruction: 'Analyse.', description: 'markets', tools: ['transcript_quotes'] },
      { name: 'Conversationalist', model: 'scripted/chat', instruction: 'Talk.', description: 'small talk' },
    ],
    dispatch: { default_route: 'Conversationalist' },
  }) as unknown as SyndicateYamlConfig;

/** Two turns on one store: the Analyst answers with a tool, then the Conversationalist; each turn on `on(i)`. */
async function deskConversation(on: (turn: number) => RuntimeName | undefined) {
  const models = {
    router: new ScriptedModel('scripted/router', (req) =>
      answer(/neglecting/.test(requestTexts(req).at(-1) ?? '') ? '{"route":"Conversationalist","reason":"chat"}' : '{"route":"Analyst","reason":"a ticker"}'),
    ),
    analyst: new ScriptedModel('scripted/analyst', (req, n) =>
      n === 1 ? toolCall('transcript_quotes', { ticker: 'MU' }, 'call-quotes') : answer(`MU: accumulate under $130 (${String(lastToolResult(req)?.result).length} bytes read)`),
    ),
    chat: new ScriptedModel('scripted/chat', () => answer('Noted.')),
  };
  const sessionService = new InMemorySessionService();
  for (const [i, text] of ['Should I buy MU on Monday?', 'You are neglecting AI and security.'].entries()) {
    const runtime = on(i);
    const r = await runSyndicateTurn({
      ...(runtime ? { runtime } : runtimeOption()),
      config: deskConfig(),
      parts: [{ text }],
      appName: 'desk',
      userId: 'u1',
      sessionId: 'thread',
      sessionService,
      compile: { resolveModel: shimResolver(models), log: () => {} },
      trace: false,
    });
    assert.equal(r.status, 'completed', r.error?.message);
  }
  return models.chat.requests[0] as ModelRequest;
}

/** The Conversationalist's request: every message, as role and the text it carries. */
const seenByChat = (request: ModelRequest) => request.messages.map((m) => ({ role: m.role, parts: m.parts.map((p) => (p.type === 'text' ? p.text : p.type)) }));

forEachRuntime('through a turn: the next route reads the previous route\'s answer as a model turn, without its tool traffic', async () => {
  const request = await deskConversation(() => undefined);
  const seen = seenByChat(request);
  const answerTurn = seen.find((m) => m.parts.some((p) => /accumulate under \$130/.test(String(p))));
  assert.ok(answerTurn, 'the Analyst\'s answer reaches the Conversationalist');
  assert.equal(answerTurn.role, 'assistant');
  assert.match(String(answerTurn.parts[0]), /^\[Analyst\] MU: accumulate under \$130 \(23000 bytes read\)/);
  assert.ok(!JSON.stringify(request.messages).includes('x'.repeat(100)), 'no tool payload');
  assert.ok(!seen.some((m) => m.parts.some((p) => p === 'toolCall' || p === 'toolResult')), 'no tool traffic');
});

acrossRuntimes('through a turn: a route on one runtime reads what a route on the other wrote, as on one runtime', async (writer, reader) => {
  const reference = seenByChat(await deskConversation(() => 'adk'));
  const crossed = seenByChat(await deskConversation((i) => (i === 0 ? writer : reader)));
  assert.deepEqual(crossed, reference);
});
