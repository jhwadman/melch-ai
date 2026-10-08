/**
 * tests/claudeCurrentApi.test.ts — the request Claude gets on each model
 * generation (lib/models/claudeModels.ts, ADR 0049), from a ModelRequest
 * through ClaudeAdapter (lib/models/claudeAdapter.ts), the adapter the
 * model step calls.
 *
 * Offline: tests/helpers/claudeCapture.ts stubs fetch, records the URL,
 * headers and body, and answers in the Messages API's own shape (a 400
 * unless a test scripts a reply), so no provider is called. The key is a
 * fixture.
 *
 * One id per generation: budget-era claude-sonnet-4-6 and claude-haiku-4-5;
 * adaptive-era claude-opus-5-5, claude-sonnet-5-5 and claude-fable-5-1, plus
 * the rows in between where their off switch or structured output differs.
 * The reasoning setting is the request's `reasoning`, the YAML's `reasoning:`
 * as written (ADR 0047).
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Content } from '@google/genai';
import type { TurnEvent } from '../lib/runtime/events.ts';

import { THINKING_STATE_KIND } from '../lib/models/claudeAdapter.ts';
import { claudeGeneration, THINKING_BINDING_BETA } from '../lib/models/claudeModels.ts';
import { capabilityOf, platformCell } from '../lib/models/capabilities.ts';
import { setSdkImporter } from '../lib/models/endpoints.ts';
import { contentsToMessages } from '../lib/models/genaiMapping.ts';
import type { FinalModelResponse, Message, ModelRequest } from '../lib/models/contract.ts';
import { trimEventForStorage } from '../lib/session/transcript.ts';
import { betas, captureClaude as capture } from './helpers/claudeCapture.ts';
import type { ClaudeCaptured as Captured } from './helpers/claudeCapture.ts';

const BUDGET_ERA = ['claude-sonnet-4-6', 'claude-haiku-4-5'];
const ADAPTIVE_ERA = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];

const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };

const hello: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }];

function request(model: string, extra: Partial<ModelRequest> = {}): ModelRequest {
  return { model, messages: hello, ...extra };
}

const DROP_BLOCK = { prefix_mismatch_behavior: 'drop_block' };
const ADAPTIVE_THINKING = { type: 'adaptive', display: 'summarized', block_binding: DROP_BLOCK };
const finalOf = (c: Captured) => c.out.at(-1) as FinalModelResponse;

// ── The table ────────────────────────────────────────────────────────────────

test('the generation table reads the model id; an id it does not know gets the newest row', () => {
  const rows: Record<string, string[]> = {
    budget: [
      'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-haiku-4.5-20251001', 'claude-opus-4-6',
      'claude-sonnet-4-5-20250929', 'claude-opus-4-1', 'claude-opus-4-20250514', 'claude-3-7-sonnet-latest', 'claude-3-opus-20240229', 'claude-sonnet-4.6',
    ],
    'opus-4.7': ['claude-opus-4-7'],
    'opus-4.8': ['claude-opus-4-8'],
    'sonnet-5': ['claude-sonnet-5'],
    'opus-5': ['claude-opus-5'],
    'fable-5': ['claude-fable-5', 'claude-mythos-5'],
    'haiku-5.5': ['claude-haiku-5-5'],
    'sonnet-5.5': ['claude-sonnet-5-5'],
    current: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-mythos-preview', 'claude-opus-6', 'claude-sonnet-x', 'claude-x'],
  };
  for (const [name, ids] of Object.entries(rows)) {
    for (const id of ids) assert.equal(claudeGeneration(id).name, name, id);
  }
});

// ── Thinking, effort, display ────────────────────────────────────────────────

test('budget era: `medium` is a thinking budget, with no effort, display or beta', async () => {
  for (const model of BUDGET_ERA) {
    const c = await capture(request(model, { reasoning: 'medium' }));
    assert.deepEqual(c.body.thinking, { type: 'enabled', budget_tokens: 8192 }, model);
    assert.equal(c.body.max_tokens, 8192 + 2048, model);
    assert.equal(c.body.output_config, undefined, model);
    assert.ok(!betas(c).includes(THINKING_BINDING_BETA), model);
    assert.ok(!c.url.includes('beta=true'), model);
  }
});

test('adaptive era: a level is adaptive thinking at that effort, summarized, under drop_block', async () => {
  for (const model of ADAPTIVE_ERA) {
    const c = await capture(request(model, { reasoning: 'medium' }));
    assert.deepEqual(c.body.thinking, ADAPTIVE_THINKING, model);
    assert.deepEqual(c.body.output_config, { effort: 'medium' }, model);
    // Thinking counts toward max_tokens: the floor the budget path would set.
    assert.equal(c.body.max_tokens, 8192 + 2048, model);
    assert.deepEqual(betas(c), [THINKING_BINDING_BETA], model);
    assert.ok(c.url.includes('/v1/messages?beta=true'), model);
    assert.ok(!('betas' in c.body), `${model}: the SDK turns betas into the header`);
  }
  const high = await capture(request('claude-opus-5-5', { reasoning: 'high' }));
  assert.deepEqual([high.body.output_config.effort, high.body.max_tokens], ['high', 16384 + 2048]);
  const budget = await capture(request('claude-opus-5-5', { reasoning: { budget_tokens: 5000 } }));
  assert.deepEqual([budget.body.output_config.effort, budget.body.max_tokens], ['medium', 5000 + 2048]);
});

test('`none` is each model\'s off switch at low effort, or low effort where it has none', async () => {
  for (const model of BUDGET_ERA) {
    const c = await capture(request(model, { reasoning: 'none' }));
    assert.ok(!('thinking' in c.body) && !('output_config' in c.body), model);
  }
  // No off switch: thinking stays on, at the lowest effort.
  for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
    const c = await capture(request(model, { reasoning: 'none' }));
    assert.deepEqual(c.body.thinking, ADAPTIVE_THINKING, model);
    assert.deepEqual(c.body.output_config, { effort: 'low' }, model);
  }
  // Sonnet 5.5: between_tools, with no other field and so no beta.
  const sonnet = await capture(request('claude-sonnet-5-5', { reasoning: 'none' }));
  assert.deepEqual(sonnet.body.thinking, { type: 'between_tools' });
  assert.deepEqual(sonnet.body.output_config, { effort: 'low' });
  assert.deepEqual(betas(sonnet), []);
  // disabled where the model takes it; Opus 5 stays on at low (ADR 0049).
  const expected: Record<string, unknown> = {
    'claude-opus-4-7': { type: 'disabled' },
    'claude-opus-4-8': { type: 'disabled' },
    'claude-sonnet-5': { type: 'disabled' },
    'claude-haiku-5-5': { type: 'disabled' },
    'claude-opus-5': { type: 'adaptive', display: 'summarized' },
    'claude-fable-5': { type: 'adaptive', display: 'summarized' },
  };
  for (const [model, thinking] of Object.entries(expected)) {
    const c = await capture(request(model, { reasoning: 'none' }));
    assert.deepEqual(c.body.thinking, thinking, model);
    assert.deepEqual(c.body.output_config, { effort: 'low' }, model);
    assert.deepEqual(betas(c), [], `${model}: no block_binding with thinking off, or on a model that does not bind`);
  }
});

test('no reasoning set: the model\'s own default, made readable where it thinks', async () => {
  const quiet = await capture(request('claude-sonnet-4-6'));
  assert.ok(!('thinking' in quiet.body));
  // Opus 4.7 does not think unless asked: nothing is sent.
  const opus47 = await capture(request('claude-opus-4-7'));
  assert.ok(!('thinking' in opus47.body) && !('output_config' in opus47.body));
  // A model that thinks by default keeps its default effort, with a summarized display.
  for (const model of ADAPTIVE_ERA) {
    const c = await capture(request(model));
    assert.deepEqual(c.body.thinking, ADAPTIVE_THINKING, model);
    assert.equal(c.body.output_config, undefined, model);
    // Thinking at the model's default effort, which is at most high, counts toward max_tokens.
    assert.equal(c.body.max_tokens, 16384 + 2048, model);
  }
  const sonnet5 = await capture(request('claude-sonnet-5'));
  assert.deepEqual(sonnet5.body.thinking, { type: 'adaptive', display: 'summarized' });
});

test('no sampling parameter is sent on any generation', async () => {
  for (const model of [...BUDGET_ERA, ...ADAPTIVE_ERA]) {
    const c = await capture(request(model, { sampling: { temperature: 0.2, topP: 0.9 }, reasoning: 'low' }));
    for (const field of ['temperature', 'top_p', 'top_k', 'topP', 'topK']) assert.ok(!(field in c.body), `${model}: ${field}`);
  }
});

test('the streamed path sends the same shape through the beta namespace', async () => {
  const c = await capture(request('claude-opus-5-5', { reasoning: 'low', stream: true }));
  assert.equal(c.body.stream, true);
  assert.deepEqual(c.body.thinking, ADAPTIVE_THINKING);
  assert.deepEqual(betas(c), [THINKING_BINDING_BETA]);
});

// ── Structured output ────────────────────────────────────────────────────────

test('budget era: structured output is a forced tool, offered under auto when thinking is on', async () => {
  for (const model of [...BUDGET_ERA, 'claude-opus-4-7']) {
    const c = await capture(request(model, { outputSchema: SCHEMA }));
    assert.deepEqual(c.body.tool_choice, { type: 'tool', name: 'structured_output' }, model);
    assert.ok(c.body.tools.some((t: any) => t.name === 'structured_output' && t.input_schema.properties.verdict), model);
    assert.equal(c.body.output_config, undefined, model);
    assert.equal(c.span['llm.structured_output'], 'forced_tool', model);
  }
  const thinking = await capture(request('claude-sonnet-4-6', { outputSchema: SCHEMA, reasoning: 'low' }));
  assert.equal(thinking.body.tool_choice, undefined);
  assert.ok(thinking.body.tools.some((t: any) => t.name === 'structured_output'));
  assert.equal(thinking.span['llm.structured_output'], 'tool_auto');
});

test('adaptive era: structured output is output_config.format beside the effort, with no tool and no tool_choice', async () => {
  for (const model of [...ADAPTIVE_ERA, 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-5-5']) {
    const c = await capture(request(model, { outputSchema: SCHEMA, reasoning: 'medium' }));
    assert.deepEqual(
      c.body.output_config,
      {
        effort: 'medium',
        format: { type: 'json_schema', schema: { type: 'object', properties: { verdict: { type: 'string' } }, additionalProperties: false, required: ['verdict'] } },
      },
      model,
    );
    assert.equal(c.body.tool_choice, undefined, model);
    assert.equal(c.body.tools, undefined, model);
    assert.equal(c.span['llm.structured_output'], 'output_format', model);
  }
});

test('output_config.format: the answer is read from the text, and constraints the API lacks move into the description', async () => {
  const schema = { type: 'object', properties: { score: { type: 'number', minimum: 0, maximum: 1 } }, required: ['score'] };
  const c = await capture(request('claude-sonnet-5-5', { outputSchema: schema }), {
    reply: { content: [{ type: 'thinking', thinking: 'Scoring.', signature: 'sig-fixture-1' }, { type: 'text', text: '{"score":0.8}' }] },
  });
  const score = c.body.output_config.format.schema.properties.score;
  assert.equal(score.type, 'number');
  assert.ok(!('minimum' in score) && /minimum: 0/.test(score.description), JSON.stringify(score));
  assert.deepEqual(finalOf(c).parts.map((p: any) => p.text), ['{"score":0.8}']);
});

test('a schema the structured-outputs transform refuses falls back to the tool, under auto where forcing is a 400', async () => {
  const c = await capture(request('claude-opus-5-5', { outputSchema: { type: 'array', items: { type: 'string' } } }));
  assert.equal(c.body.output_config, undefined);
  assert.equal(c.body.tool_choice, undefined);
  assert.ok(c.body.tools.some((t: any) => t.name === 'structured_output'));
  assert.equal(c.span['llm.structured_output'], 'tool_auto');
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /claude-opus-5-5: the outputSchema cannot be sent as structured output \(JSON schema must be an object, but got array\)/);
});

// ── Resuming a paused turn (preserved thinking) ──────────────────────────────

const A = { type: 'thinking', thinking: 'Look it up first.', signature: 'sig-fixture-a' };
const B = { type: 'thinking', thinking: 'Now the gated write.', signature: 'sig-fixture-b' };

/**
 * A turn that paused on an approval and is resumed from storage: its first
 * tool result was over 2,000 characters, so the stored row holds the elision
 * marker instead of what the model read before it produced block B. The
 * stored rows are read back as the contract's history (contentsToMessages).
 */
