/**
 * tests/mcpRedirects.test.ts — the MCP SSE client follows redirects only where
 * the SSRF guard allows (ADR 0036's rule, applied to MCP). Offline: a local
 * HTTP server stands in for the MCP host.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { createMcpTools, mcpFetch } from '../lib/tools/mcpToolFactory.ts';

const seen: Array<{ url: string; auth?: string }> = [];
let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    if (req.url === '/moved') {
      res.writeHead(302, { Location: '/here' });
      return res.end();
    }
    if (req.url === '/sse' || req.url === '/escape') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.ALLOW_PRIVATE_MCP = 'true';
});
after(() => {
  server?.close();
  delete process.env.ALLOW_PRIVATE_MCP;
});

test('a same-origin redirect is followed with its headers', async () => {
  seen.length = 0;
  const res = await mcpFetch(`${base}/moved`, { headers: { Authorization: 'Bearer local-dev' } });
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(seen, [
    { url: '/moved', auth: 'Bearer local-dev' },
    { url: '/here', auth: 'Bearer local-dev' },
  ]);
});

test('a redirect to the metadata service is refused, even with ALLOW_PRIVATE_MCP', async () => {
  await assert.rejects(mcpFetch(`${base}/escape`), /redirect refused: refusing MCP redirect to 169\.254\.169\.254/);
});

test('createMcpTools gives up on a server that redirects off-host, without following it', async () => {
  const started = Date.now();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await createMcpTools(`${base}/sse`), []);
  } finally {
    console.warn = warn;
  }
  assert.ok(Date.now() - started < 3000, 'refused at once, not after a connect timeout to the metadata address');
});
