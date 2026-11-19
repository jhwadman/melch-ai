/**
 * tests/gemini4.test.ts — what the engine does differently for Gemini 4
 * (gemini-4-hydrogen), ADR 0160, and that Gemini 3 stays as it was:
 *
 *   - earlier turns go on the wire as text and user content only;
 *   - the placeholder signature goes on an unsigned current-turn call;
 *   - the reasoning mapping (no MINIMAL, XHIGH where taken) and its round
 *     trip through a stored generateContentConfig;
 *   - the reflection call is signed with the placeholder;
 *   - the engine's own calls (compaction summary, wiki run, vision) ask for
 *     an explicit level;
 *   - a current turn read back from the trimmed (Supabase) store keeps the
 *     placeholder on its calls, and its earlier turns drop theirs.
 *
 * Offline: requests go to a stubbed fetch through the real SDK; every key
 * is an obvious fixture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GoogleGenAI } from '@google/genai';
import type { Content, GoogleGenAIOptions } from '@google/genai';

import { GeminiAdapter, PLACEHOLDER_THOUGHT_SIGNATURE, THOUGHT_SIGNATURE_KIND, placeholderSignaturesFor, textOnlyEarlierTurns } from '../lib/models/geminiAdapter.ts';
import type { GeminiAdapterOptions } from '../lib/models/geminiAdapter.ts';
import { geminiMajorVersion } from '../lib/models/geminiState.ts';
import { contentsToMessages, messagesToContents, reasoningOf } from '../lib/models/genaiMapping.ts';
import type { AssistantMessage, Message, ModelRequest, ToolMessage, UserMessage } from '../lib/models/contract.ts';
import {
  effortCeiling,
  geminiTakesXhigh,
  geminiWeakened,
  internalReasoningConfig,
  internalThinkingConfig,
  reasoningConfig,
  thinksHighByDefault,
} from '../lib/models/reasoning.ts';
import { PLACEHOLDER_THOUGHT_SIGNATURE as STATE_PLACEHOLDER } from '../lib/models/geminiState.ts';
import { SUMMARY_MAX_TOKENS, SUMMARY_MAX_TOKENS_THINKING, summaryRequest } from '../lib/runtime/native/compaction.ts';
import { reflectionSigning } from '../lib/runtime/native/selfCorrection.ts';
import { trimEventForStorage } from '../lib/session/transcript.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';

const KEY = 'fixture-gemini-key-0123456789';
const HYDROGEN = 'gemini-4-hydrogen';
const FLASH = 'gemini-3.8-flash';

const LOOKUP = { name: 'lookup', description: 'Looks a word up.', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } };
const user = (text: string): UserMessage => ({ role: 'user', parts: [{ type: 'text', text }] });
const signed = (model: string, payload: string) => ({ provider: 'gemini', kind: THOUGHT_SIGNATURE_KIND, model, payload });

const realClient = (options: GoogleGenAIOptions) => new GoogleGenAI(options);
const adapterFor = (model: string, options: Partial<GeminiAdapterOptions> = {}) =>
  new GeminiAdapter({ model, apiKey: KEY, endpoint: { platform: 'direct' }, clientFactory: realClient, ...options });

/** The JSON body each request of `fn` sent, through the real SDK over a stubbed fetch. */
async function bodies(fn: () => Promise<void>): Promise<any[]> {
  const real = globalThis.fetch;
  const seen: any[] = [];
  globalThis.fetch = (async (_url: string | URL, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    const body = { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}

async function send(model: string, request: Partial<ModelRequest> & { messages: Message[] }, options: Partial<GeminiAdapterOptions> = {}): Promise<any> {
  const a = adapterFor(model, options);
  const [body] = await bodies(async () => {
    for await (const _ of a.generate({ model, ...request })) void _;
  });
  return body;
}

/** Two turns: the first called lookup (signed by `model`) and answered; the second is the current one. */
function twoTurns(model: string): Message[] {
  const call: AssistantMessage = { role: 'assistant', parts: [{ type: 'toolCall', id: 'fc-1', name: 'lookup', args: { q: 'a' }, providerState: signed(model, 'c2ln') }] };
  const result: ToolMessage = { role: 'tool', parts: [{ type: 'toolResult', id: 'fc-1', name: 'lookup', result: { value: 14 } }] };
  const answer: AssistantMessage = { role: 'assistant', parts: [{ type: 'text', text: 'It is 14.' }] };
  return [user('look up a'), call, result, answer, user('and b?')];
}

// ── The version read ─────────────────────────────────────────────────────────

test('geminiMajorVersion reads a bare id and a resource path; anything else is 0', () => {
  assert.equal(geminiMajorVersion(HYDROGEN), 4);
  assert.equal(geminiMajorVersion(`publishers/google/models/${HYDROGEN}`), 4);
  assert.equal(geminiMajorVersion(FLASH), 3);
  assert.equal(geminiMajorVersion('gemini-2.5-flash'), 2);
  assert.equal(geminiMajorVersion('claude-sonnet-4-6'), 0);
  assert.equal(geminiMajorVersion(undefined), 0);
  assert.equal(textOnlyEarlierTurns(HYDROGEN), true);
  assert.equal(textOnlyEarlierTurns(FLASH), false);
});

// ── Earlier turns ────────────────────────────────────────────────────────────

test('Gemini 4: earlier turns go as text and user content only; the current turn keeps its calls and results', async () => {
  const current: AssistantMessage = { role: 'assistant', parts: [{ type: 'toolCall', id: 'fc-2', name: 'lookup', args: { q: 'b' }, providerState: signed(HYDROGEN, 'bm93') }] };
  const currentResult: ToolMessage = { role: 'tool', parts: [{ type: 'toolResult', id: 'fc-2', name: 'lookup', result: { value: 28 } }] };
  const body = await send(HYDROGEN, { messages: [...twoTurns(HYDROGEN), current, currentResult], tools: [LOOKUP] });
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'look up a' }] },
    { role: 'model', parts: [{ text: 'It is 14.' }] },
    { role: 'user', parts: [{ text: 'and b?' }] },
    { role: 'model', parts: [{ functionCall: { id: 'fc-2', name: 'lookup', args: { q: 'b' } }, thoughtSignature: 'bm93' }] },
    { role: 'user', parts: [{ functionResponse: { id: 'fc-2', name: 'lookup', response: { value: 28 } } }] },
  ]);
});

