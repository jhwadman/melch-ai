/**
 * lib/models/gateway.ts — the optional "one key" transport.
 *
 * WHY this file exists:
 *   A newcomer should be able to run every starter-pack syndicate with ONE
 *   credential when they choose to. A hosted gateway (Vercel AI Gateway,
 *   OpenRouter) fronts OpenAI, Anthropic, Google, xAI and Moonshot behind a single
 *   OpenAI-compatible endpoint, so a model id whose direct key is absent can
 *   still be served. This module owns that decision and nothing else.
 *
 * THE RULE (plans/model-access-tiers.md, ADR 0012):
 *   Direct adapters are canonical. A model id routes to its provider's own
 *   adapter whenever that provider's key is present. Only when the key is
 *   ABSENT and a gateway is configured does the id route through the
 *   gateway. Ollama never does. So the gateway is a fallback, never a
 *   preempt: adding a direct key beside the gateway key silently upgrades
 *   that provider's agents back to native fidelity (Gemini grounding, xAI
 *   search, Anthropic's server-side web_search) with no YAML change.
 *
 * WHAT A GATEWAY LOSES — reported, never silent:
 *   Every server-side tool sentinel (web_search, google_search, x_search,
 *   collections_search) is dropped on the gateway path, because a
 *   chat-completions endpoint has no uniform way to enable a provider's
 *   native search. lib/models/capabilities.ts turns that into a per-agent
 *   report the doctor, the A2A startup log and the ledger all read.
 *
 * WHY a leaf (imports providerMap, endpoints and lib/chatgpt/state.ts only):
 *   The registry, the gateway adapter, the capability report and the
 *   doctor all need this decision; keeping it free of adapter imports
 *   avoids the cycle model-routing warns about.
 *
 * Env (deployment config, never YAML):
 *   MODEL_GATEWAY          vercel | openrouter   (unset = off, the default)
 *   MODEL_GATEWAY_API_KEY  the gateway's key
 *   MODEL_GATEWAY_BASE_URL optional endpoint override (self-hosted proxies
 *                          that speak the same dialect, e.g. LiteLLM)
 *   MODEL_GATEWAY_MODEL_MAP optional "from=to,from=to" wire-name overrides
 *                          for ids the default mapper gets wrong
 */

import { chatGptSignInRoutesOpenAi } from '../chatgpt/state.ts';
import { providerReady } from './endpoints.ts';
import { PROVIDERS, providerForModel } from './providerMap.ts';
import type { ProviderId } from './providerMap.ts';
import { trimTrailingSlashes } from './urls.ts';

export type GatewayId = 'vercel' | 'openrouter';

/** Providers a gateway can front (everything cloud; never Ollama). */
export type CloudProviderId = Exclude<ProviderId, 'ollama'>;

export interface GatewayInfo {
  id: GatewayId;
  label: string;
  /** OpenAI-compatible base URL (chat/completions is appended). */
  baseUrl: string;
  /** Where the operator creates the key. */
  consoleUrl: string;
  /** The gateway's slug for each upstream provider, e.g. "x-ai" vs "xai". */
  slugs: Record<CloudProviderId, string>;
}

export const GATEWAY_ENV = 'MODEL_GATEWAY';
export const GATEWAY_KEY_ENV = 'MODEL_GATEWAY_API_KEY';
export const GATEWAY_BASE_URL_ENV = 'MODEL_GATEWAY_BASE_URL';
export const GATEWAY_MODEL_MAP_ENV = 'MODEL_GATEWAY_MODEL_MAP';

export const GATEWAYS: Record<GatewayId, GatewayInfo> = {
  vercel: {
    id: 'vercel',
    label: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    consoleUrl: 'https://vercel.com/ai-gateway',
    slugs: { gemini: 'google', anthropic: 'anthropic', openai: 'openai', xai: 'xai', moonshot: 'moonshotai' },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    consoleUrl: 'https://openrouter.ai/keys',
    slugs: { gemini: 'google', anthropic: 'anthropic', openai: 'openai', xai: 'x-ai', moonshot: 'moonshotai' },
  },
};

export interface GatewayConfig {
  gateway: GatewayInfo;
  /** Effective base URL (env override or the gateway's default). */
  baseUrl: string;
  keyPresent: boolean;
}

/**
 * The configured gateway, or null when MODEL_GATEWAY is unset. A set but
 * unknown value also yields null — `gatewayProblem()` says why, so the
 * doctor and the registry log can name the mistake instead of routing
 * silently to nothing.
 */
