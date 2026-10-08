/**
 * lib/models/adapterResolver.ts — one model id to one ModelAdapter on the
 * engine's own contract (ADR 0048, ADR 0060, ADR 0107).
 *
 * The routing step (routeFor: the provider from the prefix table, the
 * caller's endpoint merged over the environment's, the transport from
 * planTransport), the BYOK scoping and the contract adapter table live
 * here. lib/models/registry.ts re-exports the resolver and builds
 * resolveModel on it; `melchizedek-agents/model` (lib/model.ts) exports it
 * with no compiler or runtime in its import graph (ADR 0068).
 *
 * GEMINI (ADR 0100, ADR 0107): a Gemini id gets the engine's GeminiAdapter.
 * GEMINI_ADAPTER=engine, or the `gemini: 'engine'` option, is accepted and
 * changes nothing; `adk`, the ADK Gemini adapter that 1.0.0 removed, throws
 * an error naming the release.
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

/** Which adapter serves a Gemini id: the engine's GeminiAdapter (lib/models/geminiAdapter.ts), the only one since 1.0.0. */
export type GeminiAdapterChoice = 'engine';

/** The error for GEMINI_ADAPTER=adk, or the `gemini: 'adk'` option: the ADK Gemini adapter left in 1.0.0. */
function adkGeminiRemoved(source: string): Error {
  return new Error(
    `${source} asks for the ADK Gemini adapter, which was removed in melchizedek-agents 1.0.0 (ADR 0107): ` +
      `every Gemini id runs on the engine's GeminiAdapter. Unset ${source} (or set it to "engine").`,
  );
}

/** GEMINI_ADAPTER as set (`engine`), or undefined when unset. `adk` throws, naming 1.0.0; any other value is a configuration error. */
export function geminiAdapterSetting(env: NodeJS.ProcessEnv = process.env): GeminiAdapterChoice | undefined {
  const raw = env.GEMINI_ADAPTER?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'engine') return raw;
  if (raw === 'adk') throw adkGeminiRemoved('GEMINI_ADAPTER');
  throw new Error('GEMINI_ADAPTER must be "engine" (the only Gemini adapter since 1.0.0).');
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
   * Which Gemini adapter a Gemini id gets: `engine`, the only one (ADR 0107).
   * GEMINI_ADAPTER is still read, so `adk` there throws.
   */
  gemini?: GeminiAdapterChoice;
}

/** What a direct route's adapter is built from. */
export type AdapterRoute = Pick<Route, 'model' | 'apiKey' | 'endpoint'>;

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

/** A resolver over the one prefix table. A Gemini id gets GeminiAdapter (ADR 0100, ADR 0107). */
export function adapterResolver(): AdapterResolver {
  const geminiFor = (r: Route, choice: string): ModelAdapter => {
    if (choice !== 'engine') throw adkGeminiRemoved(`The gemini option ("${choice}")`);
    return new GeminiAdapter({ model: r.model, apiKey: r.apiKey, endpoint: r.endpoint });
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

const RESOLVER = adapterResolver();

/**
 * Resolves a model id to the engine's own ModelAdapter (ADR 0048), from the
 * prefix table and the transport rule: the provider's adapter when its key
 * (env, BYOK or endpoint) is present, the gateway's when it is absent and
 * MODEL_GATEWAY is set. A Gemini id gets GeminiAdapter. The adapter opens no span and charges nothing:
 * its caller does (ADR 0053).
 */
export function resolveAdapter(modelId: string, options: ResolveAdapterOptions = {}): ModelAdapter {
  return RESOLVER.resolveAdapter(modelId, options);
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
  return RESOLVER.resolveAdapterWithFallback(modelId, fallbackId, options, fallbackOptions);
}
