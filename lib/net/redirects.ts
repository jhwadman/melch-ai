/**
 * lib/net/redirects.ts — follow HTTP redirects one hop at a time, each hop
 * held to a policy, for code that calls `globalThis.fetch` itself.
 *
 * WHY: fetch follows redirects by default, so a guard that vets only the URL
 * a request starts at is bypassed by any server that answers 302: an allowed
 * public API with an open redirect can send a call to 169.254.169.254, and
 * fetch forwards every header but Authorization and Cookie (an API key in a
 * custom header crosses origins). web_extract follows redirects manually for
 * this reason; ADK's RestApiTool (the OpenAPI tools) calls globalThis.fetch
 * with no hook to pass a fetch of our own.
 *
 * HOW: `withRedirectGuard(policy, fn)` runs `fn` in an AsyncLocalStorage
 * context. A wrapper installed on globalThis.fetch (once, and again if
 * something replaced it) applies the guard only inside such a context and
 * calls the original fetch untouched everywhere else, so no other request in
 * the process changes behaviour and concurrent calls never see each other's
 * policy. Inside the context every request uses `redirect: 'manual'`; each
 * hop's URL goes to `policy.hopProblem` before it is fetched, a hop to
 * another origin keeps only content-negotiation headers, and a chain longer
 * than MAX_REDIRECTS is an error. 303, and 301/302 after a POST, continue as
 * a GET without a body, as browsers do.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

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

const guardContext = new AsyncLocalStorage<RedirectPolicy>();
const WRAPPED = Symbol.for('melchizedek.redirectGuardedFetch');

/** Wrap whatever globalThis.fetch is now, unless it is already our wrapper. */
function ensureInstalled(): void {
  const current = globalThis.fetch as Fetch & { [WRAPPED]?: true };
  if (current[WRAPPED]) return;
  const inner = current;
  const wrapped = ((input: string | URL | Request, init?: RequestInit) => {
    const policy = guardContext.getStore();
    return policy ? fetchWithRedirectPolicy(input, init, policy, inner) : inner(input, init);
  }) as Fetch & { [WRAPPED]?: true };
  wrapped[WRAPPED] = true;
  globalThis.fetch = wrapped;
}

/** Run `fn` with every globalThis.fetch it makes following redirects under `policy`. */
export function withRedirectGuard<T>(policy: RedirectPolicy, fn: () => Promise<T>): Promise<T> {
  ensureInstalled();
  return guardContext.run(policy, fn);
}
