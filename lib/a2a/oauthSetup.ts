/**
 * lib/a2a/oauthSetup.ts — tool credentials and the OAuth consent step from
 * the environment, for the server binary (WS6-3d, ADR 0114).
 *
 * WHY this file exists:
 *   `createA2AApp({ toolCredentials })` takes a credential store and a
 *   consent step, and the YAML declares the grants (ADR 0112), but the
 *   `melchizedek-serve` binary built neither: a declared authorization-code
 *   grant worked only for an embedder who wrote the wiring. This module is
 *   that wiring, from four variables, so the binary and an embedder build it
 *   the same way:
 *
 *     MELCHIZEDEK_CREDENTIAL_KEY  the key that seals each user's tokens (ADR 0072)
 *     OAUTH_REDIRECT_URI          the consent callback, as registered at every provider (ADR 0085)
 *     MELCHIZEDEK_OAUTH_HOSTS     which hosts each provider's tokens may go to (ADR 0114)
 *     MELCHIZEDEK_CREDENTIAL_HOSTS  which hosts each static credential variable may go to (ADR 0122)
 *     the client id and secret variables each YAML grant names
 *
 *   The consent clients are built from the syndicates the server serves from
 *   files (`oauthClientsFor`), never from a registry row, so a stored YAML
 *   can name a provider the files declare but cannot define one.
 *
 * WHAT IT NEVER DOES: print, return or log a value. Problems name variables,
 * providers and hosts only (secrets-hygiene).
 */

import type { AuditSink } from '../observability/audit.ts';
import { CREDENTIAL_KEY_ENV, credentialCipherFromEnv } from '../tools/credentialCipher.ts';
import { credentialStore, memoryCredentialRows } from '../tools/credentialStore.ts';
import type { CredentialRows } from '../tools/credentialStore.ts';
import { oauthConsent } from '../tools/oauthConsent.ts';
import type { ToolCredentials } from '../tools/oauthConsent.ts';
import { OAUTH_HOSTS_ENV, oauthHosts } from '../tools/oauthHosts.ts';
import { oauthClientsFor, oauthGrantHostProblems, oauthRefreshProviders, syndicateOAuthGrants, syndicateOAuthHostProblems } from '../tools/oauthTools.ts';
import type { OAuthGrantUse } from '../tools/oauthTools.ts';
import { CREDENTIAL_HOSTS_ENV, credentialHosts } from '../tools/credentialHosts.ts';
import { syndicateCredentialHostProblems, syndicateCredentialUses, unboundCredentialEnvs } from '../tools/credentialUses.ts';

/** The consent callback's URL, exactly as registered at every provider. */
export const OAUTH_REDIRECT_URI_ENV = 'OAUTH_REDIRECT_URI';

/** Who may complete a consent callback: `required` (the browser carries the user's identity) or `state` (the nonce alone). */
export const OAUTH_CALLBACK_IDENTITY_ENV = 'OAUTH_CALLBACK_IDENTITY';

/** OAUTH_CALLBACK_IDENTITY, checked: `required` (the default) or `state`. Throws on anything else. */
export function callbackIdentity(env: NodeJS.ProcessEnv = process.env): 'required' | 'state' {
  const raw = (env[OAUTH_CALLBACK_IDENTITY_ENV] ?? '').trim().toLowerCase() || 'required';
  if (raw !== 'required' && raw !== 'state') throw new Error(`${OAUTH_CALLBACK_IDENTITY_ENV} must be 'required' or 'state' (got '${raw.slice(0, 40)}')`);
  return raw;
}

/**
 * Why consent callbacks would all be refused under this environment, or
 * null: a required caller identity that the configured authenticator cannot
 * give a browser (only a gateway's header can: A2A_AUTH=header).
 */
export function callbackIdentityProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const authKind = (env.A2A_AUTH ?? 'secret').trim().toLowerCase() || 'secret';
  if (callbackIdentity(env) !== 'required' || authKind === 'header') return null;
  return `the consent callback requires the browser to carry the user's identity, which A2A_AUTH=${authKind} cannot give a browser, so every callback is refused: serve behind a gateway (A2A_AUTH=header), or set ${OAUTH_CALLBACK_IDENTITY_ENV}=state to let the single-use state alone bind it`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Why `raw` cannot be the consent redirect URI, or null (the rule oauthConsent enforces). */
