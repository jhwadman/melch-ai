/**
 * lib/tools/oauthDiscovery.ts — an MCP server's authorization server,
 * discovered, and this deployment registered at it as an OAuth client
 * (ADR 0124).
 *
 * WHY this file exists:
 *   The official remote MCP servers (an issue tracker's, a wiki's, a code
 *   host's) take each user's own OAuth token, and most issue no client id in
 *   advance: the MCP authorization spec has a client find the authorization
 *   server from the MCP server (protected-resource metadata, RFC 9728; then
 *   authorization-server metadata, RFC 8414 or OpenID discovery) and register
 *   itself (dynamic client registration, RFC 7591). A YAML says so with
 *   `client_registration: dynamic` on the server's `oauth2` grant; this module
 *   does the discovery and the registration, and keeps the registered client.
 *
 * WHAT IT GUARANTEES:
 *   - The MCP server is asked first, as the MCP authorization spec has a
 *     client do: an unauthenticated initialize request, and on a 401 the
 *     Bearer challenge's `resource_metadata` (and `scope`) parameters in its
 *     WWW-Authenticate header (RFC 9728 5.1). The URL it names is read first;
 *     the well-known URLs are the fallback. The header is read by a linear,
 *     length-bounded tokenizer (no regular expression), and never logged.
 *   - Discovery never widens the operator's OAuth host allowlist (ADR 0114):
 *     every URL it fetches (the MCP server's challenge, the metadata
 *     documents, including one the header names, the registration
 *     endpoint) and every endpoint it returns (authorization, token) must be
 *     a host the allowlist binds to the provider, checked before the request
 *     and again whenever the client is used. A discovered host outside it is
 *     refused by name, not skipped.
 *   - Every request passes the transport rule (https, or http to a loopback
 *     host) and the SSRF guard (lib/net/addressGuard.ts) unless private hosts
 *     are allowed (ALLOW_PRIVATE_MCP), follows no redirect, has a time limit,
 *     and reads a bounded JSON body.
 *   - The authorization server must advertise PKCE S256; one that does not is
 *     refused (MCP authorization spec). The client registers as a public
 *     client (`token_endpoint_auth_method: none`) for the one configured
 *     redirect URI, with the authorization_code and refresh_token grants.
 *   - The registered client is kept per provider, MCP server and redirect URI
 *     in the credential store's rows, sealed by its cipher
 *     (MELCHIZEDEK_CREDENTIAL_KEY), under an app name no run can have (it
 *     carries `:`, which a memory namespace cannot), so no tool call can read
 *     it as a token. A row this key cannot open, an expired client secret, or
 *     endpoints that moved are registered again.
 *   - No client secret, metadata body or server error text reaches a log
 *     line, an error message or a result: refusals name roles and hosts.
 */

import { createHash } from 'node:crypto';

import { checkHost } from '../net/addressGuard.ts';
import { OAUTH_SCOPE, PROVIDER_NAME } from './auth.ts';
import type { CredentialKey } from './auth.ts';
import type { CredentialCipher } from './credentialCipher.ts';
import { credentialContext } from './credentialStore.ts';
import type { CredentialRows } from './credentialStore.ts';
import { oauthHostProblem, oauthHosts } from './oauthHosts.ts';
import type { OAuthHostAllowlist } from './oauthHosts.ts';
import type { OAuthClientConfig, OAuthClientSource } from './oauthConsent.ts';

/** A discovery or registration that cannot proceed. The message names roles and hosts, never a value. */
export class OAuthDiscoveryError extends Error {
  readonly provider: string;
  constructor(provider: string, message: string) {
    // An allowlist refusal already names its provider (lib/tools/oauthHosts.ts).
    super(message.startsWith('provider "') ? message : `provider "${provider}": ${message}`);
    this.name = 'OAuthDiscoveryError';
    this.provider = provider;
  }
}

/** What discovery found: the MCP server as a resource, and its authorization server's endpoints. */
export interface DiscoveredAuthorization {
  /** The MCP server's canonical URI, sent as the RFC 8707 `resource` parameter. */
  resource: string;
  /** The authorization server's issuer identifier. */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  /**
   * The scopes the MCP server's 401 challenge named (its `scope` parameter),
   * when it named any: the MCP spec's first choice when the grant names none.
   */
  challengeScopes?: string[];
}

