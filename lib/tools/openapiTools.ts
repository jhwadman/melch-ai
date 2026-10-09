/**
 * lib/tools/openapiTools.ts — any HTTP API with an OpenAPI spec becomes an
 * agent's tools, from YAML.
 *
 * WHY: "Bring your own API" was a code task: write a `defineTool` per
 * endpoint, register it, name it in YAML. An OpenAPI 3 spec becomes one tool
 * per operation (parameters and request body as the tool's schema, the
 * operation's description or summary as its prompt). The engine's own
 * parser (lib/tools/openapi/parse.ts, ADR 0063) reads the spec, names the
 * tools and builds their declarations, by the rules ADK's OpenAPIToolset
 * had; the engine's own caller (lib/tools/openapi/call.ts, ADR 0067) sends
 * each call, by the rules ADK's RestApiTool had. Each operation is an own
 * Tool (lib/tools/tool.ts). An agent's `openapi:` list hands it a spec file:
 *
 *   openapi:
 *     - spec: "specs/weather.yaml"          # beside this YAML file
 *       operations: [getForecast]           # omitted: the GET operations only
 *       auth: { api_key: { env: "WEATHER_KEY", in: "header", name: "X-Api-Key" } }
 *
 * WHAT THE ENGINE ADDS, all of it exposure discipline:
 *   - READ-ONLY BY DEFAULT. Without `operations`, only GET operations become
 *     tools; anything that writes is exposed only by naming it, and a named
 *     operation can be listed under `require_approval` like a registry tool,
 *     gated by the same gate (ADR 0028), so a POST or a DELETE can wait for
 *     a person.
 *   - SECRETS FROM THE ENVIRONMENT. `auth` names an environment variable,
 *     never a value; a variable that is not set fails the compile, so an
 *     agent never runs half-authenticated. A YAML (possibly registry-stored)
 *     chooses both the variable and the host, so it may never name one of
 *     the framework's own secrets (credentialEnvProblem): the database URL,
 *     a provider key or an A2A secret cannot be sent to an API.
 *     OPENAPI_CREDENTIAL_ENVS, when the operator sets it, is the exact list
 *     of variables an `auth` may name. A credential is held by the tool,
 *     never written to session state, and its value never appears in an
 *     error the model reads. An `auth: { oauth2 }` sends an OAuth token
 *     instead, fetched per call: the run's user's own (authorization_code,
 *     through `ctx.accessToken` and the consent pause) or the server's own
 *     (client_credentials), lib/tools/oauthTools.ts, ADR 0112.
 *   - THE SSRF GUARD. Every server URL the tools will call must be http(s)
 *     and pass lib/net/addressGuard.ts: its literal rules at compile time
 *     (offline), and the full check with DNS before each call (a name can
 *     re-resolve between calls). ALLOW_PRIVATE_OPENAPI=true permits
 *     private hosts for local development, as ALLOW_PRIVATE_MCP does for MCP.
 *     The model chooses arguments, never the host: path parameters are
 *     URL-encoded whole and dot segments refused.
 *   - REDIRECTS HELD TO THE SAME GUARD. A call follows redirects by hand
 *     (lib/net/redirects.ts), so each hop is checked before it is fetched.
 *     A hop on the same origin gets the server's own check; a hop to another
 *     origin must pass the full guard even with ALLOW_PRIVATE_OPENAPI (that
 *     permits the server you configured, not wherever it points), and loses
 *     every header but content negotiation, credentials included.
 *   - BOUNDED SPECS. A spec over 4 MiB, one that expands past a million
 *     values once its $refs are resolved, or nests past 128 levels fails
 *     the compile with a readable error (lib/tools/openapi/parse.ts).
 *   - BOUNDED RESULTS. At most 8 MiB of a response is read, and a result
 *     larger than MAX_RESULT_CHARS is cut and says so; a network failure
 *     comes back as `{ error }`, never a throw.
 *
 * Spec files only, never URLs: a spec fetched at compile time would be a
 * second outbound surface, and a spec that changes under a running agent
 * changes its tools. Save the spec beside the YAML and review it like code.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { MAX_RESULT_CHARS as TOOL_RESULT_CHARS, capResult } from './tool.ts';
import type { Tool, ToolContext } from './tool.ts';
import { callOperation, hostProblem } from './openapi/call.ts';
import type { OpenApiCredential } from './openapi/call.ts';
import { MAX_SPEC_BYTES, operationNamed, parseOpenApiSpec } from './openapi/parse.ts';
import type { OpenApiOperation } from './openapi/parse.ts';
import { ToolCredentialError } from './auth.ts';
import { readCredentialEnv } from './credentialEnv.ts';
import { oauthTokenSource, tokenTransportProblem } from './oauthTools.ts';
import type { OAuth2AuthConfig, OAuthTokenSource } from './oauthTools.ts';

export { credentialEnvProblem } from './credentialEnv.ts';

export { namesTool, toSnake } from './openapi/parse.ts';

export interface OpenApiAuthConfig {
  /** Environment variable holding a bearer token (`Authorization: Bearer …`). */
  bearer_env?: string;
  /** An API key from an environment variable, sent in a header or the query. */
  api_key?: { env: string; in: 'header' | 'query'; name: string };
  /** An OAuth access token per call: the run's user's (authorization_code) or the server's (client_credentials). ADR 0112. */
  oauth2?: OAuth2AuthConfig;
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

