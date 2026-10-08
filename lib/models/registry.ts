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
 *
 * Register BEFORE constructing any agent: the LLMRegistry caches model→class
 * resolution (LRU), so late registration can be masked by stale cache hits.
 */

import { Gemini, LLMRegistry } from '@google/adk';
import type { BaseLlm } from '@google/adk';
import { endpointFromEnv, endpointProblems, mergeEndpoint, providerReady } from './endpoints.ts';
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
import { ClaudeAdapter } from './claudeAdapter.ts';
import { FallbackAdapter } from './fallbackAdapter.ts';
import type { FallbackAdapterOptions } from './fallbackAdapter.ts';
import { GatewayAdapter } from './gatewayAdapter.ts';
import { GeminiAdapter } from './geminiAdapter.ts';
import { GptAdapter } from './gptAdapter.ts';
import { GrokAdapter } from './grokAdapter.ts';
import { KimiAdapter } from './kimiAdapter.ts';
import { OllamaAdapter } from './ollamaAdapter.ts';
import { TracedGemini } from './tracedGemini.ts';
import { ClaudeLlm, registerClaudeLlm } from './claudeLlm.ts';
import { GptLlm, registerGptLlm } from './gptLlm.ts';
import { GrokLlm, registerGrokLlm } from './grokLlm.ts';
import { KimiLlm, registerKimiLlm } from './kimiLlm.ts';
import { OllamaLlm, registerOllamaLlm } from './ollamaLlm.ts';
import { GatewayLlm, registerGatewayLlm } from './gatewayLlm.ts';
import {
  gatewayConfig,
  gatewayProblem,
  gatewayUsable,
  planTransport,
} from './gateway.ts';
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
  gemini: () => LLMRegistry.register(TracedGemini),
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
const PATTERNS: Record<Exclude<ProviderId, 'ollama'>, Array<string | RegExp>> = {
  gemini: Gemini.supportedModels,
  anthropic: ClaudeLlm.supportedModels,
  openai: GptLlm.supportedModels,
  xai: GrokLlm.supportedModels,
  moonshot: KimiLlm.supportedModels,
};

let providersRegistered = false;

/**
 * Registers every adapter whose credentials exist into the ADK LLMRegistry
 * (Ollama unconditionally — local needs no key; Gemini always, since the
 * registry needs a fallback class, and a missing Gemini key surfaces as a
 * clear API error at call time). When MODEL_GATEWAY is configured, a
 * provider whose direct key is ABSENT is served by the gateway stand-in
 * instead (lib/models/gateway.ts — the fallback rule). Returns the
 * per-provider statuses so entrypoints can log which models are routable.
 */
