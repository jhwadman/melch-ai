/**
 * lib/tools/oauthTools.ts — `auth: { oauth2 }` from a syndicate YAML: an
 * OpenAPI entry or an MCP server whose calls carry an OAuth access token
 * (WS6-3c, ADR 0112).
 *
 * WHY this file exists:
 *   The credential store (ADR 0072) holds each user's tokens and the consent
 *   step (ADR 0085) puts them there, but nothing said which tools send which
 *   provider's token. The YAML says it, next to the tool it protects:
 *
 *     openapi:
 *       - spec: specs/tracker.yaml
 *         auth:
 *           oauth2:
 *             provider: tracker
 *             grant: authorization_code
 *             authorization_url: https://tracker.example.com/oauth/authorize
 *             token_url: https://tracker.example.com/oauth/token
 *             client_id_env: TRACKER_CLIENT_ID
 *             client_secret_env: TRACKER_CLIENT_SECRET
 *             scopes: [issues:read]
 *
 *   and `mcp_auth: { oauth2: { ... } }` beside an agent's `mcp_server_url`.
 *
 * THE TWO GRANTS:
 *   - authorization_code: the token is the run's own user's, read through
 *     `ctx.accessToken(provider)` at each call. A user who has not granted it
 *     is asked (the consent pause, when the run has a consent step whose
 *     clients include the provider: `oauthClientsFor` builds them from the
 *     same YAML, and `oauthRefreshProviders` the store's refresh hooks).
 *     The tool never chooses whose token.
 *   - client_credentials: the server's own token for the provider, from its
 *     token endpoint with the client id and secret, held in this process's
 *     memory until shortly before it expires, never in the credential store
 *     (no user owns it).
 *
 * SECRETS: the YAML names environment variables, never values; the variable
 *   names pass credentialEnvProblem (lib/tools/credentialEnv.ts), so a YAML
 *   cannot send a framework secret to a token endpoint. No token, client
 *   secret or provider error text reaches a result, an error, a log line or
 *   a span: a failure is reported by kind (ToolCredentialError).
 *
 * WHERE A TOKEN MAY GO: a token is sent only over https, or http to a
 *   loopback host (local development), to the server the YAML names, and
 *   only to a host the operator's allowlist binds to the provider
 *   (lib/tools/oauthHosts.ts, ADR 0114): with none configured, an
 *   authorization_code grant is refused. The allowlist is checked when a
 *   served syndicate loads (`syndicateOAuthHostProblems`), when the tools
 *   compile (the server, the token endpoint and the authorization
 *   endpoint), and again before each call sends a token
 *   (`oauthCallProblem`). The client-credentials token endpoint passes the
 *   same SSRF guard as the server it serves (ALLOW_PRIVATE_OPENAPI or
 *   ALLOW_PRIVATE_MCP), and no redirect from it is followed.
 *
 * WHERE A CLIENT SECRET MAY GO: to the token endpoint, and, when the
 *   operator configures a credential host allowlist
 *   (lib/tools/credentialHosts.ts, ADR 0122), only to a host it binds the
 *   `client_secret_env` variable to: checked at compile, when the consent
 *   clients are built, and before each client-credentials token request,
 *   code exchange (lib/tools/oauthConsent.ts) and refresh.
 */

import { blockedHostReason, checkHost } from '../net/addressGuard.ts';
import { PROVIDER_NAME, ToolCredentialError } from './auth.ts';
import type { OAuthProvider, TokenSet } from './auth.ts';
import { readCredentialEnv } from './credentialEnv.ts';
import { CLIENT_SECRET_ENV, clientSecretEnvOf, credentialCallProblem, credentialHostProblem } from './credentialHosts.ts';
import { oauthHostProblem, oauthHosts } from './oauthHosts.ts';
import type { OAuthHostAllowlist } from './oauthHosts.ts';
import type { OAuthClientConfig, OAuthClientSource } from './oauthConsent.ts';
import type { DynamicOAuthGrant } from './oauthDiscovery.ts';
import type { ToolContext } from './tool.ts';

