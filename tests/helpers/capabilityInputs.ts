/**
 * tests/helpers/capabilityInputs.ts — the requests the capability matrix is
 * checked with (tests/capabilityMatrix.test.ts), written as ModelRequests on
 * the engine's contract (lib/models/contract.ts), and the harness that
 * captures the body an adapter posts for one.
 *
 * The same inputs drive the ADK path's shim classes in
 * tests/shimBodies.test.ts, which asserts that each sends the body its
 * contract adapter sends, so a matrix cell proven on the contract holds on
 * the ADK path too.
 *
 * Offline: globalThis.fetch is replaced by a stub that records the request
 * and answers 400, so no provider is called and no SDK retries, or answers
 * with Gemini's JSON where a Gemini cell's claim covers the answer. Keys are
 * fixture values set for the duration of each capture.
 *
 * The Gemini row's inputs (the end of this file) go through the engine's own
 * GeminiAdapter on the real @google/genai client (ADR 0100).
 */

import assert from 'node:assert';
import { AgentTool, LlmAgent } from '@google/adk';

import type { MatrixRow } from '../../lib/models/capabilities.ts';
import type {
  FinalModelResponse,
  Message,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ProviderState,
  ToolDeclaration,
} from '../../lib/models/contract.ts';
import { ClaudeAdapter } from '../../lib/models/claudeAdapter.ts';
import { GeminiAdapter } from '../../lib/models/geminiAdapter.ts';
import { GEMINI_PROVIDER, THOUGHT_SIGNATURE_KIND } from '../../lib/models/geminiState.ts';
import { GptAdapter } from '../../lib/models/gptAdapter.ts';
import { GrokAdapter } from '../../lib/models/grokAdapter.ts';
import { KimiAdapter } from '../../lib/models/kimiAdapter.ts';
import { OllamaAdapter } from '../../lib/models/ollamaAdapter.ts';
import { GatewayAdapter } from '../../lib/models/gatewayAdapter.ts';
import { contractToolDeclaration } from '../../lib/models/schemaNormalize.ts';
import { resolveTools } from '../../lib/toolRegistry.ts';

export type AdapterRow = Exclude<MatrixRow, 'gemini'>;

export const FAKE_ENV: Record<AdapterRow, Record<string, string>> = {
  anthropic: { ANTHROPIC_API_KEY: 'fixture-ant-test-0123456789abcdef' }, // gitleaks:allow (test fixture)
  openai: { OPENAI_API_KEY: 'fixture-openai-0123456789abcdef' }, // gitleaks:allow (test fixture)
  xai: { XAI_API_KEY: 'fixture-xai-0123456789abcdef' }, // gitleaks:allow (test fixture)
  moonshot: { MOONSHOT_API_KEY: 'fixture-moonshot-0123456789abcdef' }, // gitleaks:allow (test fixture)
  ollama: {},
  gateway: { MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'fixture-gateway-0123456789abcdef' }, // gitleaks:allow (test fixture)
};

/** The env vars any capture touches, cleared so a developer's real keys or endpoints never route a test. */
const ALL_ENV = [
  ...new Set(Object.values(FAKE_ENV).flatMap((e) => Object.keys(e))),
  'MODEL_GATEWAY_BASE_URL',
  'MODEL_GATEWAY_MODEL_MAP',
  'ANTHROPIC_PLATFORM',
  'ANTHROPIC_BASE_URL',
  'OPENAI_PLATFORM',
  'OPENAI_BASE_URL',
  'MOONSHOT_BASE_URL',
  'OLLAMA_BASE_URL',
  'GOOGLE_GENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_PLATFORM',
  'GEMINI_MODEL_MAP',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'MODEL_RETRY_MAX_ATTEMPTS',
];

export const MODEL: Record<AdapterRow, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5-mini',
  xai: 'grok-4.5',
  moonshot: 'kimi-k3',
  ollama: 'ollama/qwen3:8b',
  // A provider whose direct key is absent, so the gateway serves it.
  gateway: 'claude-sonnet-4-6',
};

/**
 * The anthropic row's per-generation cells (ADR 0049) are checked on a second
 * id too: one that takes adaptive thinking, structured outputs and drop_block.
 */
export const ANTHROPIC_CURRENT = 'claude-opus-5-5';

/** The row's contract adapter, built inside the capture so it reads the capture's env. */
export function adapterFor(row: AdapterRow, model = MODEL[row]): ModelAdapter {
  switch (row) {
    case 'anthropic':
      return new ClaudeAdapter({ model });
    case 'openai':
      return new GptAdapter({ model });
    case 'xai':
      return new GrokAdapter({ model });
    case 'moonshot':
      return new KimiAdapter({ model });
    case 'ollama':
      return new OllamaAdapter({ model });
    case 'gateway':
      return new GatewayAdapter({ model });
  }
}

/**
 * Gemini's fixture key, for both Gemini paths: the engine's GeminiAdapter,
 * which the matrix's Gemini row is asserted on (ADR 0100), and the ADK path's
 * Gemini (tests/shimBodies.test.ts).
 */
