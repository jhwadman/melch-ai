/**
 * lib/chatgpt/oauth.ts — OpenAI's Sign in with ChatGPT, plan-usage flow, for a
 * local app (ADR 0126).
 *
 * Implemented from OpenAI's documentation of the flow for open-source apps
 * that run on the user's machine:
 *   https://developers.openai.com/siwc/token-sharing-open-source
 *   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 *   https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
 *   https://developers.openai.com/siwc/token-sharing-open-source/token-reference
 *   https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 *
 * THE FLOW: an authorization-code grant with PKCE (S256), a fresh state and
 * nonce per attempt, and a loopback redirect on http://127.0.0.1:<port>/auth/callback.
 * The app registers itself dynamically: the first authorization sends
 * `client_id=dynamic_agent_client` with an `agent_name_hint`, and the callback
 * returns the client id OpenAI issued, which is kept for every later sign-in
 * and refresh. No client secret, no pre-registration, and never another
 * app's client id or stored token. The token request names the resource
 * `https://api.openai.com/v1`; the ID token is verified (signature against
 * the issuer's JWKS, iss, aud = the issued client id, exp, nonce) before
 * anything is saved, and the plan scope must be granted.
 *
 * TOKENS: an access token lasts an hour and the refresh token rotates on every
 * refresh. Refreshes are serialized through a lock file (lib/chatgpt/store.ts)
 * and an unusable refresh token clears the tokens and asks for a new sign-in.
 * No token is ever logged or put in an error message.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { trimTrailingSlashes } from '../models/urls.ts';
import { PLAN_SCOPE, isSignedIn, readStoredSignIn } from './state.ts';
import type { StoredSignIn } from './state.ts';
import { clearTokens, withSignInLock, writeStoredSignIn } from './store.ts';

export const OPENAI_AUTH_ISSUER = 'https://auth.openai.com';
/** The resource the tokens are for: the public API, where the Responses endpoint lives. */
export const OPENAI_API_RESOURCE = 'https://api.openai.com/v1';
export const SIGNIN_SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export const CALLBACK_PATH = '/auth/callback';
/** The client id an app sends before OpenAI has issued it one. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const APP_NAME = 'Melchizedek';

/** Refresh error codes after which the refresh token is unusable (errors-and-recovery). */
const UNUSABLE_REFRESH = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

/** A sign-in failure: a code for the program, a message for the person, never a token. */
export class SignInError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SignInError';
    this.code = code;
  }
}

export interface OAuthOptions {
  /** The authorization server. Default https://auth.openai.com; an http issuer is accepted on loopback only (tests). */
  issuer?: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function issuerOf(opts: OAuthOptions): string {
  const issuer = trimTrailingSlashes(opts.issuer ?? OPENAI_AUTH_ISSUER);
  const u = new URL(issuer);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
    throw new SignInError('bad_issuer', 'The sign-in issuer must be https.');
  }
  return issuer;
}

/** The issuer's OpenID configuration; every endpoint must be on the issuer's own origin. */
export async function discover(opts: OAuthOptions = {}): Promise<Discovery> {
  const issuer = issuerOf(opts);
  let data: any;
  try {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    data = res.ok ? await res.json() : undefined;
  } catch {
    data = undefined;
  }
  if (!data || data.issuer !== issuer) throw new SignInError('discovery_failed', 'The ChatGPT sign-in configuration could not be read or verified.');
  const origin = new URL(issuer).origin;
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint'] as const) {
    const v = data[key];
    if (v === undefined && key === 'revocation_endpoint') continue;
    if (typeof v !== 'string' || new URL(v).origin !== origin) {
      throw new SignInError('discovery_failed', 'The ChatGPT sign-in configuration names an endpoint off the issuer.');
    }
  }
  return data as Discovery;
}

const randomValue = () => randomBytes(32).toString('base64url');
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** A token-endpoint call: form-encoded, JSON back, the error code (never a token) on failure. */
async function tokenRequest(endpoint: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new SignInError('network_error', 'Could not reach the ChatGPT sign-in service.');
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const raw = typeof data?.error === 'string' ? data.error : typeof data?.error?.code === 'string' ? data.error.code : `http_${res.status}`;
    const code = /^[a-z0-9_.-]{1,64}$/i.test(raw) ? raw : `http_${res.status}`;
    throw new SignInError(code, `The ChatGPT sign-in service refused the request (${code}).`);
  }
  if (!data || typeof data !== 'object') throw new SignInError('invalid_token_response', 'The ChatGPT sign-in service returned an unreadable token response.');
  return data;
}