test('Gemini 4: an earlier assistant message with text beside its calls keeps the text; one with calls alone is left out', async () => {
  const mixed: AssistantMessage = {
    role: 'assistant',
    parts: [{ type: 'text', text: 'Checking.' }, { type: 'toolCall', id: 'fc-1', name: 'lookup', args: { q: 'a' } }],
  };
  const result: ToolMessage = { role: 'tool', parts: [{ type: 'toolResult', id: 'fc-1', name: 'lookup', result: {} }] };
  const body = await send(HYDROGEN, { messages: [user('one'), mixed, result, user('two')], tools: [LOOKUP] });
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'one' }] },
    { role: 'model', parts: [{ text: 'Checking.' }] },
    { role: 'user', parts: [{ text: 'two' }] },
  ]);
});

test('Gemini 3 is unchanged: earlier turns keep their calls and results, unsigned', async () => {
  const body = await send(FLASH, { messages: twoTurns(FLASH), tools: [LOOKUP] });
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'look up a' }] },
    { role: 'model', parts: [{ functionCall: { id: 'fc-1', name: 'lookup', args: { q: 'a' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'fc-1', name: 'lookup', response: { value: 14 } } }] },
    { role: 'model', parts: [{ text: 'It is 14.' }] },
    { role: 'user', parts: [{ text: 'and b?' }] },
  ]);
});

// ── The placeholder in the current turn ─────────────────────────────────────

