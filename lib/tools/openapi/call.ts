/**
 * lib/tools/openapi/call.ts — one call of one parsed OpenAPI operation: the
 * request built from the model's arguments, sent through the SSRF guard with
 * redirects re-checked hop by hop, and the answer read back as the model
 * sees it (ADR 0045, ADR 0067).
 *
 * WHY this file exists:
 *   Until WS3-4b an operation was called through ADK's RestApiTool, under a
 *   wrapper that patched globalThis.fetch to hold its redirects to the guard
 *   (ADR 0036). The engine owns the call now, so the guard is a parameter
 *   of the engine's own request, not a patch on a global, and nothing else
 *   in the process sees it. The request is built by RestApiTool's rules
 *   (ADK 2.2), so an API receives exactly the request it received before:
 *
 *   - Each argument goes where its parameter says. A path argument is
 *     URL-encoded whole (`a/b?c` → `a%2Fb%3Fc`) and `.` or `..` is refused,
 *     so the model never chooses the path, only a segment of it. A query
 *     argument that is undefined, null or '' is left out. A header and a
 *     cookie argument are sent as text. A body argument is the whole body
 *     (`body`, `array` or '') or one property of it.
 *   - The body is encoded by the request body's first media type: JSON
 *     (`application/json`, `*+json`), a form, multipart, octet-stream or
 *     plain text; without a request body in the spec, JSON.
 *   - The credential is applied after the arguments, so a spec parameter
 *     named `Authorization` cannot replace it: a bearer token as
 *     `Authorization: Bearer …`, an API key in its header or its query key.
 *   - A status of 400 or more is RestApiTool's error text with the body; a
 *     2xx or 3xx body is JSON when it parses, else `{ text }`.
 *
 * WHAT THE ENGINE ADDS:
 *   - THE GUARD before every call: the server must be http(s) and pass
 *     lib/net/addressGuard.ts with DNS (a name can re-resolve between calls);
 *     ALLOW_PRIVATE_OPENAPI=true permits private hosts for local development.
 *   - REDIRECTS one hop at a time (lib/net/redirects.ts): a hop on the same
 *     origin gets the server's own check; a hop to another origin must pass
 *     the full guard with no development exception and keeps only
 *     content-negotiation headers, so a credential never follows it.
 *   - A CREDENTIAL NEVER IN AN ANSWER: the credential's value, plain or
 *     URL-encoded, is replaced in every error text the model reads (a fetch
 *     error can quote the URL, which carries a query key; an API's error body
 *     can echo the key it refused).
 *   - A BOUNDED READ: at most MAX_RESPONSE_BYTES of a body are read; the
 *     result the model receives is then cut by the tool (capResult).
 *   - The turn's abort signal reaches the request.
 *
 * Nothing here logs. A failure is returned as `{ error }`, never thrown.
 */

import { blockedHostReason, checkHost } from '../../net/addressGuard.ts';
import { fetchWithRedirectPolicy } from '../../net/redirects.ts';
import type { RedirectPolicy } from '../../net/redirects.ts';
import type { OpenApiOperation, OpenApiParameter } from './parse.ts';

/** What a request may carry as its body. */
type RequestBody = NonNullable<RequestInit['body']>;

/** The most bytes of a response body read; the rest is never buffered. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** A credential read from the environment at compile time (lib/tools/openapiTools.ts). */
export type OpenApiCredential =
  | { kind: 'bearer'; token: string }
  | { kind: 'api_key'; in: 'header' | 'query'; name: string; value: string };

/** The fetch a call uses; globalThis.fetch unless a test passes its own. */
type Fetch = typeof globalThis.fetch;

// ── The guard ───────────────────────────────────────────────────────────────

const isHttp = (protocol: string) => protocol === 'http:' || protocol === 'https:';

/**
 * Why a server may not be called, or null. At compile time (`resolve`
 * false) only the literal rules apply: no connection is made, and a build
 * must not need DNS. Before each call the name is resolved too.
 */
export async function hostProblem(baseUrl: string, resolve: boolean, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `'${baseUrl}' is not a URL`;
  }
  if (!isHttp(url.protocol)) return `'${baseUrl}' must be http(s)`;
  if (env.ALLOW_PRIVATE_OPENAPI === 'true') return null;
  const reason = resolve ? await checkHost(url.hostname) : blockedHostReason(url.hostname);
  return reason ? `refusing ${url.hostname}: ${reason} (set ALLOW_PRIVATE_OPENAPI=true for local development)` : null;
}