/**
 * Marks a tool built here, so require_approval may name it by its
 * operationId (lib/compile.ts). Its value is the operationId.
 */
export const OPENAPI_TOOL = Symbol.for('melchizedek.openapiTool');

/**
 * The credential an `auth` names, read from the environment once, at
 * compile. Throws (failing the compile) on a variable the allowlist refuses
 * or one that is not set; the message names the variable, never its value.
 * An `oauth2` block is not read here: its token is fetched per call
 * (oauthTokenSource, lib/tools/oauthTools.ts).
 */
function credentialFor(auth: OpenApiAuthConfig | undefined, spec: string): OpenApiCredential | undefined {
  if (!auth) return undefined;
  const read = (env: string): string => readCredentialEnv(env, `openapi ${spec}`);
  if (auth.bearer_env) return { kind: 'bearer', token: read(auth.bearer_env) };
  if (auth.api_key) return { kind: 'api_key', in: auth.api_key.in, name: auth.api_key.name, value: read(auth.api_key.env) };
  return undefined;
}

/**
 * Cut an API result to MAX_RESULT_CHARS, saying so. Kept for consumers of
 * this module; the tools cut with capResult (lib/tools/tool.ts).
 * @deprecated Use capResult from lib/tools/tool.ts.
 */
export function boundResult(result: unknown): unknown {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  if (text.length <= MAX_RESULT_CHARS) return result;
  return { truncated: true, text: `${text.slice(0, MAX_RESULT_CHARS)}… [cut at ${MAX_RESULT_CHARS} characters]` };
}

/**
 * A spec's text, read through one open file: at most MAX_SPEC_BYTES are read,
 * so the size bound holds for the bytes actually parsed, with no separate
 * check that the file could change after (CodeQL js/file-system-race).
 */
