/**
 * lib/tools/credentialHosts.ts — the operator's credential host allowlist:
 * which hosts the value of each static credential variable may be sent to
 * (ADR 0122).
 *
 * WHY this file exists:
 *   A syndicate YAML (possibly registry-stored) names a credential variable
 *   and, beside it, the host its value goes to: an OpenAPI `auth` sends
 *   `bearer_env` or `api_key.env` to the spec's server (or `base_url`), and
 *   an `oauth2` block sends `client_secret_env` to its `token_url`.
 *   credentialEnvProblem (lib/tools/credentialEnv.ts) keeps the framework's
 *   own secrets out of reach, and the OAuth host allowlist (ADR 0114) binds
 *   a provider's tokens, but nothing bound a static secret to its API: a
 *   YAML that names TRACKER_TOKEN could aim it at a host of its own. The
 *   binding is the operator's, never the YAML's: an environment variable or
 *   `createA2AApp({ credentialHosts })`.
 *
 * THE RULE (ADR 0122):
 *   - With no allowlist configured, nothing changes: a credential goes to
 *     the host the YAML names, as before. The doctor and the server binary
 *     name every credential variable a served YAML sends, as unbound.
 *   - With an allowlist configured, it is the whole list: every credential
 *     variable a YAML sends must be on it, and every host its value goes to
 *     must be one of that variable's hosts.
 *   - The check runs when a syndicate is loaded to be served, when its tools
 *     are compiled, and again before each call sends the value.
 *
 * WHAT IT COVERS: `bearer_env`, `api_key.env` and `client_secret_env` (both
 *   grants: the client-credentials token request, the consent step's code
 *   exchange and its refresh). Not `client_id_env`: a client id is not a
 *   secret. Not MCP_BEARER_TOKENS: it maps each token to its host already,
 *   and the operator writes both.
 *
 * THE FORMAT: `MELCHIZEDEK_CREDENTIAL_HOSTS="TRACKER_TOKEN=api.tracker.example.com;WEATHER_KEY=api.weather.example.com,*.weather.example.com"`.
 *   Entries are separated by `;` (or a newline), a variable from its hosts by
 *   `=`, hosts by `,`. A host is what the OAuth host allowlist takes
 *   (lib/tools/oauthHosts.ts): a hostname, `*.example.com`, IPv4 or
 *   `[IPv6]`, with no scheme, port or path.
 *
 * Nothing here reads or prints a credential's value: variable names and
 * hosts only. No regular expression here can backtrack: the separators are
 * single characters, and a variable name is one bounded character class.
 */

import { hostAllowed, hostPatternProblem } from './oauthHosts.ts';

/** The environment variable the allowlist is read from when no option sets it. */
export const CREDENTIAL_HOSTS_ENV = 'MELCHIZEDEK_CREDENTIAL_HOSTS';

/** Credential variable name → the hosts its value may be sent to. */
export type CredentialHostAllowlist = Readonly<Record<string, readonly string[]>>;

/** A credential variable's name, as a YAML may write it (lib/syndicateSchema.ts), bounded. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

/**
 * The allowlist, checked and normalized (hosts lowercased, duplicates
 * dropped). Throws, naming the variable and the host, on anything malformed.
 */
export function checkCredentialHosts(allowlist: Record<string, readonly string[]>, source = 'credentialHosts'): Record<string, string[]> {
  if (!allowlist || typeof allowlist !== 'object' || Array.isArray(allowlist)) throw new Error(`${source} must map each credential variable to its hosts.`);
  const out: Record<string, string[]> = {};
  for (const [name, hosts] of Object.entries(allowlist)) {
    if (!ENV_NAME.test(name)) throw new Error(`${source}: "${name.slice(0, 64)}" is not an environment variable name (A–Z, 0–9, _).`);
    if (!Array.isArray(hosts) || hosts.length === 0) throw new Error(`${source}: ${name} needs at least one host.`);
    const seen = new Set<string>();
    for (const raw of hosts) {
      const host = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      const problem = host ? hostPatternProblem(host) : 'is empty';
      if (problem) throw new Error(`${source}: ${name}: host "${String(raw).slice(0, 80)}" ${problem}.`);
      seen.add(host);
    }
    out[name] = [...seen];
  }
  return out;
}