function resumedTurn(model: string): Message[] {
  const state = (block: object) => ({ provider: 'anthropic', kind: THINKING_STATE_KIND, model, payload: [block] });
  const events = [
    { role: 'user', parts: [{ text: 'update the record' }] },
    { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'read_record', args: { id: 7 } }, providerState: state(A) }] },
    { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'read_record', response: { body: 'x'.repeat(5_000) } } }] },
    { role: 'model', parts: [{ functionCall: { id: 'c2', name: 'write_record', args: { id: 7 } }, providerState: state(B) }] },
    { role: 'user', parts: [{ functionResponse: { id: 'c2', name: 'write_record', response: { ok: true } } }] },
  ];
  // The Supabase row's form, read back: trimmed, then a JSON round trip.
  const stored: Content[] = events.map((content) => JSON.parse(JSON.stringify(trimEventForStorage({ content } as unknown as TurnEvent))).content);
  assert.match(JSON.stringify(stored[2]), /chars dropped before storage/);
  return contentsToMessages(stored).messages;
}

test('resume: a conversation-bound model replays the stored blocks under drop_block, and the API may drop them', async () => {
  const c = await capture(request('claude-opus-5-5', { reasoning: 'medium', messages: resumedTurn('claude-opus-5-5') }), {
    reply: {
      content: [{ type: 'text', text: 'Updated.' }],
      // B was made before the payload was elided: its history no longer matches.
      input_transformations: [
        { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'prefix_binding_mismatch' },
        { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'a-reason-from-the-future\nforged' },
      ],
    },
  });
  const assistant = c.body.messages.filter((m: any) => m.role === 'assistant');
  assert.deepEqual(assistant.map((m: any) => m.content[0]), [A, B], 'each block, verbatim, before its tool_use');
  assert.deepEqual(c.body.thinking.block_binding, DROP_BLOCK);
  assert.deepEqual(betas(c), [THINKING_BINDING_BETA]);
  // The request succeeds; the span names the known reason only.
  assert.deepEqual(finalOf(c).parts, [{ type: 'text', text: 'Updated.' }]);
  assert.equal(c.span['llm.thinking.dropped'], 'prefix_binding_mismatch');
});

