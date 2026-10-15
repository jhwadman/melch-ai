/**
 * tests/mcpStdio.test.ts — local MCP servers over stdio (ADR 0132): the
 * operator's allowlist, the child's environment, one process reused across
 * compiles, the entry's tool list, a turn that calls the tool, and the
 * schema's rules for a command entry. Offline: a fixture server and a
 * scripted model.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { closeMcpConnections, loadStdioMcpTools, stdioCommandAllowed } from '../lib/tools/mcpToolFactory.ts';
import { setLogLevel } from '../lib/runtime/logging.ts';
import { setCredentialSource } from '../lib/models/credentialSource.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall } from './helpers/scriptedModel.ts';

setLogLevel('error');
const here = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(here, 'fixtures/mcp-stdio/server.mjs');
const NODE = process.execPath;

const spec = (extra: Record<string, unknown> = {}) => ({ command: NODE, args: [SERVER], ...extra });
const ctx = {} as never;
async function whoami(tools: Awaited<ReturnType<typeof loadStdioMcpTools>>): Promise<Record<string, unknown>> {
  const t = tools.find((x) => x.name === 'stdio_whoami');
  assert.ok(t, 'the server lists stdio_whoami');
  return JSON.parse(String(await t.execute({}, ctx)));
}

after(async () => {
  await closeMcpConnections();
});

test('a command runs only when the operator lists it in MELCHIZEDEK_STDIO_MCP', async () => {
  delete process.env.MELCHIZEDEK_STDIO_MCP;
  assert.equal(stdioCommandAllowed(NODE), false);
  await assert.rejects(loadStdioMcpTools('fixture', spec()), /not allowed to run.*MELCHIZEDEK_STDIO_MCP/);
  assert.equal(stdioCommandAllowed(NODE, { MELCHIZEDEK_STDIO_MCP: `npx, ${NODE}` }), true);
  assert.equal(stdioCommandAllowed('node', { MELCHIZEDEK_STDIO_MCP: '/usr/bin/node' }), false, 'exact values only');
});

test('the child sees pass_env and env, and none of the engine\'s other variables', async () => {
  process.env.MELCHIZEDEK_STDIO_MCP = NODE;
  process.env.STDIO_TEST_PASSED = 'from-engine';
  process.env.STDIO_TEST_HIDDEN = 'must-not-leak';
  const me = await whoami(await loadStdioMcpTools('fixture', spec({ pass_env: ['STDIO_TEST_PASSED'], env: { STDIO_TEST_MODE: 'literal' }, cwd: here })));
  assert.equal(me.passed, 'from-engine');
  assert.equal(me.literal, 'literal');
  assert.equal(me.hidden, null, 'an unnamed variable stays in the engine');
  assert.equal(me.cwd, here);
});

test('pass_env reads through the credential source: a key only the source holds reaches the child', async () => {
  process.env.MELCHIZEDEK_STDIO_MCP = NODE;
  delete process.env.STDIO_TEST_PASSED;
  setCredentialSource((name) => (name === 'STDIO_TEST_PASSED' ? 'from-keychain' : undefined));
  try {
    const me = await whoami(await loadStdioMcpTools('fixture', spec({ pass_env: ['STDIO_TEST_PASSED'], env: { STDIO_TEST_MODE: 'source' } })));
    assert.equal(me.passed, 'from-keychain');
    assert.equal(process.env.STDIO_TEST_PASSED, undefined, 'the engine\'s own environment never held it');
  } finally {
    setCredentialSource(undefined);
  }
});

test('an unset pass_env variable fails the compile, naming it and no value', async () => {
  process.env.MELCHIZEDEK_STDIO_MCP = NODE;
  delete process.env.STDIO_TEST_ABSENT;
  await assert.rejects(loadStdioMcpTools('fixture', spec({ pass_env: ['STDIO_TEST_ABSENT'] })), /pass_env names STDIO_TEST_ABSENT, which is not set/);
});

test('one process per spec, reused by every compile; a different spec gets its own', async () => {
  process.env.MELCHIZEDEK_STDIO_MCP = NODE;
  const a = await whoami(await loadStdioMcpTools('fixture', spec({ env: { STDIO_TEST_MODE: 'reuse' } })));
  const b = await whoami(await loadStdioMcpTools('fixture', spec({ env: { STDIO_TEST_MODE: 'reuse' } })));
  const c = await whoami(await loadStdioMcpTools('fixture', spec({ env: { STDIO_TEST_MODE: 'other' } })));
  assert.equal(a.pid, b.pid, 'the same spec reuses the running server');
  assert.notEqual(a.pid, c.pid);
});

test('a server that cannot start yields no tools rather than failing the turn', async () => {
  process.env.MELCHIZEDEK_STDIO_MCP = NODE;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await loadStdioMcpTools('broken', spec({ args: [resolve(here, 'fixtures/mcp-stdio/does-not-exist.mjs')] })), []);
  } finally {
    console.warn = warn;
  }
});

test('a failing server\'s stderr reaches the warning with pass_env values cut out', async () => {
  process.env.MELCHIZEDEK_STDIO_MCP = NODE;
  process.env.STDIO_TEST_PASSED = 'tok-should-not-be-logged';
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    assert.deepEqual(await loadStdioMcpTools('failing', spec({ args: [resolve(here, 'fixtures/mcp-stdio/fails.mjs')], pass_env: ['STDIO_TEST_PASSED'] })), []);
  } finally {
    console.warn = warn;
  }
  const logged = lines.join('\n');
  assert.match(logged, /boot failed with token \[redacted\]/);
  assert.ok(!logged.includes('tok-should-not-be-logged'));
});

test('a turn calls a stdio tool through mcp_servers, and only the listed tools reach the model', async () => {
  process.env.MELCHIZEDEK_STDIO_MCP = NODE;
  const raw = {
    syndicate_name: 'StdioDesk',
    orchestrator: {
      name: 'Desk', model: 'scripted/stdio', instruction: 'Use the tool.',
      mcp_servers: [{ name: 'fixture', command: NODE, args: [SERVER], tools: ['stdio_whoami'] }],
    },
    subagents: [],
  };
  validateSyndicateConfig(raw); // a command entry is valid
  const desk = new ScriptedModel('scripted/stdio', (req, n) => {
    if (n === 1) return toolCall('stdio_whoami', { note: 'hello' });
    return answer(`Got ${JSON.parse(String(lastToolResult(req)?.result)).note}.`);
  });
  const r = await runSyndicateTurn({
    config: raw as unknown as SyndicateYamlConfig, parts: [{ text: 'who?' }], appName: 'stdio', userId: 'u', sessionId: 's',
    sessionService: new InProcessSessionService(), compile: { resolveModel: shimResolver({ stdio: desk }), log: () => {} }, trace: false,
  });
  assert.equal(r.status, 'completed', r.error?.message);
  assert.equal(r.text, 'Got hello.');
  const offered = desk.requests[0]!.tools?.map((t) => t.name) ?? [];
  assert.ok(offered.includes('stdio_whoami'));
  assert.ok(!offered.includes('stdio_unlisted'), 'a tool the entry does not name is not exposed');
});

test('the schema: url or command; stdio keys only with command; no credential in env', () => {
  const agent = (entry: Record<string, unknown>) => ({ syndicate_name: 'S', orchestrator: { name: 'A', model: 'gemini-x', instruction: 'x', mcp_servers: [{ name: 'm', tools: ['t'], ...entry }] }, subagents: [] });
  const problems = (entry: Record<string, unknown>): string => {
    try {
      validateSyndicateConfig(agent(entry));
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  assert.equal(problems({ command: 'npx', args: ['-y', 'server'], pass_env: ['GITHUB_TOKEN'], env: { LOG_LEVEL: 'info' }, cwd: 'servers' }), '');
  assert.match(problems({}), /give url .* or command/);
  assert.match(problems({ url: 'https://example.com/mcp', command: 'npx' }), /cannot both be given/);
  assert.match(problems({ command: 'npx', transport: 'sse' }), /takes no transport/);
  assert.match(problems({ url: 'https://example.com/mcp', args: ['x'] }), /args configures a command entry/);
  assert.match(problems({ command: 'npx', env: { GITHUB_TOKEN: 'ghp_x' } }), /looks like a credential/);
  assert.match(problems({ command: 'npx', pass_env: ['not a name'] }), /environment variable name/);
});
