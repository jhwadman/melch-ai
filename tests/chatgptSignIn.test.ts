/**
 * tests/chatgptSignIn.test.ts — Sign in with ChatGPT, local only (ADR 0126).
 *
 * Offline: a fake authorization server on 127.0.0.1 plays OpenAI's role
 * (discovery, the token endpoint with PKCE, a JWKS, revocation), and the
 * "browser" is a function that follows the authorization URL the way OpenAI's
 * consent page would, straight to the loopback callback. The Responses API is
 * a fetch stub. No provider is called, no real token exists.
 *
 * What is proved here:
 *   - the authorization request: dynamic registration, PKCE S256, a fresh
 *     state and nonce, the plan scope, the resource, the host id, the
 *     loopback redirect; the code exchange checks the verifier;
 *   - a callback with the wrong state is refused and never exchanged;
 *   - the credential file is mode 600 in a mode-700 directory, refused when
 *     readable by others, and never written inside a git work tree;
 *   - refresh: near expiry, rotated, serialized across concurrent callers;
 *     an unusable refresh token clears the tokens and keeps the registration;
 *   - sign-out clears the tokens and revokes the refresh token;
 *   - routing: OpenAI ids resolve to the sign-in adapter only with no key,
 *     and its requests stream, store nothing and carry only the bearer;
 *   - served surfaces refuse: the A2A server bin and the worker exit 1, the
 *     adapter refuses after a surface is marked served;
 *   - the doctor reports it and `--check` fails a served config using it.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { ChatGptSignInAdapter } from '../lib/chatgpt/adapter.ts';
import { DYNAMIC_CLIENT_ID, OPENAI_API_RESOURCE, SignInError, freshAccessToken, signIn, signOut } from '../lib/chatgpt/oauth.ts';
import {
  PLAN_SCOPE,
  chatGptSignInRoutesOpenAi,
  markServedSurface,
  readStoredSignIn,
  refuseChatGptSignInOnServedSurface,
  resetServedSurfaceForTests,
} from '../lib/chatgpt/state.ts';
import type { StoredSignIn } from '../lib/chatgpt/state.ts';
import { writeStoredSignIn } from '../lib/chatgpt/store.ts';
import { checkProblems, renderDoctor, runDoctor } from '../lib/doctor.ts';
import type { FinalModelResponse, ModelRequest, ModelResponse } from '../lib/models/contract.ts';
import { GptAdapter } from '../lib/models/gptAdapter.ts';
import { resolveAdapter } from '../lib/models/adapterResolver.ts';

const ROOT = process.cwd();

// ── The fake authorization server ────────────────────────────────────────────

interface Pending {
  challenge: string;
  redirectUri: string;
  clientId: string;
  nonce: string;
}

interface FakeAuth {
  issuer: string;
  /** Every request the server saw, by path. */
  calls: string[];
  /** Token-endpoint forms, in order. */
  tokenForms: Record<string, string>[];
  revoked: string[];
  /** The authorization URLs the "browser" was given. */
  authorizations: URL[];
  /** What the next refresh answers: `ok`, `ok-with-id` or an OAuth error code. */
  refreshAnswer: string;
  /** Set to delay each refresh, to widen a race. */
  refreshDelayMs: number;
  issuedClientId: string;
  /** The browser: follow the URL like the consent page would. `state` overrides the state sent back. */
  browser: (opts?: { state?: string; scope?: string }) => (url: string) => Promise<void>;
  close: () => Promise<void>;
}

