/**
 * tests/optionalAdk.test.ts — @google/adk is an optional peer (WS5-1,
 * ADR 0102).
 *
 * With ADK installed (this process), lib/adkPeer.ts hands every module
 * ADK's own classes, so the adk runtime is unchanged. Without it (a child
 * process whose resolver answers @google/adk as Node does for a package that
 * is not installed), the package loads, every shipped syndicate completes a
 * turn on the default runtime, the A2A server answers a message, and each
 * thing only ADK runs fails with AdkNotInstalledError, which names the
 * package. The build's half of the proof is in tests/packageSurface.test.ts.
 *
 * Offline: every model is scripted, fetch is stubbed to refuse anything but
 * the child's own loopback server.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as adkModule from '@google/adk';

import { ADK_PACKAGE, AdkNotInstalledError, BaseLlm, BaseSessionService, BaseTool, BaseToolset, FunctionTool, GOOGLE_SEARCH, Gemini, adk, adkInstalled, adkVersion, requireAdk } from '../lib/adkPeer.ts';
import { ROOT } from './helpers/importGraph.ts';
import { everyExampleTurnScript, lastJson, moduleUrl, runWithoutAdk } from './helpers/withoutAdk.ts';

const SHIPPED = fs
  .readdirSync(path.join(ROOT, 'config', 'agents'), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.yaml') && !f.endsWith('syndicateSchema.yaml'))
  .sort();

// ── With ADK installed ───────────────────────────────────────────────────────

test('with @google/adk installed, the peer module hands out ADK\'s own values', async () => {
  assert.equal(ADK_PACKAGE, '@google/adk');
  assert.equal(adkInstalled(), true);
  assert.equal(adk, adkModule);
  assert.equal(requireAdk('a test'), adkModule);
  assert.equal(BaseTool, adkModule.BaseTool);
  assert.equal(FunctionTool, adkModule.FunctionTool);
  assert.equal(BaseToolset, adkModule.BaseToolset);
  assert.equal(BaseLlm, adkModule.BaseLlm);
  assert.equal(Gemini, adkModule.Gemini);
  assert.equal(BaseSessionService, adkModule.BaseSessionService);
  assert.equal(GOOGLE_SEARCH, adkModule.GOOGLE_SEARCH);
  assert.match((await adkVersion()) ?? '', /^\d+\.\d+\.\d+/);
});

test('AdkNotInstalledError names the feature, the package and both ways out', () => {
  const err = new AdkNotInstalledError('The adk runtime');
  assert.equal(err.name, 'AdkNotInstalledError');
  assert.equal(err.feature, 'The adk runtime');
  assert.match(err.message, /^The adk runtime needs @google\/adk, which is not installed\./);
  assert.match(err.message, /npm install @google\/adk@~2\.2\.0/);
  assert.match(err.message, /run on the native runtime/);
});

// ── Without ADK ──────────────────────────────────────────────────────────────

test('without @google/adk, every shipped syndicate completes a turn on the default runtime, and adk names the package (source)', () => {
  assert.ok(SHIPPED.length >= 30, `${SHIPPED.length} syndicates`);
  const r = runWithoutAdk(everyExampleTurnScript(ROOT, '.ts', SHIPPED), { env: { OTEL_CONSOLE_SPANS: 'false' } });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const got = lastJson<{ blocked: boolean; installed: boolean; defaultRuntime: string; calls: number; turns: Record<string, string>; adkError: string }>(r.stdout);
  assert.equal(got.blocked, true, 'the hook makes @google/adk unresolvable');
  assert.equal(got.installed, false);
  assert.equal(got.defaultRuntime, 'native');
  assert.deepEqual(Object.keys(got.turns), SHIPPED);
  assert.deepEqual(Object.entries(got.turns).filter(([, status]) => status !== 'completed'), [], 'every syndicate completes a turn');
  assert.ok(got.calls >= SHIPPED.length);
  assert.match(got.adkError, /^AdkNotInstalledError: The adk runtime \(MELCHIZEDEK_RUNTIME=adk, or the turn's runtime option\) needs @google\/adk/);
});

test('without @google/adk, the stand-ins carry what the engine reads, and every ADK-only path names the package', () => {
  const m = (file: string) => JSON.stringify(moduleUrl(ROOT, file, '.ts'));
  const script = `
    globalThis.fetch = async (url) => { throw new Error('no network in this test: ' + String(url)); };
    const { AdkNotInstalledError, FunctionTool, BaseTool, GOOGLE_SEARCH } = await import(${m('lib/adkPeer')});
    const { toFunctionTool } = await import(${m('lib/tools/adkTool')});
    const { toolOf } = await import(${m('lib/tools/tool')});
    const { defineTool } = await import(${m('lib/tools/toolContract')});
    const { nativeToolOf } = await import(${m('lib/models/schemaNormalize')});
    const registry = await import(${m('lib/models/registry')});
    const { GeminiAdapter } = await import(${m('lib/models/geminiAdapter')});
    const { compileGraph } = await import(${m('lib/compile')});
    const { compileWorkflow } = await import(${m('lib/workflow')});
    const { loadSyndicate } = await import(${m('lib/loadSyndicate')});
    const { runWikiAgent } = await import(${m('lib/wiki/agentRun')});
    const { retryPlugins } = await import(${m('lib/runtime/syndicateTurn')});
    const { InProcessSessionService } = await import(${m('lib/runtime/sessions')});
    const { asAdkSessionService } = await import(${m('lib/runtime/adkSessionBridge')});
    const { WEB_SEARCH } = await import(${m('lib/tools/webSearchTool')});
    const { z } = await import('zod');

    const named = async (fn) => {
      try { await fn(); return 'no error'; } catch (err) { return (err instanceof AdkNotInstalledError ? 'AdkNotInstalledError: ' : 'other: ') + err.message.split('\\n')[0]; }
    };
    const out = {};

    const own = defineTool({ name: 'echo', description: 'Echo.', schema: z.object({ text: z.string() }), execute: async ({ text }) => text });
    const fn = toFunctionTool(own);
    out.functionTool = { isFunctionTool: fn instanceof FunctionTool, isBaseTool: fn instanceof BaseTool, name: fn.name, carries: toolOf(fn)?.name, runAsync: await named(() => fn.runAsync({ args: {} })) };
    out.sentinels = { webSearch: WEB_SEARCH.name, webSearchNative: nativeToolOf(WEB_SEARCH), googleSearch: GOOGLE_SEARCH.name, googleSearchNative: nativeToolOf(GOOGLE_SEARCH) };

    out.statuses = registry.registerAvailableProviders().length;
    process.env.GOOGLE_GENAI_API_KEY = 'fixture-gemini';
    out.geminiDefault = registry.resolveAdapter('gemini-x') instanceof GeminiAdapter;
    out.geminiAdk = await named(() => registry.resolveAdapter('gemini-x', { gemini: 'adk' }));
    const traced = registry.resolveModel('gemini-x', { apiKey: 'fixture-caller' });
    out.tracedGemini = { marked: traced[Symbol.for('google.adk.geminiModel')] === true, apiKey: traced.apiKey === 'fixture-caller', call: await named(async () => { for await (const _ of traced.generateContentAsync({})) {} }) };

    out.compileGraph = await named(() => compileGraph(loadSyndicate('examples/delegation.yaml')));
    out.compileWorkflow = await named(() => compileWorkflow(loadSyndicate('examples/pipeline.yaml')));
    out.retryPlugins = await named(() => retryPlugins(undefined));
    out.retryPluginsOff = retryPlugins({ model_errors: 0, tool_errors: 0 }).length;
    out.wikiAdk = await named(() => runWikiAgent({ name: 'w', description: 'w', model: 'ollama/x', instruction: 'i', userText: 'u', runtime: 'adk' }));

    const store = asAdkSessionService(new InProcessSessionService());
    const session = await store.getOrCreateSession({ appName: 'a', userId: 'u', sessionId: 's' });
    out.store = { created: session?.id === 's', again: (await store.getOrCreateSession({ appName: 'a', userId: 'u', sessionId: 's' }))?.id === 's', appendEvent: await named(() => store.appendEvent({ session, event: { id: 'e', author: 'user', invocationId: 'i', actions: {}, timestamp: 1 } })) };

    console.log(JSON.stringify(out));
  `;
  const r = runWithoutAdk(script, { env: { OTEL_CONSOLE_SPANS: 'false' } });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const got = lastJson<Record<string, any>>(r.stdout);
  const adkOnly = /^AdkNotInstalledError: .*needs @google\/adk, which is not installed/;

  assert.deepEqual({ ...got.functionTool, runAsync: undefined }, { isFunctionTool: true, isBaseTool: true, name: 'echo', carries: 'echo', runAsync: undefined });
  assert.match(got.functionTool.runAsync, adkOnly, 'the tool\'s ADK face needs ADK');
  assert.deepEqual(got.sentinels, { webSearch: 'web_search', webSearchNative: 'web_search', googleSearch: 'google_search', googleSearchNative: 'google_search' });

  assert.equal(got.statuses, 6, 'registerAvailableProviders reports every provider and registers nothing');
  assert.equal(got.geminiDefault, true, 'a Gemini id gets the engine adapter');
  assert.match(got.geminiAdk, /^AdkNotInstalledError: GEMINI_ADAPTER=adk/);
  assert.equal(got.tracedGemini.marked, true, 'resolveModel\'s Gemini carries ADK\'s mark, as the native compile reads it');
  assert.equal(got.tracedGemini.apiKey, true, 'and the caller\'s key');
  assert.match(got.tracedGemini.call, adkOnly);

  assert.match(got.compileGraph, /^AdkNotInstalledError: Compiling an agent for the ADK runtime/);
  assert.match(got.compileWorkflow, /^AdkNotInstalledError: ADK's Workflow/);
  assert.match(got.retryPlugins, /^AdkNotInstalledError: ADK's retry plugins/);
  assert.equal(got.retryPluginsOff, 0, 'no plugin asked for, nothing to load');
  assert.match(got.wikiAdk, /^AdkNotInstalledError: A wiki agent on the adk runtime/);

  assert.equal(got.store.created, true);
  assert.equal(got.store.again, true, 'getOrCreateSession reads the session it created');
  assert.match(got.store.appendEvent, adkOnly, 'the ADK face\'s append is the ADK runner\'s');
});

test('without @google/adk, the A2A server answers a message on the default runtime', () => {
  const m = (file: string) => JSON.stringify(moduleUrl(ROOT, file, '.ts'));
  const dir = fs.mkdtempSync(path.join(ROOT, '.optional-adk-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'echo.yaml'),
      ['syndicate_name: Echo', 'orchestrator:', '  name: Echo', '  model: claude-sonnet-4-6', '  instruction: Answer.', 'subagents: []'].join('\n'),
    );
    const script = `
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (!String(url).startsWith('http://127.0.0.1:')) throw new Error('no network in this test: ' + String(url));
        return realFetch(url, init);
      };
      const { createA2AApp } = await import(${m('lib/a2a/app')});
      const scripted = {
        provider: 'scripted', model: 'scripted', calls: 0,
        async *generate() { this.calls += 1; yield { partial: false, parts: [{ type: 'text', text: 'hello from native' }], finishReason: 'stop' }; },
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
    const r = runWithoutAdk(script, { env: { OTEL_CONSOLE_SPANS: 'false', MELCHIZEDEK_AGENTS_DIR: dir, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', DATABASE_URL: '' } });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const got = lastJson<{ state: string; text: string; calls: number; error: unknown }>(r.stdout);
    assert.equal(got.error, null);
    assert.equal(got.state, 'completed');
    assert.match(got.text, /hello from native/);
    assert.equal(got.calls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
