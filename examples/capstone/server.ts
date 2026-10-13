#!/usr/bin/env node
/**
 * examples/capstone/server.ts — the capstone starter's backend.
 *
 *   npm run capstone                       # mock mode: no agent service, no model
 *   CAPSTONE_MODE=a2a npm run capstone     # calls the Event Assistant over A2A
 *
 * One process, node:http only, three jobs:
 *
 *   1. A stand-in login. A visitor picks one of two fictional test accounts
 *      (fixtures/test-users.json); the backend keeps the account in a
 *      server-side session and gives the browser only an opaque, HttpOnly
 *      session cookie. Replace this with your application's real login.
 *   2. POST /api/ask. The backend takes the visitor's account id from the
 *      session (never from the request), puts the published event
 *      information in front of the question, and either answers from the
 *      mock fixture or calls the agent service with the bearer secret and
 *      X-User-Id. Failures come back as a short message a visitor can read.
 *   3. POST /mcp. A minimal MCP server with one read-only tool,
 *      get_event_updates, that the agent calls for the current
 *      announcements (fixtures/event-updates.json). Every call is logged in
 *      the trace; CAPSTONE_TOOL_DOWN=true makes it return an error (503).
 *
 * Environment (shell first, then ./.env in the directory you start from):
 *   CAPSTONE_MODE        mock (default) | a2a
 *   CAPSTONE_PORT        4100 (the port event_assistant.yaml's base_url names)
 *   CAPSTONE_HOST        127.0.0.1
 *   A2A_URL              http://127.0.0.1:4000/a2a/jsonrpc
 *   A2A_SERVER_SECRET    the A2A server's bearer secret (same .env as the server)
 *   A2A_API_KEY          optional: a model key, only for a server in BYOK mode
 *   CAPSTONE_TOOL_DOWN   true: the updates tool returns an error (the failure exercise)
 *   CAPSTONE_TIMEOUT_MS  180000: local models can take a minute or more
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { askAgent, redact } from './agent.ts';
import type { AgentServiceConfig, FailureKind } from './agent.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const PUBLIC = path.join(HERE, 'public');

export type Mode = 'mock' | 'a2a';

export interface StarterOptions {
  mode: Mode;
  agent: AgentServiceConfig;
  /** Start with the updates tool unavailable. */
  toolDown?: boolean;
  /** Where log lines go; secrets never reach it. */
  log?: (line: string) => void;
  /** For tests: the fetch the agent call uses. */
  fetchImpl?: typeof fetch;
}

export interface TestUser {
  username: string;
  displayName: string;
  accountId: string;
}

interface Session {
  user: TestUser;
  contextId: string;
}

export interface ToolCall {
  tool: 'get_event_updates';
  at: string;
  /** 200 when the tool returned the announcements, 503 when it returned an error. */
  status: number;
}

export interface Trace {
  mode: Mode;
  /** The X-User-Id this backend sent: the session's account id. */
  forwardedUserId: string;
  /** Where that id came from. Always the session. */
  identitySource: 'session';
  contextId: string;
  /** Calls to the updates tool that arrived while this question was open. */
  toolCalls: ToolCall[];
  /** [STATUS] lines the agent service reported, when it reported any. */
  statusLines: string[];
  durationMs: number;
}

