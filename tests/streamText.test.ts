/**
 * tests/streamText.test.ts — streaming the answer over message/stream
 * (A2A_STREAM_TEXT, lib/a2a/executor.ts answerStream). Scripted models that
 * stream in chunks, on an ephemeral port, no provider calls.
 *
 * The contract: chunks arrive as an `answer` artifact as the model writes
 * them; narration before a tool call is discarded; the artifact is closed
 * with the text the user actually receives; a syndicate with guards never
 * streams; and the final status message is unchanged for clients that read
 * only that.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import type { LlmResponse } from '@google/adk';

import { createA2AApp } from '../lib/a2a/app.ts';
import type { A2AApp } from '../lib/a2a/app.ts';
import { registerGuard } from '../lib/guards/index.ts';
import { ScriptedLlm, call, streamed, text } from './helpers/scriptedLlm.ts';
import { z } from 'zod';
import { runAgentLoop } from '../lib/runtime/native/agentLoop.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { drainAgentStream } from '../lib/runtime/syndicateTurn.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, streamedAnswer, toolCall } from './helpers/scriptedModel.ts';

setLogLevel(LogLevel.ERROR);

const SECRET = 'test-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const dir = mkdtempSync(join(tmpdir(), 'melch-stream-'));
const yaml = (name: string, model: string, extra: string[] = []) =>
  [`syndicate_name: ${name}`, 'orchestrator:', `  name: ${name}`, `  model: scripted/${model}`, '  instruction: Answer.', ...extra].join('\n');
writeFileSync(join(dir, 'writer.yaml'), yaml('Writer', 'writer', ['subagents: []']));
writeFileSync(join(dir, 'guarded.yaml'), yaml('Guarded', 'writer', ['subagents: []', 'guards: [shout]']));
writeFileSync(
  join(dir, 'narrator.yaml'),
  yaml('Narrator', 'narrator', [
    'subagents:',
    '  - name: Helper',
    '    description: Looks things up.',
    '    model: scripted/helper',
    '    instruction: Help.',
  ]),
);
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

// A guard that rewrites the answer: nothing it has not read may be streamed.
registerGuard({ name: 'shout', run: async (t: string) => ({ text: t.toUpperCase(), notes: ['shouted'] }) }, { override: true });

const models: Record<string, () => ScriptedLlm> = {
  writer: () => new ScriptedLlm('scripted/writer', () => streamed('Hello', ', ', 'world.')),
  // Narrates, calls the helper, then streams the real answer.
  narrator: () =>
    new ScriptedLlm('scripted/narrator', (_req, n): LlmResponse | LlmResponse[] =>
      n === 1
        ? [{ content: { role: 'model', parts: [{ text: 'Let me check. ' }] }, partial: true } as LlmResponse, call('Helper', { request: 'x' })]
        : streamed('Final ', 'answer.'),
    ),
  helper: () => new ScriptedLlm('scripted/helper', () => text('helper result')),
};

let built: A2AApp;
let server: Server;
let base = '';

before(async () => {
  built = await createA2AApp({
    defaultSyndicate: 'writer.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InMemorySessionService() },
    keyMode: 'byok',
    streamText: true,
    resolveModel: (id) => models[(id ?? '').replace('scripted/', '')]!(),
    log: () => {},
    warn: () => {},
  });
  server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => {
  server?.close();
});

/** Every result of one message/stream call, in order. */
async function streamResults(agent: string, question: string): Promise<any[]> {
  const res = await fetch(`${base}/${agent}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'X-API-Key': 'caller-key', 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: question }] } },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  return body
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)).result)
    .filter(Boolean);
}

const artifacts = (results: any[]) =>
  results
    .filter((r) => r.kind === 'artifact-update')
    .map((r) => ({ text: r.artifact.parts.map((p: any) => p.text ?? '').join(''), append: !!r.append, last: !!r.lastChunk }));
const finalText = (results: any[]) => {
  const final = results.filter((r) => r.kind === 'status-update').at(-1);
  return { state: final?.status?.state, text: (final?.status?.message?.parts ?? []).map((p: any) => p.text ?? '').join('') };
};

test('chunks stream as an answer artifact, then close with the whole text', async () => {
  const results = await streamResults('writer', 'hi');
  assert.deepEqual(artifacts(results), [
    { text: 'Hello', append: false, last: false },
    { text: ', ', append: true, last: false },
    { text: 'world.', append: true, last: false },
    { text: 'Hello, world.', append: false, last: true },
  ]);
  assert.deepEqual(finalText(results), { state: 'completed', text: 'Hello, world.' });
});

test('narration before a tool call is withdrawn; only the answer remains', async () => {
  const results = await streamResults('narrator', 'look it up');
  const a = artifacts(results);
  assert.deepEqual(a[0], { text: 'Let me check. ', append: false, last: false });
  assert.deepEqual(a[1], { text: '', append: false, last: false }, 'reset when the tool call arrives');
  assert.deepEqual(a.at(-1), { text: 'Final answer.', append: false, last: true });
  assert.equal(finalText(results).text, 'Final answer.');
});

test('a syndicate with guards never streams; the guarded text arrives whole', async () => {
  const results = await streamResults('guarded', 'hi');
  assert.deepEqual(artifacts(results), []);
  assert.deepEqual(finalText(results), { state: 'completed', text: 'HELLO, WORLD.' });
});

// ── The native loop's half (lib/runtime/native/agentLoop.ts, WS2-5b) ────────
// The A2A surface runs the native loop under MELCHIZEDEK_RUNTIME=native (ADR 0073;
// tests/nativeTurn.test.ts compares the deltas through runSyndicateTurn). Here the loop is driven
// directly and its events drained as the turn runner drains them: the same
// deltas, the same reset when a tool call follows narration, the answer whole.

test('native loop: chunks reach onTextDelta, narration before a tool call is reset, the answer is whole', async () => {
  const helper = defineTool({ name: 'Helper', description: 'Looks things up.', schema: z.object({ request: z.string() }), execute: async () => 'helper result' });
  const model = new ScriptedModel('scripted/narrator', (_req, n) =>
    n === 1 ? [{ partial: true, parts: [{ type: 'text', text: 'Let me check. ' }] }, toolCall('Helper', { request: 'x' }, 'call-1')] : streamedAnswer('Final ', 'answer.'),
  );
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: 'stream', userId: 'u', sessionId: 's' });
  await sessions.append(session, { id: 'u0000001', invocationId: 'e-1', author: 'user', content: { role: 'user', parts: [{ text: 'look it up' }] }, actions: {}, timestamp: 1 });

  const seen: string[] = [];
  const loop = runAgentLoop({ name: 'Narrator', model: 'scripted/narrator', instruction: 'Answer.', tools: [helper] }, {
    session,
    sessions,
    invocationId: 'e-1',
    stream: true,
    adapterFor: () => model,
  });
  const run = await drainAgentStream(loop as any, {
    streamText: true,
    events: { onTextDelta: (t: string) => seen.push(`+${t}`), onTextReset: () => seen.push('reset') },
  });
  assert.deepEqual(seen, ['+Let me check. ', 'reset', '+Final ', '+answer.']);
  assert.equal(run.text, 'Final answer.');
  assert.equal(model.requests[0]?.stream, true);
  assert.deepEqual(session.events.map((e) => e.author), ['user', 'Narrator', 'Narrator', 'Narrator'], 'the partials are never stored');
});
