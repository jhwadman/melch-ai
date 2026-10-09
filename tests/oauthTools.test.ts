/**
 * tests/oauthTools.test.ts — `auth: { oauth2 }` in YAML (WS6-3c, ADR 0112),
 * offline: a mock OAuth provider and a mock MCP server and API that take its
 * tokens, on a local HTTP server in this test; scripted models; the native
 * runtime.
 *
 * Covers: the schema (what a block may and may not say, and that the
 * systems_operator template's commented block validates once uncommented);
 * client_credentials against a mock token endpoint, for an MCP server and an
 * OpenAPI tool, cached and never echoed; authorization_code through the
 * consent pause to the mock MCP server, the resumed call learning the
 * server's parameters and the next call carrying the user's own token; the
 * consent step's clients built from the same YAML; and the doctor listing
 * the tools that need a grant.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { renderDoctor, runDoctor } from '../lib/doctor.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { ToolCredentialError } from '../lib/tools/auth.ts';
import { aesGcmCipher } from '../lib/tools/credentialCipher.ts';
import { credentialStore, memoryCredentialRows } from '../lib/tools/credentialStore.ts';
import { closeMcpConnections, createMcpTools } from '../lib/tools/mcpToolFactory.ts';
import { oauthConsent } from '../lib/tools/oauthConsent.ts';
import { clientCredentialsGrant, oauthClientsFor, oauthRefreshProviders, oauthTokenSource, tokenTransportProblem } from '../lib/tools/oauthTools.ts';
import type { OAuth2AuthConfig } from '../lib/tools/oauthTools.ts';
import { buildOpenApiOwnTools, credentialEnvProblem } from '../lib/tools/openapiTools.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

// ── The mock provider, MCP server and API ────────────────────────────────────

const CLIENT_ID = 'melch-test-client';
const CLIENT_SECRET = `fake-client-secret-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
const SECRET_ENV = 'TRACKER_TEST_CLIENT_SECRET';
process.env[SECRET_ENV] = CLIENT_SECRET;

const userTokens = new Map<string, string>(); // token → user (the code's subject)
const serverTokens = new Set<string>();
const refreshTokens = new Map<string, string>(); // refresh token → user
const codes = new Map<string, { challenge: string; redirectUri: string }>();
const tokenRequests: URLSearchParams[] = [];
/** Every bearer the MCP server and the API saw, in order. */
const seen: string[] = [];
const mcpCalls: Array<{ name: string; args: unknown; token: string }> = [];
let serverTokenTtl = 3600;

let http: HttpServer;
let base = '';
const transports = new Map<string, { transport: SSEServerTransport; token: string }>();
const opened: SSEServerTransport[] = [];

const bearer = (req: express.Request) => (req.headers.authorization ?? '').replace(/^Bearer /, '');
const valid = (token: string) => userTokens.has(token) || serverTokens.has(token);

