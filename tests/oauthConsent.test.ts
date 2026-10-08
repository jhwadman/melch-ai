/**
 * tests/oauthConsent.test.ts — the consent step for a tool's OAuth grant
 * (WS6-3b, ADR 0085), offline: a mock provider (authorization and token
 * endpoints, and an API, on a local HTTP server in this test), the A2A
 * server on an ephemeral port, scripted models, the native runtime.
 *
 * End to end: a tool whose provider the user has not granted pauses the task
 * input-required with a `consent_request` data part; the "browser" follows the
 * authorization URL to the mock provider and back to the callback route,
 * which exchanges the code with PKCE and stores the grant, sealed; the next
 * message resumes the paused call, which runs once. Then the refusals: a
 * replayed, expired, cross-user, tampered or denied state, and the token in
 * no event, log line, audit row, page or model request.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySessionService, LogLevel, setLogLevel } from '@google/adk';
import { z } from 'zod';

import express from 'express';

import { consentCallback, createA2AApp } from '../lib/a2a/app.ts';
import { adkShim } from '../lib/models/adkShim.ts';
import type { AuditEvent } from '../lib/observability/audit.ts';
import { pendingConsent } from '../lib/runtime/credentials.ts';
import { UnsupportedOnRuntimeError, runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { aesGcmCipher } from '../lib/tools/credentialCipher.ts';
import { credentialStore, memoryCredentialRows } from '../lib/tools/credentialStore.ts';
import { ConsentError, memoryConsentStates, oauthConsent, s256Challenge } from '../lib/tools/oauthConsent.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall } from './helpers/scriptedModel.ts';

setLogLevel(LogLevel.ERROR);

// ── The mock provider ────────────────────────────────────────────────────────

const CLIENT_ID = 'melch-test-client';
const CLIENT_SECRET = `fake-client-secret-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)

interface Issued {
  challenge: string;
  redirectUri: string;
  used: boolean;
}

/** An OAuth provider in miniature: it checks what a real one checks, and records what it saw. */
class MockProvider {
  readonly codes = new Map<string, Issued>();
  readonly accessTokens = new Set<string>();
  readonly refreshTokens = new Set<string>();
  readonly verifiers: string[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  base = '';
  server?: Server;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    if (req.method === 'GET' && url.pathname === '/authorize') {
      // The person consents: the provider redirects back with a code bound to the challenge.
      const q = url.searchParams;
      const ok = q.get('response_type') === 'code' && q.get('client_id') === CLIENT_ID && q.get('code_challenge_method') === 'S256' && !!q.get('code_challenge') && !!q.get('state') && !!q.get('redirect_uri');
      if (!ok) return void res.writeHead(400).end('bad authorization request');
      const code = `fake-code-${randomBytes(12).toString('hex')}`;
      this.codes.set(code, { challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, used: false });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state')!);
      return void res.writeHead(302, { Location: back.toString() }).end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      this.tokenRequests.push(form);
      const issued = this.codes.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      this.verifiers.push(verifier);
      const valid =
        form.get('grant_type') === 'authorization_code' &&
        form.get('client_id') === CLIENT_ID &&
        form.get('client_secret') === CLIENT_SECRET &&
        !!issued &&
        !issued.used &&
        form.get('redirect_uri') === issued.redirectUri &&
        createHash('sha256').update(verifier).digest('base64url') === issued.challenge;
      if (!valid) return void res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant', error_description: `bad code ${form.get('code')}` }));
      issued!.used = true;
      const accessToken = `fake-access-${randomBytes(12).toString('hex')}`;
      const refreshToken = `fake-refresh-${randomBytes(12).toString('hex')}`;
      this.accessTokens.add(accessToken);
      this.refreshTokens.add(refreshToken);
      return void res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600, scope: 'repo:read' }));
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!this.accessTokens.has(token)) return void res.writeHead(401).end('{}');
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ login: 'alice-gh' }));
    }
    res.writeHead(404).end();
  }

  /** Every value that must never leave the server's credential store. */
  secrets(): string[] {
    return [...this.accessTokens, ...this.refreshTokens, ...this.codes.keys(), ...this.verifiers.filter(Boolean), CLIENT_SECRET];
  }
}

