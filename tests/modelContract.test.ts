/**
 * tests/modelContract.test.ts — the engine's own model contract
 * (lib/models/contract.ts, ADR 0048).
 *
 * Two things are asserted:
 *   - A whole tool loop can be written in the contract alone, and it
 *     type-checks (`npx tsc --noEmit` covers this file): a request with a
 *     tool, a response that calls it, the toolResult follow-up, and the
 *     final answer, against a scripted adapter. The `@ts-expect-error` lines
 *     pin shapes the contract refuses.
 *   - The contract is a leaf: neither it nor any module it imports names an
 *     @google/* specifier, and the loader depends on it, never the reverse.
 *
 * Offline: the adapter is a script, so no provider is called.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  FinalModelResponse,
  Message,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  Part,
  ProviderCapabilities,
  ReasoningSetting,
  ToolCallPart,
  ToolDeclaration,
  ToolResultPart,
  Usage,
} from '../lib/models/contract.ts';
import type { ReasoningSetting as LoaderReasoningSetting } from '../lib/loadSyndicate.ts';
import { providerStateOf } from '../lib/models/providerState.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── A scripted adapter ───────────────────────────────────────────────────────

/** Yields one scripted call per generate(), and records each request it was sent. */
class ScriptedAdapter implements ModelAdapter {
  readonly provider = 'anthropic';
  readonly model = 'claude-sonnet-5-5';
  readonly requests: ModelRequest[] = [];
  readonly #calls: ModelResponse[][];

  constructor(calls: ModelResponse[][]) {
    this.#calls = calls;
  }

  async *generate(request: ModelRequest): AsyncIterable<ModelResponse> {
    // A copy of the messages as sent: the loop goes on appending to its own array.
    this.requests.push({ ...request, messages: [...request.messages] });
    const call = this.#calls.shift();
    if (!call) {
      yield { partial: false, parts: [], finishReason: 'error', error: { code: 'SCRIPT_EXHAUSTED', message: 'no scripted call left', retryable: false } };
      return;
    }
    yield* call;
  }
}

// ── A loop written against the contract alone ────────────────────────────────

type ToolImpl = (args: Record<string, unknown>) => unknown;

interface LoopResult {
  final: FinalModelResponse;
  /** The text deltas, in order, as a printer would show them. */
  streamed: string;
  thinking: string;
  usage: Usage;
  messages: Message[];
}

/** The native runtime's loop, reduced to the contract: call, run tools, call again. */
async function runToolLoop(adapter: ModelAdapter, request: ModelRequest, impls: Record<string, ToolImpl>): Promise<LoopResult> {
  const messages: Message[] = [...request.messages];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  let streamed = '';
  let thinking = '';
  for (let step = 0; step < 8; step++) {
    let final: FinalModelResponse | undefined;
    for await (const response of adapter.generate({ ...request, messages })) {
      assert.equal(final, undefined, 'nothing follows the final response');
      if (response.partial) {
        for (const part of response.parts) {
          if (part.type === 'text') streamed += part.text;
          else thinking += part.text;
        }
        continue;
      }
      final = response;
    }
    assert.ok(final, 'every call ends with a final response');
    if (final.usage) {
      usage.inputTokens += final.usage.inputTokens;
      usage.outputTokens += final.usage.outputTokens;
      usage.thinkingTokens = (usage.thinkingTokens ?? 0) + (final.usage.thinkingTokens ?? 0);
    }
    if (final.error) return { final, streamed, thinking, usage, messages };

    messages.push({ role: 'assistant', parts: final.parts });
    const calls = final.parts.filter((p): p is ToolCallPart => p.type === 'toolCall');
    if (calls.length === 0) return { final, streamed, thinking, usage, messages };

    const results: ToolResultPart[] = calls.map((call) => {
      const impl = impls[call.name];
      if (!impl) return { type: 'toolResult', id: call.id, name: call.name, result: { error: `unknown tool ${call.name}` }, isError: true };
      return { type: 'toolResult', id: call.id, name: call.name, result: impl(call.args) };
    });
    messages.push({ role: 'tool', parts: results });
  }
  throw new Error('the loop did not finish in 8 steps');
}

