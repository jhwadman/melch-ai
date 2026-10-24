/**
 * lib/models/gateway.ts — the optional "one key" transport.
 *
 * WHY this file exists:
 *   A newcomer should be able to run every starter-pack syndicate with ONE
 *   credential when they choose to. A hosted gateway (Vercel AI Gateway,
 *   OpenRouter) fronts OpenAI, Anthropic, Google, xAI, Moonshot and DeepSeek behind a single
 *   OpenAI-compatible endpoint, so a model id whose direct key is absent can
 *   still be served. This module owns that decision and nothing else.
 *
 * THE RULE (plans/model-access-tiers.md, ADR 0012, ADR 0145):
 *   Direct adapters are canonical. By default a model id routes to its
 *   provider's own adapter whenever that provider's key is present, and
 *   only when the key is ABSENT and a gateway is configured does the id
 *   route through the gateway. So the gateway is a fallback, never a
 *   preempt: adding a direct key beside the gateway key silently upgrades
 *   that provider's agents back to native fidelity (Gemini grounding, xAI
 *   search, Anthropic's server-side web_search) with no YAML change.
 *   MODEL_GATEWAY_PREFER=gateway turns the preference round: every cloud
 *   id goes through the configured gateway, direct key or not (one bill,
 *   one dashboard), and MODEL_GATEWAY_EXCEPT names the providers that take
 *   the opposite of the preference either way (gemini kept on its own key
 *   for grounding under prefer=gateway; xai sent through the gateway under
 *   prefer=direct). Two things never move: Ollama is always direct, and an
 *   A2A caller's own key (BYOK) funds its provider directly, since that is
 *   what the caller asked for.
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
 * JEV (lib/models/jev.ts): TypeSafe's decision model is not a chat model,
 *   so a gateway serves it on its own System One route, named per gateway
 *   below (`systemOne`), with the gateway's own model ids. The same rule
 *   applies: TypeSafe's direct key wins; the gateway stands in when it is
 *   absent.
 *
 * Env (deployment config, never YAML; MODEL_GATEWAY and the key are read
 * through the credential source, so a host that holds them in a keychain
 * serves them too, ADR 0133):
 *   MODEL_GATEWAY          vercel | openrouter   (unset = off, the default)
 *   MODEL_GATEWAY_API_KEY  the gateway's key
 *   MODEL_GATEWAY_BASE_URL optional endpoint override (self-hosted proxies
 *                          that speak the same dialect, e.g. LiteLLM)
 *   MODEL_GATEWAY_MODEL_MAP optional "from=to,from=to" wire-name overrides
 *                          for ids the default mapper gets wrong
 *   MODEL_GATEWAY_PREFER   direct | gateway  (unset = direct: a provider's
 *                          own key wins; gateway: the gateway wins)
 *   MODEL_GATEWAY_EXCEPT   comma list of provider ids that take the opposite
 *                          of the preference (never ollama)
 */

import { chatGptSignInRoutesOpenAi } from '../chatgpt/state.ts';
import { providerReady } from './endpoints.ts';
import { PROVIDERS, providerForModel } from './providerMap.ts';
import type { ProviderId } from './providerMap.ts';
import { trimTrailingSlashes } from './urls.ts';
import { credentialValue } from './credentialSource.ts';

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
  /** The gateway's System One route for TypeSafe Jev (lib/models/jev.ts). */
  systemOne: {
    /** Where a Jev request posts. */
    url: string;
    /** The gateway's id for a `jev-*` YAML id. */
    wire: (model: string) => string;
  };
}

export const GATEWAY_ENV = 'MODEL_GATEWAY';
export const GATEWAY_KEY_ENV = 'MODEL_GATEWAY_API_KEY';
export const GATEWAY_BASE_URL_ENV = 'MODEL_GATEWAY_BASE_URL';
export const GATEWAY_MODEL_MAP_ENV = 'MODEL_GATEWAY_MODEL_MAP';
export const GATEWAY_PREFER_ENV = 'MODEL_GATEWAY_PREFER';
export const GATEWAY_EXCEPT_ENV = 'MODEL_GATEWAY_EXCEPT';

export type GatewayPreference = 'direct' | 'gateway';
export const GATEWAY_PREFERENCES: readonly GatewayPreference[] = ['direct', 'gateway'];

