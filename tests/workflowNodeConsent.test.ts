/**
 * tests/workflowNodeConsent.test.ts — an OAuth consent pause raised inside
 * a workflow node reaches the turn and resumes that node (ADR 0128): an
 * agent node's own tool, a delegated subagent under a node, a node that is a
 * nested dispatch syndicate, a node that is a nested workflow, and one of
 * two parallel branches. Each pause ends the turn input-required with the
 * request (and the path from the node down when it waits below the node);
 * a message before the grant repeats it and stores nothing; the callback
 * stores the grant under the turn's app; the next message resumes the node
 * with the user's own token, and no completed node runs again. A map node's
 * agent is refused an authorization_code grant at load. A durable run
 * checkpoints at the pause and a restored run stands at the same request
 * without a model call. Scripted models, in-memory sessions and credential
 * rows, a mock OAuth provider and MCP server on a local port.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ModelRequest } from '../lib/models/contract.ts';
import { resetCircuits } from '../lib/models/circuitBreaker.ts';
import { runDurableTurn } from '../lib/runtime/native/checkpoint.ts';
import type { CheckpointSink, RunCheckpoint } from '../lib/runtime/native/checkpoint.ts';
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
import { ScriptedModel, answer, lastToolResult, requestTexts, shimResolver, toolCall } from './helpers/scriptedModel.ts';
import type { ModelScript } from './helpers/scriptedModel.ts';

const resultOf = (req: ModelRequest): string | undefined => {
  const r = lastToolResult(req);
  return r ? JSON.stringify(r.result) : undefined;
};
const lastText = (request: ModelRequest) => requestTexts(request).at(-1) ?? '';

/** Calls `name` with `args` the first time; once a tool result is in the history, answers with it under `label`. */
const delegating =
  (label: string, name: string, args: Record<string, unknown>, id: string): ModelScript =>
  (req) => {
    const r = resultOf(req);
    return r === undefined ? toolCall(name, args, id) : answer(`${label}: ${r}`);
  };

const config = (raw: Record<string, unknown>, file = 'workflow-node-consent'): SyndicateYamlConfig => validateSyndicateConfig(raw, file) as SyndicateYamlConfig;
const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: name, model: `scripted/${name.toLowerCase()}`, instruction: `${name}.`, ...extra });

// ── The mock provider and MCP server ─────────────────────────────────────────

const CLIENT_ID = 'melch-test-client';
const CLIENT_SECRET = `fake-client-secret-${randomBytes(8).toString('hex')}`; // gitleaks:allow (test fixture)
const SECRET_ENV = 'E2_TRACKER_CLIENT_SECRET';
process.env[SECRET_ENV] = CLIENT_SECRET;

const userTokens = new Map<string, string>(); // token → user
const codes = new Map<string, { challenge: string; redirectUri: string; user: string }>();
const mcpCalls: Array<{ name: string; args: unknown; token: string }> = [];
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

// ── The syndicates ───────────────────────────────────────────────────────────

const oauth = (user: string) => ({
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
});

/** Ops: works the tracker under the user's own grant. */
const opsAgent = (user: string) => agent('Ops', { mcp_server_url: `${base}/sse`, mcp_tools: ['lookup'], mcp_auth: oauth(user) });

/** Ops: calls lookup blind, then with the parameters the server declared, then reports; any other result is reported as it came. */
const opsScript: ModelScript = (req) => {
  const last = resultOf(req);
  if (last === undefined || req.messages.at(-1)?.role === 'user') return toolCall('lookup', {});
  const open = /T-1 is open \(for \w+\)/.exec(last);
  if (open) return answer(`Found: ${open[0]}`);
  if (/call it again/.test(last)) return toolCall('lookup', { id: 'T-1' });
  return answer(`Ops: ${last}`);
};

