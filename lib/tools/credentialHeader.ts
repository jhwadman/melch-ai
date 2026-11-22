/**
 * lib/tools/credentialHeader.ts — which header a YAML may name to carry a
 * credential (an MCP server's `auth.header.name`, ADR 0163).
 *
 * WHY this file exists:
 *   A remote MCP server's credential may travel in a header the server
 *   chooses (`X-Api-Key`, `Authorization` with a scheme of its own). The
 *   YAML names that header, and a YAML may be registry-stored, so the name is
 *   input: a name carrying CR or LF could split the request, and a name the
 *   transport or the HTTP layer owns (Host, Content-Length, the MCP session
 *   headers) could redirect, smuggle or break it. A name is a bounded RFC
 *   9110 token and none of the headers below; anything else is refused when
 *   the syndicate loads, and again when the tools compile.
 *
 * A leaf: no imports, so the schema can use it.
 */

/** An RFC 9110 field name (a token), at most 64 characters. One bounded character class: it cannot backtrack. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

/** Headers the HTTP layer, a proxy or the MCP transport owns: never a credential's carrier. Lowercase. */
const OWNED = new Set([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'cookie',
  'set-cookie',
  'accept',
  'accept-encoding',
  'origin',
  'referer',
  'forwarded',
  'via',
  'x-real-ip',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

/** Prefixes of headers a proxy or the browser owns. Lowercase. */
const OWNED_PREFIXES = ['proxy-', 'sec-', 'x-forwarded-'];

/**
 * Why `name` may not carry a credential, or null. Allowed: any token that is
 * not one of the headers the HTTP layer, a proxy or the MCP transport owns
 * (`Authorization` is allowed, for a server whose scheme is not `Bearer`).
 */
export function credentialHeaderProblem(name: string): string | null {
  if (typeof name !== 'string' || !TOKEN.test(name)) {
    return 'a header name is 1 to 64 token characters (letters, digits and !#$%&\'*+.^_`|~-), with no space, colon, CR or LF';
  }
  const lower = name.toLowerCase();
  if (OWNED.has(lower) || OWNED_PREFIXES.some((p) => lower.startsWith(p))) {
    return `${name} is a header the HTTP layer or the MCP transport sets; name the header the server reads its credential from`;
  }
  return null;
}
