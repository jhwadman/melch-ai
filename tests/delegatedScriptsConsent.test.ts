/**
 * tests/delegatedScriptsConsent.test.ts — the last two pauses a delegated
 * subagent could not raise (FU2-2, ADR 0118): a skill script run, which
 * asks for approval as a gated tool does, and an OAuth consent request for
 * an authorization_code grant. Both now leave the caller's call open and
 * end the turn input-required with the agent path; the answer (a decision,
 * or any message once the callback has stored the grant) goes back down the
 * open call and the child runs or refuses the script, or runs its paused
 * call with the user's own token. Over runSyndicateTurn and over A2A.
 * Scripted models, in-memory sessions and credential rows, a real script on
 * disk, a mock OAuth provider and MCP server on a local port.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createA2AApp } from '../lib/a2a/app.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { MessagePart, SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { aesGcmCipher } from '../lib/tools/credentialCipher.ts';
import { credentialStore, memoryCredentialRows } from '../lib/tools/credentialStore.ts';
import { closeMcpConnections } from '../lib/tools/mcpToolFactory.ts';
import { oauthConsent } from '../lib/tools/oauthConsent.ts';
import { setOAuthHosts } from '../lib/tools/oauthHosts.ts';
import { oauthClientsFor } from '../lib/tools/oauthTools.ts';
import { ScriptedModel, answer, lastToolResult, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

const resultOf = (req: ModelRequest): string | undefined => {
  const r = lastToolResult(req);
  return r ? JSON.stringify(r.result) : undefined;
};

/** Calls `name` with `args` the first time; once a tool result is in the history, answers with it under `label`. */
const delegating =
  (label: string, name: string, args: Record<string, unknown>, id: string): ModelScript =>
  (req) => {
    const r = resultOf(req);
    return r === undefined ? toolCall(name, args, id) : answer(`${label}: ${r}`);
  };

const config = (raw: Record<string, unknown>): SyndicateYamlConfig => validateSyndicateConfig(raw, 'delegated-scripts-consent') as SyndicateYamlConfig;

/** One conversation over runSyndicateTurn: each message a turn, one store, fresh models. */
function converse(
  cfg: SyndicateYamlConfig,
  scripts: Record<string, ModelScript>,
  extra: Partial<Parameters<typeof runSyndicateTurn>[0]> = {},
  userId = 'u',
  nested: Record<string, SyndicateYamlConfig> = {},
) {
  resetCircuits();
  const models = Object.fromEntries(Object.entries(scripts).map(([k, s]) => [k, new ScriptedModel(`scripted/${k}`, s)]));
  const sessionService = new InProcessSessionService();
  const turn = (parts: MessagePart[]): Promise<SyndicateTurnResult> =>
    runSyndicateTurn({
      config: cfg,
      parts,
      appName: 'app',
      userId,
      sessionId: 's',
      sessionService,
      compile: {
        resolveModel: shimResolver(models),
        log: () => {},
        loadNested: (ref) => {
          const n = nested[ref];
          if (!n) throw new Error(`no nested syndicate ${ref}`);
          return n;
        },
      },
      trace: false,
      ...extra,
    });
  const events = async (appName: string) => (await sessionService.get({ appName, userId, sessionId: 's' }))?.events ?? [];
  return { turn, models, sessionService, events };
}

const callNames = (events: Array<{ content?: { parts?: Array<{ functionCall?: { name?: string } }> } }>) =>
  events.flatMap((e) => (e.content?.parts ?? []).flatMap((p) => (p.functionCall?.name ? [p.functionCall.name] : [])));

// ══ Skill scripts on a delegated subagent ════════════════════════════════════

const FAKE = 'fake-value-not-a-credential';
const TALLY_SCRIPT = `const fs = process.getBuiltinModule('node:fs'); fs.appendFileSync(process.env.FU22_TALLY, 'x'); console.log(JSON.stringify({ ran: true, key: process.env.OPENAI_API_KEY ?? 'unset' }));`;

/** A skills shelf with one skill whose script marks a tally file. */
function shelf(): { dir: string; tally: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fu22-skills-'));
  mkdirSync(join(dir, 'tally', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'tally', 'SKILL.md'), '---\nname: tally\ndescription: Marks a tally.\n---\nRun scripts/mark.js.\n');
  writeFileSync(join(dir, 'tally', 'scripts', 'mark.js'), TALLY_SCRIPT);
  return { dir, tally: join(dir, 'tally.txt') };
}
const marks = (tally: string): number => (existsSync(tally) ? readFileSync(tally, 'utf8').length : 0);

