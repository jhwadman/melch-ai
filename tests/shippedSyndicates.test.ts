/**
 * tests/shippedSyndicates.test.ts — the package from source, as a consumer
 * meets it (ADR 0107): every shipped syndicate completes a turn on the
 * runtime, the A2A server answers a message, and the adk runtime that 1.0.0
 * removed is refused by name before any model call. The build's half is in
 * tests/packageSurface.test.ts.
 *
 * Offline: every model is scripted, and fetch is stubbed to refuse anything
 * but the child's own loopback server.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from './helpers/importGraph.ts';
import { everyExampleTurnScript, lastJson, moduleUrl, runChild } from './helpers/childProcess.ts';

const SHIPPED = fs
  .readdirSync(path.join(ROOT, 'config', 'agents'), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.yaml') && !f.endsWith('syndicateSchema.yaml'))
  .sort();

test('every shipped syndicate completes a turn, and the adk runtime is refused by name (source)', () => {
  assert.ok(SHIPPED.length >= 30, `${SHIPPED.length} syndicates`);
  // The one-agent critic (ADR 0109): an orchestrator answering in its own schema completes a turn too.
  assert.ok(SHIPPED.includes('examples/structured_critic.yaml'));
  const r = runChild(everyExampleTurnScript(ROOT, '.ts', SHIPPED), { env: { OTEL_CONSOLE_SPANS: 'false' } });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const got = lastJson<{ defaultRuntime: string; calls: number; adkCalls: number; turns: Record<string, string>; adkError: string }>(r.stdout);
  assert.equal(got.defaultRuntime, 'native');
  assert.deepEqual(Object.keys(got.turns), SHIPPED);
  assert.deepEqual(Object.entries(got.turns).filter(([, status]) => status !== 'completed'), [], 'every syndicate completes a turn');
  assert.ok(got.calls >= SHIPPED.length);
  assert.match(got.adkError, /^RuntimeRemovedError: The runtime option is "adk", but the adk runtime was removed in melchizedek-agents 1\.0\.0/);
  assert.equal(got.adkCalls, 0, 'the refusal comes before any model call');
});

test('the A2A server answers a message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipped-a2a-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'echo.yaml'),
      'syndicate_name: echo\nmemory_system: internal-only\norchestrator:\n  name: Echo\n  description: Echoes.\n  model: scripted\n  instruction: Echo.\n',
    );
    const m = (file: string) => JSON.stringify(moduleUrl(ROOT, file, '.ts'));
    const script = `
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (!String(url).startsWith('http://127.0.0.1:')) throw new Error('no network in this test: ' + String(url));
        return realFetch(url, init);
      };
      const { createA2AApp } = await import(${m('lib/a2a/app')});
      const scripted = {
        provider: 'scripted', model: 'scripted', calls: 0,
        async *generate() { this.calls += 1; yield { partial: false, parts: [{ type: 'text', text: 'hello from the engine' }], finishReason: 'stop' }; },
      };
      const secret = 'fixture-secret-0123456789abcdef0123456789';
      const built = await createA2AApp({ defaultSyndicate: 'echo.yaml', serverSecret: secret, keyMode: 'byok', resolveModel: () => scripted, log: () => {}, warn: () => {} });
      const server = await new Promise((resolve) => { const s = built.app.listen(0, '127.0.0.1', () => resolve(s)); });
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/echo/a2a/jsonrpc', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + secret, 'X-API-Key': 'fixture-caller', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] } } }),
      });
      const body = await res.json();
      server.close();
      const text = (body.result?.status?.message?.parts ?? []).concat(body.result?.artifacts?.flatMap((a) => a.parts) ?? []).map((p) => p.text ?? '').join(' ');
      console.log(JSON.stringify({ state: body.result?.status?.state, text, calls: scripted.calls, error: body.error ?? null }));
      process.exit(0);
    `;
    const r = runChild(script, { env: { OTEL_CONSOLE_SPANS: 'false', MELCHIZEDEK_AGENTS_DIR: dir, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', DATABASE_URL: '' } });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const got = lastJson<{ state: string; text: string; calls: number; error: unknown }>(r.stdout);
    assert.equal(got.error, null);
    assert.equal(got.state, 'completed');
    assert.match(got.text, /hello from the engine/);
    assert.equal(got.calls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the A2A server refuses to start under MELCHIZEDEK_RUNTIME=adk, naming 1.0.0', () => {
  const m = (file: string) => JSON.stringify(moduleUrl(ROOT, file, '.ts'));
  const script = `
    globalThis.fetch = async (url) => { throw new Error('no network in this test: ' + String(url)); };
    const { createA2AApp } = await import(${m('lib/a2a/app')});
    const { RuntimeRemovedError } = await import(${m('lib/runtime/runtimeFlag')});
    let error = '';
    try {
      await createA2AApp({ defaultSyndicate: 'tutor.yaml', serverSecret: 'fixture-secret-0123456789abcdef0123456789', log: () => {}, warn: () => {} });
    } catch (err) {
      error = (err instanceof RuntimeRemovedError ? 'RuntimeRemovedError: ' : 'other: ') + err.message;
    }
    console.log(JSON.stringify({ error }));
  `;
  const r = runChild(script, { env: { OTEL_CONSOLE_SPANS: 'false', MELCHIZEDEK_RUNTIME: 'adk', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', DATABASE_URL: '' } });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const got = lastJson<{ error: string }>(r.stdout);
  assert.match(got.error, /^RuntimeRemovedError: MELCHIZEDEK_RUNTIME is "adk", but the adk runtime was removed in melchizedek-agents 1\.0\.0/);
});
