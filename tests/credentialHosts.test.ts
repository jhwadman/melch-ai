/**
 * tests/credentialHosts.test.ts — the operator's credential host allowlist
 * (ADR 0122), offline: a mock API and token endpoint on a local HTTP server
 * in this test, reached as 127.0.0.1 (the bound host) and as localhost (the
 * same server under a host no binding names).
 *
 * Covers: the allowlist's format and rule (none configured: every
 * credential goes where the YAML says, as before; configured: it is the
 * whole list); a static `bearer_env` / `api_key` and a `client_secret_env`
 * refused to a foreign host when a served syndicate loads, when its tools
 * compile and at call time, with nothing sent; the same credentials allowed
 * to their own host; unbound credentials working as before, named by the
 * server binary's wiring and by the doctor (names only, never a value); and
 * the server binary reading MELCHIZEDEK_CREDENTIAL_HOSTS at boot.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.DATABASE_URL;
for (const name of ['MELCHIZEDEK_CREDENTIAL_HOSTS', 'MELCHIZEDEK_OAUTH_HOSTS', 'MELCHIZEDEK_CREDENTIAL_KEY', 'OAUTH_REDIRECT_URI', 'OPENAPI_CREDENTIAL_ENVS']) delete process.env[name];

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';

import { createA2AApp } from '../lib/a2a/app.ts';
import { oauthServerSetup } from '../lib/a2a/oauthSetup.ts';
import { renderDoctor, runDoctor } from '../lib/doctor.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { ToolCredentialError } from '../lib/tools/auth.ts';
import { credentialCipherFromEnv } from '../lib/tools/credentialCipher.ts';
import { checkCredentialHosts, credentialHostProblem, credentialHosts, parseCredentialHosts, setCredentialHosts } from '../lib/tools/credentialHosts.ts';
import { syndicateCredentialHostProblems, syndicateCredentialUses } from '../lib/tools/credentialUses.ts';
import { credentialStore, memoryCredentialRows } from '../lib/tools/credentialStore.ts';
import { ConsentError, oauthConsent } from '../lib/tools/oauthConsent.ts';
import { oauthClientsFor, oauthRefreshProviders, oauthTokenSource } from '../lib/tools/oauthTools.ts';
import type { OAuth2AuthConfig } from '../lib/tools/oauthTools.ts';
import { buildOpenApiOwnTools } from '../lib/tools/openapiTools.ts';
import { serverOAuth } from '../scripts/a2a_server.ts';

// ── The mock API and token endpoint ──────────────────────────────────────────

const TOKEN_ENV = 'TRACKER_STATIC_TEST_TOKEN';
const KEY_ENV = 'WEATHER_STATIC_TEST_KEY';
const SECRET_ENV = 'TRACKER_STATIC_TEST_SECRET';
const TOKEN = `fake-static-token-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
const KEY = `fake-static-key-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
const SECRET = `fake-static-secret-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
const CLIENT_ID = 'melch-static-client';
process.env[TOKEN_ENV] = TOKEN;
process.env[KEY_ENV] = KEY;
process.env[SECRET_ENV] = SECRET;

/** Every request the mock received: its host header, path, bearer, query key and form secret. */
const received: Array<{ host: string; path: string; bearer: string; key: string; secret: string }> = [];
/** Did anything carrying one of the three values reach the mock? */
const leaked = (from: number) => received.slice(from).filter((r) => r.bearer === TOKEN || r.key === KEY || r.secret === SECRET);

let mock: HttpServer;
let base = ''; // http://127.0.0.1:<port>: the bound host
let foreign = ''; // http://localhost:<port>: the same server under a host no binding names

