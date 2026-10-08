/**
 * tests/nativeLedgerCounts.test.ts — what a native turn writes to the ledger
 * for each provider family's usage, and for a Responses adapter's
 * server-side tool calls. Offline: scripted adapters yield the finals each
 * real adapter's mapping makes from a provider's reply.
 *
 * TOKEN COUNTS (ADR 0107, "One output meaning on the ledger"). Every
 * provider's call is recorded in one meaning: `output_tokens` excludes the
 * thinking, `thinking_tokens` carries it, so output + thinking is the
 * provider's own output count. A provider that reports no split (Anthropic,
 * Ollama) has its whole output count in `output_tokens` and 0 thinking.
 *
 * SERVER-SIDE TOOLS. A Grok or GPT answer that searched carries its
 * server-side calls on the stored final's customMetadata, the root span
 * records each as a ToolCall event, and the adk_turns row counts them.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { chatUsage } from '../lib/models/chatCompletionsAdapter.ts';
import type { ModelResponse, Usage } from '../lib/models/contract.ts';
import { usageFromMetadata } from '../lib/models/genaiMapping.ts';
import { responsesUsage } from '../lib/models/gptAdapter.ts';
import { GrokAdapter } from '../lib/models/grokAdapter.ts';
import { flushTracing, onSpanEnd } from '../lib/observability/tracer.ts';
import { toTelemetryRow, toTurnRow } from '../lib/observability/supabaseSpanExporter.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { ScriptedModel, answer } from './helpers/scriptedModel.ts';

const config = {
  syndicate_name: 'ledger-counts',
  orchestrator: { name: 'Solo', model: 'scripted/solo', instruction: 'Answer briefly.' },
  subagents: [],
} as unknown as SyndicateYamlConfig;

let turn = 0;

/** One traced native turn on `model`: the stored events, the llm.request span and the root span. */
async function tracedTurn(model: ScriptedModel) {
  const spans: ReadableSpan[] = [];
  const off = onSpanEnd((s) => spans.push(s));
  const sessions = new InProcessSessionService();
  const sessionId = `s${++turn}`;
  try {
    const r = await runSyndicateTurn({
      config,
      parts: [{ text: 'go' }],
      appName: 'ledger-counts',
      userId: 'u',
      sessionId,
      sessionService: sessions,
      compile: { resolveModel: () => model },
      trace: { syndicateName: `ledger-counts-${turn}` },
    });
    assert.equal(r.status, 'completed', r.error?.message);
    await flushTracing();
  } finally {
    off();
  }
  const root = spans.find((s) => s.name === `Syndicate Execution: ledger-counts-${turn}`);
  assert.ok(root, 'the root span');
  const llm = spans.find((s) => s.name === 'llm.request' && s.spanContext().traceId === root.spanContext().traceId);
  assert.ok(llm, 'the llm.request span');
  const session = await sessions.get({ appName: 'ledger-counts', userId: 'u', sessionId });
  return { root, llm, events: session?.events ?? [] };
}

/** [input, output, thinking] as the adk_telemetry row (llm.request) and the adk_turns row (root) hold them. */
async function ledgerCounts(provider: string, usage: Usage | undefined) {
  assert.ok(usage, 'the adapter mapped a usage');
  const { root, llm } = await tracedTurn(new ScriptedModel('scripted/solo', () => answer('done', usage), provider));
  const call = toTelemetryRow(llm);
  const row = toTurnRow(root);
  return {
    call: [call.input_tokens, call.output_tokens, call.thinking_tokens],
    turn: [row.input_tokens, row.output_tokens, row.thinking_tokens],
  };
}

// ── One output meaning, every provider family ────────────────────────────────

test('chat completions (Kimi, the gateway): output less reasoning_tokens, the reasoning on its own', async () => {
  const usage = chatUsage({ prompt_tokens: 12, completion_tokens: 40, total_tokens: 52, completion_tokens_details: { reasoning_tokens: 25 } });
  assert.deepEqual(await ledgerCounts('moonshot', usage), { call: [12, 15, 25], turn: [12, 15, 25] });
});

