/**
 * tests/contextWindow.test.ts — the per-model window table, the default
 * threshold it gives, `context:` resolved, and what counts as an overflow
 * (ADR 0154). Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeCapabilities } from '../lib/models/capabilities.ts';
import { COMPACT_AT_SHARE, OLLAMA_DEFAULT_CONTEXT, UNKNOWN_WINDOW, compactAfterTokens, contextWindowOf } from '../lib/models/contextWindow.ts';
import { isContextOverflow } from '../lib/models/errorResponse.ts';
import { resolveContext } from '../lib/runtime/native/compaction.ts';
import { DEFAULT_KEEP_RECENT_EVENTS, DEFAULT_MASK_OVER_CHARS } from '../lib/runtime/native/history.ts';

test('each family reads its window from the id; an id the family does not name gets its newest row', () => {
  const cases: Array<[string, number | undefined]> = [
    ['claude-sonnet-5-5', 200_000],
    ['claude-next-year', 200_000],
    ['gpt-5.5', 400_000],
    ['gpt-4o-mini', 128_000],
    ['gpt-4.1', 1_047_576],
    ['o3', 200_000],
    ['gpt-7', 400_000],
    ['gemini-3.8-flash', 1_048_576],
    ['grok-4.7', 256_000],
    ['grok-3', 131_072],
    ['kimi-k3', 1_000_000],
    ['kimi-k2.6', 262_144],
    ['deepseek-flash', 1_000_000],
    ['jev-decider', undefined],
  ];
  for (const [model, window] of cases) assert.equal(contextWindowOf(model, {}), window, model);
});

test("Ollama's window is the server's: OLLAMA_CONTEXT_LENGTH, else Ollama's default", () => {
  assert.equal(contextWindowOf('ollama/qwen3:8b', {}), OLLAMA_DEFAULT_CONTEXT);
  assert.equal(contextWindowOf('ollama/qwen3:8b', { OLLAMA_CONTEXT_LENGTH: '16384' }), 16_384);
  assert.equal(contextWindowOf('ollama/qwen3:8b', { OLLAMA_CONTEXT_LENGTH: 'lots' }), OLLAMA_DEFAULT_CONTEXT);
});

test('the default threshold is 60% of the window, and 60% of the assumed window for a provider the table does not know', () => {
  assert.equal(compactAfterTokens('claude-sonnet-5-5', {}), 120_000);
  assert.equal(compactAfterTokens('ollama/qwen3:8b', {}), Math.round(OLLAMA_DEFAULT_CONTEXT * COMPACT_AT_SHARE));
  assert.equal(compactAfterTokens('jev-decider', {}), Math.round(UNKNOWN_WINDOW * COMPACT_AT_SHARE));
});

test('context: resolved: on by default from the model, off turns both off, 0 turns one off, explicit values pass', () => {
  assert.deepEqual(resolveContext(undefined, 'claude-sonnet-5-5'), {
    compactAfterTokens: 120_000,
    keepRecentEvents: DEFAULT_KEEP_RECENT_EVENTS,
    summaryModel: undefined,
    maskOverChars: DEFAULT_MASK_OVER_CHARS,
  });
  assert.deepEqual(resolveContext('off', 'claude-sonnet-5-5'), { compactAfterTokens: undefined, keepRecentEvents: DEFAULT_KEEP_RECENT_EVENTS, summaryModel: undefined, maskOverChars: 0 });
  assert.equal(resolveContext({ compact_after_tokens: 0 }, 'claude-sonnet-5-5').compactAfterTokens, undefined);
  assert.equal(resolveContext({ mask_over_chars: 0 }, 'claude-sonnet-5-5').maskOverChars, 0);
  assert.deepEqual(resolveContext({ compact_after_tokens: 9_000, keep_recent_events: 2, summary_model: 'x', mask_over_chars: 50 }, 'claude-sonnet-5-5'), {
    compactAfterTokens: 9_000,
    keepRecentEvents: 2,
    summaryModel: 'x',
    maskOverChars: 50,
  });
});

test('the capability report carries the window', () => {
  assert.equal(describeCapabilities('claude-sonnet-5-5').contextWindow, 200_000);
  assert.equal(describeCapabilities('jev-decider').contextWindow, undefined);
});

test("an overflow is a 400, 413 or status-less refusal in a provider's words; nothing else is", () => {
  const overflow = [
    'prompt is too long: 213463 tokens > 200000 maximum',
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    'Your input exceeds the context window of this model.',
    'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
    "This model's maximum prompt length is 131072 but the request contains 140000 tokens.",
    'Your request exceeded model token limit: 262144',
    'the request exceeds the available context size',
  ];
  for (const message of overflow) {
    assert.ok(isContextOverflow({ message, status: 400 }), message);
    assert.ok(isContextOverflow({ message }), `${message} (no status)`);
    assert.ok(!isContextOverflow({ message, status: 500 }), `${message} (a 500 is the provider's fault)`);
  }
  assert.ok(isContextOverflow({ message: 'request_too_large', status: 413 }));
  assert.ok(!isContextOverflow({ message: 'rate limit exceeded', status: 429 }));
  assert.ok(!isContextOverflow({ message: 'invalid api key', status: 401 }));
  assert.ok(!isContextOverflow({ message: 'max_tokens must be positive', status: 400 }));
  assert.ok(!isContextOverflow(undefined));
});