const provider = new MockProvider();

// ── The tool ─────────────────────────────────────────────────────────────────

/** Runs of the tool that reached the provider with a token (what "the resumed call runs once" counts). */
let authorizedRuns = 0;
let allRuns = 0;
registerTool(
  'gh_whoami',
  defineTool({
    name: 'gh_whoami',
    description: 'Who the user is on GitHub.',
    schema: z.object({}),
    execute: async (_args, ctx) => {
      allRuns += 1;
      if (!ctx.accessToken) return 'no credential store';
      const token = await ctx.accessToken('github');
      authorizedRuns += 1;
      const res = await fetch(`${provider.base}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
      const me = (await res.json()) as { login?: string };
      return `logged in as ${me.login}`;
    },
  }),
  { override: true },
);

const boss = new ScriptedModel('scripted/boss', (req) => {
  const last = lastToolResult(req);
  const text = typeof last?.result === 'string' ? last.result : JSON.stringify(last?.result ?? '');
  return /logged in as/.test(text) ? answer(`You are ${text.replace('logged in as ', '')} on GitHub.`) : toolCall('gh_whoami', {}, 'call-gh');
});

// ── The server ───────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'melch-consent-'));
writeFileSync(
  join(dir, 'desk.yaml'),
  ['syndicate_name: Desk', 'orchestrator:', '  name: Boss', '  model: scripted/boss', '  instruction: Help.', '  tools: [gh_whoami]', 'subagents: []'].join('\n'),
);
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

/** Callers by bearer token: the A2A identity plug point, and what the callback consults. */
const CALLERS: Record<string, string> = { 'tok-alice': 'alice', 'tok-mallory': 'mallory' };

const sessions = new InMemorySessionService();
const rows = memoryCredentialRows();
const audits: AuditEvent[] = [];
const store = credentialStore({ rows, cipher: aesGcmCipher(randomBytes(32)), audit: (e) => audits.push(e) });
const logs: string[] = [];
let server: Server;
let base = '';
const savedRuntime = process.env.MELCHIZEDEK_RUNTIME;

before(async () => {
  process.env.MELCHIZEDEK_RUNTIME = 'native';
  await provider.start();
  // The redirect URI names the server's own port, so the port is taken first.
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const consent = oauthConsent({
    providers: {
      github: { authorizationUrl: `${provider.base}/authorize`, tokenUrl: `${provider.base}/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, scopes: ['repo:read'] },
    },
    redirectUri: `${base}/oauth/callback`,
    credentials: store,
    audit: (e) => audits.push(e),
  });
  const built = await createA2AApp({
    defaultSyndicate: 'desk.yaml',
    storage: { sessionService: sessions },
    resolveRequest: (req) => {
      const user = CALLERS[(req.headers.authorization ?? '').replace(/^Bearer /, '')];
      return user ? { scopeKey: user, caller: user } : undefined;
    },
    identityScheme: { type: 'bearer', description: 'test callers' },
    toolCredentials: { store, consent },
    resolveModel: () => adkShim(boss),
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
  });
  server.on('request', built.app);
});

after(() => {
  server?.close();
  provider.server?.close();
  if (savedRuntime === undefined) delete process.env.MELCHIZEDEK_RUNTIME;
  else process.env.MELCHIZEDEK_RUNTIME = savedRuntime;
});

