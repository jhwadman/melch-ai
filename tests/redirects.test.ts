/**
 * tests/redirects.test.ts — redirects followed one hop at a time under a
 * policy (lib/net/redirects.ts), and the OpenAPI tools' policy
 * (lib/tools/openapi/call.ts). Offline: a scripted fetch and a stub resolver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_REDIRECTS, fetchWithRedirectPolicy } from '../lib/net/redirects.ts';
import { setHostResolver } from '../lib/net/addressGuard.ts';
import { OPENAPI_REDIRECTS } from '../lib/tools/openapi/call.ts';
import type { RedirectPolicy } from '../lib/net/redirects.ts';

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown; redirect?: string };

/** A fetch that answers from a route table and records every request. */
function scripted(routes: Record<string, () => Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    seen.push({ url, method: init?.method ?? 'GET', headers, body: init?.body, redirect: init?.redirect });
    const route = routes[url];
    return route ? route() : new Response('missing', { status: 404 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}
const to = (location: string, status = 302) => () => new Response(null, { status, headers: { Location: location } });
const ok = (body = 'ok') => () => new Response(body, { status: 200 });
const allowAll: RedirectPolicy = { hopProblem: async () => null };

test('every request is manual; a same-origin hop keeps its headers, a cross-origin hop keeps only content negotiation', async () => {
  const { seen, fetchImpl } = scripted({
    'https://api.example.com/a': to('/b'),
    'https://api.example.com/b': to('https://cdn.example.net/c'),
    'https://cdn.example.net/c': ok('done'),
  });
  const res = await fetchWithRedirectPolicy(
    'https://api.example.com/a',
    { headers: { Authorization: 'Bearer t', 'X-Api-Key': 'k', Accept: 'application/json', Cookie: 'c=1' } },
    allowAll,
    fetchImpl,
  );
  assert.equal(await res.text(), 'done');
  assert.deepEqual(seen.map((s) => s.url), ['https://api.example.com/a', 'https://api.example.com/b', 'https://cdn.example.net/c']);
  assert.ok(seen.every((s) => s.redirect === 'manual'));
  assert.equal(seen[1]!.headers['x-api-key'], 'k', 'same origin: credentials stay');
  assert.deepEqual(seen[2]!.headers, { accept: 'application/json' }, 'another origin: no credentials, no cookie');
});

test('the policy sees each hop, and a refusal is an error naming it', async () => {
  const asked: Array<[string, boolean]> = [];
  const policy: RedirectPolicy = {
    async hopProblem(url, crossOrigin) {
      asked.push([url.href, crossOrigin]);
      return url.hostname === '169.254.169.254' ? 'link-local address' : null;
    },
  };
  const { seen, fetchImpl } = scripted({ 'https://api.example.com/a': to('http://169.254.169.254/latest/meta-data/') });
  await assert.rejects(fetchWithRedirectPolicy('https://api.example.com/a', {}, policy, fetchImpl), /redirect refused: link-local address/);
  assert.deepEqual(asked, [['http://169.254.169.254/latest/meta-data/', true]]);
  assert.equal(seen.length, 1, 'the refused hop is never fetched');
});

test('303, and 302 after a POST, continue as a GET without a body; 307 keeps both', async () => {
  const { seen, fetchImpl } = scripted({
    'https://a.example/p': to('https://a.example/q', 303),
    'https://a.example/q': ok(),
    'https://a.example/r': to('https://a.example/s', 307),
    'https://a.example/s': ok(),
  });
  await fetchWithRedirectPolicy('https://a.example/p', { method: 'POST', body: '{"x":1}', headers: { 'Content-Type': 'application/json' } }, allowAll, fetchImpl);
  assert.deepEqual([seen[1]!.method, seen[1]!.body, seen[1]!.headers['content-type']], ['GET', undefined, undefined]);
  await fetchWithRedirectPolicy('https://a.example/r', { method: 'POST', body: '{"x":1}' }, allowAll, fetchImpl);
  assert.deepEqual([seen[3]!.method, seen[3]!.body], ['POST', '{"x":1}']);
});

test('a chain longer than MAX_REDIRECTS is an error', async () => {
  const routes: Record<string, () => Response> = {};
  for (let i = 0; i <= MAX_REDIRECTS + 1; i++) routes[`https://a.example/${i}`] = to(`/${i + 1}`);
  const { fetchImpl } = scripted(routes);
  await assert.rejects(fetchWithRedirectPolicy('https://a.example/0', {}, allowAll, fetchImpl), /more than 5 redirects/);
});

// ── The OpenAPI tools' policy (lib/tools/openapi/call.ts) ──────────────────

/** Names that resolve as the test says: public, private, link-local. */
const resolver = async (host: string) => {
  const table: Record<string, string> = {
    'api.example.com': '93.184.216.34',
    'cdn.example.net': '93.184.216.35',
    'rebind.example.org': '10.0.0.7',
    'meta.example.org': '169.254.169.254',
    'v6meta.example.org': 'fe80::1',
  };
  if (!table[host]) throw new Error('ENOTFOUND');
  return [{ address: table[host]! }];
};

test('OPENAPI_REDIRECTS: a hop to a private or link-local address is refused, as a literal and through DNS, and never fetched', async () => {
  setHostResolver(resolver);
  const env = process.env.ALLOW_PRIVATE_OPENAPI;
  try {
    for (const [target, reason] of [
      ['http://169.254.169.254/latest/meta-data/', /refusing 169\.254\.169\.254: link-local\/metadata IPv4/],
      ['http://[::ffff:169.254.169.254]/', /refusing \[::ffff:a9fe:a9fe\]: link-local\/metadata IPv4/],
      ['http://10.1.2.3/', /refusing 10\.1\.2\.3: private IPv4/],
      ['https://rebind.example.org/x', /refusing rebind\.example\.org: resolves to a private IPv4 address/],
      ['https://meta.example.org/x', /refusing meta\.example\.org: resolves to a link-local\/metadata IPv4 address/],
      ['https://v6meta.example.org/x', /resolves to a link-local IPv6 address/],
      ['https://nowhere.example.org/x', /hostname does not resolve/],
      ['file:///etc/passwd', /file: is not http\(s\)/],
    ] as const) {
      for (const allowPrivate of [undefined, 'true']) {
        if (allowPrivate) process.env.ALLOW_PRIVATE_OPENAPI = allowPrivate;
        else delete process.env.ALLOW_PRIVATE_OPENAPI;
        const { seen, fetchImpl } = scripted({ 'https://api.example.com/a': to(target) });
        await assert.rejects(
          fetchWithRedirectPolicy('https://api.example.com/a', { headers: { Authorization: 'Bearer t' } }, OPENAPI_REDIRECTS, fetchImpl),
          reason,
          `${target} (ALLOW_PRIVATE_OPENAPI=${allowPrivate})`,
        );
        assert.equal(seen.length, 1, `${target}: the refused hop is never fetched`);
      }
    }
  } finally {
    setHostResolver();
    if (env === undefined) delete process.env.ALLOW_PRIVATE_OPENAPI;
    else process.env.ALLOW_PRIVATE_OPENAPI = env;
  }
});

test('OPENAPI_REDIRECTS: a hop to a public host is followed without the credential; a same-origin hop keeps it', async () => {
  setHostResolver(resolver);
  try {
    const { seen, fetchImpl } = scripted({
      'https://api.example.com/a': to('/b'),
      'https://api.example.com/b': to('https://cdn.example.net/c'),
      'https://cdn.example.net/c': ok('done'),
    });
    const res = await fetchWithRedirectPolicy('https://api.example.com/a', { headers: { Authorization: 'Bearer t', 'X-Api-Key': 'k' } }, OPENAPI_REDIRECTS, fetchImpl);
    assert.equal(await res.text(), 'done');
    assert.equal(seen[1]!.headers.authorization, 'Bearer t');
    assert.deepEqual(seen[2]!.headers, {}, 'no credential crosses origins');
  } finally {
    setHostResolver();
  }
});
