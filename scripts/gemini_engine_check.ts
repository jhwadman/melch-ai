#!/usr/bin/env node
/**
 * scripts/gemini_engine_check.ts — the live run gate G3 asks for (ADR 0045,
 * ADR 0100): the engine's own GeminiAdapter (lib/models/geminiAdapter.ts)
 * against the real Gemini API on the native runtime, for what only a live
 * call can confirm.
 *
 * Four cases, each one syndicate with one Gemini orchestrator, run through
 * runSyndicateTurn on an in-process session:
 *
 *   grounding   web_search and url_context: an answer, with grounding
 *               metadata on a stored event
 *   code        code_execution: Gemini runs Python and answers with its result
 *   mixed       a function tool beside code_execution and web_search, with
 *               reasoning low: the server-side invocations come back beside
 *               the call, and the signed call and the carried parts are
 *               replayed on the next step
 *   session     two turns on one session, a tool call in each, reasoning
 *               low: the second turn's requests carry the first turn's history
 *               (earlier turns' signatures left out; on Gemini 4 their calls
 *               and results too, ADR 0160) and Gemini accepts them
 *
 * The cases ADR 0160 added for Gemini 4, each also run on Gemini 3:
 *
 *   parallel    two calls in one step, then a second turn over them
 *   none        the session case at reasoning none (LOW on Gemini 4)
 *   budget      the session case at reasoning { budget_tokens: 1024 }
 *   cutover     turn 1 on gemini-3.8-flash, turn 2 on --model, one session
 *   trimmed     the session case with turn 1 read back through the Supabase
 *               trim (trimEventForStorage) into a fresh store
 *   resume      a current turn read back through the trim mid-turn (its call
 *               then carries the placeholder), continued to its answer, as an
 *               approval resume does (ADR 0028); straight on the adapter
 *   reflection  a current turn holding self-correction's reflection call,
 *               signed with the placeholder as the step stores it, continued
 *               to its answer; straight on the adapter
 *   toolerror   a tool that throws once: the tool side of self-correction
 *   compaction  the summary call itself (summarize), then three turns with
 *               compaction forced on, the third answered from the first two
 *   codesession code_execution in turn 1, a follow-up over its result in turn 2
 *   searchsession web_search in turn 1, a tool call and a follow-up in turn 2
 *   memory      memory extraction (modelExtractor) on --model
 *   followup    turn 2 answerable only from turn 1's tool result, and a
 *               second call to that tool fails (503): the answer must come
 *               from the earlier turn's projected record, not a re-fetch
 *   callonly    an earlier turn whose assistant message held only a call and
 *               whose answer was never written: on Gemini 4 two user contents
 *               then meet; straight on the adapter
 *   vision      inspect_image's vision pass (its own model,
 *               lib/tools/inspectImageTool.ts) on a generated PNG
 *
 * Each case runs on `native`, the only runtime (ADR 0107), with
 * GEMINI_ADAPTER=engine. `--runtimes` accepts `native` only.
 *
 * Only case names, runtimes, outcomes, counts and timings are printed — never
 * a key, a request body or the model's answer. An error message is printed
 * scrubbed of key-shaped strings and cut short.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gemini_engine_check.ts
 *   node --experimental-strip-types scripts/gemini_engine_check.ts --model gemini-3.5-flash
 *   node --experimental-strip-types scripts/gemini_engine_check.ts --cases grounding,code
 *
 * Needs GOOGLE_GENAI_API_KEY (or GEMINI_API_KEY), or GEMINI_PLATFORM=vertex
 * with its project and location. Every case is a billed call.
 *
 * Exit: 0 every case passed · 1 a case failed · 2 a usage error or no Gemini route.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { loadEnv } from '../lib/loadEnv.ts';
import { modelExtractor } from '../lib/memory/providers.ts';
import type { AssistantMessage, Message, ModelAdapter, ToolMessage } from '../lib/models/contract.ts';
import { GeminiAdapter, PROJECTION_MARKER } from '../lib/models/geminiAdapter.ts';
import { PLACEHOLDER_THOUGHT_SIGNATURE } from '../lib/models/geminiState.ts';
import { contentsToMessages, messagesToContents } from '../lib/models/genaiMapping.ts';
import { summarize } from '../lib/runtime/native/compaction.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import type { SessionService } from '../lib/runtime/sessions.ts';
import { trimEventForStorage } from '../lib/session/transcript.ts';
import { inspectImageContract } from '../lib/tools/inspectImageTool.ts';
import { providerForModel, providerStatuses } from '../lib/models/registry.ts';
import { patternRedactor } from '../lib/observability/redact.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult, TurnEvents } from '../lib/runtime/syndicateTurn.ts';
import { RUNTIMES } from '../lib/runtime/runtimeFlag.ts';
import type { RuntimeName } from '../lib/runtime/runtimeFlag.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';

export const CASES = [
  'grounding', 'code', 'mixed', 'session',
  'parallel', 'none', 'budget', 'cutover', 'trimmed', 'resume', 'reflection', 'toolerror',
  'compaction', 'codesession', 'searchsession', 'memory', 'vision', 'callonly', 'followup',
] as const;
export type CaseName = (typeof CASES)[number];
const DEFAULT_MODEL = 'gemini-4-hydrogen';
/** The model turn 1 of the cutover case runs on. */
const CUTOVER_FROM = 'gemini-3.8-flash';
const TURN_DEADLINE_MS = 180_000;
const ERROR_MAX = 240;