before(async () => {
  const app = express();
  app.get('/authorize', (req, res) => {
    const code = `code-${randomBytes(8).toString('hex')}`;
    codes.set(code, { challenge: String(req.query.code_challenge), redirectUri: String(req.query.redirect_uri) });
    const back = new URL(String(req.query.redirect_uri));
    back.searchParams.set('code', code);
    back.searchParams.set('state', String(req.query.state));
    res.redirect(302, back.toString());
  });
  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const form = new URLSearchParams(req.body as Record<string, string>);
    tokenRequests.push(form);
    if (form.get('client_id') !== CLIENT_ID) return void res.status(401).json({ error: 'invalid_client' });
    if (form.get('grant_type') === 'client_credentials') {
      if (form.get('client_secret') !== CLIENT_SECRET) return void res.status(401).json({ error: 'invalid_client', error_description: `bad secret ${form.get('client_secret')}` });
      const token = `fake-server-${randomBytes(8).toString('hex')}`;
      serverTokens.add(token);
      return void res.json({ access_token: token, token_type: 'Bearer', expires_in: serverTokenTtl });
    }
    if (form.get('grant_type') === 'refresh_token') {
      const user = refreshTokens.get(String(form.get('refresh_token')));
      if (!user || form.get('client_secret') !== CLIENT_SECRET) return void res.status(400).json({ error: 'invalid_grant' });
      const token = `fake-user-${randomBytes(8).toString('hex')}`;
      userTokens.set(token, user);
      return void res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }
    const issued = codes.get(String(form.get('code')));
    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!issued || issued.challenge !== challenge || issued.redirectUri !== form.get('redirect_uri')) return void res.status(400).json({ error: 'invalid_grant' });
    codes.delete(String(form.get('code')));
    const token = `fake-user-${randomBytes(8).toString('hex')}`;
    userTokens.set(token, 'alice');
    res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'tracker:read' });
  });
  // The API an OpenAPI tool calls.
  app.get('/api/whoami', (req, res) => {
    const token = bearer(req);
    seen.push(token);
    if (!valid(token)) return void res.status(401).json({ error: 'unauthorized' });
    res.json({ caller: serverTokens.has(token) ? 'server' : userTokens.get(token) });
  });
  // The MCP server: every request carries a valid bearer, or it is refused.
  app.get('/sse', async (req, res) => {
    const token = bearer(req);
    seen.push(token);
    if (!valid(token)) return void res.status(401).end();
    const server = new Server({ name: 'tracker', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'lookup', description: 'Look a ticket up by id.', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'The ticket id.' } }, required: ['id'] } },
        { name: 'close_all', description: 'Close every ticket.', inputSchema: { type: 'object' as const, properties: {} } },
      ],
    }));
    const transport = new SSEServerTransport('/messages', res);
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const entry = transports.get(transport.sessionId);
      mcpCalls.push({ name: call.params.name, args: call.params.arguments, token: entry?.token ?? '' });
      const id = (call.params.arguments as { id?: string } | undefined)?.id ?? '?';
      return { content: [{ type: 'text' as const, text: `${id} is open (for ${serverTokens.has(entry?.token ?? '') ? 'the server' : userTokens.get(entry?.token ?? '')})` }] };
    });
    transports.set(transport.sessionId, { transport, token });
    opened.push(transport);
    await server.connect(transport);
  });
  app.post('/messages', express.json(), async (req, res) => {
    const token = bearer(req);
    seen.push(token);
    if (!valid(token)) return void res.status(401).end();
    const entry = transports.get(String(req.query.sessionId));
    if (!entry) return void res.status(404).end();
    entry.token = token;
    await entry.transport.handlePostMessage(req, res, req.body);
  });
  http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const addr = http.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.ALLOW_PRIVATE_MCP = 'true';
  process.env.ALLOW_PRIVATE_OPENAPI = 'true';
});

after(async () => {
  await closeMcpConnections();
  for (const t of opened) await t.close().catch(() => {});
  http?.closeAllConnections?.();
  http?.close();
  delete process.env.ALLOW_PRIVATE_MCP;
  delete process.env.ALLOW_PRIVATE_OPENAPI;
  delete process.env[SECRET_ENV];
});

const authCode = (): OAuth2AuthConfig => ({
  provider: 'tracker',
  grant: 'authorization_code',
  authorization_url: `${base}/authorize`,
  token_url: `${base}/token`,
  client_id: CLIENT_ID,
  client_secret_env: SECRET_ENV,
  scopes: ['tracker:read'],
});
const clientCreds = (): OAuth2AuthConfig => ({
  provider: 'tracker-server',
  grant: 'client_credentials',
  token_url: `${base}/token`,
  client_id: CLIENT_ID,
  client_secret_env: SECRET_ENV,
  scopes: ['tracker:read'],
});

// ── The schema ───────────────────────────────────────────────────────────────