export function redirectUriProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${OAUTH_REDIRECT_URI_ENV} is not a URL`;
  }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) return `${OAUTH_REDIRECT_URI_ENV} must use https (http only on a loopback host)`;
  if (url.username || url.password) return `${OAUTH_REDIRECT_URI_ENV} must not carry credentials`;
  if (url.search || url.hash) return `${OAUTH_REDIRECT_URI_ENV} must not carry a query or a fragment`;
  return null;
}

/** The MCP server a grant's tools call, when the grant is an MCP one. */
const serversOf = (use: OAuthGrantUse): string[] => (use.tools.startsWith('mcp ') && use.tools.length > 4 ? [use.tools.slice(4)] : []);

/**
 * Why this grant's hosts are refused by the allowlist in `env`, one line
 * each (the MCP server, the token and authorization endpoints; an OpenAPI
 * entry's servers are checked when it compiles). Names and hosts only.
 */
export function grantHostProblems(use: OAuthGrantUse, env: NodeJS.ProcessEnv = process.env): string[] {
  let allowlist;
  try {
    allowlist = oauthHosts(env) ?? null;
  } catch {
    return [`${OAUTH_HOSTS_ENV} is malformed`];
  }
  return oauthGrantHostProblems(use.oauth2, serversOf(use), allowlist);
}

/**
 * What is wrong with this environment for these declared grants, one line
 * each, names only: the credential key, the redirect URI and the allowlist
 * (each grant's own hosts: grantHostProblems). The doctor prints these; the
 * server refuses to start on the ones that would make it unsafe.
 */
export function oauthEnvProblems(grants: readonly OAuthGrantUse[], env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const authCode = [...new Set(grants.filter((g) => g.oauth2.grant === 'authorization_code').map((g) => g.oauth2.provider))];
  const keySet = !!env[CREDENTIAL_KEY_ENV]?.trim();
  const redirect = env[OAUTH_REDIRECT_URI_ENV]?.trim();
  if (keySet) {
    try {
      credentialCipherFromEnv(env);
    } catch (err) {
      // parseCredentialKey's message names the variable and the shape, never the value.
      problems.push(err instanceof Error ? err.message : `${CREDENTIAL_KEY_ENV} is malformed`);
    }
  }
  if (redirect) {
    const problem = redirectUriProblem(redirect);
    if (problem) problems.push(problem);
    if (!keySet) problems.push(`${OAUTH_REDIRECT_URI_ENV} is set but ${CREDENTIAL_KEY_ENV} is not: the consent step has nowhere to keep a grant`);
    try {
      const identity = callbackIdentityProblem(env);
      if (identity && authCode.length) problems.push(identity);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : `${OAUTH_CALLBACK_IDENTITY_ENV} is malformed`);
    }
  }
  if (authCode.length) {
    const who = authCode.join(', ');
    if (!keySet) problems.push(`authorization_code grants (${who}) need ${CREDENTIAL_KEY_ENV}: without it no user's token can be held, and their tools answer unavailable`);
    if (!redirect) problems.push(`authorization_code grants (${who}) need ${OAUTH_REDIRECT_URI_ENV}: without it a user who has not connected cannot be asked to`);
  }
  let allowlist;
  try {
    allowlist = oauthHosts(env);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : `${OAUTH_HOSTS_ENV} is malformed`);
  }
  if (authCode.length && allowlist === undefined && !problems.some((p) => p.startsWith(OAUTH_HOSTS_ENV))) {
    problems.push(`authorization_code grants (${authCode.join(', ')}) need ${OAUTH_HOSTS_ENV}: without it the operator has bound no provider to its hosts, so they are refused`);
  }
  return problems;
}

/**
 * The warning for credential variables no allowlist binds (ADR 0122), or
 * null: with no credential host allowlist, each variable in `envs` (the
 * ones the served YAML sends) still goes to whatever host the YAML names.
 * Names only.
 */