async function send(text: string, ids: { contextId?: string; taskId?: string } = {}, token = 'tok-alice'): Promise<any> {
  const res = await fetch(`${base}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text }], ...ids } },
    }),
  });
  const body = (await res.json()) as any;
  assert.ok(body.result, JSON.stringify(body.error ?? body));
  return body.result;
}

const statusText = (task: any) => (task.status?.message?.parts ?? []).map((p: any) => p.text ?? '').join('');
const dataPart = (task: any) => (task.status?.message?.parts ?? []).find((p: any) => p.kind === 'data')?.data;

/** The person consents at the provider: the provider's redirect, as a browser would follow it, to the callback URL. */
async function consentAtProvider(authorizationUrl: string): Promise<URL> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(res.status, 302, 'the provider redirects back');
  return new URL(res.headers.get('location')!);
}

async function callback(url: URL | string, token?: string): Promise<{ status: number; page: string; headers: Headers }> {
  const res = await fetch(url, { redirect: 'manual', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
  return { status: res.status, page: await res.text(), headers: res.headers };
}

async function storedEvents(contextId: string): Promise<unknown[]> {
  const session = await sessions.getSession({ appName: 'melchizedek-a2a', userId: 'alice', sessionId: contextId });
  return (session?.events ?? []) as unknown[];
}

/** A paused task, freshly opened for alice. */
async function pausedTask(): Promise<{ task: any; request: any }> {
  const task = await send('who am I on github?');
  assert.equal(task.status.state, 'input-required', statusText(task));
  return { task, request: dataPart(task) };
}

// ── End to end ───────────────────────────────────────────────────────────────

test('a call without a grant pauses; the callback completes the flow with PKCE; the next message resumes the call once', async () => {
  const callsBefore = boss.calls;
  const { task: first, request } = await pausedTask();
  assert.equal(request.type, 'consent_request');
  assert.equal(request.provider, 'github');
  assert.equal(request.agent, 'Boss');
  assert.deepEqual(request.scopes, ['repo:read']);
  assert.ok(request.consent_id.startsWith('adk-'), 'the request is ADK\'s own adk_request_credential call');
  assert.match(request.state, /^[A-Za-z0-9_-]{43}$/);
  const auth = new URL(request.authorization_url);
  assert.equal(auth.origin + auth.pathname, `${provider.base}/authorize`);
  assert.equal(auth.searchParams.get('state'), request.state);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), `${base}/oauth/callback`);
  assert.equal(auth.searchParams.get('client_secret'), null, 'no secret in the URL');
  assert.equal(auth.searchParams.get('code_verifier'), null, 'no verifier in the URL');
  assert.match(statusText(first), /Authorization needed: Boss needs access to your github account/);
  assert.equal(allRuns, 1);
  assert.equal(authorizedRuns, 0);
  assert.equal(boss.calls - callsBefore, 1, 'one model call before the pause');

  // A message before the grant repeats the request and runs nothing.
  const early = await send('done', { contextId: first.contextId, taskId: first.id });
  assert.equal(early.status.state, 'input-required');
  assert.equal(dataPart(early).consent_id, request.consent_id);
  assert.equal(boss.calls - callsBefore, 1, 'no model call');
  assert.equal(allRuns, 1, 'no tool run');

  // The browser: consent at the provider, then the callback. A redirect_uri the request carries is ignored.
  const back = await consentAtProvider(request.authorization_url);
  assert.equal(back.origin + back.pathname, `${base}/oauth/callback`);
  back.searchParams.set('redirect_uri', 'https://evil.example/steal');
  const done = await callback(back);
  assert.equal(done.status, 200, done.page);
  assert.match(done.page, /Authorization complete/);
  assert.equal(done.headers.get('cache-control'), 'no-store');
  assert.equal(done.headers.get('referrer-policy'), 'no-referrer');
  const exchange = provider.tokenRequests.at(-1)!;
  assert.equal(exchange.get('redirect_uri'), `${base}/oauth/callback`, 'the configured redirect URI, not the request\'s');
  assert.ok(exchange.get('code_verifier'), 'the verifier went to the token endpoint');
  assert.equal(s256Challenge(exchange.get('code_verifier')!), auth.searchParams.get('code_challenge'));

  // Stored sealed.
  const [row] = rows.all();
  assert.equal(row?.provider, 'github');
  assert.equal(row?.userId, 'alice');
  assert.equal(row?.appName, 'melchizedek-a2a', 'the run\'s pinned app');
  assert.ok(row?.accessTokenEnc.startsWith('mzc1.') && row.refreshTokenEnc?.startsWith('mzc1.'));
  for (const s of provider.secrets()) assert.ok(!JSON.stringify(row).includes(s), 'the row holds ciphertext only');

  // The next message resumes the paused call, which now reads the grant.
  const resumed = await send('done', { contextId: first.contextId, taskId: first.id });
  assert.equal(resumed.status.state, 'completed', statusText(resumed));
  assert.match(statusText(resumed), /You are alice-gh on GitHub/);
  assert.equal(authorizedRuns, 1, 'the resumed call ran once');
  assert.equal(allRuns, 2);
  assert.equal(boss.calls - callsBefore, 2, 'one model step after the resume');
  // The step after the resume reads the call and its one answer: the pending notice is not left beside it.
  const afterResume = boss.requests[callsBefore + 1]!;
  const results = afterResume.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts);
  assert.equal(results.length, 1, JSON.stringify(results));
  assert.match(JSON.stringify(results[0]), /logged in as alice-gh/);

  // A further message runs nothing from before again.
  const later = await send('thanks', { contextId: first.contextId });
  assert.equal(later.status.state, 'completed', statusText(later));
  assert.equal(authorizedRuns, 1, 'the paused call did not run again');
  assert.equal(allRuns, 2);

  // The stored events: ADK's request shape, and no value anywhere.
  const events = await storedEvents(first.contextId);
  const json = JSON.stringify(events);
  for (const s of provider.secrets()) assert.ok(!json.includes(s), 'no token, code, verifier or client secret in any event');
  const opened = (events as any[]).find((e) => e.content?.parts?.some((p: any) => p.functionCall?.name === 'adk_request_credential'));
  const call = opened.content.parts[0].functionCall;
  assert.equal(call.args.function_call_id, 'call-gh');
  assert.equal(call.args.auth_config.credentialKey, 'github');
  assert.equal(call.args.auth_config.exchangedAuthCredential.oauth2.state, request.state);
  assert.deepEqual(opened.longRunningToolIds, [call.id]);
  const resumedResponses = (events as any[]).flatMap((e) => (e.content?.parts ?? []).filter((p: any) => p.functionResponse?.id === 'call-gh'));
  assert.equal(resumedResponses.length, 2, 'the pending answer, then the resumed one');
  assert.match(JSON.stringify(resumedResponses[1]), /logged in as alice-gh/);

  // Not in a model request, a log line or an audit row either.
  const requests = JSON.stringify(boss.requests);
  for (const s of provider.secrets()) assert.ok(!requests.includes(s), 'no value in a model request');
  for (const s of [...provider.secrets(), request.state]) {
    assert.ok(!logs.some((l) => l.includes(s)), 'no value or state in a log line');
    assert.ok(!JSON.stringify(audits).includes(s), 'no value or state in an audit row');
    assert.ok(!done.page.includes(s), 'no value or state in the page');
  }
  assert.ok(audits.some((a) => a.event === 'consent.callback' && a.outcome === 'ok'));
  assert.ok(audits.some((a) => a.event === 'credential.put'));

  // Replayed: the same callback again is refused, and stores nothing new.
  const replay = await callback(back);
  assert.equal(replay.status, 400);
  assert.match(replay.page, /not valid, or was already used/);
  assert.equal(rows.all().length, 1);
});

// ── Refusals at the callback ─────────────────────────────────────────────────

test('a tampered state, a cross-user callback and a declined consent are refused, and store nothing', async () => {
  await store.eraseUser('alice');
  const { request } = await pausedTask();
  const back = await consentAtProvider(request.authorization_url);
  const state = back.searchParams.get('state')!;

  // Tampered: one character changed.
  const tampered = new URL(back);
  tampered.searchParams.set('state', `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`);
  const t = await callback(tampered);
  assert.equal(t.status, 400);
  assert.match(t.page, /not valid/);
  // Malformed parameters.
  assert.equal((await callback(`${base}/oauth/callback?state=short&code=x`)).status, 400);
  assert.equal((await callback(`${base}/oauth/callback`)).status, 400);

  // Cross-user: mallory's browser carries mallory's credential.
  const cross = await callback(back, 'tok-mallory');
  assert.equal(cross.status, 403);
  assert.match(cross.page, /belongs to another user/);
  // The attempt spent the state: the right user cannot complete it either.
  assert.equal((await callback(back, 'tok-alice')).status, 400);
  assert.equal(rows.all().length, 0, 'nothing stored');

  // Declined at the provider.
  const second = await pausedTask();
  const declined = new URL(`${base}/oauth/callback`);
  declined.searchParams.set('state', second.request.state);
  declined.searchParams.set('error', 'access_denied');
  const d = await callback(declined);
  assert.equal(d.status, 400);
  assert.match(d.page, /declined/);
  assert.equal(rows.all().length, 0);

  // The token endpoint refuses the code: the provider's message (it echoes the code) is not shown.
  const third = await pausedTask();
  const bad = new URL(`${base}/oauth/callback`);
  bad.searchParams.set('state', third.request.state);
  bad.searchParams.set('code', 'fake-code-never-issued');
  const b = await callback(bad);
  assert.equal(b.status, 502);
  assert.ok(!b.page.includes('fake-code-never-issued'));
  assert.ok(!logs.some((l) => l.includes('fake-code-never-issued')));
  assert.equal(rows.all().length, 0);
});

test('an expired state is refused; a state is single-use; the configuration refuses an unsafe endpoint', async () => {
  let clock = 1_000_000;
  const local = credentialStore({ rows: memoryCredentialRows(), cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({
    providers: { github: { authorizationUrl: `${provider.base}/authorize`, tokenUrl: `${provider.base}/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } },
    redirectUri: 'https://agents.example.com/oauth/callback',
    credentials: local,
    ttlMs: 60_000,
    now: () => clock,
  });
  const binding = { appName: 'Desk', userId: 'alice', sessionId: 's1', functionCallId: 'call-1', provider: 'github' };
  const begun = await consent.begin(binding);
  clock += 60_001;
  await assert.rejects(consent.complete({ state: begun.state, code: 'fake-code' }), (e: unknown) => e instanceof ConsentError && e.code === 'expired');
  await assert.rejects(consent.complete({ state: begun.state, code: 'fake-code' }), (e: unknown) => e instanceof ConsentError && e.code === 'unknown_state');
  await assert.rejects(consent.begin({ ...binding, provider: 'gitlab' }), (e: unknown) => e instanceof ConsentError && e.code === 'unknown_provider');
  const again = await consent.begin(binding);
  await assert.rejects(consent.complete({ state: again.state, code: 'fake-code', callerUserId: 'mallory' }), (e: unknown) => e instanceof ConsentError && e.code === 'wrong_user');
  // The stored request carries no secret and no verifier.
  const config = JSON.stringify(again.authConfig);
  assert.ok(!config.includes(CLIENT_SECRET));
  assert.ok(!/verifier/i.test(config));

  const states = memoryConsentStates({ max: 2 });
  const flow = { ...binding, codeVerifier: 'v', scopes: [], expiresAt: Date.now() + 1000 };
  await states.put('a', flow);
  await states.put('b', flow);
  await states.put('c', flow);
  assert.equal(states.size(), 2, 'bounded: the oldest flow is dropped');
  assert.equal(await states.take('a'), undefined);
  assert.ok(await states.take('b'));
  assert.equal(await states.take('b'), undefined, 'single-use');

  const base = { providers: {}, credentials: local };
  assert.throws(() => oauthConsent({ ...base, redirectUri: 'http://agents.example.com/cb' }), /https/);
  assert.throws(() => oauthConsent({ ...base, redirectUri: 'https://agents.example.com/cb?x=1' }), /query/);
  assert.throws(
    () => oauthConsent({ ...base, redirectUri: 'https://a.example/cb', providers: { github: { authorizationUrl: 'http://evil.example/a', tokenUrl: 'https://p.example/t', clientId: 'c' } } }),
    /https/,
  );
  assert.throws(
    () => oauthConsent({ ...base, redirectUri: 'https://a.example/cb', providers: { github: { authorizationUrl: 'https://p.example/a', tokenUrl: 'https://p.example/t', clientId: 'c', authorizationParams: { redirect_uri: 'x' } } } }),
    /may not set/,
  );
});

