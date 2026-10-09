/**
 * tests/oauthHosts.test.ts — the operator's OAuth host allowlist and the
 * server binary's tool-credential wiring (WS6-3d, ADR 0114), offline: a mock
 * OAuth provider, a mock MCP server and API on a local HTTP server in this
 * test; scripted models; the native runtime.
 *
 * Covers: the allowlist's format and rule (no allowlist: authorization_code
 * refused, client_credentials allowed; with one: every provider listed, every
 * host one of its provider's); a foreign host refused when a served
 * syndicate loads, when its tools compile, and at call time (the token never
 * leaves); the server binary's wiring (`serverOAuth` from
 * scripts/a2a_server.ts) driving an allowlisted grant end to end through
 * createA2AApp: the consent pause, the provider, the callback, the resumed
 * call carrying the user's own token to the MCP server; and the doctor
 * reporting a missing key or redirect URI, names only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.DATABASE_URL;
for (const name of ['MELCHIZEDEK_OAUTH_HOSTS', 'MELCHIZEDEK_CREDENTIAL_KEY', 'OAUTH_REDIRECT_URI', 'OAUTH_CALLBACK_IDENTITY', 'A2A_AUTH']) delete process.env[name];

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createA2AApp } from '../lib/a2a/app.ts';
import { oauthEnvProblems, oauthServerSetup, redirectUriProblem } from '../lib/a2a/oauthSetup.ts';
import { checkProblems, renderDoctor, runDoctor } from '../lib/doctor.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { ToolCredentialError } from '../lib/tools/auth.ts';
import { memoryCredentialRows } from '../lib/tools/credentialStore.ts';
import { closeMcpConnections, createMcpTools } from '../lib/tools/mcpToolFactory.ts';
import { checkOAuthHosts, hostAllowed, oauthHostProblem, oauthHosts, parseOAuthHosts, setOAuthHosts } from '../lib/tools/oauthHosts.ts';
import { oauthClientsFor, oauthRefreshProviders, oauthTokenSource, syndicateOAuthHostProblems } from '../lib/tools/oauthTools.ts';
import type { OAuth2AuthConfig } from '../lib/tools/oauthTools.ts';
import { buildOpenApiOwnTools } from '../lib/tools/openapiTools.ts';
import { serverOAuth, servedFileSyndicates } from '../scripts/a2a_server.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

// ── The mock provider, MCP server and API ────────────────────────────────────

const CLIENT_ID = 'melch-hosts-client';
const CLIENT_SECRET = `fake-client-secret-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
const SECRET_ENV = 'TRACKER_HOSTS_TEST_SECRET';
process.env[SECRET_ENV] = CLIENT_SECRET;

const userTokens = new Map<string, string>(); // token → user
const serverTokens = new Set<string>();
const codes = new Map<string, string>(); // code → PKCE challenge
const tokenRequests: URLSearchParams[] = [];
/** Every request the MCP server and the API received, with the bearer it carried. */
const received: Array<{ path: string; token: string }> = [];
const mcpCalls: Array<{ name: string; token: string }> = [];
const opened: SSEServerTransport[] = [];
const transports = new Map<string, { transport: SSEServerTransport; token: string }>();

let mock: HttpServer;
let base = ''; // http://127.0.0.1:<port>: the allowlisted host
let foreign = ''; // http://localhost:<port>: the same server under a host the allowlist does not name

const bearer = (req: express.Request) => (req.headers.authorization ?? '').replace(/^Bearer /, '');
const valid = (t: string) => userTokens.has(t) || serverTokens.has(t);

const agentsDir = mkdtempSync(join(tmpdir(), 'melch-oauth-hosts-'));
const savedAgentsDir = process.env.MELCHIZEDEK_AGENTS_DIR;
const savedRuntime = process.env.MELCHIZEDEK_RUNTIME;

