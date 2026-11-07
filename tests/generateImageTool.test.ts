/**
 * generate_image traces its model call as one llm.request (ADR 0136): the
 * image model's tokens reach the turn's usage, and migration 0024 prices them.
 * Offline: the Gemini client is a stub, the database is PGlite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

import { onSpanEnd } from '../lib/observability/tracer.ts';
import { IMAGE_MODEL, generateImageContract, imageClient } from '../lib/tools/generateImageTool.ts';

process.env.OTEL_CONSOLE_SPANS = 'false';

const USAGE = { promptTokenCount: 120, candidatesTokenCount: 1290, thoughtsTokenCount: 200 };

async function withStub<T>(response: unknown, fn: () => Promise<T>): Promise<T> {
  const create = imageClient.create;
  const keys = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, OUTPUTS_DIR: process.env.OUTPUTS_DIR };
  const dir = mkdtempSync(join(tmpdir(), 'image-tool-'));
  imageClient.create = () => ({ models: { generateContent: async () => response } }) as never;
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.OUTPUTS_DIR = dir;
  try {
    return await fn();
  } finally {
    imageClient.create = create;
    for (const [k, v] of Object.entries(keys)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function spansOf(fn: () => Promise<unknown>): Promise<ReadableSpan[]> {
  const spans: ReadableSpan[] = [];
  const off = onSpanEnd((s) => {
    if (s.name === 'llm.request') spans.push(s);
  });
  try {
    await fn();
  } finally {
    off();
  }
  return spans;
}

test('generate_image records its call as an llm.request with the image model and its tokens', async () => {
  const response = {
    usageMetadata: USAGE,
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } }] } }],
  };
  let result = '';
  const spans = await withStub(response, () => spansOf(async () => {
    result = await generateImageContract.execute({ prompt: 'a lake at night' });
  }));
  assert.match(result, /Image saved to outputs\/image_\d+\.png/);
  assert.equal(spans.length, 1);
  const a = spans[0].attributes;
  assert.equal(a['llm.model'], IMAGE_MODEL);
  assert.equal(a['llm.provider'], 'gemini');
  assert.equal(a['llm.tokens.input'], 120);
  assert.equal(a['llm.tokens.output'], 1290);
  assert.equal(a['llm.tokens.thinking'], 200);
});

test('generate_image: a failed call still ends its llm.request, and the tool reports the error', async () => {
  const create = imageClient.create;
  process.env.GEMINI_API_KEY ??= 'test-key';
  imageClient.create = () => ({ models: { generateContent: async () => { throw new Error('quota exceeded'); } } }) as never;
  let result = '';
  try {
    const spans = await spansOf(async () => {
      result = await generateImageContract.execute({ prompt: 'a lake at night' });
    });
    assert.equal(spans.length, 1);
    assert.equal(spans[0].attributes['llm.model'], IMAGE_MODEL);
    assert.ok(spans[0].attributes['llm.error_code']);
  } finally {
    imageClient.create = create;
  }
  assert.match(result, /\[generate_image ERROR\].*quota exceeded/);
});

test('migration 0024 prices the image model: image output at $60/M, thinking at $3/M', async () => {
  const db = new PGlite({ extensions: { vector } });
  try {
    for (const f of readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
      await db.exec(readFileSync(join('db/migrations', f), 'utf-8'));
    }
    const usage = { [IMAGE_MODEL]: { calls: 1, input: 120, output: 1290, thinking: 200 } };
    const r = await db.query<{ c: string }>('SELECT melchizedek_usage_cost($1::jsonb) AS c', [JSON.stringify(usage)]);
    // (120 × 0.50 + 1290 × 60 + 200 × 3) / 1e6
    assert.equal(Number(r.rows[0].c), 0.07806);
  } finally {
    await db.close();
  }
});