test('chat completions without a split (Ollama): the whole completion as output, no thinking', async () => {
  const usage = chatUsage({ prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 });
  assert.deepEqual(await ledgerCounts('ollama', usage), { call: [12, 40, 0], turn: [12, 40, 0] });
});

test('Responses (GPT, Grok): output less reasoning_tokens, the reasoning on its own', async () => {
  const usage = responsesUsage({ input_tokens: 12, output_tokens: 7, output_tokens_details: { reasoning_tokens: 4 } });
  assert.deepEqual(await ledgerCounts('openai', usage), { call: [12, 3, 4], turn: [12, 3, 4] });
});

test('Claude: Anthropic reports no split, so the whole output_tokens is output and thinking is 0', async () => {
  // ClaudeAdapter's usage for { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 }
  // (tests/claudeAdapter.test.ts): both caches inside the input, no thinkingTokens.
  const usage: Usage = { inputTokens: 170, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 10 };
  assert.deepEqual(await ledgerCounts('anthropic', usage), { call: [170, 40, 0], turn: [170, 40, 0] });
});

test("Gemini: candidatesTokenCount and thoughtsTokenCount as Gemini reported them", async () => {
  const usage = usageFromMetadata({ promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 3 });
  assert.deepEqual(await ledgerCounts('gemini', usage), { call: [12, 4, 3], turn: [12, 4, 3] });
});

// ── Server-side tool calls ───────────────────────────────────────────────────

const XAI_OUTPUT = [
  {
    id: 'ws_1',
    type: 'web_search_call',
    status: 'completed',
    action: { type: 'search', query: 'NVDA close', sources: [{ type: 'url', url: 'https://a.example/x' }] },
  },
  { id: 'ct_1', type: 'custom_tool_call', status: 'completed', name: 'x_keyword_search', input: JSON.stringify({ query: 'NVDA', limit: '5' }) },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'NVDA closed down 0.4%.', annotations: [] }] },
];
const XAI_USAGE = {
  input_tokens: 100,
  output_tokens: 30,
  output_tokens_details: { reasoning_tokens: 10 },
  num_server_side_tools_used: 2,
  server_side_tool_usage_details: { web_search_calls: 1, x_search_calls: 1 },
};

test('a searched Grok answer: its server-side calls are ToolCall events on the root span, and the turn row counts them', async () => {
  const grok = new GrokAdapter({ model: 'grok-4.7' });
  // The final the adapter yields for this reply, carrying its server-side tool record.
  const final: ModelResponse = grok.finalOf({ output: XAI_OUTPUT, usage: XAI_USAGE }).final;
  const { root, events } = await tracedTurn(new ScriptedModel('scripted/solo', () => final, 'xai'));

  const stored = events.find((e) => e.author === 'Solo' && e.content);
  assert.deepEqual(stored?.customMetadata?.['responses.server_tool_calls'], [
    { name: 'web_search', args: { type: 'search', query: 'NVDA close' }, status: 'completed', sources: ['https://a.example/x'] },
    { name: 'x_keyword_search', args: { query: 'NVDA', limit: '5' }, status: 'completed' },
  ]);
  assert.deepEqual(stored?.customMetadata?.['responses.server_tool_usage'], { total: 2, web_search_calls: 1, x_search_calls: 1 });

  const row = toTurnRow(root);
  assert.equal(row.tool_calls, 2);
  assert.deepEqual(
    row.tool_events.map((e) => [e.name, e.tool]),
    [
      ['ToolCall', 'web_search'],
      ['ToolResponse', 'web_search'],
      ['ToolCall', 'x_keyword_search'],
    ],
  );
  assert.deepEqual([row.output_tokens, row.thinking_tokens], [20, 10]);
});

test('an answer with no server-side tools stores no server-side record', async () => {
  const grok = new GrokAdapter({ model: 'grok-4.7' });
  const plain = grok.finalOf({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 1, output_tokens: 1 } }).final;
  const { root, events } = await tracedTurn(new ScriptedModel('scripted/solo', () => plain, 'xai'));
  const stored = events.find((e) => e.author === 'Solo' && e.content);
  assert.equal(stored?.customMetadata, undefined);
  assert.equal(toTurnRow(root).tool_calls, 0);
});
