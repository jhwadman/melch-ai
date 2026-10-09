/**
 * lib/tools/mcpToolFactory.ts — a remote MCP server's tools, as the
 * engine's own Tools (lib/tools/tool.ts, ADR 0062).
 *
 * An agent's `mcp_server_url:` connects here over SSE; every tool the
 * server lists becomes an own Tool whose declaration is the server's
 * description (bounded) and input schema, and whose execute calls the
 * server and returns its text (bounded). loadMcpTools returns them;
 * createMcpTools is the name the compiler calls.
 *
 * The server is an untrusted tool vendor (ADR 0041): its URL passes the
 * SSRF guard, a credential goes only to its exact host, and its
 * descriptions and results are cut to a bound.
 *
 * A server that takes an OAuth token declares it in YAML (`mcp_auth:
 * { oauth2 }`, ADR 0112): the server's own token (client_credentials) on one
 * shared connection, or each user's (authorization_code) on that user's own
 * connection, read through `ctx.accessToken` so a user who has not granted
 * it is asked (ADR 0085).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ToolDeclaration } from '../models/contract.ts';
import { toContractJsonSchema } from '../models/schemaNormalize.ts';
import { checkHost } from '../net/addressGuard.ts';
import { fetchWithRedirectPolicy } from '../net/redirects.ts';
import type { RedirectPolicy } from '../net/redirects.ts';
import { ToolCredentialError } from './auth.ts';
import { oauthCallProblem, oauthTokenSource } from './oauthTools.ts';
import type { OAuth2AuthConfig } from './oauthTools.ts';
import { MAX_RESULT_CHARS } from './tool.ts';
import type { Tool, ToolContext } from './tool.ts';
import { toGeminiSchema } from './toolContract.ts';

// Security (SSRF): mcp_server_url can arrive from a registry-stored syndicate
// config. Only http(s), and the host must pass lib/net/addressGuard.ts (the
// same guard web_extract uses): local names and non-public addresses —
// including names that RESOLVE to one — are refused, so a malicious config
// cannot reach internal services or the cloud metadata endpoint. Set
// ALLOW_PRIVATE_MCP=true to permit private hosts in local development (where
// MCP servers commonly run on localhost).
export async function assertSafeMcpUrl(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid MCP server URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported MCP URL scheme: ${url.protocol}`);
  }
  if (env.ALLOW_PRIVATE_MCP === 'true') return url;
  const reason = await checkHost(url.hostname);
  if (reason) {
    throw new Error(`Refusing to connect to MCP host ${url.hostname}: ${reason} (set ALLOW_PRIVATE_MCP=true for local dev)`);
  }
  return url;
}

// Credentials for MCP servers that require one. MCP_BEARER_TOKENS is a JSON
// object of hostname → token. A token goes only to the exact host it names and
// only over https, so a registry-stored mcp_server_url pointing anywhere else
// never receives it. A malformed value degrades to an unauthenticated connect,
// which such a server refuses — the same empty tool list as an unreachable one.
export function mcpAuthHeaders(url: URL, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.MCP_BEARER_TOKENS;
  if (!raw || url.protocol !== 'https:') return {};
  let tokens: unknown;
  try {
    tokens = JSON.parse(raw);
  } catch {
    console.warn('[MCP] MCP_BEARER_TOKENS is not a JSON object; connecting without credentials');
    return {};
  }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return {};
  const host = url.hostname.toLowerCase();
  if (!Object.hasOwn(tokens, host)) return {};
  const token = (tokens as Record<string, unknown>)[host];
  return typeof token === 'string' && token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Where an MCP connection may be redirected (ADR 0036's rule, applied to MCP):
 * a hop on the server's own origin gets the server's check (ALLOW_PRIVATE_MCP
 * applies), a hop anywhere else the full guard with no development exception,
 * and lib/net/redirects.ts strips every credential header from it, so a
 * bearer token from MCP_BEARER_TOKENS never follows a redirect off its host.
 * The SDK already refuses a POST endpoint on another origin.
 */