async function fakeAuthServer(): Promise<FakeAuth> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const pending = new Map<string, Pending>();
  const refreshTokens = new Set<string>();
  const fake = {
    calls: [] as string[],
    tokenForms: [] as Record<string, string>[],
    revoked: [] as string[],
    authorizations: [] as URL[],
    refreshAnswer: 'ok',
    refreshDelayMs: 0,
    issuedClientId: 'app_test_issued_0001',
  } as FakeAuth;

  const idToken = (clientId: string, nonce?: string) =>
    new SignJWT({ ...(nonce ? { nonce } : {}), email: 'person@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(fake.issuer)
      .setAudience(clientId)
      .setSubject('user-test-subject')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

  const tokens = async (clientId: string, nonce: string | undefined, scope: string) => {
    const refresh = `fake-refresh-${randomBytes(6).toString('hex')}`;
    refreshTokens.add(refresh);
    return {
      access_token: `fake-access-${randomBytes(6).toString('hex')}`,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 3600,
      scope,
      id_token: await idToken(clientId, nonce),
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', fake.issuer);
    fake.calls.push(url.pathname);
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const form = Object.fromEntries(new URLSearchParams(raw));

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: fake.issuer,
        authorization_endpoint: `${fake.issuer}/api/accounts/authorize`,
        token_endpoint: `${fake.issuer}/api/accounts/oauth/token`,
        jwks_uri: `${fake.issuer}/jwks`,
        revocation_endpoint: `${fake.issuer}/revoke`,
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/revoke') {
      fake.revoked.push(form.token);
      refreshTokens.delete(form.token);
      return json(200, {});
    }
    if (url.pathname === '/api/accounts/oauth/token') {
      fake.tokenForms.push(form);
      if (form.resource !== OPENAI_API_RESOURCE) return json(400, { error: 'invalid_target' });
      if (form.grant_type === 'authorization_code') {
        const p = pending.get(form.code);
        pending.delete(form.code);
        if (!p) return json(400, { error: 'invalid_grant' });
        const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
        if (challenge !== p.challenge || form.redirect_uri !== p.redirectUri || form.client_id !== p.clientId) return json(400, { error: 'invalid_grant' });
        return json(200, await tokens(p.clientId, p.nonce, `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`));
      }
      if (form.grant_type === 'refresh_token') {
        if (fake.refreshDelayMs) await new Promise((r) => setTimeout(r, fake.refreshDelayMs));
        if (fake.refreshAnswer !== 'ok' && fake.refreshAnswer !== 'ok-with-id') return json(400, { error: fake.refreshAnswer });
        if (!refreshTokens.has(form.refresh_token)) return json(400, { error: 'refresh_token_reused' });
        refreshTokens.delete(form.refresh_token);
        const t = await tokens(form.client_id, undefined, '');
        const { scope: _scope, id_token, ...rest } = t;
        return json(200, fake.refreshAnswer === 'ok-with-id' ? { ...rest, id_token } : rest);
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    return json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  fake.browser = (opts = {}) => async (href: string) => {
    const auth = new URL(href);
    fake.authorizations.push(auth);
    const q = auth.searchParams;
    const clientId = q.get('client_id') === DYNAMIC_CLIENT_ID ? fake.issuedClientId : q.get('client_id')!;
    const code = `fake-code-${randomBytes(6).toString('hex')}`;
    pending.set(code, { challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, clientId, nonce: q.get('nonce')! });
    const back = new URL(q.get('redirect_uri')!);
    back.search = new URLSearchParams({ code, state: opts.state ?? q.get('state')!, client_id: clientId, scope: opts.scope ?? q.get('scope')! }).toString();
    // Not awaited by the caller's flow: the browser lands on the callback on its own.
    void fetch(back).then((r) => r.text()).catch(() => undefined);
  };
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const credentialFile = () => join(tempDir('melch-chatgpt-'), 'state', 'chatgpt-signin.json');

async function signedIn(fake: FakeAuth, file = credentialFile()): Promise<string> {
  await signIn({ file, issuer: fake.issuer, openBrowser: fake.browser(), timeoutMs: 10_000 });
  return file;
}

/** Run `fn` with these variables set, restoring them after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A credential with fake tokens, written as the sign-in writes it. */
function fakeStored(file: string, extra: Partial<StoredSignIn> = {}): void {
  writeStoredSignIn(file, {
    version: 1,
    issuer: 'https://auth.openai.com',
    hostId: 'urn:uuid:test-host',
    clientId: 'app_test_issued_0001',
    subject: 'user-test-subject',
    scopes: ['openid', 'offline_access', PLAN_SCOPE],
    accessToken: 'fake-access-stored',
    refreshToken: 'fake-refresh-stored',
    expiresAt: Date.now() + 3_600_000,
    ...extra,
  });
}

const NO_KEY = { OPENAI_API_KEY: undefined, OPENAI_PLATFORM: undefined, OPENAI_BASE_URL: undefined, MELCHIZEDEK_CHATGPT_SIGNIN: undefined, MODEL_GATEWAY: undefined };

// ── Sign-in ──────────────────────────────────────────────────────────────────

test('sign-in: dynamic registration, PKCE S256, state and nonce, the plan scope; the code exchange proves the verifier', async () => {
  const fake = await fakeAuthServer();
  try {
    const file = credentialFile();
    const lines: string[] = [];
    const r = await signIn({ file, issuer: fake.issuer, openBrowser: fake.browser(), onUrl: (u) => lines.push(u), timeoutMs: 10_000 });
    assert.equal(r.subject, 'user-test-subject');
    assert.ok(r.planUsage);

    const auth = fake.authorizations[0].searchParams;
    assert.equal(auth.get('client_id'), DYNAMIC_CLIENT_ID);
    assert.equal(auth.get('agent_name_hint'), 'Melchizedek');
    assert.equal(auth.get('response_type'), 'code');
    assert.equal(auth.get('code_challenge_method'), 'S256');
    assert.match(auth.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
    assert.match(auth.get('state')!, /^[A-Za-z0-9_-]{43}$/);
    assert.match(auth.get('nonce')!, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(auth.get('scope')!.split(' ').includes(PLAN_SCOPE));
    assert.ok(auth.get('scope')!.split(' ').includes('offline_access'));
    assert.equal(auth.get('resource'), OPENAI_API_RESOURCE);
    assert.match(auth.get('ext_agent_host_id')!, /^urn:uuid:[0-9a-f-]{36}$/);
    assert.match(auth.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    assert.equal(lines[0], fake.authorizations[0].href, 'the printed link is the authorization URL');

    // The exchange: the issued client id, the verifier, the same redirect URI and resource.
    const form = fake.tokenForms[0];
    assert.equal(form.grant_type, 'authorization_code');
    assert.equal(form.client_id, fake.issuedClientId);
    assert.equal(createHash('sha256').update(form.code_verifier).digest('base64url'), auth.get('code_challenge'));
    assert.equal(form.redirect_uri, auth.get('redirect_uri'));
    assert.ok(!('client_secret' in form), 'a public client sends no secret');

    // Stored: mode 600 in a mode-700 directory, the issued client id and the host id kept.
    const stored = readStoredSignIn(file)!;
    assert.equal(stored.clientId, fake.issuedClientId);
    assert.equal(stored.hostId, auth.get('ext_agent_host_id'));
    assert.equal(stored.subject, 'user-test-subject');
    assert.ok(stored.accessToken && stored.refreshToken);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);

    // A second sign-in reuses the issued client id and the host id, and sends no name hint.
    await signIn({ file, issuer: fake.issuer, openBrowser: fake.browser(), timeoutMs: 10_000 });
    const again = fake.authorizations[1].searchParams;
    assert.equal(again.get('client_id'), fake.issuedClientId);
    assert.equal(again.get('agent_name_hint'), null);
    assert.equal(again.get('ext_agent_host_id'), auth.get('ext_agent_host_id'));
    assert.notEqual(again.get('state'), auth.get('state'), 'a fresh state per attempt');
    assert.notEqual(again.get('code_challenge'), auth.get('code_challenge'), 'a fresh verifier per attempt');
  } finally {
    await fake.close();
  }
});

test('sign-in: a callback with the wrong state is refused and never exchanged', async () => {
  const fake = await fakeAuthServer();
  try {
    const file = credentialFile();
    let refused: number | undefined;
    const browser = async (href: string) => {
      const q = new URL(href).searchParams;
      const back = new URL(q.get('redirect_uri')!);
      // Wrong path, then the wrong state: neither consumes the wait.
      assert.equal((await fetch(new URL('/elsewhere', back))).status, 404);
      back.search = new URLSearchParams({ code: 'fake-code-forged', state: 'not-the-state', client_id: fake.issuedClientId }).toString();
      refused = (await fetch(back)).status;
    };
    await assert.rejects(signIn({ file, issuer: fake.issuer, openBrowser: browser, timeoutMs: 500 }), (err: unknown) => err instanceof SignInError && err.code === 'timeout');
    assert.equal(refused, 400);
    assert.equal(fake.tokenForms.length, 0, 'the forged code never reached the token endpoint');
    assert.equal(readStoredSignIn(file)?.accessToken, undefined);
  } finally {
    await fake.close();
  }
});

test('sign-in: a grant without the plan scope stores no tokens', async () => {
  const fake = await fakeAuthServer();
  try {
    const file = credentialFile();
    // The person granted identity only: the token response's scope lacks the plan scope.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const res = await original(input, init);
      if (String(input).endsWith('/oauth/token')) {
        const body = (await res.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...body, scope: 'openid profile email offline_access' }), { status: res.status, headers: { 'content-type': 'application/json' } });
      }
      return res;
    }) as typeof fetch;
    try {
      await assert.rejects(signIn({ file, issuer: fake.issuer, openBrowser: fake.browser(), timeoutMs: 10_000 }), (e: unknown) => e instanceof SignInError && e.code === 'plan_not_granted');
    } finally {
      globalThis.fetch = original;
    }
    const s = readStoredSignIn(file)!;
    assert.equal(s.clientId, fake.issuedClientId, 'the registration is kept');
    assert.equal(s.accessToken, undefined);
  } finally {
    await fake.close();
  }
});

test('the issuer must be https off loopback', async () => {
  await assert.rejects(signIn({ file: credentialFile(), issuer: 'http://auth.example.test' }), (e: unknown) => e instanceof SignInError && e.code === 'bad_issuer');
});

// ── The file ─────────────────────────────────────────────────────────────────

test('the credential file: refused when readable by others, never written inside a git work tree', () => {
  const file = credentialFile();
  fakeStored(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  chmodSync(file, 0o644);
  assert.throws(() => readStoredSignIn(file), /readable by other users/);
  const status = withEnvSync({ MELCHIZEDEK_CHATGPT_SIGNIN_FILE: file, ...NO_KEY }, () => chatGptSignInRoutesOpenAi());
  assert.equal(status, false, 'an exposed file carries nothing');

  const repo = tempDir('melch-chatgpt-repo-');
  mkdirSync(join(repo, '.git'));
  assert.throws(() => fakeStored(join(repo, 'nested', 'chatgpt-signin.json')), /inside the git work tree/);
  assert.equal(existsSync(join(repo, 'nested', 'chatgpt-signin.json')), false);
});

function withEnvSync<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── Refresh and sign-out ─────────────────────────────────────────────────────

test('refresh: near expiry the token is refreshed and rotated, once for concurrent callers, and the file stays mode 600', async () => {
  const fake = await fakeAuthServer();
  try {
    const file = await signedIn(fake);
    const before = readStoredSignIn(file)!;
    // Still fresh: no refresh.
    assert.equal(await freshAccessToken(file, { issuer: fake.issuer }), before.accessToken);
    assert.equal(fake.tokenForms.length, 1);

    writeStoredSignIn(file, { ...before, expiresAt: Date.now() + 30_000 });
    fake.refreshDelayMs = 150;
    fake.refreshAnswer = 'ok-with-id';
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => freshAccessToken(file, { issuer: fake.issuer })));
    const refreshes = fake.tokenForms.filter((f) => f.grant_type === 'refresh_token');
    assert.equal(refreshes.length, 1, 'concurrent callers share one refresh');
    assert.equal(refreshes[0].client_id, fake.issuedClientId);
    assert.equal(refreshes[0].refresh_token, before.refreshToken);
    assert.equal(refreshes[0].resource, OPENAI_API_RESOURCE);
    assert.ok(!('scope' in refreshes[0]), 'a refresh keeps the granted scopes by omitting scope');
    assert.ok(a === b && b === c && a !== before.accessToken);
    const after = readStoredSignIn(file)!;
    assert.notEqual(after.refreshToken, before.refreshToken, 'the refresh token rotated');
    assert.deepEqual(after.scopes, before.scopes, 'an omitted scope keeps the granted ones');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(existsSync(`${file}.lock`), false, 'the lock is released');
  } finally {
    await fake.close();
  }
});

test('refresh: an unusable refresh token clears the tokens, keeps the registration, and asks for a new sign-in', async () => {
  const fake = await fakeAuthServer();
  try {
    const file = await signedIn(fake);
    const before = readStoredSignIn(file)!;
    writeStoredSignIn(file, { ...before, expiresAt: Date.now() - 1 });
    fake.refreshAnswer = 'invalid_grant';
    await assert.rejects(freshAccessToken(file, { issuer: fake.issuer }), (e: unknown) => e instanceof SignInError && e.code === 'signin_expired' && !String(e.message).includes('fake-'));
    const after = readStoredSignIn(file)!;
    assert.equal(after.accessToken, undefined);
    assert.equal(after.refreshToken, undefined);
    assert.equal(after.clientId, before.clientId);
    assert.equal(after.hostId, before.hostId);
    await assert.rejects(freshAccessToken(file, { issuer: fake.issuer }), (e: unknown) => e instanceof SignInError && e.code === 'not_signed_in');
  } finally {
    await fake.close();
  }
});

test('sign-out: the tokens leave the file and the refresh token is revoked', async () => {
  const fake = await fakeAuthServer();
  try {
    const file = await signedIn(fake);
    const refresh = readStoredSignIn(file)!.refreshToken!;
    const r = await signOut(file, { issuer: fake.issuer });
    assert.deepEqual(r, { hadTokens: true, revoked: true });
    assert.deepEqual(fake.revoked, [refresh]);
    const after = readStoredSignIn(file)!;
    assert.equal(after.refreshToken, undefined);
    assert.equal(after.clientId, fake.issuedClientId);
  } finally {
    await fake.close();
  }
});

// ── Routing and the adapter ──────────────────────────────────────────────────

test('routing: OpenAI ids run on the sign-in only with no key, no proxy and no platform, and never when switched off', async () => {
  const file = credentialFile();
  fakeStored(file);
  await withEnv({ ...NO_KEY, MELCHIZEDEK_CHATGPT_SIGNIN_FILE: file }, () => {
    assert.ok(resolveAdapter('gpt-5-mini') instanceof ChatGptSignInAdapter);
    assert.ok(!(resolveAdapter('gpt-5-mini', { apiKey: 'fixture-openai-caller' }) instanceof ChatGptSignInAdapter), "a caller's key wins");
  });
  for (const extra of [{ OPENAI_API_KEY: 'fixture-openai-0123' }, { OPENAI_BASE_URL: 'https://proxy.example.test/v1' }, { MELCHIZEDEK_CHATGPT_SIGNIN: 'off' }, { OPENAI_PLATFORM: 'azure' }]) {
    await withEnv({ ...NO_KEY, MELCHIZEDEK_CHATGPT_SIGNIN_FILE: file, ...extra }, () => {
      const a = resolveAdapter('gpt-5-mini');
      assert.ok(!(a instanceof ChatGptSignInAdapter), `not with ${Object.keys(extra)[0]}`);
      assert.ok(a instanceof GptAdapter);
    });
  }
});

interface Sent {
  url: string;
  headers: Headers;
  body: any;
}

/** A Responses API stub for api.openai.com; everything else goes to the real fetch (the fake auth server). */
async function withResponsesStub<T>(fn: (sent: Sent[]) => Promise<T>): Promise<T> {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.openai.com/')) return original(input, init);
    sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(init.body) });
    const reply = { id: 'resp_fixture', object: 'response', created_at: 0, model: 'gpt-5-mini', status: 'completed', output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello from the plan.', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } };
    const events = [
      { type: 'response.reasoning_summary_text.delta', delta: 'Thinking.' },
      { type: 'response.output_text.delta', delta: 'Hello from the plan.' },
      { type: 'response.completed', response: reply },
    ];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = original;
  }
}