// ── The fixtures ─────────────────────────────────────────────────────────────

const WEATHER: ToolDeclaration = {
  name: 'get_weather',
  description: 'Current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  strict: true,
};

const SIGNED = { provider: 'anthropic', kind: 'thinking_blocks', model: 'claude-sonnet-5-5', payload: [{ type: 'thinking', thinking: '', signature: 'sig-1' }] };

function weatherRequest(signal?: AbortSignal): ModelRequest {
  return {
    model: 'claude-sonnet-5-5',
    system: 'You answer weather questions. Use the tool.',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Weather in Oslo?' }] }],
    tools: [WEATHER],
    nativeTools: ['web_search'],
    toolChoice: 'auto',
    reasoning: 'low',
    sampling: { maxOutputTokens: 1024 },
    stream: true,
    ...(signal ? { signal } : {}),
  };
}

/** Step 1 asks for the tool; step 2 streams the answer. */
function weatherScript(): ModelResponse[][] {
  return [
    [
      { partial: true, parts: [{ type: 'thinking', text: 'Need the weather tool.' }] },
      {
        partial: false,
        parts: [{ type: 'toolCall', id: 'toolu_1', name: 'get_weather', args: { city: 'Oslo' }, providerState: SIGNED }],
        finishReason: 'tool_call',
        usage: { inputTokens: 120, outputTokens: 40, thinkingTokens: 25, cacheReadTokens: 100 },
      },
    ],
    [
      { partial: true, parts: [{ type: 'text', text: 'It is 14°C ' }] },
      { partial: true, parts: [{ type: 'text', text: 'in Oslo.' }] },
      {
        partial: false,
        parts: [{ type: 'text', text: 'It is 14°C in Oslo.' }],
        finishReason: 'stop',
        usage: { inputTokens: 180, outputTokens: 12 },
        grounding: { citations: [{ url: 'https://weather.example/oslo', title: 'Oslo', start: 0, end: 19 }], searchQueries: [{ tool: 'web_search', query: 'Oslo weather now' }] },
      },
    ],
  ];
}

// ── The tool loop ────────────────────────────────────────────────────────────

test('a tool loop runs in the contract: request, tool call, tool result, final answer', async () => {
  const adapter = new ScriptedAdapter(weatherScript());
  const ran: Array<Record<string, unknown>> = [];
  const result = await runToolLoop(adapter, weatherRequest(), {
    get_weather: (args) => {
      ran.push(args);
      return { tempC: 14, sky: 'clear' };
    },
  });

  assert.deepEqual(ran, [{ city: 'Oslo' }], 'the tool ran once with the model\'s arguments');
  assert.equal(adapter.requests.length, 2);

  // The follow-up carries the call and its result, ids matched.
  const followUp = adapter.requests[1].messages;
  assert.deepEqual(followUp.map((m) => m.role), ['user', 'assistant', 'tool']);
  const [call] = followUp[1].parts;
  const [answer] = followUp[2].parts;
  assert.equal(call.type, 'toolCall');
  assert.equal(answer.type, 'toolResult');
  assert.ok(call.type === 'toolCall' && answer.type === 'toolResult');
  assert.equal(answer.id, call.id);
  assert.equal(answer.name, call.name);
  assert.deepEqual(answer.result, { tempC: 14, sky: 'clear' });

  // The reasoning state rode on the call into the next request, readable only by its writer (ADR 0046).
  assert.deepEqual(providerStateOf(call, 'anthropic', 'thinking_blocks', 'claude-sonnet-5-5')?.payload, SIGNED.payload);
  assert.equal(providerStateOf(call, 'anthropic', 'thinking_blocks', 'claude-opus-5-5'), undefined, 'another model skips it');
  assert.equal(providerStateOf(call, 'openai', 'thinking_blocks'), undefined, 'another provider skips it');

  // The same tools, choice and reasoning travel on every step.
  assert.deepEqual(adapter.requests[1].tools, [WEATHER]);
  assert.equal(adapter.requests[1].reasoning, 'low');

  // The answer: final text repeats the streamed deltas; thinking stayed out of history.
  assert.equal(result.final.finishReason, 'stop');
  assert.deepEqual(result.final.parts, [{ type: 'text', text: 'It is 14°C in Oslo.' }]);
  assert.equal(result.streamed, 'It is 14°C in Oslo.');
  assert.equal(result.thinking, 'Need the weather tool.');
  assert.ok(result.messages.every((m) => m.parts.every((p: Part) => p.type !== 'thinking')));
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 52, thinkingTokens: 25 });
  assert.deepEqual(result.final.grounding?.searchQueries, [{ tool: 'web_search', query: 'Oslo weather now' }]);
});

