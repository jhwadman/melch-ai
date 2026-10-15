/**
 * tests/credentialSource.test.ts — credentials read through a source the
 * embedding application sets (ADR 0133): presence checks, the gateway, an
 * adapter's outgoing request, env-taking helpers, fallback to the
 * environment, and a source that throws. Offline: fetch is a stub.
 */
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { credentialEnv, credentialValue, setCredentialSource } from '../lib/models/credentialSource.ts';
import { providerKeyPresent } from '../lib/models/providerMap.ts';
import { gatewayConfig } from '../lib/models/gateway.ts';
import { KimiAdapter } from '../lib/models/kimiAdapter.ts';
import { endpointFromEnv } from '../lib/models/endpoints.ts';
import * as barrel from '../lib/index.ts';

const NAMES = ['ANTHROPIC_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'MODEL_GATEWAY', 'MODEL_GATEWAY_API_KEY', 'AZURE_OPENAI_API_KEY', 'OPENAI_PLATFORM', 'AZURE_OPENAI_ENDPOINT'];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
for (const n of NAMES) delete process.env[n];

afterEach(() => {
  setCredentialSource(undefined);
  for (const n of NAMES) delete process.env[n];
});

after(() => {
  for (const n of NAMES) if (saved[n] !== undefined) process.env[n] = saved[n];
});

const vault = (held: Record<string, string>) => (name: string) => held[name];

test('the barrel exports the source', () => {
  assert.equal(typeof barrel.setCredentialSource, 'function');
  assert.equal(typeof barrel.credentialValue, 'function');
});

test('provider presence follows the source, with the environment empty', () => {
  assert.equal(providerKeyPresent('anthropic'), false);
  setCredentialSource(vault({ ANTHROPIC_API_KEY: 'sk-ant-from-vault', GEMINI_API_KEY: 'g-from-vault' }));
  assert.equal(providerKeyPresent('anthropic'), true);
  assert.equal(providerKeyPresent('gemini'), true, 'either Gemini name counts');
  assert.equal(providerKeyPresent('xai'), false);
});

test('the source wins over the environment; a name it does not hold falls back', () => {
  process.env.ANTHROPIC_API_KEY = 'from-env';
  process.env.MOONSHOT_API_KEY = 'moon-from-env';
  setCredentialSource(vault({ ANTHROPIC_API_KEY: 'from-vault' }));
  assert.equal(credentialValue('ANTHROPIC_API_KEY'), 'from-vault');
  assert.equal(credentialValue('MOONSHOT_API_KEY'), 'moon-from-env');
});

test('a source that throws holds nothing, and the engine keeps running', () => {
  process.env.ANTHROPIC_API_KEY = 'from-env';
  setCredentialSource(() => {
    throw new Error('keychain locked');
  });
  assert.equal(credentialValue('ANTHROPIC_API_KEY'), 'from-env');
});

test('the key is read at each call: a key removed from the source stops being sent', async () => {
  const held: Record<string, string> = { MOONSHOT_API_KEY: 'moon-v1' };
  setCredentialSource((n) => held[n]);
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: any) => {
    sent.push(String(new Headers(init?.headers).get('authorization') ?? ''));
    return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const req = { model: 'kimi-k3', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] } as any;
    const drain = async () => { const out = []; for await (const r of new KimiAdapter({ model: 'kimi-k3' }).generate(req)) out.push(r); return out; };
    await drain();
    assert.equal(sent[0], 'Bearer moon-v1');
    delete held.MOONSHOT_API_KEY;
    const out = await drain();
    assert.equal(sent.length, 1, 'no request without a key');
    assert.match(JSON.stringify(out.at(-1)), /MOONSHOT_API_KEY/, 'the failure names the variable');
    assert.ok(!JSON.stringify(out).includes('moon-v1'));
  } finally {
    globalThis.fetch = real;
  }
});

test('the gateway key and env-taking helpers see the source', () => {
  process.env.MODEL_GATEWAY = 'openrouter';
  setCredentialSource(vault({ MODEL_GATEWAY_API_KEY: 'gw-from-vault', AZURE_OPENAI_API_KEY: 'az-from-vault' }));
  assert.equal(gatewayConfig()?.keyPresent, true);
  process.env.OPENAI_PLATFORM = 'azure';
  process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';
  assert.equal(endpointFromEnv('openai').apiKey, 'az-from-vault');
  assert.equal(credentialEnv({ OTHER: 'x' }).OTHER, 'x', 'other names read through to the given env');
});