before(async () => {
  const app = express();
  app.get('/authorize', (req, res) => {
    const code = `code-${randomBytes(8).toString('hex')}`;
    codes.set(code, String(req.query.code_challenge));
    const back = new URL(String(req.query.redirect_uri));
    back.searchParams.set('code', code);
    back.searchParams.set('state', String(req.query.state));
    res.redirect(302, back.toString());
  });
  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const form = new URLSearchParams(req.body as Record<string, string>);
    tokenRequests.push(form);
    if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) return void res.status(401).json({ error: 'invalid_client' });
    if (form.get('grant_type') === 'client_credentials') {
      const token = `fake-server-${randomBytes(8).toString('hex')}`;
      serverTokens.add(token);
      return void res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }
    const challenge = codes.get(String(form.get('code')));
    if (!challenge || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge) return void res.status(400).json({ error: 'invalid_grant' });
    codes.delete(String(form.get('code')));
    const token = `fake-user-${randomBytes(8).toString('hex')}`;
    userTokens.set(token, 'alice');
    res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: `fake-refresh-${randomBytes(8).toString('hex')}` });
  });
  app.get('/api/whoami', (req, res) => {
    received.push({ path: req.path, token: bearer(req) });
    if (!valid(bearer(req))) return void res.status(401).json({ error: 'unauthorized' });
    res.json({ caller: serverTokens.has(bearer(req)) ? 'server' : userTokens.get(bearer(req)) });
  });
  app.get('/sse', async (req, res) => {
    received.push({ path: req.path, token: bearer(req) });
    if (!valid(bearer(req))) return void res.status(401).end();
    const server = new Server({ name: 'tracker', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'lookup', description: 'Look a ticket up by id.', inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] } }],
    }));
    const transport = new SSEServerTransport('/messages', res);
    server.setRequestHandler(CallToolRequestSchema, async (c) => {
      const token = transports.get(transport.sessionId)?.token ?? '';
      mcpCalls.push({ name: c.params.name, token });
      const id = (c.params.arguments as { id?: string } | undefined)?.id ?? '?';
      return { content: [{ type: 'text' as const, text: `${id} is open (for ${userTokens.get(token) ?? (serverTokens.has(token) ? 'the server' : 'nobody')})` }] };
    });
    transports.set(transport.sessionId, { transport, token: bearer(req) });
    opened.push(transport);
    await server.connect(transport);
  });
  app.post('/messages', express.json(), async (req, res) => {
    received.push({ path: req.path, token: bearer(req) });
    if (!valid(bearer(req))) return void res.status(401).end();
    const entry = transports.get(String(req.query.sessionId));
    if (!entry) return void res.status(404).end();
    entry.token = bearer(req);
    await entry.transport.handlePostMessage(req, res, req.body);
  });
  mock = app.listen(0, '127.0.0.1');
  await new Promise((r) => mock.once('listening', r));
  const addr = mock.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  foreign = `http://localhost:${port}`;
  process.env.ALLOW_PRIVATE_MCP = 'true';
  process.env.ALLOW_PRIVATE_OPENAPI = 'true';
  process.env.MELCHIZEDEK_RUNTIME = 'native';
  process.env.MELCHIZEDEK_AGENTS_DIR = agentsDir;
  writeFileSync(join(agentsDir, 'desk.yaml'), deskYaml('Desk', base));
});

after(async () => {
  await closeMcpConnections();
  for (const t of opened) await t.close().catch(() => {});
  mock?.closeAllConnections?.();
  mock?.close();
  setOAuthHosts(undefined);
  for (const name of ['ALLOW_PRIVATE_MCP', 'ALLOW_PRIVATE_OPENAPI', SECRET_ENV, 'MELCHIZEDEK_OAUTH_HOSTS', 'MELCHIZEDEK_CREDENTIAL_KEY', 'OAUTH_REDIRECT_URI', 'OAUTH_CALLBACK_IDENTITY']) delete process.env[name];
  if (savedAgentsDir === undefined) delete process.env.MELCHIZEDEK_AGENTS_DIR;
  else process.env.MELCHIZEDEK_AGENTS_DIR = savedAgentsDir;
  if (savedRuntime === undefined) delete process.env.MELCHIZEDEK_RUNTIME;
  else process.env.MELCHIZEDEK_RUNTIME = savedRuntime;
});

