/**
 * tests/gateway.test.ts — the one-key fallback, offline.
 *
 * No network, no real keys: the env is set and restored around each test.
 * Covers the transport rule (direct when the key is present, gateway only
 * when it is absent and configured, never for Ollama, never over a BYOK
 * key), wire-name mapping, the registry's instance factory, and the
 * capability report that names what a path drops.
 *
 * The gateway's request is asserted on the engine's contract: GatewayAdapter
 * given a ModelRequest.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  GATEWAYS,
  gatewayConfig,
  gatewayExceptions,
  gatewayPreference,
  gatewayProblem,
  gatewayWireModel,
  planTransport,
} from '../lib/models/gateway.ts';
import { describeCapabilities, capabilitySummary } from '../lib/models/capabilities.ts';
import { providerStatuses, resolveAdapter, resolveModel } from '../lib/models/registry.ts';
import type { ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { GatewayAdapter } from '../lib/models/gatewayAdapter.ts';
import { ClaudeAdapter } from '../lib/models/claudeAdapter.ts';
import { OllamaAdapter } from '../lib/models/ollamaAdapter.ts';

const ENV_KEYS = [
  'GOOGLE_GENAI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'TYPESAFE_API_KEY',
  'MODEL_GATEWAY',
  'MODEL_GATEWAY_API_KEY',
  'MODEL_GATEWAY_BASE_URL',
  'MODEL_GATEWAY_MODEL_MAP',
  'MODEL_GATEWAY_PREFER',
  'MODEL_GATEWAY_EXCEPT',
];

/** Runs fn with ONLY the given env vars set (of the ones this suite touches). */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── gatewayConfig / gatewayProblem ───────────────────────────────────────────

test('gateway is off when MODEL_GATEWAY is unset', () => {
  withEnv({}, () => {
    assert.equal(gatewayConfig(), null);
    assert.equal(gatewayProblem(), undefined);
  });
});

test('an unknown gateway id is a named problem, not a silent route, and its value is never repeated', () => {
  const pasted = 'fake-pasted-key-0123456789';
  withEnv({ MODEL_GATEWAY: pasted, MODEL_GATEWAY_API_KEY: 'k' }, () => {
    assert.equal(gatewayConfig(), null);
    const problem = gatewayProblem()!;
    assert.match(problem, /MODEL_GATEWAY is set to an unrecognised value \(not shown\); it must be one of: vercel, openrouter/);
    assert.ok(!problem.includes(pasted));
  });
});

test('a gateway without its key is a named problem', () => {
  withEnv({ MODEL_GATEWAY: 'vercel' }, () => {
    assert.equal(gatewayConfig()?.keyPresent, false);
    assert.match(gatewayProblem()!, /MODEL_GATEWAY_API_KEY is not/);
  });
});

test('MODEL_GATEWAY_BASE_URL overrides the endpoint (self-hosted proxies)', () => {
  withEnv(
    { MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'k', MODEL_GATEWAY_BASE_URL: 'http://localhost:4000/v1/' },
    () => {
      assert.equal(gatewayConfig()?.baseUrl, 'http://localhost:4000/v1');
    },
  );
});

// ── Wire names ───────────────────────────────────────────────────────────────

test('gatewayWireModel prefixes the provider slug and dots the Anthropic version', () => {
  withEnv({}, () => {
    assert.equal(gatewayWireModel('claude-sonnet-4-6', GATEWAYS.vercel), 'anthropic/claude-sonnet-4.6');
    assert.equal(gatewayWireModel('claude-haiku-4-5-20251001', GATEWAYS.vercel), 'anthropic/claude-haiku-4.5-20251001');
    assert.equal(gatewayWireModel('gpt-5-mini', GATEWAYS.vercel), 'openai/gpt-5-mini');
    assert.equal(gatewayWireModel('gemini-3.8-flash', GATEWAYS.vercel), 'google/gemini-3.8-flash');
    assert.equal(gatewayWireModel('grok-4.7', GATEWAYS.vercel), 'xai/grok-4.7');
    assert.equal(gatewayWireModel('grok-4.7', GATEWAYS.openrouter), 'x-ai/grok-4.7');
    assert.equal(gatewayWireModel('kimi-k3', GATEWAYS.openrouter), 'moonshotai/kimi-k3');
    assert.equal(gatewayWireModel('kimi-k3', GATEWAYS.vercel), 'moonshotai/kimi-k3');
    assert.equal(gatewayWireModel('deepseek-flash', GATEWAYS.openrouter), 'deepseek/deepseek-flash');
    assert.equal(gatewayWireModel('deepseek-v4-pro', GATEWAYS.vercel), 'deepseek/deepseek-v4-pro');
    // Already qualified ids pass through; Ollama ids are never mapped.
    assert.equal(gatewayWireModel('anthropic/claude-opus-5', GATEWAYS.vercel), 'anthropic/claude-opus-5');
    assert.equal(gatewayWireModel('ollama/qwen3:8b', GATEWAYS.vercel), 'ollama/qwen3:8b');
  });
});

