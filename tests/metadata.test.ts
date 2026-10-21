/**
 * tests/metadata.test.ts — labels a turn carries into the ledger (ADR 0141):
 * `metadata:` in the YAML on the root span as `meta.<key>` and on an agent's
 * span as `meta.agent.<key>`, an A2A request's `Message.metadata` and
 * `X-Melch-Meta-*` headers on the root span under the same limits and
 * redaction, and A2AAppOptions.onTaskState firing per published state.
 * Offline: scripted models only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { createA2AApp } from '../lib/a2a/app.ts';
import type { A2AApp } from '../lib/a2a/app.ts';
import type { TaskStateRecord } from '../lib/a2a/executor.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { droppedHeaderWarning, headerMetadata, metaAttributes, requestMetadata } from '../lib/observability/metadata.ts';
import { patternRedactor, setTelemetryRedactor } from '../lib/observability/redact.ts';
import { onSpanEnd } from '../lib/observability/tracer.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { SyndicateValidationError, validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { ScriptedLlm, hangUntilAborted, text } from './helpers/scriptedLlm.ts';

// Obviously fake, but shaped like a key so the redactor's `secret` pattern matches it.
const FAKE_KEY = `sk-${'x'.repeat(24)}`;

const base = (extra: Record<string, unknown> = {}, orchestrator: Record<string, unknown> = {}) => ({
  syndicate_name: 'Meta',
  orchestrator: { name: 'Solo', model: 'scripted/solo', instruction: 'Answer.', ...orchestrator },
  subagents: [],
  ...extra,
});

const problems = (raw: unknown): string[] => {
  try {
    validateSyndicateConfig(raw, 'meta.yaml');
    return [];
  } catch (err) {
    assert.ok(err instanceof SyndicateValidationError);
    return err.issues;
  }
};

/** Every span that ends while `fn` runs. */
async function spansOf(fn: () => Promise<unknown>): Promise<ReadableSpan[]> {
  const spans: ReadableSpan[] = [];
  const off = onSpanEnd((s) => {
    if (s.name !== 'melchizedek.tracer.probe') spans.push(s);
  });
  try {
    await fn();
  } finally {
    off();
  }
  return spans;
}
const rootOf = (spans: ReadableSpan[]) => spans.find((s) => s.name.startsWith('Syndicate Execution: '));
const metaOf = (span: ReadableSpan | undefined) =>
  Object.fromEntries(Object.entries(span?.attributes ?? {}).filter(([k]) => k.startsWith('meta.')));

// ── 1. The YAML contract ─────────────────────────────────────────────────────

test('metadata: strings, numbers and booleans load on the syndicate and on an agent', () => {
  const cfg = validateSyndicateConfig(base({ metadata: { team: 'growth', tier: 2, beta: true } }, { metadata: { role: 'answerer' } }), 'meta.yaml');
  assert.deepEqual(cfg.metadata, { team: 'growth', tier: 2, beta: true });
  assert.deepEqual(cfg.orchestrator.metadata, { role: 'answerer' });
});

test('metadata: refuses more than 32 keys, a long or malformed key, a long value and a nested value', () => {
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]));
  assert.match(problems(base({ metadata: many })).join('\n'), /at most 32 metadata keys/);
  assert.match(problems(base({ metadata: { ['k'.repeat(65)]: 'x' } })).join('\n'), /metadata\.k+ — .*key/i);
  assert.match(problems(base({ metadata: { 'bad key': 'x' } })).join('\n'), /key/i);
  assert.match(problems(base({ metadata: { '.hidden': 'x' } })).join('\n'), /key/i);
  assert.ok(problems(base({ metadata: { long: 'v'.repeat(257) } })).length > 0);
  assert.ok(problems(base({ metadata: { nested: { a: 1 } } })).length > 0);
  assert.ok(problems(base({}, { metadata: { list: [1, 2] } })).length > 0);
  // The boundary itself loads.
  assert.deepEqual(problems(base({ metadata: { ['k'.repeat(64)]: 'v'.repeat(256) } })), []);
});

