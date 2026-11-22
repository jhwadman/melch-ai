/**
 * tests/mcpStaticCredential.test.ts — a remote MCP server's static
 * credential by variable name (ADR 0163): `auth: { bearer_env }` or
 * `auth: { header: { env, name } }` on an `mcp_servers` entry, or as
 * `mcp_auth` beside `mcp_server_url`.
 *
 * Offline: two Streamable HTTP MCP servers on loopback (two origins), one
 * reading a bearer and one a named header, plus endpoints that redirect to
 * the other origin and that echo the credential back in a 401 body.
 *
 * Covers: the value is read through the credential source first, then the
 * environment, at each request; the variable allowlist comes first; an unset
 * variable, a refused header name, plain http to a non-loopback host and an
 * unbound host fail the compile, naming no value; the credential host
 * allowlist binds it; no redirect to another origin is followed; the value
 * never reaches a log line or a tool result; MCP_BEARER_TOKENS is ignored
 * beside it and still works without it; the schema takes exactly one of
 * oauth2, bearer_env or header.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
for (const name of ['MELCHIZEDEK_OAUTH_HOSTS', 'MELCHIZEDEK_CREDENTIAL_HOSTS', 'MCP_BEARER_TOKENS', 'OPENAPI_CREDENTIAL_ENVS']) delete process.env[name];
process.env.ALLOW_PRIVATE_MCP = 'true';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { compileSpec } from '../lib/compile.ts';
import { setCredentialSource } from '../lib/models/credentialSource.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { credentialHeaderProblem } from '../lib/tools/credentialHeader.ts';
import { setCredentialHosts } from '../lib/tools/credentialHosts.ts';
import { syndicateCredentialHostProblems, syndicateCredentialUses } from '../lib/tools/credentialUses.ts';
import { closeMcpConnections, createMcpTools, mcpStaticCredential } from '../lib/tools/mcpToolFactory.ts';

const BEARER = `fake-mcp-bearer-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
const ROTATED = `fake-mcp-rotated-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
const KEY = `fake-mcp-key-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)

/** What the servers saw: each request's path and the credential it carried. */
const seen: Array<{ origin: 'a' | 'b'; path: string; authorization?: string; key?: string }> = [];

let a: HttpServer;
let b: HttpServer;
let baseA = '';
let baseB = '';

