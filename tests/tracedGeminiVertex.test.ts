/**
 * tests/tracedGeminiVertex.test.ts — the compiler asks every agent's config
 * for includeServerSideToolInvocations, which @google/genai refuses on
 * Vertex AI before any request is sent ("only supported in Gemini Developer
 * API mode"). TracedGemini leaves it off there and keeps it on the Gemini API.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { TracedGemini } from '../lib/models/tracedGemini.ts';

const KEY = 'fixture-gemini-0123456789'; // gitleaks:allow (test fixture)

function request(): LlmRequest {
  return {
    model: 'gemini-3.8-flash',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    config: { toolConfig: { includeServerSideToolInvocations: true } },
    toolsDict: {},
    liveConnectConfig: {},
  } as unknown as LlmRequest;
}

/**
 * Runs one call and returns the LlmRequest TracedGemini hands ADK's Gemini.
 * ADK's Gemini is replaced for the call: a Vertex AI client needs Google
 * credentials before it sends anything, so the wire is out of reach offline.
 */
async function handed(endpoint: Record<string, unknown>): Promise<{ handed: LlmRequest[]; out: LlmResponse[] }> {
  const adkGemini = Object.getPrototypeOf(TracedGemini.prototype) as { generateContentAsync: (...a: unknown[]) => AsyncGenerator<LlmResponse> };
  const real = adkGemini.generateContentAsync;
  const seen: LlmRequest[] = [];
  adkGemini.generateContentAsync = async function* (req: unknown) {
    seen.push(structuredClone(req) as LlmRequest);
    yield { content: { role: 'model', parts: [{ text: 'hello' }] }, turnComplete: true } as LlmResponse;
  };
  const out: LlmResponse[] = [];
  try {
    const llm = new TracedGemini({ model: 'gemini-3.8-flash', endpoint: endpoint as any });
    for await (const r of llm.generateContentAsync(request(), false)) out.push(r);
  } finally {
    adkGemini.generateContentAsync = real;
  }
  return { handed: seen, out };
}

test('on Vertex AI the call goes out without includeServerSideToolInvocations', async () => {
  const { handed: seen, out } = await handed({ platform: 'vertex', project: 'p', location: 'us-central1', apiKey: KEY });
  assert.equal(seen.length, 1);
  assert.equal('includeServerSideToolInvocations' in ((seen[0].config?.toolConfig ?? {}) as object), false);
  assert.equal(out.at(-1)?.content?.parts?.[0]?.text, 'hello');
});

test('on the Gemini API the flag is still sent', async () => {
  const { handed: seen } = await handed({ platform: 'direct', apiKey: KEY });
  assert.equal(seen.length, 1);
  assert.equal((seen[0].config?.toolConfig as Record<string, unknown>).includeServerSideToolInvocations, true);
});
