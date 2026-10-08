/**
 * lib/net/redirects.ts — follow HTTP redirects one hop at a time, each hop
 * held to a policy, for code that makes its own requests.
 *
 * WHY: fetch follows redirects by default, so a guard that vets only the URL
 * a request starts at is bypassed by any server that answers 302: an allowed
 * public API with an open redirect can send a call to 169.254.169.254, and
 * fetch forwards every header but Authorization and Cookie (an API key in a
 * custom header crosses origins). web_extract follows redirects manually for
 * this reason, and so do the OpenAPI tools (lib/tools/openapi/call.ts) and
 * the MCP client (lib/tools/mcpToolFactory.ts), through this module.
 *
 * HOW: `fetchWithRedirectPolicy(input, init, policy, fetch)` sends every
 * request with `redirect: 'manual'`; each hop's URL goes to
 * `policy.hopProblem` before it is fetched, a hop to another origin keeps
 * only content-negotiation headers, and a chain longer than MAX_REDIRECTS is
 * an error. 303, and 301/302 after a POST, continue as a GET without a body,
 * as browsers do. The policy is a parameter of the call: nothing is
 * installed on globalThis.fetch (ADR 0067 retired the context-scoped
 * wrapper ADR 0036 put there while ADK made the OpenAPI requests).
 */

export const MAX_REDIRECTS = 5;

/** The headers a request keeps when a redirect moves it to another origin. */
const CROSS_ORIGIN_HEADERS = new Set(['accept', 'accept-language', 'content-language', 'content-type', 'user-agent']);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface RedirectPolicy {
  /** Why the request may not follow a redirect to `url`, or null to follow it. */
  hopProblem(url: URL, crossOrigin: boolean): Promise<string | null>;
}

type Fetch = typeof globalThis.fetch;

/**
 * `fetch(input, init)` with redirects followed manually under `policy`.
 * Throws when a hop is refused or the chain is too long.
 */
export async function fetchWithRedirectPolicy(
  input: string | URL | Request,
  init: RequestInit | undefined,
  policy: RedirectPolicy,
  fetchImpl: Fetch,
): Promise<Response> {
  let url = new URL(input instanceof Request ? input.url : String(input));
  let method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  let body = init?.body;

  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url, { ...init, method, headers, body, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${url.host}`);

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new Error(`redirect to an unparseable URL from ${url.host}`);
    }
    const crossOrigin = next.origin !== url.origin;
    const problem = await policy.hopProblem(next, crossOrigin);
    if (problem) throw new Error(`redirect refused: ${problem}`);

    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      if (method !== 'HEAD') method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    if (crossOrigin) {
      const kept = new Headers();
      headers.forEach((value, name) => {
        if (CROSS_ORIGIN_HEADERS.has(name.toLowerCase())) kept.set(name, value);
      });
      headers = kept;
    }
    url = next;
  }
}