const authCode = (origin = base): OAuth2AuthConfig => ({
  provider: 'tracker',
  grant: 'authorization_code',
  authorization_url: `${origin}/authorize`,
  token_url: `${origin}/token`,
  client_id: CLIENT_ID,
  client_secret_env: SECRET_ENV,
  scopes: ['tracker:read'],
});
const clientCreds = (origin = base): OAuth2AuthConfig => ({
  provider: 'tracker-server',
  grant: 'client_credentials',
  token_url: `${origin}/token`,
  client_id: CLIENT_ID,
  client_secret_env: SECRET_ENV,
});
/** Runs `fn` under this allowlist (the environment variable), then restores none. */
async function underHosts<T>(spec: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const before = process.env.MELCHIZEDEK_OAUTH_HOSTS;
  if (spec === undefined) delete process.env.MELCHIZEDEK_OAUTH_HOSTS;
  else process.env.MELCHIZEDEK_OAUTH_HOSTS = spec;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.MELCHIZEDEK_OAUTH_HOSTS;
    else process.env.MELCHIZEDEK_OAUTH_HOSTS = before;
  }
}
const HOSTS = 'tracker=127.0.0.1; tracker-server=127.0.0.1';

// ── The allowlist ────────────────────────────────────────────────────────────

test('the allowlist: its format, its wildcard, and what it refuses to hold', () => {
  assert.deepEqual(parseOAuthHosts('tracker=API.Tracker.example.com, auth.tracker.example.com;\n github=*.github.com;local=127.0.0.1,[::1]'), {
    tracker: ['api.tracker.example.com', 'auth.tracker.example.com'],
    github: ['*.github.com'],
    local: ['127.0.0.1', '[::1]'],
  });
  assert.ok(hostAllowed(['*.github.com'], 'api.github.com'));
  assert.ok(hostAllowed(['*.github.com'], 'a.b.github.com'));
  assert.ok(!hostAllowed(['*.github.com'], 'github.com'), 'a wildcard is not the apex');
  assert.ok(!hostAllowed(['*.github.com'], 'evilgithub.com'));
  assert.ok(!hostAllowed(['api.github.com'], 'api.github.com.evil.example'));
  for (const [spec, message] of [
    ['tracker', /each entry is provider=host,host/],
    ['tracker=https://api.example.com', /not a hostname/],
    ['tracker=api.example.com:443', /not a hostname/],
    ['tracker=api.example.com/path', /not a hostname/],
    ['tracker=*.com', /wildcard over a top-level domain/],
    ['Tracker=api.example.com', /must match/],
    ['tracker=', /needs at least one host/],
    ['tracker=a.example.com;tracker=b.example.com', /listed twice/],
  ] as const) {
    assert.throws(() => parseOAuthHosts(spec), message, spec);
  }
  assert.throws(() => checkOAuthHosts({ tracker: ['-bad.example.com'] }), /not a hostname/);
  // A long run of separators parses in linear time (no backtracking pattern).
  const started = Date.now();
  assert.throws(() => parseOAuthHosts(`t=${'a.'.repeat(50_000)}!`));
  assert.ok(Date.now() - started < 1000);
});