export function gatewayConfig(): GatewayConfig | null {
  const id = (process.env[GATEWAY_ENV] ?? '').trim().toLowerCase();
  if (!id) return null;
  const gateway = (GATEWAYS as Record<string, GatewayInfo>)[id];
  if (!gateway) return null;
  const override = (process.env[GATEWAY_BASE_URL_ENV] ?? '').trim();
  return {
    gateway,
    baseUrl: trimTrailingSlashes(override || gateway.baseUrl),
    keyPresent: !!process.env[GATEWAY_KEY_ENV],
  };
}

/** A human-readable misconfiguration, or undefined when the gateway is
 *  either off or usable. An unrecognised value is named as such and never
 *  repeated, since it may be a secret pasted into the wrong variable. */
export function gatewayProblem(): string | undefined {
  const id = (process.env[GATEWAY_ENV] ?? '').trim();
  if (!id) return undefined;
  const cfg = gatewayConfig();
  if (!cfg) {
    // The value is never echoed: a key pasted into the wrong variable is still a secret.
    return `${GATEWAY_ENV} is set to an unrecognised value (not shown); it must be one of: ${Object.keys(GATEWAYS).join(', ')}`;
  }
  if (!cfg.keyPresent) return `${GATEWAY_ENV}=${cfg.gateway.id} is set but ${GATEWAY_KEY_ENV} is not`;
  return undefined;
}

/** True when a gateway is configured well enough to serve requests. */
export function gatewayUsable(): boolean {
  const cfg = gatewayConfig();
  return !!cfg && cfg.keyPresent;
}

/** Parses "a=b,c=d" into a map; malformed pairs are skipped. */
function modelMapFromEnv(): Record<string, string> {
  const raw = process.env[GATEWAY_MODEL_MAP_ENV] ?? '';
  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const from = pair.slice(0, eq).trim();
    const to = pair.slice(eq + 1).trim();
    if (from && to) map[from] = to;
  }
  return map;
}

/**
 * The id a gateway expects for a YAML model id.
 *
 * Gateways prefix every id with the upstream provider's slug and spell
 * Anthropic's version segment with a dot ("claude-sonnet-4-6" is
 * "anthropic/claude-sonnet-4.6" on both Vercel and OpenRouter). Gemini,
 * GPT, Grok and Kimi ids already carry dots, so only the prefix is added. An id
 * the mapper gets wrong is fixed in MODEL_GATEWAY_MODEL_MAP, not in code.
 */
export function gatewayWireModel(model: string, gateway: GatewayInfo): string {
  const override = modelMapFromEnv()[model];
  if (override) return override;
  if (model.includes('/')) return model; // already provider-qualified
  const provider = providerForModel(model);
  if (provider === 'ollama') return model;
  const slug = gateway.slugs[provider];
  const wire =
    provider === 'anthropic' ? model.replace(/-(\d+)-(\d+)/, '-$1.$2') : model;
  return `${slug}/${wire}`;
}

export type Transport = 'direct' | 'gateway';

export interface TransportPlan {
  provider: ProviderId;
  transport: Transport;
  /** Set when transport is 'gateway'. */
  gateway?: GatewayInfo;
  /** True when this transport has a credential (or needs none). */
  funded: boolean;
  /** The direct key env, for the "set X to unlock" message. */
  keyEnv: string | null;
}

/**
 * Where a model id will be served from under the current environment.
 *
 * `callerKey` is the A2A BYOK case: a per-request key the caller sent for
 * its own provider counts as that provider's key being present, so a BYOK
 * request never falls through to the operator's gateway.
 */
export function planTransport(
  model: string,
  opts: { callerKey?: boolean } = {},
): TransportPlan {
  const provider = providerForModel(model);
  const keyEnv = PROVIDERS[provider].keyEnv;
  // A Sign in with ChatGPT credential funds OpenAI directly when no key does (ADR 0126).
  const direct = providerReady(provider) || !!opts.callerKey || (provider === 'openai' && chatGptSignInRoutesOpenAi());
  if (direct || provider === 'ollama') {
    return { provider, transport: 'direct', funded: true, keyEnv };
  }
  const cfg = gatewayConfig();
  if (cfg && cfg.keyPresent) {
    return { provider, transport: 'gateway', gateway: cfg.gateway, funded: true, keyEnv };
  }
  return { provider, transport: 'direct', funded: false, keyEnv };
}