const scripts = (): Record<string, ModelScript> => ({
  plan: (req) => answer(`plan(${lastText(req)})`),
  wrap: (req) => answer(`wrap(${lastText(req)})`),
  side: (req) => answer(`side(${lastText(req)})`),
  ops: opsScript,
  lead: delegating('Lead', 'Ops', { request: 'is T-1 open?' }, 'call-ops-1'),
  router: () => answer('{"route":"Ops","reason":"tracker"}'),
  chat: () => answer('chat'),
});

/** Plan → `node` → Wrap: a workflow syndicate whose middle node is `nodeEntry`. */
const room = (nodeEntry: Record<string, unknown>, extra: Record<string, unknown>[] = []) =>
  config({
    syndicate_name: 'Room',
    memory_system: 'internal-only',
    orchestrator: agent('Plan'),
    subagents: [nodeEntry, agent('Wrap'), ...extra],
    workflow: { edges: [['START', 'Plan', nodeEntry.name, 'Wrap']] },
  });

/** One conversation over runSyndicateTurn, with the consent step over the configs that declare the grant. */
function converse(cfg: SyndicateYamlConfig, user: string, grantConfigs: SyndicateYamlConfig[], nested: Record<string, SyndicateYamlConfig> = {}) {
  resetCircuits();
  const models = Object.fromEntries(Object.entries(scripts()).map(([k, s]) => [k, new ScriptedModel(`scripted/${k}`, s)]));
  const sessionService = new InProcessSessionService();
  const rows = memoryCredentialRows();
  const store = credentialStore({ rows, cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({ providers: oauthClientsFor(grantConfigs), redirectUri: 'http://127.0.0.1:9/oauth/callback', credentials: store });
  const logs: string[] = [];
  const turn = (parts: MessagePart[]): Promise<SyndicateTurnResult> =>
    runSyndicateTurn({
      config: cfg,
      parts,
      appName: 'app',
      userId: user,
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
      toolCredentials: { store, consent },
      events: { log: (m: string) => logs.push(m) },
      trace: false,
    });
  const events = async (appName: string) => (await sessionService.get({ appName, userId: user, sessionId: 's' }))?.events ?? [];
  /** The person consents at the provider; the callback completes the flow. */
  const grant = async (authUri: string) => {
    const res = await fetch(authUri, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const back = new URL(res.headers.get('location')!);
    return consent.complete({ state: back.searchParams.get('state'), code: back.searchParams.get('code'), callerUserId: user });
  };
  return { turn, models, sessionService, events, rows, grant, logs };
}

const callNames = (events: Array<{ content?: { parts?: Array<{ functionCall?: { name?: string } }> } }>) =>
  events.flatMap((e) => (e.content?.parts ?? []).flatMap((p) => (p.functionCall?.name ? [p.functionCall.name] : [])));

// ══ An agent node ════════════════════════════════════════════════════════════

test('an agent node\'s authorization_code tool pauses the walk for consent; a message before the grant repeats it; after the grant the node resumes with the user\'s own token and no completed node runs again', async () => {
  const cfg = room(opsAgent('kate'));
  const c = converse(cfg, 'kate', [cfg]);
  const callsBefore = mcpCalls.length;

  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.consent?.agent, 'Ops');
  assert.equal(first.consent?.provider, 'tracker');
  assert.equal(first.consent?.path, undefined, 'the node\'s own request carries no path, as a node\'s own approval does');
  assert.deepEqual(first.consent?.scopes, ['tracker:read']);
  assert.match(first.text, /^Authorization needed: Ops needs access to your tracker account/);
  assert.equal(mcpCalls.length, callsBefore, 'nothing reached the server before the grant');
  const stored = await c.events('app');
  assert.deepEqual(callNames(stored), ['lookup', 'adk_request_credential'], 'the request is the node\'s event in the walk\'s session');
  const record = stored.at(-1)!;
  assert.equal(record.author, 'Room');
  assert.deepEqual(record.longRunningToolIds, [first.consent!.id], 'the walk\'s pause record names the request');

  // A message before the grant repeats the request and stores nothing.
  const early = await c.turn([{ text: 'done?' }]);
  assert.equal(early.status, 'input-required');
  assert.equal(early.consent?.id, first.consent!.id);
  assert.equal((await c.events('app')).length, stored.length, 'a message before the grant stores nothing');
  assert.equal(c.models.ops!.calls, 1, 'no model step while the grant is missing');

  const done = await c.grant(first.consent!.authUri);
  assert.equal(done.provider, 'tracker');
  assert.deepEqual(c.rows.all().map((r) => [r.appName, r.userId, r.provider]), [['app', 'kate', 'tracker']], 'stored under the turn\'s app');

  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.text, 'wrap(Found: T-1 is open (for kate))');
  const calls = mcpCalls.slice(callsBefore);
  assert.deepEqual(calls.map((x) => [x.name, x.args]), [['lookup', { id: 'T-1' }]], 'one call, with the parameters the server declared');
  assert.equal(userTokens.get(calls[0]!.token), 'kate', 'the user\'s own token');
  assert.equal(c.models.plan!.calls, 1, 'the completed node does not run again');
  assert.equal(c.models.wrap!.calls, 1);
  assert.ok(c.logs.includes('✓ Authorization granted: Ops → tracker'), c.logs.join('\n'));

  // No token, code or secret in any stored event or log line.
  const json = JSON.stringify(await c.events('app'));
  for (const secret of [...userTokens.keys(), CLIENT_SECRET]) assert.ok(!json.includes(secret), 'no value in a session');
  for (const secret of [...userTokens.keys(), CLIENT_SECRET]) assert.ok(!c.logs.join('\n').includes(secret), 'no value in the log');

  // A new message walks the graph afresh; the grant is stored, so the node's call runs without asking again.
  const third = await c.turn([{ text: 'and T-1 again?' }]);
  assert.equal(third.status, 'completed', third.error?.message);
  assert.equal(third.consent, undefined, 'the stored grant is read, not asked for again');
  assert.equal(third.text, 'wrap(Found: T-1 is open (for kate))');
});

// ══ A delegated subagent under a node ═══════════════════════════════════════

test('a delegated subagent under a node: its consent request reaches the turn with the path from the node down, and the grant travels down the node\'s open call', async () => {
  const team = config({ syndicate_name: 'Team', orchestrator: { name: 'Lead', model: 'scripted/lead', instruction: 'Ask Ops.' }, subagents: [opsAgent('liam')] }, 'team.yaml');
  const cfg = room({ name: 'Team', description: 'works the tracker', yaml_reference: 'team.yaml' });
  const c = converse(cfg, 'liam', [team], { 'team.yaml': team });
  const callsBefore = mcpCalls.length;

  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.consent?.agent, 'Ops');
  assert.deepEqual(first.consent?.path, ['Team', 'Ops']);
  assert.deepEqual(callNames(await c.events('app/Team/Ops')), ['lookup', 'adk_request_credential'], 'the request lives in the subagent\'s session');

  const early = await c.turn([{ text: 'done?' }]);
  assert.equal(early.status, 'input-required');
  assert.equal(early.consent?.id, first.consent!.id);
  assert.deepEqual(early.consent?.path, ['Team', 'Ops']);

  await c.grant(first.consent!.authUri);
  assert.deepEqual(c.rows.all().map((r) => r.appName), ['app'], 'stored under the turn\'s app, not the child session\'s path');
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.match(second.text, /^wrap\(Lead: "Found: T-1 is open \(for liam\)"\)$/);
  const calls = mcpCalls.slice(callsBefore);
  assert.deepEqual(calls.map((x) => x.name), ['lookup']);
  assert.equal(userTokens.get(calls[0]!.token), 'liam');
  assert.equal(c.models.plan!.calls, 1);
  assert.equal(c.models.lead!.calls, 2, 'the node\'s agent resumed its own loop once');
});