const TOOL = 'gemini_check_lookup';
const VALUES: Record<string, string> = { alpha: '14', beta: '28' };

const lookupValue = (key: string) => VALUES[key.trim().toLowerCase()] ?? `No number is stored under "${key}".`;
const lookup = defineTool({
  name: TOOL,
  description: 'Returns the number stored under a key.',
  schema: z.object({ key: z.string().describe('The key, for example "alpha".') }),
  execute: async ({ key }) => lookupValue(key),
});

/** A lookup that throws on its first call in each process run of the toolerror case. */
const FLAKY = 'gemini_check_flaky_lookup';
let flakyCalls = 0;
const flaky = defineTool({
  name: FLAKY,
  description: 'Returns the number stored under a key. It may fail; if it does, call it again.',
  schema: z.object({ key: z.string().describe('The key, for example "alpha".') }),
  execute: async ({ key }) => {
    if (flakyCalls++ === 0) throw new Error('The store was busy. Try the same call again.');
    return lookupValue(key);
  },
});

/** A record store that answers once, then is down: the followup case. */
const RECORD = 'gemini_check_record';
let recordCalls = 0;
const record = defineTool({
  name: RECORD,
  description: 'Returns the customer record stored under an id: name, city, plan and account code.',
  schema: z.object({ id: z.string().describe('The customer id, for example "C-7".') }),
  execute: async () => {
    if (recordCalls++ > 0) throw new Error('503 Service Unavailable: the record store is down.');
    return { id: 'C-7', name: 'Ada Brennan', city: 'Tromsø', plan: 'Harbour', account_code: 'QX-4471' };
  },
});

const scrub = patternRedactor(['secret']);

interface TurnSpec {
  agent: Record<string, unknown>;
  turns: string[];
  /** The model each turn runs on, when it is not the agent's (the cutover case). */
  models?: string[];
  /** Between turns: the store the next turn reads (the trimmed case). */
  between?: (store: InProcessSessionService, key: { appName: string; userId: string; sessionId: string }) => Promise<InProcessSessionService>;
  /** Why the case failed, or undefined when it passed. */
  verdict: (runs: TurnRun[], store: SessionService, key: { appName: string; userId: string; sessionId: string }) => string | undefined | Promise<string | undefined>;
}

/** A case that drives the adapter or a helper directly: why it failed, or undefined. */
interface DirectSpec {
  direct: (model: string) => Promise<{ failure?: string; calls: number }>;
}

type CaseSpec = TurnSpec | DirectSpec;

