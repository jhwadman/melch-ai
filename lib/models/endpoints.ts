/**
 * lib/models/endpoints.ts — where each provider's requests go and how they
 * authenticate (ADR 0023).
 *
 * The model id still picks the provider (lib/models/providerMap.ts). This
 * module picks the provider's PLATFORM: its own public API, or the cloud an
 * enterprise reaches it through, plus a base URL for an internal proxy and a
 * map from the YAML id to the id (or deployment) that platform knows.
 *
 *   provider   platforms                 credential on a cloud platform
 *   gemini     direct | vertex           Google Application Default Credentials
 *   anthropic  direct | bedrock | vertex AWS credential chain / Google ADC
 *   openai     direct | azure            AZURE_OPENAI_API_KEY, else Entra ID
 *   xai, moonshot, ollama  direct only (moonshot: MOONSHOT_BASE_URL for a proxy)
 *
 * Configuration comes from the environment (`endpointFromEnv`) or, per
 * request, from the server's `credentials` plug point, which may return an
 * API key or a partial endpoint merged over the environment's.
 *
 * The Vertex AI, Bedrock and Azure paths are built on each vendor SDK's own
 * client for that platform and are tested against mocks; they have not been
 * run against the live clouds from this repository. The doctor says so.
 */

import { PROVIDERS, providerKeyPresent } from './providerMap.ts';
import type { ProviderId } from './providerMap.ts';

export type Platform = 'direct' | 'vertex' | 'bedrock' | 'azure';

export const PLATFORMS_FOR: Record<ProviderId, readonly Platform[]> = {
  gemini: ['direct', 'vertex'],
  anthropic: ['direct', 'bedrock', 'vertex'],
  openai: ['direct', 'azure'],
  xai: ['direct'],
  moonshot: ['direct'],
  ollama: ['direct'],
};

export interface ProviderEndpoint {
  platform: Platform;
  /** direct: an OpenAI- or Anthropic-compatible proxy in front of the vendor API. */
  baseURL?: string;
  /** A static key: the environment's, a caller's, or one a secret manager returned. */
  apiKey?: string;
  /** A bearer-token source called per client (Entra ID, a secret manager). openai/azure only. */
  token?: () => Promise<string>;
  /** vertex: the Google Cloud project and location (region, or `global`). */
  project?: string;
  location?: string;
  /** bedrock: the AWS region. */
  region?: string;
  /** YAML model id → the id or deployment name this platform uses. Unlisted ids pass through. */
  models?: Record<string, string>;
}

const PLATFORM_ENV: Partial<Record<ProviderId, string>> = {
  gemini: 'GEMINI_PLATFORM',
  anthropic: 'ANTHROPIC_PLATFORM',
  openai: 'OPENAI_PLATFORM',
};

const MODEL_MAP_ENV: Partial<Record<ProviderId, string>> = {
  gemini: 'GEMINI_MODEL_MAP',
  anthropic: 'ANTHROPIC_MODEL_MAP',
  openai: 'OPENAI_MODEL_MAP',
};

const trimmed = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

