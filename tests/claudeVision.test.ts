/**
 * tests/claudeVision.test.ts — the image blocks ClaudeAdapter sends for a
 * ModelRequest's blob parts (lib/models/claudeAdapter.ts).
 *
 * Offline: tests/helpers/claudeCapture.ts stubs fetch, records the request
 * body and answers 400, so no provider is called. The key is a fixture set
 * for the duration of each capture.
 *
 * A user-message data blob becomes a base64 image block, an https URL blob a
 * URL image block, in the parts' order; a type Anthropic rejects is dropped
 * with llm.image.dropped on the span and one warning per type.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeAdapter } from '../lib/models/claudeAdapter.ts';
import type { BlobPart, Message, ModelRequest, TextPart } from '../lib/models/contract.ts';
import { captureClaude as capture } from './helpers/claudeCapture.ts';

const MODEL = 'claude-sonnet-4-6';
const PNG = 'iVBORw0KGgo=';

function request(parts: Array<TextPart | BlobPart>, earlier: Message[] = []): ModelRequest {
  return { model: MODEL, messages: [...earlier, { role: 'user', parts }] };
}

const text = (t: string): TextPart => ({ type: 'text', text: t });
/** A data blob as the genai mapping makes one from an inlineData part that names no type. */
const UNTYPED = 'application/octet-stream';

test('a data blob becomes a base64 image block, image/png when it names no type', async () => {
  const { body, warnings, span } = await capture(
    request([text('what is this?'), { type: 'blob', mimeType: 'image/jpeg', data: '/9j/4AAQ' }, { type: 'blob', mimeType: UNTYPED, data: PNG }]),
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

test('an https URL blob becomes a URL image block, in the order the parts came', async () => {
  const { body } = await capture(
    request([
      { type: 'blob', mimeType: 'image/webp', url: 'https://example.com/cat.webp' },
      text('and this one?'),
      { type: 'blob', mimeType: UNTYPED, url: 'https://example.com/dog' },
    ]),
  );
  assert.deepEqual(body.messages[0].content, [
    { type: 'image', source: { type: 'url', url: 'https://example.com/cat.webp' } },
    { type: 'text', text: 'and this one?' },
    { type: 'image', source: { type: 'url', url: 'https://example.com/dog' } },
  ]);
});

test('a type Anthropic rejects is dropped with a span attribute and one warning per type', async () => {
  const adapter = new ClaudeAdapter({ model: MODEL });
  const parts: Array<TextPart | BlobPart> = [
    text('compare these'),
    { type: 'blob', mimeType: 'image/bmp', data: 'Qk0=' },
    { type: 'blob', mimeType: 'image/png', url: 'gs://bucket/secret-path/cat.png' },
    { type: 'blob', mimeType: 'image/gif', data: 'R0lGOD' },
  ];
  const first = await capture(request(parts), { adapter });
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
  const second = await capture(request(parts), { adapter });
  assert.deepEqual(second.warnings, []);
  assert.equal(second.span['llm.image.dropped'], 'image/bmp,non-https URL (gs:)');
});

test('only user messages carry images: an assistant message\'s blob is not sent', async () => {
  const { body } = await capture(
    request([text('and now?')], [
      { role: 'user', parts: [text('draw a cat')] },
      { role: 'assistant', parts: [text('here it is'), { type: 'blob', mimeType: 'image/png', data: PNG }] },
    ]),
  );
  assert.deepEqual(body.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'here it is' }] });
  assert.ok(!JSON.stringify(body).includes('"type":"image"'));
});

test('a dropped type is named printable and short, so a caller cannot forge a log line', async () => {
  const forged = 'image/x\n⚠ forged line' + 'x'.repeat(200);
  const { body, warnings, span } = await capture(request([text('hi'), { type: 'blob', mimeType: forged, data: 'AAAA' }]));
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'hi' }]);
  const named = String(span['llm.image.dropped']);
  assert.ok(named.length <= 64 && !/[\n\r]/.test(named), named);
  assert.equal(warnings.length, 1);
  assert.ok(!/[\n\r]/.test(warnings[0]));
});