export function registerAvailableProviders(
  log?: (msg: string) => void,
): ProviderStatus[] {
  const statuses = providerStatuses();
  if (!providersRegistered) {
    providersRegistered = true;
    for (const status of statuses) {
      if (status.transport === 'gateway' && status.provider !== 'ollama') {
        registerGatewayLlm(PATTERNS[status.provider]);
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

// ── One model id → one route (resolveModel and resolveAdapter) ───────────────

/** Where one model id goes: its provider, its transport, and what the caller injects. */
interface Route {
  provider: ProviderId;
  model: string;
  transport: 'direct' | 'gateway';
  /** A caller's own key for this provider, already scoped to it. */
  apiKey?: string;
  /** The caller's endpoint merged over the environment's (ADR 0023). */
  endpoint?: ProviderEndpoint;
}

/**
 * The fallback rule (lib/models/gateway.ts): the direct adapter whenever the
 * provider's key — from env, or the caller's own BYOK key or endpoint — is
 * present; the gateway stand-in only when it is absent and a gateway is
 * configured. The gateway key is server env only, never a request header.
 */
function routeFor(model: string, apiKey: string | undefined, endpoint: Partial<ProviderEndpoint> | undefined): Route {
  const provider = providerForModel(model);
  const merged = endpoint ? mergeEndpoint(provider, endpoint) : undefined;
  const { transport } = planTransport(model, { callerKey: !!apiKey || !!merged });
  return { provider, model, transport, ...(apiKey ? { apiKey } : {}), ...(merged ? { endpoint: merged } : {}) };
}

/**
 * BYOK is scoped to the CALLER'S provider: the key a client sends
 * authenticates that client's own provider (typically Gemini). Passing it to
 * a different provider's adapter would override the server's env key
 * (adapters prefer a passed key), fail auth, and hand the key to another
 * vendor — e.g. a Gemini key sent to xAI. Cross-provider models therefore
 * resolve keys from server env.
 */
function scopedKey(model: string, apiKey: string | undefined, keyProvider: ProviderId): string | undefined {
  return providerForModel(model) === keyProvider ? apiKey : undefined;
}

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

function normalizeProvider(provider?: string): ProviderId {
  const p = provider?.toLowerCase();
  if (p === 'ollama' || p === 'anthropic' || p === 'openai' || p === 'xai' || p === 'moonshot') {
    return p;
  }
  return 'gemini';
}

// ── Contract adapters (the native runtime) ───────────────────────────────────

/**
 * Which adapter serves a Gemini id on the contract path: `adk`, the temporary
 * AdkGeminiAdapter over ADK's Gemini (lib/models/adkGeminiAdapter.ts), or
 * `engine`, the engine's own GeminiAdapter on @google/genai
 * (lib/models/geminiAdapter.ts). `adk` until gate G3 (ADR 0060).
 */
export type GeminiAdapterChoice = 'adk' | 'engine';

/** GEMINI_ADAPTER (`adk`, the default, or `engine`). Any other value is a configuration error. */
export function geminiAdapterChoice(env: NodeJS.ProcessEnv = process.env): GeminiAdapterChoice {
  const raw = env.GEMINI_ADAPTER?.trim().toLowerCase();
  if (!raw || raw === 'adk') return 'adk';
  if (raw === 'engine') return 'engine';
  throw new Error('GEMINI_ADAPTER must be "adk" or "engine".');
}

export interface ResolveAdapterOptions {
  /**
   * A caller's own API key (BYOK). It authenticates `keyProvider`'s models
   * only, and wins over the endpoint's and the environment's key there.
   */
  apiKey?: string;
  /**
   * The provider `apiKey` belongs to (a provider id; anything else reads as
   * gemini, as the A2A X-Provider header does). Default: the model's own.
   * A model of another provider resolves its key from server env.
   */
  keyProvider?: string;
  /** Where requests go (ADR 0023), merged over the environment's endpoint for the model's provider. */
  endpoint?: Partial<ProviderEndpoint>;
  /** Which Gemini adapter a Gemini id gets. Default: GEMINI_ADAPTER, else `adk`. */
  gemini?: GeminiAdapterChoice;
}

/** Each provider's contract adapter for a direct route: what its ADK class (ADK_LLM) wraps. */
const CONTRACT_ADAPTER: Record<ProviderId, (r: Route, gemini: () => GeminiAdapterChoice) => ModelAdapter> = {
  ollama: (r) => new OllamaAdapter({ model: r.model }),
  anthropic: (r) => new ClaudeAdapter({ model: r.model, apiKey: r.apiKey, endpoint: r.endpoint }),
  openai: (r) => new GptAdapter({ model: r.model, apiKey: r.apiKey, endpoint: r.endpoint }),
  xai: (r) => new GrokAdapter({ model: r.model, apiKey: r.apiKey }),
  moonshot: (r) => new KimiAdapter({ model: r.model, apiKey: r.apiKey, baseUrl: r.endpoint?.baseURL }),
  gemini: (r, gemini) =>
    gemini() === 'engine'
      ? new GeminiAdapter({ model: r.model, apiKey: r.apiKey, endpoint: r.endpoint })
      : new AdkGeminiAdapter({ model: r.model, apiKey: r.apiKey, endpoint: r.endpoint }),
};

/**
 * Resolves a model id to the engine's own ModelAdapter (ADR 0048), from the
 * same prefix table and transport rule as resolveModel, with no ADK
 * LLMRegistry: the provider's adapter when its key (env, BYOK or endpoint)
 * is present, the gateway's when it is absent and MODEL_GATEWAY is set.
 * The adapter opens no span and charges nothing: its caller does (ADR 0053).
 */
export function resolveAdapter(modelId: string, options: ResolveAdapterOptions = {}): ModelAdapter {
  const keyProvider = options.keyProvider === undefined ? providerForModel(modelId) : normalizeProvider(options.keyProvider);
  const route = routeFor(modelId, scopedKey(modelId, options.apiKey, keyProvider), options.endpoint);
  if (route.transport === 'gateway') return new GatewayAdapter({ model: modelId });
  return CONTRACT_ADAPTER[route.provider](route, () => options.gemini ?? geminiAdapterChoice());
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
  const scoped: ResolveAdapterOptions = { ...options, keyProvider: options.keyProvider ?? providerForModel(modelId) };
  const primary = resolveAdapter(modelId, scoped);
  if (!fallbackId) return primary;
  return new FallbackAdapter(primary, resolveAdapter(fallbackId, scoped), fallbackOptions);
}