test('schema: an oauth2 block on an OpenAPI entry and as mcp_auth, and what each may not say', () => {
  const agent = (extra: Record<string, unknown>) => ({
    syndicate_name: 'S',
    orchestrator: { name: 'R', model: 'gemini-x', instruction: 'r' },
    dispatch: { default_route: 'Ops' },
    subagents: [{ name: 'Ops', model: 'gemini-x', instruction: 'o', description: 'ops', ...extra }],
  });
  const oauth2 = { provider: 'tracker', grant: 'authorization_code', authorization_url: 'https://t.example.com/a', token_url: 'https://t.example.com/t', client_id_env: 'TRACKER_ID', client_secret_env: 'TRACKER_SECRET', scopes: ['issues:read'] };
  assert.doesNotThrow(() => validateSyndicateConfig(agent({ openapi: [{ spec: 'x.yaml', auth: { oauth2 } }] }), 'ok'));
  assert.doesNotThrow(() => validateSyndicateConfig(agent({ mcp_server_url: 'https://m.example.com/sse', mcp_tools: ['lookup'], mcp_auth: { oauth2 } }), 'ok'));
  const cc = { provider: 'svc', grant: 'client_credentials', token_url: 'https://t.example.com/t', client_id: 'abc', client_secret_env: 'SVC_SECRET' };
  assert.doesNotThrow(() => validateSyndicateConfig(agent({ mcp_server_url: 'https://m.example.com/sse', mcp_auth: { oauth2: cc } }), 'ok'));

  const refused: Array<[Record<string, unknown>, RegExp]> = [
    [{ openapi: [{ spec: 'x.yaml', auth: { oauth2, bearer_env: 'X_TOKEN' } }] }, /exactly one of bearer_env, api_key or oauth2/],
    [{ openapi: [{ spec: 'x.yaml', auth: { oauth2: { ...oauth2, authorization_url: undefined } } }] }, /needs authorization_url/],
    [{ openapi: [{ spec: 'x.yaml', auth: { oauth2: { ...oauth2, client_id: 'abc' } } }] }, /exactly one of client_id or client_id_env/],
    [{ openapi: [{ spec: 'x.yaml', auth: { oauth2: { ...oauth2, scopes: ['has space'] } } }] }, /an OAuth scope/],
    [{ openapi: [{ spec: 'x.yaml', auth: { oauth2: { ...oauth2, provider: 'GitHub' } } }] }, /a provider name/],
    [{ openapi: [{ spec: 'x.yaml', auth: { oauth2: { ...oauth2, authorization_params: { state: 'x' } } } }] }, /may not set "state"/],
    [{ openapi: [{ spec: 'x.yaml', auth: { oauth2: { ...oauth2, client_secret: 'inline' } } }] }, /client_secret/],
    [{ mcp_server_url: 'https://m.example.com/sse', mcp_auth: { oauth2: { ...cc, client_secret_env: undefined } } }, /needs client_secret_env/],
    [{ mcp_server_url: 'https://m.example.com/sse', mcp_auth: { oauth2: { ...cc, authorization_url: 'https://t.example.com/a' } } }, /authorization_url is for authorization_code only/],
    [{ mcp_auth: { oauth2: cc } }, /mcp_auth is the grant an MCP server takes; it needs mcp_server_url/],
    [{ mcp_server_url: 'https://m.example.com/sse', mcp_auth: { oauth2 } }, /an authorization_code mcp_auth needs mcp_tools/],
  ];
  for (const [extra, message] of refused) {
    assert.throws(() => validateSyndicateConfig(agent(extra), 'x'), message, JSON.stringify(extra));
  }
});

