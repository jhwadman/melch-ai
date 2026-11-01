/**
 * tests/filePartsA2a.test.ts — inline files over A2A (a2aPartsToMessage), the
 * table behind them (attachmentSupport), Claude's PDF block and a failed
 * call's recorded request.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { a2aPartsToMessage } from '../lib/a2a/executor.ts';
import { attachmentSupport } from '../lib/models/attachments.ts';
import type { AttachmentSupport } from '../lib/models/attachments.ts';
import type { Message, ModelRequest } from '../lib/models/contract.ts';
import { captureClaude as capture } from './helpers/claudeCapture.ts';

const support: AttachmentSupport = {
  images: ['image/png'], documents: ['application/pdf'], media: [],
  maxImageEdge: 1568, maxImageBytes: 8, maxFileBytes: 16, maxRequestBytes: 32,
};
const files = { maxBytes: 32, support };
const b64 = (s: string) => Buffer.from(s).toString('base64');

test('without a policy every file part is refused', () => {
  assert.match(a2aPartsToMessage([{ kind: 'file', file: { bytes: b64('x'), mimeType: 'image/png' } }]).refused!, /not supported/);
  assert.match(a2aPartsToMessage([{ content: { $case: 'raw', value: Buffer.from('x') }, mediaType: 'image/png' }]).refused!, /not supported/);
});

test('an image the model reads becomes a blob, in either protocol version', () => {
  const blob = { inlineData: { mimeType: 'image/png', data: b64('png') } };
  assert.deepEqual(a2aPartsToMessage([{ kind: 'file', file: { bytes: b64('png'), mimeType: 'image/png' } }], files), { parts: [blob] });
  assert.deepEqual(a2aPartsToMessage([{ content: { $case: 'raw', value: Buffer.from('png') }, mediaType: 'image/png' }], files), { parts: [blob] });
});

test('a text type goes as text, with a name the caller cannot break out of', () => {
  const { parts } = a2aPartsToMessage([{ kind: 'file', file: { bytes: b64('a,b'), mimeType: 'text/csv; charset=utf-8', name: 'x"><y.csv' } }], files);
  assert.equal((parts[0] as { text: string }).text, '<attached_file name="x___y.csv" type="text/csv">\na,b\n</attached_file>');
});

test('text that is not UTF-8 is refused', () => {
  const r = a2aPartsToMessage([{ kind: 'file', file: { bytes: Buffer.from([0xff, 0xfe]).toString('base64'), mimeType: 'text/plain' } }], files);
  assert.match(r.refused!, /not UTF-8/);
});

test('a type the model does not read is refused, naming what it does', () => {
  const r = a2aPartsToMessage([{ kind: 'file', file: { bytes: b64('x'), mimeType: 'video/mp4' } }], files);
  assert.match(r.refused!, /does not read video\/mp4.*image\/png, application\/pdf/);
});

test('size: per file and per message', () => {
  assert.match(a2aPartsToMessage([{ kind: 'file', file: { bytes: b64('123456789'), mimeType: 'image/png' } }], files).refused!, /at most 8 bytes/);
  const pdf = { kind: 'file', file: { bytes: b64('1234567890123456'), mimeType: 'application/pdf' } };
  assert.match(a2aPartsToMessage([pdf, pdf, pdf], files).refused!, /total at most 32/);
});

test('a file by URL is never fetched', () => {
  assert.match(a2aPartsToMessage([{ kind: 'file', file: { uri: 'http://169.254.169.254/', mimeType: 'image/png' } }], files).refused!, /URL/);
  assert.match(a2aPartsToMessage([{ content: { $case: 'url', value: 'http://169.254.169.254/' }, mediaType: 'image/png' }], files).refused!, /URL/);
});

test('attachmentSupport: an unknown model reads as the plain table', () => {
  assert.deepEqual(attachmentSupport(undefined).images, ['image/jpeg', 'image/png']);
  assert.deepEqual(attachmentSupport(undefined).documents, []);
  assert.deepEqual(attachmentSupport('ollama/qwen3:8b').documents, []);
});

test('Claude gets a PDF as a document block; a failed call records its size, not its bytes', async () => {
  const data = 'JVBERi0xLjQK'.repeat(4);
  const message: Message = { role: 'user', parts: [{ type: 'blob', mimeType: 'application/pdf', data }, { type: 'text', text: 'read it' }] };
  const { body, span } = await capture({ model: 'claude-sonnet-4-6', messages: [message] } as ModelRequest);
  assert.deepEqual(body.messages[0].content[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
  const recorded = String(span['llm.payload.request']);
  assert.ok(recorded.includes('bytes not recorded'), recorded);
  assert.ok(!recorded.includes(data));
});