test('MODEL_GATEWAY_MODEL_MAP overrides the mapper per id', () => {
  withEnv({ MODEL_GATEWAY_MODEL_MAP: 'claude-sonnet-4-6=anthropic/claude-sonnet-4.6-latest, bad, gpt-5-mini=openai/gpt-5-mini-2026' }, () => {
    assert.equal(gatewayWireModel('claude-sonnet-4-6', GATEWAYS.vercel), 'anthropic/claude-sonnet-4.6-latest');
    assert.equal(gatewayWireModel('gpt-5-mini', GATEWAYS.openrouter), 'openai/gpt-5-mini-2026');
    assert.equal(gatewayWireModel('grok-4.7', GATEWAYS.openrouter), 'x-ai/grok-4.7');
  });
});

// ── The transport rule ───────────────────────────────────────────────────────

test('a present direct key always wins over a configured gateway', () => {
  withEnv({ ANTHROPIC_API_KEY: 'a', MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'g' }, () => {
    const plan = planTransport('claude-sonnet-4-6');
    assert.equal(plan.transport, 'direct');
    assert.equal(plan.funded, true);
  });
});

test('an absent direct key falls through to the gateway when one is usable', () => {
  withEnv({ MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'g' }, () => {
    for (const id of ['claude-sonnet-4-6', 'gpt-5-mini', 'grok-4.7', 'gemini-3.8-flash']) {
      const plan = planTransport(id);
      assert.equal(plan.transport, 'gateway', id);
      assert.equal(plan.gateway?.id, 'openrouter', id);
      assert.equal(plan.funded, true, id);
    }
  });
});

test('an absent key with no gateway is unfunded, and says which var funds it', () => {
  withEnv({}, () => {
    const plan = planTransport('grok-4.7');
    assert.equal(plan.transport, 'direct');
    assert.equal(plan.funded, false);
    assert.equal(plan.keyEnv, 'XAI_API_KEY');
  });
});

test('a gateway set without its key does not count as usable', () => {
  withEnv({ MODEL_GATEWAY: 'vercel' }, () => {
    assert.equal(planTransport('gpt-5-mini').funded, false);
  });
});

test('Ollama never routes through a gateway', () => {
  withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'g' }, () => {
    const plan = planTransport('ollama/qwen3:8b');
    assert.equal(plan.transport, 'direct');
    assert.equal(plan.funded, true);
  });
});

// ── The preference (ADR 0145) ────────────────────────────────────────────────

test('MODEL_GATEWAY_PREFER=gateway sends every cloud id through the gateway even beside its direct key; Ollama and a BYOK key stay direct', () => {
  withEnv({ ANTHROPIC_API_KEY: 'a', GOOGLE_GENAI_API_KEY: 'g', TYPESAFE_API_KEY: 't', MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k', MODEL_GATEWAY_PREFER: 'gateway' }, () => {
    assert.equal(gatewayPreference(), 'gateway');
    for (const id of ['claude-sonnet-4-6', 'gemini-3.8-flash', 'jev-latest', 'gpt-5-mini']) {
      const plan = planTransport(id);
      assert.equal(plan.transport, 'gateway', id);
      assert.equal(plan.funded, true, id);
    }
    assert.equal(planTransport('ollama/qwen3:8b').transport, 'direct');
    assert.equal(planTransport('gemini-3.8-flash', { callerKey: true }).transport, 'direct', "the caller's own key is what the caller asked for");
    const statuses = Object.fromEntries(providerStatuses().map((s) => [s.provider, s.transport]));
    assert.equal(statuses.anthropic, 'gateway');
    assert.equal(statuses.gemini, 'gateway');
    assert.equal(statuses.ollama, 'direct');
    assert.ok(resolveAdapter('claude-sonnet-4-6') instanceof GatewayAdapter, 'the adapter follows the plan');
  });
});