export interface DiscoveryOptions {
  /** The provider the grant names: the allowlist is read for it. */
  provider: string;
  /** Private and loopback hosts pass the SSRF guard (ALLOW_PRIVATE_MCP). The allowlist still applies. */
  allowPrivate?: boolean;
  /** The allowlist; default the one in force (`null`: none configured, which refuses). */
  allowlist?: OAuthHostAllowlist | null;
  /** Each request's time limit, ms. Default 10 s. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

const MAX_METADATA_BYTES = 64 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The URL, or a refusal naming its role: https, or http to a loopback host, and no credentials in it. */
function endpointUrl(provider: string, raw: unknown, role: string): URL {
  if (typeof raw !== 'string' || raw.length > 2048) throw new OAuthDiscoveryError(provider, `the ${role} is missing or not a URL`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthDiscoveryError(provider, `the ${role} is not a URL`);
  }
  if (url.username || url.password) throw new OAuthDiscoveryError(provider, `the ${role} (${url.hostname}) carries credentials in its URL`);
  if (url.hash) throw new OAuthDiscoveryError(provider, `the ${role} (${url.hostname}) carries a fragment`);
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!ok) throw new OAuthDiscoveryError(provider, `the ${role} (${url.hostname}) is not https (http only to a loopback host)`);
  return url;
}

/** The MCP server's canonical URI (RFC 8707, MCP authorization spec): no fragment, no trailing slash on a path. */
export function canonicalResource(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  const path = url.pathname === '/' ? '' : url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** Two identifiers equal but for a trailing slash. */
const sameId = (a: string, b: string): boolean => (a.endsWith('/') ? a.slice(0, -1) : a) === (b.endsWith('/') ? b.slice(0, -1) : b);

/** The options every guarded request reads. */
type GuardOptions = Required<Pick<DiscoveryOptions, 'provider'>> & DiscoveryOptions & { list: OAuthHostAllowlist | null };

/**
 * Discovery and registration's one way out: the URL checked against the
 * operator's allowlist for the provider and the SSRF guard first (refusal
 * throws, and no request is made), then one request with no redirect and a
 * time limit. `undefined` when the host could not be reached.
 */
async function guardedFetch(url: URL, role: string, options: GuardOptions, init: RequestInit = {}): Promise<Response | undefined> {
  const { provider } = options;
  const refused = oauthHostProblem({ provider, grant: 'authorization_code' }, url.href, role, options.list);
  if (refused) throw new OAuthDiscoveryError(provider, `${refused} (discovery never widens the allowlist)`);
  if (options.allowPrivate !== true) {
    const reason = await checkHost(url.hostname);
    if (reason) throw new OAuthDiscoveryError(provider, `refusing the ${role} ${url.hostname}: ${reason}`);
  }
  try {
    return await (options.fetch ?? fetch)(url.href, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
      // A redirect would take the request (and, for registration, the redirect URI) wherever it points.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return undefined;
  }
}

/**
 * A guarded request with a bounded JSON body. Refusal or an unreachable host
 * throws; a non-2xx answer or an unusable body is `undefined` for a metadata
 * candidate, so the next one can be tried.
 */
async function guardedJson(url: URL, role: string, options: GuardOptions, init: RequestInit = {}): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
  const res = await guardedFetch(url, role, options, init);
  if (!res) throw new OAuthDiscoveryError(options.provider, `the ${role} (${url.hostname}) could not be reached`);
  const reader = res.body?.getReader();
  if (!reader) return { status: res.status, json: undefined };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_METADATA_BYTES) {
      await reader.cancel().catch(() => {});
      return { status: res.status, json: undefined };
    }
    chunks.push(value);
  }
  if (!res.ok) return { status: res.status, json: undefined };
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { status: res.status, json: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined };
  } catch {
    return { status: res.status, json: undefined };
  }
}

// ── The MCP server's 401 challenge (RFC 9728 5.1, RFC 6750 3, RFC 9110 11.6.1) ──

/** A WWW-Authenticate header longer than this is ignored whole. */
export const MAX_CHALLENGE_HEADER = 8 * 1024;
/** A parameter value longer than this is ignored. */
const MAX_CHALLENGE_VALUE = 2048;
const MAX_CHALLENGE_SCOPES = 64;