test('a credential-shaped metadata value is dropped at load with a warning that never quotes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-meta-'));
  writeFileSync(
    join(dir, 'leaky.yaml'),
    [
      'syndicate_name: Leaky',
      'variables:',
      `  pasted: ${FAKE_KEY}`,
      'metadata:',
      '  team: growth',
      `  api_key: ${FAKE_KEY}`,
      '  via_token: "{{pasted}}"',
      'orchestrator:',
      '  name: Solo',
      '  model: scripted/solo',
      '  instruction: Answer.',
      '  metadata:',
      `    token: ${FAKE_KEY}`,
      '    role: answerer',
      'subagents: []',
    ].join('\n'),
  );
  const warnings: string[] = [];
  const cfg = loadSyndicate('leaky.yaml', { agentsDir: dir, onWarning: (m) => warnings.push(m) });
  assert.deepEqual(cfg.metadata, { team: 'growth' });
  assert.deepEqual(cfg.orchestrator.metadata, { role: 'answerer' });
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((w) => w.includes('metadata.api_key')));
  assert.ok(warnings.some((w) => w.includes('metadata.via_token')));
  assert.ok(warnings.some((w) => w.includes('orchestrator.metadata.token')));
  for (const w of warnings) assert.ok(!w.includes(FAKE_KEY), 'a warning must not quote the value');
});

// ── 2. The spans ─────────────────────────────────────────────────────────────

test('YAML metadata lands as meta.<key> on the root span and meta.agent.<key> on the agent span, redacted', async () => {
  setTelemetryRedactor(patternRedactor(['secret', 'email']));
  try {
    const config = validateSyndicateConfig(
      base({ metadata: { team: 'growth', tier: 2, beta: true, owner: 'ana@example.com', leaked: FAKE_KEY } }, { metadata: { role: 'answerer' } }),
      'meta.yaml',
    );
    const spans = await spansOf(() =>
      runSyndicateTurn({
        config,
        parts: [{ text: 'hi' }],
        appName: 'meta',
        userId: 'u1',
        sessionId: `s-${crypto.randomUUID()}`,
        sessionService: new InProcessSessionService(),
        compile: { resolveModel: () => new ScriptedLlm('scripted/solo', () => text('ok')), log: () => {} },
        // The in-process caller's own attribute wins a clash with the YAML.
        trace: { attributes: { 'meta.tier': 'from-caller' } },
      }),
    );
    assert.deepEqual(metaOf(rootOf(spans)), {
      'meta.team': 'growth',
      'meta.tier': 'from-caller',
      'meta.beta': true,
      'meta.owner': '[redacted:email]',
    });
    const agent = spans.find((s) => s.name === 'agent.invoke Solo');
    assert.deepEqual(metaOf(agent), { 'meta.agent.role': 'answerer' });
  } finally {
    setTelemetryRedactor(undefined as never);
  }
});

// ── 3. Request metadata, checked ─────────────────────────────────────────────

test('request metadata keeps valid scalars only: no smuggled key, no reserved or agent.* key, no secret, at most the room left', () => {
  const warnings: string[] = [];
  const meta = requestMetadata(
    [
      { region: 'eu' },
      {
        region: 'us', // the header named it first
        customer: 'acme',
        plan: 'pro', // reserved: the YAML declares it
        'agent.role': 'x', // agent spans are the YAML's
        'meta.x\nsurface.name': 'evil',
        '../surface.name': 'evil',
        'a b': 'x',
        __proto__: 'x',
        ['k'.repeat(65)]: 'x',
        nested: { a: 1 },
        list: [1],
        big: 'v'.repeat(257),
        token: FAKE_KEY,
        n: 3,
        ok: false,
      },
    ],
    { reserved: new Set(['plan']), room: 4, warn: (m) => warnings.push(m) },
  );
  assert.deepEqual(meta, { region: 'eu', customer: 'acme', n: 3, ok: false });
  assert.equal(Object.getPrototypeOf(meta), Object.prototype);
  for (const w of warnings) assert.ok(!w.includes(FAKE_KEY) && !w.includes('evil'));
  assert.ok(warnings.some((w) => /looks like a key or token/.test(w)));

  // Too many keys: the first 32 are kept, the rest are counted.
  const flood = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
  const kept = requestMetadata([flood], { warn: (m) => warnings.push(m) });
  assert.equal(Object.keys(kept).length, 32);
  assert.ok(warnings.some((w) => /68 key\(s\) over the limit of 32/.test(w)));

  // A non-object metadata is nothing.
  assert.deepEqual(requestMetadata(['text', 42, null, [1, 2]]), {});
});

