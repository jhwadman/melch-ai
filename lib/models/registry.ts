/**
 * lib/models/registry.ts — unified model routing. THE seam for model
 * optionality: an agent's YAML declares `model`, and this module makes sure
 * that string reaches the right provider adapter.
 *
 * THREE RESOLUTION PATHS, ONE PREFIX TABLE (lib/models/providerMap.ts):
 *
 *   1. registerAvailableProviders() — for entrypoints that pass `model` as a
 *      STRING to LlmAgent (scripts/syndicate_chat.ts). Registers every
 *      provider's own ADK class whose credentials exist into the ADK
 *      LLMRegistry; the registry then string-matches supportedModels patterns:
 *        claude-*  → ClaudeLlm      gpt-* / o<digit>* → GptLlm
 *        grok-*    → GrokLlm        ollama/<model>    → OllamaLlm
 *        kimi-*    → KimiLlm        gemini-*          → TracedGemini (ADK's Gemini + llm.request spans)
 *      Each non-Gemini class is the ADK shim around its contract adapter,
 *      with the provider's own toLlmResponse (ADR 0056, ADR 0057); never a
 *      bare adkShimClass, which would lose it.
 *
 *   2. resolveModel() — the ADK BaseLlm INSTANCE for one id, for BYOK paths
 *      (lib/a2a/app.ts), where a per-request API key or endpoint must be
 *      injected. The same classes. The YAML model string always wins over
 *      the X-Provider header (which only selects a DEFAULT model when the
 *      YAML omits `model` — a deprecated affordance).
 *
 *   3. resolveAdapter() — the engine's own ModelAdapter (lib/models/
 *      contract.ts, ADR 0048) for one id, with no ADK LLMRegistry, for the
 *      native loop (ADR 0045). The same transport rule (the gateway when the
 *      direct key is absent), the same BYOK and endpoint injection. Gemini
 *      ids get the temporary AdkGeminiAdapter until gate G3, or the engine's
 *      GeminiAdapter when GEMINI_ADAPTER=engine or `{ gemini: 'engine' }`
 *      asks for it (ADR 0060). resolveAdapterWithFallback() wraps a pair in a
 *      FallbackAdapter; the ADK path keeps FallbackLlm(shim, shim) (ADR 0053).
 *
 * Paths 2 and 3 read one routing step (routeFor) and one table per path
 * keyed by provider, so a key or endpoint reaches the same place on both.
 * routeFor and the contract table live in lib/models/adapterResolver.ts,
 * which imports no ADK; `melchizedek-agents/model` exports its resolver,
 * which gives a Gemini id GeminiAdapter (ADR 0068).
 *
 * Register BEFORE constructing any agent: the LLMRegistry caches model→class
 * resolution (LRU), so late registration can be masked by stale cache hits.
 */

import type { BaseLlm } from '@google/adk';
import { Gemini, adkInstalled, requireAdk } from '../adkPeer.ts';
import { endpointFromEnv, endpointProblems, providerReady } from './endpoints.ts';
import type { ProviderEndpoint } from './endpoints.ts';

import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GPT_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_KIMI_MODEL,
  DEFAULT_OLLAMA_MODEL,
} from '../config.ts';
import type { ModelAdapter } from './contract.ts';
import { AdkGeminiAdapter } from './adkGeminiAdapter.ts';
import { adapterResolver, geminiAdapterSetting, normalizeProvider, routeFor, scopedKey } from './adapterResolver.ts';
import type { GeminiAdapterChoice, ResolveAdapterOptions, Route } from './adapterResolver.ts';
import type { FallbackAdapterOptions } from './fallbackAdapter.ts';
import { TracedGemini } from './tracedGemini.ts';
import { ClaudeLlm, registerClaudeLlm } from './claudeLlm.ts';
import { GptLlm, registerGptLlm } from './gptLlm.ts';
import { GrokLlm, registerGrokLlm } from './grokLlm.ts';
import { KimiLlm, registerKimiLlm } from './kimiLlm.ts';
import { OllamaLlm, registerOllamaLlm } from './ollamaLlm.ts';
import { GatewayLlm, registerGatewayLlm } from './gatewayLlm.ts';
import { gatewayConfig, gatewayProblem, gatewayUsable } from './gateway.ts';
import {
  PROVIDERS,
  providerForModel,
  providerKeyPresent,
} from './providerMap.ts';
import type { ProviderId } from './providerMap.ts';