/** The `oauth2` block of an `auth` (OpenAPI) or an `mcp_auth` (MCP). */
export interface OAuth2AuthConfig {
  /** The credential store's name for the provider (lowercase). */
  provider: string;
  grant: 'authorization_code' | 'client_credentials';
  /** The provider's authorization endpoint (authorization_code only). */
  authorization_url?: string;
  /** The provider's token endpoint. Absent only with `client_registration: 'dynamic'`, which discovers it. */
  token_url?: string;
  /**
   * `'dynamic'` (MCP servers, authorization_code only, ADR 0124): no
   * pre-issued client. The authorization server is discovered from the MCP
   * server and the deployment registers itself (lib/tools/oauthDiscovery.ts).
   */
  client_registration?: 'dynamic';
  /** The client id, written out (it is not a secret) … */
  client_id?: string;
  /** … or the environment variable holding it. */
  client_id_env?: string;
  /** The environment variable holding the client secret. Required for client_credentials. */
  client_secret_env?: string;
  scopes?: string[];
  /** Extra authorization parameters (authorization_code only), e.g. `access_type: offline`. */
  authorization_params?: Record<string, string>;
}

/** An agent's `mcp_auth:` beside its `mcp_server_url`. */
export interface McpAuthConfig {
  oauth2: OAuth2AuthConfig;
}

/** Where a declared grant sits: for the doctor, and for the error messages. */
export interface OAuthGrantUse {
  /** The agent that holds the tools. */
  agent: string;
  /** `openapi <spec>` or `mcp <url>`. */
  tools: string;
  oauth2: OAuth2AuthConfig;
}

/** An agent's declared OAuth grants, OpenAPI entries first, then its MCP server, then each of its `mcp_servers` (ADR 0124). */
export function agentOAuthGrants(agent: {
  name?: string;
  openapi?: Array<{ spec?: string; auth?: { oauth2?: OAuth2AuthConfig } }>;
  mcp_server_url?: string;
  mcp_auth?: { oauth2?: OAuth2AuthConfig };
  mcp_servers?: Array<{ url?: string; auth?: { oauth2?: OAuth2AuthConfig } }>;
}, prefix = ''): OAuthGrantUse[] {
  const name = `${prefix}${agent.name ?? ''}`;
  const out: OAuthGrantUse[] = [];
  for (const entry of agent.openapi ?? []) {
    if (entry?.auth?.oauth2) out.push({ agent: name, tools: `openapi ${entry.spec ?? ''}`, oauth2: entry.auth.oauth2 });
  }
  if (agent.mcp_auth?.oauth2) out.push({ agent: name, tools: `mcp ${agent.mcp_server_url ?? ''}`, oauth2: agent.mcp_auth.oauth2 });
  for (const server of agent.mcp_servers ?? []) {
    if (server?.auth?.oauth2) out.push({ agent: name, tools: `mcp ${server.url ?? ''}`, oauth2: server.auth.oauth2 });
  }
  return out;
}

/** The environment variables a grant reads, by role. */
export function oauthEnvNames(oauth2: OAuth2AuthConfig): string[] {
  return [oauth2.client_id_env, oauth2.client_secret_env].filter((e): e is string => typeof e === 'string' && e !== '');
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Why a token may not be sent to `raw`, or null: https, or http to a loopback host. */
export function tokenTransportProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `'${raw.slice(0, 200)}' is not a URL`;
  }
  if (url.username || url.password) return `${url.hostname} must not carry credentials in its URL`;
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
  return `an OAuth token is sent only over https (http only to a loopback host), not to ${url.protocol}//${url.hostname}`;
}

// ── The operator's host allowlist (ADR 0114) ─────────────────────────────────

/**
 * Why this grant may not be declared for these servers, one line per
 * refusal: each server the tools call, the token endpoint and the
 * authorization endpoint must be hosts the operator's allowlist binds to the
 * provider (lib/tools/oauthHosts.ts). With no allowlist, an
 * authorization_code grant is refused and a client_credentials one allowed.
 * `allowlist` defaults to the one in force; `null` means none is configured.
 */