interface TurnRun {
  result?: SyndicateTurnResult;
  threw?: string;
  /** Function names the turn's events answered. */
  toolCalls: string[];
  /** The most calls one model event carried. */
  widestStep: number;
  grounded: boolean;
  codeParts: number;
}

const has = (text: string | undefined, needle: string) => (text ?? '').replace(/[,\s]/g, '').includes(needle);

function incomplete(runs: TurnRun[]): string | undefined {
  for (const [i, run] of runs.entries()) {
    if (run.threw) return `turn ${i + 1} threw: ${run.threw}`;
    if (run.result?.status !== 'completed') {
      const error = run.result?.error ? ` (${run.result.error.code}: ${scrub(run.result.error.message).slice(0, ERROR_MAX)})` : '';
      return `turn ${i + 1} ${run.result?.status ?? 'did not run'}${error}`;
    }
    // An earlier turn's record is history, never an answer (ADR 0160).
    if ((run.result?.text ?? '').includes(PROJECTION_MARKER)) return `turn ${i + 1} wrote a tool record as text`;
  }
  return undefined;
}

function specs(model: string): Record<CaseName, CaseSpec> {
  const base = { name: 'Checker', model, instruction: 'Answer briefly and plainly.' };
  return {
    grounding: {
      agent: { ...base, tools: ['web_search', 'url_context'] },
      turns: ['Read https://www.iana.org/help/example-domains and search the web: which organisation reserves example.com? One sentence.'],
      verdict: (runs) =>
        incomplete(runs) ?? (!runs[0].result?.text ? 'no answer' : !runs[0].grounded ? 'no grounding metadata on any stored event' : undefined),
    },
    code: {
      agent: { ...base, code_execution: 'gemini' },
      turns: ['Write and run Python to compute the sum of the first 50 prime numbers. Answer with the number only.'],
      verdict: (runs) => incomplete(runs) ?? (!has(runs[0].result?.text, '5117') ? 'the answer is not 5117' : undefined),
    },
    mixed: {
      agent: { ...base, tools: [TOOL, 'web_search'], code_execution: 'gemini', reasoning: 'low' },
      turns: [`Call ${TOOL} with the key "alpha", then run Python to multiply that number by 3. Answer with the product only.`],
      verdict: (runs) =>
        incomplete(runs) ?? (!runs[0].toolCalls.includes(TOOL) ? `${TOOL} was not called` : !has(runs[0].result?.text, '42') ? 'the answer is not 42' : undefined),
    },
    session: {
      agent: { ...base, tools: [TOOL], reasoning: 'low' },
      turns: [
        `Call ${TOOL} with the key "alpha" and tell me the number.`,
        `Now call ${TOOL} with the key "beta" and add it to the number from before. Answer with the sum only.`,
      ],
      verdict: (runs) => {
        const stopped = incomplete(runs);
        if (stopped) return stopped;
        if (!runs.every((r) => r.toolCalls.includes(TOOL))) return `${TOOL} was not called on every turn`;
        return has(runs[1].result?.text, '42') ? undefined : 'the second turn does not answer 42';
      },
    },
    parallel: {
      agent: { ...base, tools: [TOOL], reasoning: 'low' },
      turns: [
        `In ONE step, call ${TOOL} twice in parallel: once with the key "alpha" and once with the key "beta". Then answer with their sum only.`,
        'Now add 10 to that sum. Answer with the number only.',
      ],
      verdict: (runs) => {
        const stopped = incomplete(runs);
        if (stopped) return stopped;
        if (runs[0].widestStep < 2) return 'the two calls did not come in one step';
        if (!has(runs[0].result?.text, '42')) return 'the first turn does not answer 42';
        return has(runs[1].result?.text, '52') ? undefined : 'the second turn does not answer 52';
      },
    },
    none: sessionLike(base, 'none'),
    budget: sessionLike(base, { budget_tokens: 1024 }),
    cutover: { ...sessionLike(base, 'low'), models: [CUTOVER_FROM, model] },
    trimmed: { ...sessionLike(base, 'low'), between: trimmedStore },
    toolerror: {
      agent: { ...base, tools: [FLAKY], reasoning: 'low' },
      turns: [`Call ${FLAKY} with the key "alpha" and tell me the number. If it fails, call it again.`],
      verdict: (runs) => {
        const stopped = incomplete(runs);
        if (stopped) return stopped;
        if (runs[0].toolCalls.filter((n) => n === FLAKY).length < 2) return `${FLAKY} was not retried`;
        return has(runs[0].result?.text, '14') ? undefined : 'the answer is not 14';
      },
    },
    compaction: {
      // Compaction forced on: every step past the first compacts what lies beyond the last two events.
      agent: { ...base, tools: [TOOL], reasoning: 'low', context: { compact_after_tokens: 1, keep_recent_events: 2 } },
      turns: [
        `Call ${TOOL} with the key "alpha" and tell me the number.`,
        `Call ${TOOL} with the key "beta" and tell me the number.`,
        'What is the sum of the two numbers you looked up? Answer with the sum only.',
      ],
      verdict: async (runs, store, key) => {
        const stopped = incomplete(runs);
        if (stopped) return stopped;
        const session = await store.get(key);
        const compacted = (session?.events ?? []).filter((e) => (e as { isCompacted?: boolean }).isCompacted).length;
        if (!compacted) return 'no compaction was stored (the summary call failed or was skipped)';
        return has(runs[2].result?.text, '42') ? undefined : 'the third turn does not answer 42';
      },
    },
    codesession: {
      agent: { ...base, code_execution: 'gemini', reasoning: 'low' },
      turns: [
        'Write and run Python to compute the sum of the first 50 prime numbers. Answer with the number only.',
        'Now run Python to multiply that number by 2. Answer with the number only.',
      ],
      verdict: (runs) => {
        const stopped = incomplete(runs);
        if (stopped) return stopped;
        if (!has(runs[0].result?.text, '5117')) return 'the first turn is not 5117';
        return has(runs[1].result?.text, '10234') ? undefined : 'the second turn is not 10234';
      },
    },
    searchsession: {
      agent: { ...base, tools: ['web_search', TOOL], reasoning: 'low' },
      turns: [
        'Search the web: which organisation reserves the domain example.com? Answer with its abbreviation only.',
        `Call ${TOOL} with the key "alpha". Then answer in one line: the organisation from your previous answer, and the number.`,
      ],
      verdict: (runs) => {
        const stopped = incomplete(runs);
        if (stopped) return stopped;
        if (!runs[0].grounded) return 'the first turn has no grounding';
        if (!runs[1].toolCalls.includes(TOOL)) return `${TOOL} was not called in turn 2`;
        const text = runs[1].result?.text ?? '';
        return /IANA|Internet Assigned/i.test(text) && has(text, '14') ? undefined : 'the second turn lost the organisation or the number';
      },
    },
    followup: {
      agent: { ...base, tools: [RECORD], reasoning: 'low' },
      turns: [
        `Look up customer C-7 with ${RECORD} and tell me their city only.`,
        'And what is their account code? Answer with the code only.',
      ],
      verdict: (runs) => {
        const stopped = incomplete(runs);
        if (stopped) return stopped;
        if (!runs[0].toolCalls.includes(RECORD)) return `${RECORD} was not called in turn 1`;
        if (runs[1].toolCalls.includes(RECORD)) return `turn 2 called ${RECORD} again (a re-fetch)`;
        return has(runs[1].result?.text, 'QX-4471') ? undefined : 'turn 2 does not answer QX-4471';
      },
    },
    resume: { direct: resumeCase },
    reflection: { direct: reflectionCase },
    memory: { direct: memoryCase },
    vision: { direct: visionCase },
    callonly: { direct: callOnlyCase },
  };
}

