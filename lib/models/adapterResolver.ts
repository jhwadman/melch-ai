/**
 * lib/models/adapterResolver.ts — one model id to one ModelAdapter on the
 * engine's own contract (ADR 0048, ADR 0060), with no @google/adk in its
 * import graph.
 *
 * WHY its own module: lib/models/registry.ts imports ADK (it registers the
 * ADK classes and builds TracedGemini), so the `melchizedek-agents/model`
 * entry (lib/model.ts) cannot load it. The routing step both paths share
 * (routeFor: the provider from the prefix table, the caller's endpoint merged
 * over the environment's, the transport from planTransport), the BYOK scoping
 * and the contract adapter table live here; registry.ts imports them for
 * resolveModel and for its own resolveAdapter.
 *
 * GEMINI (ADR 0068, ADR 0100): a Gemini id gets the engine's GeminiAdapter
 * unless `adk` is asked for, by the option or by GEMINI_ADAPTER=adk.
 * `adapterResolver(adkGemini)` takes the factory for the temporary
 * AdkGeminiAdapter from its caller: registry.ts passes one, so `adk` works
 * there for one release (with @google/adk installed). The resolver exported
 * here has none, so asking it for `adk` throws and names the entry that has
 * it.
 */

import type { ModelAdapter } from './contract.ts';
import { ClaudeAdapter } from './claudeAdapter.ts';
import { mergeEndpoint } from './endpoints.ts';
import type { ProviderEndpoint } from './endpoints.ts';
import { FallbackAdapter } from './fallbackAdapter.ts';
import type { FallbackAdapterOptions } from './fallbackAdapter.ts';
import { planTransport } from './gateway.ts';
import { GatewayAdapter } from './gatewayAdapter.ts';
import { GeminiAdapter } from './geminiAdapter.ts';
import { GptAdapter } from './gptAdapter.ts';
import { GrokAdapter } from './grokAdapter.ts';
import { KimiAdapter } from './kimiAdapter.ts';
import { OllamaAdapter } from './ollamaAdapter.ts';
import { providerForModel } from './providerMap.ts';
import type { ProviderId } from './providerMap.ts';