/** What a Bearer challenge tells a client that has no token yet. */
export interface BearerChallenge {
  /** The `resource_metadata` parameter: the protected-resource metadata URL (RFC 9728 5.1), unparsed. */
  resourceMetadata?: string;
  /** The `scope` parameter, split, each a valid scope token (RFC 6750 3). */
  scopes?: string[];
}

/** RFC 9110 tchar, by code point: no regular expression on header input. */
function isTchar(c: number): boolean {
  if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return true;
  // ! # $ % & ' * + - . ^ _ ` | ~
  return c === 0x21 || (c >= 0x23 && c <= 0x27) || c === 0x2a || c === 0x2b || c === 0x2d || c === 0x2e || c === 0x5e || c === 0x5f || c === 0x60 || c === 0x7c || c === 0x7e;
}

/**
 * The first Bearer challenge's parameters in a WWW-Authenticate header, or
 * undefined (no Bearer challenge, or a header that is too long or malformed:
 * either is ignored whole, and discovery falls back to the well-known URLs).
 * One pass over the header, each step advancing: linear in its length, with
 * no regular expression. Several challenges in one header, quoted-string
 * values with escapes, case-insensitive scheme and parameter names, and a
 * token68 credential on another scheme are understood. A parameter given
 * twice in the Bearer challenge makes it ambiguous, and malformed.
 */
export function parseBearerChallenge(header: string | null | undefined): BearerChallenge | undefined {
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_CHALLENGE_HEADER) return undefined;
  const h = header;
  const n = h.length;
  let i = 0;
  const ws = () => {
    while (i < n && (h[i] === ' ' || h[i] === '\t')) i++;
  };
  /** A token, or a token68 (which adds `/`); empty when none starts here. */
  const word = () => {
    const start = i;
    while (i < n && (isTchar(h.charCodeAt(i)) || h[i] === '/')) i++;
    return h.slice(start, i);
  };
  let current = ''; // the scheme the parameters belong to, lowercased
  let afterScheme = false; // a scheme was read, and no comma since: a bare word is its token68
  let bearer: Map<string, string> | undefined;
  while (i < n) {
    ws();
    if (i >= n) break;
    if (h[i] === ',') {
      i++;
      afterScheme = false;
      continue;
    }
    const name = word();
    if (!name) return undefined; // a character no challenge can hold here
    ws();
    if (h[i] !== '=') {
      if (afterScheme) continue; // the scheme's token68 credential
      if (bearer) break; // the Bearer challenge is complete
      current = name.toLowerCase();
      afterScheme = true;
      if (current === 'bearer') bearer = new Map();
      continue;
    }
    // `=`: an auth-param, or the padding of a token68.
    let eq = 0;
    while (i < n && h[i] === '=') {
      i++;
      eq++;
    }
    ws();
    if (eq > 1 || i >= n || h[i] === ',') {
      if (!afterScheme) return undefined; // padding with no scheme before it
      continue; // token68 padding
    }
    if (name.includes('/')) return undefined; // not a parameter name
    let value: string;
    if (h[i] === '"') {
      i++;
      const parts: string[] = [];
      let length = 0;
      let closed = false;
      while (i < n) {
        const ch = h[i]!;
        if (ch === '"') {
          i++;
          closed = true;
          break;
        }
        if (ch === '\\') {
          i++;
          if (i >= n) break;
        }
        if (length <= MAX_CHALLENGE_VALUE) {
          parts.push(h[i]!);
          length++;
        }
        i++;
      }
      if (!closed) return undefined;
      value = parts.join('');
    } else {
      value = word();
      if (!value) return undefined;
    }
    ws();
    if (i < n && h[i] !== ',') return undefined; // a parameter runs into something else
    afterScheme = false;
    if (current === 'bearer' && bearer) {
      const key = name.toLowerCase();
      if (bearer.has(key)) return undefined;
      bearer.set(key, value);
    }
  }
  if (!bearer) return undefined;
  const out: BearerChallenge = {};
  const metadata = bearer.get('resource_metadata');
  if (metadata && metadata.length <= MAX_CHALLENGE_VALUE) out.resourceMetadata = metadata;
  const scope = bearer.get('scope');
  if (scope && scope.length <= MAX_CHALLENGE_VALUE) {
    const scopes = [...new Set(scope.split(' ').filter((s) => s && OAUTH_SCOPE.test(s)))].slice(0, MAX_CHALLENGE_SCOPES);
    if (scopes.length) out.scopes = scopes;
  }
  return out;
}