export function unboundCredentialWarning(envs: readonly string[], env: NodeJS.ProcessEnv = process.env): string | null {
  let allowlist;
  try {
    allowlist = credentialHosts(env);
  } catch {
    return null; // A malformed allowlist is a problem, reported as one.
  }
  if (allowlist) return null; // Configured: an unbound variable is refused, not warned about.
  const unbound = [...new Set(envs)].sort();
  if (!unbound.length) return null;
  return `${unbound.join(', ')} ${unbound.length === 1 ? 'is' : 'are'} sent to whatever host the YAML names: no ${CREDENTIAL_HOSTS_ENV} binds ${unbound.length === 1 ? 'it' : 'them'} to ${unbound.length === 1 ? 'its' : 'their'} hosts`;
}

/**
 * What is wrong with the credential host allowlist for these uses, one line
 * each, names and hosts only: a malformed allowlist, or each use it refuses
 * (lib/tools/credentialUses.ts). Empty when none is configured.
 */
export function credentialHostEnvProblems(configs: readonly SyndicateLike[], env: NodeJS.ProcessEnv = process.env, load?: (ref: string) => SyndicateLike): string[] {
  let allowlist;
  try {
    allowlist = credentialHosts(env);
  } catch (err) {
    return [err instanceof Error ? err.message : `${CREDENTIAL_HOSTS_ENV} is malformed`];
  }
  return syndicateCredentialHostProblems(configs, { allowlist: allowlist ?? null, ...(load ? { load } : {}) });
}

/** The parts of a syndicate config the setup reads. */
type SyndicateLike = Parameters<typeof oauthClientsFor>[0][number];

export interface OAuthServerSetupOptions {
  /** The syndicates the server serves from files (the default, and the served ids). */
  configs: readonly SyndicateLike[];
  /** Reads a nested `yaml_reference:` file. */
  load?: (ref: string) => SyndicateLike;
  env?: NodeJS.ProcessEnv;
  /** Where sealed rows live: postgresCredentialRows(pool) with DATABASE_URL. Default: this process's memory. */
  rows?: CredentialRows;
  /** The audit trail for puts, refreshes and consent callbacks. */
  audit?: AuditSink;
  /** Private and loopback token endpoints pass the guard (ALLOW_PRIVATE_OPENAPI / ALLOW_PRIVATE_MCP). */
  allowPrivate?: boolean;
  /** For tests: the fetch the token requests use. */
  fetch?: typeof fetch;
}

export interface OAuthServerSetup {
  /** createA2AApp's `toolCredentials`; undefined when MELCHIZEDEK_CREDENTIAL_KEY is unset. */
  toolCredentials?: ToolCredentials;
  /** One line for the server's banner: key id, row store, consent path, providers, allowlist. No value. */
  summary: string;
  /** One line for the server's banner: the credential host allowlist (ADR 0122), variable names only. */
  credentialSummary: string;
  /** What works less than the YAML asks, names only. */
  warnings: string[];
}

/**
 * The credential store and consent step from the environment. Throws, naming
 * variables only, when the configuration would be unsafe or cannot work: a
 * malformed key, a redirect URI without a key, a malformed redirect URI or
 * allowlist, an authorization-code grant the allowlist does not permit, a
 * grant whose client variables are unset.
 */