/**
 * Where an API call may be redirected: the server's own rule on its origin,
 * the full guard (no development exception) anywhere else.
 */
export const OPENAPI_REDIRECTS: RedirectPolicy = {
  async hopProblem(url, crossOrigin) {
    if (!isHttp(url.protocol)) return `${url.protocol} is not http(s)`;
    if (!crossOrigin) return hostProblem(url.href, true);
    const reason = await checkHost(url.hostname);
    return reason ? `refusing ${url.hostname}: ${reason}` : null;
  },
};

// ── Building the request (RestApiTool's rules) ──────────────────────────────

/** A path argument, encoded whole; a dot segment is refused. */
function encodePathParamValue(name: string, value: string): string {
  if (value === '.' || value === '..') {
    throw new Error(`Invalid value for path parameter '${name}': relative path segments ('.' and '..') are not allowed.`);
  }
  return encodeURIComponent(value);
}

/** Sets an own property, so a parameter named `__proto__` stays a key. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

interface PreparedParams {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bodyData: Record<string, unknown>;
  cookies: Record<string, string>;
}

/** The URL, headers, cookies and body parts the arguments make. */
function prepareParams(baseUrl: string, path: string, parameters: readonly OpenApiParameter[], args: Record<string, unknown>): PreparedParams {
  const headers: Record<string, string> = {};
  const query = new URLSearchParams();
  const cookies: Record<string, string> = {};
  const pathParams: Record<string, string> = {};
  const bodyData: Record<string, unknown> = {};
  let body: unknown;
  const byName = new Map(parameters.map((p) => [p.name, p]));

  for (const [argName, value] of Object.entries(args)) {
    const param = byName.get(argName);
    if (!param) continue;
    const original = param.originalName;
    switch (param.location) {
      case 'path':
        put(pathParams, original, encodePathParamValue(original, String(value)));
        break;
      case 'query':
        if (value !== undefined && value !== null && value !== '') query.append(original, String(value));
        break;
      case 'header':
        put(headers, original, String(value));
        break;
      case 'cookie':
        put(cookies, original, String(value));
        break;
      case 'body':
        if (original === 'body' || original === 'array' || original === '') body = value;
        else put(bodyData, original, value);
        break;
      default:
        break;
    }
  }

  // Placeholders are `{name}`; a negated class, so the match is linear.
  const resolvedPath = path.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => (Object.hasOwn(pathParams, name) ? pathParams[name]! : placeholder));
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  let url = `${base}${resolvedPath}`;
  const parts = url.split('?');
  if (parts.length > 1) {
    for (const [key, value] of new URLSearchParams(parts[1])) query.append(key, value);
    url = parts[0]!;
  }
  const queryString = query.toString();
  if (queryString) url += `?${queryString}`;
  return { url, headers, body, bodyData, cookies };
}

const isRawBody = (value: unknown) =>
  typeof value === 'string' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob;

/** The request body, encoded by the request body's first media type. Sets Content-Type where RestApiTool did. */
function prepareBody(requestBody: unknown, body: unknown, bodyData: Record<string, unknown>, headers: Record<string, string>): RequestBody | undefined {
  const data = body !== undefined ? body : Object.keys(bodyData).length > 0 ? bodyData : undefined;
  if (requestBody && typeof requestBody === 'object' && 'content' in requestBody) {
    const content = (requestBody as { content?: unknown }).content;
    const mime = content && typeof content === 'object' ? Object.keys(content)[0] : undefined;
    if (mime && data !== undefined) {
      if (mime === 'application/json' || mime.endsWith('+json')) {
        headers['Content-Type'] = mime;
        return typeof data === 'string' ? data : JSON.stringify(data);
      }
      if (mime === 'application/x-www-form-urlencoded') return new URLSearchParams(data as Record<string, string>);
      if (mime === 'multipart/form-data') {
        const form = new FormData();
        if (typeof data === 'object' && data !== null) for (const [key, value] of Object.entries(data)) form.append(key, String(value));
        return form;
      }
      if (mime === 'application/octet-stream') {
        headers['Content-Type'] = mime;
        return (isRawBody(data) ? data : String(data)) as RequestBody;
      }
      if (mime === 'text/plain') {
        headers['Content-Type'] = mime;
        return String(data);
      }
    }
  } else if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    return typeof data === 'string' ? data : JSON.stringify(data);
  }
  return undefined;
}