test('MODEL_GATEWAY_PREFER=gateway without a usable gateway changes nothing: the direct key still serves', () => {
  withEnv({ ANTHROPIC_API_KEY: 'a', MODEL_GATEWAY_PREFER: 'gateway' }, () => {
    assert.deepEqual([planTransport('claude-sonnet-4-6').transport, planTransport('claude-sonnet-4-6').funded], ['direct', true]);
    assert.ok(resolveAdapter('claude-sonnet-4-6') instanceof ClaudeAdapter);
  });
});

test('MODEL_GATEWAY_EXCEPT turns the preference round for the providers it names, either way; unknown words and ollama are refused by name', () => {
  withEnv({ ANTHROPIC_API_KEY: 'a', GOOGLE_GENAI_API_KEY: 'g', MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'k', MODEL_GATEWAY_PREFER: 'gateway', MODEL_GATEWAY_EXCEPT: 'gemini' }, () => {
    assert.deepEqual([...gatewayExceptions()], ['gemini']);
    assert.equal(planTransport('gemini-3.8-flash').transport, 'direct', 'kept on its own key for grounding');
    assert.equal(planTransport('claude-sonnet-4-6').transport, 'gateway');
    assert.equal(gatewayProblem(), undefined);
  });
  withEnv({ ANTHROPIC_API_KEY: 'a', XAI_API_KEY: 'x', MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'k', MODEL_GATEWAY_EXCEPT: 'xai' }, () => {
    assert.equal(gatewayPreference(), 'direct');
    assert.equal(planTransport('grok-4.7').transport, 'gateway', 'an exception under the default sends that provider through the gateway');
    assert.equal(planTransport('claude-sonnet-4-6').transport, 'direct');
  });
  withEnv({ XAI_API_KEY: 'x', MODEL_GATEWAY_EXCEPT: 'xai' }, () => {
    assert.equal(planTransport('grok-4.7').transport, 'direct', 'no usable gateway: the exception cannot be honoured, the key serves');
  });
  withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k', MODEL_GATEWAY_PREFER: 'sideways' }, () => {
    assert.match(gatewayProblem() ?? '', /MODEL_GATEWAY_PREFER=sideways is not a preference/);
    assert.equal(gatewayPreference(), 'direct', 'an unrecognised value reads as the default');
  });
  withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k', MODEL_GATEWAY_EXCEPT: 'ollama,claude' }, () => {
    assert.match(gatewayProblem() ?? '', /MODEL_GATEWAY_EXCEPT names ollama, claude/);
    assert.equal(gatewayExceptions().size, 0);
  });
});

test("a caller's BYOK key funds the direct path and never falls through", () => {
  withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'g' }, () => {
    assert.equal(planTransport('gemini-3.8-flash', { callerKey: true }).transport, 'direct');
    assert.equal(planTransport('gemini-3.8-flash').transport, 'gateway');
  });
});

// ── Registry integration ─────────────────────────────────────────────────────

test('providerStatuses marks gateway-covered providers available with transport=gateway', () => {
  withEnv({ GOOGLE_GENAI_API_KEY: 'g', MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k' }, () => {
    const by = Object.fromEntries(providerStatuses().map((s) => [s.provider, s]));
    assert.equal(by.gemini.transport, 'direct');
    assert.equal(by.anthropic.available, true);
    assert.equal(by.anthropic.transport, 'gateway');
    assert.equal(by.anthropic.gateway, 'vercel');
    assert.equal(by.ollama.transport, 'direct');
  });
});

test('providerStatuses stays unavailable when the gateway is misconfigured', () => {
  withEnv({ MODEL_GATEWAY: 'vercel' }, () => {
    const by = Object.fromEntries(providerStatuses().map((s) => [s.provider, s]));
    assert.equal(by.anthropic.available, false);
    assert.match(by.anthropic.reason!, /ANTHROPIC_API_KEY/);
  });
});

test('resolveAdapter and resolveModel return the gateway adapter only when the direct key is absent', () => {
  withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k' }, () => {
    assert.ok(resolveAdapter('claude-sonnet-4-6') instanceof GatewayAdapter);
    assert.ok(resolveAdapter('ollama/qwen3:8b') instanceof OllamaAdapter);
    assert.ok(resolveModel('claude-sonnet-4-6') instanceof GatewayAdapter);
    assert.ok(resolveModel('ollama/qwen3:8b') instanceof OllamaAdapter);
  });
  withEnv({ ANTHROPIC_API_KEY: 'a', MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k' }, () => {
    assert.ok(resolveAdapter('claude-sonnet-4-6') instanceof ClaudeAdapter);
    assert.ok(resolveModel('claude-sonnet-4-6') instanceof ClaudeAdapter);
  });
});

