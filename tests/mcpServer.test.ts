/**
 * tests/mcpServer.test.ts — the melchizedek-mcp server (ADR 0125): syndicates
 * as MCP tools, driven by an in-process MCP client over stdio framing and
 * over Streamable HTTP. Scripted models, no provider calls.
 *
 * Covered: tools/list, a turn and its continuation by session_id, structured
 * output, an approval pause answered only through melch_resume, a cancel
 * (notifications/cancelled ends the turn canceled), the bearer on HTTP, and
 * the refusal to bind beyond loopback without a secret (the library check and
 * the bin itself).
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { request as httpRequest } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { createMcpServer, mcpBindProblem, mcpHttpApp, serveMcpStdio, toolNameFor, RESUME_TOOL } from '../lib/mcp/server.ts';
import type { MelchMcpServer } from '../lib/mcp/server.ts';
import { parseMcpArgs } from '../scripts/mcp_server.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import type { TaskRecord } from '../lib/observability/metrics.ts';
import { ScriptedLlm, call, hangUntilAborted, sentTexts, text } from './helpers/scriptedLlm.ts';

const SECRET = 'mcp-test-secret-0123456789abcdef0123'; // gitleaks:allow (test fixture)

const sent: string[] = [];
registerTool(
  'mcp_test_send',
  defineTool({
    name: 'mcp_test_send',
    description: 'Send.',
    schema: z.object({ to: z.string() }),
    execute: async ({ to }) => (sent.push(to), `sent to ${to}`),
  }),
  { override: true },
);

const dir = mkdtempSync(join(tmpdir(), 'melch-mcp-'));
const yaml = (name: string, lines: string[]) => writeFileSync(join(dir, `${name}.yaml`), lines.join('\n'));
yaml('echo', [
  'syndicate_name: Echo Desk',
  'orchestrator:',
  '  name: Echo',
  '  model: scripted/echo',
  '  description: Repeats how many things you have said.',
  '  instruction: Count.',
  'subagents: []',
]);
yaml('mailer', [
  'syndicate_name: Mailer',
  'orchestrator:',
  '  name: Boss',
  '  model: scripted/boss',
  '  instruction: Send.',
  '  tools: [mcp_test_send]',
  '  require_approval: [mcp_test_send]',
  'subagents: []',
]);
yaml('slow', [
  'syndicate_name: Slow',
  'orchestrator:',
  '  name: Sloth',
  '  model: scripted/slow',
  '  instruction: Wait.',
  'subagents: []',
]);
yaml('verdict', [
  'syndicate_name: Verdict',
  'orchestrator:',
  '  name: Judge',
  '  model: scripted/judge',
  '  instruction: Judge.',
  '  output:',
  '    schema:',
  '      type: object',
  '      properties: { verdict: { type: string } }',
  '      required: [verdict]',
  'subagents: []',
]);
yaml('desk', ['syndicate_name: Desk', 'orchestrator:', '  name: Clerk', '  model: scripted/asker', '  instruction: Help.', '  tools: [ask_user]', 'subagents: []']);
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

let slowEntered: () => void = () => {};
const resolveModel = (id?: string) => {
  const key = (id ?? '').replace(/^scripted\//, '');
  if (key === 'echo') {
    return new ScriptedLlm(id!, (req) => {
      const users = sentTexts(req).filter((t) => t.startsWith('say:'));
      return text(`heard ${users.length}`);
    });
  }
  if (key === 'boss') {
    return new ScriptedLlm(id!, (req, n) => {
      const last = req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response;
      return n === 1 && !last ? call('mcp_test_send', { to: 'ops@acme.test' }) : text(`result ${JSON.stringify(last ?? null)}`);
    });
  }
  if (key === 'slow') {
    return new ScriptedLlm(id!, (_req, _n, signal) => {
      slowEntered();
      return hangUntilAborted(signal);
    });
  }
  if (key === 'asker') {
    return new ScriptedLlm(id!, (req) => {
      const last = req.contents.at(-1)?.parts?.find((p: any) => p.functionResponse)?.functionResponse?.response;
      return last ? text(`paying from ${JSON.stringify(last)}`) : call('ask_user', { question: 'Which account?', options: ['personal', 'work'] });
    });
  }
  if (key === 'judge') return new ScriptedLlm(id!, () => text('{"verdict":"sound"}'));
  throw new Error(`no scripted model '${id}'`);
};

const records: TaskRecord[] = [];
let mcp: MelchMcpServer;

/** A client transport speaking stdio's newline-delimited JSON over two streams. */
class StreamClientTransport implements Transport {
  onmessage?: (m: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
  private buf = new ReadBuffer();
  private readonly toServer: PassThrough;
  private readonly fromServer: PassThrough;
  constructor(toServer: PassThrough, fromServer: PassThrough) {
    this.toServer = toServer;
    this.fromServer = fromServer;
  }
  async start() {
    this.fromServer.on('data', (chunk: Buffer) => {
      this.buf.append(chunk);
      for (let m = this.buf.readMessage(); m; m = this.buf.readMessage()) this.onmessage?.(m);
    });
  }
  async send(message: JSONRPCMessage) {
    this.toServer.write(serializeMessage(message));
  }
  async close() {
    this.toServer.end();
    this.onclose?.();
  }
}

let stdioClient: Client;
let httpClient: Client;
let httpServer: HttpServer;
let httpBase = '';
let closeSessions: () => Promise<void> = async () => {};

before(async () => {
  const syndicates = ['echo', 'mailer', 'slow', 'verdict', 'desk'].map((id) => ({ id, config: loadSyndicate(`${id}.yaml`) }));
  mcp = createMcpServer({ syndicates, resolveModel, onTaskEnd: (r) => records.push(r), log: () => {}, warn: () => {} });

  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  await serveMcpStdio(mcp, { stdin: toServer, stdout: fromServer });
  stdioClient = new Client({ name: 'test-stdio', version: '1.0.0' });
  await stdioClient.connect(new StreamClientTransport(toServer, fromServer));

  const app = mcpHttpApp(mcp, { secret: SECRET, warn: () => {} });
  closeSessions = app.closeSessions;
  httpServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = httpServer.address();
  httpBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  httpClient = new Client({ name: 'test-http', version: '1.0.0' });
  await httpClient.connect(
    new StreamableHTTPClientTransport(new URL(`${httpBase}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${SECRET}` } } }),
  );
});

