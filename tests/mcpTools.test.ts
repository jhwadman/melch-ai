/**
 * tests/mcpTools.test.ts — what an agent may do with an MCP server's tools
 * (ADR 0041): `mcp_tools` exposes only the named ones, `require_approval` can
 * gate them on a dispatch route, and a server's descriptions and results are
 * bounded. Offline: an MCP SSE server in this process, scripted models.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { MAX_MCP_DESCRIPTION_CHARS, MAX_MCP_RESULT_CHARS, closeMcpConnections, createMcpTools } from '../lib/tools/mcpToolFactory.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, scriptedResolver, text } from './helpers/scriptedLlm.ts';

const calls: string[] = [];
let http: HttpServer;
let url = '';
const transports = new Map<string, SSEServerTransport>();
const opened: SSEServerTransport[] = [];

before(async () => {
  const app = express();
  const tool = (name: string, description: string) => ({ name, description, inputSchema: { type: 'object' as const, properties: {} } });
  app.get('/sse', async (_req, res) => {
    const server = new Server({ name: 'test-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [tool('lookup', 'Look a thing up.'), tool('delete_all', 'Delete everything.'), tool('verbose', 'x'.repeat(5_000))],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      calls.push(req.params.name);
      const body = req.params.name === 'verbose' ? 'y'.repeat(MAX_MCP_RESULT_CHARS + 5_000) : `${req.params.name} ran`;
      return { content: [{ type: 'text' as const, text: body }] };
    });
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    opened.push(transport);
    await server.connect(transport);
  });
  app.post('/messages', express.json(), async (req, res) => {
    const t = transports.get(String(req.query.sessionId));
    if (!t) return void res.status(404).end();
    await t.handlePostMessage(req, res, req.body);
  });
  http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const addr = http.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/sse`;
  process.env.ALLOW_PRIVATE_MCP = 'true';
});
after(async () => {
  await closeMcpConnections();
  for (const t of opened) await t.close().catch(() => {});
  http?.closeAllConnections?.();
  http?.close();
  delete process.env.ALLOW_PRIVATE_MCP;
});

test("a server's long description and long result are cut and say so", async () => {
  const tools = await createMcpTools(url);
  const verbose = tools.find((t) => t.name === 'verbose')!;
  const description = verbose.declaration().description ?? '';
  assert.ok(description.length < MAX_MCP_DESCRIPTION_CHARS + 60);
  assert.match(description, /\[description cut at 1000 characters\]$/);
  const result = String(await verbose.execute({}, {} as any));
  assert.ok(result.length < MAX_MCP_RESULT_CHARS + 60);
  assert.match(result, /\[result cut at 20000 characters\]$/);
});

test('schema: mcp_tools needs mcp_server_url, and require_approval may name an MCP tool listed there', () => {
  const base = { syndicate_name: 'S', orchestrator: { name: 'R', model: 'gemini-x', instruction: 'r' }, dispatch: { default_route: 'Ops' } };
  assert.throws(
    () => validateSyndicateConfig({ ...base, subagents: [{ name: 'Ops', model: 'gemini-x', instruction: 'o', description: 'd', mcp_tools: ['lookup'] }] }, 't'),
    /mcp_tools.*needs mcp_server_url/,
  );
  assert.throws(
    () => validateSyndicateConfig({ ...base, subagents: [{ name: 'Ops', model: 'gemini-x', instruction: 'o', description: 'd', mcp_server_url: url, require_approval: ['delete_all'] }] }, 't'),
    /'delete_all' is not in this agent's tools, its openapi operations or its mcp_tools/,
  );
  validateSyndicateConfig({ ...base, subagents: [{ name: 'Ops', model: 'gemini-x', instruction: 'o', description: 'd', mcp_server_url: url, mcp_tools: ['lookup', 'delete_all'], require_approval: ['delete_all'] }] }, 't');
});

test('a route sees only its mcp_tools, and a gated MCP tool waits for a person', async () => {
  calls.length = 0;
  const config = {
    syndicate_name: 'Desk',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      { name: 'Ops', model: 'scripted/ops', instruction: 'Operate.', description: 'operations', mcp_server_url: url, mcp_tools: ['lookup', 'delete_all'], require_approval: ['delete_all'] },
    ],
    dispatch: { default_route: 'Chat' },
  } as unknown as SyndicateYamlConfig;
  let offered: string[] = [];
  const router = new ScriptedLlm('scripted/router', () => text('{"route":"Ops","reason":"ops"}'));
  const chat = new ScriptedLlm('scripted/chat', () => text('chat'));
  const ops = new ScriptedLlm('scripted/ops', (req, n) => {
    if (n === 1) offered = ((req as any).config?.tools ?? []).flatMap((t: any) => t.functionDeclarations ?? []).map((d: any) => d.name);
    return n === 1 ? call('delete_all', {}) : text('done');
  });
  const sessionService = new InProcessSessionService();
  const turn = (parts: any[]) =>
    runSyndicateTurn({ config, parts, appName: 'app', userId: 'u', sessionId: 's', sessionService, compile: { resolveModel: scriptedResolver({ router, chat, ops }) }, trace: false });

  const first = await turn([{ text: 'clean up' }]);
  assert.ok(offered.includes('lookup') && offered.includes('delete_all'), `offered: ${offered.join(', ')}`);
  assert.ok(!offered.includes('verbose'), 'a tool the server lists but mcp_tools does not name is not exposed');
  assert.equal(first.status, 'input-required', first.error?.message);
  assert.deepEqual(calls, [], 'the gated tool has not run');
  const second = await turn([approvalResponsePart(first.approval!.id, true)]);
  assert.equal(second.status, 'completed', second.error?.message);
  assert.deepEqual(calls, ['delete_all']);
});