test('a failure is a final response with error set, never a throw', async () => {
  const adapter = new ScriptedAdapter([
    [{ partial: false, parts: [], finishReason: 'error', error: { code: 'MISSING_API_KEY', message: 'ANTHROPIC_API_KEY is not set in environment.', retryable: false } }],
  ]);
  const result = await runToolLoop(adapter, weatherRequest(), {});
  assert.equal(result.final.finishReason, 'error');
  assert.deepEqual(result.final.error, { code: 'MISSING_API_KEY', message: 'ANTHROPIC_API_KEY is not set in environment.', retryable: false });
});

test('a model that thought without answering ends in an error that keeps its usage (ADR 0027)', async () => {
  const adapter = new ScriptedAdapter([
    [
      { partial: true, parts: [{ type: 'thinking', text: 'Considering…' }] },
      {
        partial: false,
        parts: [],
        finishReason: 'max_tokens',
        usage: { inputTokens: 900, outputTokens: 4096, thinkingTokens: 4096 },
        error: { code: 'OLLAMA_MAX_TOKENS', message: 'qwen3.5:9b filled its context window while thinking', retryable: false },
      },
    ],
  ]);
  const result = await runToolLoop(adapter, weatherRequest(), {});
  assert.equal(result.final.error?.code, 'OLLAMA_MAX_TOKENS');
  assert.equal(result.final.finishReason, 'max_tokens');
  assert.equal(result.usage.outputTokens, 4096);
});

test('the abort signal reaches the adapter with the request', async () => {
  const controller = new AbortController();
  const adapter = new ScriptedAdapter(weatherScript());
  await runToolLoop(adapter, weatherRequest(controller.signal), { get_weather: () => ({ tempC: 14 }) });
  assert.ok(adapter.requests.every((r) => r.signal === controller.signal));
});

// ── Shapes the contract refuses (checked by tsc, never run) ──────────────────

function refusedShapes(): void {
  // @ts-expect-error a blob is inline or by URL, never both
  const both: Part = { type: 'blob', mimeType: 'image/png', data: 'iVBOR', url: 'https://example.com/a.png' };
  // @ts-expect-error a partial response carries deltas, never a tool call
  const partialCall: ModelResponse = { partial: true, parts: [{ type: 'toolCall', id: 'c', name: 'n', args: {} }] };
  // @ts-expect-error a final response never carries thinking
  const finalThinking: ModelResponse = { partial: false, parts: [{ type: 'thinking', text: 't' }], finishReason: 'stop' };
  // @ts-expect-error a tool message holds tool results only
  const toolText: Message = { role: 'tool', parts: [{ type: 'text', text: 'done' }] };
  // @ts-expect-error a user message holds no tool calls
  const userCall: Message = { role: 'user', parts: [{ type: 'toolCall', id: 'c', name: 'n', args: {} }] };
  // @ts-expect-error a final response says why the model stopped
  const noReason: ModelResponse = { partial: false, parts: [] };
  // @ts-expect-error native tools are named from the engine's list
  const unknownNative: ModelRequest = { model: 'm', messages: [], nativeTools: ['file_search'] };
  void [both, partialCall, finalThinking, toolText, userCall, noReason, unknownNative];
}
void refusedShapes;

