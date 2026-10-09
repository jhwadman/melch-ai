/**
 * tests/oauthDiscovery.test.ts — OAuth for an MCP server with no pre-issued
 * client (ADR 0124): protected-resource metadata (RFC 9728), authorization
 * server metadata (RFC 8414), dynamic client registration (RFC 7591), PKCE
 * S256 and the RFC 8707 resource parameter, against a fake authorization
 * server in this process. Offline.
 *
 * Covers: discovery from the MCP server's metadata, and from its origin when
 * it has none; a discovered host outside the operator's allowlist refused by
 * name before any request reaches it (the issuer, the token endpoint); an
 * authorization server without S256 or without a registration endpoint
 * refused; the consent flow with a registered client end to end; the
 * registration kept sealed in the credential store's rows and reused; the
 * YAML key and where it may stand; the server binary's setup wiring.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
for (const name of ['MELCHIZEDEK_OAUTH_HOSTS', 'MELCHIZEDEK_CREDENTIAL_KEY', 'OAUTH_REDIRECT_URI', 'MELCHIZEDEK_CREDENTIAL_HOSTS']) delete process.env[name];

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import express from 'express';

import { oauthServerSetup } from '../lib/a2a/oauthSetup.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { aesGcmCipher } from '../lib/tools/credentialCipher.ts';
import { credentialStore, memoryCredentialRows } from '../lib/tools/credentialStore.ts';
import { oauthConsent } from '../lib/tools/oauthConsent.ts';
import {
  OAuthDiscoveryError,
  REGISTERED_CLIENTS_APP,
  authorizationServerMetadataUrls,
  canonicalResource,
  discoverAuthorization,
  dynamicOAuthClient,
  oauthClientRegistry,
  protectedResourceMetadataUrls,
} from '../lib/tools/oauthDiscovery.ts';
import { dynamicOAuthGrantsFor, oauthClientsFor, oauthRefreshProviders } from '../lib/tools/oauthTools.ts';

const REDIRECT = 'http://127.0.0.1:1/oauth/callback';
const ALLOW = { tracker: ['127.0.0.1'] };

let http: HttpServer;
let base = ''; // http://127.0.0.1:<port>: the allowlisted host
let foreign = ''; // http://localhost:<port>: the same server under a host the allowlist does not name

/** Every request, as `<host> <method> <path>`. */
const seen: string[] = [];
const registrations: Array<Record<string, unknown>> = [];
const tokenRequests: URLSearchParams[] = [];
const clients = new Set<string>();
const codes = new Map<string, { challenge: string; resource: string; clientId: string }>();

/** One authorization server's metadata under `/as<variant>`, with `overrides`. */
const asMetadata = (variant: string, overrides: Record<string, unknown> = {}) => ({
  issuer: `${base}/as${variant}`,
  authorization_endpoint: `${base}/as/authorize`,
  token_endpoint: `${base}/as/token`,
  registration_endpoint: `${base}/as/register`,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  ...overrides,
});