async function collect(gen: AsyncGenerator<ModelResponse, void>): Promise<ModelResponse[]> {
  const out: ModelResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

const REQUEST: ModelRequest = {
  model: 'gpt-5-mini',
  system: 'Be brief.',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'Say hello.' }] }],
  sampling: { maxOutputTokens: 256, temperature: 0.2, topP: 0.9 },
} as ModelRequest;

test('the adapter: streamed, not stored, no sampling fields, the bearer only; a non-streamed call gets one final', async () => {
  resetServedSurfaceForTests();
  const file = credentialFile();
  fakeStored(file);
  await withEnv({ OPENAI_ORG_ID: 'org-should-not-be-sent', OPENAI_PROJECT_ID: 'proj-should-not-be-sent' }, () =>
    withResponsesStub(async (sent) => {
      const adapter = new ChatGptSignInAdapter({ model: 'gpt-5-mini', file });
      const out = await collect(adapter.generate(REQUEST));
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, 'https://api.openai.com/v1/responses');
      assert.equal(sent[0].headers.get('authorization'), 'Bearer fake-access-stored');
      assert.equal(sent[0].headers.get('openai-organization'), null);
      assert.equal(sent[0].headers.get('openai-project'), null);
      const body = sent[0].body;
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.instructions, 'Be brief.');
      for (const k of ['max_output_tokens', 'temperature', 'top_p']) assert.ok(!(k in body), `${k} is not sent`);
      // Not asked to stream: one thinking partial, then the final.
      assert.equal(out.length, 2);
      assert.deepEqual(out[0], { partial: true, parts: [{ type: 'thinking', text: 'Thinking.' }] });
      const final = out[1] as FinalModelResponse;
      assert.equal(final.partial, false);
      assert.equal(final.error, undefined);
      assert.deepEqual(final.parts.filter((p) => p.type === 'text').map((p: any) => p.text), ['Hello from the plan.']);
    }),
  );
});