/** The URL with the credential applied: a header set, or a query key appended. */
function applyCredential(url: string, headers: Record<string, string>, credential: OpenApiCredential | undefined): string {
  if (!credential) return url;
  if (credential.kind === 'bearer') {
    headers['Authorization'] = `Bearer ${credential.token}`;
    return url;
  }
  if (credential.in === 'header') {
    put(headers, credential.name, credential.value);
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}${credential.name}=${encodeURIComponent(credential.value)}`;
}

/** The request one call sends. Throws on a dot path segment. */
export interface OpenApiRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: RequestBody;
}

/**
 * The request for one operation and the model's arguments, as RestApiTool
 * built it: arguments placed by their parameters, the body encoded, the
 * credential applied last, cookies joined into one header unless a header
 * argument already named Cookie.
 */
export function buildRequest(
  op: Pick<OpenApiOperation, 'baseUrl' | 'path' | 'method' | 'parameters' | 'operation'>,
  args: Record<string, unknown>,
  credential?: OpenApiCredential,
): OpenApiRequest {
  const prepared = prepareParams(op.baseUrl, op.path, op.parameters, args);
  const body = prepareBody(op.operation.requestBody, prepared.body, prepared.bodyData, prepared.headers);
  const url = applyCredential(prepared.url, prepared.headers, credential);
  const hasCookie = Object.keys(prepared.headers).some((h) => h.toLowerCase() === 'cookie');
  if (Object.keys(prepared.cookies).length > 0 && !hasCookie) {
    prepared.headers['Cookie'] = Object.entries(prepared.cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
  }
  return { url, method: op.method.toUpperCase(), headers: prepared.headers, ...(body !== undefined ? { body } : {}) };
}

// ── Reading the answer ──────────────────────────────────────────────────────

/** A body as text, reading at most MAX_RESPONSE_BYTES and cancelling the rest. */
async function boundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = MAX_RESPONSE_BYTES - size;
      chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
      size += Math.min(value.byteLength, room);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** The credential's values as they could appear in a text: plain and URL-encoded. */
function secretsOf(credential: OpenApiCredential | undefined): string[] {
  if (!credential) return [];
  const value = credential.kind === 'bearer' ? credential.token : credential.value;
  return [...new Set([value, encodeURIComponent(value)])].filter((s) => s.length > 0);
}

/** `text` with every secret replaced. Plain substring search: no pattern built from the secret. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}

export interface CallOptions {
  credential?: OpenApiCredential;
  signal?: AbortSignal;
  /** Defaults to globalThis.fetch, read at call time. */
  fetchImpl?: Fetch;
  /** Defaults to OPENAPI_REDIRECTS. */
  redirects?: RedirectPolicy;
}

/**
 * Call one operation with the model's arguments. Checks the server, builds
 * the request, follows redirects under the policy, and returns what the
 * model reads: the parsed body, `{ text }`, or `{ error }`. Never throws.
 * The result is not cut here; the tool cuts it (capResult).
 */
export async function callOperation(
  op: Pick<OpenApiOperation, 'name' | 'baseUrl' | 'path' | 'method' | 'parameters' | 'operation' | 'authScheme'>,
  args: Record<string, unknown>,
  options: CallOptions = {},
): Promise<unknown> {
  const { credential } = options;
  const secrets = secretsOf(credential);
  const problem = await hostProblem(op.baseUrl, true);
  if (problem) return { error: `${op.name} was not called: ${problem}` };
  // RestApiTool asked the client for a credential here (an interrupt the
  // engine does not raise): the API is never called without the one its
  // spec requires.
  if (!credential && op.authScheme) {
    const type = typeof op.authScheme.type === 'string' ? ` (${op.authScheme.type})` : '';
    return { error: `${op.name} was not called: the API's spec requires a credential${type}, and this agent's openapi entry sets no auth` };
  }
  try {
    const request = buildRequest(op, args, credential);
    const response = await fetchWithRedirectPolicy(
      request.url,
      { method: request.method, headers: request.headers, body: request.body, signal: options.signal },
      options.redirects ?? OPENAPI_REDIRECTS,
      options.fetchImpl ?? globalThis.fetch,
    );
    const text = await boundedText(response);
    if (response.status >= 400) {
      return {
        error: redactSecrets(
          `Tool ${op.name} execution failed. Analyze this execution error and your inputs. Retry with adjustments if applicable. But make sure don't retry more than 3 times. Execution Error: ${text}`,
          secrets,
        ),
      };
    }
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  } catch (err) {
    return { error: redactSecrets(`${op.name} failed: ${err instanceof Error ? err.message : String(err)}`, secrets) };
  }
}