function readSpec(specPath: string, source: string): string {
  let fd: number;
  try {
    fd = openSync(specPath, 'r');
  } catch {
    throw new Error(`openapi: spec not found: ${source}`);
  }
  try {
    const buf = Buffer.alloc(MAX_SPEC_BYTES + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = readSync(fd, buf, n, buf.length - n, null);
    if (n > MAX_SPEC_BYTES) throw new Error(`openapi ${source}: the spec is larger than ${MAX_SPEC_BYTES} bytes`);
    return buf.subarray(0, n).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/**
 * An own Tool that calls one operation (lib/tools/openapi/call.ts), its
 * result cut to MAX_RESULT_CHARS. With `oauth`, each call fetches its token
 * first; a token that cannot be had is answered as `{ error }` naming the
 * provider and what to do, never a value (and, for a user who has not
 * granted it, the run's consent step has already asked).
 */
function operationTool(op: OpenApiOperation, credential: OpenApiCredential | undefined, oauth?: OAuthTokenSource): Tool {
  const tool: Tool = {
    name: op.name,
    declaration: () => op.declaration,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
      let sent = credential;
      if (oauth) {
        try {
          sent = { kind: 'bearer', token: await oauth(ctx, op.baseUrl) };
        } catch (error) {
          return { error: error instanceof ToolCredentialError ? error.message : 'The authorization for this API could not be obtained.' };
        }
      }
      return capResult(await callOperation(op, args ?? {}, { credential: sent, signal: ctx?.signal }));
    },
  };
  Object.defineProperty(tool, OPENAPI_TOOL, { value: op.operationId });
  return tool;
}

/**
 * The own Tools one `openapi:` entry gives an agent.
 * Throws (failing the compile) on a missing spec, an unset auth variable,
 * an operation the spec does not have, or a server the guard refuses.
 */
export async function buildOpenApiOwnTools(entry: OpenApiConfig, baseDir: string = process.cwd()): Promise<Tool[]> {
  const specPath = resolve(baseDir, entry.spec);
  const ext = extname(specPath).toLowerCase();
  const text = readSpec(specPath, entry.spec);
  if (!['.yaml', '.yml', '.json'].includes(ext)) throw new Error(`openapi ${entry.spec}: a spec is .yaml, .yml or .json`);
  const credential = credentialFor(entry.auth, entry.spec);
  const all = parseOpenApiSpec(text, ext === '.json' ? 'json' : 'yaml', {
    source: entry.spec,
    ...(entry.prefix ? { prefix: entry.prefix } : {}),
  });

  let picked: OpenApiOperation[];
  if (entry.operations?.length) {
    const unknown = entry.operations.filter((op) => !all.some((o) => operationNamed(op, o, entry.prefix)));
    if (unknown.length) {
      throw new Error(`openapi ${entry.spec}: no operation ${unknown.map((u) => `'${u}'`).join(', ')} (the spec has ${all.map((o) => o.operationId).join(', ')})`);
    }
    picked = all.filter((o) => entry.operations!.some((op) => operationNamed(op, o, entry.prefix)));
  } else {
    picked = all.filter((o) => o.method === 'get');
  }
  const chosen = entry.base_url ? picked.map((o) => ({ ...o, baseUrl: entry.base_url! })) : picked;

  for (const baseUrl of new Set(chosen.map((o) => o.baseUrl))) {
    if (!baseUrl) throw new Error(`openapi ${entry.spec}: the spec names no server; set base_url`);
    const problem = await hostProblem(baseUrl, false);
    if (problem) throw new Error(`openapi ${entry.spec}: ${problem}`);
  }
  let oauth: OAuthTokenSource | undefined;
  if (entry.auth?.oauth2 && chosen.length) {
    // Every server the token goes to takes it over https (or loopback http).
    for (const server of new Set(chosen.map((o) => o.baseUrl))) {
      const problem = tokenTransportProblem(server);
      if (problem) throw new Error(`openapi ${entry.spec}: ${problem}`);
    }
    oauth = oauthTokenSource(entry.auth.oauth2, `openapi ${entry.spec}`, [...new Set(chosen.map((o) => o.baseUrl))], { allowPrivate: process.env.ALLOW_PRIVATE_OPENAPI === 'true' });
  }
  return chosen.map((o) => operationTool(o, credential, oauth));
}

/**
 * The tools one `openapi:` entry gives an agent: buildOpenApiOwnTools' own
 * Tools, each marked so require_approval can name it by its operationId.
 */
export async function buildOpenApiTools(entry: OpenApiConfig, baseDir: string = process.cwd()): Promise<Tool[]> {
  return buildOpenApiOwnTools(entry, baseDir);
}

/** The operationId of a tool built from an `openapi:` entry, or undefined. */
export function openApiOperationId(tool: unknown): string | undefined {
  if (!tool || typeof tool !== 'object') return undefined;
  const id = (tool as Record<symbol, unknown>)[OPENAPI_TOOL];
  return typeof id === 'string' ? id : undefined;
}

/** True for a tool built from an `openapi:` entry. */
export function isOpenApiTool(tool: unknown): boolean {
  return openApiOperationId(tool) !== undefined;
}