before(async () => {
  const app = express();
  const note = (req: express.Request, secret = '') =>
    received.push({ host: String(req.headers.host ?? ''), path: req.path, bearer: (req.headers.authorization ?? '').replace(/^Bearer /, ''), key: String(req.query.key ?? ''), secret });
  app.get('/api/whoami', (req, res) => {
    note(req);
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (bearer === TOKEN) return void res.json({ caller: 'bearer' });
    if (req.query.key === KEY) return void res.json({ caller: 'api_key' });
    if (bearer.startsWith('fake-server-')) return void res.json({ caller: 'server' });
    res.status(401).json({ error: 'unauthorized' });
  });
  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const form = new URLSearchParams(req.body as Record<string, string>);
    note(req, form.get('client_secret') ?? '');
    if (form.get('client_secret') !== SECRET) return void res.status(401).json({ error: 'invalid_client' });
    res.json({ access_token: `fake-server-${randomBytes(6).toString('hex')}`, token_type: 'Bearer', expires_in: 3600, refresh_token: 'fake-refresh-next' });
  });
  mock = app.listen(0, '127.0.0.1');
  await new Promise((r) => mock.once('listening', r));
  const addr = mock.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  foreign = `http://localhost:${port}`;
  process.env.ALLOW_PRIVATE_OPENAPI = 'true';
  process.env.ALLOW_PRIVATE_MCP = 'true';
  process.env.MELCHIZEDEK_RUNTIME = 'native';
});

after(() => {
  mock?.closeAllConnections?.();
  mock?.close();
  setCredentialHosts(undefined);
  for (const name of ['ALLOW_PRIVATE_OPENAPI', 'ALLOW_PRIVATE_MCP', TOKEN_ENV, KEY_ENV, SECRET_ENV, 'MELCHIZEDEK_CREDENTIAL_HOSTS', 'MELCHIZEDEK_RUNTIME']) delete process.env[name];
});

/** Runs `fn` under this credential allowlist (the environment variable), then restores none. */
async function underHosts<T>(spec: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const before = process.env.MELCHIZEDEK_CREDENTIAL_HOSTS;
  if (spec === undefined) delete process.env.MELCHIZEDEK_CREDENTIAL_HOSTS;
  else process.env.MELCHIZEDEK_CREDENTIAL_HOSTS = spec;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.MELCHIZEDEK_CREDENTIAL_HOSTS;
    else process.env.MELCHIZEDEK_CREDENTIAL_HOSTS = before;
  }
}
const HOSTS = `${TOKEN_ENV}=127.0.0.1; ${KEY_ENV}=127.0.0.1; ${SECRET_ENV}=127.0.0.1`;
const ELSEWHERE = `${TOKEN_ENV}=api.example.com; ${KEY_ENV}=api.example.com; ${SECRET_ENV}=auth.example.com`;