/** The systems_operator template with its commented `mcp_auth` block uncommented, and optionally rewritten. */
function operatorWithAuth(rewrite: (yaml: string) => string = (y) => y): string {
  const shipped = readFileSync(join(process.cwd(), 'config', 'agents', 'templates', 'systems_operator.yaml'), 'utf-8');
  const lines = shipped.split('\n');
  const at = lines.findIndex((l) => l.trim() === '# mcp_auth:');
  assert.ok(at > 0, 'the template carries a commented mcp_auth block');
  for (let i = at; i < lines.length && /^ {4}# {1,}\S/.test(lines[i]!) && !/^ {4}# [A-Z]/.test(lines[i]!); i++) lines[i] = lines[i]!.replace(/^( {4})# /, '$1');
  return rewrite(lines.join('\n'));
}

test('the systems_operator template declares an OAuth-protected MCP server, and the doctor lists the tool as needing a grant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-oauth-doctor-'));
  writeFileSync(join(dir, 'operator_cc.yaml'), operatorWithAuth());
  // The authorization_code form: the person's own grant, which needs mcp_tools.
  writeFileSync(
    join(dir, 'operator_user.yaml'),
    operatorWithAuth((y) =>
      y
        .replace('grant: "client_credentials"', 'grant: "authorization_code"\n        authorization_url: "https://auth.example.com/oauth/authorize"')
        .replace('    mcp_auth:', '    mcp_tools: [find_scroll, borrow_scroll]\n    mcp_auth:'),
    ),
  );
  const cc = loadSyndicate('operator_cc.yaml', { agentsDir: dir }) as SyndicateYamlConfig;
  const systems = cc.subagents!.find((s) => s.name === 'Systems')!;
  assert.equal(systems.mcp_auth?.oauth2.grant, 'client_credentials');
  assert.equal(systems.mcp_auth?.oauth2.client_secret_env, 'SYSTEMS_CLIENT_SECRET');

  const result = runDoctor({ agentsDir: dir });
  const byFile = Object.fromEntries(result.syndicates.map((s) => [s.file, s]));
  for (const file of ['operator_cc.yaml', 'operator_user.yaml']) assert.equal(byFile[file]?.error, undefined, byFile[file]?.error);
  const [grant] = byFile['operator_cc.yaml']!.grants!;
  assert.equal(grant!.agent, 'Systems');
  assert.match(grant!.tools, /^mcp /);
  assert.equal(grant!.provider, 'systems');
  assert.equal(grant!.grant, 'client_credentials');
  assert.deepEqual(grant!.scopes, ['systems:read', 'systems:write']);
  assert.deepEqual(grant!.missingEnv, ['SYSTEMS_CLIENT_ID', 'SYSTEMS_CLIENT_SECRET'], 'names only');
  assert.equal(byFile['operator_user.yaml']!.grants![0]!.grant, 'authorization_code');
  const out = renderDoctor(result);
  assert.match(out, /⚿ Systems needs a grant: each user connects systems \(consent\)/);
  assert.match(out, /⚿ Systems needs a grant: the server's own systems token \(client_credentials\)/);
  assert.match(out, /SYSTEMS_CLIENT_ID, SYSTEMS_CLIENT_SECRET not set/);
  // A syndicate with no grant carries none.
  writeFileSync(join(dir, 'plain.yaml'), readFileSync(join(process.cwd(), 'config', 'agents', 'templates', 'systems_operator.yaml'), 'utf-8'));
  assert.equal(runDoctor({ agentsDir: dir }).syndicates.find((s) => s.file === 'plain.yaml')?.grants, undefined);
});

// ── client_credentials ───────────────────────────────────────────────────────

test('client_credentials: one token from the token endpoint, held until shortly before it expires; a refusal names no value', async () => {
  let clock = 1_000_000;
  let requests = 0;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    requests++;
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('scope'), 'a b');
    assert.equal(init.redirect, 'error', 'a redirect would carry the secret elsewhere');
    return new Response(JSON.stringify({ access_token: `fake-cc-${requests}`, token_type: 'bearer', expires_in: 120 }), { status: 200 });
  }) as typeof fetch;
  const grant = clientCredentialsGrant({ provider: 'svc', tokenUrl: 'https://auth.example.com/token', clientId: 'id', clientSecret: CLIENT_SECRET, scopes: ['a', 'b'], allowPrivate: true, fetch: fakeFetch, now: () => clock });
  const [a, b] = await Promise.all([grant.token(), grant.token()]);
  assert.equal(a, 'fake-cc-1');
  assert.equal(b, 'fake-cc-1', 'one request at a time');
  clock += 30_000;
  assert.equal(await grant.token(), 'fake-cc-1');
  clock += 40_000; // within the 60 s skew of expiry
  assert.equal(await grant.token(), 'fake-cc-2');
  assert.equal(requests, 2);

  const refusing = clientCredentialsGrant({
    provider: 'svc',
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'id',
    clientSecret: CLIENT_SECRET,
    allowPrivate: true,
    fetch: (async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: `secret ${CLIENT_SECRET} refused` }), { status: 401 })) as typeof fetch,
  });
  await assert.rejects(refusing.token(), (e: unknown) => e instanceof ToolCredentialError && e.code === 'grant_failed' && !e.message.includes(CLIENT_SECRET));
});