/** The session case at another reasoning setting. */
function sessionLike(base: Record<string, unknown>, reasoning: unknown): TurnSpec {
  return {
    agent: { ...base, tools: [TOOL], reasoning },
    turns: [
      `Call ${TOOL} with the key "alpha" and tell me the number.`,
      `Now call ${TOOL} with the key "beta" and add it to the number from before. Answer with the sum only.`,
    ],
    verdict: (runs) => {
      const stopped = incomplete(runs);
      if (stopped) return stopped;
      if (!runs.every((r) => r.toolCalls.includes(TOOL))) return `${TOOL} was not called on every turn`;
      return has(runs[1].result?.text, '42') ? undefined : 'the second turn does not answer 42';
    },
  };
}

/** A fresh store holding the session's events as the Supabase store keeps them (trimEventForStorage). */
async function trimmedStore(store: InProcessSessionService, key: { appName: string; userId: string; sessionId: string }): Promise<InProcessSessionService> {
  const held = await store.get(key);
  const next = new InProcessSessionService();
  const session = await next.create(key);
  for (const event of held?.events ?? []) await next.append(session, trimEventForStorage(event as TurnEvent) as TurnEvent);
  return next;
}

// ── The direct cases ────────────────────────────────────────────────────────

const LOOKUP_DECLARATION = {
  name: TOOL,
  description: 'Returns the number stored under a key.',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
};

