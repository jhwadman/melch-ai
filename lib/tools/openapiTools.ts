/**
 * lib/tools/openapiTools.ts — any HTTP API with an OpenAPI spec becomes an
 * agent's tools, from YAML.
 *
 * WHY: "Bring your own API" was a code task: write a `defineTool` per
 * endpoint, register it, name it in YAML. ADK 2.2 ships `OpenAPIToolset`,
 * which turns an OpenAPI 3 spec into one tool per operation (parameters and
 * request body as the tool's schema, the operation's summary as its
 * description). An agent's `openapi:` list hands it a spec file:
 *
 *   openapi:
 *     - spec: "specs/weather.yaml"          # beside this YAML file
 *       operations: [getForecast]           # omitted: the GET operations only
 *       auth: { api_key: { env: "WEATHER_KEY", in: "header", name: "X-Api-Key" } }
 *
 * WHAT THE ENGINE ADDS to ADK's toolset, all of it exposure discipline:
 *   - READ-ONLY BY DEFAULT. Without `operations`, only GET operations become
 *     tools; anything that writes is exposed only by naming it, and a named
 *     operation can be listed under `require_approval` like a registry tool
 *     (ADR 0028), so a POST or a DELETE can wait for a person.
 *   - SECRETS FROM THE ENVIRONMENT. `auth` names an environment variable,
 *     never a value; a variable that is not set fails the compile, so an
 *     agent never runs half-authenticated. A YAML (possibly registry-stored)
 *     chooses both the variable and the host, so it may never name one of
 *     the framework's own secrets (credentialEnvProblem): the database URL,
 *     a provider key or an A2A secret cannot be sent to an API.
 *     OPENAPI_CREDENTIAL_ENVS, when the operator sets it, is the exact list
 *     of variables an `auth` may name.
 *   - THE SSRF GUARD. Every server URL the tools will call must be http(s)
 *     and pass lib/net/addressGuard.ts: its literal rules at compile time
 *     (offline), and the full check with DNS before each call (a name can
 *     re-resolve between calls). ALLOW_PRIVATE_OPENAPI=true permits
 *     private hosts for local development, as ALLOW_PRIVATE_MCP does for MCP.
 *     The model chooses arguments, never the host: path parameters are
 *     URL-encoded by ADK and dot segments refused.
 *   - REDIRECTS HELD TO THE SAME GUARD. ADK calls globalThis.fetch, which
 *     follows redirects; a call runs under lib/net/redirects.ts instead, so
 *     each hop is checked before it is fetched. A hop on the same origin
 *     gets the server's own check; a hop to another origin must pass the
 *     full guard even with ALLOW_PRIVATE_OPENAPI (that permits the server
 *     you configured, not wherever it points), and loses every header but
 *     content negotiation, credentials included.
 *   - BOUNDED RESULTS. A response larger than MAX_RESULT_CHARS is cut and
 *     says so; a network failure comes back as `{ error }`, never a throw.
 *
 * Spec files only, never URLs: a spec fetched at compile time would be a
 * second outbound surface, and a spec that changes under a running agent
 * changes its tools. Save the spec beside the YAML and review it like code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { BaseTool, OpenAPIToolset, tokenToSchemeCredential } from '@google/adk';
import type { RunAsyncToolRequest } from '@google/adk';

import { blockedHostReason, checkHost } from '../net/addressGuard.ts';
import { withRedirectGuard } from '../net/redirects.ts';
import type { RedirectPolicy } from '../net/redirects.ts';
import { MAX_RESULT_CHARS as TOOL_RESULT_CHARS } from './tool.ts';

export interface OpenApiAuthConfig {
  /** Environment variable holding a bearer token (`Authorization: Bearer …`). */
  bearer_env?: string;
  /** An API key from an environment variable, sent in a header or the query. */
  api_key?: { env: string; in: 'header' | 'query'; name: string };
}

/** One entry of an agent's `openapi:` list. */
export interface OpenApiConfig {
  /** Path to an OpenAPI 3 spec (.yaml, .yml or .json). Relative paths resolve beside the syndicate file. */
  spec: string;
  /** Operations to expose, by operationId or tool name. Omitted: every GET operation. */
  operations?: string[];
  /** Overrides the spec's `servers[0].url`. */
  base_url?: string;
  /** Prepended to every tool name (`<prefix>_<tool>`), to keep two APIs apart. */
  prefix?: string;
  auth?: OpenApiAuthConfig;
}