async function withEnv(tally: string, body: () => Promise<void>): Promise<void> {
  const saved = { key: process.env.OPENAI_API_KEY, tally: process.env.FU22_TALLY };
  process.env.OPENAI_API_KEY = FAKE;
  process.env.FU22_TALLY = tally;
  try {
    await body();
  } finally {
    for (const [name, value] of [['OPENAI_API_KEY', saved.key], ['FU22_TALLY', saved.tally]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const runner = (dir: string) => ({
  name: 'Runner',
  model: 'scripted/runner',
  description: 'Runs skill scripts',
  instruction: 'Run the tally.',
  skills: { dir, scripts: 'local', env: ['FU22_TALLY'] },
});
const scriptDesk = (dir: string) =>
  config({ syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Runner.' }, subagents: [runner(dir)] });
const scriptScripts = (): Record<string, ModelScript> => ({
  boss: delegating('Boss', 'Runner', { request: 'count' }, 'call-runner-1'),
  runner: delegating('Runner', 'run_skill_script', { skill_name: 'tally', script_path: 'scripts/mark.js' }, 'call-mark-1'),
});

test('schema: skill scripts are allowed on a delegated subagent', () => {
  const { dir } = shelf();
  try {
    assert.doesNotThrow(() => scriptDesk(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a delegated subagent\'s script run pauses the turn with the path, runs once on approval, and the caller continues', async () => {
  const { dir, tally } = shelf();
  try {
    await withEnv(tally, async () => {
      const c = converse(scriptDesk(dir), scriptScripts());
      const first = await c.turn([{ text: 'count' }]);
      assert.equal(first.status, 'input-required', first.error?.message);
      assert.equal(first.approval?.agent, 'Runner');
      assert.equal(first.approval?.tool, 'run_skill_script');
      assert.deepEqual(first.approval?.args, { skill_name: 'tally', script_path: 'scripts/mark.js' });
      assert.deepEqual(first.approval?.path, ['Boss', 'Runner']);
      assert.equal(marks(tally), 0, 'nothing ran before the approval');
      assert.deepEqual(callNames(await c.events('app/Boss/Runner')), ['run_skill_script', 'adk_request_confirmation']);
      assert.deepEqual(callNames(await c.events('app')), ['Runner'], 'the caller holds the open call');

      const second = await c.turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
      assert.equal(second.status, 'completed', second.error?.message);
      assert.equal(marks(tally), 1, 'the script ran once');
      const seen = resultOf(c.models.runner!.requests[1]!) ?? '';
      assert.ok(seen.includes('\\"ran\\":true'), seen);
      assert.ok(seen.includes('\\"key\\":\\"unset\\"'), 'the minimal environment holds in a child (ADR 0086)');
      assert.ok(!seen.includes(FAKE));
      assert.match(second.text, /^Boss: "Runner: /);
      assert.equal(c.models.boss!.calls, 2);

      const third = await c.turn([{ text: 'thanks' }]);
      assert.equal(third.status, 'completed', third.error?.message);
      assert.equal(marks(tally), 1, 'a later turn never runs the script again');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused script run in a delegated subagent never runs; the child reads the refusal and the caller continues', async () => {
  const { dir, tally } = shelf();
  try {
    await withEnv(tally, async () => {
      const c = converse(scriptDesk(dir), scriptScripts());
      const first = await c.turn([{ text: 'count' }]);
      const second = await c.turn([approvalResponsePart(first.approval!.id, false) as MessagePart]);
      assert.equal(second.status, 'completed', second.error?.message);
      assert.equal(marks(tally), 0);
      assert.match(resultOf(c.models.runner!.requests[1]!) ?? '', /This script run was rejected\./);
      assert.match(second.text, /^Boss: "Runner: /);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two levels deep: a nested syndicate\'s subagent\'s script run pauses with the full path and runs on approval', async () => {
  const { dir, tally } = shelf();
  try {
    await withEnv(tally, async () => {
      const team = config({ syndicate_name: 'Team', orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Ask Runner.' }, subagents: [runner(dir)] });
      const top = config({
        syndicate_name: 'Desk',
        orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Team.' },
        subagents: [{ name: 'Team', description: 'runs scripts', yaml_reference: 'team.yaml' }],
      });
      const c = converse(
        top,
        { ...scriptScripts(), boss: delegating('Boss', 'Team', { request: 'count' }, 'call-team-1'), lead: delegating('Lead', 'Runner', { request: 'count' }, 'call-runner-1') },
        {},
        'u',
        { 'team.yaml': team },
      );
      const turn = c.turn;
      const first = await turn([{ text: 'count' }]);
      assert.equal(first.status, 'input-required', first.error?.message);
      assert.deepEqual(first.approval?.path, ['Boss', 'Team', 'Runner']);
      assert.equal(marks(tally), 0);
      const second = await turn([approvalResponsePart(first.approval!.id, true) as MessagePart]);
      assert.equal(second.status, 'completed', second.error?.message);
      assert.equal(marks(tally), 1);
      assert.match(second.text, /^Boss: "Lead: /);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══ OAuth consent inside a delegated subagent ═══════════════════════════════

const CLIENT_ID = 'melch-test-client';
const CLIENT_SECRET = `fake-client-secret-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
const SECRET_ENV = 'FU22_TRACKER_CLIENT_SECRET';
process.env[SECRET_ENV] = CLIENT_SECRET;

const userTokens = new Map<string, string>(); // token → user
const codes = new Map<string, { challenge: string; redirectUri: string; user: string }>();
const mcpCalls: Array<{ name: string; args: unknown; token: string }> = [];
/** Every bearer the MCP server saw. */
const seen: string[] = [];
let http: HttpServer;
let base = '';
const transports = new Map<string, { transport: SSEServerTransport; token: string }>();
const opened: SSEServerTransport[] = [];
const bearer = (req: express.Request) => (req.headers.authorization ?? '').replace(/^Bearer /, '');

before(async () => {
  const app = express();
  // The provider: `login_hint` names who consents (the mock's stand-in for its own sign-in).
  app.get('/authorize', (req, res) => {
    const code = `code-${randomBytes(8).toString('hex')}`;
    codes.set(code, { challenge: String(req.query.code_challenge), redirectUri: String(req.query.redirect_uri), user: String(req.query.login_hint ?? 'alice') });
    const back = new URL(String(req.query.redirect_uri));
    back.searchParams.set('code', code);
    back.searchParams.set('state', String(req.query.state));
    res.redirect(302, back.toString());
  });
  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const form = new URLSearchParams(req.body as Record<string, string>);
    if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) return void res.status(401).json({ error: 'invalid_client' });
    const issued = codes.get(String(form.get('code')));
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    if (!issued || issued.challenge !== challenge || issued.redirectUri !== form.get('redirect_uri')) return void res.status(400).json({ error: 'invalid_grant' });
    codes.delete(String(form.get('code')));
    const token = `fake-user-${randomBytes(8).toString('hex')}`;
    userTokens.set(token, issued.user);
    res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'tracker:read' });
  });
  // The MCP server: every request carries a valid user bearer, or it is refused.
  app.get('/sse', async (req, res) => {
    const token = bearer(req);
    seen.push(token);
    if (!userTokens.has(token)) return void res.status(401).end();
    const server = new Server({ name: 'tracker', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'lookup', description: 'Look a ticket up by id.', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'The ticket id.' } }, required: ['id'] } }],
    }));
    const transport = new SSEServerTransport('/messages', res);
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const entry = transports.get(transport.sessionId);
      mcpCalls.push({ name: call.params.name, args: call.params.arguments, token: entry?.token ?? '' });
      const id = (call.params.arguments as { id?: string } | undefined)?.id ?? '?';
      return { content: [{ type: 'text' as const, text: `${id} is open (for ${userTokens.get(entry?.token ?? '')})` }] };
    });
    transports.set(transport.sessionId, { transport, token });
    opened.push(transport);
    await server.connect(transport);
  });
  app.post('/messages', express.json(), async (req, res) => {
    const token = bearer(req);
    seen.push(token);
    if (!userTokens.has(token)) return void res.status(401).end();
    const entry = transports.get(String(req.query.sessionId));
    if (!entry) return void res.status(404).end();
    entry.token = token;
    await entry.transport.handlePostMessage(req, res, req.body);
  });
  http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  const addr = http.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.ALLOW_PRIVATE_MCP = 'true';
  // The operator binds the provider to its hosts (ADR 0114).
  setOAuthHosts({ tracker: ['127.0.0.1'] });
});

after(async () => {
  await closeMcpConnections();
  for (const t of opened) await t.close().catch(() => {});
  http?.closeAllConnections?.();
  http?.close();
  delete process.env.ALLOW_PRIVATE_MCP;
  setOAuthHosts(undefined);
  delete process.env[SECRET_ENV];
});

const opsAgent = (user: string) => ({
  name: 'Ops',
  model: 'scripted/ops',
  description: 'works the tracker',
  instruction: 'Work the tracker.',
  mcp_server_url: `${base}/sse`,
  mcp_tools: ['lookup'],
  mcp_auth: {
    oauth2: {
      provider: 'tracker',
      grant: 'authorization_code',
      authorization_url: `${base}/authorize`,
      token_url: `${base}/token`,
      client_id: CLIENT_ID,
      client_secret_env: SECRET_ENV,
      scopes: ['tracker:read'],
      authorization_params: { login_hint: user },
    },
  },
});
const consentDesk = (user: string) =>
  config({ syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Ops.' }, subagents: [opsAgent(user)] });

/** Ops: calls lookup blind, then with the parameters the server declared, then reports; any other result is reported as it came. */
const opsScript: ModelScript = (req) => {
  const last = resultOf(req);
  if (last === undefined || req.messages.at(-1)?.role === 'user') return toolCall('lookup', {});
  const open = /T-1 is open \(for \w+\)/.exec(last);
  if (open) return answer(`Found: ${open[0]}`);
  if (/call it again/.test(last)) return toolCall('lookup', { id: 'T-1' });
  return answer(`Ops: ${last}`);
};
const consentScripts = (): Record<string, ModelScript> => ({ boss: delegating('Boss', 'Ops', { request: 'is T-1 open?' }, 'call-ops-1'), ops: opsScript });

test('a delegated subagent\'s authorization_code tool pauses for consent; the callback stores the grant; the next message resumes the child\'s call with the user\'s own token', async () => {
  const cfg = consentDesk('carol');
  const rows = memoryCredentialRows();
  const store = credentialStore({ rows, cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({ providers: oauthClientsFor([cfg]), redirectUri: 'http://127.0.0.1:9/oauth/callback', credentials: store });
  const logs: string[] = [];
  const c = converse(cfg, consentScripts(), { toolCredentials: { store, consent }, events: { log: (m: string) => logs.push(m) } }, 'carol');

  const callsBefore = mcpCalls.length;
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.consent?.agent, 'Ops');
  assert.equal(first.consent?.provider, 'tracker');
  assert.deepEqual(first.consent?.path, ['Boss', 'Ops']);
  assert.deepEqual(first.consent?.scopes, ['tracker:read']);
  assert.match(first.text, /^Authorization needed: Ops needs access to your tracker account/);
  assert.equal(mcpCalls.length, callsBefore, 'nothing reached the server before the grant');
  // The request lives in the child's session; the caller holds the open call.
  assert.deepEqual(callNames(await c.events('app/Boss/Ops')), ['lookup', 'adk_request_credential']);
  assert.deepEqual(callNames(await c.events('app')), ['Ops']);

  // A message before the grant repeats the request and runs nothing.
  const early = await c.turn([{ text: 'done?' }]);
  assert.equal(early.status, 'input-required');
  assert.equal(early.consent?.id, first.consent!.id);
  assert.deepEqual(early.consent?.path, ['Boss', 'Ops']);
  assert.equal(c.models.boss!.calls, 1, 'no model step while the grant is missing');

  // The person consents at the provider; the callback completes the flow and stores the grant under the turn's app.
  const res = await fetch(first.consent!.authUri, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get('location')!);
  const done = await consent.complete({ state: back.searchParams.get('state'), code: back.searchParams.get('code'), callerUserId: 'carol' });
  assert.equal(done.provider, 'tracker');
  assert.deepEqual(rows.all().map((r) => [r.appName, r.userId, r.provider]), [['app', 'carol', 'tracker']], 'stored under the root app, not the child session\'s path');

  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.match(second.text, /^Boss: "Found: T-1 is open \(for carol\)"$/);
  const calls = mcpCalls.slice(callsBefore);
  assert.deepEqual(calls.map((x) => [x.name, x.args]), [['lookup', { id: 'T-1' }]], 'one call, with the parameters the server declared');
  assert.equal(userTokens.get(calls[0]!.token), 'carol', 'the user\'s own token');
  assert.equal(c.models.boss!.calls, 2, 'the caller resumed its own loop');
  assert.ok(logs.some((l) => l === '✓ Authorization granted: Boss → Ops → tracker'), logs.join('\n'));

  // No token, code or secret in any stored event, the caller's or the child's.
  const json = JSON.stringify([...(await c.events('app')), ...(await c.events('app/Boss/Ops'))]);
  for (const secret of [...userTokens.keys(), CLIENT_SECRET]) assert.ok(!json.includes(secret), 'no value in a session');
  for (const secret of [...userTokens.keys(), CLIENT_SECRET]) assert.ok(!logs.join('\n').includes(secret), 'no value in the log');

  const third = await c.turn([{ text: 'thanks' }]);
  assert.equal(third.status, 'completed', third.error?.message);
  assert.equal(mcpCalls.length, callsBefore + 1, 'a later turn never runs the call again');
});

test('a dispatch route that delegates: consent inside the route\'s subagent pauses the turn, and the next message after the grant resumes that route without classifying', async () => {
  const team = config({ syndicate_name: 'Team', orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Ask Ops.' }, subagents: [opsAgent('gina')] });
  const top = config({
    syndicate_name: 'Front',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      { name: 'Team', description: 'works the tracker', yaml_reference: 'team.yaml' },
    ],
    dispatch: { default_route: 'Chat' },
  });
  const store = credentialStore({ rows: memoryCredentialRows(), cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({ providers: oauthClientsFor([team]), redirectUri: 'http://127.0.0.1:9/oauth/callback', credentials: store });
  const c = converse(
    top,
    { router: () => answer('{"route":"Team","reason":"tracker"}'), chat: () => answer('chat'), lead: delegating('Lead', 'Ops', { request: 'is T-1 open?' }, 'call-ops-1'), ops: opsScript },
    { toolCredentials: { store, consent } },
    'gina',
    { 'team.yaml': team },
  );
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.deepEqual(first.consent?.path, ['Team', 'Ops']);
  const res = await fetch(first.consent!.authUri, { redirect: 'manual' });
  const back = new URL(res.headers.get('location')!);
  await consent.complete({ state: back.searchParams.get('state'), code: back.searchParams.get('code'), callerUserId: 'gina' });
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.route?.decidedBy, 'consent');
  assert.equal(second.route?.route, 'Team');
  assert.equal(c.models.router!.calls, 1, 'the resume does not classify');
  assert.match(second.text, /^Lead: "Found: T-1 is open \(for gina\)"$/);
});

// ── Inside a nested dispatch syndicate's route (ADR 0120) ───────────────────

/** A nested dispatch syndicate whose route Ops works the tracker under the user's own grant. */
const dispatchDesk = (user: string) =>
  config({
    syndicate_name: 'Team',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [{ name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' }, opsAgent(user)],
    dispatch: { default_route: 'Chat' },
  });

test('a nested dispatch syndicate delegated to: consent inside its route pauses with the path; the grant resumes that route on the nested conversation', async () => {
  const team = dispatchDesk('ivan');
  const top = config({ syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Team.' }, subagents: [{ name: 'Team', description: 'works the tracker', yaml_reference: 'team.yaml' }] });
  const rows = memoryCredentialRows();
  const store = credentialStore({ rows, cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({ providers: oauthClientsFor([team]), redirectUri: 'http://127.0.0.1:9/oauth/callback', credentials: store });
  const c = converse(
    top,
    { boss: delegating('Boss', 'Team', { request: 'is T-1 open?' }, 'call-team-1'), router: () => answer('{"route":"Ops","reason":"tracker"}'), chat: () => answer('chat'), ops: opsScript },
    { toolCredentials: { store, consent } },
    'ivan',
    { 'team.yaml': team },
  );
  const callsBefore = mcpCalls.length;
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.consent?.agent, 'Ops');
  assert.deepEqual(first.consent?.path, ['Boss', 'Team', 'Ops']);
  assert.deepEqual(callNames(await c.events('app/Boss/Team')), ['lookup', 'adk_request_credential'], 'the request lives in the nested conversation, where its route answered');
  const early = await c.turn([{ text: 'done?' }]);
  assert.equal(early.status, 'input-required');
  assert.equal(early.consent?.id, first.consent!.id);
  const res = await fetch(first.consent!.authUri, { redirect: 'manual' });
  const back = new URL(res.headers.get('location')!);
  await consent.complete({ state: back.searchParams.get('state'), code: back.searchParams.get('code'), callerUserId: 'ivan' });
  assert.deepEqual(rows.all().map((r) => r.appName), ['app'], 'stored under the root app');
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.match(second.text, /^Boss: "Found: T-1 is open \(for ivan\)"$/);
  assert.equal(c.models.router!.calls, 1, 'the nested syndicate does not classify again');
  const calls = mcpCalls.slice(callsBefore);
  assert.deepEqual(calls.map((x) => x.name), ['lookup']);
  assert.equal(userTokens.get(calls[0]!.token), 'ivan', 'the user\'s own token');
});

test('a nested dispatch syndicate as a route: consent inside its route pauses with the path from the route down; the next message after the grant resumes it without classifying', async () => {
  const team = dispatchDesk('judy');
  const top = config({
    syndicate_name: 'Front',
    orchestrator: { name: 'Front', model: 'scripted/front', instruction: 'Classify.' },
    subagents: [
      { name: 'Small', model: 'scripted/small', instruction: 'Chat.', description: 'small talk' },
      { name: 'Team', description: 'works the tracker', yaml_reference: 'team.yaml' },
    ],
    dispatch: { default_route: 'Small' },
  });
  const rows = memoryCredentialRows();
  const store = credentialStore({ rows, cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({ providers: oauthClientsFor([team]), redirectUri: 'http://127.0.0.1:9/oauth/callback', credentials: store });
  const c = converse(
    top,
    { front: () => answer('{"route":"Team","reason":"tracker"}'), small: () => answer('small'), router: () => answer('{"route":"Ops","reason":"tracker"}'), chat: () => answer('chat'), ops: opsScript },
    { toolCredentials: { store, consent } },
    'judy',
    { 'team.yaml': team },
  );
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.deepEqual(first.consent?.path, ['Team', 'Ops']);
  const stored = (await c.events('app')).length;
  const early = await c.turn([{ text: 'done?' }]);
  assert.equal(early.status, 'input-required');
  assert.equal(early.consent?.id, first.consent!.id);
  assert.equal((await c.events('app')).length, stored, 'a message before the grant stores nothing');
  const res = await fetch(first.consent!.authUri, { redirect: 'manual' });
  const back = new URL(res.headers.get('location')!);
  await consent.complete({ state: back.searchParams.get('state'), code: back.searchParams.get('code'), callerUserId: 'judy' });
  assert.deepEqual(rows.all().map((r) => r.appName), ['app'], 'stored under the root app');
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.route?.decidedBy, 'consent');
  assert.equal(second.route?.route, 'Team');
  assert.equal(c.models.front!.calls, 1, 'the top does not classify again');
  assert.equal(c.models.router!.calls, 1, 'the nested syndicate does not classify again');
  assert.equal(second.text, 'Found: T-1 is open (for judy)');
});

test('two levels deep: consent inside a nested syndicate\'s subagent pauses with the full path, and the grant travels down both open calls', async () => {
  const team = config({ syndicate_name: 'Team', orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Ask Ops.' }, subagents: [opsAgent('hank')] });
  const top = config({ syndicate_name: 'Desk', orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Team.' }, subagents: [{ name: 'Team', description: 'works the tracker', yaml_reference: 'team.yaml' }] });
  const rows = memoryCredentialRows();
  const store = credentialStore({ rows, cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({ providers: oauthClientsFor([team]), redirectUri: 'http://127.0.0.1:9/oauth/callback', credentials: store });
  const c = converse(
    top,
    { boss: delegating('Boss', 'Team', { request: 'is T-1 open?' }, 'call-team-1'), lead: delegating('Lead', 'Ops', { request: 'is T-1 open?' }, 'call-ops-1'), ops: opsScript },
    { toolCredentials: { store, consent } },
    'hank',
    { 'team.yaml': team },
  );
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.deepEqual(first.consent?.path, ['Boss', 'Team', 'Ops']);
  const res = await fetch(first.consent!.authUri, { redirect: 'manual' });
  const back = new URL(res.headers.get('location')!);
  await consent.complete({ state: back.searchParams.get('state'), code: back.searchParams.get('code'), callerUserId: 'hank' });
  assert.deepEqual(rows.all().map((r) => r.appName), ['app'], 'the root app, two levels down too');
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.match(second.text, /^Boss: "Lead: .*T-1 is open \(for hank\)/);
});

test('the WS6-3d host checks hold for a resumed child call: with its host off the allowlist the turn is refused and nothing is sent', async () => {
  const cfg = consentDesk('dave');
  const rows = memoryCredentialRows();
  const store = credentialStore({ rows, cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({ providers: oauthClientsFor([cfg]), redirectUri: 'http://127.0.0.1:9/oauth/callback', credentials: store });
  const c = converse(cfg, consentScripts(), { toolCredentials: { store, consent } }, 'dave');
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.deepEqual(first.consent?.path, ['Boss', 'Ops']);
  const res = await fetch(first.consent!.authUri, { redirect: 'manual' });
  const back = new URL(res.headers.get('location')!);
  await consent.complete({ state: back.searchParams.get('state'), code: back.searchParams.get('code') });
  const daveToken = [...userTokens].find(([, u]) => u === 'dave')?.[0];
  assert.ok(daveToken);
  const seenBefore = seen.length;
  const callsBefore = mcpCalls.length;
  setOAuthHosts({ tracker: ['tracker.example.com'] });
  try {
    await assert.rejects(c.turn([{ text: 'done' }]), /provider "tracker" may send its tokens only to tracker\.example\.com/);
    assert.ok(!seen.slice(seenBefore).includes(daveToken!), 'the token never left for a host off the allowlist');
    assert.equal(mcpCalls.length, callsBefore);
  } finally {
    setOAuthHosts({ tracker: ['127.0.0.1'] });
  }
  // Back on the allowlist, the same message resumes the child's call.
  const again = await c.turn([{ text: 'done' }]);
  assert.equal(again.status, 'completed', again.error?.message);
  assert.match(again.text, /T-1 is open \(for dave\)/);
});

test('old sessions resume: a conversation whose subagent answered without a consent step continues, and its next call pauses for consent', async () => {
  const cfg = consentDesk('erin');
  const store = credentialStore({ rows: memoryCredentialRows(), cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({ providers: oauthClientsFor([cfg]), redirectUri: 'http://127.0.0.1:9/oauth/callback', credentials: store });
  // Before this change: no consent step reached the child, so its call answered not_connected and the turn completed.
  // Boss delegates on every message from the person.
  const boss: ModelScript = (req) => (req.messages.at(-1)?.role === 'user' ? toolCall('Ops', { request: 'is T-1 open?' }) : answer(`Boss: ${resultOf(req)}`));
  const before = converse(cfg, { boss, ops: opsScript }, { toolCredentials: { store } }, 'erin');
  const old = await before.turn([{ text: 'is T-1 open?' }]);
  assert.equal(old.status, 'completed', old.error?.message);
  assert.equal(old.consent, undefined);
  assert.match(old.text, /^Boss: "Ops: /);
  // The same store, now with the consent step: the conversation continues, and the new call asks.
  const turn = (parts: MessagePart[]) =>
    runSyndicateTurn({
      config: cfg,
      parts,
      appName: 'app',
      userId: 'erin',
      sessionId: 's',
      sessionService: before.sessionService,
      compile: { resolveModel: shimResolver(before.models as Record<string, ScriptedModel>), log: () => {} },
      toolCredentials: { store, consent },
      trace: false,
    });
  const next = await turn([{ text: 'and now?' }]);
  assert.equal(next.status, 'input-required', next.error?.message ?? next.text);
  assert.deepEqual(next.consent?.path, ['Boss', 'Ops']);
});

// ── Over A2A ─────────────────────────────────────────────────────────────────

test('over A2A: the consent_request data part carries the path; the callback route stores the grant; the next message completes with the user\'s token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fu22-a2a-'));
  const yaml = [
    'syndicate_name: Desk',
    'orchestrator:',
    '  name: Boss',
    '  model: scripted/boss',
    '  instruction: Delegate to Ops.',
    'subagents:',
    '  - name: Ops',
    '    model: scripted/ops',
    '    description: works the tracker',
    '    instruction: Work the tracker.',
    `    mcp_server_url: "${base}/sse"`,
    '    mcp_tools: [lookup]',
    '    mcp_auth:',
    '      oauth2:',
    '        provider: tracker',
    '        grant: authorization_code',
    `        authorization_url: "${base}/authorize"`,
    `        token_url: "${base}/token"`,
    `        client_id: ${CLIENT_ID}`,
    `        client_secret_env: ${SECRET_ENV}`,
    '        scopes: ["tracker:read"]',
    '        authorization_params: { login_hint: frank }',
  ].join('\n');
  writeFileSync(join(dir, 'desk.yaml'), yaml);
  const savedDir = process.env.MELCHIZEDEK_AGENTS_DIR;
  process.env.MELCHIZEDEK_AGENTS_DIR = dir;

  const listening = createServer();
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
  const addr = listening.address();
  const server = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const rows = memoryCredentialRows();
  const store = credentialStore({ rows, cipher: aesGcmCipher(randomBytes(32)) });
  const cfg = validateSyndicateConfig(structuredClone(consentDesk('frank')), 'desk');
  const consent = oauthConsent({ providers: oauthClientsFor([cfg]), redirectUri: `${server}/oauth/callback`, credentials: store });
  const scripts = consentScripts();
  const logs: string[] = [];
  try {
    const built = await createA2AApp({
      defaultSyndicate: 'desk.yaml',
      storage: { sessionService: new InProcessSessionService() },
      toolCredentials: { store, consent, requireCallerIdentity: false },
      resolveModel: (id?: string) => {
        const key = (id ?? '').replace(/^scripted\//, '');
        return shimResolver({ [key]: new ScriptedModel(`scripted/${key}`, scripts[key]!) })(id);
      },
      log: (m) => logs.push(m),
      warn: (m) => logs.push(m),
    });
    listening.on('request', built.app);
    const send = async (message: string, ids: { contextId?: string; taskId?: string } = {}): Promise<any> => {
      const res = await fetch(`${server}/a2a/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: message }], ...ids } } }),
      });
      const body = (await res.json()) as any;
      assert.ok(body.result, JSON.stringify(body.error ?? body));
      return body.result;
    };
    const statusText = (task: any) => (task.status?.message?.parts ?? []).map((p: any) => p.text ?? '').join('');
    const data = (task: any) => (task.status?.message?.parts ?? []).find((p: any) => p.kind === 'data')?.data;

    const callsBefore = mcpCalls.length;
    const first = await send('is T-1 open?');
    assert.equal(first.status.state, 'input-required', statusText(first));
    const request = data(first);
    assert.deepEqual(Object.keys(request).sort(), ['agent', 'authorization_url', 'consent_id', 'path', 'provider', 'scopes', 'state', 'type']);
    assert.equal(request.type, 'consent_request');
    assert.equal(request.agent, 'Ops');
    assert.deepEqual(request.path, ['Boss', 'Ops']);
    assert.equal(new URL(request.authorization_url).searchParams.get('state'), request.state);
    assert.equal(mcpCalls.length, callsBefore);

    // The browser: the provider, then the server's callback route.
    const atProvider = await fetch(request.authorization_url, { redirect: 'manual' });
    assert.equal(atProvider.status, 302);
    const callback = await fetch(new URL(atProvider.headers.get('location')!), { redirect: 'manual' });
    assert.equal(callback.status, 200, await callback.text());
    assert.equal(rows.all().length, 1);
    assert.ok(!rows.all()[0]!.appName.includes('/'), 'the grant is filed under the conversation\'s app, not a child path');

    const second = await send('done', { contextId: first.contextId, taskId: first.id });
    assert.equal(second.status.state, 'completed', statusText(second));
    assert.match(statusText(second), /Found: T-1 is open \(for frank\)/);
    const calls = mcpCalls.slice(callsBefore);
    assert.equal(calls.length, 1);
    assert.equal(userTokens.get(calls[0]!.token), 'frank', 'the user\'s own token');
    for (const s of [CLIENT_SECRET, ...userTokens.keys()]) assert.ok(!logs.join('\n').includes(s), 'no secret or token in the server log');
    await built.shutdown(0);
  } finally {
    listening.closeAllConnections?.();
    listening.close();
    if (savedDir === undefined) delete process.env.MELCHIZEDEK_AGENTS_DIR;
    else process.env.MELCHIZEDEK_AGENTS_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('over A2A: a delegated subagent\'s script run asks with the path, and "approve" runs it', async () => {
  const { dir: skills, tally } = shelf();
  const dir = mkdtempSync(join(tmpdir(), 'fu22-a2a-scripts-'));
  writeFileSync(
    join(dir, 'desk.yaml'),
    [
      'syndicate_name: Desk',
      'orchestrator:',
      '  name: Boss',
      '  model: scripted/boss',
      '  instruction: Delegate to Runner.',
      'subagents:',
      '  - name: Runner',
      '    model: scripted/runner',
      '    description: Runs skill scripts',
      '    instruction: Run the tally.',
      '    skills:',
      `      dir: "${skills}"`,
      '      scripts: local',
      '      env: [FU22_TALLY]',
    ].join('\n'),
  );
  const savedDir = process.env.MELCHIZEDEK_AGENTS_DIR;
  process.env.MELCHIZEDEK_AGENTS_DIR = dir;
  const scripts = scriptScripts();
  try {
    await withEnv(tally, async () => {
      const built = await createA2AApp({
        defaultSyndicate: 'desk.yaml',
        storage: { sessionService: new InProcessSessionService() },
        resolveModel: (id?: string) => {
          const key = (id ?? '').replace(/^scripted\//, '');
          return shimResolver({ [key]: new ScriptedModel(`scripted/${key}`, scripts[key]!) })(id);
        },
        log: () => {},
        warn: () => {},
      });
      const listening = await new Promise<HttpServer>((resolve) => {
        const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
      });
      const addr = listening.address();
      const server = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      try {
        const send = async (message: string, ids: { contextId?: string; taskId?: string } = {}): Promise<any> => {
          const res = await fetch(`${server}/a2a/jsonrpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: message }], ...ids } } }),
          });
          const body = (await res.json()) as any;
          assert.ok(body.result, JSON.stringify(body.error ?? body));
          return body.result;
        };
        const data = (task: any) => (task.status?.message?.parts ?? []).find((p: any) => p.kind === 'data')?.data;
        const first = await send('count');
        assert.equal(first.status.state, 'input-required');
        assert.equal(data(first).type, 'approval_request');
        assert.equal(data(first).tool, 'run_skill_script');
        assert.deepEqual(data(first).path, ['Boss', 'Runner']);
        assert.equal(marks(tally), 0);
        const done = await send('approve', { contextId: first.contextId, taskId: first.id });
        assert.equal(done.status.state, 'completed');
        assert.equal(marks(tally), 1);
        await built.shutdown(0);
      } finally {
        listening.closeAllConnections?.();
        listening.close();
      }
    });
  } finally {
    if (savedDir === undefined) delete process.env.MELCHIZEDEK_AGENTS_DIR;
    else process.env.MELCHIZEDEK_AGENTS_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(skills, { recursive: true, force: true });
  }
});
