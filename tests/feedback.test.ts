/**
 * tests/feedback.test.ts — POST /feedback and /:agentId/feedback (ADR 0140)
 * on an ephemeral port, offline: the bearer, validation, the 32 KB body
 * limit, the per-turn-per-user minute, the redactor on the comment, the
 * caller's own turns only, and the adk_labels row the desktop app reads
 * (melch-app tests/unit/db/feedback.test.ts plants rows in this shape). The
 * Postgres store against the real ledger schema is in feedbackPostgres.test.ts.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.TELEMETRY_REDACT;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { createA2AApp } from '../lib/a2a/app.ts';
import type { A2AApp } from '../lib/a2a/app.ts';
import { feedbackLimiter, isFeedbackPath, mayRate, parseFeedback } from '../lib/a2a/feedback.ts';
import type { FeedbackRow, FeedbackStore, FeedbackTurn } from '../lib/a2a/feedback.ts';
import { ScriptedLlm, text } from './helpers/scriptedLlm.ts';

const SECRET = 'test-secret-feedback-0123456789abcdef'; // gitleaks:allow (test fixture)
// A credential-shaped string the redactor must keep out of the label.
const FAKE_KEY = 'sk-ant-api03-' + 'x'.repeat(40); // gitleaks:allow (test fixture)
const TRACE = 'a'.repeat(32);
const OTHER_TRACE = 'b'.repeat(32);

const dir = mkdtempSync(join(tmpdir(), 'melch-feedback-'));
writeFileSync(join(dir, 'echo.yaml'), ['syndicate_name: Echo', 'orchestrator:', '  name: Echo', '  model: scripted/echo', '  instruction: Echo.', 'subagents: []'].join('\n'));
writeFileSync(join(dir, 'other.yaml'), ['syndicate_name: Other', 'orchestrator:', '  name: Other', '  model: scripted/echo', '  instruction: Echo.', 'subagents: []'].join('\n'));
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

/** The ledger as a map: turns by trace and task id, and the labels written. */
function memoryStore(turns: Array<FeedbackTurn & { taskId?: string }>): FeedbackStore & { rows: FeedbackRow[]; failNext: boolean } {
  const rows: FeedbackRow[] = [];
  const store = {
    rows,
    failNext: false,
    async turn(ref: { taskId: string } | { traceId: string }) {
      const t = turns.find((x) => ('taskId' in ref ? x.taskId === ref.taskId : x.traceId === ref.traceId));
      return t ? { traceId: t.traceId, userId: t.userId } : null;
    },
    async add(row: FeedbackRow) {
      if (store.failNext) {
        store.failNext = false;
        throw new Error('down');
      }
      rows.push(row);
    },
  };
  return store;
}

const store = memoryStore([
  { traceId: TRACE, userId: 'default', taskId: 'task-1' },
  { traceId: OTHER_TRACE, userId: 'default' },
]);