const userMessage = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] });

/**
 * Runs `messages` on `adapter` until it answers without a call (at most four
 * steps), answering each lookup; returns the history, the answer, and the calls made.
 */
async function loop(adapter: ModelAdapter, model: string, messages: Message[], steps = 4): Promise<{ messages: Message[]; text: string; error?: string; calls: number }> {
  let calls = 0;
  for (let i = 0; i < steps; i++) {
    let final: { parts: AssistantMessage['parts']; error?: { code: string; message: string } } | undefined;
    calls++;
    for await (const r of adapter.generate({ model, messages, tools: [LOOKUP_DECLARATION], reasoning: 'low' })) if (!r.partial) final = r;
    if (!final) return { messages, text: '', error: 'no final', calls };
    if (final.error) return { messages, text: '', error: `${final.error.code}: ${scrub(final.error.message).slice(0, ERROR_MAX)}`, calls };
    const assistant: AssistantMessage = { role: 'assistant', parts: final.parts };
    messages = [...messages, assistant];
    const toolCalls = final.parts.filter((p) => p.type === 'toolCall');
    if (!toolCalls.length) {
      const text = final.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
      return text.includes(PROJECTION_MARKER) ? { messages, text, error: 'the answer wrote a tool record as text', calls } : { messages, text, calls };
    }
    const results: ToolMessage = {
      role: 'tool',
      parts: toolCalls.map((c) => ({ type: 'toolResult', id: c.id, name: c.name, result: { result: lookupValue(String((c.args as { key?: unknown }).key ?? '')) } })),
    };
    messages = [...messages, results];
  }
  return { messages, text: '', error: 'no answer within the step limit', calls };
}

/** Messages as the Supabase store would give them back: through genai contents and trimEventForStorage. */
function throughTrim(messages: Message[]): Message[] {
  const { contents } = messagesToContents({ messages });
  const stored = contents.map((content) => trimEventForStorage({ content } as unknown as TurnEvent).content);
  return contentsToMessages(stored as never).messages;
}

async function resumeCase(model: string): Promise<{ failure?: string; calls: number }> {
  const adapter = new GeminiAdapter({ model });
  const first = await loop(adapter, model, [userMessage(`Call ${TOOL} with the key "alpha" and tell me the number.`)]);
  if (first.error) return { failure: `turn 1: ${first.error}`, calls: first.calls };
  // Turn 2's first step only: its call, answered, and then the turn is paused and read back.
  const ask = userMessage(`Now call ${TOOL} with the key "beta" and add it to the number from before. Answer with the sum only.`);
  const step = await loop(adapter, model, [...first.messages, ask], 1);
  const calls = first.calls + step.calls;
  const last = step.messages.at(-1);
  if (last?.role !== 'tool') return { failure: step.error ?? 'turn 2 made no call to pause on', calls };
  const resumed = throughTrim(step.messages);
  const sentinel = JSON.stringify(resumed).includes(PLACEHOLDER_THOUGHT_SIGNATURE);
  if (!sentinel) return { failure: 'the trimmed current turn holds no placeholder (the case tests nothing)', calls };
  const rest = await loop(adapter, model, resumed);
  if (rest.error) return { failure: `resumed turn: ${rest.error}`, calls: calls + rest.calls };
  return { failure: has(rest.text, '42') ? undefined : 'the resumed turn does not answer 42', calls: calls + rest.calls };
}