test('behind a server secret the callback asks the authenticator only once the bearer matches; requireCallerIdentity refuses without one', async () => {
  const seen: Array<string | undefined> = [];
  const stub = {
    complete: async (input: { callerUserId?: string }) => {
      seen.push(input.callerUserId);
      return { appName: 'a', userId: 'alice', sessionId: 's', functionCallId: 'c', provider: 'github' };
    },
  };
  // A trusted-header authenticator believes whoever reaches it, so the header alone must not count.
  const resolveRequest = (req: any) => (req.headers['x-user'] ? { scopeKey: String(req.headers['x-user']) } : undefined);
  const secret = 'test-secret-0123456789abcdef'; // gitleaks:allow (test fixture)
  const app = express();
  app.get('/cb', consentCallback(stub, { resolveRequest, serverSecret: secret }));
  app.get('/strict', consentCallback(stub, { resolveRequest, serverSecret: secret, requireCallerIdentity: true }));
  const s: Server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  try {
    const addr = s.address();
    const at = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    assert.equal((await fetch(`${at}/cb`, { headers: { 'x-user': 'mallory' } })).status, 200);
    assert.equal((await fetch(`${at}/cb`, { headers: { 'x-user': 'alice', Authorization: `Bearer ${secret}` } })).status, 200);
    assert.deepEqual(seen, [undefined, 'alice'], 'the spoofable header counted only behind the secret');
    assert.equal((await fetch(`${at}/strict`, { headers: { 'x-user': 'alice' } })).status, 401);
    assert.equal(seen.length, 2, 'a refused callback reaches no flow');
  } finally {
    s.close();
  }
});