test('X-Melch-Meta-* headers: a malformed one refuses the request, a secret-shaped one is dropped', () => {
  assert.deepEqual(headerMetadata({ 'x-melch-meta-customer': 'acme', 'x-other': 'z' }), { meta: { customer: 'acme' } });
  assert.deepEqual(headerMetadata({ host: 'x' }), {});
  assert.match(headerMetadata({ 'x-melch-meta-': 'x' }).error ?? '', /metadata key/);
  assert.match(headerMetadata({ 'x-melch-meta-a b': 'x' }).error ?? '', /metadata key/);
  assert.match(headerMetadata({ 'x-melch-meta-long': 'v'.repeat(257) }).error ?? '', /longer than 256/);
  assert.match(headerMetadata({ 'x-melch-meta-agent.role': 'x' }).error ?? '', /reserved/);
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-melch-meta-k${i}`, 'v']));
  assert.match(headerMetadata(many).error ?? '', /at most 32/);
  const secret = headerMetadata({ 'x-melch-meta-token': FAKE_KEY, 'x-melch-meta-team': 'a' });
  assert.deepEqual(secret, { meta: { team: 'a' }, dropped: ['token'] });
  assert.ok(!droppedHeaderWarning('token').includes(FAKE_KEY));
  // Attributes are prefixed: no key reaches outside meta.*.
  assert.deepEqual(Object.keys(metaAttributes({ 'surface.name': 'x' })), ['meta.surface.name']);
});

// ── 4. Over A2A: metadata on the root span, and onTaskState ──────────────────

const agentsDir = mkdtempSync(join(tmpdir(), 'melch-meta-a2a-'));
writeFileSync(
  join(agentsDir, 'labelled.yaml'),
  ['syndicate_name: Labelled', 'metadata:', '  environment: prod', 'orchestrator:', '  name: Labelled', '  model: scripted/echo', '  instruction: Echo.', 'subagents: []'].join('\n'),
);
writeFileSync(join(agentsDir, 'hang.yaml'), ['syndicate_name: Hang', 'orchestrator:', '  name: Hang', '  model: scripted/hang', '  instruction: Hang.', 'subagents: []'].join('\n'));

let app: A2AApp;
let server: Server;
let url = '';
const states: TaskStateRecord[] = [];
const serverWarnings: string[] = [];

before(async () => {
  process.env.MELCHIZEDEK_AGENTS_DIR = agentsDir;
  app = await createA2AApp({
    defaultSyndicate: 'labelled.yaml',
    storage: { sessionService: new InProcessSessionService() },
    keyMode: 'server',
    resolveModel: (id) =>
      (id ?? '').endsWith('hang')
        ? new ScriptedLlm('scripted/hang', (_r, _n, signal) => hangUntilAborted(signal))
        : new ScriptedLlm('scripted/echo', () => text('echoed')),
    onTaskState: (r) => {
      states.push(r);
      if (r.state === 'rejected') throw new Error('a broken observer');
    },
    log: () => {},
    warn: (m) => serverWarnings.push(m),
  });
  server = await new Promise((resolve) => {
    const s = app.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => {
  server?.close();
});

async function sendWith(headers: Record<string, string>, metadata: unknown, path = '/a2a/jsonrpc', configuration?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'hi' }], ...(metadata !== undefined ? { metadata } : {}) },
        ...(configuration ? { configuration } : {}),
      },
    }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test('A2A: Message.metadata and X-Melch-Meta-* headers land as meta.* on the root span, under the YAML and the limits', async () => {
  let reply: Awaited<ReturnType<typeof sendWith>> | undefined;
  const spans = await spansOf(async () => {
    reply = await sendWith(
      { 'X-Melch-Meta-Customer': 'acme', 'X-Melch-Meta-Region': 'eu', 'X-Melch-Meta-Key': FAKE_KEY },
      {
        region: 'us', // the header wins
        environment: 'staging', // the YAML's own key: a caller cannot relabel it
        plan: 'pro',
        seats: 12,
        token: FAKE_KEY,
        'x\nsurface.name': 'evil',
        nested: { deep: true },
        'github.com/some/extension': { other: 'data' },
      },
    );
  });
  assert.equal(reply?.body.result.status.state, 'completed');
  assert.deepEqual(metaOf(rootOf(spans)), {
    'meta.environment': 'prod',
    'meta.customer': 'acme',
    'meta.region': 'eu',
    'meta.plan': 'pro',
    'meta.seats': 12,
  });
  assert.ok(!JSON.stringify(rootOf(spans)?.attributes).includes(FAKE_KEY));
  assert.ok(serverWarnings.every((w) => !w.includes(FAKE_KEY)));
  assert.ok(serverWarnings.some((w) => w.includes('X-Melch-Meta-key')));
  assert.ok(serverWarnings.some((w) => w.includes('Request metadata token')));
});

test('A2A: a request over the limits keeps the YAML’s keys and at most 32 in all', async () => {
  const flood = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 'v'.repeat(256)]));
  let reply: Awaited<ReturnType<typeof sendWith>> | undefined;
  const spans = await spansOf(async () => {
    reply = await sendWith({}, flood);
  });
  assert.equal(reply?.body.result.status.state, 'completed');
  const meta = metaOf(rootOf(spans));
  assert.equal(Object.keys(meta).length, 32);
  assert.equal(meta['meta.environment'], 'prod');
});

test('A2A: a malformed X-Melch-Meta-* header is refused before anything runs', async () => {
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-Melch-Meta-K${i}`, 'v']));
  assert.equal((await sendWith(many, undefined)).status, 400);
  assert.equal((await sendWith({ 'X-Melch-Meta-Long': 'v'.repeat(300) }, undefined)).status, 400);
  assert.equal((await sendWith({ 'X-Melch-Meta-agent.role': 'x' }, undefined)).status, 400);
});