after(async () => {
  await stdioClient?.close().catch(() => {});
  await httpClient?.close().catch(() => {});
  await closeSessions();
  httpServer?.close();
});

const textOf = (r: any) => (r.content ?? []).map((c: any) => c.text ?? '').join('\n');

for (const [label, client] of [['stdio', () => stdioClient], ['http', () => httpClient]] as const) {
  test(`${label}: each syndicate is a tool, plus ${RESUME_TOOL}`, async () => {
    const { tools } = await client().listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['desk', 'echo', 'mailer', RESUME_TOOL, 'slow', 'verdict'].sort());
    const echo = tools.find((t) => t.name === 'echo')!;
    assert.match(echo.description ?? '', /^Repeats how many things you have said\./);
    assert.deepEqual(echo.inputSchema.required, ['message']);
    assert.ok(echo.inputSchema.properties?.session_id);
  });

  test(`${label}: a turn returns its session_id, and the session_id continues it`, async () => {
    const first: any = await client().callTool({ name: 'echo', arguments: { message: 'say: one' } });
    assert.equal(first.isError, undefined, textOf(first));
    assert.match(textOf(first), /heard 1/);
    const sid = first.structuredContent.session_id;
    assert.match(textOf(first), new RegExp(`session_id: ${sid}`));
    const second: any = await client().callTool({ name: 'echo', arguments: { message: 'say: two', session_id: sid } });
    assert.match(textOf(second), /heard 2/);
    assert.equal(second.structuredContent.session_id, sid);
    const fresh: any = await client().callTool({ name: 'echo', arguments: { message: 'say: three' } });
    assert.match(textOf(fresh), /heard 1/);
    assert.notEqual(fresh.structuredContent.session_id, sid);
  });

  test(`${label}: an output schema's answer is structured content too`, async () => {
    const r: any = await client().callTool({ name: 'verdict', arguments: { message: 'judge it' } });
    assert.equal(r.isError, undefined, textOf(r));
    assert.deepEqual(r.structuredContent.output, { verdict: 'sound' });
  });

  test(`${label}: an approval pauses the turn, a message never answers it, ${RESUME_TOOL} does`, async () => {
    sent.length = 0;
    const paused: any = await client().callTool({ name: 'mailer', arguments: { message: 'tell ops' } });
    assert.equal(paused.structuredContent.status, 'input-required');
    assert.equal(paused.structuredContent.waiting_for.kind, 'approval');
    assert.equal(paused.structuredContent.waiting_for.tool, 'mcp_test_send');
    assert.match(textOf(paused), /Approval needed: Boss wants to run mcp_test_send\(\{"to":"ops@acme.test"\}\)/);
    assert.deepEqual(sent, []);
    const sid = paused.structuredContent.session_id;

    // The word itself on the syndicate's tool is not an answer.
    const again: any = await client().callTool({ name: 'mailer', arguments: { message: 'approve', session_id: sid } });
    assert.equal(again.structuredContent.status, 'input-required');
    assert.deepEqual(sent, []);

    const missing: any = await client().callTool({ name: RESUME_TOOL, arguments: { session_id: sid } });
    assert.equal(missing.isError, true);
    assert.deepEqual(sent, []);

    const done: any = await client().callTool({ name: RESUME_TOOL, arguments: { session_id: sid, approve: true } });
    assert.equal(done.structuredContent.status, 'completed', textOf(done));
    assert.deepEqual(sent, ['ops@acme.test']);
    assert.match(textOf(done), /sent to ops@acme.test/);
  });

  test(`${label}: a refusal through ${RESUME_TOOL} never runs the call`, async () => {
    sent.length = 0;
    const paused: any = await client().callTool({ name: 'mailer', arguments: { message: 'tell ops' } });
    const done: any = await client().callTool({ name: RESUME_TOOL, arguments: { session_id: paused.structuredContent.session_id, approve: false } });
    assert.equal(done.structuredContent.status, 'completed', textOf(done));
    assert.deepEqual(sent, []);
    assert.match(textOf(done), /rejected/);
  });

  test(`${label}: a question pauses the turn and ${RESUME_TOOL}'s answer resumes it`, async () => {
    const paused: any = await client().callTool({ name: 'desk', arguments: { message: 'pay the bill' } });
    assert.equal(paused.structuredContent.status, 'input-required', textOf(paused));
    assert.equal(paused.structuredContent.waiting_for.kind, 'input');
    assert.match(textOf(paused), /Which account\? \(personal \/ work\)/);
    const sid = paused.structuredContent.session_id;
    const noAnswer: any = await client().callTool({ name: RESUME_TOOL, arguments: { session_id: sid, approve: true } });
    assert.equal(noAnswer.isError, true);
    const done: any = await client().callTool({ name: RESUME_TOOL, arguments: { session_id: sid, answer: 'work' } });
    assert.equal(done.structuredContent.status, 'completed', textOf(done));
    assert.match(textOf(done), /paying from .*work/);
  });

  test(`${label}: a cancellation ends the turn canceled`, async () => {
    const entered = new Promise<void>((resolve) => {
      slowEntered = resolve;
    });
    const before = records.length;
    const ac = new AbortController();
    const pending = client().callTool({ name: 'slow', arguments: { message: 'wait' } }, undefined, { signal: ac.signal, timeout: 30_000 });
    await entered;
    ac.abort('the person stopped it');
    await assert.rejects(pending);
    for (let i = 0; i < 100 && records.length === before; i++) await new Promise((r) => setTimeout(r, 20));
    const record = records.at(-1)!;
    assert.equal(record.agentId, 'slow');
    assert.equal(record.status, 'canceled');
    for (let i = 0; i < 50 && mcp.inFlight > 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(mcp.inFlight, 0);
  });
}