test('Gemini 4: an unsigned current-turn call gets the placeholder by default; Gemini 3 does not; the option still decides', async () => {
  const unsigned: AssistantMessage = { role: 'assistant', parts: [{ type: 'toolCall', id: 'toolu_1', name: 'lookup', args: { q: 'a' } }] };
  const result: ToolMessage = { role: 'tool', parts: [{ type: 'toolResult', id: 'toolu_1', name: 'lookup', result: {} }] };
  const messages = [user('now'), unsigned, result];
  const h = await send(HYDROGEN, { messages, tools: [LOOKUP] });
  assert.equal(h.contents[1].parts[0].thoughtSignature, PLACEHOLDER_THOUGHT_SIGNATURE);
  const f = await send(FLASH, { messages, tools: [LOOKUP] });
  assert.equal(f.contents[1].parts[0].thoughtSignature, undefined);
  const off = await send(HYDROGEN, { messages, tools: [LOOKUP] }, { placeholderSignatures: false });
  assert.equal(off.contents[1].parts[0].thoughtSignature, undefined);
  assert.equal(placeholderSignaturesFor(HYDROGEN, undefined), true);
  assert.equal(placeholderSignaturesFor(FLASH, undefined), false);
  assert.equal(placeholderSignaturesFor(FLASH, true), true);
});

test("Gemini 4: a 3.8 Flash signature from the current turn is not replayed; the placeholder stands in (a cutover mid-turn)", async () => {
  const fromFlash: AssistantMessage = { role: 'assistant', parts: [{ type: 'toolCall', id: 'fc-1', name: 'lookup', args: { q: 'a' }, providerState: signed(FLASH, 'Zmxhc2g=') }] };
  const result: ToolMessage = { role: 'tool', parts: [{ type: 'toolResult', id: 'fc-1', name: 'lookup', result: {} }] };
  const body = await send(HYDROGEN, { messages: [user('now'), fromFlash, result], tools: [LOOKUP] });
  assert.equal(body.contents[1].parts[0].thoughtSignature, PLACEHOLDER_THOUGHT_SIGNATURE);
});

// ── The trimmed store ────────────────────────────────────────────────────────

test('a session read back through the Supabase trim: the current turn keeps the placeholder on its call, earlier turns drop theirs', async () => {
  // Turn 1 complete, turn 2 paused after its first call (an approval resume, ADR 0028).
  const current: AssistantMessage = { role: 'assistant', parts: [{ type: 'toolCall', id: 'fc-2', name: 'lookup', args: { q: 'b' }, providerState: signed(HYDROGEN, 'cmVhbA==') }] };
  const currentResult: ToolMessage = { role: 'tool', parts: [{ type: 'toolResult', id: 'fc-2', name: 'lookup', result: { value: 28 } }] };
  const live = [...twoTurns(HYDROGEN), current, currentResult];
  const { contents } = messagesToContents({ messages: live });
  const stored = contents.map((content) => trimEventForStorage({ content } as unknown as TurnEvent).content as Content);
  assert.equal(stored[5].parts?.[0].thoughtSignature, STATE_PLACEHOLDER, 'the trim stores the skip value on the call');
  const { messages } = contentsToMessages(stored);
  const body = await send(HYDROGEN, { messages, tools: [LOOKUP] });
  assert.deepEqual(body.contents[1], { role: 'model', parts: [{ text: 'It is 14.' }] });
  assert.equal(body.contents.length, 5);
  assert.deepEqual(body.contents[3].parts[0], { functionCall: { id: 'fc-2', name: 'lookup', args: { q: 'b' } }, thoughtSignature: PLACEHOLDER_THOUGHT_SIGNATURE });
});

// ── Reasoning ────────────────────────────────────────────────────────────────

test('Gemini 4 reasoning: no MINIMAL; none and a budget of 0 go as LOW; XHIGH on hydrogen and neon; a positive budget as a budget', async () => {
  const cases: Array<[string, ModelRequest['reasoning'], unknown]> = [
    [HYDROGEN, 'none', { thinkingLevel: 'LOW' }],
    [HYDROGEN, { budget_tokens: 0 }, { thinkingLevel: 'LOW' }],
    [HYDROGEN, 'low', { thinkingLevel: 'LOW', includeThoughts: true }],
    [HYDROGEN, 'medium', { thinkingLevel: 'MEDIUM', includeThoughts: true }],
    [HYDROGEN, 'high', { thinkingLevel: 'HIGH', includeThoughts: true }],
    [HYDROGEN, 'xhigh', { thinkingLevel: 'XHIGH', includeThoughts: true }],
    [HYDROGEN, 'max', { thinkingLevel: 'XHIGH', includeThoughts: true }],
    [HYDROGEN, { budget_tokens: 4096 }, { thinkingBudget: 4096, includeThoughts: true }],
    ['gemini-4-neon', 'xhigh', { thinkingLevel: 'XHIGH', includeThoughts: true }],
    ['gemini-4-flash', 'xhigh', { thinkingLevel: 'HIGH', includeThoughts: true }],
    [FLASH, 'none', { thinkingLevel: 'MINIMAL' }],
    [FLASH, { budget_tokens: 0 }, { thinkingLevel: 'MINIMAL' }],
    [FLASH, 'xhigh', { thinkingLevel: 'HIGH', includeThoughts: true }],
  ];
  for (const [model, reasoning, expected] of cases) {
    const body = await send(model, { messages: [user('hi')], reasoning });
    assert.deepEqual(body.generationConfig.thinkingConfig, expected, `${model} ${JSON.stringify(reasoning)}`);
  }
});