export const MCP_REDIRECTS: RedirectPolicy = {
  async hopProblem(url, crossOrigin) {
    if (!crossOrigin) {
      try {
        await assertSafeMcpUrl(url.href);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol} is not http(s)`;
    const reason = await checkHost(url.hostname);
    return reason ? `refusing MCP redirect to ${url.hostname}: ${reason}` : null;
  },
};

/** The fetch an MCP transport uses: every redirect hop checked before it is followed. */
export const mcpFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  fetchWithRedirectPolicy(input, init, MCP_REDIRECTS, (i, o) => fetch(i, o));

/**
 * A remote MCP server is an untrusted tool vendor: its tool descriptions go
 * into the prompt and its results into the conversation. Both are bounded,
 * so a server cannot flood the context (or the bill) with either.
 */
export const MAX_MCP_DESCRIPTION_CHARS = 1_000;
/** Every tool's shared result limit (lib/tools/tool.ts). */
export const MAX_MCP_RESULT_CHARS = MAX_RESULT_CHARS;
const bounded = (text: string, max: number, what: string): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [${what} cut at ${max} characters]`;

/** Every MCP connection opened and still in use, so a shutdown can close them. */
const openTransports = new Set<SSEClientTransport>();

/**
 * Close every open MCP connection. A connection otherwise lives as long as
 * the process (its tools are called for the life of the compiled agent), and
 * its stream reconnects when the server restarts; an embedding app that
 * stops cleanly, or a test, calls this.
 */
export async function closeMcpConnections(): Promise<void> {
  const all = [...openTransports];
  openTransports.clear();
  for (const pool of userPools) pool.clear();
  await Promise.all(all.map((t) => t.close().catch(() => {})));
}

/**
 * The parameters an MCP tool declares: the server's input schema, each
 * top-level property given a type (string when the server names none) and a
 * description, in the contract's lowercase dialect. They pass through
 * Gemini's dialect first (toGeminiSchema), so the declaration is exactly
 * what ADK's FunctionTool declared: `default`, `propertyNames`, `$schema`
 * and a boolean `additionalProperties` are left out.
 */
export function mcpToolParameters(inputSchema: { properties?: Record<string, unknown>; required?: string[] } | undefined): ToolDeclaration['parameters'] {
  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries<any>(inputSchema?.properties ?? {})) {
    properties[key] = { ...prop, type: prop?.type ?? 'string', description: prop?.description || '' };
  }
  const required = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
  return toContractJsonSchema(toGeminiSchema({ type: 'object', properties, required }));
}

/** What the server says about one tool, as the contract declares it (description bounded). */
function declarationOf(tool: { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }): ToolDeclaration {
  return {
    name: tool.name,
    description: bounded(tool.description || `MCP Tool: ${tool.name}`, MAX_MCP_DESCRIPTION_CHARS, 'description'),
    parameters: mcpToolParameters(tool.inputSchema),
  };
}

/** A callTool result's text parts, joined and bounded. */
function resultText(result: unknown): string {
  // MCP callTool returns { content: [{ type: 'text', text: '...' }] }
  const content = ((result as { content?: Array<{ type: string; text?: string }> })?.content ?? []);
  const texts = content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
  return bounded(texts.join('\n'), MAX_MCP_RESULT_CHARS, 'result');
}

/** A message with every occurrence of `secret` cut out: an SDK error can quote a request. */
const redact = (message: string, secret: string | undefined): string => (secret ? message.split(secret).join('[redacted]') : message);

/**
 * The fetch an MCP transport uses when the server takes an OAuth token
 * (ADR 0112): every request (the SSE stream and each POST) carries the
 * token `token()` returns now, and every redirect hop is checked, a hop off
 * the server's origin losing the header (MCP_REDIRECTS).
 */
function bearerFetch(oauth2: OAuth2AuthConfig, token: (destination: string) => Promise<string>) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Every request is checked where it actually goes (the stream, and the
    // message endpoint the server names), before a token is attached (ADR 0114).
    const destination = input instanceof Request ? input.url : String(input);
    if (oauthCallProblem(oauth2, destination)) throw new ToolCredentialError('host_refused', oauth2.provider, 'oauth');
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${await token(destination)}`);
    return mcpFetch(input, { ...init, headers });
  };
}

/** How an agent reaches its MCP server: which tools it may use, and the OAuth grant the server takes. */
export interface McpToolOptions {
  /** `mcp_tools`: the names this agent may use. Required with an authorization_code grant. */
  tools?: string[];
  /** `mcp_auth.oauth2` (ADR 0112). Without it, MCP_BEARER_TOKENS applies. */
  oauth2?: OAuth2AuthConfig;
}

/** Per-user connections at most per authorization-code server; the least recently used is closed first. */
export const MAX_MCP_USER_CONNECTIONS = 64;

/** Every per-user pool, so closeMcpConnections can empty them. */
const userPools = new Set<Map<string, unknown>>();

/**
 * The tools a remote MCP server offers, as own Tools, or none when the
 * server cannot be reached or refuses (logged, never thrown). The
 * connection stays open for the tools' calls; closeMcpConnections ends it.
 *
 * With `oauth2` (ADR 0112):
 *   - client_credentials: one connection, every request carrying the
 *     server's own token for the provider (lib/tools/oauthTools.ts).
 *   - authorization_code: the token is each user's, so there is no
 *     connection at compile time. Each name in `tools` becomes a Tool whose
 *     call reads the run's user's token (`ctx.accessToken`, which asks for
 *     consent when the user has not granted it) and runs on that user's own
 *     connection. The parameters are the server's, learned from the first
 *     listing any user's connection makes; until then a call connects and
 *     asks the model to call again with them, rather than call blind.
 * A missing variable or a refused URL fails the compile (thrown), naming
 * the variable, never a value.
 */
export async function loadMcpTools(mcpServerUrl: string, options: McpToolOptions = {}): Promise<Tool[]> {
  const oauth2 = options.oauth2;
  if (oauth2?.grant === 'authorization_code') return userGrantMcpTools(mcpServerUrl, oauth2, options.tools);
  const tokenSource = oauth2 ? oauthTokenSource(oauth2, `mcp ${mcpServerUrl}`, mcpServerUrl, { allowPrivate: process.env.ALLOW_PRIVATE_MCP === 'true' }) : undefined;
  let transport: SSEClientTransport | undefined;
  try {
    const url = await assertSafeMcpUrl(mcpServerUrl);
    transport = new SSEClientTransport(
      url,
      tokenSource
        ? { fetch: bearerFetch(oauth2!, (destination) => tokenSource(undefined, destination)) }
        : { requestInit: { headers: mcpAuthHeaders(url) }, fetch: mcpFetch },
    );
    const client = new Client({
      name: 'melchizedek-a2a-client',
      version: '1.0.0'
    }, {
      capabilities: {}
    });

    await client.connect(transport);
    openTransports.add(transport);

    // Fetch available tools from the MCP server
    const toolsResponse = await client.listTools();

    return toolsResponse.tools.map((tool): Tool => {
      // MCP servers describe tools in standard lowercase JSON Schema, which
      // is the contract's dialect; mcpToolParameters derives the parameters.
      const declaration = declarationOf(tool);
      return {
        name: tool.name,
        declaration: () => declaration,
        execute: async (input: Record<string, unknown>): Promise<string> => {
          try {
            return resultText(await client.callTool({ name: tool.name, arguments: input }));
          } catch (error: any) {
            return `[MCP ERROR] Tool ${tool.name} failed: ${error instanceof ToolCredentialError ? error.message : error?.message}`;
          }
        },
      };
    });
  } catch (error) {
    // A token that cannot be had is reported by kind; the rest as before.
    console.warn(`[MCP] Failed to connect or load tools from ${mcpServerUrl}`, error instanceof ToolCredentialError ? error.message : error);
    // A failed connect leaves the SSE stream's reconnect timer running; close
    // it, or every unreachable server keeps retrying for the process's life.
    if (transport) openTransports.delete(transport);
    await transport?.close().catch(() => {});
    return [];
  }
}

/** One user's connection to an authorization-code server, and the token its requests carry now. */
interface UserConnection {
  holder: { token: string };
  /** Set once the URL has passed the guard. */
  transport?: SSEClientTransport;
  ready: Promise<Client>;
}

/** The tools of a server whose calls carry each user's own OAuth token (authorization_code). */
function userGrantMcpTools(mcpServerUrl: string, oauth2: OAuth2AuthConfig, names: string[] | undefined): Tool[] {
  const where = `mcp ${mcpServerUrl}`;
  if (!names?.length) throw new Error(`${where}: an authorization_code mcp_auth needs mcp_tools, the names this agent may use (no user's grant exists to list them at startup)`);
  const source = oauthTokenSource(oauth2, where, mcpServerUrl);
  const provider = oauth2.provider;
  /** The server's declarations, from the first listing any user's connection made. */
  const known = new Map<string, ToolDeclaration>();
  let listed = false;
  const pool = new Map<string, UserConnection>();
  userPools.add(pool as Map<string, unknown>);

  const drop = (key: string, conn: UserConnection) => {
    if (pool.get(key) === conn) pool.delete(key);
    if (!conn.transport) return;
    openTransports.delete(conn.transport);
    void conn.transport.close().catch(() => {});
  };

  const connectionFor = (key: string, token: string): Promise<Client> => {
    const held = pool.get(key);
    if (held) {
      held.holder.token = token;
      // Most recently used last.
      pool.delete(key);
      pool.set(key, held);
      return held.ready;
    }
    const holder = { token };
    const conn = {} as UserConnection;
    conn.holder = holder;
    conn.ready = (async () => {
      const url = await assertSafeMcpUrl(mcpServerUrl);
      const transport = new SSEClientTransport(url, { fetch: bearerFetch(oauth2, async () => holder.token) });
      conn.transport = transport;
      const client = new Client({ name: 'melchizedek-a2a-client', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      openTransports.add(transport);
      if (!listed) {
        const offered = await client.listTools();
        for (const tool of offered.tools) if (names.includes(tool.name)) known.set(tool.name, declarationOf(tool));
        listed = true;
      }
      return client;
    })();
    conn.ready.catch(() => drop(key, conn));
    pool.set(key, conn);
    while (pool.size > MAX_MCP_USER_CONNECTIONS) {
      const [oldestKey, oldest] = pool.entries().next().value as [string, UserConnection];
      drop(oldestKey, oldest);
    }
    return conn.ready;
  };

  return names.map((name): Tool => {
    const placeholder: ToolDeclaration = {
      name,
      description: `${name}, a tool on the ${provider} MCP server. Its parameters are known once this person has connected ${provider}; until then, call it with no arguments to connect.`,
      parameters: mcpToolParameters(undefined),
    };
    return {
      name,
      declaration: () => known.get(name) ?? placeholder,
      execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
        let token: string;
        try {
          token = await source(ctx, mcpServerUrl);
        } catch (error) {
          return `[MCP ERROR] Tool ${name}: ${error instanceof ToolCredentialError ? error.message : `the ${provider} authorization could not be read.`}`;
        }
        if (!ctx?.appName || !ctx?.userId) return `[MCP ERROR] Tool ${name}: ${new ToolCredentialError('no_user', provider).message}`;
        const key = `${ctx.appName}\0${ctx.userId}`;
        const blind = !known.has(name);
        let client: Client;
        try {
          client = await connectionFor(key, token);
        } catch {
          return `[MCP ERROR] Tool ${name}: the ${provider} MCP server could not be reached with this person's authorization.`;
        }
        if (!known.has(name)) return `[MCP ERROR] Tool ${name}: the ${provider} MCP server does not offer it.`;
        if (blind) return `Connected to ${provider}. ${name}'s parameters are now known: call it again with them.`;
        try {
          return resultText(await client.callTool({ name, arguments: input }));
        } catch (error: any) {
          // The connection may be dead (or its token refused): the next call opens a fresh one.
          const conn = pool.get(key);
          if (conn) drop(key, conn);
          return `[MCP ERROR] Tool ${name} failed: ${redact(String(error?.message ?? error), token)}`;
        }
      },
    };
  });
}

/** The server's tools, as the compiler lists them on an agent: loadMcpTools' own Tools. */
export async function createMcpTools(mcpServerUrl: string, options: McpToolOptions = {}): Promise<Tool[]> {
  return loadMcpTools(mcpServerUrl, options);
}