// ══ A node that is a nested dispatch syndicate ═══════════════════════════════

test('a node that is a nested dispatch syndicate: consent inside its route reaches the turn with the path, and the grant resumes that route without classifying', async () => {
  const team = config(
    {
      syndicate_name: 'Team',
      orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
      subagents: [agent('Chat'), opsAgent('mona')],
      dispatch: { default_route: 'Chat' },
    },
    'team.yaml',
  );
  const cfg = room({ name: 'Team', description: 'works the tracker', yaml_reference: 'team.yaml' });
  const c = converse(cfg, 'mona', [team], { 'team.yaml': team });
  const callsBefore = mcpCalls.length;

  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.consent?.agent, 'Ops');
  assert.deepEqual(first.consent?.path, ['Team', 'Ops']);
  assert.deepEqual(callNames(await c.events('app/node:Team')), ['lookup', 'adk_request_credential'], 'the request lives in the nested conversation');

  const stored = (await c.events('app')).length;
  const early = await c.turn([{ text: 'done?' }]);
  assert.equal(early.status, 'input-required');
  assert.equal(early.consent?.id, first.consent!.id);
  assert.equal((await c.events('app')).length, stored, 'a message before the grant stores nothing');

  await c.grant(first.consent!.authUri);
  assert.deepEqual(c.rows.all().map((r) => r.appName), ['app']);
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.text, 'wrap(Found: T-1 is open (for mona))');
  assert.equal(c.models.router!.calls, 1, 'the nested syndicate does not classify again');
  assert.equal(c.models.plan!.calls, 1);
  const calls = mcpCalls.slice(callsBefore);
  assert.deepEqual(calls.map((x) => x.name), ['lookup']);
  assert.equal(userTokens.get(calls[0]!.token), 'mona');
});

