/**
 * tests/llmRequestBoundary.test.ts — which tests may build a genai-shaped
 * LlmRequest.
 *
 * The model tests assert from a ModelRequest (lib/models/contract.ts, ADR
 * 0048) to the wire body. The genai-shaped LlmRequest (lib/models/genaiMapping.ts)
 * remains only where the engine speaks genai: the mapping itself, the
 * scripted model the turn suites are written in (tests/helpers/scriptedLlm.ts,
 * which reads the request the way the recorded ADK references did, ADR 0108),
 * the suites and fixtures scripted through it, and the tool suites that read
 * a declared tool set off that request. This suite keeps that list.
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
  /** The genai mapping and the scripted model the turn suites are written in. */
  | 'genai mapping'
  /** A suite or fixture whose scripted model reads the request it is given. */
  | 'scripted turn'
  /** A tool suite that reads the tools declared on the request. */
  | 'declared tools';

/** Every test file that may build an LlmRequest, relative to tests/, and why. */
const ALLOWED: Record<string, { reason: Reason; why: string }> = {
  // ── The mapping and the scripted model ─────────────────────────────────────
  'genaiMapping.test.ts': { reason: 'genai mapping', why: 'the mapping between the genai shapes and the contract the Gemini adapter speaks.' },
  'helpers/scriptedLlm.ts': { reason: 'genai mapping', why: 'ScriptedLlm, scripted in the genai shapes the recorded references read (ADR 0108).' },

  // ── Scripted turns ─────────────────────────────────────────────────────────
  'syndicateTurn.test.ts': { reason: 'scripted turn', why: 'the boundary suite scripts its models with ScriptedLlm.' },
  'fixtures/sessions/scenarios.ts': { reason: 'scripted turn', why: 'the stored-session scenarios read the scripted request.' },
  'reasoningState.test.ts': { reason: 'scripted turn', why: 'Claude’s reasoning state read back off the scripted request (ADR 0046).' },
  'kimiReasoningState.test.ts': { reason: 'scripted turn', why: 'Kimi’s reasoning_content read back off a genai-shaped request (ADR 0046).' },

  // ── Declared tools ─────────────────────────────────────────────────────────
  'toolBaseRest.test.ts': { reason: 'declared tools', why: 'the engine’s own tools declared onto a genai-shaped request (ADR 0062).' },
  'skillHarness.test.ts': { reason: 'declared tools', why: 'reads the tools the harness declared on the request.' },
};

/** The model suites moved onto the contract (WS1-11, WS1-15): never allowed back. */
const ON_THE_CONTRACT = [
  'models.test.ts',
  'capabilityMatrix.test.ts',
  'endpoints.test.ts',
  'gateway.test.ts',
  'modelRetry.test.ts',
  'claudeCurrentApi.test.ts',
  'claudeVision.test.ts',
  'reasoningKey.test.ts',
];

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

test('only the allowlisted tests build an LlmRequest; the rest assert from a ModelRequest', () => {
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
  assert.equal(code("import type { LlmRequest } from '../lib/models/genaiMapping.ts';"), true);
  assert.equal(code('const r = modelRequestToLlmRequest(request);'), true);
  assert.equal(code("const r: any = { model: 'm', contents: [], toolsDict: {} };"), true);
  assert.equal(code('// an LlmRequest, mentioned in a comment\nconst r = 1;'), false);
  assert.equal(code('/** llmRequestToModelRequest maps it */ const r = 1;'), false);
  assert.equal(code('const r = llmRequestToModelRequest;'), false, 'the other direction names no LlmRequest');
});
