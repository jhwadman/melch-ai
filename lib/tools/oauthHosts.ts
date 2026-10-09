/**
 * lib/tools/oauthHosts.ts — the operator's OAuth host allowlist: which hosts
 * each provider's tokens may be sent to (WS6-3d, ADR 0114).
 *
 * WHY this file exists:
 *   A YAML declares an OAuth grant beside the tool it protects (ADR 0112) and
 *   chooses the host that tool calls. The credential store keys a user's
 *   grant by app (the memory namespace), user and provider, so two syndicates
 *   in one namespace share their users' grants. Without a binding, a
 *   registry-stored YAML could name a provider another syndicate's users
 *   granted and point a tool at a host of its own, and receive their tokens.
 *   The binding is the operator's, never the YAML's: an environment variable
 *   or `createA2AApp({ oauthHosts })`.
 *
 * THE RULE (ADR 0114):
 *   - With no allowlist configured, an authorization_code grant (a user's
 *     token) is refused; a client_credentials grant (the server's own token,
 *     from a secret the operator supplies) is allowed, as `bearer_env` is.
 *   - With an allowlist configured, it is the whole list: every grant's
 *     provider must be on it, and every host its tokens or its client secret
 *     go to (the API or MCP server, the token endpoint, the authorization
 *     endpoint) must be one of that provider's hosts.
 *   - The check runs when a syndicate is loaded to be served, when its tools
 *     are compiled, and again before each call sends a token.
 *
 * THE FORMAT: `MELCHIZEDEK_OAUTH_HOSTS="tracker=api.tracker.example.com,auth.tracker.example.com;github=api.github.com,github.com"`.
 *   Entries are separated by `;` (or a newline), a provider from its hosts by
 *   `=`, hosts by `,`. A host is a hostname, `*.example.com` (any subdomain,
 *   not the apex), an IPv4 address, or a bracketed IPv6 address. Ports and
 *   schemes are not part of a host: the transport rule (https, or http to a
 *   loopback host) is checked separately (tokenTransportProblem).
 *
 * Nothing here reads or prints a secret: hosts and provider names only. No
 * regular expression here can backtrack: labels are split, then each is
 * matched by one bounded character class.
 */

import { PROVIDER_NAME } from './auth.ts';

/** The environment variable the allowlist is read from when no option sets it. */
export const OAUTH_HOSTS_ENV = 'MELCHIZEDEK_OAUTH_HOSTS';

/** Provider name → the hosts its tokens may be sent to. */
export type OAuthHostAllowlist = Readonly<Record<string, readonly string[]>>;

const LABEL = /^[a-z0-9-]{1,63}$/;
const IPV6 = /^\[[0-9a-f:.]{2,45}\]$/;

/** Why `pattern` is not a host an allowlist can hold, or null (lowercased, trimmed). Also lib/tools/credentialHosts.ts. */
export function hostPatternProblem(pattern: string): string | null {
  if (pattern.length > 253) return 'is longer than 253 characters';
  if (IPV6.test(pattern)) return null;
  const name = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
  const labels = name.split('.');
  if (labels.length < 1 || labels.some((l) => !LABEL.test(l) || l.startsWith('-') || l.endsWith('-'))) {
    return 'is not a hostname, *.domain, IPv4 or [IPv6] address (no scheme, port or path)';
  }
  if (pattern.startsWith('*.') && labels.length < 2) return 'is a wildcard over a top-level domain';
  return null;
}

/**
 * The allowlist, checked and normalized (hosts lowercased, duplicates
 * dropped). Throws, naming the provider and the host, on anything malformed.
 */