test('Gemini 4 reasoning: what is weakened, and the ceiling', () => {
  assert.equal(geminiWeakened(HYDROGEN, 'none'), 'none');
  assert.equal(geminiWeakened(HYDROGEN, { budget_tokens: 0 }), 'none');
  assert.equal(geminiWeakened(HYDROGEN, 'low'), undefined);
  assert.equal(geminiWeakened(HYDROGEN, 'xhigh'), undefined);
  assert.equal(geminiWeakened(HYDROGEN, 'max'), 'max');
  assert.equal(geminiWeakened('gemini-4-flash', 'xhigh'), 'xhigh');
  assert.equal(geminiWeakened(FLASH, 'none'), undefined, 'Gemini 3 has MINIMAL');
  assert.equal(geminiWeakened(FLASH, 'xhigh'), 'xhigh');
  assert.equal(effortCeiling(HYDROGEN), 'xhigh');
  assert.equal(effortCeiling('gemini-4-neon'), 'xhigh');
  assert.equal(effortCeiling('gemini-4-flash'), 'high');
  assert.equal(effortCeiling(FLASH), 'high');
  assert.equal(geminiTakesXhigh(`publishers/google/models/${HYDROGEN}`), true);
  assert.equal(geminiTakesXhigh('gemini-4-hydrogenx'), false);
});

test('Gemini 4 reasoning survives the stored generateContentConfig round trip; Gemini 3 reads as it did', () => {
  const round = (model: string, setting: Parameters<typeof reasoningConfig>[1]) => reasoningOf(reasoningConfig(model, setting) as never);
  assert.equal(round(HYDROGEN, 'none'), 'none');
  assert.equal(round(HYDROGEN, { budget_tokens: 0 }), 'none');
  assert.equal(round(HYDROGEN, 'low'), 'low');
  assert.equal(round(HYDROGEN, 'xhigh'), 'xhigh');
  assert.equal(round(HYDROGEN, 'max'), 'max');
  assert.equal(round('gemini-4-flash', 'xhigh'), 'xhigh');
  assert.equal(round(FLASH, 'none'), 'none');
  assert.equal(round(FLASH, 'xhigh'), 'xhigh');
  assert.equal(round(FLASH, 'max'), 'max');
  assert.equal(reasoningOf({ thinkingConfig: { thinkingLevel: 'LOW' } } as never), 'low', 'LOW alone is low');
});

// ── Self-correction ──────────────────────────────────────────────────────────

test('the reflection call is signed with the placeholder on Gemini 3 and 4; Gemini 2 and other providers as before', () => {
  const gemini = { provider: 'gemini' };
  assert.deepEqual(reflectionSigning(gemini, HYDROGEN), { placeholder: STATE_PLACEHOLDER });
  assert.deepEqual(reflectionSigning(gemini, FLASH), { placeholder: STATE_PLACEHOLDER });
  assert.deepEqual(reflectionSigning(gemini, 'gemini-2.5-flash'), {});
  assert.equal(reflectionSigning({ provider: 'anthropic' }, 'claude-sonnet-4-6'), undefined);
});

// ── The engine's own calls ───────────────────────────────────────────────────