export function oauthGrantHostProblems(oauth2: OAuth2AuthConfig, servers: readonly string[], allowlist?: OAuthHostAllowlist | null): string[] {
  const list = allowlist === undefined ? oauthHosts() ?? null : allowlist;
  const urls: Array<[string, string]> = servers.map((s): [string, string] => ['server', s]);
  // A dynamic grant names no endpoint: discovery checks each one it finds (lib/tools/oauthDiscovery.ts).
  if (oauth2.token_url) urls.push(['token_url', oauth2.token_url]);
  if (oauth2.authorization_url) urls.push(['authorization_url', oauth2.authorization_url]);
  const out = new Set<string>();
  for (const [role, url] of urls) {
    const problem = oauthHostProblem(oauth2, url, role, list);
    if (problem) out.add(problem);
  }
  return [...out];
}

/**
 * Why a call may not send this grant's token (or secret) to `destination`
 * now, or null: the transport rule and the allowlist in force, checked again
 * at each call. The compile checked the same; this holds if a request is
 * aimed elsewhere, or the allowlist changed. A malformed allowlist refuses.
 */
export function oauthCallProblem(oauth2: Pick<OAuth2AuthConfig, 'provider' | 'grant'>, destination: string): string | null {
  const transport = tokenTransportProblem(destination);
  if (transport) return transport;
  try {
    return oauthHostProblem(oauth2, destination, 'server', oauthHosts() ?? null);
  } catch {
    return 'the OAuth host allowlist is malformed';
  }
}

// ── client_credentials ───────────────────────────────────────────────────────

export interface ClientCredentialsOptions {
  provider: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  /** Private and loopback token endpoints are allowed (ALLOW_PRIVATE_OPENAPI / ALLOW_PRIVATE_MCP). */
  allowPrivate?: boolean;
  /** A token this close to its expiry is fetched again. Default 60 s. */
  refreshSkewMs?: number;
  /** The token request's time limit, ms. Default 10 s. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/** A token response, read whole up to a bound, as a JSON object; undefined otherwise. */
async function readTokenJson(res: Response): Promise<Record<string, unknown> | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_TOKEN_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Why the server may not call this token endpoint, or null (the full guard, with DNS). */
async function tokenEndpointProblem(raw: string, allowPrivate: boolean): Promise<string | null> {
  const transport = tokenTransportProblem(raw);
  if (transport) return transport;
  if (allowPrivate) return null;
  const reason = await checkHost(new URL(raw).hostname);
  return reason ? `refusing token endpoint ${new URL(raw).hostname}: ${reason}` : null;
}

/**
 * One token-endpoint request (RFC 6749 4.4, 6): the endpoint checked by the
 * guard first, no redirect followed, a time limit, a bounded response. Any
 * failure is ToolCredentialError('grant_failed'), never the provider's text,
 * which may echo what it refused.
 */
async function tokenRequest(
  tokenUrl: string,
  body: URLSearchParams,
  provider: string,
  options: { allowPrivate: boolean; doFetch: typeof fetch; timeoutMs: number; now: () => number; signal?: AbortSignal },
): Promise<TokenSet> {
  if (await tokenEndpointProblem(tokenUrl, options.allowPrivate)) throw new ToolCredentialError('grant_failed', provider);
  let json: Record<string, unknown> | undefined;
  try {
    const res = await options.doFetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      // A redirect would carry the client secret (or the refresh token) to wherever it points.
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs),
    });
    json = await readTokenJson(res);
    if (!res.ok) json = undefined;
  } catch {
    json = undefined;
  }
  const accessToken = json?.access_token;
  const tokenType = json?.token_type;
  if (typeof accessToken !== 'string' || !accessToken) throw new ToolCredentialError('grant_failed', provider);
  if (tokenType !== undefined && (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer')) throw new ToolCredentialError('grant_failed', provider);
  const refreshToken = typeof json?.refresh_token === 'string' && json.refresh_token ? json.refresh_token : undefined;
  const expiresIn = typeof json?.expires_in === 'number' ? json.expires_in : typeof json?.expires_in === 'string' ? Number(json.expires_in) : undefined;
  const scopes = typeof json?.scope === 'string' ? json.scope.split(' ').filter((x) => x !== '') : undefined;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: new Date(options.now() + expiresIn * 1000) } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

/**
 * The server's own token for a provider (RFC 6749 4.4), fetched when first
 * needed and again shortly before it expires, one request at a time. A
 * failure throws ToolCredentialError('grant_failed'), never the provider's
 * text, which may echo what it refused.
 */
export function clientCredentialsGrant(options: ClientCredentialsOptions): { token(signal?: AbortSignal): Promise<string> } {
  const now = options.now ?? Date.now;
  const skew = options.refreshSkewMs ?? 60_000;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let held: { accessToken: string; expiresAt?: number } | undefined;
  let pending: Promise<string> | undefined;

  const request = async (signal?: AbortSignal): Promise<string> => {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: options.clientId, client_secret: options.clientSecret });
    if (options.scopes?.length) body.set('scope', options.scopes.join(' '));
    const issued = await tokenRequest(options.tokenUrl, body, options.provider, { allowPrivate: options.allowPrivate === true, doFetch, timeoutMs, now, ...(signal ? { signal } : {}) });
    held = { accessToken: issued.accessToken, ...(issued.expiresAt ? { expiresAt: issued.expiresAt.getTime() } : {}) };
    return issued.accessToken;
  };

  return {
    async token(signal) {
      if (held && (held.expiresAt === undefined || held.expiresAt - skew > now())) return held.accessToken;
      if (!pending) pending = request(signal).finally(() => (pending = undefined));
      return pending;
    },
  };
}