/** A spec file whose server is `origin`/api, in a fresh directory. */
function specDir(origin: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'melch-credential-hosts-'));
  writeFileSync(join(dir, 'api.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, servers: [{ url: `${origin}/api` }], paths: { '/whoami': { get: { operationId: 'whoami', responses: { '200': { description: 'ok' } } } } } }));
  return dir;
}
const bearerAuth = { bearer_env: TOKEN_ENV };
const keyAuth = { api_key: { env: KEY_ENV, in: 'query' as const, name: 'key' } };
const clientCreds = (origin = base): OAuth2AuthConfig => ({ provider: 'tracker-server', grant: 'client_credentials', token_url: `${origin}/token`, client_id: CLIENT_ID, client_secret_env: SECRET_ENV });
const authCode = (origin = base): OAuth2AuthConfig => ({
  provider: 'tracker',
  grant: 'authorization_code',
  authorization_url: `${origin}/authorize`,
  token_url: `${origin}/token`,
  client_id: CLIENT_ID,
  client_secret_env: SECRET_ENV,
});

// ── The allowlist ────────────────────────────────────────────────────────────

test('the allowlist: its format, its wildcard, and what it refuses to hold', () => {
  assert.deepEqual(parseCredentialHosts('TRACKER_TOKEN=API.Tracker.example.com, *.tracker.example.com;\n WEATHER_KEY=api.weather.example.com;LOCAL=127.0.0.1,[::1]'), {
    TRACKER_TOKEN: ['api.tracker.example.com', '*.tracker.example.com'],
    WEATHER_KEY: ['api.weather.example.com'],
    LOCAL: ['127.0.0.1', '[::1]'],
  });
  for (const [spec, message] of [
    ['TRACKER_TOKEN', /each entry is VARIABLE=host,host/],
    ['tracker_token=api.example.com', /not an environment variable name/],
    ['TRACKER_TOKEN=https://api.example.com', /not a hostname/],
    ['TRACKER_TOKEN=api.example.com:443', /not a hostname/],
    ['TRACKER_TOKEN=*.com', /wildcard over a top-level domain/],
    ['TRACKER_TOKEN=', /needs at least one host/],
    ['TRACKER_TOKEN=a.example.com;TRACKER_TOKEN=b.example.com', /listed twice/],
  ] as const) {
    assert.throws(() => parseCredentialHosts(spec), message, spec);
  }
  assert.throws(() => checkCredentialHosts({ TRACKER_TOKEN: ['-bad.example.com'] }), /not a hostname/);
  // Long runs of separators and a long name parse in linear time (no backtracking pattern).
  const started = Date.now();
  assert.throws(() => parseCredentialHosts(`T=${'a.'.repeat(50_000)}!`));
  assert.throws(() => parseCredentialHosts(`${'A'.repeat(100_000)}!=x.example.com`));
  assert.throws(() => parseCredentialHosts(';'.repeat(100_000) + '='));
  assert.ok(Date.now() - started < 1000);
});

test('the rule: with no allowlist every credential goes where the YAML says; with one, it is the whole list', async () => {
  assert.equal(credentialHostProblem(TOKEN_ENV, 'https://anywhere.example', 'server', null), null);
  const list = parseCredentialHosts(`${TOKEN_ENV}=api.example.com,*.cdn.example.com`);
  assert.equal(credentialHostProblem(TOKEN_ENV, 'https://api.example.com/v1', 'server', list), null);
  assert.equal(credentialHostProblem(TOKEN_ENV, 'https://eu.cdn.example.com/', 'server', list), null);
  assert.match(credentialHostProblem(TOKEN_ENV, 'https://evil.example/collect', 'server', list)!, new RegExp(`${TOKEN_ENV} may be sent only to api\\.example\\.com, \\*\\.cdn\\.example\\.com; evil\\.example \\(server\\) is not one of them`));
  assert.match(credentialHostProblem(KEY_ENV, 'https://api.example.com', 'server', list)!, new RegExp(`${KEY_ENV} is not on the operator's credential host allowlist`));
  // createA2AApp's option wins over the variable; undefined returns to it.
  await underHosts(`${TOKEN_ENV}=from-env.example.com`, () => {
    setCredentialHosts({ [TOKEN_ENV]: ['from-option.example.com'] });
    assert.deepEqual(credentialHosts(), { [TOKEN_ENV]: ['from-option.example.com'] });
    setCredentialHosts(undefined);
    assert.deepEqual(credentialHosts(), { [TOKEN_ENV]: ['from-env.example.com'] });
  });
  assert.throws(() => setCredentialHosts({ [TOKEN_ENV]: ['https://x.example.com'] }), /not a hostname/);
});

// ── A foreign host: at load, at compile, at call ─────────────────────────────

/** A syndicate whose one agent calls the API at `origin` with `auth`, and an MCP server whose grant's secret goes to `tokenOrigin`. */
function apiYaml(name: string, dir: string, auth: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    syndicate_name: name,
    orchestrator: { name: 'Api', model: 'scripted/api', instruction: 'Call the API.', openapi: [{ spec: join(dir, 'api.json'), auth, ...extra }] },
  });
}

