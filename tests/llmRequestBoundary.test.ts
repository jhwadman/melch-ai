/**
 * tests/llmRequestBoundary.test.ts — which tests may build an ADK LlmRequest.
 *
 * The model tests assert from a ModelRequest (lib/models/contract.ts, ADR
 * 0048) to the wire body, so the native runtime inherits them when ADK
 * leaves (ADR 0045). Only the ADK path's own tests build an LlmRequest:
 * the shim and the genai mapping, the per-provider shim cases, the ADK
 * runtime and tool layer that WS2 replaces, and the boundary suite, which
 * stays on ADK until WS2-12. This suite keeps that list.
 *
 * A file builds an LlmRequest when its code (comments aside) names the
 * `LlmRequest` type, calls `modelRequestToLlmRequest`, or writes one of the
 * fields only an LlmRequest has (`toolsDict`, `liveConnectConfig`). Every
 * such file under tests/ must be on ALLOWED with a reason; every file on
 * ALLOWED must still build one, so the list never outlives its reason.
 *
 * Offline: reads the test sources, runs nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, stripComments } from './helpers/importGraph.ts';

type Reason =
  /** The shim, the mapping it runs on, and the scripted ADK model built on it. */
  | 'shim'
  /** A provider's ADK class held to its contract adapter: the thin per-provider shim cases. */
  | 'provider shim cases'
  /** ADK's runner, sessions, tools and callbacks: the runtime WS2 replaces. */
  | 'ADK runtime'
  /** A provider suite still driven through its ADK class; its contract twin already asserts the bodies. */
  | 'ADK-path provider suite';

/** Every test file that may build an LlmRequest, relative to tests/, and why. */
const ALLOWED: Record<string, { reason: Reason; why: string }> = {
  // ── The shim's own tests ───────────────────────────────────────────────────
  'adkShim.test.ts': { reason: 'shim', why: 'AdkShim maps an LlmRequest to a ModelRequest and back (ADR 0053).' },
  'genaiMapping.test.ts': { reason: 'shim', why: 'the mapping between LlmRequest and ModelRequest the shim runs on.' },
  'helpers/scriptedLlm.ts': { reason: 'shim', why: 'ScriptedLlm, the shim around ScriptedModel, scripted in ADK terms.' },
  'telemetryLedger.test.ts': { reason: 'shim', why: 'what an ADK-path call records on its span, through the shim and TracedGemini.' },

  // ── Per-provider shim cases ────────────────────────────────────────────────
  'shimBodies.test.ts': { reason: 'provider shim cases', why: 'every ADK-path class sends its contract adapter’s body for the matrix inputs.' },
  'claudeAdapter.test.ts': { reason: 'provider shim cases', why: 'ClaudeLlm’s older reasoning spelling and event shape (ADR 0055).' },
  'responsesAdapter.test.ts': { reason: 'provider shim cases', why: 'GptLlm and GrokLlm keep the Responses usage meaning and tool record (ADR 0056).' },
  'chatCompletionsAdapter.test.ts': { reason: 'provider shim cases', why: 'the chat shims’ older spelling and final shape (ADR 0057).' },
  'adkGeminiAdapter.test.ts': { reason: 'provider shim cases', why: 'AdkGeminiAdapter runs ADK’s Gemini, and behind the shim.' },
  'errorResponse.test.ts': { reason: 'provider shim cases', why: 'the error LlmResponse each ADK-path class yields, which FallbackLlm reads (ADR 0044).' },
  'fallback.test.ts': { reason: 'provider shim cases', why: 'FallbackLlm, the ADK path’s fallback pair (ADR 0044).' },
  'fallbackAdapter.test.ts': { reason: 'provider shim cases', why: 'FallbackAdapter behind the shim, against FallbackLlm.' },

  // ── The ADK runtime (WS2) and the boundary suite (WS2-12) ──────────────────
  'syndicateTurn.test.ts': { reason: 'ADK runtime', why: 'the boundary suite, on ADK until WS2-12.' },
  'fixtures/sessions/scenarios.ts': { reason: 'ADK runtime', why: 'stored-session fixtures recorded through ADK’s runner.' },
  'memoryTools.test.ts': { reason: 'ADK runtime', why: 'ADK’s memory tools write into the LlmRequest (processLlmRequest).' },
  'toolBaseRest.test.ts': { reason: 'ADK runtime', why: 'the ADK sentinels and request processors beside the engine’s own tools (ADR 0062).' },
  'selfCorrection.test.ts': { reason: 'ADK runtime', why: 'an ADK before-model callback reads the request.' },
  'skillHarness.test.ts': { reason: 'ADK runtime', why: 'reads the tools ADK declared on the request.' },
  'reasoningState.test.ts': { reason: 'ADK runtime', why: 'Claude’s reasoning state through ADK’s runner and storage (ADR 0046).' },
  'responsesReasoningState.test.ts': { reason: 'ADK runtime', why: 'Responses reasoning items through ADK’s runner and storage (ADR 0050).' },
  'kimiReasoningState.test.ts': { reason: 'ADK runtime', why: 'Kimi’s reasoning_content through ADK’s runner and storage (ADR 0046).' },

  // ── ADK-path provider suites (their contract twins assert the same bodies) ─
  'claudeCurrentApi.test.ts': { reason: 'ADK-path provider suite', why: 'ClaudeLlm per generation (ADR 0049); claudeAdapter.test.ts asserts the same bodies from ModelRequests.' },
  'claudeVision.test.ts': { reason: 'ADK-path provider suite', why: 'ClaudeLlm’s image blocks and span; claudeAdapter.test.ts covers blobs on the contract.' },
  'reasoningKey.test.ts': { reason: 'ADK-path provider suite', why: 'the compiler’s reasoning: config through each ADK class (ADR 0047).' },
};