function parseModelMap(raw: string | undefined, name: string): Record<string, string> | undefined {
  if (!trimmed(raw)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch {
    throw new Error(`${name} must be a JSON object of model id → platform id.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((v) => typeof v !== 'string')) {
    throw new Error(`${name} must be a JSON object of model id → platform id.`);
  }
  return parsed as Record<string, string>;
}

/** The platform the environment selects for a provider (default direct). */
export function platformFromEnv(provider: ProviderId, env: NodeJS.ProcessEnv = process.env): Platform {
  const name = PLATFORM_ENV[provider];
  const raw = name ? trimmed(env[name])?.toLowerCase() : undefined;
  // @google/genai's own switch selects Vertex too, so honour it rather than
  // run a Vertex-configured process against AI Studio.
  if (!raw && provider === 'gemini' && /^(1|true)$/i.test(env.GOOGLE_GENAI_USE_VERTEXAI ?? '')) return 'vertex';
  if (!raw) return 'direct';
  if (!(PLATFORMS_FOR[provider] as readonly string[]).includes(raw)) {
    throw new Error(`${name}=${raw} is not a platform for ${PROVIDERS[provider].label}; use one of ${PLATFORMS_FOR[provider].join(', ')}.`);
  }
  return raw as Platform;
}

/** A provider's endpoint as the environment configures it. */
export function endpointFromEnv(provider: ProviderId, env: NodeJS.ProcessEnv = process.env): ProviderEndpoint {
  const platform = platformFromEnv(provider, env);
  const mapEnv = MODEL_MAP_ENV[provider];
  const models = mapEnv ? parseModelMap(env[mapEnv], mapEnv) : undefined;
  const base: ProviderEndpoint = { platform, ...(models ? { models } : {}) };
  switch (`${provider}/${platform}`) {
    case 'gemini/vertex':
      return { ...base, project: trimmed(env.GOOGLE_CLOUD_PROJECT), location: trimmed(env.GOOGLE_CLOUD_LOCATION) };
    case 'anthropic/vertex':
      return {
        ...base,
        project: trimmed(env.ANTHROPIC_VERTEX_PROJECT_ID) ?? trimmed(env.GOOGLE_CLOUD_PROJECT),
        location: trimmed(env.CLOUD_ML_REGION) ?? trimmed(env.GOOGLE_CLOUD_LOCATION),
      };
    case 'anthropic/bedrock':
      return { ...base, region: trimmed(env.AWS_REGION) ?? trimmed(env.AWS_DEFAULT_REGION) };
    case 'anthropic/direct':
      return { ...base, ...(trimmed(env.ANTHROPIC_BASE_URL) ? { baseURL: trimmed(env.ANTHROPIC_BASE_URL) } : {}) };
    case 'openai/direct':
      return { ...base, ...(trimmed(env.OPENAI_BASE_URL) ? { baseURL: trimmed(env.OPENAI_BASE_URL) } : {}) };
    case 'moonshot/direct':
      return { ...base, ...(trimmed(env.MOONSHOT_BASE_URL) ? { baseURL: trimmed(env.MOONSHOT_BASE_URL) } : {}) };
    case 'openai/azure': {
      const endpoint = trimmed(env.AZURE_OPENAI_ENDPOINT);
      const key = trimmed(env.AZURE_OPENAI_API_KEY);
      return {
        ...base,
        ...(endpoint ? { baseURL: azureBaseURL(endpoint) } : {}),
        ...(key ? { apiKey: key } : {}),
      };
    }
    default:
      return base;
  }
}

/** Azure OpenAI's v1 API, which the plain OpenAI client speaks. */
export function azureBaseURL(endpoint: string): string {
  const root = endpoint.replace(/\/+$/, '').replace(/\/openai(\/v1)?$/, '');
  return `${root}/openai/v1/`;
}

/** The id to send: the platform's name for a YAML model id. */
export function platformModel(endpoint: ProviderEndpoint | undefined, model: string): string {
  return endpoint?.models?.[model] ?? model;
}

/** What is missing for an endpoint to be usable; empty when complete. */
export function endpointProblems(provider: ProviderId, e: ProviderEndpoint): string[] {
  const problems: string[] = [];
  switch (`${provider}/${e.platform}`) {
    case 'gemini/vertex':
    case 'anthropic/vertex':
      if (!e.project) problems.push(provider === 'gemini' ? 'GOOGLE_CLOUD_PROJECT not set' : 'ANTHROPIC_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) not set');
      if (!e.location) problems.push(provider === 'gemini' ? 'GOOGLE_CLOUD_LOCATION not set' : 'CLOUD_ML_REGION (or GOOGLE_CLOUD_LOCATION) not set');
      break;
    case 'anthropic/bedrock':
      if (!e.region) problems.push('AWS_REGION not set');
      break;
    case 'openai/azure':
      if (!e.baseURL) problems.push('AZURE_OPENAI_ENDPOINT not set');
      break;
  }
  return problems;
}

/**
 * True when a provider can be called: its key is present on the direct
 * platform, or its cloud platform is fully configured (the cloud's own
 * credential chain is then trusted to authenticate; the doctor says it was
 * not checked).
 */
export function providerReady(provider: ProviderId): boolean {
  let e: ProviderEndpoint;
  try {
    e = endpointFromEnv(provider);
  } catch {
    return false;
  }
  if (e.platform === 'direct') return providerKeyPresent(provider);
  return endpointProblems(provider, e).length === 0;
}

/** Merge a per-request endpoint (the credentials plug point) over the environment's. */
export function mergeEndpoint(provider: ProviderId, override: Partial<ProviderEndpoint> | undefined): ProviderEndpoint {
  const fromEnv = endpointFromEnv(provider);
  if (!override) return fromEnv;
  if (override.platform && override.platform !== fromEnv.platform) {
    // A different platform shares nothing with the environment's settings.
    return { ...override, platform: override.platform } as ProviderEndpoint;
  }
  return { ...fromEnv, ...override, platform: fromEnv.platform };
}

/** The label for logs and the doctor: "Claude on Bedrock (us-east-1)". */
export function endpointLabel(provider: ProviderId, e: ProviderEndpoint): string {
  const where =
    e.platform === 'vertex'
      ? `Vertex AI${e.project ? ` (${e.project}, ${e.location ?? '?'})` : ''}`
      : e.platform === 'bedrock'
        ? `Bedrock${e.region ? ` (${e.region})` : ''}`
        : e.platform === 'azure'
          ? `Azure OpenAI${e.baseURL ? ` (${new URL(e.baseURL).host})` : ''}`
          : e.baseURL
            ? `proxy ${safeHost(e.baseURL)}`
            : 'direct';
  return `${PROVIDERS[provider].label} on ${where}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid URL)';
  }
}

/** How a cloud platform authenticates, for the doctor. */
export function credentialSource(provider: ProviderId, e: ProviderEndpoint): string {
  if (e.platform === 'vertex') return 'Google Application Default Credentials';
  if (e.platform === 'bedrock') return 'the AWS credential chain';
  if (e.platform === 'azure') return e.apiKey ? 'AZURE_OPENAI_API_KEY' : e.token ? 'a token callback' : 'Entra ID (@azure/identity)';
  return PROVIDERS[provider].keyEnv ?? 'none (local)';
}

/** The vendor SDK package a platform needs, beyond the direct one. */
export const PLATFORM_SDK: Partial<Record<`${ProviderId}/${Platform}`, string>> = {
  'anthropic/bedrock': '@anthropic-ai/bedrock-sdk',
  'anthropic/vertex': '@anthropic-ai/vertex-sdk',
};

// ── Building a vendor client for a platform ──────────────────────────────────

/** Which SDK class to construct, with what options. */
export interface ClientSpec {
  module: string;
  /** Export names tried in order (default export first for the direct SDKs). */
  exportNames: string[];
  options: Record<string, unknown>;
}

export type SdkImporter = (module: string) => Promise<any>;

let sdkImporter: SdkImporter = (module) => import(module);

/**
 * Replace how vendor SDKs are imported: for tests (a mock Bedrock client)
 * and for bundlers that need static imports. Undefined restores the default.
 */
export function setSdkImporter(importer: SdkImporter | undefined): void {
  sdkImporter = importer ?? ((module) => import(module));
}

/** Import a spec's module and construct its client. Throws SdkMissingError when absent. */
export async function instantiateClient(spec: ClientSpec): Promise<any> {
  let mod: any;
  try {
    mod = await sdkImporter(spec.module);
  } catch {
    throw new SdkMissingError(spec.module);
  }
  const Ctor = spec.exportNames.map((n) => mod?.[n]).find((c) => typeof c === 'function');
  if (!Ctor) throw new Error(`${spec.module} exports none of ${spec.exportNames.join(', ')}.`);
  return new Ctor(spec.options);
}

export class SdkMissingError extends Error {
  readonly module: string;
  constructor(module: string) {
    super(`The ${module} package is not installed. Run: npm install ${module}`);
    this.module = module;
  }
}

/** The Anthropic client for an endpoint, or why it cannot be built. */
export function claudeClientSpec(e: ProviderEndpoint, apiKey: string | undefined): ClientSpec | { error: string } {
  const problems = endpointProblems('anthropic', e);
  if (problems.length) return { error: `Claude on ${e.platform}: ${problems.join('; ')}.` };
  switch (e.platform) {
    case 'bedrock':
      return { module: '@anthropic-ai/bedrock-sdk', exportNames: ['AnthropicBedrock', 'default'], options: { awsRegion: e.region } };
    case 'vertex':
      return { module: '@anthropic-ai/vertex-sdk', exportNames: ['AnthropicVertex', 'default'], options: { projectId: e.project, region: e.location } };
    default:
      if (!apiKey) return { error: 'ANTHROPIC_API_KEY is not set in environment.' };
      return { module: '@anthropic-ai/sdk', exportNames: ['default', 'Anthropic'], options: { apiKey, ...(e.baseURL ? { baseURL: e.baseURL } : {}) } };
  }
}

/** The scope Azure OpenAI tokens are issued for. */
export const AZURE_COGNITIVE_SCOPE = 'https://cognitiveservices.azure.com/.default';

let entraProvider: Promise<() => Promise<string>> | undefined;

/**
 * A bearer-token source from Entra ID (DefaultAzureCredential: managed
 * identity, workload identity, the Azure CLI...), shared by every client in
 * the process so tokens are cached and refreshed once.
 */
export function entraTokenSource(): () => Promise<string> {
  return async () => {
    entraProvider ??= sdkImporter('@azure/identity').then(
      (m) => m.getBearerTokenProvider(new m.DefaultAzureCredential(), AZURE_COGNITIVE_SCOPE),
      () => {
        entraProvider = undefined;
        throw new Error(
          'Azure OpenAI without AZURE_OPENAI_API_KEY authenticates with Entra ID through @azure/identity, which is not installed. Run: npm install @azure/identity',
        );
      },
    );
    return (await entraProvider)();
  };
}

/** Platforms whose adapter does not send the provider's native web search. */
export function nativeSearchOn(provider: ProviderId, platform: Platform): boolean {
  if (platform === 'direct') return true;
  // Gemini grounding is a Vertex AI feature as much as an AI Studio one.
  // Anthropic's server-side web search and OpenAI's web_search tool are not
  // sent on Bedrock, Claude-on-Vertex or Azure: availability there varies by
  // region and version and has not been verified from this repository.
  return provider === 'gemini';
}
