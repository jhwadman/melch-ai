/**
 * lib/models/registry.ts — unified model routing. THE seam for model
 * optionality: an agent's YAML declares `model`, and this module makes sure
 * that string reaches the right provider adapter.
 *
 * ONE PREFIX TABLE (lib/models/providerMap.ts), ONE RESOLUTION (ADR 0107):
 *
 *   resolveAdapter() — the engine's own ModelAdapter (lib/models/
 *     contract.ts, ADR 0048) for one id: the provider's adapter when its key
 *     (env, BYOK or endpoint) is present, the gateway's when it is absent
 *     and MODEL_GATEWAY is set. A Gemini id gets the engine's GeminiAdapter.
 *     resolveAdapterWithFallback() wraps a pair in a FallbackAdapter.
 *
 *   resolveModel() — the same adapter for a BYOK path (lib/a2a/app.ts), in
 *     the shape the A2A server's resolver takes: a per-request key scoped to
 *     the caller's provider, an endpoint, and the X-Provider header's
 *     default model when the YAML names none (a deprecated affordance).
 *
 * The routing step (routeFor) and the contract table live in
 * lib/models/adapterResolver.ts, which `melchizedek-agents/model` exports
 * (ADR 0068). providerStatuses() and logProviderStatuses() report which
 * providers are routable; nothing is registered anywhere: a model id
 * resolves when an agent first calls it.
 */

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
import { geminiAdapterSetting, normalizeProvider, resolveAdapter } from './adapterResolver.ts';
import type { GeminiAdapterChoice, ResolveAdapterOptions } from './adapterResolver.ts';
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
export { resolveAdapter, resolveAdapterWithFallback } from './adapterResolver.ts';
export { gatewayConfig, gatewayProblem, gatewayUsable, planTransport, GATEWAYS } from './gateway.ts';
export type { GatewayId, GatewayInfo, TransportPlan } from './gateway.ts';
export { describeCapabilities, capabilitySummary } from './capabilities.ts';
export type { CapabilityReport } from './capabilities.ts';

// ── Availability ─────────────────────────────────────────────────────────────

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

/**
 * The per-provider statuses, each said once on `log`: active, served by the
 * gateway, or disabled and why. Entrypoints call it at boot so an operator
 * sees which models are routable; it registers nothing.
 */
export function logProviderStatuses(log?: (msg: string) => void): ProviderStatus[] {
  const statuses = providerStatuses();
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

// ── BYOK paths ───────────────────────────────────────────────────────────────

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
 * Resolves a model id (from YAML) to the engine's ModelAdapter for a BYOK
 * path, injecting a per-request apiKey where it belongs: the key reaches
 * only a model of `defaultProvider`'s provider (gemini when unset). When
 * `model` is undefined, falls back to the default model of
 * `defaultProvider` (or Gemini).
 */
export function resolveModel(
  model: string | undefined,
  options: ResolveModelOptions = {},
): ModelAdapter {
  const keyProvider = normalizeProvider(options.defaultProvider);
  const resolved = model ?? DEFAULT_MODEL_FOR[keyProvider];
  return resolveAdapter(resolved, {
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    keyProvider,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });
}

/** GEMINI_ADAPTER: `engine`, the only Gemini adapter since 1.0.0; `adk` throws, naming the release (ADR 0107). */
export function geminiAdapterChoice(env: NodeJS.ProcessEnv = process.env): GeminiAdapterChoice {
  return geminiAdapterSetting(env) ?? 'engine';
}