test('where a token may go: https, or http to a loopback host; the token endpoint passes the SSRF guard', async () => {
  assert.equal(tokenTransportProblem('https://api.example.com'), null);
  assert.equal(tokenTransportProblem('http://127.0.0.1:8080/sse'), null);
  assert.match(tokenTransportProblem('http://api.example.com')!, /only over https/);
  assert.match(tokenTransportProblem('https://u:p@api.example.com')!, /credentials in its URL/);
  assert.throws(() => oauthTokenSource(clientCreds(), 'mcp x', 'http://api.example.com/sse'), /only over https/);
  // Without the development switch, a private token endpoint is refused at compile.
  assert.throws(() => oauthTokenSource({ ...clientCreds(), token_url: 'https://10.0.0.5/token' }, 'mcp x', 'https://m.example.com/sse'), /refusing token endpoint 10\.0\.0\.5/);
  // A framework secret is never a client secret.
  assert.throws(() => oauthTokenSource({ ...clientCreds(), client_secret_env: 'A2A_SERVER_SECRET' }, 'mcp x', 'https://m.example.com/sse', { allowPrivate: true }), /framework's own settings/);
  assert.throws(() => oauthTokenSource({ ...clientCreds(), client_secret_env: 'TRACKER_UNSET_SECRET' }, 'mcp x', 'https://m.example.com/sse', { allowPrivate: true }), /TRACKER_UNSET_SECRET is not set/);
  assert.equal(credentialEnvProblem('TRACKER_TEST_CLIENT_SECRET', {}), null, 'still exported from openapiTools');
});

test('client_credentials MCP: the tools are listed and called with the server\'s own token on every request', async () => {
  const before = tokenRequests.length;
  seen.length = 0;
  const tools = await createMcpTools(`${base}/sse`, { oauth2: clientCreds() });
  assert.deepEqual(tools.map((t) => t.name).sort(), ['close_all', 'lookup']);
  const result = await tools.find((t) => t.name === 'lookup')!.execute({ id: 'T-7' }, {} as any);
  assert.equal(result, 'T-7 is open (for the server)');
  assert.equal(tokenRequests.length - before, 1, 'one token request, then the held token');
  assert.ok(seen.length >= 2 && seen.every((t) => serverTokens.has(t)), 'the stream and every POST carried the server token');
  assert.ok(!String(result).includes(CLIENT_SECRET));
});

test('client_credentials OpenAPI: each call carries the server token; a refused grant answers an error naming no value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-oauth-openapi-'));
  writeFileSync(
    join(dir, 'tracker.json'),
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Tracker', version: '1' },
      servers: [{ url: `${base}/api` }],
      paths: { '/whoami': { get: { operationId: 'whoami', summary: 'Who is calling.', responses: { '200': { description: 'ok' } } } } },
    }),
  );
  const [tool] = await buildOpenApiOwnTools({ spec: 'tracker.json', auth: { oauth2: clientCreds() } }, dir);
  const answer = JSON.stringify(await tool!.execute({}, {} as any));
  assert.match(answer, /"caller":"server"/);

  // The authorization_code form reads the run's user's token from the context.
  const [userTool] = await buildOpenApiOwnTools({ spec: 'tracker.json', auth: { oauth2: authCode() } }, dir);
  const none = (await userTool!.execute({}, {} as any)) as { error: string };
  assert.match(none.error, /holds no "tracker" authorizations/);
  const token = [...userTokens.keys()][0] ?? (() => { const t = `fake-user-${randomBytes(4).toString('hex')}`; userTokens.set(t, 'alice'); return t; })();
  const asked: string[] = [];
  const mine = JSON.stringify(await userTool!.execute({}, { accessToken: async (p: string) => (asked.push(p), token) } as any));
  assert.match(mine, /"caller":"alice"/);
  assert.deepEqual(asked, ['tracker'], 'the tool names the provider; the context decides whose token');

  // A grant the token endpoint refuses: an error, never the secret or the provider's text.
  process.env.TRACKER_WRONG_SECRET = 'fake-wrong-secret';
  try {
    const [refused] = await buildOpenApiOwnTools({ spec: 'tracker.json', auth: { oauth2: { ...clientCreds(), client_secret_env: 'TRACKER_WRONG_SECRET' } } }, dir);
    const failed = (await refused!.execute({}, {} as any)) as { error: string };
    assert.match(failed.error, /server's own "tracker-server" authorization could not be obtained/);
    assert.ok(!failed.error.includes('fake-wrong-secret'));
  } finally {
    delete process.env.TRACKER_WRONG_SECRET;
  }
});