export function oauthServerSetup(options: OAuthServerSetupOptions): OAuthServerSetup {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const grants = syndicateOAuthGrants(options.configs, options.load);
  const authCode = [...new Set(grants.filter((g) => g.oauth2.grant === 'authorization_code').map((g) => g.oauth2.provider))];
  const redirect = env[OAUTH_REDIRECT_URI_ENV]?.trim() || undefined;
  const cipher = credentialCipherFromEnv(env); // a malformed key throws here, at boot
  const allowlist = oauthHosts(env); // a malformed allowlist throws here, at boot
  const hostsLabel = allowlist ? `host allowlist for ${Object.keys(allowlist).join(', ')}` : `no host allowlist (${OAUTH_HOSTS_ENV}): authorization_code grants refused`;
  if (redirect) {
    const problem = redirectUriProblem(redirect);
    if (problem) throw new Error(problem);
  }
  // A served syndicate whose grant the allowlist refuses is refused here, at boot, as its route would refuse it.
  const refused = syndicateOAuthHostProblems(options.configs, { ...(options.load ? { load: options.load } : {}), allowlist: allowlist ?? null });
  if (refused.length) throw new Error(`refusing an OAuth grant the operator's host allowlist does not permit:\n  - ${refused.join('\n  - ')}`);
  // The credential host allowlist (ADR 0122): malformed throws here, at boot; a served file it refuses too.
  const credentialList = credentialHosts(env);
  const credentialRefused = syndicateCredentialHostProblems(options.configs, { ...(options.load ? { load: options.load } : {}), allowlist: credentialList ?? null });
  if (credentialRefused.length) throw new Error(`refusing a credential the operator's credential host allowlist does not permit:\n  - ${credentialRefused.join('\n  - ')}`);
  const uses = syndicateCredentialUses(options.configs, options.load);
  const unboundWarning = unboundCredentialWarning(uses.map((u) => u.env), env);
  if (unboundWarning) warnings.push(`${unboundWarning.charAt(0).toUpperCase()}${unboundWarning.slice(1)}.`);
  const credentialSummary = credentialList
    ? `bound: ${Object.keys(credentialList).join(', ')} (${CREDENTIAL_HOSTS_ENV})`
    : uses.length
      ? `no allowlist (${CREDENTIAL_HOSTS_ENV}): ${unboundCredentialEnvs(uses, undefined).join(', ')} unbound`
      : `no allowlist (${CREDENTIAL_HOSTS_ENV}); no served file sends a static credential`;
  if (!cipher) {
    if (redirect) throw new Error(`${OAUTH_REDIRECT_URI_ENV} is set but ${CREDENTIAL_KEY_ENV} is not: the consent step has nowhere to keep a grant. Set ${CREDENTIAL_KEY_ENV} (openssl rand -base64 32).`);
    if (authCode.length) warnings.push(`authorization_code grants (${authCode.join(', ')}) are declared but ${CREDENTIAL_KEY_ENV} is not set: their tools answer unavailable.`);
    return { summary: `off (${CREDENTIAL_KEY_ENV} unset) · ${hostsLabel}`, credentialSummary, warnings };
  }
  const clients = oauthClientsFor(options.configs, { env, ...(options.load ? { load: options.load } : {}), allowlist: allowlist ?? null });
  const providers = Object.keys(clients);
  const store = credentialStore({
    rows: options.rows ?? memoryCredentialRows(),
    cipher,
    providers: oauthRefreshProviders(clients, { ...(options.allowPrivate ? { allowPrivate: true } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) }),
    ...(options.audit ? { audit: options.audit } : {}),
  });
  if (!options.rows) warnings.push(`Tool credentials are held in process memory: lost on restart, one instance only. Set DATABASE_URL to keep them sealed in Postgres.`);
  const where = options.rows ? 'postgres' : 'process memory';
  if (!redirect) {
    if (providers.length) warnings.push(`${OAUTH_REDIRECT_URI_ENV} is not set: a user who has not connected ${providers.join(', ')} cannot be asked to.`);
    return { toolCredentials: { store }, summary: `sealed (key ${cipher.keyId}) in ${where}; no consent step · ${hostsLabel}`, credentialSummary, warnings };
  }
  if (!providers.length) {
    warnings.push(`${OAUTH_REDIRECT_URI_ENV} is set but no served syndicate declares an authorization_code grant: no consent callback is mounted.`);
    return { toolCredentials: { store }, summary: `sealed (key ${cipher.keyId}) in ${where}; no consent step · ${hostsLabel}`, credentialSummary, warnings };
  }
  const consent = oauthConsent({
    providers: clients,
    redirectUri: redirect,
    credentials: store,
    ...(options.audit ? { audit: options.audit } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    toolCredentials: { store, consent },
    summary: `sealed (key ${cipher.keyId}) in ${where}; consent at ${new URL(redirect).pathname} for ${providers.join(', ')} · ${hostsLabel}`,
    credentialSummary,
    warnings,
  };
}
