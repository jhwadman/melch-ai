/**
 * tests/claudeVision.test.ts — the image blocks ClaudeLlm sends.
 *
 * Offline: globalThis.fetch is replaced by a stub that records the request
 * body and answers 400, so no provider is called. The key is a fake value set
 * for the duration of each capture.
 *
 * A user-turn inlineData part becomes a base64 image block, an https fileData
 * part a URL image block, in the parts' order; a type Anthropic rejects is
 * dropped with llm.image.dropped on the span and one warning per type.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel, LogLevel } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { ClaudeLlm } from '../lib/models/claudeLlm.ts';
import { onSpanEnd } from '../lib/observability/tracer.ts';

setLogLevel(LogLevel.ERROR);
process.env.OTEL_CONSOLE_SPANS = 'false';

const MODEL = 'claude-sonnet-4-6';
const PNG = 'iVBORw0KGgo=';

function request(parts: any[], extra: LlmRequest['contents'] = []): LlmRequest {
  return {
    model: MODEL,
    contents: [...extra, { role: 'user', parts }],
    liveConnectConfig: {} as any,
    toolsDict: {},
    config: {},
  } as LlmRequest;
}

/** Sends one request; returns the posted body, the warnings, and the llm.request span's attributes. */
async function capture(req: LlmRequest, llm = new ClaudeLlm({ model: MODEL })) {
  const saved = { key: process.env.ANTHROPIC_API_KEY, platform: process.env.ANTHROPIC_PLATFORM };
  process.env.ANTHROPIC_API_KEY = 'fixture-ant-test-0123456789abcdef'; // gitleaks:allow (test fixture)
  delete process.env.ANTHROPIC_PLATFORM;
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  const spans: Record<string, unknown>[] = [];
  let body: any;
  globalThis.fetch = (async (input: any, init: any) => {
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    if (body === undefined && typeof raw === 'string') body = JSON.parse(raw);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'captured' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as any;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  const off = onSpanEnd((span) => {
    if (span.name === 'llm.request') spans.push({ ...span.attributes });
  });
  try {
    for await (const _ of llm.generateContentAsync(req, false) as AsyncGenerator<LlmResponse, void>) {
      // drain; the 400 surfaces as an error response, which is expected
    }
  } finally {
    off();
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_PLATFORM', saved.platform]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.ok(body, 'the adapter sent no request');
  return { body, warnings, span: spans.at(-1) ?? {} };
}

test('an inlineData part becomes a base64 image block, image/png when it names no type', async () => {
  const { body, warnings, span } = await capture(
    request([
      { text: 'what is this?' },
      { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQ' } },
      { inlineData: { data: PNG } },
    ]),
  );
  assert.deepEqual(body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      ],
    },
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(span['llm.image.dropped'], undefined);
});

test('an https fileData part becomes a URL image block, in the order the parts came', async () => {
  const { body } = await capture(
    request([
      { fileData: { fileUri: 'https://example.com/cat.webp', mimeType: 'image/webp' } },
      { text: 'and this one?' },
      { fileData: { fileUri: 'https://example.com/dog' } },
    ]),
  );
  assert.deepEqual(body.messages[0].content, [
    { type: 'image', source: { type: 'url', url: 'https://example.com/cat.webp' } },
    { type: 'text', text: 'and this one?' },
    { type: 'image', source: { type: 'url', url: 'https://example.com/dog' } },
  ]);
});

test('a type Anthropic rejects is dropped with a span attribute and one warning per type', async () => {
  const llm = new ClaudeLlm({ model: MODEL });
  const parts = [
    { text: 'compare these' },
    { inlineData: { mimeType: 'image/bmp', data: 'Qk0=' } },
    { fileData: { fileUri: 'gs://bucket/secret-path/cat.png', mimeType: 'image/png' } },
    { inlineData: { mimeType: 'image/gif', data: 'R0lGOD' } },
  ];
  const first = await capture(request(parts), llm);
  assert.deepEqual(first.body.messages[0].content, [
    { type: 'text', text: 'compare these' },
    { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lGOD' } },
  ]);
  assert.equal(first.span['llm.image.dropped'], 'image/bmp,non-https URL (gs:)');
  assert.equal(first.warnings.length, 2);
  assert.match(first.warnings[0], /image\/bmp/);
  assert.match(first.warnings[1], /non-https URL \(gs:\)/);
  // The drop names the scheme, never the URL, in the attribute and the log.
  assert.ok(!JSON.stringify([first.warnings, first.span['llm.image.dropped'], first.body]).includes('secret-path'));

  // The same adapter does not warn again for a type it already named; the span still records the drop.
  const second = await capture(request(parts), llm);
  assert.deepEqual(second.warnings, []);
  assert.equal(second.span['llm.image.dropped'], 'image/bmp,non-https URL (gs:)');
});

test('only user turns carry images: a model-turn image part is not sent', async () => {
  const { body } = await capture(
    request([{ text: 'and now?' }], [
      { role: 'user', parts: [{ text: 'draw a cat' }] },
      { role: 'model', parts: [{ text: 'here it is' }, { inlineData: { mimeType: 'image/png', data: PNG } }] },
    ]),
  );
  assert.deepEqual(body.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'here it is' }] });
  assert.ok(!JSON.stringify(body).includes('"type":"image"'));
});

test('a dropped type is named printable and short, so a caller cannot forge a log line', async () => {
  const forged = 'image/x\n⚠ forged line' + 'x'.repeat(200);
  const { body, warnings, span } = await capture(request([{ text: 'hi' }, { inlineData: { mimeType: forged, data: 'AAAA' } }]));
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'hi' }]);
  const named = String(span['llm.image.dropped']);
  assert.ok(named.length <= 64 && !/[\n\r]/.test(named), named);
  assert.equal(warnings.length, 1);
  assert.ok(!/[\n\r]/.test(warnings[0]));
});