test('A2A: onTaskState reports each state the executor publishes, once per state', async () => {
  states.length = 0;
  const done = await sendWith({}, undefined);
  const taskId = done.body.result.id;
  const mine = states.filter((s) => s.taskId === taskId);
  assert.deepEqual(mine.map((s) => s.state), ['submitted', 'completed']);
  for (const s of mine) {
    assert.equal(s.syndicate, 'Labelled');
    assert.equal(s.agentId, 'default');
    assert.equal(s.contextId, done.body.result.contextId);
    assert.equal(typeof s.at, 'number');
  }
  assert.equal(mine[0].traceId, undefined);
  assert.match(mine[1].traceId ?? '', /^[0-9a-f]{32}$/);

  // A canceled task: submitted, then canceled, read back through tasks/get too.
  states.length = 0;
  const sent = await sendWith({}, undefined, '/hang/a2a/jsonrpc', { blocking: false });
  const id = sent.body.result.id;
  const rpc = (method: string, params: unknown) =>
    fetch(`${url}/hang/a2a/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) }).then((r) => r.json() as Promise<any>);
  await rpc('tasks/cancel', { id });
  for (let i = 0; i < 100 && !states.some((s) => s.taskId === id && s.state === 'canceled'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(states.filter((s) => s.taskId === id).map((s) => s.state), ['submitted', 'canceled']);
  const got = await rpc('tasks/get', { id });
  assert.equal(got.result.status.state, 'canceled');
});

test('A2A: a throwing onTaskState never fails the task', async () => {
  // The observer above throws on `rejected`; a message with no text is rejected, and the reply still arrives.
  states.length = 0;
  const res = await fetch(`${url}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [] } } }),
  });
  const body = (await res.json()) as any;
  assert.equal(body.result.status.state, 'rejected');
  assert.deepEqual(states.map((s) => s.state), ['submitted', 'rejected']);
});