test('the adapter: no sign-in is a MISSING_API_KEY final, and a served surface refuses before any token is read', async () => {
  resetServedSurfaceForTests();
  const missing = await collect(new ChatGptSignInAdapter({ model: 'gpt-5-mini', file: credentialFile() }).generate(REQUEST));
  assert.equal((missing.at(-1) as FinalModelResponse).error?.code, 'MISSING_API_KEY');

  const file = credentialFile();
  fakeStored(file);
  markServedSurface('a test server');
  try {
    await withResponsesStub(async (sent) => {
      const out = await collect(new ChatGptSignInAdapter({ model: 'gpt-5-mini', file }).generate(REQUEST));
      const final = out.at(-1) as FinalModelResponse;
      assert.equal(final.error?.code, 'CHATGPT_SIGNIN_LOCAL_ONLY');
      assert.equal(final.error?.retryable, false);
      assert.equal(sent.length, 0);
    });
  } finally {
    resetServedSurfaceForTests();
  }
});

// ── Served surfaces ──────────────────────────────────────────────────────────

test('served surfaces refuse to start while the sign-in is the OpenAI path', () => {
  const file = credentialFile();
  fakeStored(file);
  withEnvSync({ ...NO_KEY, MELCHIZEDEK_CHATGPT_SIGNIN_FILE: file }, () => {
    assert.throws(() => refuseChatGptSignInOnServedSurface('a test server'), /local only/);
  });
  resetServedSurfaceForTests();
  for (const extra of [{ OPENAI_API_KEY: 'fixture-openai-0123' }, { MELCHIZEDEK_CHATGPT_SIGNIN: 'off' }]) {
    withEnvSync({ ...NO_KEY, MELCHIZEDEK_CHATGPT_SIGNIN_FILE: file, ...extra }, () => refuseChatGptSignInOnServedSurface('a test server'));
    resetServedSurfaceForTests();
  }

  const env = { ...process.env, MELCHIZEDEK_DOTENV: 'off', MELCHIZEDEK_CHATGPT_SIGNIN_FILE: file, OPENAI_API_KEY: '', MODEL_GATEWAY: '', MELCHIZEDEK_RUNTIME: '' };
  delete (env as Record<string, string | undefined>).OPENAI_API_KEY;
  for (const script of ['scripts/a2a_server.ts', 'scripts/assistant_worker.ts']) {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', join(ROOT, script), ...(script.includes('worker') ? ['--once'] : ['syndicate.yaml'])], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 1, `${script} exits 1`);
    assert.match(r.stdout + r.stderr, /Sign in with ChatGPT is local only/, `${script} names the reason`);
    assert.ok(!(r.stdout + r.stderr).includes('fake-access-stored') && !(r.stdout + r.stderr).includes('fake-refresh-stored'), `${script} prints no token`);
  }
});