export const GEMINI_ENV = { GOOGLE_GENAI_API_KEY: 'fixture-genai-0123456789abcdef' }; // gitleaks:allow (test fixture)

/** One request an adapter posted: where it went and its JSON body. */
export interface PostedRequest {
  url: string;
  body: any;
}

/** The fetch reply to the request at `index` among a capture's requests. */
export type Reply = (index: number, url: string) => Response;

/** The default reply: a 400, which every adapter reports as an error final and no SDK retries. */
const rejected: Reply = () =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'captured' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Runs `send` with the row's fixture env (every other key cleared) and fetch
 * stubbed to answer with `reply` (default a 400); returns every request
 * posted and everything `send` yielded. A call that throws (ADK's Gemini
 * throws the 400) is drained like one that yields its error.
 */
export async function captureExchange<T>(
  row: AdapterRow | 'gemini',
  send: () => AsyncIterable<T>,
  reply: Reply = rejected,
): Promise<{ requests: PostedRequest[]; yielded: T[] }> {
  const saved = Object.fromEntries(ALL_ENV.map((k) => [k, process.env[k]]));
  for (const k of ALL_ENV) delete process.env[k];
  Object.assign(process.env, row === 'gemini' ? GEMINI_ENV : FAKE_ENV[row]);
  const originalFetch = globalThis.fetch;
  const requests: PostedRequest[] = [];
  const yielded: T[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const url = input instanceof Request ? input.url : String(input);
    if (typeof raw === 'string') requests.push({ url, body: JSON.parse(raw) });
    return reply(requests.length - 1, url);
  }) as any;
  try {
    for await (const value of send()) yielded.push(value);
  } catch {
    // ADK's Gemini throws the 400; the body is what is asserted
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of ALL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return { requests, yielded };
}

/** Runs `send` against a 400 (captureExchange) and returns the first JSON body it posted. */
export async function captureBody(row: AdapterRow | 'gemini', send: () => AsyncIterable<unknown>): Promise<any> {
  const { requests } = await captureExchange(row, send);
  assert.ok(requests[0], `${row}: the adapter sent no request`);
  return requests[0].body;
}

/** Sends one request through the row's contract adapter (for `model`, default the row's) and returns the JSON body it posted. */
export function capture(row: AdapterRow, req: ModelRequest, stream = false, model?: string): Promise<any> {
  const request: ModelRequest = { ...req, model: model ?? req.model, stream };
  return captureBody(row, () => adapterFor(row, request.model).generate(request));
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export function request(row: AdapterRow, overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: MODEL[row],
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  };
}

/** The structured-output schema, in the contract's lowercase dialect. */
export const SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
};

/** A declaration from a real tool object, as the genai mapping reads a toolsDict entry. */
function declared(tool: unknown): ToolDeclaration {
  const declaration = contractToolDeclaration(tool);
  assert.ok(declaration, 'the tool declares a function');
  return declaration;
}

/** A real ADK AgentTool and the registry's load_memory: what a syndicate that delegates and declares memory sends. */
export function delegationTools(): ToolDeclaration[] {
  const sub = new LlmAgent({ name: 'Scout', description: 'Finds things', model: 'gemini-3.5-flash-lite', instruction: 'x' });
  return [declared(new AgentTool({ agent: sub })), declared(resolveTools(['load_memory'])[0])];
}

export function withDelegationTools(row: AdapterRow): ModelRequest {
  return request(row, { tools: delegationTools() });
}

/** The signed block Claude returned before its tool call, as the adapter stores it (ADR 0046). */
export const SIGNED_THINKING = { type: 'thinking', thinking: 'I should ask Scout.', signature: 'sig-fixture-0123' };

/** The reasoning item a Responses model returned before its function call (ADR 0046). */
export const REASONING_ITEM = {
  type: 'reasoning',
  id: 'rs_fixture_1',
  summary: [{ type: 'summary_text', text: 'I should ask Scout.' }],
  encrypted_content: 'enc-fixture-0123',
};

/** The reasoning_content Kimi returned before its tool call, as the adapter stores it (ADR 0046). */
export const KIMI_REASONING = 'Scout will know; ask it.';

type Dialect = 'anthropic' | 'responses' | 'chat';
export const DIALECT: Record<AdapterRow, Dialect> = {
  anthropic: 'anthropic',
  openai: 'responses',
  xai: 'responses',
  moonshot: 'chat',
  ollama: 'chat',
  gateway: 'chat',
};

/**
 * The state the row's own adapter wrote on the call: reasoning items on the
 * Responses rows, reasoning_content on Moonshot, Anthropic's signed block
 * everywhere else (which the other chat-completions adapters must ignore).
 */
function stateOnCall(row: AdapterRow): ProviderState {
  if (DIALECT[row] === 'responses') return { provider: row, kind: 'reasoning_items', model: MODEL[row], payload: [REASONING_ITEM] };
  if (row === 'moonshot') return { provider: 'moonshot', kind: 'reasoning_content', model: MODEL.moonshot, payload: KIMI_REASONING };
  return { provider: 'anthropic', kind: 'thinking_blocks', payload: [SIGNED_THINKING] };
}

