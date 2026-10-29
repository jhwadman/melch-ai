/**
 * tests/envSyndicate.test.ts — a syndicate handed to the server as
 * MELCHIZEDEK_AGENT_YAML (lib/envSyndicate.ts): decoded into a private
 * agents directory and loaded once, so a bad one stops the boot. The last
 * two tests run the real server binary with it. Offline: no database, no
 * model call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

import { envSyndicate } from '../lib/envSyndicate.ts';

const SYNDICATE = {
  syndicate_name: 'From the environment',
  memory_system: 'session-only',
  orchestrator: { name: 'Lead', model: 'gemini-3.5-flash', instruction: 'Answer.' },
  subagents: [],
};
const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : stringify(value)).toString('base64');
const scratch = () => mkdtempSync(join(tmpdir(), 'melch-envsyn-'));

test('unset, there is no syndicate from the environment', () => {
  assert.equal(envSyndicate({}, scratch()), undefined);
  assert.equal(envSyndicate({ MELCHIZEDEK_AGENT_YAML: '  ' }, scratch()), undefined);
});

test('the file lands in a private directory as agent.yaml and loads', () => {
  const got = envSyndicate({ MELCHIZEDEK_AGENT_YAML: b64(SYNDICATE) }, scratch());
  assert.ok(got);
  assert.equal(got.id, 'agent');
  assert.equal(got.file, 'agent.yaml');
  assert.equal(statSync(got.agentsDir).mode & 0o777, 0o700);
  // One descriptor for the mode and the content, so both describe the same file.
  const fd = openSync(join(got.agentsDir, got.file), 'r');
  try {
    assert.equal(fstatSync(fd).mode & 0o777, 0o600);
    assert.equal(readFileSync(fd, 'utf8'), stringify(SYNDICATE));
  } finally {
    closeSync(fd);
  }
});

test('MELCHIZEDEK_AGENT_ID names it; wrapped and URL-safe base64 both decode', () => {
  const wrapped = b64(SYNDICATE).replace(/(.{60})/g, '$1\n');
  const got = envSyndicate({ MELCHIZEDEK_AGENT_YAML: wrapped, MELCHIZEDEK_AGENT_ID: 'support_desk' }, scratch());
  assert.equal(got?.file, 'support_desk.yaml');
  const urlSafe = Buffer.from(stringify(SYNDICATE)).toString('base64url');
  assert.ok(envSyndicate({ MELCHIZEDEK_AGENT_YAML: urlSafe }, scratch()));
});

test('an id that could name a file path or a registry row is refused', () => {
  for (const id of ['../x', 'registry:x', 'a.yaml', 'a b']) {
    assert.throws(() => envSyndicate({ MELCHIZEDEK_AGENT_YAML: b64(SYNDICATE), MELCHIZEDEK_AGENT_ID: id }, scratch()), /MELCHIZEDEK_AGENT_ID/);
  }
});

test('the YAML itself, not encoded, is refused with the fix', () => {
  assert.throws(() => envSyndicate({ MELCHIZEDEK_AGENT_YAML: stringify(SYNDICATE) }, scratch()), /base64 < agent\.yaml/);
});

test('an agents directory beside it is refused: the syndicate comes from one place', () => {
  assert.throws(
    () => envSyndicate({ MELCHIZEDEK_AGENT_YAML: b64(SYNDICATE), MELCHIZEDEK_AGENTS_DIR: '/srv/agents' }, scratch()),
    /MELCHIZEDEK_AGENTS_DIR/,
  );
});

test('a definition that does not validate stops here, with the loader\'s reason', () => {
  const bad = { ...SYNDICATE, orchestrator: { name: 'Lead' } };
  assert.throws(() => envSyndicate({ MELCHIZEDEK_AGENT_YAML: b64(bad) }, scratch()), /MELCHIZEDEK_AGENT_YAML does not load/);
});

test('a nested yaml_reference must travel in bundled_references', () => {
  const nested = { ...SYNDICATE, subagents: [{ name: 'Desk', description: 'The desk.', yaml_reference: 'desk.yaml' }] };
  assert.throws(() => envSyndicate({ MELCHIZEDEK_AGENT_YAML: b64(nested) }, scratch()), /desk\.yaml/);
  const bundled = { ...nested, bundled_references: { 'desk.yaml': SYNDICATE } };
  assert.ok(envSyndicate({ MELCHIZEDEK_AGENT_YAML: b64(bundled) }, scratch()));
});

// ── The binary ───────────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const SECRET = 'env-syndicate-test-secret-0123456789abcdef'; // gitleaks:allow (test fixture)

/** The bin with a minimal environment, never the runner's (see tests/serverShutdown.test.ts). */
function serve(args: string[], extra: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MELCHIZEDEK_CHATGPT_SIGNIN_FILE: process.env.MELCHIZEDEK_CHATGPT_SIGNIN_FILE,
    MELCHIZEDEK_DOTENV: 'off',
    OTEL_CONSOLE_SPANS: 'false',
    ...extra,
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', 'scripts/a2a_server.ts', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
}

test('the server serves the syndicate from the environment as its default and at /agent/', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${SECRET}` };
  const run = serve([], { PORT: String(port), A2A_SERVER_SECRET: SECRET, MELCHIZEDEK_AGENT_YAML: b64(SYNDICATE) });
  try {
    for (let i = 0; i < 300; i++) {
      if (await fetch(`${base}/readyz`).then((r) => r.status === 200, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const card = await fetch(`${base}/.well-known/agent-card.json`, { headers: auth });
    assert.equal(card.status, 200, `the server started:\n${run.output()}`);
    assert.equal(((await card.json()) as any).name, 'Lead');
    const agent = await fetch(`${base}/agent/.well-known/agent-card.json`, { headers: auth });
    assert.equal(agent.status, 200);
    assert.match(((await agent.json()) as any).url, /\/agent\/a2a\/jsonrpc$/);
    // The shipped syndicates are not reachable: the agents directory holds this one file.
    assert.equal((await fetch(`${base}/council/.well-known/agent-card.json`, { headers: auth })).status, 404);
  } finally {
    run.child.kill('SIGKILL');
    await run.exited;
  }
});

test('the server refuses a syndicate argument that is not the one in the environment', async () => {
  const run = serve(['council.yaml'], { PORT: String(await freePort()), MELCHIZEDEK_AGENT_YAML: b64(SYNDICATE) });
  assert.equal(await run.exited, 1);
  assert.match(run.output(), /MELCHIZEDEK_AGENT_YAML is set, so this server serves 'agent'/);
});