test('at load: a served syndicate that sends a bound credential to a foreign host is refused, by the server wiring and by createA2AApp', async () => {
  const agents = mkdtempSync(join(tmpdir(), 'melch-credential-hosts-load-'));
  writeFileSync(join(agents, 'good.yaml'), apiYaml('Good', specDir(base), bearerAuth));
  writeFileSync(join(agents, 'evil.yaml'), apiYaml('Evil', specDir(foreign), bearerAuth));
  writeFileSync(join(agents, 'override.yaml'), apiYaml('Override', specDir(base), keyAuth, { base_url: `${foreign}/api` }));
  writeFileSync(join(agents, 'secret.yaml'), JSON.stringify({ syndicate_name: 'Secret', orchestrator: { name: 'Ops', model: 'scripted/ops', instruction: 'x', mcp_server_url: `${base}/sse`, mcp_auth: { oauth2: clientCreds(foreign) } } }));
  const saved = process.env.MELCHIZEDEK_AGENTS_DIR;
  process.env.MELCHIZEDEK_AGENTS_DIR = agents;
  const sent = received.length;
  try {
    await underHosts(HOSTS, async () => {
      const load = (f: string) => loadSyndicate(f);
      assert.deepEqual(syndicateCredentialHostProblems([load('good.yaml')]), []);
      assert.match(syndicateCredentialHostProblems([load('evil.yaml')]).join('\n'), new RegExp(`^Api · openapi .*api\\.json · bearer_env: ${TOKEN_ENV} may be sent only to 127\\.0\\.0\\.1; localhost \\(server\\) is not one of them$`));
      assert.match(syndicateCredentialHostProblems([load('override.yaml')]).join('\n'), new RegExp(`api_key: ${KEY_ENV} may be sent only to 127\\.0\\.0\\.1; localhost \\(server\\)`));
      assert.match(syndicateCredentialHostProblems([load('secret.yaml')]).join('\n'), new RegExp(`^Ops · mcp .*/sse · client_secret_env: ${SECRET_ENV} may be sent only to 127\\.0\\.0\\.1; localhost \\(token_url\\)`));
      const app = (file: string) => createA2AApp({ defaultSyndicate: file, storage: { sessionService: new InProcessSessionService() }, log: () => {}, warn: () => {} });
      for (const file of ['evil.yaml', 'override.yaml', 'secret.yaml']) {
        await assert.rejects(app(file), new RegExp(`${file.replace('.', '\\.')}: refusing a credential the operator's credential host allowlist does not permit`), file);
      }
      // A variable the allowlist does not name is refused too: configured, the list is whole.
      await underHosts(`${KEY_ENV}=127.0.0.1`, async () => {
        await assert.rejects(app('good.yaml'), new RegExp(`${TOKEN_ENV} is not on the operator's credential host allowlist`));
      });
      // The server binary's boot refuses the same file, naming the variable and never its value.
      assert.throws(
        () => serverOAuth({ syndicateName: 'evil.yaml', servedAgents: ['evil'], env: process.env }),
        (e: unknown) => e instanceof Error && /refusing a credential the operator's credential host allowlist does not permit/.test(e.message) && e.message.includes(TOKEN_ENV) && !e.message.includes(TOKEN),
      );
      // The bound file loads and serves.
      const built = await app('good.yaml');
      await built.shutdown(0);
    });
  } finally {
    process.env.MELCHIZEDEK_AGENTS_DIR = saved;
  }
  assert.deepEqual(leaked(sent), [], 'nothing carrying a credential reached the mock');
});