// ══ A node that is a nested workflow ═════════════════════════════════════════

test('a node that is a nested workflow: its agent node\'s consent request reaches the turn with the path, and the grant walks back into the nested graph', async () => {
  const inner = config(
    { syndicate_name: 'Inner', memory_system: 'internal-only', orchestrator: opsAgent('nina'), workflow: { edges: [['START', 'Ops']] } },
    'inner.yaml',
  );
  const cfg = room({ name: 'Writer', description: 'works the tracker', yaml_reference: 'inner.yaml' });
  const c = converse(cfg, 'nina', [inner], { 'inner.yaml': inner });
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.consent?.agent, 'Ops');
  assert.deepEqual(first.consent?.path, ['Writer', 'Ops']);
  const early = await c.turn([{ text: 'done?' }]);
  assert.equal(early.consent?.id, first.consent!.id);
  await c.grant(first.consent!.authUri);
  assert.deepEqual(c.rows.all().map((r) => r.appName), ['app'], 'a nested walk\'s flow is bound to the turn\'s app');
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.text, 'wrap(Found: T-1 is open (for nina))');
  assert.equal(c.models.plan!.calls, 1);
});

// ══ Parallel branches and map nodes ══════════════════════════════════════════

test('parallel branches: the branch that needs a grant pauses, the other completes and is not run again on the resume', async () => {
  const cfg = config({
    syndicate_name: 'Room',
    memory_system: 'internal-only',
    orchestrator: agent('Plan'),
    subagents: [opsAgent('omar'), agent('Side'), agent('Wrap')],
    workflow: { edges: [['START', 'Plan', ['Ops', 'Side']], [['Ops', 'Side'], 'Both', 'Wrap']], nodes: { Both: { join: true } } },
  });
  const c = converse(cfg, 'omar', [cfg]);
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.consent?.agent, 'Ops');
  assert.equal(c.models.side!.calls, 1, 'the other branch ran');
  assert.equal(c.models.wrap!.calls, 0, 'the join waits for the paused branch');
  await c.grant(first.consent!.authUri);
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.match(second.text, /^wrap\(/);
  assert.match(second.text, /Found: T-1 is open \(for omar\)/);
  assert.match(second.text, /side\(/);
  assert.equal(c.models.side!.calls, 1, 'the completed branch is not run again');
  assert.equal(c.models.plan!.calls, 1);
  assert.equal(c.models.wrap!.calls, 1);
});

test('two parallel branches both wait for the grant: the turn asks once, and one message after the grant resumes both', async () => {
  const cfg = config({
    syndicate_name: 'Room',
    memory_system: 'internal-only',
    orchestrator: agent('Plan'),
    subagents: [opsAgent('rita'), { ...opsAgent('rita'), name: 'Ops2', model: 'scripted/ops' }, agent('Wrap')],
    workflow: { edges: [['START', 'Plan', ['Ops', 'Ops2']], [['Ops', 'Ops2'], 'Both', 'Wrap']], nodes: { Both: { join: true } } },
  });
  const c = converse(cfg, 'rita', [cfg]);
  const callsBefore = mcpCalls.length;
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  const record = (await c.events('app')).at(-1)!;
  assert.equal(record.longRunningToolIds?.length, 2, 'the walk waits on both requests');
  const early = await c.turn([{ text: 'done?' }]);
  assert.equal(early.consent?.id, first.consent!.id, 'the first missing grant is repeated');
  await c.grant(first.consent!.authUri);
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal((second.text.match(/Found: T-1 is open \(for rita\)/g) ?? []).length, 2, second.text);
  assert.equal(mcpCalls.length - callsBefore, 2, 'each branch\'s call ran once');
  assert.equal(c.models.plan!.calls, 1);
  assert.equal(c.models.wrap!.calls, 1);
});

// ══ A walk below a delegated call or a route ═════════════════════════════════

test('a nested workflow delegated to: its node\'s consent request reaches the turn through the open call, and the grant walks back into the graph', async () => {
  const inner = config(
    { syndicate_name: 'Inner', memory_system: 'internal-only', orchestrator: opsAgent('sam'), workflow: { edges: [['START', 'Ops']] } },
    'inner.yaml',
  );
  const cfg = config({
    syndicate_name: 'Desk',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Writer.' },
    subagents: [{ name: 'Writer', description: 'works the tracker', yaml_reference: 'inner.yaml' }],
  });
  const c = converse(cfg, 'sam', [inner], { 'inner.yaml': inner });
  c.models.boss = new ScriptedModel('scripted/boss', delegating('Boss', 'Writer', { request: 'is T-1 open?' }, 'call-writer-1'));
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.deepEqual(first.consent?.path, ['Boss', 'Writer', 'Ops']);
  const early = await c.turn([{ text: 'done?' }]);
  assert.equal(early.consent?.id, first.consent!.id);
  await c.grant(first.consent!.authUri);
  assert.deepEqual(c.rows.all().map((r) => r.appName), ['app']);
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.text, 'Boss: "Found: T-1 is open (for sam)"');
});