const servers: Server[] = [];
async function serve(options: Partial<Parameters<typeof createA2AApp>[0]> = {}): Promise<{ app: A2AApp; base: string }> {
  const app = await createA2AApp({
    defaultSyndicate: 'echo.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InProcessSessionService(), feedback: store },
    resolveModel: () => new ScriptedLlm('scripted/echo', () => text('ok')),
    servedAgents: ['other'],
    log: () => {},
    warn: () => {},
    ...options,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const addr = server.address();
  return { app, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

let base = '';
before(async () => {
  base = (await serve()).base;
});
after(() => {
  for (const s of servers) s.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${SECRET}` }, b = base) =>
  fetch(`${b}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the body: one turn id, a score of up, down or 1–5, an optional comment and user id; errors never echo the value', () => {
  assert.equal(parseFeedback({ traceId: TRACE, score: 'up' }).ok, true);
  assert.equal(parseFeedback({ taskId: 'task-1', score: 5, comment: 'Good', userId: 'u-1' }).ok, true);
  for (const bad of [
    { traceId: TRACE, score: 0 },
    { traceId: TRACE, score: 6 },
    { traceId: TRACE, score: 2.5 },
    { traceId: TRACE, score: 'meh' },
    { traceId: TRACE, score: '5' },
    { traceId: TRACE },
    { score: 'up' },
    { traceId: TRACE, taskId: 'task-1', score: 'up' },
    { traceId: 'has space', score: 'up' },
    { traceId: TRACE, score: 'up', comment: 'x'.repeat(4_001) },
    { traceId: TRACE, score: 'up', userId: '' },
    { traceId: TRACE, score: 'up', userId: FAKE_KEY },
    { traceId: TRACE, score: 'up', extra: 1 },
    [],
    null,
  ]) {
    const r = parseFeedback(bad);
    assert.equal(r.ok, false, JSON.stringify(bad)?.slice(0, 60));
    if (!r.ok) {
      assert.doesNotMatch(r.error, /meh|has space|sk-ant/, 'the message names the rule, not the value');
    }
  }
  const blank = parseFeedback({ traceId: TRACE, score: 'down', comment: '   ' });
  assert.ok(blank.ok && blank.value.comment === null, 'a blank comment is no comment');
  assert.equal(isFeedbackPath('/feedback'), true);
  assert.equal(isFeedbackPath('/other/feedback'), true);
  assert.equal(isFeedbackPath('/a2a/feedback/x'), false);
});

test('401 without the bearer, and with a wrong one', async () => {
  assert.equal((await post('/feedback', { traceId: TRACE, score: 'up' }, {})).status, 401);
  assert.equal((await post('/feedback', { traceId: TRACE, score: 'up' }, { Authorization: 'Bearer nope' })).status, 401);
  assert.equal((await post('/other/feedback', { traceId: TRACE, score: 'up' }, {})).status, 401);
  assert.equal(store.rows.length, 0);
});

test('400 for a bad score, both ids, neither id, a non-JSON body; 413 over 32 KB', async () => {
  for (const body of [{ traceId: TRACE, score: 7 }, { traceId: TRACE, taskId: 'task-1', score: 'up' }, { score: 'up' }]) {
    const r = await post('/feedback', body);
    assert.equal(r.status, 400);
    assert.ok(((await r.json()) as { error?: string }).error);
  }
  assert.equal((await post('/feedback', '{not json')).status, 400);
  const huge = await post('/feedback', { traceId: TRACE, score: 'up', comment: 'y'.repeat(40_000) });
  assert.equal(huge.status, 413);
  const msg = await huge.text();
  assert.doesNotMatch(msg, /yyyy/, 'the refusal does not echo the body');
  assert.match(msg, /^\{/, 'answered as JSON, not an HTML stack');
  assert.equal(store.rows.length, 0);
});

test('a rating writes the row the app reads: ref = trace_id, labeler end-user, fields { score, userId }, the comment redacted in note', async () => {
  const r = await post('/feedback', { traceId: TRACE, score: 'down', comment: `Wrong refund policy. My key is ${FAKE_KEY}`, userId: 'u1' });
  assert.equal(r.status, 201);
  const body = await r.text();
  assert.deepEqual(JSON.parse(body), { ok: true, traceId: TRACE });
  assert.doesNotMatch(body, /refund|sk-ant/, 'the answer repeats nothing that was sent');
  const row = store.rows.at(-1)!;
  assert.deepEqual(Object.keys(row).sort(), ['fields', 'labeler', 'note', 'ref', 'trace_id']);
  assert.equal(row.ref, TRACE);
  assert.equal(row.trace_id, TRACE);
  assert.equal(row.labeler, 'end-user');
  assert.deepEqual(row.fields, { score: 'down', userId: 'u1' });
  assert.equal(row.note, 'Wrong refund policy. My key is [redacted:secret]');

  // A 1–5 score is a number; no comment and no user id are nulls.
  assert.equal((await post('/feedback', { taskId: 'task-1', score: 4 })).status, 201);
  assert.deepEqual(store.rows.at(-1), { ref: TRACE, trace_id: TRACE, labeler: 'end-user', fields: { score: 4, userId: null }, note: null });
});

test('one label per turn and user per minute: 429 with Retry-After; another user or turn is not held back', async () => {
  const first = await post('/feedback', { traceId: OTHER_TRACE, score: 'up', userId: 'u7' });
  assert.equal(first.status, 201);
  const again = await post('/feedback', { traceId: OTHER_TRACE, score: 'down', userId: 'u7' });
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers.get('retry-after')) > 0);
  assert.equal((await post('/feedback', { traceId: OTHER_TRACE, score: 'down', userId: 'u8' })).status, 201, 'another user');
  // By task id or trace id, the same turn is the same key.
  assert.equal((await post('/feedback', { traceId: TRACE, score: 1, userId: 'u7' })).status, 201);
  assert.equal((await post('/feedback', { taskId: 'task-1', score: 1, userId: 'u7' })).status, 429);
  // A failed write gives the minute back.
  store.failNext = true;
  assert.equal((await post('/feedback', { traceId: OTHER_TRACE, score: 'up', userId: 'u9' })).status, 503);
  assert.equal((await post('/feedback', { traceId: OTHER_TRACE, score: 'up', userId: 'u9' })).status, 201);

  const lim = feedbackLimiter(60_000, () => 0);
  assert.equal(lim.take('k').ok, true);
  assert.equal(lim.take('k').ok, false);
});

test('an unknown turn is 404; the per-agent route checks the agent; no ledger is 501', async () => {
  const missing = await post('/feedback', { traceId: 'c'.repeat(32), score: 'up' });
  assert.equal(missing.status, 404);
  assert.equal((await post('/other/feedback', { traceId: OTHER_TRACE, score: 3, userId: 'agent-route' })).status, 201);
  assert.equal((await post('/not-served/feedback', { traceId: OTHER_TRACE, score: 3 })).status, 404);
  const { base: bare } = await serve({ storage: { sessionService: new InProcessSessionService() } });
  assert.equal((await post('/feedback', { traceId: TRACE, score: 'up' }, undefined, bare)).status, 501);
});

test('behind an authenticator, an end user rates only turns from their own scope; another scope gets the same 404', async () => {
  const mine = memoryStore([
    { traceId: TRACE, userId: 'alice' },
    { traceId: OTHER_TRACE, userId: 'bob' },
  ]);
  const { base: b } = await serve({
    serverSecret: undefined,
    storage: { sessionService: new InProcessSessionService(), feedback: mine },
    resolveRequest: (req) => {
      const who = req.headers['x-test-user'];
      return typeof who === 'string' ? { scopeKey: who, caller: 'jwt' } : undefined;
    },
  });
  assert.equal((await post('/feedback', { traceId: TRACE, score: 'up' }, {}, b)).status, 401, 'no identity');
  assert.equal((await post('/feedback', { traceId: TRACE, score: 'up' }, { 'X-Test-User': 'alice' }, b)).status, 201);
  const theirs = await post('/feedback', { traceId: OTHER_TRACE, score: 'down' }, { 'X-Test-User': 'alice' }, b);
  assert.equal(theirs.status, 404);
  assert.equal(mine.rows.length, 1);

  assert.equal(mayRate({ scopeKey: 'acme', ownsNested: true }, 'acme/u1'), true, 'a caller owning nested scopes');
  assert.equal(mayRate({ scopeKey: 'acme', ownsNested: false }, 'acme/u1'), false);
  assert.equal(mayRate({ scopeKey: 'acme' }, 'acmex'), false);
  assert.equal(mayRate({ scopeKey: 'x', operator: true }, 'anyone'), true, 'an operator credential');
  assert.equal(mayRate({ scopeKey: 'x' }, null), false);
});

test('the server-wide body limit still applies to the A2A routes', async () => {
  const r = await fetch(`${base}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nothing', params: { pad: 'z'.repeat(40_000) } }),
  });
  assert.notEqual(r.status, 413, 'a 40 KB task body is under the 1 MB default');
});