test('at compile: a bound credential aimed at a foreign host fails the compile, before anything is sent', async () => {
  const sent = received.length;
  await underHosts(HOSTS, async () => {
    await assert.rejects(buildOpenApiOwnTools({ spec: 'api.json', auth: bearerAuth }, specDir(foreign)), new RegExp(`openapi api\\.json: ${TOKEN_ENV} may be sent only to 127\\.0\\.0\\.1; localhost \\(server\\)`));
    await assert.rejects(buildOpenApiOwnTools({ spec: 'api.json', auth: keyAuth, base_url: `${foreign}/api` }, specDir(base)), new RegExp(`${KEY_ENV} may be sent only to 127\\.0\\.0\\.1`));
    // A client secret aimed at a token endpoint of the YAML's own.
    await assert.rejects(buildOpenApiOwnTools({ spec: 'api.json', auth: { oauth2: clientCreds(foreign) } }, specDir(base)), new RegExp(`${SECRET_ENV} may be sent only to 127\\.0\\.0\\.1; localhost \\(token_url\\)`));
    // The consent step's clients: refused at boot.
    assert.throws(() => oauthClientsFor([{ orchestrator: { name: 'Ops', mcp_server_url: `${base}/sse`, mcp_auth: { oauth2: authCode(foreign) } } }], { allowlist: { tracker: ['127.0.0.1', 'localhost'] } }), new RegExp(`${SECRET_ENV} may be sent only to 127\\.0\\.0\\.1; localhost \\(token_url\\)`));
  });
  assert.equal(received.length, sent, 'no request reached the mock');
});