// ── authorization_code, through the consent pause ────────────────────────────

test('an expired user token is renewed at the YAML\'s token endpoint with its refresh token', async () => {
  const clients = oauthClientsFor([{ subagents: [{ name: 'Ops', mcp_server_url: `${base}/sse`, mcp_auth: { oauth2: authCode() } }] }]);
  let clock = Date.now();
  const store = credentialStore({ rows: memoryCredentialRows(), cipher: aesGcmCipher(randomBytes(32)), providers: oauthRefreshProviders(clients, { allowPrivate: true }), now: () => clock });
  const refresh = `fake-refresh-${randomBytes(6).toString('hex')}`;
  refreshTokens.set(refresh, 'bob');
  const key = { appName: 'app', userId: 'bob', provider: 'tracker' };
  await store.put(key, { accessToken: 'fake-old-access', refreshToken: refresh, expiresAt: new Date(clock + 30_000), scopes: ['tracker:read'] });
  const grant = await store.get(key);
  assert.notEqual(grant?.accessToken, 'fake-old-access', 'renewed inside the 60 s skew');
  assert.equal(userTokens.get(grant!.accessToken), 'bob');
  assert.equal(tokenRequests.at(-1)?.get('grant_type'), 'refresh_token');
  clock += 1000;
  assert.equal((await store.get(key))?.accessToken, grant!.accessToken, 'the renewed token is kept');
  // A refused refresh is reported by kind.
  const refusing = oauthRefreshProviders(clients, { allowPrivate: true }).tracker!;
  await assert.rejects(refusing.refresh!('fake-unknown-refresh', { scopes: [] }), (e: unknown) => e instanceof ToolCredentialError && e.code === 'grant_failed');
});

