/**
 * tests/serverShutdown.test.ts — the real server binary on SIGTERM: /readyz
 * fails at once while requests are still served for A2A_SHUTDOWN_DELAY_MS,
 * then the listener closes, running tasks drain, and the process exits 0.
 * Offline: no database, no model call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

test('SIGTERM fails readiness first, keeps serving through the delay, then exits cleanly', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // A minimal environment, never the runner's: MELCHIZEDEK_DOTENV=off keeps the
  // clone's own .env (real keys, a real database) unread, and nothing else
  // (a Redis URL, a provider key) is inherited.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MELCHIZEDEK_DOTENV: 'off',
    PORT: String(port),
    A2A_SHUTDOWN_DELAY_MS: '1500',
    A2A_SHUTDOWN_GRACE_MS: '3000',
    OTEL_CONSOLE_SPANS: 'false',
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', 'scripts/a2a_server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    for (let i = 0; i < 100; i++) {
      const ok = await fetch(`${base}/readyz`).then((r) => r.status === 200, () => false);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await fetch(`${base}/readyz`)).status, 200, `the server started:\n${output}`);

    const signalled = Date.now();
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await fetch(`${base}/readyz`)).status, 503, 'readiness fails at once');
    assert.equal((await fetch(`${base}/healthz`)).status, 200, 'requests are still served during the delay');

    assert.equal(await exited, 0, output);
    assert.ok(Date.now() - signalled >= 1400, 'the listener stayed open for the delay');
    assert.match(output, /\/readyz now fails; still serving for 1500 ms/);
    assert.match(output, /waiting up to 1500 ms for running ones/, 'the drain gets what is left of the grace budget');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