test('resume: a budget-era model does not bind blocks to the conversation and replays them as before', async () => {
  const c = await capture(request('claude-sonnet-4-6', { reasoning: 'medium', messages: resumedTurn('claude-sonnet-4-6') }));
  const assistant = c.body.messages.filter((m: any) => m.role === 'assistant');
  assert.deepEqual(assistant.map((m: any) => m.content[0]), [A, B]);
  assert.deepEqual(c.body.thinking, { type: 'enabled', budget_tokens: 8192 });
  assert.deepEqual(betas(c), []);
});

test('resume: with thinking off on a conversation-bound model, no signed block is replayed', async () => {
  const c = await capture(request('claude-sonnet-5-5', { reasoning: 'none', messages: resumedTurn('claude-sonnet-5-5') }));
  assert.deepEqual(c.body.thinking, { type: 'between_tools' });
  assert.ok(!JSON.stringify(c.body.messages).includes('sig-fixture'), 'between_tools cannot carry drop_block');
  const assistant = c.body.messages.filter((m: any) => m.role === 'assistant');
  assert.deepEqual(assistant.map((m: any) => m.content.map((b: any) => b.type)), [['tool_use'], ['tool_use']]);
});

// ── Images ───────────────────────────────────────────────────────────────────

/** A URL blob as the genai mapping makes one from a fileData part that names no type. */
const untypedUrl = (url: string) => ({ type: 'blob' as const, mimeType: 'application/octet-stream', url });