export interface Starter {
  server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  setToolDown(down: boolean): void;
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as T;

export const EVENT_INFO = readFileSync(path.join(FIXTURES, 'event-info.md'), 'utf8');
export const TEST_USERS = readJson<{ users: TestUser[] }>('test-users.json').users;
const MOCK = readJson<{ text: string }>('mock-response.json');
// The tool returns the announcements only: the fixture's _note is for the
// person reading the file, and would hand the model the answer to a case.
const { event: UPDATES_EVENT, updates: UPDATES_LIST } = readJson<{ event: string; updates: unknown[] }>('event-updates.json');
const UPDATES = JSON.stringify({ event: UPDATES_EVENT, updates: UPDATES_LIST }, null, 2);

/** The one tool the MCP endpoint offers: what the model reads about it. */
export const UPDATES_TOOL = {
  name: 'get_event_updates',
  description:
    'Get the organisers\' current announcements for the event: changes to times, rooms and the programme since the event information was published. Each announcement has a date, who issued it, and the text. Takes no arguments. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

const MAX_BODY = 8 * 1024;
const MAX_QUESTION = 1000;
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

/**
 * The message the agent reads: the published event information, then the
 * question. The question cannot open or close the information block, so a
 * visitor cannot pass off their own text as published information.
 */
export function buildMessage(question: string): string {
  const clean = question.replace(/<\/?\s*event_information[^>]*>/gi, '').trim();
  return `<event_information>\n${EVENT_INFO.trim()}\n</event_information>\n\nVisitor's question: ${clean}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('body is not JSON'), { status: 400 });
  }
}

export function createStarter(options: StarterOptions): Starter {
  const log = options.log ?? ((line: string) => console.log(line));
  const sessions = new Map<string, Session>();
  const toolLog: ToolCall[] = [];
  let toolDown = options.toolDown ?? false;
  const secrets = [options.agent.secret, options.agent.apiKey];

  const sessionOf = (req: IncomingMessage): Session | undefined => {
    const sid = cookieValue(req, 'sid');
    return sid ? sessions.get(sid) : undefined;
  };

  /**
   * MCP over Streamable HTTP, the smallest server that works: JSON
   * responses, no session, one tool. Hand-written so every message is
   * visible; a real tool server would use the MCP SDK.
   */
  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const msg = (await readBody(req)) as { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: string; protocolVersion?: string } };
    if (msg.id === undefined) {
      res.writeHead(202);
      res.end();
      return; // a notification (notifications/initialized): nothing to answer
    }
    const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'capstone-event-updates', version: '1.0.0' },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: [UPDATES_TOOL] });
      case 'tools/call': {
        if (msg.params?.name !== UPDATES_TOOL.name) {
          return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${msg.params?.name}` } });
        }
        const status = toolDown ? 503 : 200;
        toolLog.push({ tool: 'get_event_updates', at: new Date().toISOString(), status });
        log(`[tool] get_event_updates -> ${status === 200 ? 'ok' : 'unavailable'}`);
        return reply(
          toolDown
            ? { isError: true, content: [{ type: 'text', text: 'ERROR: the event updates service is unavailable (HTTP 503). No announcements could be checked.' }] }
            : { content: [{ type: 'text', text: UPDATES }] },
        );
      }
      default:
        return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    // The read-only tool the agent service calls, as a minimal MCP server
    // (no session: the caller is the A2A server, not a visitor).
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
      }
      return handleMcp(req, res);
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(readFileSync(path.join(PUBLIC, file)));
      return;
    }

    if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: { kind: 'not_found', message: 'Not found.' } });

    // Every state-changing call is JSON from this page's own origin. A
    // cross-site form cannot send application/json without a preflight,
    // and the session cookie is SameSite=Strict.
    if (req.method === 'POST') {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return sendJson(res, 415, { error: { kind: 'bad_request', message: 'Send JSON.' } });
      }
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) {
        return sendJson(res, 403, { error: { kind: 'bad_request', message: 'Cross-origin requests are refused.' } });
      }
    }

    if (route === 'GET /api/users') {
      return sendJson(res, 200, { users: TEST_USERS.map((u) => ({ username: u.username, displayName: u.displayName })) });
    }

    if (route === 'POST /api/login') {
      const body = (await readBody(req)) as { username?: unknown };
      const user = TEST_USERS.find((u) => u.username === body.username);
      if (!user) return sendJson(res, 400, { error: { kind: 'bad_request', message: 'Pick one of the test accounts.' } });
      const sid = randomBytes(32).toString('base64url');
      sessions.set(sid, { user, contextId: `conv-${randomBytes(9).toString('base64url')}` });
      return sendJson(res, 200, { displayName: user.displayName, mode: options.mode }, {
        'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }

    if (route === 'POST /api/logout') {
      const sid = cookieValue(req, 'sid');
      if (sid) sessions.delete(sid);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    const session = sessionOf(req);
    if (!session) return sendJson(res, 401, { error: { kind: 'signed_out', message: 'Sign in with a test account first.' } });

    if (route === 'GET /api/me') {
      return sendJson(res, 200, { displayName: session.user.displayName, mode: options.mode, toolDown });
    }

    if (route === 'POST /api/new-conversation') {
      session.contextId = `conv-${randomBytes(9).toString('base64url')}`;
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'POST /api/ask') {
      // Only `question` is read from the body. A userId, accountId or
      // X-User-Id the browser sends is ignored: identity is the session's.
      const body = (await readBody(req)) as { question?: unknown };
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question || question.length > MAX_QUESTION) {
        return sendJson(res, 400, { error: { kind: 'bad_request', message: `Ask a question of 1 to ${MAX_QUESTION} characters.` } });
      }
      const started = Date.now();
      const firstTool = toolLog.length;
      const trace = (statusLines: string[]): Trace => ({
        mode: options.mode,
        forwardedUserId: session.user.accountId,
        identitySource: 'session',
        contextId: session.contextId,
        toolCalls: toolLog.slice(firstTool),
        statusLines,
        durationMs: Date.now() - started,
      });

      if (options.mode === 'mock') {
        return sendJson(res, 200, { answer: MOCK.text, trace: trace([]) });
      }

      const outcome = await askAgent(
        options.agent,
        { userId: session.user.accountId, text: buildMessage(question), contextId: session.contextId },
        options.fetchImpl,
      );
      const t = trace(outcome.ok ? outcome.statusLines : []);
      const toolFailed = t.toolCalls.some((c) => c.status >= 400);
      if (!outcome.ok) {
        log(`[ask] ${session.user.username}: ${outcome.kind}: ${redact(outcome.detail, ...secrets)}`);
        return sendJson(res, outcome.httpStatus, { error: { kind: outcome.kind satisfies FailureKind, message: outcome.message }, trace: t });
      }
      log(`[ask] ${session.user.username}: answered in ${t.durationMs} ms, ${t.toolCalls.length} tool call(s)`);
      return sendJson(res, 200, {
        answer: outcome.text,
        ...(toolFailed ? { notice: 'The live updates could not be checked for this answer, so it rests on the published event information only.' } : {}),
        trace: t,
      });
    }

    return sendJson(res, 404, { error: { kind: 'not_found', message: 'Not found.' } });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: { status?: number; message?: string }) => {
      const status = err?.status ?? 500;
      if (status === 500) log(`[error] ${redact(err?.message ?? String(err), ...secrets)}`);
      if (!res.headersSent) sendJson(res, status, { error: { kind: 'bad_request', message: status === 500 ? 'Something went wrong on our side.' : String(err.message) } });
      else res.end();
    });
  });

  return {
    server,
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    setToolDown: (down) => {
      toolDown = down;
    },
  };
}

