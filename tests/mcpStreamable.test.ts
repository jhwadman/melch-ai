/**
 * tests/mcpStreamable.test.ts — an agent's MCP client over Streamable HTTP,
 * the legacy SSE fallback, and several MCP servers per agent (ADR 0124).
 * Offline: a Streamable HTTP MCP server and a legacy SSE MCP server in this
 * process, a mock OAuth token endpoint, scripted models.
 *
 * Covers: `auto` connects over Streamable HTTP; `auto` against an SSE-only
 * server falls back on the spec's signal (the initialize POST answered 404);
 * an explicit transport uses that one only; a 401 is not the fallback signal;
 * the OAuth fetch wrapper carries the token on Streamable HTTP requests too;
 * `mcp_servers` merges each server's named tools, `require_approval` may
 * name any server's tool, and a name on two servers, or shared with the
 * agent's own tools, is refused at load (and at compile, for a config built
 * in code).
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
for (const name of ['MELCHIZEDEK_OAUTH_HOSTS', 'MELCHIZEDEK_CREDENTIAL_HOSTS', 'MCP_BEARER_TOKENS']) delete process.env[name];

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import express from 'express';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { compileSpec } from '../lib/compile.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { closeMcpConnections, createMcpTools, isSseFallbackSignal } from '../lib/tools/mcpToolFactory.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

/** Every request the servers received: which endpoint, which method. */
const hits: string[] = [];
/** Every tool call the servers ran, as `<server>:<tool>`, with the bearer it carried. */
const calls: Array<{ call: string; token: string }> = [];
const CLIENT_SECRET = `fake-client-secret-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
const SECRET_ENV = 'SECURE_STREAMABLE_TEST_SECRET';
process.env[SECRET_ENV] = CLIENT_SECRET;
const issued = new Set<string>();

let http: HttpServer;
let base = '';
const sseTransports = new Map<string, SSEServerTransport>();
const opened: SSEServerTransport[] = [];

const bearer = (req: express.Request) => (req.headers.authorization ?? '').replace(/^Bearer /, '');

/** A low-level MCP server named `label` offering `names`. */
function mcpServer(label: string, names: string[], token?: () => string) {
  const server = new Server({ name: label, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: names.map((name) => ({ name, description: `${name} on ${label}.`, inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } } } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    calls.push({ call: `${label}:${req.params.name}`, token: token?.() ?? '' });
    return { content: [{ type: 'text' as const, text: `${label} ran ${req.params.name}` }] };
  });
  return server;
}

/** A stateless Streamable HTTP endpoint at `path` (a fresh server per request, as the SDK's stateless example). */
function streamable(app: express.Express, path: string, label: string, names: string[], options: { requireToken?: boolean } = {}) {
  app.post(path, express.json(), async (req, res) => {
    hits.push(`POST ${path}`);
    if (options.requireToken && !issued.has(bearer(req))) return void res.status(401).json({ error: 'unauthorized' });
    const token = bearer(req);
    const server = mcpServer(label, names, () => token);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  // No standalone SSE stream and no session to end: the spec's 405.
  app.get(path, (_req, res) => {
    hits.push(`GET ${path}`);
    res.status(405).set('Allow', 'POST').end();
  });
  app.delete(path, (_req, res) => void res.status(405).end());
}

before(async () => {
  const app = express();
  streamable(app, '/mcp', 'tracker', ['lookup', 'delete_all', 'verbose']);
  streamable(app, '/wiki/mcp', 'wiki', ['search_pages', 'read_page']);
  streamable(app, '/secure/mcp', 'secure', ['whoami'], { requireToken: true });
  // A legacy HTTP+SSE server: GET opens the stream, POSTs go to /messages. A
  // POST to /sse is express's 404: the fallback signal.
  app.get('/sse', async (_req, res) => {
    hits.push('GET /sse');
    const transport = new SSEServerTransport('/messages', res);
    sseTransports.set(transport.sessionId, transport);
    opened.push(transport);
    await mcpServer('legacy', ['legacy_lookup']).connect(transport);
  });
  app.post('/messages', express.json(), async (req, res) => {
    const t = sseTransports.get(String(req.query.sessionId));
    if (!t) return void res.status(404).end();
    await t.handlePostMessage(req, res, req.body);
  });
  app.post('/sse', (_req, res) => {
    hits.push('POST /sse');
    res.status(404).end();
  });
  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const form = new URLSearchParams(req.body as Record<string, string>);
    if (form.get('grant_type') !== 'client_credentials' || form.get('client_secret') !== CLIENT_SECRET) return void res.status(401).json({ error: 'invalid_client' });
    const token = `fake-server-${randomBytes(8).toString('hex')}`;
    issued.add(token);
    res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
  });
  http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const addr = http.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.ALLOW_PRIVATE_MCP = 'true';
});

after(async () => {
  await closeMcpConnections();
  for (const t of opened) await t.close().catch(() => {});
  http?.closeAllConnections?.();
  http?.close();
  delete process.env.ALLOW_PRIVATE_MCP;
  delete process.env[SECRET_ENV];
});

// ── Transport ────────────────────────────────────────────────────────────────

test('auto connects over Streamable HTTP and calls a tool there', async () => {
  hits.length = 0;
  calls.length = 0;
  const tools = await createMcpTools(`${base}/mcp`);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['delete_all', 'lookup', 'verbose']);
  assert.ok(hits.includes('POST /mcp'), `hits: ${hits.join(', ')}`);
  assert.ok(!hits.some((h) => h.includes('/sse')), 'no SSE attempt against a Streamable HTTP server');
  const lookup = tools.find((t) => t.name === 'lookup')!;
  assert.equal(await lookup.execute({ id: '7' }, {} as any), 'tracker ran lookup');
  assert.deepEqual(calls.map((c) => c.call), ['tracker:lookup']);
});

test("auto falls back to SSE on the spec's signal, and an existing SSE URL keeps working", async () => {
  hits.length = 0;
  calls.length = 0;
  const tools = await createMcpTools(`${base}/sse`);
  assert.deepEqual(tools.map((t) => t.name), ['legacy_lookup']);
  assert.deepEqual(hits.slice(0, 2), ['POST /sse', 'GET /sse'], 'the Streamable HTTP POST first, answered 404, then the SSE stream');
  assert.equal(await tools[0]!.execute({}, {} as any), 'legacy ran legacy_lookup');
});

test('an explicit transport uses that one only', async () => {
  hits.length = 0;
  assert.deepEqual(await createMcpTools(`${base}/sse`, { transport: 'streamable_http' }), [], 'no fallback when the YAML names streamable_http');
  assert.ok(!hits.includes('GET /sse'));
  hits.length = 0;
  const sse = await createMcpTools(`${base}/sse`, { transport: 'sse' });
  assert.deepEqual(sse.map((t) => t.name), ['legacy_lookup']);
  assert.ok(!hits.includes('POST /sse'), 'sse skips the Streamable HTTP attempt');
  assert.deepEqual(await createMcpTools(`${base}/mcp`, { transport: 'sse' }), [], 'an SSE-only client cannot reach a Streamable HTTP-only server');
});

test('the fallback signal is a 4xx other than 401 and 403', () => {
  assert.equal(isSseFallbackSignal(new StreamableHTTPError(404, 'x')), true);
  assert.equal(isSseFallbackSignal(new StreamableHTTPError(405, 'x')), true);
  assert.equal(isSseFallbackSignal(new StreamableHTTPError(400, 'x')), true);
  assert.equal(isSseFallbackSignal(new StreamableHTTPError(401, 'x')), false, 'a refused credential is not a transport question');
  assert.equal(isSseFallbackSignal(new StreamableHTTPError(403, 'x')), false);
  assert.equal(isSseFallbackSignal(new StreamableHTTPError(500, 'x')), false);
  assert.equal(isSseFallbackSignal(new Error('network')), false);
});

test('a server that refuses the credential (401) gets no SSE attempt and no tools', async () => {
  hits.length = 0;
  assert.deepEqual(await createMcpTools(`${base}/secure/mcp`), []);
  assert.deepEqual(hits, ['POST /secure/mcp']);
});

test('an OAuth grant carries its token on every Streamable HTTP request', async () => {
  calls.length = 0;
  hits.length = 0;
  const oauth2 = { provider: 'secure', grant: 'client_credentials' as const, token_url: `${base}/token`, client_id: 'melch', client_secret_env: SECRET_ENV };
  const tools = await createMcpTools(`${base}/secure/mcp`, { oauth2 });
  assert.deepEqual(tools.map((t) => t.name), ['whoami']);
  assert.equal(await tools[0]!.execute({}, {} as any), 'secure ran whoami');
  assert.equal(calls.length, 1);
  assert.ok(issued.has(calls[0]!.token), 'the call carried the token the token endpoint issued');
  assert.ok(hits.every((h) => h === 'POST /secure/mcp' || h === 'GET /secure/mcp'), `hits: ${hits.join(', ')}`);
});

// ── Several servers per agent ────────────────────────────────────────────────

const solo = (orchestrator: Record<string, unknown>) => ({ syndicate_name: 'Desk', orchestrator: { name: 'Solo', model: 'scripted/solo', instruction: 'Work.', ...orchestrator } });

test('schema: mcp_servers, its names, its tools, and what it cannot be combined with', () => {
  const servers = [
    { name: 'tracker', url: 'https://mcp.tracker.example.com/mcp', tools: ['lookup'] },
    { name: 'wiki', url: 'https://mcp.wiki.example.com/mcp', tools: ['search_pages'], transport: 'streamable_http' },
  ];
  assert.doesNotThrow(() => validateSyndicateConfig(solo({ mcp_servers: servers, require_approval: ['search_pages'] }), 'ok'));
  assert.throws(() => validateSyndicateConfig(solo({ mcp_servers: [servers[0], { ...servers[1], tools: ['lookup'] }] }), 't'), /'lookup' is also listed on MCP server 'tracker'/);
  assert.throws(() => validateSyndicateConfig(solo({ tools: ['lookup'], mcp_servers: servers }), 't'), /'lookup' is also one of this agent's own tools/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_servers: [servers[0], { ...servers[1], name: 'tracker' }] }), 't'), /'tracker' names mcp_servers entry 0 too/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_server_url: 'https://m.example.com/mcp', mcp_servers: servers }), 't'), /cannot be combined with mcp_server_url/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_servers: [{ name: 'tracker', url: 'https://m.example.com/mcp' }] }), 't'), /tools/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_servers: [{ ...servers[0], transport: 'websocket' }] }), 't'), /transport/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_servers: [{ ...servers[0], name: 'Tracker!' }] }), 't'), /name/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_servers: servers, require_approval: ['delete_all'] }), 't'), /'delete_all' is not in this agent's tools/);
  assert.throws(() => validateSyndicateConfig(solo({ mcp_transport: 'sse' }), 't'), /mcp_transport is how mcp_server_url is reached/);
  assert.doesNotThrow(() => validateSyndicateConfig(solo({ mcp_server_url: 'https://m.example.com/sse', mcp_transport: 'sse' }), 'ok'));
});

test("an agent's mcp_servers merge each server's named tools, and require_approval gates any of them", async () => {
  calls.length = 0;
  const config = solo({
    mcp_servers: [
      { name: 'tracker', url: `${base}/mcp`, tools: ['lookup', 'delete_all'] },
      { name: 'wiki', url: `${base}/wiki/mcp`, tools: ['search_pages'] },
      { name: 'legacy', url: `${base}/sse`, tools: ['legacy_lookup'] },
    ],
    require_approval: ['search_pages'],
  }) as unknown as SyndicateYamlConfig;
  validateSyndicateConfig(config, 'multi');
  let offered: string[] = [];
  const llm = new ScriptedLlm('scripted/solo', (req, n) => {
    if (n === 1) offered = ((req as any).config?.tools ?? []).flatMap((t: any) => t.functionDeclarations ?? []).map((d: any) => d.name);
    if (n === 1) return call('lookup', { id: '1' });
    if (n === 2) return call('legacy_lookup', {});
    if (n === 3) return call('search_pages', { id: 'q' });
    return text('done');
  });
  const sessionService = new InProcessSessionService();
  const turn = (parts: any[]) =>
    runSyndicateTurn({ config, parts, appName: 'app', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: scriptedResolver({ solo: llm }) }, trace: false });
  const first = await turn([{ text: 'find it' }]);
  assert.deepEqual(offered.filter((n) => !n.startsWith('adk_')).sort(), ['delete_all', 'legacy_lookup', 'lookup', 'search_pages'], 'each server exposes only its named tools');
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.deepEqual(calls.map((c) => c.call), ['tracker:lookup', 'legacy:legacy_lookup'], 'the gated wiki tool waits');
  const second = await turn([approvalResponsePart(first.approval!.id, true)]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(calls.map((c) => c.call), ['tracker:lookup', 'legacy:legacy_lookup', 'wiki:search_pages']);
});

test('a config built in code with one tool name on two servers is refused at compile', async () => {
  const config = solo({
    mcp_servers: [
      { name: 'tracker', url: `${base}/mcp`, tools: ['lookup'] },
      { name: 'again', url: `${base}/mcp`, tools: ['lookup'] },
    ],
  }) as unknown as SyndicateYamlConfig;
  await assert.rejects(compileSpec(config, { resolveModel: scriptedResolver({ solo: new ScriptedLlm('scripted/solo', () => text('x')) }) }), /mcp_servers again: tool 'lookup' collides with another of this agent's tools/);
});