function mcpServer(label: string, accepts: () => string[], read: (req: express.Request) => string | undefined) {
  return (req: express.Request, res: express.Response) => {
    const got = read(req);
    if (!got || !accepts().includes(got)) {
      // Echoes what it was sent: no message the engine writes may repeat it.
      return void res.status(401).send(`unauthorized: ${got ?? 'none'}`);
    }
    const server = new Server({ name: label, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: `${label}_lookup`, description: `lookup on ${label}`, inputSchema: { type: 'object' as const, properties: {} } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text' as const, text: `${label} ran` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    void server.connect(transport).then(() => transport.handleRequest(req, res, req.body));
  };
}

function app(origin: 'a' | 'b') {
  const x = express();
  x.use(express.json());
  x.use((req, _res, next) => {
    seen.push({ origin, path: req.path, ...(req.headers.authorization ? { authorization: String(req.headers.authorization) } : {}), ...(req.headers['x-api-key'] ? { key: String(req.headers['x-api-key']) } : {}) });
    next();
  });
  x.post('/bearer/mcp', mcpServer('bearer', () => [`Bearer ${BEARER}`, `Bearer ${ROTATED}`], (req) => req.headers.authorization));
  x.post('/header/mcp', mcpServer('keyed', () => [KEY], (req) => req.headers['x-api-key'] as string | undefined));
  for (const path of ['/bearer/mcp', '/header/mcp']) {
    x.get(path, (_req, res) => void res.status(405).set('Allow', 'POST').end());
    x.delete(path, (_req, res) => void res.status(405).end());
  }
  // A redirect to the other origin: a credential never follows it.
  x.post('/away/mcp', (_req, res) => void res.redirect(307, `${baseB}/bearer/mcp`));
  return x;
}

before(async () => {
  a = app('a').listen(0, '127.0.0.1');
  b = app('b').listen(0, '127.0.0.1');
  await Promise.all([a, b].map((s) => new Promise<void>((resolve) => s.once('listening', () => resolve()))));
  baseA = `http://127.0.0.1:${(a.address() as { port: number }).port}`;
  baseB = `http://127.0.0.1:${(b.address() as { port: number }).port}`;
});

after(async () => {
  await closeMcpConnections();
  await Promise.all([a, b].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  delete process.env.ALLOW_PRIVATE_MCP;
});

/** Runs `fn`, collecting everything console.warn was given, as text. */
async function warned<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => void lines.push(args.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try {
    return { result: await fn(), text: lines.join('\n') };
  } finally {
    console.warn = original;
  }
}

/** A source holding `held`, and nothing in the environment. */
function withSource(held: Record<string, string>): () => void {
  setCredentialSource((name) => held[name]);
  return () => setCredentialSource(undefined);
}

test('bearer_env: the token is read through the credential source, sent to the server on every request, and read again at each request', async () => {
  const held: Record<string, string> = { TRACKER_MCP_TOKEN: BEARER };
  const restore = withSource(held);
  try {
    seen.length = 0;
    const tools = await createMcpTools(`${baseA}/bearer/mcp`, { credential: { env: 'TRACKER_MCP_TOKEN' }, transport: 'streamable_http' });
    assert.deepEqual(tools.map((t) => t.name), ['bearer_lookup']);
    assert.ok(seen.length >= 2 && seen.every((s) => s.authorization === `Bearer ${BEARER}`), 'every request carried the bearer');
    assert.equal(await tools[0]!.execute({}, {} as never), 'bearer ran');
    // Replaced in the source: the next request sends the new value.
    held.TRACKER_MCP_TOKEN = ROTATED;
    seen.length = 0;
    assert.equal(await tools[0]!.execute({}, {} as never), 'bearer ran');
    assert.ok(seen.length >= 1 && seen.every((s) => s.authorization === `Bearer ${ROTATED}`));
    // Removed: the next call is refused, naming the variable and no value.
    delete held.TRACKER_MCP_TOKEN;
    seen.length = 0;
    const refused = String(await tools[0]!.execute({}, {} as never));
    assert.equal(seen.length, 0, 'nothing was sent');
    assert.match(refused, /TRACKER_MCP_TOKEN is not set/);
    assert.ok(!refused.includes(BEARER) && !refused.includes(ROTATED));
  } finally {
    restore();
  }
});

test('header: the value goes as-is in the header the entry names; the environment answers when the source holds nothing', async () => {
  process.env.TRACKER_MCP_KEY = KEY;
  setCredentialSource(() => undefined);
  try {
    seen.length = 0;
    const tools = await createMcpTools(`${baseA}/header/mcp`, { credential: { env: 'TRACKER_MCP_KEY', header: 'X-Api-Key' }, transport: 'streamable_http' });
    assert.deepEqual(tools.map((t) => t.name), ['keyed_lookup']);
    assert.ok(seen.length >= 2 && seen.every((s) => s.key === KEY && s.authorization === undefined));
  } finally {
    setCredentialSource(undefined);
    delete process.env.TRACKER_MCP_KEY;
  }
});

test('configuration errors fail the compile, naming the variable or the host and never a value', async () => {
  const restore = withSource({ TRACKER_MCP_TOKEN: BEARER, A2A_SERVER_SECRET: BEARER });
  try {
    const url = `${baseA}/bearer/mcp`;
    await assert.rejects(createMcpTools(url, { credential: { env: 'TRACKER_UNSET_TOKEN' } }), /TRACKER_UNSET_TOKEN is not set/);
    await assert.rejects(createMcpTools(url, { credential: { env: 'A2A_SERVER_SECRET' } }), /framework's own settings/);
    await assert.rejects(createMcpTools('http://mcp.example.com/mcp', { credential: { env: 'TRACKER_MCP_TOKEN' } }), /only over https \(http only to a loopback host\)/);
    await assert.rejects(createMcpTools(url, { credential: { env: 'TRACKER_MCP_TOKEN', header: 'Host' } }), /Host is a header the HTTP layer or the MCP transport sets/);
    await assert.rejects(createMcpTools(url, { credential: { env: 'TRACKER_MCP_TOKEN', header: 'X-Key\r\nX-Evil' } }), /token characters/);
    await assert.rejects(createMcpTools(url, { credential: { env: 'TRACKER_MCP_TOKEN' }, oauth2: { provider: 'p', grant: 'client_credentials', token_url: 'https://t.example.com', client_secret_env: 'X_SECRET' } }), /not two/);
    setCredentialHosts({ TRACKER_MCP_TOKEN: ['mcp.tracker.example.com'] });
    try {
      await assert.rejects(createMcpTools(url, { credential: { env: 'TRACKER_MCP_TOKEN' } }), (err: Error) => /TRACKER_MCP_TOKEN may be sent only to mcp\.tracker\.example\.com; 127\.0\.0\.1/.test(err.message) && !err.message.includes(BEARER));
    } finally {
      setCredentialHosts(undefined);
    }
    // Bound to its host, it is sent.
    setCredentialHosts({ TRACKER_MCP_TOKEN: ['127.0.0.1'] });
    try {
      assert.deepEqual((await createMcpTools(url, { credential: { env: 'TRACKER_MCP_TOKEN' }, transport: 'streamable_http' })).map((t) => t.name), ['bearer_lookup']);
    } finally {
      setCredentialHosts(undefined);
    }
  } finally {
    restore();
  }
});

test('a redirect to another origin is not followed, and the other origin never sees the credential', async () => {
  const restore = withSource({ TRACKER_MCP_TOKEN: BEARER });
  try {
    seen.length = 0;
    const { result, text } = await warned(() => createMcpTools(`${baseA}/away/mcp`, { credential: { env: 'TRACKER_MCP_TOKEN' }, transport: 'streamable_http' }));
    assert.deepEqual(result, []);
    assert.ok(!seen.some((s) => s.origin === 'b'), 'the other origin received no request');
    assert.match(text, /follows no redirect off its server/);
    assert.ok(!text.includes(BEARER));
  } finally {
    restore();
  }
});

test('a server that echoes the credential in its refusal: no log line repeats it', async () => {
  // The keyed server refuses this value and echoes it in its 401 body; auto tries SSE once after a 401 (no OAuth grant).
  const wrong = `fake-mcp-wrong-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
  const restore = withSource({ TRACKER_MCP_KEY: wrong });
  try {
    seen.length = 0;
    const { result, text } = await warned(() => createMcpTools(`${baseA}/header/mcp`, { credential: { env: 'TRACKER_MCP_KEY', header: 'X-Api-Key' } }));
    assert.deepEqual(result, []);
    assert.ok(seen.some((s) => s.key === wrong), 'the server was sent the value');
    assert.ok(text.length > 0, 'the failure was logged');
    assert.ok(!text.includes(wrong), `a log line repeats the credential: ${text.slice(0, 300)}`);
    assert.match(text, /\[redacted\]/, 'the echoed value was cut out, not merely absent');
  } finally {
    restore();
  }
});

test('MCP_BEARER_TOKENS: ignored beside a static credential; unchanged without one', async () => {
  const restore = withSource({ TRACKER_MCP_KEY: KEY });
  process.env.MCP_BEARER_TOKENS = JSON.stringify({ '127.0.0.1': 'fake-mcp-bearer-tokens-value' });
  try {
    seen.length = 0;
    await createMcpTools(`${baseA}/header/mcp`, { credential: { env: 'TRACKER_MCP_KEY', header: 'X-Api-Key' }, transport: 'streamable_http' });
    assert.ok(seen.length > 0 && seen.every((s) => s.authorization === undefined), 'no MCP_BEARER_TOKENS header beside auth');
    // Without auth: MCP_BEARER_TOKENS keeps its rule (https only), so a loopback http server gets nothing.
    seen.length = 0;
    await warned(() => createMcpTools(`${baseA}/bearer/mcp`, { transport: 'streamable_http' }));
    assert.ok(seen.length > 0 && seen.every((s) => s.authorization === undefined));
  } finally {
    delete process.env.MCP_BEARER_TOKENS;
    restore();
  }
});

// ── The YAML ─────────────────────────────────────────────────────────────────

const agent = (extra: Record<string, unknown>) =>
  ({
    syndicate_name: 'S',
    orchestrator: { name: 'R', model: 'gemini-x', instruction: 'r', ...extra },
  }) as unknown as SyndicateYamlConfig;

test('schema: auth is exactly one of oauth2, bearer_env or header, on an mcp_servers entry and as mcp_auth; a header name that could smuggle is refused at load', () => {
  const entry = (auth: unknown) => agent({ mcp_servers: [{ name: 'tracker', url: 'https://mcp.tracker.example.com/mcp', tools: ['lookup'], auth }] });
  assert.doesNotThrow(() => validateSyndicateConfig(entry({ bearer_env: 'TRACKER_MCP_TOKEN' }), 't'));
  assert.doesNotThrow(() => validateSyndicateConfig(entry({ header: { env: 'TRACKER_MCP_KEY', name: 'X-Api-Key' } }), 't'));
  assert.doesNotThrow(() => validateSyndicateConfig(agent({ mcp_server_url: 'https://mcp.tracker.example.com/mcp', mcp_auth: { bearer_env: 'TRACKER_MCP_TOKEN' } }), 't'));
  assert.doesNotThrow(() => validateSyndicateConfig(agent({ mcp_server_url: 'https://mcp.tracker.example.com/mcp', mcp_auth: { header: { env: 'TRACKER_MCP_KEY', name: 'Authorization' } } }), 't'));
  assert.throws(() => validateSyndicateConfig(entry({ bearer_env: 'A', header: { env: 'B', name: 'X-Api-Key' } }), 't'), /exactly one of oauth2, bearer_env or header/);
  assert.throws(() => validateSyndicateConfig(entry({}), 't'), /exactly one of oauth2, bearer_env or header/);
  assert.throws(() => validateSyndicateConfig(entry({ bearer_env: 'sk-live-123' }), 't'), /environment variable name/);
  for (const name of ['Host', 'content-length', 'Transfer-Encoding', 'Mcp-Session-Id', 'X-Key\r\nHost: evil', 'X Key', 'X-Key:', '', 'x'.repeat(65), 'Proxy-Authorization', 'X-Forwarded-For']) {
    assert.throws(() => validateSyndicateConfig(entry({ header: { env: 'TRACKER_MCP_KEY', name } }), 't'), /header/, `refused: ${JSON.stringify(name)}`);
  }
  // A stdio entry still takes no auth.
  assert.throws(() => validateSyndicateConfig(agent({ mcp_servers: [{ name: 'local', command: 'npx', tools: ['x'], auth: { bearer_env: 'TRACKER_MCP_TOKEN' } }] }), 't'), /takes no auth/);
});

test('credentialHeaderProblem allows any other token, Authorization included', () => {
  for (const name of ['X-Api-Key', 'Authorization', 'api_key', 'X-Goog-Api-Key']) assert.equal(credentialHeaderProblem(name), null, name);
});

test('the load-time check and the doctor see the variable: credentialUses lists it, bound to the entry\'s URL', () => {
  const config = agent({
    mcp_servers: [
      { name: 'tracker', url: 'https://mcp.tracker.example.com/mcp', tools: ['lookup'], auth: { bearer_env: 'TRACKER_MCP_TOKEN' } },
      { name: 'docs', url: 'https://mcp.docs.example.com/mcp', tools: ['search'], auth: { header: { env: 'DOCS_MCP_KEY', name: 'X-Api-Key' } } },
    ],
  });
  const single = agent({ mcp_server_url: 'https://mcp.single.example.com/mcp', mcp_auth: { bearer_env: 'SINGLE_MCP_TOKEN' } });
  const uses = syndicateCredentialUses([config, single]);
  assert.deepEqual(
    uses.map((u) => [u.env, u.role, u.destinations]),
    [
      ['TRACKER_MCP_TOKEN', 'bearer_env', ['https://mcp.tracker.example.com/mcp']],
      ['DOCS_MCP_KEY', 'header', ['https://mcp.docs.example.com/mcp']],
      ['SINGLE_MCP_TOKEN', 'bearer_env', ['https://mcp.single.example.com/mcp']],
    ],
  );
  const problems = syndicateCredentialHostProblems([config], { allowlist: { TRACKER_MCP_TOKEN: ['mcp.tracker.example.com'], DOCS_MCP_KEY: ['elsewhere.example.com'] } });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /DOCS_MCP_KEY may be sent only to elsewhere\.example\.com; mcp\.docs\.example\.com/);
});

test('the compile reads auth from either form (mcp_servers[].auth and mcp_auth)', async () => {
  const restore = withSource({ TRACKER_MCP_TOKEN: BEARER, TRACKER_MCP_KEY: KEY });
  try {
    assert.deepEqual(mcpStaticCredential({ bearer_env: 'A' }), { env: 'A' });
    assert.deepEqual(mcpStaticCredential({ header: { env: 'B', name: 'X-Api-Key' } }), { env: 'B', header: 'X-Api-Key' });
    assert.equal(mcpStaticCredential({ oauth2: { provider: 'p', grant: 'client_credentials' } as never }), undefined);
    assert.equal(mcpStaticCredential(undefined), undefined);
    const several = agent({
      mcp_servers: [
        { name: 'tracker', url: `${baseA}/bearer/mcp`, tools: ['bearer_lookup'], transport: 'streamable_http', auth: { bearer_env: 'TRACKER_MCP_TOKEN' } },
        { name: 'docs', url: `${baseB}/header/mcp`, tools: ['keyed_lookup'], transport: 'streamable_http', auth: { header: { env: 'TRACKER_MCP_KEY', name: 'X-Api-Key' } } },
      ],
    });
    const single = agent({ mcp_server_url: `${baseA}/bearer/mcp`, mcp_transport: 'streamable_http', mcp_auth: { bearer_env: 'TRACKER_MCP_TOKEN' } });
    const names = async (config: SyndicateYamlConfig) => {
      const root = await compileSpec(config);
      return root.tools.flatMap((t) => (t.kind === 'tool' ? [(t.tool as { name?: string }).name ?? ''] : [])).sort();
    };
    assert.deepEqual(await names(several), ['bearer_lookup', 'keyed_lookup']);
    assert.deepEqual(await names(single), ['bearer_lookup']);
  } finally {
    restore();
  }
});