test('a workflow route: its node\'s consent request reaches the turn with the path from the route down, and the grant resumes the route without classifying', async () => {
  const inner = config(
    { syndicate_name: 'Inner', memory_system: 'internal-only', orchestrator: opsAgent('tess'), workflow: { edges: [['START', 'Ops']] } },
    'inner.yaml',
  );
  const cfg = config({
    syndicate_name: 'Front',
    orchestrator: { name: 'Front', model: 'scripted/front', instruction: 'Classify.' },
    subagents: [agent('Chat'), { name: 'Writer', description: 'works the tracker', yaml_reference: 'inner.yaml' }],
    dispatch: { default_route: 'Chat' },
  });
  const c = converse(cfg, 'tess', [inner], { 'inner.yaml': inner });
  c.models.front = new ScriptedModel('scripted/front', () => answer('{"route":"Writer","reason":"tracker"}'));
  const first = await c.turn([{ text: 'is T-1 open?' }]);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.deepEqual(first.consent?.path, ['Writer', 'Ops']);
  const stored = (await c.events('app')).length;
  const early = await c.turn([{ text: 'done?' }]);
  assert.equal(early.consent?.id, first.consent!.id);
  assert.equal((await c.events('app')).length, stored, 'a message before the grant stores nothing');
  await c.grant(first.consent!.authUri);
  const second = await c.turn([{ text: 'done' }]);
  assert.equal(second.status, 'completed', second.error?.message ?? second.text);
  assert.equal(second.route?.decidedBy, 'consent');
  assert.equal(second.route?.route, 'Writer');
  assert.equal(c.models.front!.calls, 1, 'the resume does not classify');
  assert.equal(second.text, 'Found: T-1 is open (for tess)');
});

