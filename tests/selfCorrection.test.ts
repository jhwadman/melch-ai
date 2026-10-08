/**
 * tests/selfCorrection.test.ts — ADR 0034: the reflect-and-retry plugins on by
 * default (a malformed model reply is retried instead of failing the turn; a
 * tool that throws gets structured guidance), `retries: 0` turning each off,
 * `url_context` native on Gemini and a no-op elsewhere, and `examples:` in the
 * instruction. Scripted models, in-memory sessions, no network. The
 * malformed reply reaches the loop through the model contract, as an error
 * code the genai mapping reads back as the finish reason (ADR 0088).
 *
 * The native loop's self-correction (lib/runtime/native/selfCorrection.ts,
 * ADR 0075) is held to the same stored events as these plugins in
 * tests/nativeLoop.test.ts ("self-correction: …"), with the parity harness
 * there; here, its settings.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { DEFAULT_MODEL_ERROR_RETRIES, DEFAULT_TOOL_ERROR_RETRIES, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { SelfCorrection } from '../lib/runtime/native/selfCorrection.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { buildModelRequest, type NativeAgent } from '../lib/runtime/native/request.ts';
import { registerTool, resolveTools } from '../lib/toolRegistry.ts';
import { URL_CONTEXT_MARKER } from '../lib/tools/nativeTools.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { describeCapabilities } from '../lib/models/capabilities.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

let attempts = 0;
registerTool(
  'self_correction_flaky',
  defineTool({
    name: 'self_correction_flaky',
    description: 'Fails once.',
    schema: z.object({ q: z.string() }),
    execute: async ({ q }) => {
      if (++attempts === 1) throw new Error('upstream 503');
      return `ok ${q}`;
    },
  }),
  { override: true },
);

const lastResponse = (req: any) => JSON.stringify(req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response ?? null);

function config(extra: Record<string, unknown> = {}, orchestrator: Record<string, unknown> = {}): SyndicateYamlConfig {
  return validateSyndicateConfig(
    { syndicate_name: 'S', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Help.', ...orchestrator }, subagents: [], ...extra },
    't',
  ) as SyndicateYamlConfig;
}
const turn = (cfg: SyndicateYamlConfig, boss: ScriptedLlm) =>
  runSyndicateTurn({ config: cfg, parts: [{ text: 'go' }], appName: 'a', userId: 'u', sessionId: 's', sessionService: new InProcessSessionService(), compile: { resolveModel: scriptedResolver({ boss }) }, trace: false });
const malformedOnce = () => {
  let n = 0;
  return new ScriptedLlm('scripted/boss', () => (++n === 1 ? ({ errorCode: 'MALFORMED_FUNCTION_CALL', finishReason: 'MALFORMED_FUNCTION_CALL', errorMessage: 'bad call' } as any) : text('recovered')));
};

test(
  'by default a malformed model reply is retried, not a failed turn',
  async () => {
    const boss = malformedOnce();
    const r = await turn(config(), boss);
    assert.equal(r.status, 'completed', r.error?.message);
    assert.equal(r.text, 'recovered');
    assert.equal(boss.calls, 2);
  },
);

test('retries.model_errors: 0 lets the malformed reply fail the turn', async () => {
  const r = await turn(config({ retries: { model_errors: 0 } }), malformedOnce());
  assert.equal(r.status, 'failed');
  assert.match(String(r.error?.code), /MALFORMED_FUNCTION_CALL/);
});

test('a tool that throws comes back with reflection guidance; tool_errors: 0 gives the plain error', async () => {
  const script = () => new ScriptedLlm('scripted/boss', (req, n) => (n <= 2 ? call('self_correction_flaky', { q: 'x' }) : text(`final ${lastResponse(req)}`)));
  let seen = '';
  attempts = 0;
  const guided = new ScriptedLlm('scripted/boss', (req, n) => {
    if (n === 2) seen = lastResponse(req);
    return n <= 2 ? call('self_correction_flaky', { q: 'x' }) : text('done');
  });
  const r = await turn(config({}, { tools: ['self_correction_flaky'] }), guided);
  assert.equal(r.status, 'completed');
  assert.match(seen, /ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN/);
  assert.match(seen, /reflection_guidance/);

  attempts = 0;
  const plain = script();
  await turn(config({ retries: { tool_errors: 0 } }, { tools: ['self_correction_flaky'] }), plain);
  assert.match(lastResponse(plain.requests[1]), /Error in tool 'self_correction_flaky': upstream 503/);
  assert.doesNotMatch(lastResponse(plain.requests[1]), /REFLECT_AND_RETRY/);
});

test('url_context is native on Gemini, a no-op elsewhere, and reported as dropped', async () => {
  const [marker] = resolveTools(['url_context']);
  assert.equal(marker, URL_CONTEXT_MARKER);
  assert.equal('declaration' in URL_CONTEXT_MARKER, false, 'never a client-side function');
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: 'a', userId: 'u', sessionId: 's' });
  const agent = (model: string): NativeAgent => ({ name: 'reader', model, tools: [URL_CONTEXT_MARKER] });
  const gemini = await buildModelRequest(agent('gemini-3.8-flash'), { session, invocationId: 'e-1' });
  assert.deepEqual(gemini.request.nativeTools, ['url_context']);
  assert.equal(gemini.request.tools, undefined);
  const claude = await buildModelRequest(agent('claude-sonnet-4-6'), { session, invocationId: 'e-1' });
  assert.equal(claude.request.nativeTools, undefined, 'nothing added, nothing thrown');
  assert.equal(claude.request.tools, undefined);
  assert.ok(describeCapabilities('claude-sonnet-4-6', ['url_context']).dropped.includes('url_context'));
});

test('examples reach every request\'s instruction', async () => {
  let instruction = '';
  const boss = new ScriptedLlm('scripted/boss', (req: any) => ((instruction = JSON.stringify(req.config?.systemInstruction ?? '')), text('ok')));
  await turn(config({}, { examples: [{ input: 'Capital of France?', output: 'Paris.' }] }), boss);
  assert.match(instruction, /Capital of France\?/);
  assert.match(instruction, /Paris\./);
});

test('the native loop reads the same retries: defaults on, 0 turns each side off', () => {
  const defaults = new SelfCorrection();
  assert.deepEqual([defaults.modelErrors, defaults.toolErrors], [DEFAULT_MODEL_ERROR_RETRIES, DEFAULT_TOOL_ERROR_RETRIES]);
  assert.deepEqual([defaults.modelErrors, defaults.toolErrors], [2, 3]);
  assert.deepEqual(defaults.forModel('Boss', 'e-1')?.tools.map((t) => t.name), ['adk_handle_model_error']);
  assert.ok(defaults.forCalls('e-1', 1));
  const off = new SelfCorrection({ model_errors: 0, tool_errors: 0 });
  assert.equal(off.forModel('Boss', 'e-1'), undefined);
  assert.equal(off.forCalls('e-1', 1), undefined);
});