/** Characters a single API result may carry into the conversation: every tool's shared limit (lib/tools/tool.ts). */
export const MAX_RESULT_CHARS = TOOL_RESULT_CHARS;

/** Marks a tool built here, so require_approval may gate it (lib/compile.ts). */
export const OPENAPI_TOOL = Symbol.for('melchizedek.openapiTool');

/** snake_case, the way ADK names a tool from an operationId. */
export function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** True when a configured operation name (an operationId or a tool name) names this tool. */
export function namesTool(configured: string, tool: { name: string; operation?: { operationId?: string } }): boolean {
  return configured === tool.name || configured === tool.operation?.operationId || toSnake(configured) === tool.name;
}

/**
 * Why a server may not be called, or null. At compile time only the literal
 * rules apply (no connection is made, and a build must not need DNS); before
 * each call the name is resolved too, which guards the connection itself.
 */
async function hostProblem(baseUrl: string, resolve: boolean): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `'${baseUrl}' is not a URL`;
  }
  if (!/^https?:$/.test(url.protocol)) return `'${baseUrl}' must be http(s)`;
  if (process.env.ALLOW_PRIVATE_OPENAPI === 'true') return null;
  const reason = resolve ? await checkHost(url.hostname) : blockedHostReason(url.hostname);
  return reason ? `refusing ${url.hostname}: ${reason} (set ALLOW_PRIVATE_OPENAPI=true for local development)` : null;
}

/** Prefixes and names of variables the framework itself reads: never an API credential. */
const FRAMEWORK_ENV_PREFIXES = [
  'A2A_', 'SUPABASE_', 'DATABASE_', 'MCP_', 'MODEL_', 'MEMORY_', 'OTEL_', 'TELEMETRY_', 'MELCHIZEDEK_',
  'GOOGLE_', 'GEMINI_', 'ANTHROPIC_', 'OPENAI_', 'AZURE_', 'AWS_', 'XAI_', 'MOONSHOT_', 'OLLAMA_', 'WIKI_',
  'ALLOW_', 'OPENAPI_',
];
const FRAMEWORK_ENV_NAMES = new Set(['PUBLIC_URL', 'HOST', 'PORT', 'PATH', 'HOME', 'NODE_OPTIONS', 'WEB_EXTRACT_CHAR_LIMIT']);

/**
 * Why an `auth` may not read this variable, or null. With
 * OPENAPI_CREDENTIAL_ENVS set, only the names it lists are allowed; without
 * it, anything but the framework's own variables is.
 */
export function credentialEnvProblem(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const allow = env.OPENAPI_CREDENTIAL_ENVS?.split(',').map((s) => s.trim()).filter(Boolean);
  if (allow?.length) {
    return allow.includes(name) ? null : `${name} is not in OPENAPI_CREDENTIAL_ENVS (${allow.join(', ')})`;
  }
  if (FRAMEWORK_ENV_NAMES.has(name) || FRAMEWORK_ENV_PREFIXES.some((p) => name.startsWith(p))) {
    return `${name} is one of the framework's own settings and may not be sent to an API; give the API its own variable (or list it in OPENAPI_CREDENTIAL_ENVS)`;
  }
  return null;
}

function credentialFor(auth: OpenApiAuthConfig | undefined, spec: string): { authScheme?: any; authCredential?: any } {
  if (!auth) return {};
  const read = (env: string): string => {
    const refused = credentialEnvProblem(env);
    if (refused) throw new Error(`openapi ${spec}: ${refused}`);
    const value = process.env[env]?.trim();
    if (!value) throw new Error(`openapi ${spec}: ${env} is not set (auth reads it from the environment)`);
    return value;
  };
  if (auth.bearer_env) {
    const [authScheme, authCredential] = tokenToSchemeCredential('oauth2Token', undefined, undefined, read(auth.bearer_env));
    return { authScheme, authCredential };
  }
  if (auth.api_key) {
    const [authScheme, authCredential] = tokenToSchemeCredential('apikey', auth.api_key.in, auth.api_key.name, read(auth.api_key.env));
    return { authScheme, authCredential };
  }
  return {};
}

/**
 * Where an API call may be redirected: the server's own rule on its origin,
 * the full guard (no development exception) anywhere else.
 */
