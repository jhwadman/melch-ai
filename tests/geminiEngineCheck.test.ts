/**
 * tests/geminiEngineCheck.test.ts — the G3 live check script
 * (scripts/gemini_engine_check.ts) run offline: its arguments, and two of its
 * cases on the native runtime against a stubbed Gemini API, so the script the
 * orchestrator runs live is known to drive the engine's GeminiAdapter and to
 * read a pass from what Gemini answers. No provider is called; the key is a
 * fixture.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { main } from '../scripts/gemini_engine_check.ts';

const KEY = 'fixture-gemini-check-0123456789'; // gitleaks:allow (test fixture)
const ENV_KEYS = [
  'GOOGLE_GENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_PLATFORM', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GEMINI_MODEL_MAP', 'GEMINI_ADAPTER', 'MODEL_GATEWAY', 'MODEL_GATEWAY_API_KEY',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
let printed: string[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GOOGLE_GENAI_API_KEY = KEY;
  printed = [];
  console.log = (...args: unknown[]) => void printed.push(args.join(' '));
  console.error = (...args: unknown[]) => void printed.push(args.join(' '));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const candidate = (parts: object[], extra: object = {}) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', ...extra }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
});

test('the live check refuses a bad argument or a model that is not Gemini, before any call', async () => {
  globalThis.fetch = (async () => assert.fail('no call is made')) as typeof fetch;
  assert.equal(await main(['--model', 'claude-sonnet-4-6'], { readEnvFile: false }), 2);
  assert.equal(await main(['--cases', 'everything'], { readEnvFile: false }), 2);
  assert.equal(await main(['--runtimes', 'both'], { readEnvFile: false }), 2);
  assert.equal(await main(['--runtimes', 'adk'], { readEnvFile: false }), 2, 'the ADK runtime left in 1.0.0');
  assert.equal(await main(['--verbose'], { readEnvFile: false }), 2);
  delete process.env.GOOGLE_GENAI_API_KEY;
  assert.equal(await main([], { readEnvFile: false }), 2, 'no Gemini route');
});

test("the live check's grounding and code cases pass on the native runtime when Gemini answers as asked, and print no key", async () => {
  const hosts = new Set<string>();
  let calls = 0;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    calls++;
    hosts.add(new URL(String(url)).host);
    const body = JSON.parse(String(init.body));
    const tools = JSON.stringify(body.tools ?? []);
    const reply = tools.includes('googleSearch')
      ? candidate([{ text: 'IANA reserves example.com.' }], {
          groundingMetadata: { webSearchQueries: ['example.com reserved'], groundingChunks: [{ web: { uri: 'https://www.iana.org/help/example-domains', title: 'iana.org' } }] },
        })
      : candidate([{ executableCode: { language: 'PYTHON', code: 'print(5117)' } }, { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '5117\n' } }, { text: '5117' }]);
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const exit = await main(['--cases', 'grounding,code', '--model', 'gemini-3.5-flash'], { readEnvFile: false });
  assert.equal(exit, 0, printed.join('\n'));
  assert.deepEqual([...hosts], ['generativelanguage.googleapis.com']);
  assert.equal(calls, 2, 'one call per case');
  const lines = printed.filter((l) => /^(pass|FAIL)/.test(l));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.startsWith('pass')), lines.join('\n'));
  assert.ok(lines.some((l) => /grounding\s+native .*grounded/.test(l)));
  // The code and its result are stored as Gemini sent them (ADR 0100).
  assert.ok(lines.some((l) => /code\s+native .*2 code parts stored/.test(l)), 'code parts stored');
  assert.ok(!printed.join('\n').includes(KEY), 'the key is never printed');
});

test('the live check fails a case whose answer is wrong, and says why', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(candidate([{ text: '17' }])), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  assert.equal(await main(['--cases', 'code', '--runtimes', 'native'], { readEnvFile: false }), 1);
  assert.match(printed.join('\n'), /FAIL\s+code\s+native .*the answer is not 5117/);
});
