/**
 * tests/publicPosture.test.ts — a server on a public URL states its security
 * posture (ADR 0039): A2A_AUTH, A2A_SERVED_AGENTS and A2A_TRUST_PROXY are
 * required, the refusal names each one missing, and `*` is an explicit
 * "serve every agent". Runs the real bin on a minimal environment
 * (MELCHIZEDEK_DOTENV=off: this clone's .env is never read).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Start the bin; resolve with its exit code and output, or 'listening' once /healthz answers. */
async function run(extra: Record<string, string>): Promise<{ result: number | 'listening'; output: string }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MELCHIZEDEK_DOTENV: 'off',
    OTEL_CONSOLE_SPANS: 'false',
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    A2A_SERVER_SECRET: SECRET,
    ...extra,
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', 'scripts/a2a_server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
  const listening = (async () => {
    for (let i = 0; i < 150; i++) {
      if (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)) return 'listening' as const;
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'timeout' as const;
  })();
  const result = await Promise.race([exited, listening]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  if (result === 'timeout') throw new Error(`the server neither started nor exited:\n${output}`);
  return { result, output };
}

test('a public server with no stated posture refuses to start, naming all three settings', async () => {
  const { result, output } = await run({});
  assert.equal(result, 1);
  assert.match(output, /PUBLIC_URL is set, so this server must state its security posture/);
  for (const name of ['A2A_AUTH', 'A2A_SERVED_AGENTS', 'A2A_TRUST_PROXY']) assert.match(output, new RegExp(`- ${name}:`), name);
});

test('a public server names only what is still missing', async () => {
  const { result, output } = await run({ A2A_AUTH: 'secret', A2A_SERVED_AGENTS: '*' });
  assert.equal(result, 1);
  assert.match(output, /- A2A_TRUST_PROXY:/);
  assert.doesNotMatch(output, /- A2A_AUTH:|- A2A_SERVED_AGENTS:/);
});

test('a public server that states its posture starts; * is an explicit "every agent"', async () => {
  const { result, output } = await run({ A2A_AUTH: 'secret', A2A_SERVED_AGENTS: '*', A2A_TRUST_PROXY: '1', A2A_SHUTDOWN_DELAY_MS: '0' });
  assert.equal(result, 'listening', output);
});

test('without PUBLIC_URL nothing is required (a local server keeps its defaults)', async () => {
  const { result, output } = await run({ PUBLIC_URL: '', A2A_SHUTDOWN_DELAY_MS: '0' });
  assert.equal(result, 'listening', output);
});
