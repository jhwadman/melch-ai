/**
 * lib/tools/mcpToolFactory.ts — a remote MCP server's tools, as the
 * engine's own Tools (lib/tools/tool.ts, ADR 0062).
 *
 * An agent's `mcp_server_url:` connects here over SSE; every tool the
 * server lists becomes an own Tool whose declaration is the server's
 * description (bounded) and input schema, and whose execute calls the
 * server and returns its text (bounded). loadMcpTools returns them for the
 * native runtime; createMcpTools hands the ADK runtime the FunctionTool
 * toFunctionTool (lib/tools/adkTool.ts) makes of each, so both runtimes
 * declare the same parameters and run the same call.
 *
 * The server is an untrusted tool vendor (ADR 0041): its URL passes the
 * SSRF guard, a credential goes only to its exact host, and its
 * descriptions and results are cut to a bound.
 */
import type { FunctionTool } from '@google/adk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ToolDeclaration } from '../models/contract.ts';
import { toContractJsonSchema } from '../models/schemaNormalize.ts';
import { checkHost } from '../net/addressGuard.ts';
import { fetchWithRedirectPolicy } from '../net/redirects.ts';
import type { RedirectPolicy } from '../net/redirects.ts';
import { toFunctionTool } from './adkTool.ts';
import { MAX_RESULT_CHARS } from './tool.ts';
import type { Tool } from './tool.ts';
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
  await Promise.all(all.map((t) => t.close().catch(() => {})));
}

/**
 * The parameters an MCP tool declares: the server's input schema, each
 * top-level property given a type (string when the server names none) and a
 * description, in the contract's lowercase dialect. They pass through
 * Gemini's dialect first (toGeminiSchema), so the declaration is exactly
 * what the ADK runtime's FunctionTool declares: `default`, `propertyNames`,
 * `$schema` and a boolean `additionalProperties` are left out on both.
 */
export function mcpToolParameters(inputSchema: { properties?: Record<string, unknown>; required?: string[] } | undefined): ToolDeclaration['parameters'] {
  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries<any>(inputSchema?.properties ?? {})) {
    properties[key] = { ...prop, type: prop?.type ?? 'string', description: prop?.description || '' };
  }
  const required = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
  return toContractJsonSchema(toGeminiSchema({ type: 'object', properties, required }));
}

/**
 * The tools a remote MCP server offers, as own Tools, or none when the
 * server cannot be reached or refuses (logged, never thrown). The
 * connection stays open for the tools' calls; closeMcpConnections ends it.
 */
export async function loadMcpTools(mcpServerUrl: string): Promise<Tool[]> {
  let transport: SSEClientTransport | undefined;
  try {
    const url = await assertSafeMcpUrl(mcpServerUrl);
    transport = new SSEClientTransport(url, {
      requestInit: { headers: mcpAuthHeaders(url) },
      fetch: mcpFetch,
    });
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
      // is the contract's dialect; toFunctionTool derives Gemini's.
      const declaration: ToolDeclaration = {
        name: tool.name,
        description: bounded(tool.description || `MCP Tool: ${tool.name}`, MAX_MCP_DESCRIPTION_CHARS, 'description'),
        parameters: mcpToolParameters(tool.inputSchema),
      };
      return {
        name: tool.name,
        declaration: () => declaration,
        execute: async (input: Record<string, unknown>): Promise<string> => {
          try {
            const result = await client.callTool({
              name: tool.name,
              arguments: input
            });
            // MCP callTool returns { content: [{ type: 'text', text: '...' }] }
            interface McpCallToolResult {
              content: Array<{
                type: string;
                text?: string;
                [key: string]: unknown;
              }>;
            }
            const content = (result as McpCallToolResult).content;
            const texts = content.filter(c => c.type === 'text').map(c => c.text ?? '');
            return bounded(texts.join('\n'), MAX_MCP_RESULT_CHARS, 'result');
          } catch (error: any) {
            return `[MCP ERROR] Tool ${tool.name} failed: ${error.message}`;
          }
        },
      };
    });
  } catch (error) {
    console.warn(`[MCP] Failed to connect or load tools from ${mcpServerUrl}`, error);
    // A failed connect leaves the SSE stream's reconnect timer running; close
    // it, or every unreachable server keeps retrying for the process's life.
    if (transport) openTransports.delete(transport);
    await transport?.close().catch(() => {});
    return [];
  }
}

/**
 * The server's tools as the ADK runtime runs them: the FunctionTool
 * toFunctionTool makes of each own Tool, carrying it for toolOf().
 */
export async function createMcpTools(mcpServerUrl: string): Promise<FunctionTool[]> {
  return (await loadMcpTools(mcpServerUrl)).map((tool) => toFunctionTool(tool));
}