export const GATEWAYS: Record<GatewayId, GatewayInfo> = {
  vercel: {
    id: 'vercel',
    label: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    consoleUrl: 'https://vercel.com/ai-gateway',
    slugs: { gemini: 'google', anthropic: 'anthropic', openai: 'openai', xai: 'xai', moonshot: 'moonshotai', deepseek: 'deepseek', typesafe: 'typesafe-ai' },
    systemOne: {
      // The TypeSafe SDK's base URL on Vercel is /typesafe, where the documented id is typesafe-ai/jev
      // (vercel.com/ai-gateway/models/jev); GET /typesafe/v1/models also lists jev-1.13.0 and jev-1.14.0 as written.
      url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
      wire: (model) => (/^jev-(latest|preview)$/.test(model) ? 'typesafe-ai/jev' : model),
    },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    consoleUrl: 'https://openrouter.ai/keys',
    slugs: { gemini: 'google', anthropic: 'anthropic', openai: 'openai', xai: 'x-ai', moonshot: 'moonshotai', deepseek: 'deepseek', typesafe: 'typesafe' },
    systemOne: {
      // OpenRouter serves the TypeSafe SDK's wire at /api/v1/systemone; ids drop the patch (typesafe/jev-1.14), aliases track ~typesafe/jev-latest.
      url: 'https://openrouter.ai/api/v1/systemone',
      wire: (model) => (/^jev-(latest|preview)$/.test(model) ? '~typesafe/jev-latest' : `typesafe/${model.replace(/^(jev-\d+\.\d+)\.\d+$/, '$1')}`),
    },
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
  const id = (credentialValue(GATEWAY_ENV) ?? '').trim().toLowerCase();
  if (!id) return null;
  const gateway = (GATEWAYS as Record<string, GatewayInfo>)[id];
  if (!gateway) return null;
  const override = (credentialValue(GATEWAY_BASE_URL_ENV) ?? '').trim();
  return {
    gateway,
    baseUrl: trimTrailingSlashes(override || gateway.baseUrl),
    keyPresent: !!credentialValue(GATEWAY_KEY_ENV),
  };
}

/** A human-readable misconfiguration, or undefined when the gateway is
 *  either off or usable. An unrecognised value is named as such and never
 *  repeated, since it may be a secret pasted into the wrong variable. */
export function gatewayProblem(): string | undefined {
  const id = (credentialValue(GATEWAY_ENV) ?? '').trim();
  if (!id) return undefined;
  const cfg = gatewayConfig();
  if (!cfg) {
    // The value is never echoed: a key pasted into the wrong variable is still a secret.
    return `${GATEWAY_ENV} is set to an unrecognised value (not shown); it must be one of: ${Object.keys(GATEWAYS).join(', ')}`;
  }
  if (!cfg.keyPresent) return `${GATEWAY_ENV}=${cfg.gateway.id} is set but ${GATEWAY_KEY_ENV} is not`;
  return gatewayPreferenceProblem();
}

/** A misconfigured preference or exception list, or undefined; the values are plain words, so they are named. */
export function gatewayPreferenceProblem(): string | undefined {
  const raw = (credentialValue(GATEWAY_PREFER_ENV) ?? '').trim().toLowerCase();
  if (raw && !(GATEWAY_PREFERENCES as readonly string[]).includes(raw)) {
    return `${GATEWAY_PREFER_ENV}=${raw} is not a preference; it must be one of: ${GATEWAY_PREFERENCES.join(', ')}`;
  }
  const unknown = exceptionWords().filter((w) => !(w in PROVIDERS) || w === 'ollama');
  if (unknown.length) return `${GATEWAY_EXCEPT_ENV} names ${unknown.join(', ')}; it takes provider ids (${(Object.keys(PROVIDERS) as ProviderId[]).filter((p) => p !== 'ollama').join(', ')}), never ollama`;
  return undefined;
}

/** Which way the rule leans: `direct` (the default; a provider's own key wins) or `gateway` (the gateway wins). An unrecognised value reads as direct. */
export function gatewayPreference(): GatewayPreference {
  const raw = (credentialValue(GATEWAY_PREFER_ENV) ?? '').trim().toLowerCase();
  return raw === 'gateway' ? 'gateway' : 'direct';
}

function exceptionWords(): string[] {
  return (credentialValue(GATEWAY_EXCEPT_ENV) ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
}

/** The providers that take the opposite of the preference (MODEL_GATEWAY_EXCEPT); unknown words and ollama are dropped and named by gatewayPreferenceProblem. */
export function gatewayExceptions(): ReadonlySet<ProviderId> {
  return new Set(exceptionWords().filter((w): w is ProviderId => w in PROVIDERS && w !== 'ollama'));
}

/** True when the operator wants `provider`'s ids on the gateway even beside a direct key: the preference, turned round for an exception. */
export function gatewayWanted(provider: ProviderId): boolean {
  if (provider === 'ollama') return false;
  const prefersGateway = gatewayPreference() === 'gateway';
  return gatewayExceptions().has(provider) ? !prefersGateway : prefersGateway;
}

/** True when a gateway is configured well enough to serve requests. */
export function gatewayUsable(): boolean {
  const cfg = gatewayConfig();
  return !!cfg && cfg.keyPresent;
}

/** Parses "a=b,c=d" into a map; malformed pairs are skipped. */
function modelMapFromEnv(): Record<string, string> {
  const raw = credentialValue(GATEWAY_MODEL_MAP_ENV) ?? '';
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
 * GPT, Grok, Kimi and DeepSeek ids already carry dots (or need none), so only the
 * prefix is added. An id
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

/**
 * The id a gateway's System One route expects for a `jev-*` YAML id
 * (lib/models/jev.ts): MODEL_GATEWAY_MODEL_MAP first, then the gateway's
 * own rule.
 */
export function gatewaySystemOneModel(model: string, gateway: GatewayInfo): string {
  return modelMapFromEnv()[model] ?? gateway.systemOne.wire(model);
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
  return providerTransport(providerForModel(model), opts);
}

/**
 * Where a provider's ids are served from under the current environment: the
 * rule in this file's header. A caller's own key (BYOK) and Ollama are
 * direct whatever the preference; otherwise the preferred path when it is
 * funded, else the other when it is, else unfunded.
 */
export function providerTransport(provider: ProviderId, opts: { callerKey?: boolean } = {}): TransportPlan {
  const keyEnv = PROVIDERS[provider].keyEnv;
  if (provider === 'ollama' || opts.callerKey) return { provider, transport: 'direct', funded: true, keyEnv };
  // A Sign in with ChatGPT credential funds OpenAI directly when no key does (ADR 0126).
  const direct = providerReady(provider) || (provider === 'openai' && chatGptSignInRoutesOpenAi());
  const cfg = gatewayConfig();
  const viaGateway: TransportPlan | undefined = cfg && cfg.keyPresent ? { provider, transport: 'gateway', gateway: cfg.gateway, funded: true, keyEnv } : undefined;
  if (gatewayWanted(provider) && viaGateway) return viaGateway;
  if (direct) return { provider, transport: 'direct', funded: true, keyEnv };
  if (viaGateway) return viaGateway;
  return { provider, transport: 'direct', funded: false, keyEnv };
}