export { providerForModel, providerKeyPresent, PROVIDERS };
export {
  endpointFromEnv,
  endpointLabel,
  endpointProblems,
  PLATFORMS_FOR,
  platformFromEnv,
  providerReady,
} from './endpoints.ts';
export type { Platform, ProviderEndpoint } from './endpoints.ts';
export type { ProviderId };
export type { GeminiAdapterChoice, ResolveAdapterOptions };
export { gatewayConfig, gatewayProblem, gatewayUsable, planTransport, GATEWAYS } from './gateway.ts';
export type { GatewayId, GatewayInfo, TransportPlan } from './gateway.ts';
export { describeCapabilities, capabilitySummary } from './capabilities.ts';
export type { CapabilityReport } from './capabilities.ts';
export { GatewayLlm, TracedGemini };

// ── Availability + registration ──────────────────────────────────────────────

export interface ProviderStatus {
  provider: ProviderId;
  label: string;
  available: boolean;
  /**
   * How this provider's ids will be served: its own endpoint, or the
   * configured gateway standing in because the direct key is absent
   * (lib/models/gateway.ts). Absent when unavailable.
   */
  transport?: 'direct' | 'gateway';
  /** Gateway id when transport is 'gateway'. */
  gateway?: string;
  /** Why the provider is unavailable (e.g. which env var is missing). */
  reason?: string;
}

/** Availability report without side effects (used by demos and key gates). */
export function providerStatuses(): ProviderStatus[] {
  const gw = gatewayUsable() ? gatewayConfig() : null;
  return (Object.keys(PROVIDERS) as ProviderId[]).map((provider) => {
    const label = PROVIDERS[provider].label;
    if (providerReady(provider)) {
      return { provider, label, available: true, transport: 'direct' as const };
    }
    // A cloud platform that is not fully configured is not covered by the
    // gateway: the deployment chose that platform on purpose.
    let cloudProblem: string | undefined;
    try {
      const e = endpointFromEnv(provider);
      if (e.platform !== 'direct') cloudProblem = endpointProblems(provider, e).join('; ');
    } catch (err) {
      cloudProblem = err instanceof Error ? err.message : String(err);
    }
    if (cloudProblem) return { provider, label, available: false, reason: cloudProblem };
    if (gw && provider !== 'ollama') {
      return {
        provider,
        label,
        available: true,
        transport: 'gateway' as const,
        gateway: gw.gateway.id,
      };
    }
    return {
      provider,
      label,
      available: false,
      reason: `${PROVIDERS[provider].keyEnv} not set`,
    };
  });
}

const REGISTRARS: Record<ProviderId, () => void> = {
  gemini: () => requireAdk("Registering a model class with ADK's LLMRegistry").LLMRegistry.register(TracedGemini),
  anthropic: registerClaudeLlm,
  openai: registerGptLlm,
  xai: registerGrokLlm,
  moonshot: registerKimiLlm,
  ollama: registerOllamaLlm,
};

/**
 * The direct adapter's OWN supportedModels per provider. A gateway stand-in
 * must register under these exact regex instances so it REPLACES the
 * direct entry (the LLMRegistry dict is keyed by regex object) instead of
 * sitting behind it unmatched. Gemini's are ADK's built-in patterns, which
 * are registered at import time — replacing them is how TracedGemini works
 * too.
 */
const PATTERNS = (): Record<Exclude<ProviderId, 'ollama'>, Array<string | RegExp>> => ({
  gemini: Gemini.supportedModels,
  anthropic: ClaudeLlm.supportedModels,
  openai: GptLlm.supportedModels,
  xai: GrokLlm.supportedModels,
  moonshot: KimiLlm.supportedModels,
});