/** Where one model id goes: its provider, its transport, and what the caller injects. */
export interface Route {
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
export function routeFor(model: string, apiKey: string | undefined, endpoint: Partial<ProviderEndpoint> | undefined): Route {
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
export function scopedKey(model: string, apiKey: string | undefined, keyProvider: ProviderId): string | undefined {
  return providerForModel(model) === keyProvider ? apiKey : undefined;
}

/** A provider name as the A2A X-Provider header gives it; anything unknown reads as gemini. */
export function normalizeProvider(provider?: string): ProviderId {
  const p = provider?.toLowerCase();
  if (p === 'ollama' || p === 'anthropic' || p === 'openai' || p === 'xai' || p === 'moonshot') {
    return p;
  }
  return 'gemini';
}

/**
 * Which adapter serves a Gemini id on the contract path: `adk`, the temporary
 * AdkGeminiAdapter over ADK's Gemini (lib/models/adkGeminiAdapter.ts), or
 * `engine`, the engine's own GeminiAdapter on @google/genai
 * (lib/models/geminiAdapter.ts).
 */
export type GeminiAdapterChoice = 'adk' | 'engine';

/** GEMINI_ADAPTER as set (`adk` or `engine`), or undefined when unset. Any other value is a configuration error. */
export function geminiAdapterSetting(env: NodeJS.ProcessEnv = process.env): GeminiAdapterChoice | undefined {
  const raw = env.GEMINI_ADAPTER?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'adk' || raw === 'engine') return raw;
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
  /**
   * Which Gemini adapter a Gemini id gets. Default: GEMINI_ADAPTER, else
   * `engine` (since 0.20.0, ADR 0100). `adk` is available for one release
   * through `melchizedek-agents/models/registry` with @google/adk installed;
   * `melchizedek-agents/model` has no `adk`.
   */
  gemini?: GeminiAdapterChoice;
}

/** What a direct route's adapter is built from. */
export type AdapterRoute = Pick<Route, 'model' | 'apiKey' | 'endpoint'>;

/** Builds the temporary AdkGeminiAdapter; only lib/models/registry.ts supplies one. */
export type AdkGeminiFactory = (route: AdapterRoute) => ModelAdapter;

export interface AdapterResolver {
  resolveAdapter(modelId: string, options?: ResolveAdapterOptions): ModelAdapter;
  resolveAdapterWithFallback(
    modelId: string,
    fallbackId: string | undefined,
    options?: ResolveAdapterOptions,
    fallbackOptions?: FallbackAdapterOptions,
  ): ModelAdapter;
}

/** Each non-Gemini provider's contract adapter for a direct route. */
const CONTRACT_ADAPTER: Record<Exclude<ProviderId, 'gemini'>, (r: Route) => ModelAdapter> = {
  ollama: (r) => new OllamaAdapter({ model: r.model }),
  anthropic: (r) => new ClaudeAdapter({ model: r.model, apiKey: r.apiKey, endpoint: r.endpoint }),
  openai: (r) => new GptAdapter({ model: r.model, apiKey: r.apiKey, endpoint: r.endpoint }),
  xai: (r) => new GrokAdapter({ model: r.model, apiKey: r.apiKey }),
  moonshot: (r) => new KimiAdapter({ model: r.model, apiKey: r.apiKey, baseUrl: r.endpoint?.baseURL }),
};

/**
 * A resolver over the one prefix table. A Gemini id gets GeminiAdapter
 * unless `adk` is asked for (ADR 0100). With `adkGemini`, `adk` gets
 * AdkGeminiAdapter (ADR 0060); without it, asking for `adk` throws (ADR 0068).
 */
export function adapterResolver(adkGemini?: AdkGeminiFactory): AdapterResolver {
  const geminiFor = (r: Route, choice: GeminiAdapterChoice): ModelAdapter => {
    const route: AdapterRoute = { model: r.model, apiKey: r.apiKey, endpoint: r.endpoint };
    if (choice === 'engine') return new GeminiAdapter(route);
    if (!adkGemini) {
      throw new Error(
        'The ADK Gemini adapter is not available from melchizedek-agents/model, which loads no @google/adk. ' +
          'Use gemini: "engine" (or unset GEMINI_ADAPTER), or resolve through melchizedek-agents/models/registry.',
      );
    }
    return adkGemini(route);
  };

  function resolveAdapter(modelId: string, options: ResolveAdapterOptions = {}): ModelAdapter {
    const keyProvider = options.keyProvider === undefined ? providerForModel(modelId) : normalizeProvider(options.keyProvider);
    const route = routeFor(modelId, scopedKey(modelId, options.apiKey, keyProvider), options.endpoint);
    if (route.transport === 'gateway') return new GatewayAdapter({ model: modelId });
    if (route.provider === 'gemini') {
      return geminiFor(route, options.gemini ?? geminiAdapterSetting() ?? 'engine');
    }
    return CONTRACT_ADAPTER[route.provider](route);
  }

  function resolveAdapterWithFallback(
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

  return { resolveAdapter, resolveAdapterWithFallback };
}

const ADK_FREE = adapterResolver();

/**
 * Resolves a model id to the engine's own ModelAdapter (ADR 0048), from the
 * prefix table and the transport rule resolveModel uses, with no ADK: the
 * provider's adapter when its key (env, BYOK or endpoint) is present, the
 * gateway's when it is absent and MODEL_GATEWAY is set. A Gemini id gets
 * GeminiAdapter (ADR 0068). The adapter opens no span and charges nothing:
 * its caller does (ADR 0053).
 */
export function resolveAdapter(modelId: string, options: ResolveAdapterOptions = {}): ModelAdapter {
  return ADK_FREE.resolveAdapter(modelId, options);
}

/**
 * An agent's model and its `fallback_model:`: a FallbackAdapter (ADR 0044)
 * around resolveAdapter's two adapters, or the primary alone. The caller's
 * key stays with its own provider: unless `keyProvider` says otherwise it
 * belongs to the primary's, so a fallback on another provider resolves from
 * server env.
 */
export function resolveAdapterWithFallback(
  modelId: string,
  fallbackId: string | undefined,
  options: ResolveAdapterOptions = {},
  fallbackOptions: FallbackAdapterOptions = {},
): ModelAdapter {
  return ADK_FREE.resolveAdapterWithFallback(modelId, fallbackId, options, fallbackOptions);
}