async function reflectionCase(model: string): Promise<{ failure?: string; calls: number }> {
  const adapter = new GeminiAdapter({ model });
  // As the step stores it (ADR 0103): the reflection call in the model's place, signed with
  // the placeholder (a MALFORMED_FUNCTION_CALL response has no signature), and its guidance.
  const id = 'adk_handle_model_error_00000000-0000-4000-8000-000000000000';
  const contents = [
    { role: 'user', parts: [{ text: `Call ${TOOL} with the key "alpha" and tell me the number.` }] },
    {
      role: 'model',
      parts: [{
        functionCall: { id, name: 'adk_handle_model_error', args: { response_type: 'ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN', error_type: 'MALFORMED_FUNCTION_CALL', error_details: 'Malformed function call.', finish_reason: 'MALFORMED_FUNCTION_CALL', retry_count: 1 } },
        thoughtSignature: PLACEHOLDER_THOUGHT_SIGNATURE,
      }],
    },
    {
      role: 'user',
      parts: [{ functionResponse: { id, name: 'adk_handle_model_error', response: { response_type: 'ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN', reflection_guidance: `Your previous response was malformed. Call ${TOOL} again with valid arguments.` } } }],
    },
  ];
  const run = await loop(adapter, model, contentsToMessages(contents as never).messages);
  if (run.error) return { failure: run.error, calls: run.calls };
  return { failure: has(run.text, '14') ? undefined : 'the answer is not 14', calls: run.calls };
}

async function callOnlyCase(model: string): Promise<{ failure?: string; calls: number }> {
  const adapter = new GeminiAdapter({ model });
  // Turn 1 ended on its tool result (the turn was stopped before the answer).
  const messages: Message[] = [
    userMessage(`Call ${TOOL} with the key "alpha".`),
    { role: 'assistant', parts: [{ type: 'toolCall', id: 'adk-1-0-lookup', name: TOOL, args: { key: 'alpha' } }] },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'adk-1-0-lookup', name: TOOL, result: { result: '14' } }] },
    userMessage(`Call ${TOOL} with the key "beta" and tell me the number.`),
  ];
  const run = await loop(adapter, model, messages);
  if (run.error) return { failure: run.error, calls: run.calls };
  return { failure: has(run.text, '28') ? undefined : 'the answer is not 28', calls: run.calls };
}

async function memoryCase(model: string): Promise<{ failure?: string; calls: number }> {
  const prompt = [
    'Extract the durable facts about the user from this transcript, one per line, as "- <fact>". Nothing else.',
    '',
    'User: I moved to Oslo last spring and I am allergic to penicillin.',
    'Assistant: Noted.',
  ].join('\n');
  try {
    const text = await modelExtractor({ model }).extract(prompt);
    return { failure: /oslo/i.test(text) && /penicillin/i.test(text) ? undefined : 'the extraction lost a fact', calls: 1 };
  } catch (err) {
    return { failure: scrub(err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX), calls: 1 };
  }
}