before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    seen.push(`${req.hostname} ${req.method} ${req.path}`);
    next();
  });
  // The MCP servers' protected-resource metadata (RFC 9728), one per variant.
  const prm = (resourcePath: string, issuer: () => string) =>
    app.get(`/.well-known/oauth-protected-resource${resourcePath}`, (_req, res) => void res.json({ resource: `${base}${resourcePath}`, authorization_servers: [issuer()] }));
  prm('/mcp', () => `${base}/as`);
  prm('/foreign-as/mcp', () => `${foreign}/as`);
  prm('/foreign-token/mcp', () => `${base}/as-foreign-token`);
  prm('/plain/mcp', () => `${base}/as-plain`);
  prm('/noreg/mcp', () => `${base}/as-noreg`);
  app.get('/.well-known/oauth-protected-resource/mismatch/mcp', (_req, res) => void res.json({ resource: `${base}/elsewhere`, authorization_servers: [`${base}/as`] }));
  // The authorization servers' metadata (RFC 8414 with a path: the path after the well-known segment).
  app.get('/.well-known/oauth-authorization-server/as', (_req, res) => void res.json(asMetadata('')));
  app.get('/.well-known/oauth-authorization-server/as-foreign-token', (_req, res) => void res.json(asMetadata('-foreign-token', { token_endpoint: `${foreign}/as/token` })));
  app.get('/.well-known/oauth-authorization-server/as-plain', (_req, res) => void res.json(asMetadata('-plain', { code_challenge_methods_supported: ['plain'] })));
  app.get('/.well-known/oauth-authorization-server/as-noreg', (_req, res) => {
    const { registration_endpoint: _drop, ...rest } = asMetadata('-noreg');
    res.json(rest);
  });
  // An MCP server with no protected-resource metadata: its origin is its authorization server (MCP 2025-03-26).
  app.get('/.well-known/oauth-authorization-server', (_req, res) => void res.json({ ...asMetadata(''), issuer: base }));

  app.post('/as/register', express.json(), (req, res) => {
    registrations.push(req.body as Record<string, unknown>);
    const clientId = `dyn-${randomBytes(6).toString('hex')}`;
    clients.add(clientId);
    res.status(201).json({ ...req.body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
  });
  app.get('/as/authorize', (req, res) => {
    if (!clients.has(String(req.query.client_id))) return void res.status(400).send('unknown client');
    const code = `code-${randomBytes(8).toString('hex')}`;
    codes.set(code, { challenge: String(req.query.code_challenge), resource: String(req.query.resource ?? ''), clientId: String(req.query.client_id) });
    const back = new URL(String(req.query.redirect_uri));
    back.searchParams.set('code', code);
    back.searchParams.set('state', String(req.query.state));
    res.redirect(302, back.toString());
  });
  app.post('/as/token', express.urlencoded({ extended: false }), (req, res) => {
    const form = new URLSearchParams(req.body as Record<string, string>);
    tokenRequests.push(form);
    const issued = codes.get(String(form.get('code')));
    if (!issued || issued.clientId !== form.get('client_id')) return void res.status(400).json({ error: 'invalid_grant' });
    if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== issued.challenge) return void res.status(400).json({ error: 'invalid_grant' });
    if (form.get('resource') !== issued.resource) return void res.status(400).json({ error: 'invalid_target' });
    codes.delete(String(form.get('code')));
    res.json({ access_token: `fake-user-${randomBytes(8).toString('hex')}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `fake-refresh-${randomBytes(8).toString('hex')}` });
  });
  http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  foreign = `http://localhost:${port}`;
});

after(() => {
  http?.closeAllConnections?.();
  http?.close();
});

const discover = (path: string, allowlist: Record<string, string[]> | null = ALLOW) => discoverAuthorization(`${base}${path}`, { provider: 'tracker', allowPrivate: true, allowlist });

// ── Discovery ────────────────────────────────────────────────────────────────

test('the well-known URLs, in the order the specs give', () => {
  assert.deepEqual(protectedResourceMetadataUrls('https://mcp.example.com/v1/mcp').map(String), [
    'https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp',
    'https://mcp.example.com/.well-known/oauth-protected-resource',
  ]);
  assert.deepEqual(authorizationServerMetadataUrls('https://auth.example.com/tenant').map(String), [
    'https://auth.example.com/.well-known/oauth-authorization-server/tenant',
    'https://auth.example.com/.well-known/openid-configuration/tenant',
    'https://auth.example.com/tenant/.well-known/openid-configuration',
  ]);
  assert.deepEqual(authorizationServerMetadataUrls('https://auth.example.com').map(String), [
    'https://auth.example.com/.well-known/oauth-authorization-server',
    'https://auth.example.com/.well-known/openid-configuration',
  ]);
  assert.equal(canonicalResource('https://MCP.example.com/mcp/#frag'), 'https://mcp.example.com/mcp');
  assert.equal(canonicalResource('https://mcp.example.com/'), 'https://mcp.example.com');
});

test("discovery follows the MCP server's protected-resource metadata to its authorization server", async () => {
  const found = await discover('/mcp');
  assert.deepEqual(found, {
    resource: `${base}/mcp`,
    issuer: `${base}/as`,
    authorizationEndpoint: `${base}/as/authorize`,
    tokenEndpoint: `${base}/as/token`,
    registrationEndpoint: `${base}/as/register`,
  });
});

test('a server with no protected-resource metadata is its own authorization server', async () => {
  const found = await discover('/legacy/mcp');
  assert.equal(found.issuer, base);
  assert.equal(found.resource, `${base}/legacy/mcp`);
});

test('a discovered host outside the allowlist is refused by name, and no request reaches it', async () => {
  seen.length = 0;
  await assert.rejects(discover('/foreign-as/mcp'), (e: unknown) => e instanceof OAuthDiscoveryError && /localhost \(authorization server metadata\) is not one of them/.test(e.message) && /never widens/.test(e.message));
  assert.ok(!seen.some((s) => s.startsWith('localhost ')), `no request to the foreign host: ${seen.join(', ')}`);
  await assert.rejects(discover('/foreign-token/mcp'), /localhost \(token_url\) is not one of them/);
  assert.ok(!seen.some((s) => s.includes('/as/register')), 'nothing was registered');
  // The MCP server itself must be allowlisted too, and with no allowlist an authorization_code grant is refused outright.
  await assert.rejects(discoverAuthorization(`${foreign}/mcp`, { provider: 'tracker', allowPrivate: true, allowlist: ALLOW }), /localhost \(protected-resource metadata\) is not one of them/);
  await assert.rejects(discover('/mcp', null), /binds the provider to its hosts first/);
  await assert.rejects(discover('/mcp', { github: ['127.0.0.1'] }), /provider "tracker" is not on the operator's OAuth host allowlist/);
});

test('an authorization server without PKCE S256 or without registration is refused', async () => {
  await assert.rejects(discover('/plain/mcp'), /does not advertise PKCE S256/);
  await assert.rejects(discover('/noreg/mcp'), /offers no dynamic client registration/);
  await assert.rejects(discover('/mismatch/mcp'), /names another resource than the MCP server/);
});

test('the SSRF guard applies unless private hosts are allowed', async () => {
  await assert.rejects(discoverAuthorization(`${base}/mcp`, { provider: 'tracker', allowlist: ALLOW }), /refusing the protected-resource metadata 127\.0\.0\.1/);
});

// ── Registration and consent ─────────────────────────────────────────────────

test('consent with a registered client: registration, PKCE S256, the resource parameter, the grant stored', async () => {
  registrations.length = 0;
  tokenRequests.length = 0;
  const rows = memoryCredentialRows();
  const cipher = aesGcmCipher(randomBytes(32));
  const registry = oauthClientRegistry({ rows, cipher });
  const grant = { provider: 'tracker', server: `${base}/mcp`, scopes: ['issues:read'] };
  const source = dynamicOAuthClient(grant, { redirectUri: REDIRECT, registry, allowPrivate: true, allowlist: ALLOW });
  const store = credentialStore({ rows, cipher, providers: oauthRefreshProviders({ tracker: source }, { allowPrivate: true }) });
  const consent = oauthConsent({ providers: { tracker: source }, redirectUri: REDIRECT, credentials: store });
  assert.equal(consent.has('tracker'), true);

  const request = await consent.begin({ appName: 'app', userId: 'alice', sessionId: 's', functionCallId: 'fc-1', provider: 'tracker' });
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0], {
    client_name: 'Melchizedek agents',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'issues:read',
  });
  const auth = new URL(request.authUri);
  assert.equal(`${auth.origin}${auth.pathname}`, `${base}/as/authorize`);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('resource'), `${base}/mcp`);
  assert.ok(clients.has(String(auth.searchParams.get('client_id'))), 'the registered client id');

  const redirected = await fetch(request.authUri, { redirect: 'manual' });
  const back = new URL(String(redirected.headers.get('location')));
  const done = await consent.complete({ state: back.searchParams.get('state'), code: back.searchParams.get('code') });
  assert.equal(done.functionCallId, 'fc-1');
  const form = tokenRequests.at(-1)!;
  assert.equal(form.get('resource'), `${base}/mcp`);
  assert.equal(form.get('client_secret'), null, 'a public client sends no secret');
  const grantNow = await store.get({ appName: 'app', userId: 'alice', provider: 'tracker' });
  assert.match(String(grantNow?.accessToken), /^fake-user-/);

  // The registration is kept sealed, under an app name no run can have, and reused.
  const kept = rows.all().filter((r) => r.appName === REGISTERED_CLIENTS_APP);
  assert.equal(kept.length, 1);
  const clientId = String(auth.searchParams.get('client_id'));
  assert.ok(!kept[0]!.accessTokenEnc.includes(clientId) && kept[0]!.accessTokenEnc.startsWith('mzc1.'), 'sealed, not plaintext');
  const again = dynamicOAuthClient(grant, { redirectUri: REDIRECT, registry, allowPrivate: true, allowlist: ALLOW });
  assert.equal((await again()).clientId, clientId);
  assert.equal(registrations.length, 1, 'no second registration');

  // A different redirect URI is a different deployment: a registration of its own.
  const other = dynamicOAuthClient(grant, { redirectUri: 'http://127.0.0.1:2/oauth/callback', registry, allowPrivate: true, allowlist: ALLOW });
  assert.notEqual((await other()).clientId, clientId);
  assert.equal(registrations.length, 2);
});

test('a source that cannot discover is a refusal by kind, and is tried again next time', async () => {
  const source = dynamicOAuthClient({ provider: 'tracker', server: `${base}/foreign-as/mcp`, scopes: [] }, { redirectUri: REDIRECT, allowPrivate: true, allowlist: ALLOW });
  const consent = oauthConsent({ providers: { tracker: source }, redirectUri: REDIRECT, credentials: { put: async () => {} } });
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => void warned.push(args.join(' '));
  try {
    await assert.rejects(consent.begin({ appName: 'app', userId: 'alice', sessionId: 's', functionCallId: 'fc', provider: 'tracker' }), /could not be set up/);
    await assert.rejects(source(), OAuthDiscoveryError);
  } finally {
    console.warn = warn;
  }
  assert.ok(warned.some((w) => /localhost/.test(w)), 'the operator log names the host');
});

test('the registry ignores a row another key sealed', async () => {
  const rows = memoryCredentialRows();
  const first = oauthClientRegistry({ rows, cipher: aesGcmCipher(randomBytes(32)) });
  const key = { appName: REGISTERED_CLIENTS_APP, userId: 'k', provider: 'tracker' };
  await first.put(key, { clientId: 'c', issuer: 'i', authorizationEndpoint: 'a', tokenEndpoint: 't', resource: 'r', redirectUri: REDIRECT });
  assert.equal((await first.get(key))?.clientId, 'c');
  assert.equal(await oauthClientRegistry({ rows, cipher: aesGcmCipher(randomBytes(32)) }).get(key), undefined);
});

// ── The YAML key, and the server's setup ─────────────────────────────────────

const dynamic = { provider: 'tracker', grant: 'authorization_code', client_registration: 'dynamic', scopes: ['issues:read'] };
const solo = (orchestrator: Record<string, unknown>) => ({ syndicate_name: 'Desk', orchestrator: { name: 'Solo', model: 'gemini-x', instruction: 'Work.', ...orchestrator } });

test('schema: client_registration: dynamic on an MCP server, and nowhere it cannot work', () => {
  assert.doesNotThrow(() => validateSyndicateConfig(solo({ mcp_server_url: 'https://mcp.tracker.example.com/mcp', mcp_tools: ['lookup'], mcp_auth: { oauth2: dynamic } }), 'ok'));
  assert.doesNotThrow(() => validateSyndicateConfig(solo({ mcp_servers: [{ name: 'tracker', url: 'https://mcp.tracker.example.com/mcp', tools: ['lookup'], auth: { oauth2: dynamic } }] }), 'ok'));
  assert.throws(() => validateSyndicateConfig(solo({ mcp_server_url: 'https://m.example.com/mcp', mcp_tools: ['x'], mcp_auth: { oauth2: { ...dynamic, client_id: 'c' } } }), 't'), /client_id cannot be combined with client_registration: dynamic/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_server_url: 'https://m.example.com/mcp', mcp_auth: { oauth2: { ...dynamic, grant: 'client_credentials' } } }), 't'), /client_registration: dynamic is for an authorization_code grant/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_server_url: 'https://m.example.com/mcp', mcp_tools: ['x'], mcp_auth: { oauth2: { ...dynamic, token_url: 'https://a.example.com/token' } } }), 't'), /token_url cannot be combined/);
  assert.throws(() => validateSyndicateConfig(solo({ openapi: [{ spec: 'a.yaml', auth: { oauth2: dynamic } }] }), 't'), /an OpenAPI entry names its own/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_server_url: 'https://m.example.com/mcp', mcp_tools: ['x'], mcp_auth: { oauth2: { provider: 'tracker', grant: 'authorization_code' } } }), 't'), /exactly one of client_id or client_id_env/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_server_url: 'https://m.example.com/mcp', mcp_tools: ['x'], mcp_auth: { oauth2: { ...dynamic, authorization_params: { resource: 'x' } } } }), 't'), /may not set "resource"/);
});

