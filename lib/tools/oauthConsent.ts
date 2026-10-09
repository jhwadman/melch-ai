/**
 * lib/tools/oauthConsent.ts — the consent step for a tool's OAuth grant: the
 * authorization URL a paused call hands the person, and the callback that
 * completes the authorization-code flow with PKCE (WS6-3b, ADR 0085).
 *
 * WHY this file exists:
 *   A tool that acts for a person needs their delegated access
 *   (`ctx.accessToken(provider)`, ADR 0072). When the person has not
 *   granted it yet, the call asks for it (`ctx.requestCredential(provider)`)
 *   and the turn pauses on ADK's own `adk_request_credential` call. The
 *   person opens the authorization URL, the provider redirects their browser
 *   to the server's callback route (lib/a2a/app.ts), and this module
 *   exchanges the code for tokens, server-side, and puts them in the
 *   credential store, sealed. The person's next message resumes the call.
 *
 * WHAT IT GUARANTEES:
 *   - The state nonce is 256 random bits, single-use, short-lived (10
 *     minutes by default) and bound to the app, the user, the session, the
 *     provider and the paused call. Only its SHA-256 is a key in the
 *     pending store: a dump of the store cannot complete a flow.
 *   - PKCE S256: the code verifier never leaves this process. It is not in
 *     the authorization URL, an event, a log line or the browser.
 *   - The redirect URI comes from configuration only. The callback never
 *     reads one from the request, and the token request repeats the
 *     configured one.
 *   - The code is exchanged here, server-side. The tokens go to the
 *     credential store and nowhere else: never into the callback's page, an
 *     event, a log line, an audit row or the model's context.
 *   - A refusal (`ConsentError`) names its reason and the provider, never a
 *     code, a token, a state or a provider's own error text, which may echo
 *     what it refused.
 *
 * MULTIPLE INSTANCES: the default pending store is this process's memory, so
 * the callback must reach the instance that paused the call (sticky routing,
 * as the A2A task store already needs). `ConsentStates` is the plug point
 * for a shared store.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { AuditSink } from '../observability/audit.ts';
import { scopeHashOf } from '../observability/audit.ts';
import { PROVIDER_NAME } from './auth.ts';
import { clientSecretEnvOf, credentialCallProblem } from './credentialHosts.ts';
import type { CredentialStore, TokenSet } from './auth.ts';

// ── Configuration ────────────────────────────────────────────────────────────

/** One provider's OAuth client, as registered at the provider. */
export interface OAuthClientConfig {
  /** The provider's authorization endpoint (https, or http on a loopback host). */
  authorizationUrl: string;
  /** The provider's token endpoint (https, or http on a loopback host). */
  tokenUrl: string;
  clientId: string;
  /** A confidential client's secret, sent in the token request body. Omit for a public client (PKCE alone). */
  clientSecret?: string;
  /** The scopes the grant asks for. */
  scopes?: string[];
  /** Extra authorization parameters the provider needs (`access_type=offline`, say). Never `state`, `redirect_uri` or the PKCE pair. */
  authorizationParams?: Record<string, string>;
  /**
   * The protected resource the token is for (RFC 8707): sent as `resource`
   * on the authorization request, the code exchange and each refresh. An MCP
   * server's canonical URI, for a client registered by discovery (ADR 0124).
   */
  resource?: string;
}

/**
 * A client found when first needed rather than configured at boot: an MCP
 * server's authorization server, discovered and registered at
 * (lib/tools/oauthDiscovery.ts dynamicOAuthClient, ADR 0124). Throws when
 * it cannot be had; the next call tries again.
 */
export type OAuthClientSource = () => Promise<OAuthClientConfig>;