/** A minimal .env read: KEY=value lines; the shell environment wins. */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

/** The starter's options from the environment. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): StarterOptions & { port: number; host: string } {
  const mode = (env.CAPSTONE_MODE ?? 'mock').trim();
  if (mode !== 'mock' && mode !== 'a2a') throw new Error(`CAPSTONE_MODE must be mock or a2a (got '${mode}')`);
  return {
    mode,
    port: Number(env.CAPSTONE_PORT ?? 4100),
    host: env.CAPSTONE_HOST ?? '127.0.0.1',
    toolDown: env.CAPSTONE_TOOL_DOWN === 'true',
    agent: {
      url: env.A2A_URL ?? 'http://127.0.0.1:4000/a2a/jsonrpc',
      secret: env.A2A_SERVER_SECRET ?? '',
      apiKey: env.A2A_API_KEY ?? '',
      timeoutMs: Number(env.CAPSTONE_TIMEOUT_MS ?? 180_000),
    },
  };
}

const invokedAsMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  loadDotEnv(path.join(process.cwd(), '.env'));
  const opts = optionsFromEnv();
  const starter = createStarter(opts);
  starter
    .listen(opts.port, opts.host)
    .then((port) => {
      console.log(`Capstone starter on http://${opts.host}:${port}  (mode: ${opts.mode})`);
      if (opts.mode === 'a2a') {
        console.log(`  agent service: ${opts.agent.url}`);
        console.log(`  A2A_SERVER_SECRET: ${opts.agent.secret ? `set (${opts.agent.secret.length} chars)` : 'not set (the local server must run without one)'}`);
        console.log(`  A2A_API_KEY: ${opts.agent.apiKey ? 'set (sent as X-API-Key)' : 'not set (the server pays with its own keys)'}`);
      }
      console.log(`  updates tool (MCP): http://${opts.host}:${port}/mcp${opts.toolDown ? '  (DOWN: every call returns an error)' : ''}`);
    })
    .catch((err: NodeJS.ErrnoException) => {
      console.error(err.code === 'EADDRINUSE' ? `Port ${opts.port} is in use: stop the other process or set CAPSTONE_PORT.` : err.message);
      process.exit(1);
    });
}
