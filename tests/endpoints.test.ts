/**
 * tests/endpoints.test.ts — configured endpoints and cloud platforms
 * (ADR 0023, lib/models/endpoints.ts). Offline: the Bedrock, Vertex AI and
 * Entra ID SDKs are mocked through setSdkImporter, Azure OpenAI through a
 * captured fetch. These paths are not verified against the live clouds.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel, LogLevel } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import {
  azureBaseURL,
  claudeClientSpec,
  endpointFromEnv,
  endpointProblems,
  platformModel,
  providerReady,
  setSdkImporter,
} from '../lib/models/endpoints.ts';
import { ClaudeLlm } from '../lib/models/claudeLlm.ts';
import { GptLlm } from '../lib/models/gptLlm.ts';
import { TracedGemini, resolveModel } from '../lib/models/registry.ts';
import { capabilityOf, describeCapabilities } from '../lib/models/capabilities.ts';
import { endpointRows } from '../lib/doctor.ts';
import { WEB_SEARCH } from '../lib/tools/webSearchTool.ts';

setLogLevel(LogLevel.ERROR);

const ENV_KEYS = [
  'GEMINI_PLATFORM', 'ANTHROPIC_PLATFORM', 'OPENAI_PLATFORM', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY',
  'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_MODEL_MAP', 'OPENAI_MODEL_MAP', 'GEMINI_MODEL_MAP',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MODEL_GATEWAY',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function withEnv(vars: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setSdkImporter(undefined);
});

const req = (model: string, tools = false): LlmRequest =>
  ({
    model,
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    liveConnectConfig: {} as any,
    toolsDict: tools ? { web_search: WEB_SEARCH } : {},
    config: {},
  }) as unknown as LlmRequest;

async function drain(gen: AsyncGenerator<LlmResponse, void>): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

test('the environment selects a platform per provider; direct is the default', () => {
  withEnv({});
  assert.deepEqual(endpointFromEnv('anthropic'), { platform: 'direct' });
  withEnv({ ANTHROPIC_PLATFORM: 'bedrock', AWS_REGION: 'us-east-1', ANTHROPIC_MODEL_MAP: '{"claude-x":"us.anthropic.claude-x-v1:0"}' });
  const e = endpointFromEnv('anthropic');
  assert.equal(e.platform, 'bedrock');
  assert.equal(e.region, 'us-east-1');
  assert.equal(platformModel(e, 'claude-x'), 'us.anthropic.claude-x-v1:0');
  assert.equal(platformModel(e, 'claude-y'), 'claude-y', 'unlisted ids pass through');

  withEnv({ GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'global' });
  assert.deepEqual(endpointFromEnv('gemini'), { platform: 'vertex', project: 'p', location: 'global' }, "genai's own switch is honoured");

  withEnv({ OPENAI_PLATFORM: 'bedrock' });
  assert.throws(() => endpointFromEnv('openai'), /not a platform for OpenAI/);
  withEnv({ ANTHROPIC_MODEL_MAP: 'nope' });
  assert.throws(() => endpointFromEnv('anthropic'), /ANTHROPIC_MODEL_MAP must be a JSON object/);
});

test('Azure OpenAI uses the v1 API under the resource endpoint', () => {
  assert.equal(azureBaseURL('https://r.openai.azure.com'), 'https://r.openai.azure.com/openai/v1/');
  assert.equal(azureBaseURL('https://r.openai.azure.com/'), 'https://r.openai.azure.com/openai/v1/');
  assert.equal(azureBaseURL('https://r.openai.azure.com/openai/v1'), 'https://r.openai.azure.com/openai/v1/');
});

test('a cloud platform is ready when configured, without a vendor API key', () => {
  withEnv({ ANTHROPIC_PLATFORM: 'vertex', GOOGLE_CLOUD_PROJECT: 'p' });
  assert.deepEqual(endpointProblems('anthropic', endpointFromEnv('anthropic')), ['CLOUD_ML_REGION (or GOOGLE_CLOUD_LOCATION) not set']);
  assert.equal(providerReady('anthropic'), false);
  withEnv({ ANTHROPIC_PLATFORM: 'vertex', GOOGLE_CLOUD_PROJECT: 'p', CLOUD_ML_REGION: 'us-east5' });
  assert.equal(providerReady('anthropic'), true);
  withEnv({ OPENAI_PLATFORM: 'azure' });
  assert.equal(providerReady('openai'), false);
  withEnv({ OPENAI_PLATFORM: 'azure', AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com' });
  assert.equal(providerReady('openai'), true, 'no key: Entra ID');
});

test('claudeClientSpec picks the SDK client for each platform', () => {
  assert.deepEqual(claudeClientSpec({ platform: 'bedrock', region: 'eu-west-1' }, undefined), {
    module: '@anthropic-ai/bedrock-sdk', exportNames: ['AnthropicBedrock', 'default'], options: { awsRegion: 'eu-west-1' },
  });
  assert.deepEqual(claudeClientSpec({ platform: 'vertex', project: 'p', location: 'us-east5' }, undefined), {
    module: '@anthropic-ai/vertex-sdk', exportNames: ['AnthropicVertex', 'default'], options: { projectId: 'p', region: 'us-east5' },
  });
  assert.deepEqual(claudeClientSpec({ platform: 'direct', baseURL: 'https://proxy.internal' }, 'fixture-key'), {
    module: '@anthropic-ai/sdk', exportNames: ['default', 'Anthropic'], options: { apiKey: 'fixture-key', baseURL: 'https://proxy.internal' },
  });
  assert.deepEqual(claudeClientSpec({ platform: 'direct' }, undefined), { error: 'ANTHROPIC_API_KEY is not set in environment.' });
  assert.match((claudeClientSpec({ platform: 'bedrock' }, undefined) as any).error, /AWS_REGION not set/);
});

test('Claude on Bedrock: the Bedrock client, the mapped id, web_search not sent', async () => {
  withEnv({ ANTHROPIC_PLATFORM: 'bedrock', AWS_REGION: 'us-east-1', ANTHROPIC_MODEL_MAP: '{"claude-sonnet-x":"us.anthropic.claude-sonnet-x-v1:0"}' });
  let options: any;
  let body: any;
  class AnthropicBedrock {
    messages = {
      create: async (b: any) => {
        body = b;
        return { content: [{ type: 'text', text: 'hi from bedrock' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    // An id the generation table does not know takes drop_block's beta (ADR 0049).
    beta = { messages: this.messages };
    constructor(o: any) {
      options = o;
    }
  }
  const imported: string[] = [];
  setSdkImporter(async (m) => {
    imported.push(m);
    return { AnthropicBedrock };
  });
  const out = await drain(new ClaudeLlm({ model: 'claude-sonnet-x' }).generateContentAsync(req('claude-sonnet-x', true)));
  assert.deepEqual(imported, ['@anthropic-ai/bedrock-sdk']);
  assert.deepEqual(options, { awsRegion: 'us-east-1' });
  assert.equal(body.model, 'us.anthropic.claude-sonnet-x-v1:0');
  assert.ok(!(body.tools ?? []).some((t: any) => t.name === 'web_search'), 'web_search is not sent on Bedrock');
  assert.equal(out.at(-1)?.content?.parts?.[0]?.text, 'hi from bedrock');
});

test('Claude on a cloud platform without its SDK says which package to install', async () => {
  withEnv({ ANTHROPIC_PLATFORM: 'vertex', GOOGLE_CLOUD_PROJECT: 'p', CLOUD_ML_REGION: 'us-east5' });
  setSdkImporter(async () => {
    throw new Error('Cannot find package');
  });
  const out = await drain(new ClaudeLlm({ model: 'claude-x' }).generateContentAsync(req('claude-x')));
  assert.equal(out[0]?.errorCode, 'SDK_NOT_INSTALLED');
  assert.match(out[0]?.errorMessage ?? '', /npm install @anthropic-ai\/vertex-sdk/);
});

/** One GptLlm request with fetch captured: the URL, headers and body. */
async function captureGpt(llm: GptLlm, request: LlmRequest) {
  const originalFetch = globalThis.fetch;
  let seen: { url: string; headers: Headers; body: any } | undefined;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input.url;
    seen ??= { url, headers: new Headers(init?.headers), body: JSON.parse(init?.body ?? 'null') };
    return new Response(JSON.stringify({ error: { message: 'captured' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  }) as any;
  try {
    await drain(llm.generateContentAsync(request));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(seen, 'no request was sent');
  return seen!;
}

test('GPT on Azure OpenAI: the v1 endpoint, the deployment name, the key header, no web_search', async () => {
  withEnv({
    OPENAI_PLATFORM: 'azure',
    AZURE_OPENAI_ENDPOINT: 'https://acme.openai.azure.com',
    AZURE_OPENAI_API_KEY: 'fixture-azure-0123456789',
    OPENAI_MODEL_MAP: '{"gpt-5-mini":"acme-gpt5mini"}',
  });
  const seen = await captureGpt(new GptLlm({ model: 'gpt-5-mini' }), req('gpt-5-mini', true));
  assert.equal(seen.url, 'https://acme.openai.azure.com/openai/v1/responses');
  assert.equal(seen.body.model, 'acme-gpt5mini');
  assert.equal(seen.headers.get('authorization'), 'Bearer fixture-azure-0123456789');
  assert.ok(!(seen.body.tools ?? []).some((t: any) => t.type === 'web_search'));
});

test('GPT on Azure without a key authenticates with an Entra ID token', async () => {
  withEnv({ OPENAI_PLATFORM: 'azure', AZURE_OPENAI_ENDPOINT: 'https://acme.openai.azure.com' });
  let scope = '';
  setSdkImporter(async (m) => {
    assert.equal(m, '@azure/identity');
    return {
      DefaultAzureCredential: class {},
      getBearerTokenProvider: (_cred: unknown, s: string) => ((scope = s), async () => 'fixture-entra-token'),
    };
  });
  const seen = await captureGpt(new GptLlm({ model: 'gpt-5-mini' }), req('gpt-5-mini'));
  assert.equal(scope, 'https://cognitiveservices.azure.com/.default');
  assert.equal(seen.headers.get('authorization'), 'Bearer fixture-entra-token');
});

test('an OpenAI-compatible proxy: OPENAI_BASE_URL, or an endpoint from the credentials plug point', async () => {
  withEnv({ OPENAI_API_KEY: 'fixture-openai-0123456789', OPENAI_BASE_URL: 'https://llm-proxy.internal/v1' });
  let seen = await captureGpt(new GptLlm({ model: 'gpt-5-mini' }), req('gpt-5-mini', true));
  assert.equal(seen.url, 'https://llm-proxy.internal/v1/responses');
  assert.ok((seen.body.tools ?? []).some((t: any) => t.type === 'web_search'), 'a direct proxy keeps the native tool');

  withEnv({});
  const llm = resolveModel('gpt-5-mini', { endpoint: { baseURL: 'https://tenant-proxy.internal/v1', apiKey: 'fixture-tenant-key' } });
  seen = await captureGpt(llm as GptLlm, req('gpt-5-mini'));
  assert.equal(seen.url, 'https://tenant-proxy.internal/v1/responses');
  assert.equal(seen.headers.get('authorization'), 'Bearer fixture-tenant-key');
});

test('Gemini on Vertex AI: the ADK client in Vertex mode, no AI Studio key sent', () => {
  withEnv({ GEMINI_PLATFORM: 'vertex', GOOGLE_CLOUD_PROJECT: 'acme', GOOGLE_CLOUD_LOCATION: 'europe-west4', GOOGLE_GENAI_API_KEY: 'fixture-genai-0123456789' });
  const g = new TracedGemini({ model: 'gemini-x' }) as any;
  assert.equal(g.vertexai, true);
  assert.equal(g.project, 'acme');
  assert.equal(g.location, 'europe-west4');
  const byok = resolveModel('gemini-x', { apiKey: 'fixture-caller-0123456789' }) as any;
  assert.equal(byok.vertexai, true);
  assert.equal(byok.apiKey, undefined, "a caller's AI Studio key is not sent to Vertex AI");
});

test('the capability report and matrix state the platform and what it drops', () => {
  withEnv({ ANTHROPIC_PLATFORM: 'bedrock', AWS_REGION: 'us-east-1', GEMINI_PLATFORM: 'vertex', GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'global' });
  const claude = describeCapabilities('claude-x', ['web_search', 'web_extract']);
  assert.equal(claude.funded, true, 'Bedrock needs no ANTHROPIC_API_KEY');
  assert.equal(claude.platform, 'bedrock');
  assert.deepEqual(claude.dropped, ['web_search']);
  assert.equal(capabilityOf('claude-x', 'native_search').support, 'unsupported');
  const gemini = describeCapabilities('gemini-x', ['web_search']);
  assert.equal(gemini.platform, 'vertex');
  assert.deepEqual(gemini.native, ['web_search'], 'grounding is a Vertex AI feature too');
});

test('the doctor lists each configured endpoint, and what is missing', () => {
  withEnv({ ANTHROPIC_PLATFORM: 'bedrock', OPENAI_PLATFORM: 'azure', AZURE_OPENAI_ENDPOINT: 'https://acme.openai.azure.com', AZURE_OPENAI_API_KEY: 'fixture-azure-0123456789', GEMINI_PLATFORM: 'nope' });
  const rows = endpointRows();
  const claude = rows.find((r) => r.provider === 'anthropic')!;
  assert.equal(claude.platform, 'bedrock');
  assert.ok(claude.problems.includes('AWS_REGION not set'));
  assert.equal(claude.liveVerified, false);
  const gpt = rows.find((r) => r.provider === 'openai')!;
  assert.deepEqual(gpt.problems, []);
  assert.equal(gpt.credential, 'AZURE_OPENAI_API_KEY');
  assert.match(gpt.label, /Azure OpenAI \(acme\.openai\.azure\.com\)/);
  assert.equal(rows.find((r) => r.provider === 'gemini')!.platform, 'invalid');
  assert.equal(rows.some((r) => r.provider === 'xai'), false, 'default endpoints are not listed');
});

// ── trimTrailingSlashes (CodeQL js/polynomial-redos) ─────────────────────────

test('trimTrailingSlashes drops only trailing slashes, in one pass', async () => {
  const { trimTrailingSlashes } = await import('../lib/models/urls.ts');
  assert.equal(trimTrailingSlashes('https://api.moonshot.ai/v1///'), 'https://api.moonshot.ai/v1');
  assert.equal(trimTrailingSlashes('https://x.test/a/b'), 'https://x.test/a/b');
  assert.equal(trimTrailingSlashes('///'), '');
  assert.equal(trimTrailingSlashes(''), '');
  // A long run of slashes followed by another character: the old regex was
  // quadratic here; one pass from the end is immediate.
  const hostile = 'https://x.test' + '/'.repeat(200_000) + 'v1';
  const started = performance.now();
  assert.equal(trimTrailingSlashes(hostile), hostile);
  assert.ok(performance.now() - started < 200);
});
