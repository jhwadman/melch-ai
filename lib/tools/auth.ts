/**
 * lib/tools/auth.ts — a tool's access to a third-party API on behalf of the
 * run's own user (ADR 0072).
 *
 * WHY this file exists:
 *   A long-running agent that acts for a person (reads their calendar, opens
 *   a pull request in their repository) needs that person's delegated
 *   access, not the server's own key. The engine holds one OAuth token set
 *   per app, end user and provider (lib/tools/credentialStore.ts, sealed by
 *   lib/tools/credentialCipher.ts), and a tool reaches it through one
 *   ToolContext member:
 *
 *     const token = await ctx.accessToken('github');
 *
 *   bound to the context's own app and user, the way `searchMemory` is
 *   bound to the run's own silo (ADR 0059): a tool chooses the provider,
 *   never whose token. The token comes back valid, refreshed first when it
 *   has expired. A tool sends it to its provider and nowhere else: never in
 *   its result, an error, a log line or a span.
 *
 * WHOSE APP: the run pins it, as memory pins its namespace
 *   (`pinnedCredentialStore`, like namespacedMemoryService), so a delegated
 *   subagent, which runs under its own app name, reads the root's
 *   credentials. The consent step that puts a token is
 *   lib/tools/oauthConsent.ts (ADR 0085); the YAML that lets an OpenAPI or
 *   MCP tool use a provider (`auth: { oauth2 }`, lib/tools/oauthTools.ts,
 *   ADR 0112) is what calls `accessToken` for a declared tool.
 *
 * A LEAF: types and plain functions, no runtime imports, so lib/tools/tool.ts
 * can bind the member without loading crypto, pg or telemetry.
 */

/** Which credential: the app the run pins, the end user (scope key), and the provider. */
export interface CredentialKey {
  appName: string;
  userId: string;
  provider: string;
}

/** A token set as a provider issues it. Plaintext: it exists only in memory, in the call that uses it. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** When the access token stops working. Absent: the provider did not say. */
  expiresAt?: Date;
  /** What the user granted. */
  scopes?: string[];
}

/** What `get` hands back: a valid access token and what it was granted. */
export interface AccessGrant {
  accessToken: string;
  scopes: string[];
  expiresAt?: Date;
}

/** How a provider renews and withdraws a token (`oauthRefreshProviders` builds the refresh from a YAML grant, ADR 0112). */
export interface OAuthProvider {
  /**
   * A new token set for this refresh token. Throw when the provider refuses;
   * the store reports the refusal without the provider's message, which may
   * echo the token.
   */
  refresh?(refreshToken: string, context: { scopes: string[]; signal?: AbortSignal }): Promise<TokenSet>;
  /** Withdraw the grant at the provider (best effort; the stored row is deleted either way). */
  revoke?(tokens: { accessToken: string; refreshToken?: string }): Promise<void>;
}

export interface EraseCredentialsOptions {
  /** Erase only this app's credentials. Default: every app's. */
  appName?: string;
  /** Also erase users nested beneath this one ('<userId>/...'). */
  includeNested?: boolean;
}

/** The credential store: put, get with refresh, revoke, erase. Holds ciphertext only. */
export interface CredentialStore {
  /** Store (or replace) the token set for this key, sealed. */
  put(key: CredentialKey, tokens: TokenSet): Promise<void>;
  /**
   * A valid access token for this key, refreshed first when expired.
   * Undefined when none is stored. Throws a ToolCredentialError when the
   * stored token expired and cannot be refreshed, or cannot be opened.
   */
  get(key: CredentialKey, options?: { signal?: AbortSignal }): Promise<AccessGrant | undefined>;
  /** Delete the key's token set and withdraw it at the provider when it can. True when one was stored. */
  revoke(key: CredentialKey): Promise<boolean>;
  /** Delete every token set of this user (every app's, or one app's). Returns the count. */
  eraseUser(userId: string, options?: EraseCredentialsOptions): Promise<number>;
}

/** What the ToolContext member gives a tool: a valid access token for a provider, for this run's user only. */
export type ToolAccessToken = (provider: string) => Promise<string>;

export type ToolCredentialErrorCode = 'not_connected' | 'expired' | 'refresh_failed' | 'unreadable' | 'no_user' | 'invalid' | 'unavailable' | 'grant_failed';

/**
 * A credential that cannot be used. The message names the provider and what
 * to do, never a token, a user or a key, so a tool may return it to the model.
 */
export class ToolCredentialError extends Error {
  readonly code: ToolCredentialErrorCode;
  readonly provider?: string;
  constructor(code: ToolCredentialErrorCode, provider?: string) {
    const p = provider ? `"${provider}"` : 'this provider';
    super(
      code === 'not_connected'
        ? `No ${p} account is connected for this user; ask them to connect it.`
        : code === 'expired'
          ? `The ${p} authorization for this user has expired and cannot be renewed; ask them to connect it again.`
          : code === 'refresh_failed'
            ? `The ${p} authorization for this user could not be renewed; ask them to connect it again.`
            : code === 'unreadable'
              ? `The stored ${p} authorization cannot be read with this server's credential key.`
              : code === 'no_user'
                ? 'Third-party access needs the app and user of the run.'
                : code === 'unavailable'
                  ? `This server holds no ${p} authorizations: its operator has not configured tool credentials.`
                  : code === 'grant_failed'
                    ? `The server's own ${p} authorization could not be obtained from the provider's token endpoint.`
                    : `Invalid credential request for ${p}.`,
    );
    this.name = 'ToolCredentialError';
    this.code = code;
    this.provider = provider;
  }
}

/** A provider name: lowercase letters, digits, and . _ - inside; at most 64 characters. */
export const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** One OAuth scope token (RFC 6749 3.3: visible ASCII but space, `"` and `\`), at most 256 characters. One class, so it cannot backtrack. */
export const OAUTH_SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/;

/**
 * The ToolContext member: an access token for `provider`, from this app's
 * and this user's credentials only. A context that does not know its app
 * and user refuses, rather than read a key nobody writes to.
 */
export function toolAccessToken(store: Pick<CredentialStore, 'get'>, appName: string | undefined, userId: string | undefined, signal?: AbortSignal): ToolAccessToken {
  return async (provider: string) => {
    if (typeof provider !== 'string' || !PROVIDER_NAME.test(provider)) throw new ToolCredentialError('invalid');
    if (!appName || !userId) throw new ToolCredentialError('no_user', provider);
    const grant = await store.get({ appName, userId, provider }, { signal });
    if (!grant) throw new ToolCredentialError('not_connected', provider);
    return grant.accessToken;
  };
}

/**
 * `store` with every key's app replaced by `appName`: the run's pinned app
 * (the root syndicate's memory namespace), whatever app name a nested agent
 * runs under. Erase passes through, since it names its app itself.
 */
export function pinnedCredentialStore(store: CredentialStore, appName: string): CredentialStore {
  const pin = (key: CredentialKey): CredentialKey => ({ ...key, appName });
  return {
    put: (key, tokens) => store.put(pin(key), tokens),
    get: (key, options) => store.get(pin(key), options),
    revoke: (key) => store.revoke(pin(key)),
    eraseUser: (userId, options) => store.eraseUser(userId, options),
  };
}