/** An 8x8 PNG of one colour, written without an image library. */
function solidPng(r: number, g: number, b: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 8 }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: 8 }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function visionCase(): Promise<{ failure?: string; calls: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-check-vision-'));
  const saved = process.env.OUTPUTS_DIR;
  process.env.OUTPUTS_DIR = dir;
  const log = console.log;
  console.log = () => {};
  try {
    writeFileSync(join(dir, 'red.png'), solidPng(220, 20, 20));
    const text = String(await (inspectImageContract as unknown as { execute: (a: { image_path: string }) => Promise<string> }).execute({ image_path: 'outputs/red.png' }));
    return { failure: /red/i.test(text) ? undefined : 'the inventory does not name the colour', calls: 1 };
  } catch (err) {
    return { failure: scrub(err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX), calls: 1 };
  } finally {
    console.log = log;
    if (saved === undefined) delete process.env.OUTPUTS_DIR;
    else process.env.OUTPUTS_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The summary call alone, on --model: a stored compaction from three short events. */
async function summaryCall(model: string): Promise<string | undefined> {
  const at = Date.now() / 1000;
  const events = [
    { id: 's1', author: 'user', timestamp: at, content: { role: 'user', parts: [{ text: 'My project is called Kestrel and ships on 2027-02-01.' }] } },
    { id: 's2', author: 'Checker', timestamp: at + 1, content: { role: 'model', parts: [{ text: 'Noted: Kestrel, shipping 2027-02-01.' }] } },
    { id: 's3', author: 'user', timestamp: at + 2, content: { role: 'user', parts: [{ text: 'We decided to drop the Windows build.' }] } },
  ] as unknown as TurnEvent[];
  try {
    const event = await summarize(events, new GeminiAdapter({ model }), model);
    return /kestrel/i.test(event.compactedContent ?? '') ? undefined : 'the summary lost the project name';
  } catch (err) {
    return `the summary call failed: ${scrub(err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX)}`;
  }
}

function syndicate(name: CaseName, agent: Record<string, unknown>): SyndicateYamlConfig {
  return validateSyndicateConfig(
    { syndicate_name: `gemini-check-${name}`, memory_system: 'internal-only', orchestrator: agent, subagents: [] },
    'gemini_engine_check',
  ) as SyndicateYamlConfig;
}

/** One case on one runtime, with GEMINI_ADAPTER=engine for its duration. */
async function runCase(name: CaseName, spec: CaseSpec, runtime: RuntimeName, model: string): Promise<{ failure?: string; runs: TurnRun[]; ms: number; calls?: number }> {
  const saved = process.env.GEMINI_ADAPTER;
  process.env.GEMINI_ADAPTER = 'engine';
  const t0 = Date.now();
  if ('direct' in spec) {
    try {
      const { failure, calls } = await spec.direct(model);
      return { failure, runs: [], ms: Date.now() - t0, calls };
    } finally {
      if (saved === undefined) delete process.env.GEMINI_ADAPTER;
      else process.env.GEMINI_ADAPTER = saved;
    }
  }
  let sessionService = new InProcessSessionService();
  const sessionId = `gemini-check-${name}-${runtime}-${Date.now()}`;
  const key = { appName: 'gemini-check', userId: 'gemini-check', sessionId };
  const runs: TurnRun[] = [];
  let preface: string | undefined;
  try {
    if (name === 'compaction') preface = await summaryCall(model);
    for (const [i, message] of spec.turns.entries()) {
      if (preface) break;
      if (i > 0 && spec.between) sessionService = await spec.between(sessionService, key);
      const config = syndicate(name, spec.models ? { ...spec.agent, model: spec.models[i] } : spec.agent);
      const run: TurnRun = { toolCalls: [], widestStep: 0, grounded: false, codeParts: 0 };
      const events: TurnEvents = {
        onEvent: (event) => {
          const e = event as any;
          if (e.groundingMetadata) run.grounded = true;
          let callsHere = 0;
          for (const part of e.content?.parts ?? []) {
            if (part?.functionResponse?.name) run.toolCalls.push(String(part.functionResponse.name));
            if (part?.functionCall?.name) callsHere++;
            if (part?.executableCode || part?.codeExecutionResult) run.codeParts += 1;
          }
          run.widestStep = Math.max(run.widestStep, callsHere);
        },
      };
      try {
        run.result = await runSyndicateTurn({
          config,
          parts: [{ text: message }],
          appName: 'gemini-check',
          userId: 'gemini-check',
          sessionId,
          sessionService,
          deadlineMs: TURN_DEADLINE_MS,
          runtime,
          trace: false,
          events,
        });
      } catch (err) {
        run.threw = scrub(err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX);
      }
      runs.push(run);
      if (run.threw || run.result?.status !== 'completed') break;
    }
  } finally {
    if (saved === undefined) delete process.env.GEMINI_ADAPTER;
    else process.env.GEMINI_ADAPTER = saved;
  }
  const failure = preface ?? (await spec.verdict(runs, sessionService, key));
  return { failure, runs, ms: Date.now() - t0 };
}

function parseArgs(argv: string[]): { model: string; cases: CaseName[]; runtimes: RuntimeName[] } | string {
  let model = DEFAULT_MODEL;
  let cases: CaseName[] = [...CASES];
  let runtimes: RuntimeName[] = [...RUNTIMES];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--model' && value) model = value;
    else if (flag === '--cases' && value) cases = value.split(',').map((c) => c.trim()) as CaseName[];
    else if (flag === '--runtimes' && value) runtimes = value.split(',').map((r) => r.trim()) as RuntimeName[];
    else return `unknown or incomplete argument: ${flag}`;
    i++;
  }
  if (providerForModel(model) !== 'gemini') return `--model must be a Gemini id, not ${model}`;
  const badCase = cases.find((c) => !CASES.includes(c));
  if (badCase) return `unknown case: ${badCase} (one of ${CASES.join(', ')})`;
  const badRuntime = runtimes.find((r) => !RUNTIMES.includes(r));
  if (badRuntime) return `unknown runtime: ${badRuntime} (native is the only runtime)`;
  return { model, cases, runtimes };
}

/** `readEnvFile: false` leaves .env unread (the offline test sets its own fixture env). */
export async function main(argv = process.argv.slice(2), options: { readEnvFile?: boolean } = {}): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    console.error(args);
    return 2;
  }
  if (options.readEnvFile !== false) loadEnv(import.meta.url);
  // The direct cases call the adapter outside a turn, and it traces each call: no
  // sink and no console span for them (a span carries a thinking preview).
  process.env.TELEMETRY_SUPABASE = 'false';
  process.env.TELEMETRY_POSTGRES = 'false';
  process.env.OTEL_CONSOLE_SPANS = 'false';
  setLogLevel('error');
  const gemini = providerStatuses().find((p) => p.provider === 'gemini');
  if (!gemini || gemini.transport !== 'direct') {
    console.error('No direct Gemini route: set GOOGLE_GENAI_API_KEY (or GEMINI_API_KEY), or GEMINI_PLATFORM=vertex.');
    return 2;
  }
  registerTool(TOOL, lookup, { override: true });
  registerTool(FLAKY, flaky, { override: true });
  registerTool(RECORD, record, { override: true });
  console.log(`Gemini ${args.model} · adapter GeminiAdapter (engine)`);
  const all = specs(args.model);
  let failed = 0;
  for (const name of args.cases) {
    for (const runtime of args.runtimes) {
      flakyCalls = 0;
      recordCalls = 0;
      const { failure, runs, ms, calls: direct } = await runCase(name, all[name], runtime, args.model);
      if (failure) failed++;
      const calls = direct ?? runs.reduce((n, r) => n + (r.result?.usage.llmCalls ?? 0), 0);
      const code = runs.reduce((n, r) => n + r.codeParts, 0);
      const grounded = runs.some((r) => r.grounded);
      const facts = `${calls} model calls, ${(ms / 1000).toFixed(1)}s${grounded ? ', grounded' : ''}${code ? `, ${code} code parts stored` : ''}`;
      console.log(`${failure ? 'FAIL' : 'pass'}  ${name.padEnd(10)} ${runtime.padEnd(7)} ${facts}${failure ? ` — ${failure}` : ''}`);
    }
  }
  return failed ? 1 : 0;
}

function isMain(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = await main();