/** The allowlist from its text form (MELCHIZEDEK_CREDENTIAL_HOSTS). Throws on a malformed entry. */
export function parseCredentialHosts(text: string): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};
  for (const entry of text.split(/[;\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`${CREDENTIAL_HOSTS_ENV}: each entry is VARIABLE=host,host (got "${trimmed.slice(0, 80)}").`);
    const name = trimmed.slice(0, eq).trim();
    if (Object.hasOwn(parsed, name)) throw new Error(`${CREDENTIAL_HOSTS_ENV}: ${name.slice(0, 64)} is listed twice.`);
    parsed[name] = trimmed.slice(eq + 1).split(',').map((h) => h.trim()).filter((h) => h !== '');
  }
  return checkCredentialHosts(parsed, CREDENTIAL_HOSTS_ENV);
}

let configured: Record<string, string[]> | undefined;
let envCache: { raw: string; value: Record<string, string[]> } | undefined;

/**
 * Sets this process's allowlist (createA2AApp's `credentialHosts` does),
 * which wins over the environment variable. `undefined` returns to the
 * variable.
 */
export function setCredentialHosts(allowlist: Record<string, readonly string[]> | undefined): void {
  configured = allowlist === undefined ? undefined : checkCredentialHosts(allowlist);
}

/**
 * The allowlist in force: the one set by `setCredentialHosts`, else the
 * environment variable's, else undefined (not configured). A malformed
 * variable throws, so the first check refuses rather than allowing.
 */
export function credentialHosts(env: NodeJS.ProcessEnv = process.env): CredentialHostAllowlist | undefined {
  if (configured) return configured;
  const raw = env[CREDENTIAL_HOSTS_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  if (envCache?.raw !== raw) envCache = { raw, value: parseCredentialHosts(raw) };
  return envCache.value;
}

/**
 * Why the value of credential variable `name` may not be sent to `url`, or
 * null. `role` names the URL in the message (`server`, `token_url`).
 * `allowlist` defaults to the one in force; `null` means none is
 * configured, which allows (the behaviour before ADR 0122).
 */
export function credentialHostProblem(name: string, url: string, role = 'server', allowlist: CredentialHostAllowlist | null | undefined = credentialHosts()): string | null {
  const list = allowlist ?? undefined;
  if (!list) return null;
  if (!Object.hasOwn(list, name)) {
    return `${name} is not on the operator's credential host allowlist (${CREDENTIAL_HOSTS_ENV} or createA2AApp's credentialHosts), so it is sent nowhere`;
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return `${role} '${url.slice(0, 200)}' is not a URL`;
  }
  const hosts = list[name]!;
  if (hostAllowed(hosts, hostname)) return null;
  return `${name} may be sent only to ${hosts.join(', ')}; ${hostname} (${role}) is not one of them`;
}

/**
 * The call-time check: why the value of `name` may not be sent to
 * `destination` now, or null. A malformed allowlist refuses.
 */
export function credentialCallProblem(name: string, destination: string): string | null {
  try {
    return credentialHostProblem(name, destination, 'server', credentialHosts() ?? null);
  } catch {
    return `the credential host allowlist (${CREDENTIAL_HOSTS_ENV}) is malformed`;
  }
}

/**
 * Marks an OAuth client config (lib/tools/oauthConsent.ts) with the
 * variable its client secret came from, so the consent step's code exchange
 * and the refresh hook can check the token endpoint at call time. Set by
 * oauthClientsFor (lib/tools/oauthTools.ts); a client built by hand carries
 * none and is not checked.
 */
export const CLIENT_SECRET_ENV: unique symbol = Symbol.for('melchizedek.clientSecretEnv');

/** The variable a client config's secret came from, when oauthClientsFor marked it. */
export function clientSecretEnvOf(client: object): string | undefined {
  const name = (client as Record<symbol, unknown>)[CLIENT_SECRET_ENV];
  return typeof name === 'string' ? name : undefined;
}