export function checkOAuthHosts(allowlist: Record<string, readonly string[]>, source = 'oauthHosts'): Record<string, string[]> {
  if (!allowlist || typeof allowlist !== 'object' || Array.isArray(allowlist)) throw new Error(`${source} must map each provider to its hosts.`);
  const out: Record<string, string[]> = {};
  for (const [provider, hosts] of Object.entries(allowlist)) {
    if (!PROVIDER_NAME.test(provider)) throw new Error(`${source}: provider "${provider.slice(0, 64)}" must match ${PROVIDER_NAME}.`);
    if (!Array.isArray(hosts) || hosts.length === 0) throw new Error(`${source}: provider "${provider}" needs at least one host.`);
    const seen = new Set<string>();
    for (const raw of hosts) {
      const host = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      const problem = host ? hostPatternProblem(host) : 'is empty';
      if (problem) throw new Error(`${source}: provider "${provider}": host "${String(raw).slice(0, 80)}" ${problem}.`);
      seen.add(host);
    }
    out[provider] = [...seen];
  }
  return out;
}

/** The allowlist from its text form (MELCHIZEDEK_OAUTH_HOSTS). Throws on a malformed entry. */
export function parseOAuthHosts(text: string): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};
  for (const entry of text.split(/[;\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`${OAUTH_HOSTS_ENV}: each entry is provider=host,host (got "${trimmed.slice(0, 80)}").`);
    const provider = trimmed.slice(0, eq).trim();
    if (Object.hasOwn(parsed, provider)) throw new Error(`${OAUTH_HOSTS_ENV}: provider "${provider.slice(0, 64)}" is listed twice.`);
    parsed[provider] = trimmed.slice(eq + 1).split(',').map((h) => h.trim()).filter((h) => h !== '');
  }
  return checkOAuthHosts(parsed, OAUTH_HOSTS_ENV);
}

let configured: Record<string, string[]> | undefined;
let envCache: { raw: string; value: Record<string, string[]> } | undefined;

/**
 * Sets this process's allowlist (createA2AApp's `oauthHosts` does), which
 * wins over the environment variable. `undefined` returns to the variable.
 */
export function setOAuthHosts(allowlist: Record<string, readonly string[]> | undefined): void {
  configured = allowlist === undefined ? undefined : checkOAuthHosts(allowlist);
}

/**
 * The allowlist in force: the one set by `setOAuthHosts`, else the
 * environment variable's, else undefined (not configured). A malformed
 * variable throws, so the first check refuses rather than allowing.
 */
export function oauthHosts(env: NodeJS.ProcessEnv = process.env): OAuthHostAllowlist | undefined {
  if (configured) return configured;
  const raw = env[OAUTH_HOSTS_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  if (envCache?.raw !== raw) envCache = { raw, value: parseOAuthHosts(raw) };
  return envCache.value;
}

/** True when `hostname` (as URL.hostname gives it) matches one of `patterns`. */
export function hostAllowed(patterns: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((p) => (p.startsWith('*.') ? host.length > p.length - 1 && host.endsWith(p.slice(1)) : host === p));
}

/** The grant fields the rule reads. */
export interface OAuthGrantRef {
  provider: string;
  grant: 'authorization_code' | 'client_credentials';
}

/**
 * Why a token (or client secret) of this grant may not be sent to `url`,
 * or null. `role` names the URL in the message (`server`, `token_url`, …).
 * `allowlist` defaults to the one in force; pass `null` for "not configured".
 */
export function oauthHostProblem(grant: OAuthGrantRef, url: string, role = 'server', allowlist: OAuthHostAllowlist | null | undefined = oauthHosts()): string | null {
  const list = allowlist ?? undefined;
  if (!list) {
    if (grant.grant === 'client_credentials') return null;
    return `provider "${grant.provider}": an authorization_code grant sends each user's own token, so the operator binds the provider to its hosts first (${OAUTH_HOSTS_ENV}="${grant.provider}=api.example.com,…", or createA2AApp's oauthHosts)`;
  }
  if (!Object.hasOwn(list, grant.provider)) {
    return `provider "${grant.provider}" is not on the operator's OAuth host allowlist (${OAUTH_HOSTS_ENV} or createA2AApp's oauthHosts)`;
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return `${role} '${url.slice(0, 200)}' is not a URL`;
  }
  const hosts = list[grant.provider]!;
  if (hostAllowed(hosts, hostname)) return null;
  return `provider "${grant.provider}" may send its tokens only to ${hosts.join(', ')}; ${hostname} (${role}) is not one of them`;
}