test('a BYOK key for the caller provider stays direct', () => {
  withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k' }, () => {
    assert.ok(resolveAdapter('claude-sonnet-4-6', { apiKey: 'caller', keyProvider: 'anthropic' }) instanceof ClaudeAdapter);
    const model = resolveModel('claude-sonnet-4-6', { apiKey: 'caller', defaultProvider: 'anthropic' });
    assert.ok(model instanceof ClaudeAdapter);
  });
});

// ── The gateway adapter's request shape ──────────────────────────────────────

const hello = (model: string, text = 'hello'): ModelRequest => ({ model, messages: [{ role: 'user', parts: [{ type: 'text', text }] }] });

async function drain(gen: AsyncIterable<ModelResponse>): Promise<ModelResponse[]> {
  const out: ModelResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

test('GatewayAdapter posts to the gateway with a bearer key and the mapped model id, attributing the upstream provider', async () => {
  await withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'secret-key' }, async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;
    try {
      const adapter = new GatewayAdapter({ model: 'claude-sonnet-4-6' });
      const out = await drain(adapter.generate(hello('claude-sonnet-4-6')));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-key');
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.model, 'anthropic/claude-sonnet-4.6');
      assert.deepEqual(out.at(-1)?.parts, [{ type: 'text', text: 'hi' }]);
      // Attribution: the span/ledger provider is the upstream, not "gateway".
      assert.equal(adapter.provider, 'anthropic');
      assert.equal(adapter.transport(), 'gateway:vercel');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('GatewayAdapter without a key ends on a clear error and makes no request', async () => {
  await withEnv({ MODEL_GATEWAY: 'vercel' }, async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}');
    }) as any;
    try {
      const out = await drain(new GatewayAdapter({ model: 'gpt-5-mini' }).generate(hello('gpt-5-mini', 'x')));
      assert.equal(called, false);
      const final = out.at(-1);
      assert.ok(final && !final.partial);
      assert.equal(final.error?.code, 'GATEWAY_KEY_MISSING');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── Capability report ────────────────────────────────────────────────────────

test('describeCapabilities: native on the direct path, dropped through a gateway, portable tools always kept', () => {
  withEnv({ GOOGLE_GENAI_API_KEY: 'g' }, () => {
    const r = describeCapabilities('gemini-3.8-flash', ['web_search', 'wiki_search']);
    assert.deepEqual(r.native, ['web_search']);
    assert.deepEqual(r.dropped, []);
    assert.deepEqual(r.portable, ['wiki_search']);
    assert.equal(capabilitySummary('A', r), undefined);
  });
  withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k' }, () => {
    const r = describeCapabilities('grok-4.7', ['web_search', 'x_search', 'web_extract']);
    assert.equal(r.transport, 'gateway');
    assert.deepEqual(r.dropped, ['web_search', 'x_search']);
    assert.deepEqual(r.portable, ['web_extract']);
    assert.match(capabilitySummary('XScout', r)!, /via gateway:vercel — dropped web_search, x_search/);
  });
});

test('describeCapabilities: provider-specific sentinels are dropped on the wrong direct provider', () => {
  withEnv({ ANTHROPIC_API_KEY: 'a' }, () => {
    const r = describeCapabilities('claude-sonnet-4-6', ['google_search', 'web_search']);
    assert.deepEqual(r.native, ['web_search']);
    assert.deepEqual(r.dropped, ['google_search']);
    assert.match(capabilitySummary('J', r)!, /no native google_search/);
  });
});

test('describeCapabilities: an unfunded path says which variable funds it', () => {
  withEnv({}, () => {
    const r = describeCapabilities('gpt-5-mini', []);
    assert.equal(r.funded, false);
    assert.match(capabilitySummary('G', r)!, /set OPENAI_API_KEY/);
  });
});

test('describeCapabilities: a local model drops search and says why', () => {
  withEnv({}, () => {
    const r = describeCapabilities('ollama/qwen3:8b', ['web_search']);
    assert.equal(r.funded, true);
    assert.deepEqual(r.dropped, ['web_search']);
    assert.match(capabilitySummary('T', r)!, /local model has no native search/);
  });
});