test('the consent step\'s clients come from the YAML; one provider declared twice must agree', () => {
  const config = { orchestrator: { name: 'R' }, subagents: [{ name: 'Ops', mcp_server_url: `${base}/sse`, mcp_auth: { oauth2: authCode() } }, { name: 'Cc', mcp_server_url: `${base}/sse`, mcp_auth: { oauth2: clientCreds() } }] };
  const clients = oauthClientsFor([config]);
  assert.deepEqual(Object.keys(clients), ['tracker'], 'client_credentials needs no consent');
  assert.equal(clients.tracker!.clientId, CLIENT_ID);
  assert.equal(clients.tracker!.clientSecret, CLIENT_SECRET);
  assert.deepEqual(clients.tracker!.scopes, ['tracker:read']);
  const twice = { subagents: [{ name: 'A', openapi: [{ spec: 'a.yaml', auth: { oauth2: authCode() } }] }, { name: 'B', mcp_server_url: 'x', mcp_auth: { oauth2: { ...authCode(), scopes: ['tracker:write'] } } }] };
  assert.throws(() => oauthClientsFor([twice]), /provider "tracker" is declared twice with different endpoints, client or scopes/);
  assert.throws(() => oauthClientsFor([{ subagents: [{ name: 'A', mcp_auth: { oauth2: { ...authCode(), client_secret_env: 'DATABASE_URL' } } }] }]), /framework's own settings/);
});

test('authorization_code MCP: the call pauses for consent, the grant resumes it, and the user\'s own token reaches the server', async () => {
  const config = {
    syndicate_name: 'Desk',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      { name: 'Ops', model: 'scripted/ops', instruction: 'Work the tracker.', description: 'works the tracker', mcp_server_url: `${base}/sse`, mcp_tools: ['lookup'], mcp_auth: { oauth2: authCode() } },
    ],
    dispatch: { default_route: 'Chat' },
  };
  assert.doesNotThrow(() => validateSyndicateConfig(structuredClone(config), 'desk'));

  const rows = memoryCredentialRows();
  const store = credentialStore({ rows, cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({ providers: oauthClientsFor([config]), redirectUri: 'http://127.0.0.1:9/oauth/callback', credentials: store });

  const declared: string[] = [];
  const lastResult = (req: any) => JSON.stringify(req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response ?? null);
  const router = new ScriptedLlm('scripted/router', () => text('{"route":"Ops","reason":"tracker"}'));
  const chat = new ScriptedLlm('scripted/chat', () => text('chat'));
  const ops = new ScriptedLlm('scripted/ops', (req: any) => {
    declared.push(JSON.stringify(req.tools ?? req.config?.tools ?? null));
    const last = lastResult(req);
    if (/is open/.test(last)) return text(`Found: ${JSON.parse(last).result}`);
    if (/call it again/.test(last)) return call('lookup', { id: 'T-1' });
    return call('lookup', {});
  });
  const sessionService = new InProcessSessionService();
  const turn = (t: string) =>
    runSyndicateTurn({
      config: config as unknown as SyndicateYamlConfig,
      parts: [{ text: t }],
      appName: 'app',
      userId: 'alice',
      sessionId: 's1',
      sessionService,
      toolCredentials: { store, consent },
      compile: { resolveModel: scriptedResolver({ router, chat, ops }) },
      trace: false,
    });

  const callsBefore = mcpCalls.length;
  const first = await turn('is T-1 open?');
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.consent?.provider, 'tracker');
  assert.equal(first.consent?.agent, 'Ops');
  assert.deepEqual(first.consent?.scopes, ['tracker:read']);
  assert.equal(mcpCalls.length, callsBefore, 'nothing reached the server before the grant');

  // The person consents at the provider; the callback completes the flow.
  const res = await fetch(first.consent!.authUri, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get('location')!);
  const done = await consent.complete({ state: back.searchParams.get('state'), code: back.searchParams.get('code'), callerUserId: 'alice' });
  assert.equal(done.provider, 'tracker');
  assert.equal(rows.all()[0]?.userId, 'alice');

  // The next message resumes the paused call: it connects with alice's token, learns the parameters, and asks to be called again.
  const second = await turn('done');
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.route?.decidedBy, 'consent');
  assert.match(second.text, /Found: T-1 is open \(for alice\)/);
  const calls = mcpCalls.slice(callsBefore);
  assert.deepEqual(calls.map((c) => [c.name, c.args]), [['lookup', { id: 'T-1' }]], 'one call, with the parameters the server declared');
  assert.equal(userTokens.get(calls[0]!.token), 'alice', 'the user\'s own token');
  assert.match(declared.at(-1)!, /"id"/, 'after the listing, the declaration carries the server\'s parameters');

  // No token, code or secret in any stored event.
  const session = await sessionService.get({ appName: 'app', userId: 'alice', sessionId: 's1' });
  const json = JSON.stringify(session?.events ?? []);
  for (const secret of [...userTokens.keys(), CLIENT_SECRET]) assert.ok(!json.includes(secret), 'no value in the session');
});
