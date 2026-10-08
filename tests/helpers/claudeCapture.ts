/**
 * tests/helpers/claudeCapture.ts — one ModelRequest through a ClaudeAdapter,
 * offline, with what it posted, yielded, warned and set on its span.
 *
 * globalThis.fetch is replaced by a stub that records the first request the
 * real Anthropic SDK sends and answers in the Messages API's own shape (a 400
 * unless the caller scripts a reply), so no provider is called. Only the
 * caller's env is set (a fixture key by default); every other Anthropic
 * variable is cleared, so a developer's real key or platform never routes a
 * test. The call runs inside an `llm.request` span (traceLlmGeneration), as
 * a caller of the contract opens one (ADR 0053), so the adapter's span
 * attributes are read from it.
 */

import assert from 'node:assert/strict';

import { ClaudeAdapter } from '../../lib/models/claudeAdapter.ts';
import type { ModelRequest, ModelResponse } from '../../lib/models/contract.ts';
import { modelResponseToLlmResponse } from '../../lib/models/genaiMapping.ts';
import { onSpanEnd, traceLlmGeneration } from '../../lib/observability/tracer.ts';

export const CLAUDE_FIXTURE_KEY = 'fixture-ant-test-0123456789abcdef'; // gitleaks:allow (test fixture)

/** The env vars a capture touches, cleared first. */
const ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_PLATFORM', 'ANTHROPIC_BASE_URL', 'AWS_REGION', 'ANTHROPIC_MODEL_MAP'];

export interface ClaudeCaptured {
  /** The first request posted; empty when none went through fetch (a stubbed SDK). */
  url: string;
  headers: Headers;
  body: any;
  /** What the adapter yielded. */
  out: ModelResponse[];
  warnings: string[];
  /** The llm.request span's attributes. */
  span: Record<string, unknown>;
}

export interface ClaudeCaptureOptions {
  /** A successful Messages API answer's fields; without it the stub answers 400. */
  reply?: Record<string, unknown>;
  /** An adapter to reuse (its one-time warnings persist across calls). Default: a new one, built inside the capture. */
  adapter?: ClaudeAdapter;
  /** The environment for the call. Default: the fixture key. */
  env?: Record<string, string>;
}

export async function captureClaude(request: ModelRequest, opts: ClaudeCaptureOptions = {}): Promise<ClaudeCaptured> {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, opts.env ?? { ANTHROPIC_API_KEY: CLAUDE_FIXTURE_KEY });
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  const spans: Record<string, unknown>[] = [];
  let seen: { url: string; headers: Headers; body: any } | undefined;
  globalThis.fetch = (async (input: any, init: any) => {
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    if (!seen && typeof raw === 'string') {
      seen = { url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers), body: JSON.parse(raw) };
    }
    if (opts.reply) {
      return new Response(
        JSON.stringify({
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: request.model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
          ...opts.reply,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'captured' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  const off = onSpanEnd((span) => {
    if (span.name === 'llm.request') spans.push({ ...span.attributes });
  });
  const out: ModelResponse[] = [];
  try {
    const adapter = opts.adapter ?? new ClaudeAdapter({ model: request.model });
    async function* mapped() {
      for await (const r of adapter.generate(request)) {
        out.push(r);
        yield modelResponseToLlmResponse(r);
      }
    }
    for await (const _ of traceLlmGeneration({ provider: adapter.provider, model: adapter.model, request }, mapped())) {
      // drain; a 400 is a final with an error, which is expected
    }
  } finally {
    off();
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  assert.ok(out.length > 0 && !out.at(-1)!.partial, `${request.model}: the adapter ended without a final`);
  return { url: seen?.url ?? '', headers: seen?.headers ?? new Headers(), body: seen?.body, out, warnings, span: spans.at(-1) ?? {} };
}

/** The anthropic-beta header's values. */
export const betas = (c: ClaudeCaptured) => (c.headers.get('anthropic-beta') ?? '').split(',').filter(Boolean);