test('allowed to its host, and at call time refused with nothing sent once the operator moves the binding', async () => {
  const dir = specDir(base);
  const ctx = { appName: 'app', userId: 'alice' } as any;
  const [bearerTool, keyTool, serverTool] = await underHosts(HOSTS, async () => [
    (await buildOpenApiOwnTools({ spec: 'api.json', auth: bearerAuth }, dir))[0]!,
    (await buildOpenApiOwnTools({ spec: 'api.json', auth: keyAuth }, dir))[0]!,
    (await buildOpenApiOwnTools({ spec: 'api.json', auth: { oauth2: clientCreds() } }, dir))[0]!,
  ]);
  // Bound to 127.0.0.1: each reaches its own host with its credential.
  await underHosts(HOSTS, async () => {
    assert.deepEqual(await bearerTool.execute({}, ctx), { caller: 'bearer' });
    assert.deepEqual(await keyTool.execute({}, ctx), { caller: 'api_key' });
    assert.deepEqual(await serverTool.execute({}, ctx), { caller: 'server' });
  });
  assert.ok(received.some((r) => r.secret === SECRET && r.host.startsWith('127.0.0.1')), 'the client secret went to its bound token endpoint');

  // The operator binds the variables elsewhere: nothing more leaves.
  const sent = received.length;
  await underHosts(ELSEWHERE, async () => {
    for (const tool of [bearerTool, keyTool]) {
      const out = (await tool.execute({}, ctx)) as { error: string };
      assert.match(out.error, /whoami was not called: the operator's credential host allowlist does not let this API's credential be sent to 127\.0\.0\.1/);
      assert.ok(!out.error.includes(TOKEN) && !out.error.includes(KEY));
    }
    // The server's own token is held from before; a fresh source must fetch one, and is refused.
    const source = await underHosts(HOSTS, () => oauthTokenSource(clientCreds(), 'x', `${base}/api`, { allowPrivate: true }));
    await assert.rejects(source(ctx, `${base}/api`), (e: unknown) => e instanceof ToolCredentialError && e.code === 'host_refused' && e.allowlist === 'credential' && /client secret may not be sent to this host: the operator's credential host allowlist \(MELCHIZEDEK_CREDENTIAL_HOSTS\)/.test(e.message) && !e.message.includes('MELCHIZEDEK_OAUTH_HOSTS') && !e.message.includes(SECRET));
    // The refresh hook and the consent step's code exchange carry the client secret: refused too.
    const clients = await underHosts(HOSTS, () => oauthClientsFor([{ orchestrator: { name: 'Ops', mcp_server_url: `${base}/sse`, mcp_auth: { oauth2: authCode() } } }], { allowlist: { tracker: ['127.0.0.1'] } }));
    const refresh = oauthRefreshProviders(clients, { allowPrivate: true }).tracker!;
    // The OAuth host allowlist is unset here, so the refresh token is refused first, and the refusal names that list.
    await assert.rejects(refresh.refresh!('fake-refresh', { scopes: [] }), (e: unknown) => e instanceof ToolCredentialError && e.code === 'host_refused' && e.allowlist === 'oauth');
    const cipher = credentialCipherFromEnv({ MELCHIZEDEK_CREDENTIAL_KEY: randomBytes(32).toString('base64') })!;
    const consent = oauthConsent({ providers: clients, redirectUri: 'https://agents.example.com/oauth/callback', credentials: credentialStore({ rows: memoryCredentialRows(), cipher }) });
    const begun = await consent.begin({ appName: 'Desk', userId: 'alice', sessionId: 's1', functionCallId: 'call-1', provider: 'tracker' });
    await assert.rejects(consent.complete({ state: begun.state, code: 'fake-code' }), (e: unknown) => e instanceof ConsentError && e.code === 'exchange_failed');
  });
  assert.deepEqual(received.slice(sent), [], 'no request reached the mock');
  // A malformed allowlist refuses rather than allows.
  await underHosts(`${TOKEN_ENV}=https://bad`, async () => {
    assert.match(((await bearerTool.execute({}, ctx)) as { error: string }).error, /was not called/);
  });
  assert.deepEqual(received.slice(sent), [], 'still nothing');
});

// ── Unbound: as before, named ─────────────────────────────────────────────────

test('unbound: with no allowlist a credential works as before, and the server wiring and the doctor name each variable, never a value', async () => {
  const dir = specDir(base);
  await underHosts(undefined, async () => {
    // As before ADR 0122: compiled and called, to whatever host the YAML names.
    const tool = (await buildOpenApiOwnTools({ spec: 'api.json', auth: bearerAuth }, dir))[0]!;
    assert.deepEqual(await tool.execute({}, {} as any), { caller: 'bearer' });
    const foreignTool = (await buildOpenApiOwnTools({ spec: 'api.json', auth: keyAuth, base_url: `${foreign}/api` }, dir))[0]!;
    assert.deepEqual(await foreignTool.execute({}, {} as any), { caller: 'api_key' });

    const agents = mkdtempSync(join(tmpdir(), 'melch-credential-hosts-unbound-'));
    writeFileSync(join(agents, 'desk.yaml'), apiYaml('Desk', dir, bearerAuth));
    writeFileSync(join(agents, 'weather.yaml'), apiYaml('Weather', dir, keyAuth));
    writeFileSync(join(agents, 'secret.yaml'), JSON.stringify({ syndicate_name: 'Secret', orchestrator: { name: 'Ops', model: 'scripted/ops', instruction: 'x', mcp_server_url: `${base}/sse`, mcp_auth: { oauth2: clientCreds() } } }));
    const configs = ['desk.yaml', 'weather.yaml', 'secret.yaml'].map((f) => loadSyndicate(f, { agentsDir: agents }));
    assert.deepEqual(syndicateCredentialUses(configs).map((u) => `${u.env}:${u.role}`), [`${TOKEN_ENV}:bearer_env`, `${KEY_ENV}:api_key`, `${SECRET_ENV}:client_secret_env`]);
    assert.deepEqual(syndicateCredentialHostProblems(configs), [], 'nothing is refused');

    // The server wiring: a warning naming each variable, and the banner line.
    const setup = oauthServerSetup({ configs, env: process.env });
    const warning = setup.warnings.find((w) => w.includes('MELCHIZEDEK_CREDENTIAL_HOSTS'))!;
    assert.equal(warning, `${SECRET_ENV}, ${TOKEN_ENV}, ${KEY_ENV} are sent to whatever host the YAML names: no MELCHIZEDEK_CREDENTIAL_HOSTS binds them to their hosts.`);
    assert.match(setup.credentialSummary, new RegExp(`no allowlist \\(MELCHIZEDEK_CREDENTIAL_HOSTS\\): ${SECRET_ENV}, ${TOKEN_ENV}, ${KEY_ENV} unbound`));

    // The doctor: a warning, not a --check failure; names only.
    const result = runDoctor({ agentsDir: agents });
    assert.deepEqual(result.credentials!.problems, []);
    assert.deepEqual(result.credentials!.envs, [SECRET_ENV, TOKEN_ENV, KEY_ENV]);
    assert.match(result.credentials!.warning!, new RegExp(`${SECRET_ENV}, ${TOKEN_ENV}, ${KEY_ENV} are sent to whatever host the YAML names`));
    const out = renderDoctor(result);
    assert.match(out, /credentials ⚠ MELCHIZEDEK_CREDENTIAL_HOSTS unset · sent: /);
    for (const value of [TOKEN, KEY, SECRET]) assert.ok(!out.includes(value) && !JSON.stringify(result).includes(value) && !JSON.stringify(setup.warnings).includes(value), 'no value appears');

    // Configured: the warning goes, and a refusal is a problem the doctor's --check fails on.
    await underHosts(`${TOKEN_ENV}=127.0.0.1; ${KEY_ENV}=127.0.0.1`, () => {
      const bound = runDoctor({ agentsDir: agents });
      assert.equal(bound.credentials!.warning, undefined);
      assert.deepEqual(bound.credentials!.problems, [`secret.yaml: Ops · mcp ${base}/sse · client_secret_env: ${SECRET_ENV} is not on the operator's credential host allowlist (MELCHIZEDEK_CREDENTIAL_HOSTS or createA2AApp's credentialHosts), so it is sent nowhere`]);
      assert.match(renderDoctor(bound), /credentials ✗ MELCHIZEDEK_CREDENTIAL_HOSTS set/);
    });
    await underHosts('nonsense', () => {
      assert.match(runDoctor({ agentsDir: agents }).credentials!.problems.join('\n'), /MELCHIZEDEK_CREDENTIAL_HOSTS: each entry is VARIABLE=host,host/);
    });
  });
});

// ── The server binary reads the setting ──────────────────────────────────────

test('the server binary reads MELCHIZEDEK_CREDENTIAL_HOSTS: its banner names the bound variables, and a malformed one stops the boot', async () => {
  const agents = mkdtempSync(join(tmpdir(), 'melch-credential-hosts-boot-'));
  writeFileSync(join(agents, 'desk.yaml'), apiYaml('Desk', specDir(base), bearerAuth));
  const saved = process.env.MELCHIZEDEK_AGENTS_DIR;
  process.env.MELCHIZEDEK_AGENTS_DIR = agents;
  try {
    await underHosts(HOSTS, () => {
      const setup = serverOAuth({ syndicateName: 'desk.yaml', servedAgents: ['desk'], env: process.env });
      assert.equal(setup.credentialSummary, `bound: ${TOKEN_ENV}, ${KEY_ENV}, ${SECRET_ENV} (MELCHIZEDEK_CREDENTIAL_HOSTS)`);
      assert.ok(!setup.warnings.some((w) => w.includes('MELCHIZEDEK_CREDENTIAL_HOSTS')));
    });
    await underHosts(`${TOKEN_ENV}=https://api.example.com`, () => {
      assert.throws(() => serverOAuth({ syndicateName: 'desk.yaml', servedAgents: ['desk'], env: process.env }), /MELCHIZEDEK_CREDENTIAL_HOSTS: TRACKER_STATIC_TEST_TOKEN: host "https:\/\/api\.example\.com" is not a hostname/);
    });
    await underHosts(undefined, () => {
      const setup = serverOAuth({ syndicateName: 'desk.yaml', servedAgents: ['desk'], env: process.env });
      assert.ok(setup.warnings.some((w) => w.startsWith(`${TOKEN_ENV} is sent to whatever host the YAML names`)));
    });
  } finally {
    process.env.MELCHIZEDEK_AGENTS_DIR = saved;
  }
});