// ── Runtimes ─────────────────────────────────────────────────────────────────

test('a consent opened on native is refused on the ADK runtime, with UnsupportedOnRuntimeError, before any model call', async () => {
  const sessionService = new InMemorySessionService();
  const config = {
    syndicate_name: 'Desk',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Help.', tools: ['gh_whoami'] },
    subagents: [],
  } as unknown as SyndicateYamlConfig;
  const local = credentialStore({ rows: memoryCredentialRows(), cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({
    providers: { github: { authorizationUrl: `${provider.base}/authorize`, tokenUrl: `${provider.base}/token`, clientId: CLIENT_ID } },
    redirectUri: 'https://agents.example.com/oauth/callback',
    credentials: local,
  });
  const model = new ScriptedModel('scripted/boss', () => toolCall('gh_whoami', {}, 'call-gh'));
  const turn = (runtime: 'adk' | 'native') =>
    runSyndicateTurn({
      config,
      parts: [{ text: 'who am I?' }],
      appName: 'Desk',
      userId: 'bob',
      sessionId: 'rt',
      sessionService,
      compile: { resolveModel: shimResolver({ boss: model }), log: () => {} },
      trace: false,
      runtime,
      toolCredentials: { store: local, consent },
    });
  const paused = await turn('native');
  assert.equal(paused.status, 'input-required');
  assert.equal(paused.consent?.provider, 'github');
  assert.equal(paused.consent?.functionCallId, 'call-gh');
  const session = await sessionService.getSession({ appName: 'Desk', userId: 'bob', sessionId: 'rt' });
  assert.equal(pendingConsent(session?.events ?? [])?.id, paused.consent?.id);
  const calls = model.calls;
  await assert.rejects(turn('adk'), (e: unknown) => e instanceof UnsupportedOnRuntimeError && /adk_request_credential/.test(e.message));
  assert.equal(model.calls, calls, 'no model call');
});