/** An `earliest_refresh_at` as epoch milliseconds (seconds, milliseconds or an ISO date), when present. */
function epochMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** The token fields a response carries, validated. */
function tokenFields(data: Record<string, unknown>, previousScopes?: string[]): Pick<StoredSignIn, 'accessToken' | 'refreshToken' | 'expiresAt' | 'earliestRefreshAt' | 'scopes'> {
  const scope = typeof data.scope === 'string' ? data.scope : previousScopes?.join(' ');
  if (typeof scope !== 'string') throw new SignInError('invalid_token_response', 'The ChatGPT sign-in service did not confirm the granted permissions.');
  const scopes = scope.split(' ').filter(Boolean);
  if (
    typeof data.access_token !== 'string' || !data.access_token ||
    typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
    typeof data.expires_in !== 'number' || !(data.expires_in > 0) ||
    typeof data.refresh_token !== 'string' || !data.refresh_token
  ) {
    throw new SignInError('invalid_token_response', 'The ChatGPT sign-in service returned incomplete credentials.');
  }
  const earliest = epochMs(data.earliest_refresh_at);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    ...(earliest !== undefined ? { earliestRefreshAt: earliest } : {}),
    scopes,
  };
}

/** Verify an ID token against the issuer's keys; the verified subject. */
async function verifyIdToken(idToken: unknown, d: Discovery, clientId: string, nonce?: string): Promise<string> {
  if (typeof idToken !== 'string' || !idToken) throw new SignInError('invalid_id_token', 'The ChatGPT sign-in returned no verifiable identity.');
  try {
    const { payload } = await jwtVerify(idToken, createRemoteJWKSet(new URL(d.jwks_uri)), {
      issuer: d.issuer,
      audience: clientId,
      algorithms: ['RS256'],
      clockTolerance: 5,
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('no subject');
    if (nonce !== undefined && payload.nonce !== nonce) throw new Error('nonce');
    if (payload.azp !== undefined && payload.azp !== clientId) throw new Error('azp');
    return payload.sub;
  } catch {
    throw new SignInError('invalid_id_token', 'The ChatGPT identity could not be verified. Sign in again.');
  }
}

// ── The loopback listener ────────────────────────────────────────────────────

const CLIENT_ID_SHAPE = /^[A-Za-z0-9_-]{1,200}$/;
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;max-width:32rem;margin:15vh auto;padding:24px}</style><h1>${title}</h1><p>${body}</p></html>`;

interface Callback {
  code: string;
  clientId: string;
}

interface Listener {
  redirectUri: string;
  result: Promise<Callback>;
  close: () => void;
}

/**
 * A one-shot listener on 127.0.0.1. A request with the wrong host, path,
 * method or state is refused (400 or 404) and does not end the wait: an
 * unrelated loopback request must not cancel a sign-in in progress.
 */
async function listen(port: number, state: string, savedClientId: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Listener> {
  let settle!: (v: Callback | SignInError) => void;
  let done = false;
  const result = new Promise<Callback>((resolve, reject) => {
    settle = (v) => {
      if (done) return;
      done = true;
      if (v instanceof SignInError) reject(v);
      else resolve(v);
    };
  });
  result.catch(() => undefined);
  let bound = port;
  const expected = Buffer.from(state);

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${bound}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (done || req.method !== 'GET' || req.headers.host !== `127.0.0.1:${bound}` || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const states = url.searchParams.getAll('state');
    const got = Buffer.from(states[0] ?? '');
    if (states.length !== 1 || got.length !== expected.length || !timingSafeEqual(got, expected)) {
      res.writeHead(400, PAGE_HEADERS).end(page('Sign-in not recognized', 'This sign-in response does not match the one Melchizedek started. Return to the terminal and try again.'));
      return;
    }
    if (url.searchParams.has('error')) {
      res.writeHead(200, PAGE_HEADERS).end(page('Sign-in cancelled', 'You can close this tab and return to the terminal.'));
      const raw = url.searchParams.get('error') ?? '';
      const code = /^[a-z0-9_.-]{1,64}$/i.test(raw) ? raw : 'authorization_failed';
      settle(new SignInError(code, `ChatGPT did not authorize the sign-in (${code}).`));
      return;
    }
    const codes = url.searchParams.getAll('code');
    const ids = url.searchParams.getAll('client_id');
    const clientId = ids[0] ?? savedClientId;
    res.writeHead(200, PAGE_HEADERS).end(page('Return to the terminal', 'Melchizedek is finishing your ChatGPT sign-in. You can close this tab.'));
    if (
      codes.length !== 1 || !codes[0] || ids.length > 1 ||
      !clientId || !CLIENT_ID_SHAPE.test(clientId) || clientId === DYNAMIC_CLIENT_ID ||
      (savedClientId !== undefined && ids.length === 1 && ids[0] !== savedClientId)
    ) {
      settle(new SignInError('registration_incomplete', 'ChatGPT did not complete the app registration. Sign in again.'));
      return;
    }
    settle({ code: codes[0], clientId });
  };

  const server = createServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new SignInError('callback_port_unavailable', `Port ${port} on 127.0.0.1 is unavailable for the sign-in callback; pass another with --port.`)));
    server.listen({ port, host: '127.0.0.1' }, () => {
      const a = server.address();
      if (a && typeof a !== 'string') bound = a.port;
      resolve();
    });
  });
  const timer = setTimeout(() => settle(new SignInError('timeout', 'The ChatGPT sign-in was not completed in time.')), timeoutMs);
  const abort = () => settle(new SignInError('cancelled', 'The ChatGPT sign-in was cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  const close = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  };
  return { redirectUri: `http://127.0.0.1:${bound}${CALLBACK_PATH}`, result, close };
}