test("the engine's own calls: an explicit level on a model that thinks high by default, nothing new elsewhere", () => {
  assert.equal(thinksHighByDefault(HYDROGEN), true);
  assert.equal(thinksHighByDefault(FLASH), false);
  assert.equal(thinksHighByDefault('claude-sonnet-4-6'), false);
  assert.deepEqual(internalReasoningConfig(HYDROGEN, 'low'), { reasoningEffort: 'low', thinkingConfig: { thinkingLevel: 'LOW' } });
  assert.deepEqual(internalReasoningConfig(FLASH, 'low'), {});
  assert.deepEqual(internalReasoningConfig('claude-sonnet-4-6', 'low'), {});
  assert.deepEqual(internalThinkingConfig(HYDROGEN, 'low'), { thinkingConfig: { thinkingLevel: 'LOW' } });
  assert.equal(internalThinkingConfig(FLASH, 'low'), undefined);
});

test('the compaction summary: low under the raised cap on Gemini 4; no level and the old cap on Gemini 3 and Claude', () => {
  const events = [{ id: 'e1', author: 'user', timestamp: 1, content: { role: 'user', parts: [{ text: 'hello' }] } }] as unknown as TurnEvent[];
  const h = summaryRequest(events, HYDROGEN);
  assert.equal(h.reasoning, 'low');
  assert.equal(h.sampling?.maxOutputTokens, SUMMARY_MAX_TOKENS_THINKING);
  for (const model of [FLASH, 'claude-sonnet-4-6']) {
    const r = summaryRequest(events, model);
    assert.equal(r.reasoning, undefined, model);
    assert.equal(r.sampling?.maxOutputTokens, SUMMARY_MAX_TOKENS, model);
  }
});

// ── An approval resume, through the engine ───────────────────────────────────

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { llmRequestToModelRequest } from '../lib/models/genaiMapping.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { z } from 'zod';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

registerTool(
  'gemini4_test_send',
  defineTool({ name: 'gemini4_test_send', description: 'Send a note.', schema: z.object({ to: z.string() }), execute: async ({ to }) => `sent to ${to}` }),
  { override: true },
);

test('an approval resume read back from the trimmed store: on Gemini 4 the paused call and its result go as a pair, the call with the placeholder', async () => {
  const seen: any[] = [];
  const boss = new ScriptedLlm(HYDROGEN, (req, n) => {
    seen.push(req);
    return n === 1 ? call('gemini4_test_send', { to: 'ops@acme.test' }) : text('done');
  });
  const config = {
    syndicate_name: 'Mailer',
    orchestrator: { name: 'Boss', model: HYDROGEN, instruction: 'Send notes.', tools: ['gemini4_test_send'], require_approval: ['gemini4_test_send'] },
    subagents: [],
  } as unknown as SyndicateYamlConfig;
  const key = { appName: 'app', userId: 'u', sessionId: 's' };
  const live = new InProcessSessionService();
  const run = (sessionService: InProcessSessionService, parts: any[]) =>
    runSyndicateTurn({ config, parts, ...key, sessionService, compile: { resolveModel: scriptedResolver({ [HYDROGEN]: boss }) }, trace: false });

  const first = await run(live, [{ text: 'tell ops' }]);
  assert.equal(first.status, 'input-required');
  // The paused turn as the Supabase store keeps it.
  const stored = new InProcessSessionService();
  const session = await stored.create(key);
  for (const event of (await live.get(key))!.events) await stored.append(session, trimEventForStorage(event as TurnEvent) as TurnEvent);
  const second = await run(stored, [approvalResponsePart(first.approval!.id, true)]);
  assert.equal(second.status, 'completed');

  // What the resumed step would send Hydrogen.
  const request = llmRequestToModelRequest(seen.at(-1), { model: HYDROGEN });
  const body = await send(HYDROGEN, { ...request, model: HYDROGEN });
  const parts = body.contents.flatMap((c: any) => c.parts.map((p: any) => ({ role: c.role, ...p })));
  const callPart = parts.find((p: any) => p.functionCall?.name === 'gemini4_test_send');
  const result = parts.find((p: any) => p.functionResponse?.name === 'gemini4_test_send');
  assert.ok(callPart, 'the paused call is sent');
  assert.ok(result, 'its result is sent');
  assert.equal(callPart.thoughtSignature, PLACEHOLDER_THOUGHT_SIGNATURE);
  assert.equal(body.contents.at(-1).role, 'user');
  assert.ok(!parts.some((p: any) => p.functionResponse && !parts.some((q: any) => q.functionCall?.name === p.functionResponse.name)), 'no orphan result');
});