/** The request that draws the challenge: an MCP initialize with no token, as any client's first request is. */
const PROBE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'melchizedek-oauth-discovery', version: '1' } },
});

/**
 * The MCP server's Bearer challenge, when an unauthenticated initialize is
 * answered 401 with one. Refused like every request (allowlist, SSRF guard)
 * before it is sent; any other answer, or no answer, is undefined and
 * discovery uses the well-known URLs. The body is never read, and the header
 * is never logged.
 */
async function serverChallenge(server: URL, options: GuardOptions): Promise<BearerChallenge | undefined> {
  const res = await guardedFetch(server, 'MCP server', options, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: PROBE_BODY,
  });
  if (!res) return undefined;
  await res.body?.cancel().catch(() => {});
  if (res.status !== 401) return undefined;
  return parseBearerChallenge(res.headers.get('www-authenticate'));
}

/** RFC 9728 3.1: the protected-resource metadata URLs for a server, path-specific first. */
export function protectedResourceMetadataUrls(serverUrl: string): URL[] {
  const url = new URL(serverUrl);
  const path = url.pathname === '/' ? '' : url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const out = [new URL(`/.well-known/oauth-protected-resource${path}`, url.origin)];
  if (path) out.push(new URL('/.well-known/oauth-protected-resource', url.origin));
  return out;
}

/** RFC 8414 3.1 and OpenID discovery, in the order the MCP authorization spec gives. */
export function authorizationServerMetadataUrls(issuer: string): URL[] {
  const url = new URL(issuer);
  const path = url.pathname === '/' ? '' : url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  if (!path) return [new URL('/.well-known/oauth-authorization-server', url.origin), new URL('/.well-known/openid-configuration', url.origin)];
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, url.origin),
    new URL(`/.well-known/openid-configuration${path}`, url.origin),
    new URL(`${path}/.well-known/openid-configuration`, url.origin),
  ];
}

/**
 * The MCP server's authorization server, as the MCP authorization spec finds
 * it: the protected-resource metadata URL named by the server's 401 challenge
 * (WWW-Authenticate, RFC 9728 5.1), then the well-known URLs (RFC 9728 3.1);
 * the metadata names the authorization server (a server with none is its
 * own, as the 2025-03-26 revision had it), and its own metadata (RFC 8414, or
 * OpenID discovery) names the endpoints. Every host involved, the one the
 * header names included, passes the provider's allowlist before any request;
 * PKCE S256 and a registration endpoint are required. Throws
 * OAuthDiscoveryError.
 */