/** The model suites this ticket moved onto the contract: never allowed back. */
const ON_THE_CONTRACT = ['models.test.ts', 'capabilityMatrix.test.ts', 'endpoints.test.ts', 'gateway.test.ts', 'modelRetry.test.ts'];

const BUILDS_LLM_REQUEST = /\bLlmRequest\b|\bmodelRequestToLlmRequest\b|\btoolsDict\b|\bliveConnectConfig\b/;

const TESTS = path.join(ROOT, 'tests');

/** This suite: its patterns name what they look for. */
const SELF = 'llmRequestBoundary.test.ts';

/** Every .ts file under tests/ but this one, relative to tests/, with forward slashes. */
function testSources(dir = TESTS): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testSources(full));
    else if (entry.name.endsWith('.ts')) out.push(path.relative(TESTS, full).split(path.sep).join('/'));
  }
  return out.filter((file) => file !== SELF).sort();
}

const buildsLlmRequest = (file: string) => BUILDS_LLM_REQUEST.test(stripComments(fs.readFileSync(path.join(TESTS, file), 'utf8')));

test('only the allowlisted tests build an ADK LlmRequest; the rest assert from a ModelRequest', () => {
  const offenders = testSources().filter((file) => buildsLlmRequest(file) && !(file in ALLOWED));
  assert.deepEqual(offenders, [], 'drive the contract adapter with a ModelRequest, or add the file to ALLOWED with its reason');
});

test('every allowlisted file exists and still builds an LlmRequest', () => {
  const sources = new Set(testSources());
  for (const file of Object.keys(ALLOWED)) {
    assert.ok(sources.has(file), `${file} is allowlisted but does not exist`);
    assert.ok(buildsLlmRequest(file), `${file} no longer builds an LlmRequest: remove it from ALLOWED`);
  }
});

test('the model suites on the contract stay off the list', () => {
  for (const file of ON_THE_CONTRACT) {
    assert.ok(!(file in ALLOWED), `${file} asserts from ModelRequests`);
    assert.equal(buildsLlmRequest(file), false, `${file} builds an LlmRequest`);
  }
});

test('the scan sees an LlmRequest however a file builds one, and skips comments', () => {
  const code = (src: string) => BUILDS_LLM_REQUEST.test(stripComments(src));
  assert.equal(code("import type { LlmRequest } from '@google/adk';"), true);
  assert.equal(code('const r = modelRequestToLlmRequest(request);'), true);
  assert.equal(code("const r: any = { model: 'm', contents: [], toolsDict: {} };"), true);
  assert.equal(code('// an LlmRequest, mentioned in a comment\nconst r = 1;'), false);
  assert.equal(code('/** llmRequestToModelRequest maps it */ const r = 1;'), false);
  assert.equal(code('const r = llmRequestToModelRequest;'), false, 'the other direction is the shim’s, and names no LlmRequest');
});