let providersRegistered = false;

/**
 * Registers every adapter whose credentials exist into the ADK LLMRegistry
 * (Ollama unconditionally — local needs no key; Gemini always, since the
 * registry needs a fallback class, and a missing Gemini key surfaces as a
 * clear API error at call time). When MODEL_GATEWAY is configured, a
 * provider whose direct key is ABSENT is served by the gateway stand-in
 * instead (lib/models/gateway.ts — the fallback rule). Returns the
 * per-provider statuses so entrypoints can log which models are routable.
 *
 * Without @google/adk installed there is no LLMRegistry to register into:
 * the native runtime resolves every id through resolveAdapter, so nothing is
 * registered and the statuses are returned as they are (ADR 0102).
 */
export function registerAvailableProviders(
  log?: (msg: string) => void,
): ProviderStatus[] {
  const statuses = providerStatuses();
  if (!providersRegistered && adkInstalled()) {
    providersRegistered = true;
    for (const status of statuses) {
      if (status.transport === 'gateway' && status.provider !== 'ollama') {
        registerGatewayLlm(PATTERNS()[status.provider]);
      } else if (status.available || status.provider === 'gemini') {
        REGISTRARS[status.provider]();
      }
    }
  }
  if (log) {
    const problem = gatewayProblem();
    if (problem) log(`⚠ ${problem} — gateway ignored`);
    for (const s of statuses) {
      if (!s.available) {
        log(`⚠ ${s.label} disabled (${s.reason}) — ${modelHint(s.provider)} models unavailable`);
      } else if (s.transport === 'gateway') {
        log(`◇ ${s.label} — via gateway:${s.gateway} (${modelHint(s.provider)} served without native search)`);
      } else {
        log(`✓ ${s.label} — active`);
      }
    }
  }
  return statuses;
}

function modelHint(provider: ProviderId): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-*';
    case 'openai':
      return 'gpt-*/o*';
    case 'xai':
      return 'grok-*';
    case 'moonshot':
      return 'kimi-*';
    case 'ollama':
      return 'ollama/*';
    case 'gemini':
      return 'gemini-*';
  }
}

// ── One model id → one route ─────────────────────────────────────────────────
//
// routeFor and scopedKey (lib/models/adapterResolver.ts) are the one routing
// step resolveModel and resolveAdapter share, so a key or endpoint reaches
// the same place on both paths.

// ── ADK instances (BYOK paths on the ADK runtime) ────────────────────────────

export interface ResolveModelOptions {
  /** Per-request API key (e.g. the A2A X-Api-Key header). */
  apiKey?: string;
  /**
   * DEPRECATED — the A2A X-Provider header. Only consulted when `model` is
   * undefined, to pick that provider's default model. A model id in the
   * YAML always wins. It also names the provider `apiKey` belongs to.
   */
  defaultProvider?: string;
  /**
   * Where this request goes and how it authenticates (ADR 0023), merged over
   * the environment's endpoint for the model's provider: the credentials plug
   * point's per-request answer.
   */
  endpoint?: Partial<ProviderEndpoint>;
}

const DEFAULT_MODEL_FOR: Record<ProviderId, string> = {
  gemini: DEFAULT_GEMINI_MODEL,
  anthropic: DEFAULT_CLAUDE_MODEL,
  openai: DEFAULT_GPT_MODEL,
  xai: DEFAULT_GROK_MODEL,
  moonshot: DEFAULT_KIMI_MODEL,
  ollama: DEFAULT_OLLAMA_MODEL,
};

/**
 * Each provider's ADK class for a direct route: the provider's own exported
 * class, so GptLlm's and the chat-completions shims' toLlmResponse keep the
 * ledger's usage meaning (ADR 0056, ADR 0057). Grok has no platforms, so it
 * takes no endpoint; Kimi takes its base URL; Ollama is local and takes
 * neither.
 */