export async function discoverAuthorization(serverUrl: string, options: DiscoveryOptions): Promise<DiscoveredAuthorization> {
  const { provider } = options;
  if (!PROVIDER_NAME.test(provider)) throw new OAuthDiscoveryError('oauth', 'the provider name is not valid');
  const list = options.allowlist === undefined ? oauthHosts() ?? null : options.allowlist;
  const opts = { ...options, list };
  const server = endpointUrl(provider, serverUrl, 'MCP server');
  const resource = canonicalResource(server.href);

  const challenge = await serverChallenge(server, opts);
  const candidates: Array<{ url: URL; role: string }> = [];
  if (challenge?.resourceMetadata) {
    // A value that is no URL at all is a malformed challenge, ignored; a URL is held to every rule, and refused by name.
    let parsed: URL | undefined;
    try {
      parsed = new URL(challenge.resourceMetadata);
    } catch {
      parsed = undefined;
    }
    const role = 'protected-resource metadata named by the 401';
    if (parsed) candidates.push({ url: endpointUrl(provider, parsed.href, role), role });
  }
  for (const url of protectedResourceMetadataUrls(server.href)) {
    if (!candidates.some((c) => c.url.href === url.href)) candidates.push({ url, role: 'protected-resource metadata' });
  }

  let issuer: string | undefined;
  for (const { url: candidate, role } of candidates) {
    const { json } = await guardedJson(candidate, role, opts);
    if (!json) continue;
    if (typeof json.resource === 'string' && !sameId(json.resource, resource)) {
      throw new OAuthDiscoveryError(provider, `the protected-resource metadata at ${candidate.hostname} names another resource than the MCP server (RFC 9728 3.3)`);
    }
    const servers = Array.isArray(json.authorization_servers) ? json.authorization_servers : [];
    if (typeof servers[0] !== 'string') throw new OAuthDiscoveryError(provider, `the protected-resource metadata at ${candidate.hostname} names no authorization server`);
    issuer = servers[0];
    break;
  }
  // No protected-resource metadata: the MCP server's origin is its authorization server (MCP 2025-03-26).
  const issuerUrl = endpointUrl(provider, issuer ?? server.origin, 'authorization server');
  const issuerId = issuer ?? server.origin;

  let metadata: Record<string, unknown> | undefined;
  for (const candidate of authorizationServerMetadataUrls(issuerUrl.href)) {
    const { json } = await guardedJson(candidate, 'authorization server metadata', opts);
    if (!json) continue;
    if (typeof json.issuer !== 'string' || !sameId(json.issuer, issuerId)) {
      throw new OAuthDiscoveryError(provider, `the authorization server metadata at ${candidate.hostname} names another issuer (RFC 8414 3.3)`);
    }
    metadata = json;
    break;
  }
  if (!metadata) throw new OAuthDiscoveryError(provider, `no authorization server metadata at ${issuerUrl.hostname}`);
  const methods = Array.isArray(metadata.code_challenge_methods_supported) ? metadata.code_challenge_methods_supported : [];
  if (!methods.includes('S256')) throw new OAuthDiscoveryError(provider, `the authorization server ${issuerUrl.hostname} does not advertise PKCE S256, which the MCP authorization spec requires`);
  if (metadata.registration_endpoint === undefined) {
    throw new OAuthDiscoveryError(provider, `the authorization server ${issuerUrl.hostname} offers no dynamic client registration; declare client_id and the endpoints instead`);
  }
  const endpoints = {
    authorizationEndpoint: endpointUrl(provider, metadata.authorization_endpoint, 'authorization endpoint'),
    tokenEndpoint: endpointUrl(provider, metadata.token_endpoint, 'token endpoint'),
    registrationEndpoint: endpointUrl(provider, metadata.registration_endpoint, 'registration endpoint'),
  };
  // Discovery never widens the allowlist: each endpoint it found is one the operator bound to the provider.
  for (const [role, url] of [['authorization_url', endpoints.authorizationEndpoint], ['token_url', endpoints.tokenEndpoint], ['registration endpoint', endpoints.registrationEndpoint]] as const) {
    const refused = oauthHostProblem({ provider, grant: 'authorization_code' }, url.href, role, list);
    if (refused) throw new OAuthDiscoveryError(provider, `${refused} (discovery never widens the allowlist)`);
    if (options.allowPrivate !== true) {
      const reason = await checkHost(url.hostname);
      if (reason) throw new OAuthDiscoveryError(provider, `refusing the ${role} ${url.hostname}: ${reason}`);
    }
  }
  return {
    resource,
    issuer: issuerId,
    authorizationEndpoint: endpoints.authorizationEndpoint.href,
    tokenEndpoint: endpoints.tokenEndpoint.href,
    registrationEndpoint: endpoints.registrationEndpoint.href,
    ...(challenge?.scopes ? { challengeScopes: challenge.scopes } : {}),
  };
}

/** A client this deployment registered at an authorization server. */
export interface RegisteredClient {
  clientId: string;
  /** A confidential client's secret, when the server issued one anyway. */
  clientSecret?: string;
  /** Epoch ms after which the secret stops working; absent when it does not expire. */
  secretExpiresAt?: number;
}

export interface RegistrationOptions extends DiscoveryOptions {
  /** The consent callback, exactly as every authorization will send it. */
  redirectUri: string;
  /** Shown to the person on the provider's consent screen. Default "Melchizedek agents". */
  clientName?: string;
  scopes?: string[];
}

const CLIENT_ID_MAX = 512;
const CLIENT_SECRET_MAX = 2048;

/**
 * Registers this deployment at the authorization server (RFC 7591) as a
 * public PKCE client for the one redirect URI. Throws OAuthDiscoveryError,
 * never the server's text.
 */