/**
 * A thinking agent mid tool loop: a prior assistant turn with thought and
 * call, then the result. The call carries the reasoning state its step
 * produced. The reasoning is the low level, which every row's wire can say.
 */
export function thinkingToolLoop(row: AdapterRow, reasoning: ModelRequest['reasoning'] = 'low'): ModelRequest {
  const messages: Message[] = [
    { role: 'user', parts: [{ type: 'text', text: 'look it up' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'thinking', text: 'I should ask Scout.' },
        { type: 'toolCall', id: 'call_1', name: 'Scout', args: { request: 'find it' }, providerState: stateOnCall(row) },
      ],
    },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'call_1', name: 'Scout', result: { result: 'found' } }] },
  ];
  return { ...withDelegationTools(row), messages, reasoning };
}

/** A user turn with a PNG beside the text. */
export function visionRequest(row: AdapterRow): ModelRequest {
  return request(row, {
    messages: [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'what is this?' },
          { type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
      },
    ],
  });
}

// ── Gemini (ADR 0100) ────────────────────────────────────────────────────────
//
// The matrix's Gemini row is asserted on the engine's own GeminiAdapter
// (lib/models/geminiAdapter.ts), on the real @google/genai client over the
// stubbed fetch, so the body is the JSON that would reach the Gemini API.
// Where a cell's claim is about the answer too (grounding, carried parts,
// signatures, usage), the stub answers with Gemini's JSON and the final the
// adapter makes of it is asserted.

/** The Gemini 3 id the row is checked with; reasoning maps to a thinkingLevel on it. */
export const GEMINI_MODEL = 'gemini-3.5-flash';

/** A Gemini 2.x id, which takes a thinking budget only. */
export const GEMINI_BUDGET_MODEL = 'gemini-2.5-flash';

/** The thought signature Gemini returned on a call, as the adapter stores it (ADR 0046). */
export const GEMINI_SIGNATURE = 'c2lnLWZpeHR1cmU=';

export function geminiRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { model: GEMINI_MODEL, messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], ...overrides };
}

/** One Gemini response: a candidate with `parts`, its finish reason, any other candidate field (grounding), and usage. */
export function geminiCandidate(parts: object[], extra: { finishReason?: string; usageMetadata?: object; [k: string]: unknown } = {}): object {
  const { finishReason = 'STOP', usageMetadata, ...candidate } = extra;
  return {
    candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}), ...candidate }],
    ...(usageMetadata ? { usageMetadata } : {}),
  };
}

/** Gemini's JSON answer for the request at each index (the last repeats), or one SSE stream of all of them when `stream` is set. */
export function geminiReply(responses: object | object[], stream = false): Reply {
  const list = Array.isArray(responses) ? responses : [responses];
  return (index) => {
    if (stream) {
      const sse = list.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(list[Math.min(index, list.length - 1)]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** What one GeminiAdapter call posted and yielded. */
export interface GeminiExchange {
  url: string;
  body: any;
  partials: ModelResponse[];
  final: FinalModelResponse;
}

/**
 * Sends `req` through a GeminiAdapter on the real client (the fixture key,
 * the Gemini API) and returns the request it posted and what it yielded.
 * Without `responses` the stub answers 400 and only the request matters.
 */
export async function geminiExchange(req: ModelRequest, responses?: object | object[]): Promise<GeminiExchange> {
  const reply = responses === undefined ? undefined : geminiReply(responses, req.stream === true);
  const { requests, yielded } = await captureExchange('gemini', () => new GeminiAdapter({ model: req.model }).generate(req), reply);
  assert.equal(requests.length, 1, 'gemini: one request per call');
  const final = yielded.at(-1);
  assert.ok(final && !final.partial, 'gemini: the call ends on one final');
  return { url: requests[0].url, body: requests[0].body, partials: yielded.filter((r) => r.partial), final };
}

/** The Gemini function declaration named `name` in a request body. */
export function geminiDeclaration(body: any, name: string): any {
  return (body.tools ?? []).flatMap((t: any) => t.functionDeclarations ?? []).find((d: any) => d.name === name);
}

/**
 * A thinking Gemini agent mid tool loop: Scout was called with the signature
 * Gemini returned on the call, and answered. The call id is the engine's, so
 * it stays off the wire.
 */
export function geminiThinkingToolLoop(reasoning: ModelRequest['reasoning'] = 'low', model = GEMINI_MODEL): ModelRequest {
  const signed: ProviderState = { provider: GEMINI_PROVIDER, kind: THOUGHT_SIGNATURE_KIND, model, payload: GEMINI_SIGNATURE };
  const messages: Message[] = [
    { role: 'user', parts: [{ type: 'text', text: 'look it up' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'thinking', text: 'I should ask Scout.' },
        { type: 'toolCall', id: 'adk-1-0-Scout', name: 'Scout', args: { request: 'find it' }, providerState: signed },
      ],
    },
    { role: 'tool', parts: [{ type: 'toolResult', id: 'adk-1-0-Scout', name: 'Scout', result: { result: 'found' } }] },
  ];
  return { model, tools: delegationTools(), messages, reasoning };
}