/** Open a URL in the default browser, with no shell. */
export async function openInBrowser(url: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', shell: false });
    child.once('error', () => reject(new SignInError('browser_unavailable', 'The browser could not be opened; open the printed link yourself.')));
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new SignInError('browser_unavailable', 'The browser could not be opened; open the printed link yourself.'))));
  });
}

// ── Sign in, refresh, sign out ───────────────────────────────────────────────

export interface SignInOptions extends OAuthOptions {
  /** The credential file (lib/chatgpt/state.ts signInFile). */
  file: string;
  /** The loopback port; 0 (the default) takes a free one. */
  port?: number;
  /** Opens the authorization URL; default the system browser. */
  openBrowser?: (url: string) => Promise<void>;
  /** Called with the authorization URL before the browser opens, so the person can open it themselves. */
  onUrl?: (url: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** What a sign-in reports: never a token. */
export interface SignInResult {
  subject: string;
  scopes: string[];
  expiresAt: number;
  planUsage: boolean;
}

/**
 * The browser sign-in. Stores the registration (host id, issued client id)
 * before the code exchange, and the tokens after the ID token verifies and
 * the plan scope is confirmed.
 */
export async function signIn(opts: SignInOptions): Promise<SignInResult> {
  const issuer = issuerOf(opts);
  const d = await discover({ issuer });
  const previous = readStoredSignIn(opts.file);
  const sameIssuer = previous?.issuer === issuer;
  const hostId = previous?.hostId ?? `urn:uuid:${randomUUID()}`;
  const savedClientId = sameIssuer ? previous?.clientId : undefined;

  const state = randomValue();
  const nonce = randomValue();
  const verifier = randomValue();
  const listener = await listen(opts.port ?? 0, state, savedClientId, opts.timeoutMs ?? 5 * 60_000, opts.signal);
  try {
    const auth = new URL(d.authorization_endpoint);
    auth.search = new URLSearchParams({
      client_id: savedClientId ?? DYNAMIC_CLIENT_ID,
      response_type: 'code',
      redirect_uri: listener.redirectUri,
      scope: SIGNIN_SCOPES,
      resource: OPENAI_API_RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: pkceChallenge(verifier),
      ext_agent_host_id: hostId,
      ...(savedClientId ? {} : { agent_name_hint: APP_NAME }),
    }).toString();
    opts.onUrl?.(auth.toString());
    await (opts.openBrowser ?? openInBrowser)(auth.toString()).catch((err) => {
      // The printed link still works; only a cancelled sign-in ends here.
      if (!(err instanceof SignInError) || err.code !== 'browser_unavailable') throw err;
    });
    const cb = await listener.result;

    // Keep the issued registration even if the one-time code fails below.
    const registration: StoredSignIn = sameIssuer && previous
      ? { ...previous, clientId: cb.clientId, hostId }
      : { version: 1, issuer, hostId, clientId: cb.clientId };
    writeStoredSignIn(opts.file, registration);

    const data = await tokenRequest(d.token_endpoint, {
      grant_type: 'authorization_code',
      client_id: cb.clientId,
      code: cb.code,
      code_verifier: verifier,
      redirect_uri: listener.redirectUri,
      resource: OPENAI_API_RESOURCE,
    });
    const subject = await verifyIdToken(data.id_token, d, cb.clientId, nonce);
    const fields = tokenFields(data);
    const planUsage = fields.scopes!.includes(PLAN_SCOPE);
    if (!planUsage) {
      throw new SignInError('plan_not_granted', 'The sign-in did not grant use of your ChatGPT plan; sign in again and allow it.');
    }
    writeStoredSignIn(opts.file, { ...registration, subject, ...fields, savedAt: new Date().toISOString() });
    return { subject, scopes: fields.scopes!, expiresAt: fields.expiresAt!, planUsage };
  } finally {
    listener.close();
  }
}

/** One refresh of the stored session; the caller holds the lock. */
async function refreshOnce(file: string, s: StoredSignIn, opts: OAuthOptions): Promise<StoredSignIn> {
  const issuer = issuerOf(opts);
  if (s.issuer !== issuer || !s.clientId || !s.refreshToken) {
    throw new SignInError('not_signed_in', 'The stored ChatGPT sign-in cannot be refreshed here; sign in again.');
  }
  const d = await discover({ issuer });
  let data: Record<string, unknown>;
  try {
    data = await tokenRequest(d.token_endpoint, {
      grant_type: 'refresh_token',
      client_id: s.clientId,
      refresh_token: s.refreshToken,
      resource: OPENAI_API_RESOURCE,
    });
  } catch (err) {
    if (err instanceof SignInError && UNUSABLE_REFRESH.has(err.code)) {
      clearTokens(file);
      throw new SignInError('signin_expired', 'Your ChatGPT sign-in has expired or was revoked; run `melchizedek-setup --chatgpt-signin` again.');
    }
    throw err;
  }
  const fields = tokenFields(data, s.scopes);
  if (data.id_token !== undefined) {
    const subject = await verifyIdToken(data.id_token, d, s.clientId);
    if (s.subject && subject !== s.subject) throw new SignInError('account_mismatch', 'The refreshed ChatGPT identity is a different account; sign in again.');
  }
  const next: StoredSignIn = { ...s, ...fields, savedAt: new Date().toISOString() };
  writeStoredSignIn(file, next);
  return next;
}

const SKEW_MS = 120_000;

export interface AccessTokenOptions extends OAuthOptions {
  now?: () => number;
}

/**
 * A usable access token from the credential file, refreshed when it is within
 * two minutes of expiry (and past `earliest_refresh_at`). Refreshes take the
 * file's lock and re-read it first, so a refresh another process just made is
 * used rather than repeated.
 */
export async function freshAccessToken(file: string, opts: AccessTokenOptions = {}): Promise<string> {
  const now = opts.now ?? Date.now;
  const fresh = (s: StoredSignIn | undefined) => isSignedIn(s) && (s!.expiresAt ?? 0) - SKEW_MS > now();
  const notSignedIn = () => new SignInError('not_signed_in', `No ChatGPT sign-in is stored at ${file}; run \`melchizedek-setup --chatgpt-signin\`.`);
  const first = readStoredSignIn(file);
  if (!isSignedIn(first)) throw notSignedIn();
  if (fresh(first)) return first!.accessToken!;
  return withSignInLock(file, async () => {
    const s = readStoredSignIn(file);
    if (!isSignedIn(s)) throw notSignedIn();
    if (fresh(s)) return s!.accessToken!;
    const valid = (s!.expiresAt ?? 0) > now();
    if (valid && s!.earliestRefreshAt !== undefined && now() < s!.earliestRefreshAt) return s!.accessToken!;
    return (await refreshOnce(file, s!, opts)).accessToken!;
  });
}

/**
 * Sign out: the tokens leave the file (the host id and issued client id
 * stay, for the next sign-in), and the refresh token is revoked at the
 * issuer. `revoked: false` means the local tokens are gone but the remote
 * revocation was not confirmed: disconnect the app in ChatGPT's settings.
 */
export async function signOut(file: string, opts: OAuthOptions = {}): Promise<{ hadTokens: boolean; revoked: boolean }> {
  const s = readStoredSignIn(file);
  if (!s?.refreshToken) {
    if (s) clearTokens(file);
    return { hadTokens: false, revoked: false };
  }
  clearTokens(file);
  try {
    const d = await discover(opts);
    if (!d.revocation_endpoint || !s.clientId) return { hadTokens: true, revoked: false };
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(d.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: s.refreshToken, token_type_hint: 'refresh_token', client_id: s.clientId }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      await res?.body?.cancel().catch(() => undefined);
      if (res?.status === 200) return { hadTokens: true, revoked: true };
      if (res && res.status < 500) break;
    }
  } catch {
    // The local tokens are gone either way.
  }
  return { hadTokens: true, revoked: false };
}