// ── The doctor ───────────────────────────────────────────────────────────────

test('the doctor reports the sign-in, and --check fails a served config that would run on it', () => {
  const file = credentialFile();
  fakeStored(file);
  const agentsDir = tempDir('melch-chatgpt-agents-');
  copyFileSync(join(ROOT, 'config', 'agents', 'templates', 'conversational.yaml'), join(agentsDir, 'conversational.yaml'));

  const SERVING = ['A2A_AUTH', 'A2A_SERVER_SECRET', 'A2A_CALLERS', 'A2A_JWT_ISSUER', 'A2A_JWT_AUDIENCE', 'A2A_JWT_JWKS_URL', 'A2A_JWT_SECRET', 'A2A_TRUSTED_USER_HEADER', 'A2A_KEY_MODE', 'PUBLIC_URL'];
  const clear = Object.fromEntries(SERVING.map((k) => [k, undefined]));
  const local = withEnvSync({ ...NO_KEY, ...clear, MELCHIZEDEK_CHATGPT_SIGNIN_FILE: file }, () => runDoctor({ agentsDir }));
  assert.equal(local.counts.blocked, 0, 'control: the keyless template is not blocked');
  assert.ok(local.chatgpt?.routesOpenAi);
  assert.deepEqual(local.chatgpt?.problems, []);
  assert.deepEqual(checkProblems(local), []);
  assert.equal(local.providers.find((p) => p.provider === 'openai')?.credential, 'chatgpt-signin');
  const text = renderDoctor(local);
  assert.match(text, /chatgpt .*signed in · carries OpenAI ids · local only/);
  assert.ok(!text.includes('fake-access-stored') && !text.includes('fake-refresh-stored'));

  const served = withEnvSync({ ...NO_KEY, ...clear, MELCHIZEDEK_CHATGPT_SIGNIN_FILE: file, A2A_SERVER_SECRET: 'test-only-secret-test-only-secret-0000' }, () => runDoctor({ agentsDir }));
  assert.ok(served.chatgpt?.problems.some((p) => p.includes('local only')));
  assert.ok(checkProblems(served).some((p) => p.startsWith('chatgpt: ')));

  // The bin: --check exits 1 on the served config, 0 locally.
  const run = (extra: Record<string, string>) => {
    const env: Record<string, string | undefined> = { ...process.env, MELCHIZEDEK_DOTENV: 'off', MELCHIZEDEK_AGENTS_DIR: agentsDir, MELCHIZEDEK_CHATGPT_SIGNIN_FILE: file, MODEL_GATEWAY: '', MELCHIZEDEK_RUNTIME: '', ...extra };
    for (const k of [...SERVING, 'OPENAI_API_KEY']) if (!(k in extra)) delete env[k];
    return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', join(ROOT, 'scripts', 'doctor.ts'), '--check', '--no-color'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  };
  const ok = run({});
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = run({ A2A_SERVER_SECRET: 'test-only-secret-test-only-secret-0000' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /Sign in with ChatGPT is local only/);
});

test('the template documents the variables by name only', () => {
  const template = readFileSync(join(ROOT, '.env.example'), 'utf-8');
  assert.match(template, /^# MELCHIZEDEK_CHATGPT_SIGNIN_FILE=/m);
  assert.match(template, /^# MELCHIZEDEK_CHATGPT_SIGNIN=off/m);
  // No stored credential anywhere in the repository's own paths.
  assert.equal(existsSync(join(ROOT, 'chatgpt-signin.json')), false);
});