const ADK_LLM: Record<ProviderId, (r: Route) => BaseLlm> = {
  ollama: (r) => new OllamaLlm({ model: r.model }),
  anthropic: (r) => new ClaudeLlm({ model: r.model, apiKey: r.apiKey, endpoint: r.endpoint }),
  openai: (r) => new GptLlm({ model: r.model, apiKey: r.apiKey, endpoint: r.endpoint }),
  xai: (r) => new GrokLlm({ model: r.model, apiKey: r.apiKey }),
  moonshot: (r) => new KimiLlm({ model: r.model, apiKey: r.apiKey, baseUrl: r.endpoint?.baseURL }),
  gemini: (r) => new TracedGemini({ model: r.model, apiKey: r.apiKey, endpoint: r.endpoint }),
};

/**
 * Resolves a model id (from YAML) to a provider adapter INSTANCE for the ADK
 * runtime, injecting a per-request apiKey where the provider accepts one.
 * When `model` is undefined, falls back to the default model of
 * `defaultProvider` (or Gemini).
 */
export function resolveModel(
  model: string | undefined,
  options: ResolveModelOptions = {},
): BaseLlm {
  const keyProvider = normalizeProvider(options.defaultProvider);
  const resolved = model ?? DEFAULT_MODEL_FOR[keyProvider];
  const route = routeFor(resolved, scopedKey(resolved, options.apiKey, keyProvider), options.endpoint);
  return route.transport === 'gateway' ? new GatewayLlm({ model: resolved }) : ADK_LLM[route.provider](route);
}

// ── Contract adapters (the native runtime) ───────────────────────────────────

/** GEMINI_ADAPTER (`engine`, the default, or `adk`). Any other value is a configuration error. */
export function geminiAdapterChoice(env: NodeJS.ProcessEnv = process.env): GeminiAdapterChoice {
  return geminiAdapterSetting(env) ?? 'engine';
}

/**
 * The contract resolver with the temporary AdkGeminiAdapter (ADR 0060): a
 * Gemini id gets the engine's GeminiAdapter (the default since 0.20.0, ADR
 * 0100), or AdkGeminiAdapter when GEMINI_ADAPTER=adk or `{ gemini: 'adk' }`
 * asks for it, for one release, which needs @google/adk. The ADK-free
 * resolver in lib/models/adapterResolver.ts, which `melchizedek-agents/model`
 * exports, refuses `adk` (ADR 0068).
 */
const WITH_ADK_GEMINI = adapterResolver((r) => new AdkGeminiAdapter(r));

/**
 * Resolves a model id to the engine's own ModelAdapter (ADR 0048), from the
 * same prefix table and transport rule as resolveModel, with no ADK
 * LLMRegistry: the provider's adapter when its key (env, BYOK or endpoint)
 * is present, the gateway's when it is absent and MODEL_GATEWAY is set.
 * The adapter opens no span and charges nothing: its caller does (ADR 0053).
 */
export function resolveAdapter(modelId: string, options: ResolveAdapterOptions = {}): ModelAdapter {
  return WITH_ADK_GEMINI.resolveAdapter(modelId, options);
}

/**
 * An agent's model and its `fallback_model:` on the contract path: a
 * FallbackAdapter (ADR 0044) around resolveAdapter's two adapters, or the
 * primary alone when there is no fallback. The caller's key stays with its
 * own provider: unless `keyProvider` says otherwise it belongs to the
 * primary's, so a fallback on another provider resolves from server env.
 * Nothing calls this yet; the ADK path's pair stays
 * FallbackLlm(shim(primary), shim(fallback)) (ADR 0053).
 */
export function resolveAdapterWithFallback(
  modelId: string,
  fallbackId: string | undefined,
  options: ResolveAdapterOptions = {},
  fallbackOptions: FallbackAdapterOptions = {},
): ModelAdapter {
  return WITH_ADK_GEMINI.resolveAdapterWithFallback(modelId, fallbackId, options, fallbackOptions);
}