export interface OAuthConsentOptions {
  /** Each provider's client, by provider name (lowercase, as the credential store names it): configured, or found when first needed. */
  providers: Record<string, OAuthClientConfig | OAuthClientSource>;
  /**
   * The server's callback URL, exactly as registered at every provider
   * (`https://agents.example.com/oauth/callback`). The A2A server mounts the
   * callback route at its path. Never taken from a request.
   */
  redirectUri: string;
  /** Where a completed grant is put. Its keys are the paused run's app, user and provider. */
  credentials: Pick<CredentialStore, 'put'>;
  /** The pending flows. Default: this process's memory (memoryConsentStates). */
  states?: ConsentStates;
  /** How long a flow may take, ms. Default 10 minutes. */
  ttlMs?: number;
  /** The token request's time limit, ms. Default 10 s. */
  exchangeTimeoutMs?: number;
  /** The audit trail (ADR 0042): one `consent.callback` row per completion or refusal, never a value. */
  audit?: AuditSink;
  /** For tests: the fetch the token request uses, and the clock. */
  fetch?: typeof fetch;
  now?: () => number;
}

// ── The pending flows ────────────────────────────────────────────────────────

/** Who and what a flow is for: the paused call it resumes. */
export interface ConsentBinding {
  appName: string;
  userId: string;
  sessionId: string;
  /** The paused call's id: the one the resume runs again. */
  functionCallId: string;
  provider: string;
}

/** A flow in progress. Holds the PKCE verifier, so it lives server-side only. */
export interface PendingFlow extends ConsentBinding {
  codeVerifier: string;
  scopes: string[];
  /** Epoch ms after which the flow is refused. */
  expiresAt: number;
}

/**
 * Where flows wait for their callback, keyed by the state's SHA-256.
 * `take` removes what it returns, so a state completes at most once.
 */
export interface ConsentStates {
  put(stateHash: string, flow: PendingFlow): Promise<void>;
  take(stateHash: string): Promise<PendingFlow | undefined>;
}

/**
 * Flows in this process's memory, at most `max` of them: the oldest is
 * dropped first, and an expired one whenever another is put.
 */