test('ReasoningSetting is the contract\'s type, re-exported by the loader', () => {
  const fromLoader: LoaderReasoningSetting = { budget_tokens: 4096 };
  const fromContract: ReasoningSetting = fromLoader;
  const back: LoaderReasoningSetting = fromContract;
  assert.deepEqual(back, { budget_tokens: 4096 });
});

test('ProviderCapabilities states one path\'s capabilities, field by matrix column', () => {
  // Claude on its own API today (lib/models/capabilities.ts), stated in the contract's terms.
  const claude: ProviderCapabilities = {
    tools: { support: 'supported' },
    outputSchema: { support: 'supported', note: 'sent as a forced tool call; with a thinking budget the tool is offered under tool_choice auto' },
    reasoningState: { support: 'supported' },
    streaming: { support: 'supported' },
    blobs: { support: 'unsupported', note: 'image parts are dropped from the request', mimeTypes: [], urls: false, outsideUserTurns: false },
    nativeTools: { web_search: { support: 'supported' } },
    toolChoice: ['auto', 'none'],
    reasoning: 'budget',
    sampling: ['maxOutputTokens'],
  };
  assert.equal(claude.nativeTools.x_search, undefined, 'a native tool not listed is dropped');
});

// ── The leaf ─────────────────────────────────────────────────────────────────

/**
 * The source with its comments blanked out. String and template literals are
 * kept whole, so a `//` inside a URL stays code; the files walked here put
 * no quote inside a regex literal before their imports.
 */
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** import/export ... from '<s>', import '<s>', import('<s>') and require('<s>'). */
const SPECIFIER = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1|\bimport\s*(['"])([^'"]+)\3|\b(?:import|require)\s*\(\s*(['"])([^'"]+)\5\s*\)/g;

/** The module specifiers a source file names, comments excluded. */
function specifiersOf(file: string): string[] {
  const code = stripComments(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
  return [...code.matchAll(SPECIFIER)].map((m) => m[2] ?? m[4] ?? m[6]);
}

/** Every module reachable from `entry` through relative specifiers, with the specifiers each one names. */
function importGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [path.resolve(ROOT, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (graph.has(file)) continue;
    const specifiers = specifiersOf(file);
    graph.set(file, specifiers);
    for (const spec of specifiers) {
      if (spec.startsWith('.')) pending.push(path.resolve(path.dirname(file), spec));
    }
  }
  return graph;
}

test('the contract and every module it imports name no @google/* specifier', () => {
  const graph = importGraph('lib/models/contract.ts');
  const files = [...graph.keys()].map((f) => path.relative(ROOT, f)).sort();
  assert.deepEqual(files, ['lib/models/contract.ts', 'lib/models/providerState.ts']);
  const google = [...graph].flatMap(([file, specs]) => specs.filter((s) => s.includes('@google/')).map((s) => `${path.relative(ROOT, file)} → ${s}`));
  assert.deepEqual(google, []);
  assert.deepEqual([...graph.values()].flat().filter((s) => !s.startsWith('.')), [], 'a leaf imports no package');
});

test('the specifier scan sees real imports and skips comments (control)', () => {
  assert.ok(specifiersOf('lib/models/claudeLlm.ts').includes('@google/adk'));
  // providerState.ts names @google/genai in its comments only.
  assert.ok(fs.readFileSync(path.resolve(ROOT, 'lib/models/providerState.ts'), 'utf8').includes('@google/genai'));
  assert.deepEqual(specifiersOf('lib/models/providerState.ts'), []);
});

test('the loader depends on the contract, never the reverse', () => {
  assert.ok(specifiersOf('lib/loadSyndicate.ts').includes('./models/contract.ts'));
  assert.ok(!importGraph('lib/models/contract.ts').has(path.resolve(ROOT, 'lib/loadSyndicate.ts')));
});