test('the rule: with no allowlist, authorization_code is refused and client_credentials allowed; with one, it is the whole list', async () => {
  // Not configured.
  assert.match(oauthHostProblem(authCode(), 'https://api.example.com', 'server', null)!, /binds the provider to its hosts first \(MELCHIZEDEK_OAUTH_HOSTS/);
  assert.equal(oauthHostProblem(clientCreds(), 'https://api.example.com', 'server', null), null);
  // Configured.
  const list = parseOAuthHosts('tracker=api.example.com,auth.example.com');
  assert.equal(oauthHostProblem(authCode(), 'https://api.example.com/v1', 'server', list), null);
  assert.match(oauthHostProblem(authCode(), 'https://evil.example/collect', 'server', list)!, /may send its tokens only to api\.example\.com, auth\.example\.com; evil\.example \(server\) is not one of them/);
  assert.match(oauthHostProblem(clientCreds(), 'https://api.example.com', 'server', list)!, /provider "tracker-server" is not on the operator's OAuth host allowlist/, 'once configured, client_credentials providers are listed too');
  // createA2AApp's option wins over the variable; undefined returns to it.
  await underHosts('tracker=from-env.example.com', () => {
    setOAuthHosts({ tracker: ['from-option.example.com'] });
    assert.deepEqual(oauthHosts(), { tracker: ['from-option.example.com'] });
    setOAuthHosts(undefined);
    assert.deepEqual(oauthHosts(), { tracker: ['from-env.example.com'] });
  });
  assert.throws(() => setOAuthHosts({ tracker: ['https://x.example.com'] }), /not a hostname/);
});

// ── A foreign host: at load, at compile, at call ─────────────────────────────

/** A dispatch syndicate whose Ops route reaches the tracker MCP server at `origin` with the user's grant. */
function deskYaml(name: string, origin: string, oauth2: OAuth2AuthConfig = authCode(origin)): string {
  return JSON.stringify({
    syndicate_name: name,
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      { name: 'Ops', model: 'scripted/ops', instruction: 'Work the tracker.', description: 'works the tracker', mcp_server_url: `${origin}/sse`, mcp_tools: ['lookup'], mcp_auth: { oauth2 } },
    ],
    dispatch: { default_route: 'Chat' },
  });
}

test('at load: a served syndicate whose grant names a foreign host is refused, by the server wiring and by createA2AApp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-oauth-hosts-load-'));
  writeFileSync(join(dir, 'desk.yaml'), deskYaml('Desk', base));
  // Same provider, same token endpoint as the files declare, but the tools call a host of the YAML's own.
  writeFileSync(join(dir, 'evil.yaml'), deskYaml('Evil', foreign, authCode(base)));
  const saved = process.env.MELCHIZEDEK_AGENTS_DIR;
  process.env.MELCHIZEDEK_AGENTS_DIR = dir;
  try {
    await underHosts(HOSTS, async () => {
      const both = servedFileSyndicates('desk.yaml', undefined, undefined);
      assert.deepEqual(both.map((c) => c.syndicate_name).sort(), ['Desk', 'Evil'], 'every root file is served when A2A_SERVED_AGENTS is unset');
      const problems = syndicateOAuthHostProblems(both);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /^Ops · mcp http:\/\/localhost:\d+\/sse · oauth2: provider "tracker" may send its tokens only to 127\.0\.0\.1; localhost \(server\) is not one of them$/);
      await assert.rejects(createA2AApp({ defaultSyndicate: 'evil.yaml', storage: { sessionService: new InProcessSessionService() }, log: () => {}, warn: () => {} }), /evil\.yaml: refusing an OAuth grant the operator's host allowlist does not permit/);
    });
    // With no allowlist, the authorization-code grant itself is refused at load.
    await underHosts(undefined, async () => {
      await assert.rejects(createA2AApp({ defaultSyndicate: 'desk.yaml', storage: { sessionService: new InProcessSessionService() }, log: () => {}, warn: () => {} }), /an authorization_code grant sends each user's own token, so the operator binds the provider to its hosts first/);
    });
  } finally {
    process.env.MELCHIZEDEK_AGENTS_DIR = saved;
  }
});

