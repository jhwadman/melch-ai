/**
 * Offline tests of SCRIPT orchestration (lib/script/, ADR 0137 Part B):
 * runSyndicateTurn on a `script:` syndicate with scripted models, the
 * script itself run for real in the sandbox. Routing, per-call models,
 * conversation calls, parallel, the pause and its replay, divergence, the
 * schema's refusals and the switch.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';
process.env.MELCHIZEDEK_CODE_SANDBOX = 'on';

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateTurnResult } from '../lib/runtime/syndicateTurn.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { validateSyndicateConfig } from '../lib/syndicateSchema.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { CodeSandboxOffError } from '../lib/sandbox/sandbox.ts';
import { SCRIPT_CALL, openRun } from '../lib/script/journal.ts';
import { runScript } from '../lib/script/run.ts';
import { ScriptedModel, answer, lastToolResult, requestTexts, shimResolver, toolCall, untilAborted } from './helpers/scriptedModel.ts';
import { z } from 'zod';
import { registerTool } from '../lib/toolRegistry.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { approvalResponsePart } from '../lib/runtime/approvals.ts';
import { runDurableTurn } from '../lib/runtime/native/checkpoint.ts';
import type { RunCheckpoint } from '../lib/runtime/native/checkpoint.ts';
import { onSpanEnd } from '../lib/observability/tracer.ts';

const APP = 'desk';
const USER = 'u1';

const TRIAGE_SCHEMA = { type: 'object', properties: { route: { type: 'string' }, risky: { type: 'boolean' } }, required: ['route'] };

function deskConfig(source: string, extra: Partial<SyndicateYamlConfig> = {}): SyndicateYamlConfig {
  return validateSyndicateConfig({
    syndicate_name: 'Desk',
    script: { source, models: ['scripted/big'], ...((extra as { script?: object }).script ?? {}) },
    orchestrator: { name: 'Triage', model: 'scripted/triage', instruction: 'Classify.', output: { schema: TRIAGE_SCHEMA } },
    subagents: [
      { name: 'Analyst', model: 'scripted/analyst', instruction: 'Analyze.', description: 'numbers' },
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      { name: 'Editor', model: 'scripted/editor', instruction: 'Edit.', description: 'edits' },
    ],
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'script')),
  });
}

function models(overrides: Partial<Record<string, ScriptedModel>> = {}) {
  return {
    triage: new ScriptedModel('triage', (req) => answer(JSON.stringify({ route: /hello/i.test(requestTexts(req).join(' ')) ? 'Chat' : 'Analyst', risky: /risky/.test(requestTexts(req).join(' ')) }))),
    analyst: new ScriptedModel('analyst', (req) => answer(`analysis of: ${requestTexts(req).at(-1)}`)),
    chat: new ScriptedModel('chat', (req) => answer(`hi! (${requestTexts(req).length} texts in view)`)),
    editor: new ScriptedModel('editor', (req) => answer(`edited: ${requestTexts(req).at(-1)}`)),
    big: new ScriptedModel('big', () => answer('the big model answered')),
    ...overrides,
  } as Record<string, ScriptedModel>;
}

function turner(config: SyndicateYamlConfig, m: Record<string, ScriptedModel>, sessions = new InProcessSessionService()) {
  const progress: string[] = [];
  const run = (text: string, sessionId = 's1'): Promise<SyndicateTurnResult> =>
    runSyndicateTurn({
      config,
      parts: [{ text }],
      appName: APP,
      userId: USER,
      sessionId,
      sessionService: sessions,
      compile: { resolveModel: shimResolver(m) },
      trace: false,
      events: { onProgress: (t) => progress.push(t) },
    });
  return { run, sessions, progress };
}

const ROUTER = `export default async ({ message, transcript, agent, log }) => {
  let route = 'Analyst';
  try {
    const triage = await agent('Triage', transcript ? transcript + '\\n--- MESSAGE ---\\n' + message : message);
    if (['Analyst', 'Chat'].includes(triage.route)) route = triage.route;
  } catch (e) {
    log('Routing fell back: ' + e.message);
  }
  log('Routed to ' + route);
  return agent(route, null, { conversation: true });
};`;

test('script: routes in code, the route answers in the conversation, and the next turn sees the history', async () => {
  const m = models();
  const { run, sessions, progress } = turner(deskConfig(ROUTER), m);
  const first = await run('what is 2+2?');
  assert.equal(first.status, 'completed', JSON.stringify(first.error));
  assert.equal(first.text, 'analysis of: what is 2+2?');
  assert.ok(progress.includes('Routed to Analyst'));
  const second = await run('hello there');
  assert.equal(second.text, 'hi! (3 texts in view)');
  // The classifier read the transcript digest of the first exchange.
  assert.match(requestTexts(m.triage!.requests[1]!).join(' '), /analysis of: what is 2\+2\?/);
  // A run that finished stores no journal: the conversation keeps the exchange, as for a dispatch route.
  const session = await sessions.get({ appName: APP, userId: USER, sessionId: 's1' });
  assert.equal(session!.events.filter((e) => e.actions.agentState?.[SCRIPT_CALL]).length, 0);
  assert.deepEqual(session!.events.filter((e) => e.content?.parts?.some((p) => p.text)).map((e) => e.author), ['user', 'Analyst', 'user', 'Chat']);
});

test('script: a failed classifier falls back in the script (fail-static is code now)', async () => {
  const m = models({ triage: new ScriptedModel('triage', () => answer('not json')) });
  const { run, progress } = turner(deskConfig(ROUTER), m);
  const r = await run('hello');
  assert.equal(r.status, 'completed');
  assert.match(r.text, /^analysis of: hello/);
  assert.ok(progress.some((p) => /Routing fell back: Triage answered \d+ characters that are not the JSON/.test(p)));
});

test('script: agent() moves a call to a listed model, and refuses one not listed', async () => {
  const m = models();
  const source = `export default async ({ agent }) => {
    const big = await agent('Analyst', 'hard question', { model: 'scripted/big' });
    let refused = '';
    try { await agent('Analyst', 'x', { model: 'scripted/unlisted' }) } catch (e) { refused = e.message }
    return { big, refused };
  };`;
  const r = await turner(deskConfig(source), m).run('go');
  assert.equal(r.status, 'completed', JSON.stringify(r.error));
  const out = JSON.parse(r.text);
  assert.equal(out.big, 'the big model answered');
  assert.match(out.refused, /not in script\.models/);
  assert.equal(m.analyst!.calls, 0);
});

test('script: parallel runs calls concurrently and returns them in call order', async () => {
  const slow = (name: string, ms: number) => new ScriptedModel(name, async () => {
    await new Promise((res) => setTimeout(res, ms));
    return answer(name);
  });
  const m = models({ analyst: slow('analyst', 60), chat: slow('chat', 5), editor: slow('editor', 30) });
  const source = `export default async ({ agent, parallel }) => (await parallel(['Analyst', 'Chat', 'Editor'].map((a) => () => agent(a, 'q')))).join(',');`;
  const started = Date.now();
  const r = await turner(deskConfig(source), m).run('go');
  assert.equal(r.text, 'analyst,chat,editor');
  assert.ok(Date.now() - started < 400);
});

const CONFIRM = `export default async ({ message, agent, askUser, now }) => {
  const t = await now();
  const triage = await agent('Triage', message);
  const draft = await agent(triage.route, message);
  if (triage.risky) {
    const ok = await askUser('confirm-send', 'Send this reply?', { payload: { draft } });
    if (!/^y/i.test(ok.reply)) return agent('Editor', { draft, notes: ok.reply });
  }
  return draft + ' @' + (typeof t);
};`;

test('script: askUser pauses the turn input-required; the answer resumes it by replaying the journal', async () => {
  const m = models();
  const { run, sessions } = turner(deskConfig(CONFIRM), m);
  const paused = await run('a risky question');
  assert.equal(paused.status, 'input-required', JSON.stringify(paused.error));
  assert.equal(paused.input?.node, 'Desk');
  assert.equal(paused.input?.message, 'Send this reply?');
  assert.deepEqual(paused.input?.payload, { draft: 'analysis of: a risky question' });
  const events = (await sessions.get({ appName: APP, userId: USER, sessionId: 's1' }))!.events;
  const open = openRun(events, 'Desk');
  assert.ok(open?.pin.source.includes('confirm-send'));
  // The paused run stored its journal: one content-less event per call, then the pause.
  const journal = events.filter((e) => e.actions.agentState?.[SCRIPT_CALL]);
  assert.deepEqual(journal.map((e) => (e.actions.agentState![SCRIPT_CALL] as { kind: string }).kind), ['now', 'agent', 'agent', 'askUser']);
  assert.ok(journal.slice(0, 3).every((e) => e.author === 'Desk' && !e.content && e.nodeInfo?.path?.startsWith('Desk.')));
  const done = await run('no, make it shorter');
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.match(done.text, /^edited: /);
  assert.match(done.text, /make it shorter/);
  // Replayed, not paid for again.
  assert.equal(m.triage!.calls, 1);
  assert.equal(m.analyst!.calls, 1);
  assert.equal(m.editor!.calls, 1);
  // The run finished: the next message starts a new one.
  const next = await run('another question');
  assert.equal(next.status, 'completed');
  assert.equal(m.triage!.calls, 2);
});

test('script: a paused run keeps the source it started on across a redeploy', async () => {
  const m = models();
  const sessions = new InProcessSessionService();
  const paused = await turner(deskConfig(CONFIRM), m, sessions).run('risky one');
  assert.equal(paused.status, 'input-required');
  const redeployed = deskConfig(`export default async () => 'the new script'`);
  const resumed = await turner(redeployed, m, sessions).run('yes');
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed.error));
  assert.match(resumed.text, /^analysis of: risky one/);
  const fresh = await turner(redeployed, m, sessions).run('hello again');
  assert.equal(fresh.text, 'the new script');
});

test('script: a resume whose recorded calls no longer match fails SCRIPT_DIVERGED, naming the call', async () => {
  const m = models();
  const { run, sessions } = turner(deskConfig(CONFIRM), m);
  await run('risky business');
  const open = openRun((await sessions.get({ appName: APP, userId: USER, sessionId: 's1' }))!.events, 'Desk')!;
  // The recorded Triage call's argument hash, as a non-deterministic script would leave it.
  const entries = open.entries.map((e) => (e.name === 'Triage' ? { ...e, hash: 'tampered' } : e));
  const host = { script: 'Desk', invocationId: 'i', signal: new AbortController().signal, log: () => {}, append: async () => {}, agent: async () => ({ route: 'Analyst', risky: true }), tool: async () => null };
  const r = await runScript({ source: open.pin.source, message: open.pin.message, transcript: '', variables: {}, resume: { run: open.pin.run, entries, answer: 'yes' } }, host);
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.error.code, 'SCRIPT_DIVERGED');
  assert.match(r.status === 'failed' ? r.error.message : '', /agent\("Triage"\)/);
});

test('script: tool() runs only what script.tools lists; the call ceiling stops a runaway run', async () => {
  const m = models();
  const source = `export default async ({ tool }) => {
    const out = await tool('run_code', { code: 'export default (x) => x * 3', input: 14 });
    let refused = '';
    try { await tool('web_extract', { url: 'https://example.com' }) } catch (e) { refused = e.message }
    return { result: out.result, refused };
  };`;
  const r = await turner(deskConfig(source, { script: { tools: ['run_code'] } } as Partial<SyndicateYamlConfig>), m).run('go');
  assert.equal(r.status, 'completed', JSON.stringify(r.error));
  assert.deepEqual(JSON.parse(r.text), { result: 42, refused: "tool: 'web_extract' is not in script.tools (run_code)" });

  const host = { script: 'S', invocationId: 'i', signal: new AbortController().signal, log: () => {}, append: async () => {}, agent: async () => 'x', tool: async () => 'x' };
  const capped = await runScript({ source: 'export default async ({ now }) => { for (;;) await now() }', message: '', transcript: '', variables: {}, callLimit: 10 }, host);
  assert.equal(capped.status, 'failed');
  assert.equal(capped.status === 'failed' && capped.error.code, 'SCRIPT_CALL_LIMIT');
});

test('script: the script\'s own errors fail the turn SCRIPT_ERROR, and the answer may be JSON', async () => {
  const m = models();
  const thrown = await turner(deskConfig(`export default async () => { throw new Error('bad routing table') }`), m).run('x');
  assert.equal(thrown.status, 'failed');
  assert.equal(thrown.failedStage, 'script');
  assert.deepEqual(thrown.error, { code: 'SCRIPT_ERROR', message: 'Error: bad routing table' });
  const json = await turner(deskConfig(`export default async ({ variables }) => ({ ok: true, n: variables.n })`), m).run('x');
  assert.deepEqual(JSON.parse(json.text), { ok: true });
});

test('schema: a script syndicate refuses dispatch, pauses inside its agents, and code_execution moved off Gemini', () => {
  const base = {
    syndicate_name: 'S',
    script: { source: 'export default async () => "x"', models: ['claude-opus-5-5'] },
    orchestrator: { name: 'A', model: 'gemini-3.5-flash', instruction: 'x' },
  };
  assert.doesNotThrow(() => validateSyndicateConfig(base));
  assert.throws(() => validateSyndicateConfig({ ...base, dispatch: { default_route: 'B' }, subagents: [{ name: 'B', description: 'b', instruction: 'b' }] }), /a script or a plan-dispatch router, not both/);
  assert.throws(() => validateSyndicateConfig({ ...base, orchestrator: { ...base.orchestrator, tools: ['web_extract'], require_approval: ['web_extract'] } }), /cannot be resumed in this version/);
  assert.throws(() => validateSyndicateConfig({ ...base, orchestrator: { ...base.orchestrator, tools: ['ask_user'] } }), /pause in the script with askUser/);
  assert.throws(() => validateSyndicateConfig({ ...base, orchestrator: { ...base.orchestrator, code_execution: 'gemini' } }), /lets agent\(\) move this agent to claude-opus-5-5/);
  assert.throws(() => validateSyndicateConfig({ ...base, max_concurrency: 2 }), /parallel\(thunks, \{ max \}\)/);
  assert.throws(() => validateSyndicateConfig({ ...base, script: { ...base.script, modles: [] } }), /modles/);
  assert.doesNotThrow(() => validateSyndicateConfig({ ...base, orchestrator: { ...base.orchestrator, mode: 'task' } }));
});

test('loader: {{token}} does not touch script.source, and the script reads the bound variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'script-load-'));
  const file = join(dir, 'desk.yaml');
  writeFileSync(file, [
    'syndicate_name: Desk',
    'variables: { desk: "Harwick" }',
    'script:',
    '  source: |',
    '    export default async ({ variables }) => `{{desk}} is ${variables.desk}`;',
    'orchestrator: { name: A, model: gemini-3.5-flash, instruction: "You are {{desk}}." }',
  ].join('\n'));
  const config = loadSyndicate('desk.yaml', { agentsDir: dir, bindings: { extra: 1 } });
  assert.match(config.script!.source, /`\{\{desk\}\} is \$\{variables\.desk\}`/);
  assert.equal(config.script!.variables?.desk, 'Harwick');
  assert.equal(config.script!.variables?.extra, 1);
  assert.equal(config.orchestrator.instruction, 'You are Harwick.');
});

test('switch: a script syndicate is refused before any model call while the sandbox is off', async () => {
  const m = models();
  process.env.MELCHIZEDEK_CODE_SANDBOX = 'off';
  try {
    await assert.rejects(turner(deskConfig(ROUTER), m).run('hi'), CodeSandboxOffError);
    assert.equal(m.triage!.calls, 0);
  } finally {
    process.env.MELCHIZEDEK_CODE_SANDBOX = 'on';
  }
});

// ── The rest of the ADR: nesting, gates, durability, spans, live events ──────

let published = 0;
registerTool(
  'script_test_publish',
  defineTool({
    name: 'script_test_publish',
    description: 'Publishes a draft (test).',
    schema: z.object({ draft: z.string() }),
    execute: async ({ draft }) => {
      published++;
      return `published: ${draft}`;
    },
  }),
);

const PUBLISHER = `export default async ({ message, agent, tool }) => {
  const draft = await agent('Analyst', message);
  const out = await tool('script_test_publish', { draft });
  return typeof out === 'string' ? out : 'refused: ' + out.error;
};`;

test('gate: a tool in script.require_approval pauses for approval; the decision runs or refuses the pinned call', async () => {
  const m = models();
  const config = deskConfig(PUBLISHER, { script: { tools: ['script_test_publish'], require_approval: ['script_test_publish'] } } as Partial<SyndicateYamlConfig>);
  for (const approved of [true, false]) {
    published = 0;
    const sessions = new InProcessSessionService();
    const sid = `gate-${approved}`;
    const turn = (parts: unknown[]) => runSyndicateTurn({ config, parts: parts as never, appName: APP, userId: USER, sessionId: sid, sessionService: sessions, compile: { resolveModel: shimResolver(m) }, trace: false });
    const paused = await turn([{ text: 'write the note' }]);
    assert.equal(paused.status, 'input-required', JSON.stringify(paused.error));
    assert.equal(paused.approval?.tool, 'script_test_publish');
    assert.deepEqual(paused.approval?.args, { draft: 'analysis of: write the note' });
    assert.equal(published, 0);
    // A message that is not the decision repeats the request; nothing runs.
    const again = await turn([{ text: 'hello?' }]);
    assert.equal(again.approval?.id, paused.approval?.id);
    const done = await turn([approvalResponsePart(paused.approval!.id, approved)]);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.text, approved ? 'published: analysis of: write the note' : 'refused: This tool call is rejected.');
    assert.equal(published, approved ? 1 : 0);
  }
  assert.throws(() => validateSyndicateConfig({ syndicate_name: 'S', script: { source: 'export default () => 1', tools: ['a'], require_approval: ['b'] }, orchestrator: { name: 'A', model: 'm', instruction: 'x' } }), /'b' is not in script\.tools/);
});

test('nesting: a script syndicate runs whole as a delegated subagent, and its askUser pauses and resumes the turn', async () => {
  const inner = deskConfig(CONFIRM);
  const boss = new ScriptedModel('boss', (req, n) => (n === 1 ? toolCall('Desk', { request: 'a risky question' }) : answer(`boss relays: ${JSON.stringify(lastToolResult(req) ?? null).slice(0, 200)}`)));
  const m = models({ boss } as Record<string, ScriptedModel>);
  const outer = validateSyndicateConfig({
    syndicate_name: 'Outer',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Desk.' },
    subagents: [{ name: 'Desk', description: 'the desk', yaml_reference: 'desk.yaml' }],
  });
  const sessions = new InProcessSessionService();
  const turn = (text: string) => runSyndicateTurn({ config: outer, parts: [{ text }], appName: APP, userId: USER, sessionId: 'nest', sessionService: sessions, compile: { resolveModel: shimResolver(m), loadNested: () => inner }, trace: false });
  const paused = await turn('ask the desk');
  assert.equal(paused.status, 'input-required', JSON.stringify(paused.error));
  assert.equal(paused.input?.message, 'Send this reply?');
  const done = await turn('yes');
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.match(done.text, /analysis of: a risky question/);
  assert.equal(m.triage!.calls, 1);
});

test('nesting: agent() runs a nested script syndicate as its own turn; a pause inside it fails PAUSE_INSIDE_AGENT', async () => {
  const m = models();
  const inner = deskConfig(ROUTER);
  const confirming = deskConfig(CONFIRM);
  const outerOf = (ref: string) =>
    validateSyndicateConfig({
      syndicate_name: 'Outer',
      script: { source: `export default async ({ agent }) => 'outer got: ' + await agent('Desk', 'risky: what is 2+2?')` },
      orchestrator: { name: 'Boss', model: 'scripted/triage', instruction: 'unused' },
      subagents: [{ name: 'Desk', description: 'the desk', yaml_reference: ref }],
    });
  const run = (ref: string, loaded: SyndicateYamlConfig) =>
    runSyndicateTurn({ config: outerOf(ref), parts: [{ text: 'go' }], appName: APP, userId: USER, sessionId: `own-${ref}`, sessionService: new InProcessSessionService(), compile: { resolveModel: shimResolver(m), loadNested: () => loaded }, trace: false });
  const ok = await run('router.yaml', inner);
  assert.equal(ok.status, 'completed', JSON.stringify(ok.error));
  assert.equal(ok.text, 'outer got: analysis of: risky: what is 2+2?');
  const failed = await run('confirm.yaml', confirming);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'PAUSE_INSIDE_AGENT');
});

test('durable: a worker stopped mid-script resumes from its last journaled call, paying for nothing twice', async () => {
  const slowAnalyst = new ScriptedModel('analyst', () => answer('the analysis'));
  let editorCalls = 0;
  const m = models({ analyst: slowAnalyst });
  const source = `export default async ({ message, agent }) => {
    const triage = await agent('Triage', message);
    const draft = await agent('Analyst', message);
    return agent('Editor', { draft, route: triage.route });
  };`;
  const config = deskConfig(source);
  let saved: RunCheckpoint | null = null;
  const crash = new AbortController();
  m.editor = new ScriptedModel('editor', async (_req, _n, signal) => {
    editorCalls++;
    if (editorCalls === 1) {
      crash.abort();
      return untilAborted(signal);
    }
    return answer('edited once');
  });
  const attempt = (signal?: AbortSignal) =>
    runDurableTurn({
      config,
      parts: [{ text: 'a question' }],
      runId: 'job-1',
      appName: APP,
      userId: USER,
      checkpoints: { load: async () => saved, save: async (cp) => ((saved = cp), true) },
      compile: { resolveModel: shimResolver(m) },
      trace: false,
      ...(signal ? { signal } : {}),
    });
  const first = await attempt(crash.signal);
  assert.equal(first.status, 'canceled');
  assert.ok(saved, 'journal appends were checkpoint boundaries');
  const second = await attempt();
  assert.equal(second.status, 'completed', JSON.stringify(second.error));
  assert.equal(second.text, 'edited once');
  assert.ok(second.resumedFromStep > 0);
  assert.equal(m.triage!.calls, 1, 'Triage replayed from the journal');
  assert.equal(slowAnalyst.calls, 1, 'Analyst replayed from the journal');
});

test('spans: script.invoke and script.call in their own trace; agent() turn spans carry the run and the call', async () => {
  const spans: Array<{ name: string; attributes: Record<string, unknown>; traceId: string }> = [];
  const off = onSpanEnd((span) => spans.push({ name: span.name, attributes: span.attributes as Record<string, unknown>, traceId: span.spanContext().traceId }));
  try {
    const m = models();
    const r = await runSyndicateTurn({ config: deskConfig(ROUTER), parts: [{ text: 'what is 2+2?' }], appName: APP, userId: USER, sessionId: 'spans', sessionService: new InProcessSessionService(), compile: { resolveModel: shimResolver(m) } });
    assert.equal(r.status, 'completed');
  } finally {
    off();
  }
  const invoke = spans.find((s) => s.name === 'script.invoke Desk');
  assert.ok(invoke, spans.map((s) => s.name).join(', '));
  assert.equal(invoke.attributes['script.status'], 'completed');
  assert.equal(invoke.attributes['script.calls'], 2);
  const calls = spans.filter((s) => s.name.startsWith('script.call '));
  assert.deepEqual(calls.map((s) => s.name), ['script.call agent:Triage', 'script.call agent:Analyst']);
  assert.ok(calls.every((s) => s.traceId === invoke.traceId && s.attributes['script.call.status'] === 'completed'));
  const turns = spans.filter((s) => s.name === 'Syndicate Execution: Desk');
  assert.deepEqual(turns.map((s) => s.attributes['script.call.seq']), [1, 2]);
  assert.ok(turns.every((s) => s.attributes['script.run'] === invoke.attributes['script.run'] && s.traceId !== invoke.traceId));
  // Nothing of the person's text or the answers rides on a script span.
  assert.ok(![invoke, ...calls].some((s) => JSON.stringify(s.attributes).includes('2+2')));
});

test('live events: agent() calls report through onAgentEvent with the path [script, agent]', async () => {
  const seen: Array<{ agent: string; path: string }> = [];
  const m = models();
  await runSyndicateTurn({
    config: deskConfig(ROUTER), parts: [{ text: 'what is 2+2?' }], appName: APP, userId: USER, sessionId: 'live', sessionService: new InProcessSessionService(), compile: { resolveModel: shimResolver(m) }, trace: false,
    events: { onAgentEvent: (_e, b) => seen.push({ agent: b.agent, path: b.path.join('/') }) },
  });
  assert.ok(seen.some((s) => s.agent === 'Triage' && s.path === 'Desk/Triage'));
  assert.ok(seen.some((s) => s.agent === 'Analyst' && s.path === 'Desk/Analyst'));
});

test('askUser: with a schema a JSON reply is parsed, plain text passes as is; script.models are checked before any call', async () => {
  const m = models();
  const source = `export default async ({ askUser }) => { const a = await askUser('pick', 'Pick?', { schema: { type: 'object' } }); return { reply: a.reply } };`;
  for (const [answerText, expected] of [['{"n": 2}', { n: 2 }], ['two please', 'two please']] as const) {
    const { run } = turner(deskConfig(source), m);
    assert.equal((await run('go', `schema-${answerText}`)).status, 'input-required');
    const done = await run(answerText, `schema-${answerText}`);
    assert.deepEqual(JSON.parse(done.text), { reply: expected });
  }
  const bad = await turner(deskConfig(ROUTER, { script: { models: ['scripted/nowhere'] } } as Partial<SyndicateYamlConfig>), m).run('hi');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error?.code, 'SCRIPT_MODEL_INVALID');
  assert.equal(m.triage!.calls, 0);
});

test('nesting: a script syndicate as a dispatch route pauses the turn on its askUser, and the answer resumes it without classifying', async () => {
  const inner = deskConfig(CONFIRM);
  const router = new ScriptedModel('router', () => answer(JSON.stringify({ route: 'Desk' })));
  const m = models({ router } as Record<string, ScriptedModel>);
  const outer = validateSyndicateConfig({
    syndicate_name: 'Front',
    dispatch: { default_route: 'Desk' },
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Route.', output: { schema: { type: 'object', properties: { route: { type: 'string' } }, required: ['route'] } } },
    subagents: [{ name: 'Desk', description: 'the desk', yaml_reference: 'desk.yaml' }],
  });
  const sessions = new InProcessSessionService();
  const turn = (text: string) => runSyndicateTurn({ config: outer, parts: [{ text }], appName: APP, userId: USER, sessionId: 'route-nest', sessionService: sessions, compile: { resolveModel: shimResolver(m), loadNested: () => inner }, trace: false });
  const paused = await turn('a risky question');
  assert.equal(paused.status, 'input-required', JSON.stringify(paused.error));
  assert.equal(paused.input?.message, 'Send this reply?');
  const done = await turn('yes');
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.match(done.text, /^analysis of: a risky question/);
  assert.equal(router.calls, 1);
  assert.equal(m.triage!.calls, 1);
});

test('nesting: a script syndicate as a workflow node runs its whole script, and its askUser pauses the walk', async () => {
  const m = models();
  const flow = (inner: SyndicateYamlConfig) =>
    runSyndicateTurn({
      config: validateSyndicateConfig({
        syndicate_name: 'Flow',
        workflow: { edges: [['START', 'Prep', 'Desk']] },
        orchestrator: { name: 'Prep', model: 'scripted/chat', instruction: 'Prepare.' },
        subagents: [{ name: 'Desk', description: 'the desk', yaml_reference: 'desk.yaml' }],
      }),
      parts: [{ text: 'hello there' }], appName: APP, userId: USER, sessionId: `flow-${inner.script!.source.length}`, sessionService: new InProcessSessionService(),
      compile: { resolveModel: shimResolver(m), loadNested: () => inner }, trace: false,
    });
  const ran = await flow(deskConfig(`export default async ({ message, agent }) => 'desk saw: ' + message`));
  assert.equal(ran.status, 'completed', JSON.stringify(ran.error));
  assert.match(ran.text, /^desk saw: hi! \(/);
  const asked = await flow(deskConfig(`export default async ({ askUser }) => (await askUser('q', 'Which one?')).reply`));
  assert.equal(asked.status, 'input-required', JSON.stringify(asked.error));
  assert.equal(asked.input?.message, 'Which one?');
});