test('a URL image that names no type is typed by its extension; a non-image is dropped with the same warning', async () => {
  const c = await capture(
    request('claude-sonnet-4-6', {
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'look' },
            untypedUrl('https://example.com/photos/cat.JPG?size=large'),
            untypedUrl('https://example.com/files/report.pdf'),
            untypedUrl('https://example.com/art/logo.svg'),
            untypedUrl('https://cdn.example.com/image?id=3'),
            { type: 'blob', mimeType: 'image/png', url: 'https://example.com/odd.pdf' },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(c.body.messages[0].content, [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'url', url: 'https://example.com/photos/cat.JPG?size=large' } },
    // No extension the table knows: sent, and Anthropic reads the type from the bytes.
    { type: 'image', source: { type: 'url', url: 'https://cdn.example.com/image?id=3' } },
    // A type the part names wins over the extension.
    { type: 'image', source: { type: 'url', url: 'https://example.com/odd.pdf' } },
  ]);
  assert.equal(c.span['llm.image.dropped'], 'application/pdf,image/svg+xml');
  assert.equal(c.warnings.length, 2);
  assert.match(c.warnings[0], /\(application\/pdf\) is not sent to Claude, which takes JPEG, PNG, GIF or WebP/);
});

test('Bedrock and Vertex AI take base64 images only: a URL image is dropped there, and the matrix says so', async () => {
  let body: any;
  class AnthropicBedrock {
    messages = {
      create: async (b: any) => {
        body = b;
        return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    beta = { messages: this.messages };
  }
  setSdkImporter(async () => ({ AnthropicBedrock }));
  try {
    const c = await capture(
      request('claude-sonnet-4-6', {
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'look' },
              { type: 'blob', mimeType: 'image/png', url: 'https://example.com/secret-path/cat.png' },
              { type: 'blob', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
            ],
          },
        ],
      }),
      { env: { ANTHROPIC_PLATFORM: 'bedrock', AWS_REGION: 'us-east-1' } },
    );
    assert.deepEqual(body.messages[0].content, [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    assert.equal(c.span['llm.image.dropped'], 'URL source');
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0], /given by URL is not sent to Anthropic Claude on Bedrock \(us-east-1\)/);
    assert.ok(!c.warnings[0].includes('secret-path'));
  } finally {
    setSdkImporter(undefined);
  }
  const saved = { platform: process.env.ANTHROPIC_PLATFORM, region: process.env.AWS_REGION };
  try {
    Object.assign(process.env, { ANTHROPIC_PLATFORM: 'bedrock', AWS_REGION: 'us-east-1' });
    assert.equal(capabilityOf('claude-sonnet-4-6', 'vision').support, 'degraded');
  } finally {
    for (const [k, v] of [['ANTHROPIC_PLATFORM', saved.platform], ['AWS_REGION', saved.region]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  for (const platform of ['bedrock', 'vertex'] as const) {
    assert.equal(platformCell('anthropic', platform, 'vision')?.support, 'degraded', platform);
  }
  assert.equal(platformCell('anthropic', 'direct', 'vision'), undefined);
  assert.equal(platformCell('openai', 'azure', 'vision'), undefined);
});