export function memoryConsentStates(options: { max?: number; now?: () => number } = {}): ConsentStates & { size(): number } {
  const max = options.max ?? 10_000;
  const now = options.now ?? Date.now;
  const flows = new Map<string, PendingFlow>();
  return {
    async put(stateHash, flow) {
      const at = now();
      for (const [k, f] of flows) if (f.expiresAt <= at) flows.delete(k);
      while (flows.size >= max) flows.delete(flows.keys().next().value as string);
      flows.set(stateHash, { ...flow, scopes: [...flow.scopes] });
    },
    async take(stateHash) {
      const flow = flows.get(stateHash);
      flows.delete(stateHash);
      return flow;
    },
    size: () => flows.size,
  };
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type ConsentErrorCode =
  /** The callback's parameters are missing or malformed. */
  | 'invalid_request'
  /** No flow has this state: tampered, invented, or already used. */
  | 'unknown_state'
  | 'expired'
  /** The callback's authenticated caller is not the user the flow is for. */
  | 'wrong_user'
  /** The person declined at the provider, or the provider refused the request. */
  | 'denied'
  /** The token endpoint refused the code or answered something unusable. */
  | 'exchange_failed'
  /** The grant could not be stored. */
  | 'store_failed'
  /** The provider has no client configured. */
  | 'unknown_provider'
  /** A discovered client could not be found or registered (ADR 0124). */
  | 'registration_failed';

/** A consent step that cannot proceed. The message names the reason, never a value. */
export class ConsentError extends Error {
  readonly code: ConsentErrorCode;
  readonly provider?: string;
  constructor(code: ConsentErrorCode, provider?: string) {
    const p = provider ? `"${provider}"` : 'the provider';
    super(
      code === 'invalid_request'
        ? 'The authorization response is incomplete.'
        : code === 'unknown_state'
          ? 'This authorization link is not valid, or was already used. Ask the agent again for a new one.'
          : code === 'expired'
            ? 'This authorization link has expired. Ask the agent again for a new one.'
            : code === 'wrong_user'
              ? 'This authorization link belongs to another user.'
              : code === 'denied'
                ? `The authorization at ${p} was declined.`
                : code === 'exchange_failed'
                  ? `The authorization at ${p} could not be completed.`
                  : code === 'store_failed'
                    ? `The authorization at ${p} could not be saved.`
                    : code === 'registration_failed'
                      ? `The authorization at ${p} could not be set up.`
                      : `No OAuth client is configured for ${p}.`,
    );
    this.name = 'ConsentError';
    this.code = code;
    if (provider !== undefined) this.provider = provider;
  }
}

// ── The consent manager ──────────────────────────────────────────────────────

/** What a paused call carries: the URL the person opens, and the stored request (no secret in either). */
export interface ConsentRequest {
  provider: string;
  /** The provider's authorization URL with client id, redirect URI, scopes, state and the S256 challenge. */
  authUri: string;
  /** The state nonce the URL carries. */
  state: string;
  scopes: string[];
  /**
   * ADK's AuthConfig for the `adk_request_credential` call, as ADK's
   * generateAuthRequest shapes it, without the client secret and without the
   * code verifier: `credentialKey`, `authScheme` (an oauth2
   * authorizationCode flow) and `exchangedAuthCredential.oauth2`
   * (`clientId`, `redirectUri`, `authUri`, `state`).
   */
  authConfig: Record<string, unknown>;
}

/** A completed flow: whose grant was stored, for which paused call. */
export type ConsentCompletion = ConsentBinding;

export interface OAuthConsent {
  /** The configured redirect URI; the callback route is mounted at its path. */
  readonly redirectUri: string;
  /** True when `provider` has a client configured. */
  has(provider: string): boolean;
  /** Starts a flow for a paused call: a fresh state and verifier, held here. */
  begin(binding: ConsentBinding): Promise<ConsentRequest>;
  /**
   * Completes a flow from the callback's parameters: the state taken (once),
   * checked for expiry and, when the callback knows its caller, for the
   * user; the code exchanged with the verifier; the grant stored. Throws
   * ConsentError.
   */
  complete(input: { state?: unknown; code?: unknown; error?: unknown; callerUserId?: string }): Promise<ConsentCompletion>;
}

/** A state as begin issues it: 32 random bytes, base64url, 43 characters. */
const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
/** A code as a provider sends it: visible ASCII, bounded. */
const CODE_FORMAT = /^[\x21-\x7e]{1,2048}$/;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** RFC 7636 S256: the challenge for a verifier. */
export function s256Challenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An endpoint the configuration may name: https, or http on a loopback host (development, tests). */
function checkEndpoint(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} is not a URL.`);
  }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!ok) throw new Error(`${what} must use https (http only on a loopback host).`);
  if (url.username || url.password) throw new Error(`${what} must not carry credentials.`);
  return url;
}

const RESERVED_PARAMS = new Set(['state', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'client_id', 'response_type', 'scope', 'resource']);

/** A client's configuration, checked: the endpoints, the client id, the parameters. Throws, naming the provider. */
function checkClient(name: string, client: OAuthClientConfig): OAuthClientConfig {
  checkEndpoint(client.authorizationUrl, `${name}: authorizationUrl`);
  checkEndpoint(client.tokenUrl, `${name}: tokenUrl`);
  if (typeof client.clientId !== 'string' || !client.clientId) throw new Error(`${name}: clientId is required.`);
  for (const key of Object.keys(client.authorizationParams ?? {})) {
    if (RESERVED_PARAMS.has(key)) throw new Error(`${name}: authorizationParams may not set "${key}".`);
  }
  if (client.resource !== undefined) checkEndpoint(client.resource, `${name}: resource`);
  return { ...client, scopes: [...(client.scopes ?? [])] };
}

/** The consent manager over a credential store. Validates the configuration at once: a bad URL throws here, at boot. */
export function oauthConsent(options: OAuthConsentOptions): OAuthConsent {
  const redirect = checkEndpoint(options.redirectUri, 'The OAuth redirect URI');
  if (redirect.search || redirect.hash) throw new Error('The OAuth redirect URI must not carry a query or a fragment.');
  const providers = new Map<string, OAuthClientConfig | OAuthClientSource>();
  for (const [name, client] of Object.entries(options.providers)) {
    if (!PROVIDER_NAME.test(name)) throw new Error(`OAuth provider "${name.slice(0, 64)}" must match ${PROVIDER_NAME}.`);
    // A source is checked each time it answers; a configured client here, at boot.
    providers.set(name, typeof client === 'function' ? client : checkClient(name, client));
  }
  /** The provider's client now, or undefined; a source that fails is a ConsentError('registration_failed'). */
  const clientOf = async (name: string): Promise<OAuthClientConfig | undefined> => {
    const entry = providers.get(name);
    if (typeof entry !== 'function') return entry;
    try {
      return checkClient(name, await entry());
    } catch (err) {
      // A discovery refusal names roles and hosts, never a value (lib/tools/oauthDiscovery.ts); anything else is named by kind only.
      console.warn(`[OAuth] ${name}: the client could not be set up: ${err instanceof Error && err.name === 'OAuthDiscoveryError' ? err.message : err instanceof Error ? err.name : 'unknown error'}`);
      throw new ConsentError('registration_failed', name);
    }
  };
  const states = options.states ?? memoryConsentStates({ ...(options.now ? { now: options.now } : {}) });
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.exchangeTimeoutMs ?? 10_000;

  const record = (outcome: string, flow: Partial<ConsentBinding> | undefined, reason?: string) => {
    try {
      options.audit?.({
        event: 'consent.callback',
        outcome,
        scopeHash: scopeHashOf(flow?.userId),
        detail: { ...(flow?.provider ? { provider: flow.provider } : {}), ...(flow?.appName ? { appName: flow.appName } : {}), ...(reason ? { reason } : {}) },
      });
    } catch {
      // The audit sink never fails the flow (ADR 0042).
    }
  };

  /** The token response, read whole up to a bound, as JSON. */
  const readJson = async (res: Response): Promise<Record<string, unknown> | undefined> => {
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
  };

  /** The authorization code exchanged for a token set (RFC 6749 4.1.3, RFC 7636 4.5). Throws ConsentError, never the provider's text. */
  const exchange = async (client: OAuthClientConfig, flow: PendingFlow, code: string): Promise<TokenSet> => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: options.redirectUri,
      client_id: client.clientId,
      code_verifier: flow.codeVerifier,
    });
    if (client.resource) body.set('resource', client.resource);
    if (client.clientSecret) {
      // The secret goes only to a host the operator binds its variable to (ADR 0122), checked now:
      // the allowlist can change after boot. Refused, nothing is sent.
      const secretEnv = clientSecretEnvOf(client);
      if (secretEnv && credentialCallProblem(secretEnv, client.tokenUrl)) throw new ConsentError('exchange_failed', flow.provider);
      body.set('client_secret', client.clientSecret);
    }
    let json: Record<string, unknown> | undefined;
    try {
      const res = await doFetch(client.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        // A redirect would carry the code to wherever it points.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      json = await readJson(res);
      if (!res.ok) json = undefined;
    } catch {
      json = undefined;
    }
    const accessToken = json?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new ConsentError('exchange_failed', flow.provider);
    const tokenType = json?.token_type;
    if (tokenType !== undefined && (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer')) throw new ConsentError('exchange_failed', flow.provider);
    const refreshToken = typeof json?.refresh_token === 'string' && json.refresh_token ? json.refresh_token : undefined;
    const expiresIn = typeof json?.expires_in === 'number' ? json.expires_in : typeof json?.expires_in === 'string' ? Number(json.expires_in) : undefined;
    const granted = typeof json?.scope === 'string' ? json.scope.split(' ').filter((s) => s !== '') : flow.scopes;
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: new Date(now() + expiresIn * 1000) } : {}),
      scopes: granted,
    };
  };

  return {
    redirectUri: options.redirectUri,

    has: (provider) => typeof provider === 'string' && providers.has(provider),

    async begin(binding) {
      if (!providers.has(binding.provider)) throw new ConsentError('unknown_provider', PROVIDER_NAME.test(binding.provider) ? binding.provider : undefined);
      const client = (await clientOf(binding.provider))!;
      for (const field of ['appName', 'userId', 'sessionId', 'functionCallId'] as const) {
        if (typeof binding[field] !== 'string' || !binding[field]) throw new Error(`A consent flow needs the paused call's ${field}.`);
      }
      const state = base64url(randomBytes(32));
      const codeVerifier = base64url(randomBytes(32));
      const scopes = [...(client.scopes ?? [])];
      await states.put(sha256(state), {
        appName: binding.appName,
        userId: binding.userId,
        sessionId: binding.sessionId,
        functionCallId: binding.functionCallId,
        provider: binding.provider,
        codeVerifier,
        scopes,
        expiresAt: now() + ttlMs,
      });
      const url = new URL(client.authorizationUrl);
      for (const [k, v] of Object.entries(client.authorizationParams ?? {})) url.searchParams.set(k, v);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('redirect_uri', options.redirectUri);
      if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', s256Challenge(codeVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
      if (client.resource) url.searchParams.set('resource', client.resource);
      const authUri = url.toString();
      const authConfig = {
        credentialKey: binding.provider,
        authScheme: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: client.authorizationUrl,
              tokenUrl: client.tokenUrl,
              scopes: Object.fromEntries(scopes.map((s) => [s, ''])),
            },
          },
        },
        exchangedAuthCredential: {
          authType: 'oauth2',
          oauth2: { clientId: client.clientId, redirectUri: options.redirectUri, authUri, state },
        },
      };
      return { provider: binding.provider, authUri, state, scopes, authConfig };
    },

    async complete(input) {
      const state = input.state;
      if (typeof state !== 'string' || !STATE_FORMAT.test(state)) {
        record('denied', undefined, 'invalid_request');
        throw new ConsentError('invalid_request');
      }
      // Taken before anything else is checked: a state is spent by its first use, whatever the outcome.
      const flow = await states.take(sha256(state));
      if (!flow) {
        record('denied', undefined, 'unknown_state');
        throw new ConsentError('unknown_state');
      }
      const fail = (code: ConsentErrorCode): never => {
        record('denied', flow, code);
        throw new ConsentError(code, flow.provider);
      };
      if (flow.expiresAt <= now()) fail('expired');
      if (input.callerUserId !== undefined && input.callerUserId !== flow.userId) fail('wrong_user');
      if (input.error !== undefined) fail('denied');
      const code = input.code;
      if (typeof code !== 'string' || !CODE_FORMAT.test(code)) fail('invalid_request');
      if (!providers.has(flow.provider)) fail('unknown_provider');
      let client: OAuthClientConfig | undefined;
      try {
        client = await clientOf(flow.provider);
      } catch {
        return fail('registration_failed');
      }
      if (!client) fail('unknown_provider');
      let tokens: TokenSet;
      try {
        tokens = await exchange(client!, flow, code as string);
      } catch {
        return fail('exchange_failed');
      }
      try {
        await options.credentials.put({ appName: flow.appName, userId: flow.userId, provider: flow.provider }, tokens);
      } catch {
        return fail('store_failed');
      }
      record('ok', flow);
      return { appName: flow.appName, userId: flow.userId, sessionId: flow.sessionId, functionCallId: flow.functionCallId, provider: flow.provider };
    },
  };
}

/** The credential store and the consent step a run reaches its tools' third-party grants through. */
export interface ToolCredentials {
  /** The sealed per-user store (ADR 0072). A run reads it pinned to its own app. */
  store: CredentialStore;
  /** The consent step. Without it, a missing grant is a ToolCredentialError, as before. */
  consent?: OAuthConsent;
}