test('at compile: an MCP server or an OpenAPI server outside the provider\'s hosts fails the compile, before anything is sent', async () => {
  const sent = received.length;
  const tokens = tokenRequests.length;
  await underHosts(HOSTS, async () => {
    await assert.rejects(createMcpTools(`${foreign}/sse`, { tools: ['lookup'], oauth2: authCode() }), /localhost \(server\) is not one of them/);
    await assert.rejects(createMcpTools(`${foreign}/sse`, { oauth2: clientCreds() }), /localhost \(server\) is not one of them/);
    // A token endpoint of the YAML's own would receive the client secret.
    await assert.rejects(createMcpTools(`${base}/sse`, { oauth2: clientCreds(foreign) }), /localhost \(token_url\) is not one of them/);
    const dir = mkdtempSync(join(tmpdir(), 'melch-oauth-hosts-openapi-'));
    writeFileSync(join(dir, 'api.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, servers: [{ url: `${foreign}/api` }], paths: { '/whoami': { get: { operationId: 'whoami', responses: { '200': { description: 'ok' } } } } } }));
    await assert.rejects(buildOpenApiOwnTools({ spec: 'api.json', auth: { oauth2: authCode() } }, dir), /openapi api\.json: provider "tracker" may send its tokens only to 127\.0\.0\.1; localhost \(server\)/);
    // The consent step's clients: an endpoint off the list is refused at boot.
    assert.throws(() => oauthClientsFor([{ orchestrator: { name: 'Ops', mcp_server_url: `${base}/sse`, mcp_auth: { oauth2: authCode(foreign) } } }]), /localhost \(token_url\) is not one of them/);
  });
  assert.equal(received.length, sent, 'no request reached the server');
  assert.equal(tokenRequests.length, tokens, 'no token request was made');
});

test('at call time: tools compiled under the allowlist refuse to send a token once their host is off it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-oauth-hosts-call-'));
  writeFileSync(join(dir, 'api.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, servers: [{ url: `${base}/api` }], paths: { '/whoami': { get: { operationId: 'whoami', responses: { '200': { description: 'ok' } } } } } }));
  const userToken = `fake-user-${randomBytes(6).toString('hex')}`;
  userTokens.set(userToken, 'alice');
  const ctx = { appName: 'app', userId: 'alice', accessToken: async () => userToken } as any;

  const [openapiUser, openapiServer, mcpUser, mcpServer] = await underHosts(HOSTS, async () => [
    (await buildOpenApiOwnTools({ spec: 'api.json', auth: { oauth2: authCode() } }, dir))[0]!,
    (await buildOpenApiOwnTools({ spec: 'api.json', auth: { oauth2: clientCreds() } }, dir))[0]!,
    (await createMcpTools(`${base}/sse`, { tools: ['lookup'], oauth2: authCode() })).find((t) => t.name === 'lookup')!,
    (await createMcpTools(`${base}/sse`, { oauth2: clientCreds() })).find((t) => t.name === 'lookup')!,
  ]);
  // Permitted: each reaches the server with its token.
  await underHosts(HOSTS, async () => {
    assert.match(JSON.stringify(await openapiUser.execute({}, ctx)), /"caller":"alice"/);
    assert.match(JSON.stringify(await openapiServer.execute({}, ctx)), /"caller":"server"/);
    assert.match(String(await mcpServer.execute({ id: 'T-2' }, ctx)), /T-2 is open \(for the server\)/);
  });

  // The operator takes 127.0.0.1 off the list: nothing more leaves.
  const sent = received.length;
  const tokens = tokenRequests.length;
  await underHosts('tracker=api.example.com; tracker-server=api.example.com', async () => {
    const refusal = /may not be sent to this host: the operator's OAuth host allowlist \(MELCHIZEDEK_OAUTH_HOSTS\) does not include it/;
    assert.match(String(((await openapiUser.execute({}, ctx)) as { error: string }).error), refusal);
    assert.match(String(((await openapiServer.execute({}, ctx)) as { error: string }).error), refusal);
    assert.match(String(await mcpUser.execute({ id: 'T-3' }, ctx)), refusal);
    assert.match(String(await mcpServer.execute({ id: 'T-3' }, ctx)), /\[MCP ERROR\] Tool lookup failed/);
    // A refresh token goes nowhere either.
    const refresh = oauthRefreshProviders({ tracker: { authorizationUrl: `${base}/authorize`, tokenUrl: `${base}/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } }, { allowPrivate: true }).tracker!;
    await assert.rejects(refresh.refresh!('fake-refresh', { scopes: [] }), (e: unknown) => e instanceof ToolCredentialError && e.code === 'host_refused' && e.allowlist === 'oauth' && /OAuth host allowlist \(MELCHIZEDEK_OAUTH_HOSTS\)/.test(e.message) && !e.message.includes('MELCHIZEDEK_CREDENTIAL_HOSTS'));
    // The token source refuses a destination off the list, whatever its compile allowed.
    const source = await underHosts(HOSTS, () => oauthTokenSource(authCode(), 'x', `${base}/sse`));
    await assert.rejects(source(ctx, `${base}/sse`), (e: unknown) => e instanceof ToolCredentialError && e.code === 'host_refused' && e.allowlist === 'oauth' && !e.message.includes(userToken));
  });
  assert.deepEqual(received.slice(sent).filter((r) => r.token), [], 'no request carried a token');
  assert.equal(tokenRequests.length, tokens, 'no token or refresh request');
  // A destination other than the compiled one is refused even while the compiled one is permitted.
  await underHosts(HOSTS, async () => {
    const source = oauthTokenSource(authCode(), 'x', `${base}/sse`);
    await assert.rejects(source(ctx, `${foreign}/sse`), (e: unknown) => e instanceof ToolCredentialError && e.code === 'host_refused');
  });
});

// ── The server binary's wiring, end to end ───────────────────────────────────

test('the server wiring: key, redirect URI and allowlist from the environment take an allowlisted grant through consent to the MCP server', async () => {
  writeFileSync(join(agentsDir, 'desk.yaml'), deskYaml('Desk', base));
  writeFileSync(join(agentsDir, 'evil.yaml'), deskYaml('Evil', foreign, authCode(base)));

  // The redirect URI names the server's own port, so the port is taken first.
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const addr = http.address();
  const server = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const key = randomBytes(32).toString('base64');
  process.env.MELCHIZEDEK_CREDENTIAL_KEY = key;
  process.env.OAUTH_REDIRECT_URI = `${server}/oauth/callback`;
  process.env.OAUTH_CALLBACK_IDENTITY = 'state';
  process.env.MELCHIZEDEK_OAUTH_HOSTS = HOSTS;

  const logs: string[] = [];
  try {
    // A2A_SERVED_AGENTS unset would serve evil.yaml too: the wiring refuses to start.
    assert.throws(() => serverOAuth({ syndicateName: 'desk.yaml' }), /localhost \(server\) is not one of them/);
    // The operator serves desk only.
    const oauth = serverOAuth({ syndicateName: 'desk.yaml', servedAgents: ['desk'] });
    assert.ok(oauth.toolCredentials?.consent, oauth.summary);
    assert.equal(oauth.toolCredentials?.requireCallerIdentity, false);
    assert.match(oauth.summary, /^sealed \(key [0-9a-f]{12}\) in process memory; consent at \/oauth\/callback for tracker · host allowlist for tracker, tracker-server$/);
    assert.ok(!oauth.summary.includes(key) && !oauth.warnings.join(' ').includes(key), 'the key never appears');
    assert.ok(oauth.warnings.some((w) => /process memory/.test(w)));
    assert.ok(oauth.warnings.some((w) => /OAUTH_CALLBACK_IDENTITY=state/.test(w)));

    const ops = new ScriptedLlm('scripted/ops', (req: any) => {
      const last = JSON.stringify(req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response ?? null);
      if (/is open/.test(last)) return text(`Found: ${JSON.parse(last).result}`);
      if (/call it again/.test(last)) return call('lookup', { id: 'T-1' });
      return call('lookup', {});
    });
    const router = new ScriptedLlm('scripted/router', () => text('{"route":"Ops","reason":"tracker"}'));
    const chat = new ScriptedLlm('scripted/chat', () => text('chat'));
    const resolver = scriptedResolver({ router, chat, ops });
    const built = await createA2AApp({
      defaultSyndicate: 'desk.yaml',
      storage: { sessionService: new InProcessSessionService() },
      toolCredentials: oauth.toolCredentials,
      resolveModel: (name) => resolver(name) as any,
      log: (m) => logs.push(m),
      warn: (m) => logs.push(m),
    });
    http.on('request', built.app);

    const send = async (path: string, message: string, ids: { contextId?: string; taskId?: string } = {}) => {
      const res = await fetch(`${server}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': 'alice' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: message }], ...ids } } }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const statusText = (task: any) => (task.status?.message?.parts ?? []).map((p: any) => p.text ?? '').join('');

    // The foreign syndicate is refused when its route loads it, and nothing reaches the MCP server.
    const sent = received.length;
    const evil = await send('/evil/a2a/jsonrpc', 'is T-1 open?');
    assert.equal(evil.status, 503);
    assert.ok(logs.some((l) => /Agent 'evil' could not be loaded: evil\.yaml: refusing an OAuth grant/.test(l)), logs.join('\n'));
    assert.equal(received.length, sent);

    // The allowlisted one pauses for consent.
    const first = (await send('/a2a/jsonrpc', 'is T-1 open?')).body.result;
    assert.equal(first.status.state, 'input-required', statusText(first));
    const request = (first.status.message.parts as any[]).find((p) => p.kind === 'data')?.data;
    assert.equal(request.type, 'consent_request');
    assert.equal(request.provider, 'tracker');
    assert.equal(received.length, sent, 'nothing reached the MCP server before the grant');

    // The browser: the provider, then the server's callback.
    const atProvider = await fetch(request.authorization_url, { redirect: 'manual' });
    assert.equal(atProvider.status, 302);
    const back = new URL(atProvider.headers.get('location')!);
    assert.equal(back.origin + back.pathname, `${server}/oauth/callback`);
    const callback = await fetch(back, { redirect: 'manual' });
    assert.equal(callback.status, 200, await callback.text());

    // The next message resumes the call: the user's own token reaches the allowlisted MCP server.
    const callsBefore = mcpCalls.length;
    const second = (await send('/a2a/jsonrpc', 'done', { contextId: first.contextId, taskId: first.id })).body.result;
    assert.equal(second.status.state, 'completed', statusText(second));
    assert.match(statusText(second), /Found: T-1 is open \(for alice\)/);
    const calls = mcpCalls.slice(callsBefore);
    assert.equal(calls.length, 1);
    assert.equal(userTokens.get(calls[0]!.token), 'alice', 'the user\'s own token');
    const secrets = [key, CLIENT_SECRET, ...userTokens.keys()];
    for (const s of secrets) assert.ok(!logs.join('\n').includes(s), 'no key, secret or token in the server log');
    await built.shutdown(0);
  } finally {
    http.closeAllConnections?.();
    http.close();
    for (const name of ['MELCHIZEDEK_CREDENTIAL_KEY', 'OAUTH_REDIRECT_URI', 'OAUTH_CALLBACK_IDENTITY', 'MELCHIZEDEK_OAUTH_HOSTS']) delete process.env[name];
  }
});

test('the server wiring refuses what cannot work: a redirect URI without a key, a malformed key, a redirect with a query', () => {
  const configs = [loadSyndicate('desk.yaml')];
  const env = (extra: Record<string, string>) => ({ ...process.env, MELCHIZEDEK_OAUTH_HOSTS: HOSTS, ...extra });
  assert.throws(() => oauthServerSetup({ configs, env: env({ OAUTH_REDIRECT_URI: 'https://agents.example.com/oauth/callback' }) }), /OAUTH_REDIRECT_URI is set but MELCHIZEDEK_CREDENTIAL_KEY is not/);
  const malformed = 'fake-not-a-key';
  assert.throws(() => oauthServerSetup({ configs, env: env({ MELCHIZEDEK_CREDENTIAL_KEY: malformed }) }), (e: unknown) => e instanceof Error && /MELCHIZEDEK_CREDENTIAL_KEY must be 32 random bytes/.test(e.message) && !e.message.includes(malformed));
  assert.match(redirectUriProblem('https://agents.example.com/cb?x=1')!, /query or a fragment/);
  assert.match(redirectUriProblem('http://agents.example.com/cb')!, /must use https/);
  // No key: the store is off, and an authorization-code grant is said to answer unavailable.
  const off = oauthServerSetup({ configs, env: env({}) });
  assert.equal(off.toolCredentials, undefined);
  assert.ok(off.warnings.some((w) => /authorization_code grants \(tracker\) are declared but MELCHIZEDEK_CREDENTIAL_KEY is not set/.test(w)));
  // A key without a redirect URI: a store, no consent step.
  const noConsent = oauthServerSetup({ configs, env: env({ MELCHIZEDEK_CREDENTIAL_KEY: randomBytes(32).toString('hex') }), rows: memoryCredentialRows() });
  assert.ok(noConsent.toolCredentials?.store && !noConsent.toolCredentials.consent);
  assert.ok(noConsent.warnings.some((w) => /OAUTH_REDIRECT_URI is not set: a user who has not connected tracker cannot be asked to/.test(w)));
  // The key and allowlist need nothing from a deployment that declares no grant.
  assert.deepEqual(oauthEnvProblems([], {}), []);
});

// ── The doctor ───────────────────────────────────────────────────────────────

test('the doctor reports a missing key, a missing redirect URI, a missing allowlist and a foreign host, names only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-oauth-hosts-doctor-'));
  writeFileSync(join(dir, 'desk.yaml'), deskYaml('Desk', base));
  writeFileSync(join(dir, 'evil.yaml'), deskYaml('Evil', foreign, authCode(base)));
  const saved = { ...process.env };
  try {
    for (const name of ['MELCHIZEDEK_CREDENTIAL_KEY', 'OAUTH_REDIRECT_URI', 'MELCHIZEDEK_OAUTH_HOSTS']) delete process.env[name];
    const bare = runDoctor({ agentsDir: dir });
    const problems = bare.oauth!.problems.join('\n');
    assert.match(problems, /authorization_code grants \(tracker\) need MELCHIZEDEK_CREDENTIAL_KEY/);
    assert.match(problems, /authorization_code grants \(tracker\) need OAUTH_REDIRECT_URI/);
    assert.match(problems, /authorization_code grants \(tracker\) need MELCHIZEDEK_OAUTH_HOSTS/);
    assert.deepEqual(bare.oauth!.set, { MELCHIZEDEK_CREDENTIAL_KEY: false, OAUTH_REDIRECT_URI: false, MELCHIZEDEK_OAUTH_HOSTS: false });
    const out = renderDoctor(bare);
    assert.match(out, /oauth       ✗ MELCHIZEDEK_CREDENTIAL_KEY unset · OAUTH_REDIRECT_URI unset · MELCHIZEDEK_OAUTH_HOSTS unset/);
    assert.match(out, /✗ provider "tracker": an authorization_code grant sends each user's own token/);

    const key = randomBytes(32).toString('base64');
    process.env.MELCHIZEDEK_CREDENTIAL_KEY = key;
    process.env.OAUTH_REDIRECT_URI = 'https://agents.example.com/oauth/callback';
    process.env.MELCHIZEDEK_OAUTH_HOSTS = HOSTS;
    process.env.A2A_AUTH = 'header';
    const configured = runDoctor({ agentsDir: dir });
    assert.deepEqual(configured.oauth!.problems, []);
    const evil = configured.syndicates.find((s) => s.file === 'evil.yaml')!.grants![0]!;
    assert.match(evil.hostProblems.join('\n'), /localhost \(server\) is not one of them/);
    assert.deepEqual(configured.syndicates.find((s) => s.file === 'desk.yaml')!.grants![0]!.hostProblems, []);
    // A grant whose hosts the allowlist refuses is a problem --check exits non-zero on; the permitted one is not.
    const failing = checkProblems(configured);
    assert.ok(failing.some((p) => p.startsWith('evil.yaml: Ops · tracker: ') && /localhost \(server\) is not one of them/.test(p)), failing.join('\n'));
    assert.ok(!failing.some((p) => p.startsWith('desk.yaml')), failing.join('\n'));
    assert.deepEqual(checkProblems({ ...configured, syndicates: configured.syndicates.filter((s) => s.file !== 'evil.yaml') }).filter((p) => /tracker: /.test(p)), []);
    const rendered = renderDoctor(configured);
    assert.match(rendered, /oauth       ✓ MELCHIZEDEK_CREDENTIAL_KEY set · OAUTH_REDIRECT_URI set · MELCHIZEDEK_OAUTH_HOSTS set/);
    assert.ok(!rendered.includes(key) && !JSON.stringify(configured).includes(key), 'the key never appears');

    // Behind no gateway, a required callback identity refuses every callback: the doctor says so.
    delete process.env.A2A_AUTH;
    assert.match(runDoctor({ agentsDir: dir }).oauth!.problems.join('\n'), /every callback is refused/);
    // A malformed key is named, not shown.
    process.env.MELCHIZEDEK_CREDENTIAL_KEY = 'fake-short-key';
    const bad = runDoctor({ agentsDir: dir }).oauth!.problems.join('\n');
    assert.match(bad, /MELCHIZEDEK_CREDENTIAL_KEY must be 32 random bytes/);
    assert.ok(!bad.includes('fake-short-key'));
  } finally {
    for (const name of ['MELCHIZEDEK_CREDENTIAL_KEY', 'OAUTH_REDIRECT_URI', 'MELCHIZEDEK_OAUTH_HOSTS', 'A2A_AUTH']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test('melchizedek-doctor --check exits non-zero on a grant whose hosts the OAuth allowlist refuses, and zero once it is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-oauth-hosts-check-'));
  // Local models, so no syndicate is blocked: only the grant's hosts decide.
  const local = (yaml: string) => yaml.replaceAll('scripted/', 'ollama/');
  writeFileSync(join(dir, 'desk.yaml'), local(deskYaml('Desk', base)));
  const doctor = resolve('scripts/doctor.ts');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    MELCHIZEDEK_AGENTS_DIR: dir,
    MELCHIZEDEK_CREDENTIAL_KEY: randomBytes(32).toString('base64'),
    OAUTH_REDIRECT_URI: 'https://agents.example.com/oauth/callback',
    MELCHIZEDEK_OAUTH_HOSTS: HOSTS,
    A2A_AUTH: 'header',
  };
  const run = () => spawnSync(process.execPath, ['--disable-warning=DEP0040', '--experimental-strip-types', doctor, '--check', '--no-color'], { cwd: dir, env, encoding: 'utf8' });
  const clean = run();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  writeFileSync(join(dir, 'evil.yaml'), local(deskYaml('Evil', foreign, authCode(base))));
  const refused = run();
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /localhost \(server\) is not one of them/);
  assert.ok(!refused.stdout.includes(env.MELCHIZEDEK_CREDENTIAL_KEY!), 'the key never appears');
});