const REDIRECTS: RedirectPolicy = {
  async hopProblem(url, crossOrigin) {
    if (!/^https?:$/.test(url.protocol)) return `${url.protocol} is not http(s)`;
    if (!crossOrigin) return hostProblem(url.href, true);
    const reason = await checkHost(url.hostname);
    return reason ? `refusing ${url.hostname}: ${reason}` : null;
  },
};

/** Cut an API result to MAX_RESULT_CHARS, saying so. */
export function boundResult(result: unknown): unknown {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  if (text.length <= MAX_RESULT_CHARS) return result;
  return { truncated: true, text: `${text.slice(0, MAX_RESULT_CHARS)}… [cut at ${MAX_RESULT_CHARS} characters]` };
}

/**
 * The tools one `openapi:` entry gives an agent. Throws (failing the compile)
 * on a missing spec, an unset auth variable, an operation the spec does not
 * have, or a server the guard refuses.
 */
export async function buildOpenApiTools(entry: OpenApiConfig, baseDir: string = process.cwd()): Promise<BaseTool[]> {
  const specPath = resolve(baseDir, entry.spec);
  if (!existsSync(specPath)) throw new Error(`openapi: spec not found: ${entry.spec}`);
  const ext = extname(specPath).toLowerCase();
  if (!['.yaml', '.yml', '.json'].includes(ext)) throw new Error(`openapi ${entry.spec}: a spec is .yaml, .yml or .json`);
  const toolset = new OpenAPIToolset({
    specStr: readFileSync(specPath, 'utf-8'),
    specType: ext === '.json' ? 'json' : 'yaml',
    ...(entry.prefix ? { prefix: entry.prefix } : {}),
    ...credentialFor(entry.auth, entry.spec),
  });
  const all = (await toolset.getTools()) as Array<BaseTool & { endpoint: { method: string; baseUrl: string }; operation?: { operationId?: string } }>;

  let chosen: typeof all;
  if (entry.operations?.length) {
    const unknown = entry.operations.filter((op) => !all.some((t) => namesTool(op, t) || namesTool(op, { name: t.name.replace(`${entry.prefix}_`, ''), operation: t.operation })));
    if (unknown.length) {
      throw new Error(`openapi ${entry.spec}: no operation ${unknown.map((u) => `'${u}'`).join(', ')} (the spec has ${all.map((t) => t.operation?.operationId ?? t.name).join(', ')})`);
    }
    chosen = all.filter((t) => entry.operations!.some((op) => namesTool(op, t) || namesTool(op, { name: t.name.replace(`${entry.prefix}_`, ''), operation: t.operation })));
  } else {
    chosen = all.filter((t) => t.endpoint.method.toLowerCase() === 'get');
  }

  if (entry.base_url) for (const t of chosen) t.endpoint.baseUrl = entry.base_url;
  for (const baseUrl of new Set(chosen.map((t) => t.endpoint.baseUrl))) {
    if (!baseUrl) throw new Error(`openapi ${entry.spec}: the spec names no server; set base_url`);
    const problem = await hostProblem(baseUrl, false);
    if (problem) throw new Error(`openapi ${entry.spec}: ${problem}`);
  }
  return chosen.map(guarded);
}

/**
 * A copy of a generated tool whose call re-checks its host, follows
 * redirects only where the guard allows, catches a network failure, and
 * bounds the result. The original is untouched.
 */
function guarded<T extends BaseTool & { endpoint: { baseUrl: string } }>(tool: T): T {
  const copy = Object.create(tool) as T;
  const original = tool.runAsync.bind(tool);
  Object.defineProperty(copy, OPENAPI_TOOL, { value: true });
  Object.defineProperty(copy, 'runAsync', {
    value: async (request: RunAsyncToolRequest) => {
      const problem = await hostProblem(tool.endpoint.baseUrl, true);
      if (problem) return { error: `${tool.name} was not called: ${problem}` };
      try {
        return boundResult(await withRedirectGuard(REDIRECTS, () => original(request)));
      } catch (err) {
        return { error: `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
  return copy;
}

/** True for a tool built from an `openapi:` entry. */
export function isOpenApiTool(tool: unknown): boolean {
  return !!tool && typeof tool === 'object' && (tool as Record<symbol, unknown>)[OPENAPI_TOOL] === true;
}