test('a session id from one syndicate does not continue another', async () => {
  const first: any = await stdioClient.callTool({ name: 'echo', arguments: { message: 'say: one' } });
  const other: any = await stdioClient.callTool({ name: 'verdict', arguments: { message: 'x', session_id: first.structuredContent.session_id } });
  assert.equal(other.isError, true);
  assert.match(textOf(other), /conversation with echo/);
});

test('bad arguments are readable errors, not turns', async () => {
  const before = records.length;
  const empty: any = await stdioClient.callTool({ name: 'echo', arguments: { message: '  ' } });
  assert.equal(empty.isError, true);
  const badSid: any = await stdioClient.callTool({ name: 'echo', arguments: { message: 'hi', session_id: '../../etc' } });
  assert.equal(badSid.isError, true);
  const unknown: any = await stdioClient.callTool({ name: RESUME_TOOL, arguments: { session_id: 'never-seen', approve: true } });
  assert.equal(unknown.isError, true);
  assert.equal(records.length, before);
});

test('http: a request without the bearer is refused', async () => {
  const res = await fetch(`${httpBase}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
  });
  assert.equal(res.status, 401);
  const wrong = await fetch(`${httpBase}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(wrong.status, 401);
});

test('http: a loopback bind refuses a foreign Host header (DNS rebinding)', async () => {
  // fetch may not set Host; node:http does.
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${httpBase}/healthz`, { headers: { Host: 'evil.example.com' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('a bind beyond loopback without a secret is refused', () => {
  assert.equal(mcpBindProblem({ host: '127.0.0.1' }), undefined);
  assert.equal(mcpBindProblem({ host: 'localhost' }), undefined);
  assert.match(mcpBindProblem({ host: '0.0.0.0' }) ?? '', /MCP_SERVER_SECRET/);
  assert.match(mcpBindProblem({ host: '0.0.0.0', secret: 'short' }) ?? '', /at least 32/);
  assert.equal(mcpBindProblem({ host: '0.0.0.0', secret: SECRET }), undefined);
  assert.throws(() => mcpHttpApp(mcp, { host: '0.0.0.0' }), /MCP_SERVER_SECRET/);
});

test('the bin refuses a public bind without a secret, before it loads anything', () => {
  const env = { ...process.env, MELCHIZEDEK_DOTENV: 'off', MCP_SERVER_SECRET: '', MELCHIZEDEK_AGENTS_DIR: dir };
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=DEP0040', '--experimental-strip-types', 'scripts/mcp_server.ts', '--http', '--host', '0.0.0.0', '--port', '0'],
    { env, encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL: MCP_HOST=0\.0\.0\.0 would expose/);
  assert.equal(r.stdout, '');
});

test('the bin over real stdio: stdout carries only the protocol', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=DEP0040', '--experimental-strip-types', 'scripts/mcp_server.ts', '--agents-dir', dir, '--syndicate', 'echo', '--syndicate', 'mailer'],
    env: { ...(process.env as Record<string, string>), MELCHIZEDEK_DOTENV: 'off' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bin', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['echo', 'mailer', RESUME_TOOL].sort());
  } finally {
    await client.close().catch(() => {});
  }
});

test('flags and tool names', () => {
  assert.deepEqual(parseMcpArgs(['--syndicate', 'a', 'b', '--http', '--port', '4200']), { syndicates: ['a', 'b'], http: true, help: false, port: 4200 });
  assert.throws(() => parseMcpArgs(['--bogus']), /Unknown flag/);
  assert.throws(() => parseMcpArgs(['--port']), /needs a value/);
  assert.equal(toolNameFor('research desk.v2.yaml'), 'research_desk_v2');
  assert.throws(() => createMcpServer({ syndicates: [{ id: RESUME_TOOL, config: loadSyndicate('echo.yaml') }] }), /reserved/);
  assert.throws(() => createMcpServer({ syndicates: [{ id: 'a b', config: loadSyndicate('echo.yaml') }] }), /must match/);
});