export async function registerOAuthClient(discovered: DiscoveredAuthorization, options: RegistrationOptions): Promise<RegisteredClient> {
  const { provider } = options;
  const list = options.allowlist === undefined ? oauthHosts() ?? null : options.allowlist;
  const endpoint = endpointUrl(provider, discovered.registrationEndpoint, 'registration endpoint');
  const body: Record<string, unknown> = {
    client_name: options.clientName ?? 'Melchizedek agents',
    redirect_uris: [options.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  if (options.scopes?.length) body.scope = options.scopes.join(' ');
  const { status, json } = await guardedJson(endpoint, 'registration endpoint', { ...options, list }, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (status !== 200 && status !== 201) throw new OAuthDiscoveryError(provider, `the registration endpoint ${endpoint.hostname} refused the registration (HTTP ${status})`);
  const clientId = json?.client_id;
  if (typeof clientId !== 'string' || !clientId || clientId.length > CLIENT_ID_MAX) throw new OAuthDiscoveryError(provider, `the registration endpoint ${endpoint.hostname} answered without a usable client_id`);
  const secret = json?.client_secret;
  if (secret !== undefined && (typeof secret !== 'string' || !secret || secret.length > CLIENT_SECRET_MAX)) {
    throw new OAuthDiscoveryError(provider, `the registration endpoint ${endpoint.hostname} answered with an unusable client_secret`);
  }
  const expires = json?.client_secret_expires_at;
  return {
    clientId,
    ...(typeof secret === 'string' ? { clientSecret: secret } : {}),
    ...(typeof secret === 'string' && typeof expires === 'number' && Number.isFinite(expires) && expires > 0 ? { secretExpiresAt: expires * 1000 } : {}),
  };
}

// ── The registered clients, sealed in the credential store's rows ───────────

/**
 * The app name registered clients are filed under. It carries `:`, which a
 * memory namespace (the app a run pins, `[A-Za-z0-9._-]`) cannot, so no
 * run's credential key ever reaches one of these rows.
 */
export const REGISTERED_CLIENTS_APP = 'oauth-client:dcr';

/** The row a provider's registered client is kept in: one per MCP server (resource) and redirect URI. */
export function registeredClientKey(provider: string, resource: string, redirectUri: string): CredentialKey {
  return { appName: REGISTERED_CLIENTS_APP, userId: createHash('sha256').update(`${resource}\n${redirectUri}`).digest('hex'), provider };
}

/** What a sealed registration holds. */
interface StoredRegistration {
  v: 1;
  clientId: string;
  clientSecret?: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  redirectUri: string;
}

export interface OAuthClientRegistry {
  /** The registration kept for this key, or undefined (none, unreadable under this key, or its secret expired). */
  get(key: CredentialKey): Promise<(StoredRegistration & { secretExpiresAt?: number }) | undefined>;
  put(key: CredentialKey, registration: Omit<StoredRegistration, 'v'>, secretExpiresAt?: number): Promise<void>;
}

/** Registered clients over the credential store's rows, sealed by its cipher (the same key as every user's tokens). */
export function oauthClientRegistry(options: { rows: CredentialRows; cipher: CredentialCipher; now?: () => number }): OAuthClientRegistry {
  const { rows, cipher } = options;
  const now = options.now ?? Date.now;
  return {
    async get(key) {
      const row = await rows.read(key);
      if (!row || row.keyId !== cipher.keyId) return undefined;
      if (row.expiresAt && row.expiresAt.getTime() <= now()) return undefined;
      try {
        const parsed = JSON.parse(await cipher.decrypt(row.accessTokenEnc, credentialContext(key, 'access'))) as StoredRegistration;
        if (parsed?.v !== 1 || typeof parsed.clientId !== 'string') return undefined;
        return { ...parsed, ...(row.expiresAt ? { secretExpiresAt: row.expiresAt.getTime() } : {}) };
      } catch {
        return undefined;
      }
    },
    async put(key, registration, secretExpiresAt) {
      const sealed = await cipher.encrypt(JSON.stringify({ v: 1, ...registration }), credentialContext(key, 'access'));
      await rows.upsert({
        appName: key.appName,
        userId: key.userId,
        provider: key.provider,
        scopes: [],
        accessTokenEnc: sealed,
        refreshTokenEnc: null,
        keyId: cipher.keyId,
        expiresAt: secretExpiresAt ? new Date(secretExpiresAt) : null,
      });
    },
  };
}

// ── The consent step's client for a dynamic grant ───────────────────────────

/** A dynamic grant as a served YAML declares it (lib/tools/oauthTools.ts dynamicOAuthGrantsFor). */
export interface DynamicOAuthGrant {
  provider: string;
  /** The MCP server the grant is for. */
  server: string;
  scopes: string[];
  authorizationParams?: Record<string, string>;
}

export interface DynamicClientOptions {
  /** The consent callback, as configured (OAUTH_REDIRECT_URI). */
  redirectUri: string;
  /** Where registrations are kept; without one, each process registers once in memory. */
  registry?: OAuthClientRegistry;
  allowPrivate?: boolean;
  clientName?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** For tests. */
  allowlist?: OAuthHostAllowlist | null;
}

/**
 * The consent step's client for a dynamic grant (oauthConsent and
 * oauthRefreshProviders take it in place of a fixed config): discovered and
 * registered on first use, kept, and re-checked against the allowlist in
 * force on every use. A failure is not cached; the next use tries again.
 */
export function dynamicOAuthClient(grant: DynamicOAuthGrant, options: DynamicClientOptions): OAuthClientSource {
  let resolved: OAuthClientConfig | undefined;
  let pending: Promise<OAuthClientConfig> | undefined;
  const allowlistNow = () => (options.allowlist === undefined ? oauthHosts() ?? null : options.allowlist);

  const resolve = async (): Promise<OAuthClientConfig> => {
    const discovered = await discoverAuthorization(grant.server, {
      provider: grant.provider,
      ...(options.allowPrivate ? { allowPrivate: true } : {}),
      ...(options.allowlist !== undefined ? { allowlist: options.allowlist } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    // The YAML's scopes are the operator's choice; with none, the server's 401 challenge names them (MCP scope selection).
    const scopes = grant.scopes.length ? grant.scopes : (discovered.challengeScopes ?? []);
    const key = registeredClientKey(grant.provider, discovered.resource, options.redirectUri);
    const kept = await options.registry?.get(key);
    const current =
      kept &&
      kept.issuer === discovered.issuer &&
      kept.authorizationEndpoint === discovered.authorizationEndpoint &&
      kept.tokenEndpoint === discovered.tokenEndpoint &&
      kept.redirectUri === options.redirectUri
        ? kept
        : undefined;
    let clientId: string;
    let clientSecret: string | undefined;
    if (current) {
      clientId = current.clientId;
      clientSecret = current.clientSecret;
    } else {
      const registered = await registerOAuthClient(discovered, {
        provider: grant.provider,
        redirectUri: options.redirectUri,
        scopes,
        ...(options.clientName ? { clientName: options.clientName } : {}),
        ...(options.allowPrivate ? { allowPrivate: true } : {}),
        ...(options.allowlist !== undefined ? { allowlist: options.allowlist } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
      await options.registry?.put(
        key,
        {
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          issuer: discovered.issuer,
          authorizationEndpoint: discovered.authorizationEndpoint,
          tokenEndpoint: discovered.tokenEndpoint,
          resource: discovered.resource,
          redirectUri: options.redirectUri,
        },
        registered.secretExpiresAt,
      );
    }
    return {
      authorizationUrl: discovered.authorizationEndpoint,
      tokenUrl: discovered.tokenEndpoint,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      scopes: [...scopes],
      ...(grant.authorizationParams ? { authorizationParams: { ...grant.authorizationParams } } : {}),
      resource: discovered.resource,
    };
  };

  return async () => {
    if (resolved) {
      // The allowlist can change after the client was found: checked on every use.
      for (const [role, url] of [['authorization_url', resolved.authorizationUrl], ['token_url', resolved.tokenUrl]] as const) {
        const refused = oauthHostProblem({ provider: grant.provider, grant: 'authorization_code' }, url, role, allowlistNow());
        if (refused) throw new OAuthDiscoveryError(grant.provider, refused);
      }
      return resolved;
    }
    if (!pending) {
      pending = resolve()
        .then((client) => (resolved = client))
        .finally(() => (pending = undefined));
    }
    return pending;
  };
}