test('schema: an authorization_code grant on an agent a map node runs is refused by name; a client_credentials grant is not', () => {
  const mapped = (auth: Record<string, unknown>) => ({
    syndicate_name: 'Room',
    memory_system: 'internal-only',
    orchestrator: agent('Plan'),
    subagents: [agent('Each', { mcp_server_url: 'https://tracker.example.com/sse', mcp_tools: ['lookup'], mcp_auth: auth }), agent('Wrap')],
    workflow: { edges: [['START', 'Plan', 'Items', 'Wrap']], nodes: { Items: { map: 'Each' } } },
  });
  assert.throws(() => config(mapped(oauth('pat'))), /an authorization_code grant \(a consent pause\) is not supported on an agent a map node runs/);
  const server = { ...oauth('pat').oauth2, grant: 'client_credentials', authorization_url: undefined, authorization_params: undefined };
  delete server.authorization_url;
  delete server.authorization_params;
  assert.doesNotThrow(() => config(mapped({ oauth2: server })));
  // The same agent as a plain node pauses as any node does.
  assert.doesNotThrow(() => room(opsAgent('pat')));
});

// ══ A durable run ════════════════════════════════════════════════════════════

test('a durable run checkpoints at the consent pause, and a run restored from that checkpoint stands at the same request without a model call', async () => {
  const cfg = room(opsAgent('quinn'));
  const rows = memoryCredentialRows();
  const store = credentialStore({ rows, cipher: aesGcmCipher(randomBytes(32)) });
  const consent = oauthConsent({ providers: oauthClientsFor([cfg]), redirectUri: 'http://127.0.0.1:9/oauth/callback', credentials: store });
  let latest: string | null = null;
  const sink: CheckpointSink = {
    load: async () => (latest ? (JSON.parse(latest) as RunCheckpoint) : null),
    save: async (cp) => {
      latest = JSON.stringify(cp);
      return true;
    },
  };
  const run = (models: Record<string, ScriptedModel>) => {
    resetCircuits();
    return runDurableTurn({
      config: cfg,
      parts: [{ text: 'is T-1 open?' }],
      appName: 'app',
      userId: 'quinn',
      runId: 'quinn:job-1',
      checkpoints: sink,
      compile: { resolveModel: shimResolver(models), log: () => {} },
      toolCredentials: { store, consent },
      trace: false,
    });
  };
  const fresh = () => Object.fromEntries(Object.entries(scripts()).map(([k, s]) => [k, new ScriptedModel(`scripted/${k}`, s)]));
  const callsBefore = mcpCalls.length;
  const firstModels = fresh();
  const first = await run(firstModels);
  assert.equal(first.status, 'input-required', first.error?.message ?? first.text);
  assert.equal(first.consent?.agent, 'Ops');
  const saved = JSON.parse(latest!) as RunCheckpoint;
  assert.ok(saved.steps > 0, 'the run checkpointed');
  assert.ok(JSON.stringify(saved).includes(first.consent!.id), 'the checkpoint holds the consent request');

  const againModels = fresh();
  const again = await run(againModels);
  assert.equal(again.status, 'input-required', again.error?.message ?? again.text);
  assert.ok(again.resumedFromStep > 0, 'restored from the checkpoint');
  assert.equal(again.consent?.id, first.consent!.id, 'the same request, no new flow');
  assert.equal(againModels.plan!.calls + againModels.ops!.calls + againModels.wrap!.calls, 0, 'no model call is paid again');
  assert.equal(mcpCalls.length, callsBefore, 'nothing reached the server');
});

