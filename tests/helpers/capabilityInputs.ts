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
 * and answers 400, so no provider is called and no SDK retries. Keys are
 * fixture values set for the duration of each capture.
 */

import assert from 'node:assert';
import { AgentTool, LlmAgent } from '@google/adk';

import type { MatrixRow } from '../../lib/models/capabilities.ts';
import type { Message, ModelAdapter, ModelRequest, ProviderState, ToolDeclaration } from '../../lib/models/contract.ts';
import { ClaudeAdapter } from '../../lib/models/claudeAdapter.ts';
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

/** Gemini's fixture key, for the ADK path's Gemini (tests/shimBodies.test.ts); the matrix's Gemini cells are ADK's. */
export const GEMINI_ENV = { GOOGLE_GENAI_API_KEY: 'fixture-genai-0123456789abcdef' }; // gitleaks:allow (test fixture)

/**
 * Runs `send` with the row's fixture env (every other key cleared) and fetch
 * stubbed to answer 400; returns the first JSON body posted. A call that
 * throws on the 400 (ADK's Gemini does) is drained like one that yields it.
 */
export async function captureBody(row: AdapterRow | 'gemini', send: () => AsyncIterable<unknown>): Promise<any> {
  const saved = Object.fromEntries(ALL_ENV.map((k) => [k, process.env[k]]));
  for (const k of ALL_ENV) delete process.env[k];
  Object.assign(process.env, row === 'gemini' ? GEMINI_ENV : FAKE_ENV[row]);
  const originalFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (input: any, init: any) => {
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    if (body === undefined && typeof raw === 'string') body = JSON.parse(raw);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'captured' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as any;
  try {
    for await (const _ of send()) {
      // drain; the 400 surfaces as an error final, which is expected
    }
  } catch {
    // ADK's Gemini throws the 400; the body is what is asserted
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of ALL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  assert.ok(body, `${row}: the adapter sent no request`);
  return body;
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