// ── The token a call sends ───────────────────────────────────────────────────

/**
 * What a tool calls for the token of one call, naming where that call goes.
 * Throws ToolCredentialError, whose message names no value: `host_refused`
 * when the destination is not one of the provider's hosts.
 */
export type OAuthTokenSource = (ctx: ToolContext | undefined, destination: string) => Promise<string>;

/**
 * The token source a declared `oauth2` block gives its tools. Reads the
 * client-credentials variables now, so a variable that is not set (or that
 * the allowlist refuses) fails the compile, naming the variable only, and
 * so does a host the operator's OAuth host allowlist does not bind to the
 * provider (ADR 0114). `where` prefixes those messages; `server` is the URL
 * (or URLs) the token is sent to.
 */
export function oauthTokenSource(oauth2: OAuth2AuthConfig, where: string, server: string | readonly string[], options: { allowPrivate?: boolean; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): OAuthTokenSource {
  const servers = typeof server === 'string' ? [server] : [...server];
  for (const s of servers) {
    const problem = tokenTransportProblem(s);
    if (problem) throw new Error(`${where}: ${problem}`);
  }
  if (!PROVIDER_NAME.test(oauth2.provider)) throw new Error(`${where}: provider must match ${PROVIDER_NAME}`);
  const hostProblems = oauthGrantHostProblems(oauth2, servers);
  if (hostProblems.length) throw new Error(`${where}: ${hostProblems.join('; ')}`);
  const provider = oauth2.provider;
  /** The call-time check (ADR 0114): before any token is read or fetched. */
  const refuse = (destination: string) => {
    if (oauthCallProblem(oauth2, destination)) throw new ToolCredentialError('host_refused', provider);
  };
  if (oauth2.grant === 'authorization_code') {
    return async (ctx, destination) => {
      refuse(destination);
      if (!ctx?.accessToken) throw new ToolCredentialError('unavailable', provider);
      return ctx.accessToken(provider);
    };
  }
  const env = options.env ?? process.env;
  if (!oauth2.client_secret_env) throw new Error(`${where}: a client_credentials grant needs client_secret_env`);
  const tokenUrl = oauth2.token_url;
  if (!tokenUrl) throw new Error(`${where}: a client_credentials grant needs token_url`);
  const transport = tokenTransportProblem(tokenUrl);
  if (transport) throw new Error(`${where}: token_url: ${transport}`);
  if (options.allowPrivate !== true) {
    const blocked = blockedHostReason(new URL(tokenUrl).hostname);
    if (blocked) throw new Error(`${where}: refusing token endpoint ${new URL(tokenUrl).hostname}: ${blocked}`);
  }
  // The client secret goes only to a host the operator binds its variable to (ADR 0122).
  const secretEnv = oauth2.client_secret_env;
  const unbound = credentialHostProblem(secretEnv, tokenUrl, 'token_url');
  if (unbound) throw new Error(`${where}: ${unbound}`);
  const grant = clientCredentialsGrant({
    provider,
    tokenUrl,
    clientId: oauth2.client_id ?? readCredentialEnv(oauth2.client_id_env ?? '', where, env),
    clientSecret: readCredentialEnv(oauth2.client_secret_env, where, env),
    ...(oauth2.scopes?.length ? { scopes: [...oauth2.scopes] } : {}),
    ...(options.allowPrivate ? { allowPrivate: true } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return async (ctx, destination) => {
    refuse(destination);
    // The client secret goes to the token endpoint: held to the same rule,
    // and to the credential host allowlist (ADR 0122).
    refuse(tokenUrl);
    if (credentialCallProblem(secretEnv, tokenUrl)) throw new ToolCredentialError('host_refused', provider);
    return grant.token(ctx?.signal);
  };
}

// ── The consent step's clients ───────────────────────────────────────────────

/** The parts of a syndicate config `oauthClientsFor` reads. */
interface AgentLike {
  name?: string;
  openapi?: Array<{ spec?: string; auth?: { oauth2?: OAuth2AuthConfig } }>;
  mcp_server_url?: string;
  mcp_auth?: { oauth2?: OAuth2AuthConfig };
  mcp_servers?: Array<{ url?: string; auth?: { oauth2?: OAuth2AuthConfig } }>;
  yaml_reference?: string;
}
interface SyndicateLike {
  orchestrator?: AgentLike;
  subagents?: AgentLike[];
}

/** The options oauthClientsFor and dynamicOAuthGrantsFor share. */
interface ClientsForOptions {
  env?: NodeJS.ProcessEnv;
  load?: (ref: string) => SyndicateLike;
  allowlist?: OAuthHostAllowlist | null;
}

/** Every declared authorization-code grant, by provider: configured clients and dynamic grants, one grant per provider. */
function collectOAuthClients(configs: readonly SyndicateLike[], options: ClientsForOptions): { clients: Record<string, OAuthClientConfig>; dynamic: Record<string, DynamicOAuthGrant> } {
  const env = options.env ?? process.env;
  const allowlist = options.allowlist === undefined ? oauthHosts(env) ?? null : options.allowlist;
  const clients: Record<string, OAuthClientConfig> = {};
  const dynamic: Record<string, DynamicOAuthGrant> = {};
  const signature = new Map<string, string>();
  for (const use of syndicateOAuthGrants(configs, options.load)) {
    const o = use.oauth2;
    if (o.grant !== 'authorization_code') continue;
    const where = `${use.agent} · ${use.tools} · oauth2`;
    if (o.client_registration === 'dynamic') {
      // Discovered and registered when first needed (ADR 0124): the MCP server is all the YAML names.
      const server = use.tools.startsWith('mcp ') && use.tools.length > 4 ? use.tools.slice(4) : '';
      if (!server) throw new Error(`${where}: client_registration: dynamic is for an MCP server's grant`);
      const hostProblems = oauthGrantHostProblems(o, [server], allowlist);
      if (hostProblems.length) throw new Error(`${where}: ${hostProblems.join('; ')}`);
      const sig = JSON.stringify(['dynamic', server, [...(o.scopes ?? [])].sort(), o.authorization_params ?? {}]);
      const before = signature.get(o.provider);
      if (before !== undefined) {
        if (before !== sig) throw new Error(`${where}: provider "${o.provider}" is declared twice with different endpoints, client or scopes`);
        continue;
      }
      signature.set(o.provider, sig);
      dynamic[o.provider] = { provider: o.provider, server, scopes: [...(o.scopes ?? [])], ...(o.authorization_params ? { authorizationParams: { ...o.authorization_params } } : {}) };
      continue;
    }
    if (!o.authorization_url) throw new Error(`${where}: an authorization_code grant needs authorization_url`);
    if (!o.token_url) throw new Error(`${where}: an authorization_code grant needs token_url`);
    // The consent step sends the client secret, the code and later the refresh token to these endpoints (ADR 0114).
    const hostProblems = oauthGrantHostProblems(o, [], allowlist);
    if (hostProblems.length) throw new Error(`${where}: ${hostProblems.join('; ')}`);
    // The client secret goes to the token endpoint: a host the operator binds its variable to (ADR 0122).
    const secretProblem = o.client_secret_env ? credentialHostProblem(o.client_secret_env, o.token_url, 'token_url') : null;
    if (secretProblem) throw new Error(`${where}: ${secretProblem}`);
    const sig = JSON.stringify([o.authorization_url, o.token_url, o.client_id ?? null, o.client_id_env ?? null, o.client_secret_env ?? null, [...(o.scopes ?? [])].sort(), o.authorization_params ?? {}]);
    const before = signature.get(o.provider);
    if (before !== undefined) {
      if (before !== sig) throw new Error(`${where}: provider "${o.provider}" is declared twice with different endpoints, client or scopes`);
      continue;
    }
    signature.set(o.provider, sig);
    clients[o.provider] = {
      authorizationUrl: o.authorization_url,
      tokenUrl: o.token_url,
      clientId: o.client_id ?? readCredentialEnv(o.client_id_env ?? '', where, env),
      ...(o.client_secret_env ? { clientSecret: readCredentialEnv(o.client_secret_env, where, env) } : {}),
      scopes: [...(o.scopes ?? [])],
      ...(o.authorization_params ? { authorizationParams: { ...o.authorization_params } } : {}),
      // The variable the secret came from, so the exchange and the refresh check its host at call time.
      ...(o.client_secret_env ? { [CLIENT_SECRET_ENV]: o.client_secret_env } : {}),
    };
  }
  return { clients, dynamic };
}

/**
 * The OAuth clients the consent step needs for these syndicates' declared
 * authorization-code grants, by provider: pass them as
 * `oauthConsent({ providers })` (lib/tools/oauthConsent.ts). Client ids and
 * secrets are read from the variables the YAML names. Two declarations of
 * one provider must agree on its endpoints, client and scopes, or this
 * throws: a provider's grant is one grant, whichever tool asks for it.
 * `load` reads a nested `yaml_reference:` file, when given. A grant with
 * `client_registration: dynamic` has no client until it is registered: it
 * is in `dynamicOAuthGrantsFor`, not here.
 */
export function oauthClientsFor(configs: readonly SyndicateLike[], options: ClientsForOptions = {}): Record<string, OAuthClientConfig> {
  return collectOAuthClients(configs, options).clients;
}

/**
 * The dynamic grants these syndicates declare (`client_registration:
 * dynamic`, ADR 0124), by provider, checked as oauthClientsFor checks the
 * others (one grant per provider, the MCP server on the allowlist): each
 * becomes a consent client through `dynamicOAuthClient`
 * (lib/tools/oauthDiscovery.ts).
 */
export function dynamicOAuthGrantsFor(configs: readonly SyndicateLike[], options: ClientsForOptions = {}): Record<string, DynamicOAuthGrant> {
  return collectOAuthClients(configs, options).dynamic;
}

/**
 * Every OAuth grant these syndicates declare, orchestrators and subagents,
 * following a nested `yaml_reference:` through `load` when given (once per
 * file; agent names then read "Parent › Child").
 */
export function syndicateOAuthGrants(configs: readonly SyndicateLike[], load?: (ref: string) => SyndicateLike): OAuthGrantUse[] {
  const out: OAuthGrantUse[] = [];
  const seen = new Set<string>();
  const visit = (config: SyndicateLike, prefix: string) => {
    const agents = [config.orchestrator, ...(config.subagents ?? [])].filter((a): a is AgentLike => !!a);
    for (const agent of agents) {
      if (agent.yaml_reference) {
        if (!load || seen.has(agent.yaml_reference)) continue;
        seen.add(agent.yaml_reference);
        visit(load(agent.yaml_reference), `${prefix}${agent.name ?? agent.yaml_reference} › `);
        continue;
      }
      out.push(...agentOAuthGrants(agent, prefix));
    }
  };
  for (const config of configs) visit(config, '');
  return out;
}

/**
 * Why these syndicates may not be served here, one line per refusal
 * (ADR 0114): each declared grant's MCP server, token endpoint and
 * authorization endpoint against the operator's OAuth host allowlist (an
 * OpenAPI entry's servers are in its spec, so its compile checks those).
 * The A2A server checks every syndicate it loads to serve; the compile
 * checks again, and each call once more.
 */
export function syndicateOAuthHostProblems(configs: readonly SyndicateLike[], options: { load?: (ref: string) => SyndicateLike; allowlist?: OAuthHostAllowlist | null } = {}): string[] {
  const allowlist = options.allowlist === undefined ? oauthHosts() ?? null : options.allowlist;
  const out: string[] = [];
  for (const use of syndicateOAuthGrants(configs, options.load)) {
    const servers = use.tools.startsWith('mcp ') && use.tools.length > 4 ? [use.tools.slice(4)] : [];
    for (const problem of oauthGrantHostProblems(use.oauth2, servers, allowlist)) out.push(`${use.agent} · ${use.tools} · oauth2: ${problem}`);
  }
  return out;
}

/**
 * The credential store's refresh hooks for the same providers
 * (`credentialStore({ providers })`, lib/tools/credentialStore.ts): an
 * expired user token is renewed at the provider's token endpoint with its
 * refresh token (RFC 6749 6) instead of asking the person again. Built from
 * `oauthClientsFor`'s clients, and from `dynamicOAuthClient`'s sources (a
 * discovered client, ADR 0124); `allowPrivate` lets a private or loopback
 * token endpoint through the guard (development).
 */
export function oauthRefreshProviders(
  clients: Record<string, OAuthClientConfig | OAuthClientSource>,
  options: { allowPrivate?: boolean; fetch?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Record<string, OAuthProvider> {
  const providers: Record<string, OAuthProvider> = {};
  for (const [name, entry] of Object.entries(clients)) {
    providers[name] = {
      refresh: async (refreshToken, context) => {
        let client: OAuthClientConfig;
        try {
          client = typeof entry === 'function' ? await entry() : entry;
        } catch {
          throw new ToolCredentialError('refresh_failed', name);
        }
        // A refresh token goes only to a token endpoint the allowlist binds to its provider (ADR 0114).
        if (oauthCallProblem({ provider: name, grant: 'authorization_code' }, client.tokenUrl)) throw new ToolCredentialError('host_refused', name);
        // The client secret too: only to a host the operator binds its variable to (ADR 0122).
        const secretEnv = clientSecretEnvOf(client);
        if (client.clientSecret && secretEnv && credentialCallProblem(secretEnv, client.tokenUrl)) throw new ToolCredentialError('host_refused', name);
        const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId });
        if (client.clientSecret) body.set('client_secret', client.clientSecret);
        if (client.resource) body.set('resource', client.resource);
        return tokenRequest(client.tokenUrl, body, name, {
          allowPrivate: options.allowPrivate === true,
          doFetch: options.fetch ?? fetch,
          timeoutMs: options.timeoutMs ?? 10_000,
          now: options.now ?? Date.now,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      },
    };
  }
  return providers;
}