test('the consent clients: a dynamic grant is collected apart, one grant per provider', () => {
  const config = solo({ mcp_servers: [{ name: 'tracker', url: `${base}/mcp`, tools: ['lookup'], auth: { oauth2: dynamic } }] });
  assert.deepEqual(oauthClientsFor([config as any], { allowlist: ALLOW }), {});
  assert.deepEqual(dynamicOAuthGrantsFor([config as any], { allowlist: ALLOW }), { tracker: { provider: 'tracker', server: `${base}/mcp`, scopes: ['issues:read'] } });
  assert.throws(() => dynamicOAuthGrantsFor([config as any], { allowlist: { tracker: ['mcp.example.com'] } }), /127\.0\.0\.1 \(server\) is not one of them/);
  const twice = solo({
    mcp_servers: [
      { name: 'tracker', url: `${base}/mcp`, tools: ['lookup'], auth: { oauth2: dynamic } },
      { name: 'other', url: `${base}/other/mcp`, tools: ['find'], auth: { oauth2: dynamic } },
    ],
  });
  assert.throws(() => dynamicOAuthGrantsFor([twice as any], { allowlist: ALLOW }), /provider "tracker" is declared twice/);
});

test("the server's setup offers a dynamic grant's consent", () => {
  const config = solo({ mcp_server_url: `${base}/mcp`, mcp_tools: ['lookup'], mcp_auth: { oauth2: dynamic } });
  const env = { MELCHIZEDEK_CREDENTIAL_KEY: randomBytes(32).toString('base64'), OAUTH_REDIRECT_URI: REDIRECT, MELCHIZEDEK_OAUTH_HOSTS: 'tracker=127.0.0.1', OAUTH_CALLBACK_IDENTITY: 'state' };
  const setup = oauthServerSetup({ configs: [config as any], env, allowPrivate: true });
  assert.equal(setup.toolCredentials?.consent?.has('tracker'), true);
  assert.match(setup.summary, /consent at \/oauth\/callback for tracker/);
  const noRedirect = oauthServerSetup({ configs: [config as any], env: { ...env, OAUTH_REDIRECT_URI: '' }, allowPrivate: true });
  assert.ok(noRedirect.warnings.some((w) => /OAUTH_REDIRECT_URI is not set: a user who has not connected tracker cannot be asked to/.test(w)));
});
