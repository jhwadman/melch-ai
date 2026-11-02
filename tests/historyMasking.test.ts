/**
 * tests/historyMasking.test.ts — old tool results go to the model as stubs,
 * and recall_tool_result reads them back (ADR 0152).
 *
 * The projection (lib/runtime/native/history.ts) sends a tool result older
 * than the verbatim tail and longer than mask_over_chars as
 * `{ masked: true, tool, ref, chars, head }`; the stored event is untouched;
 * small results stay; the tail stays verbatim. The request builder lists
 * recall_tool_result and says so in the system prompt only when something
 * was masked, and the tool returns the stored result for a ref this agent's
 * projection includes, and "no such result" otherwise.
 *
 * Offline: scripted adapters only.
 */
process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { ToolResultPart } from '../lib/models/contract.ts';
import { createTurnEvent } from '../lib/runtime/events.ts';
import type { TurnEvent } from '../lib/runtime/events.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { DEFAULT_MASK, MASK_HEAD_CHARS, isMaskedResult, projectHistory, storedToolResult } from '../lib/runtime/native/history.ts';
import { NO_SUCH_RESULT, RECALL_NOTE, RECALL_TOOL, recallToolResultTool } from '../lib/runtime/native/recall.ts';
import { registerTool } from '../lib/toolRegistry.ts';
import { createToolContext } from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { ScriptedModel, answer, toolCall } from './helpers/scriptedModel.ts';

const BIG = 'x'.repeat(3_000);
const SMALL = 'small';

// ── The projection ───────────────────────────────────────────────────────────

/** A conversation: a call answered big, one answered small, then enough turns to push both out of the tail. */
function conversation(scope?: string): TurnEvent[] {
  const ev = (init: Parameters<typeof createTurnEvent>[0], i: number): TurnEvent => ({ ...createTurnEvent(init), timestamp: 1_000 + i, ...(scope ? { isolationScope: scope } : {}) });
  const events: TurnEvent[] = [
    ev({ id: 'e-user-1', author: 'user', content: { role: 'user', parts: [{ text: 'read it' }] } }, 0),
    ev({ id: 'e-call-1', author: 'Me', content: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'read', args: { k: 1 } } }, { functionCall: { id: 'c2', name: 'peek', args: {} } }] } }, 1),
    ev({ id: 'e-res-1', author: 'Me', content: { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'read', response: { text: BIG } } }, { functionResponse: { id: 'c2', name: 'peek', response: { text: SMALL } } }] } }, 2),
    ev({ id: 'e-ans-1', author: 'Me', content: { role: 'model', parts: [{ text: 'done' }] } }, 3),
  ];
  for (let t = 2; t <= 5; t++) {
    events.push(ev({ id: `e-user-${t}`, author: 'user', content: { role: 'user', parts: [{ text: `turn ${t}` }] } }, events.length));
    events.push(ev({ id: `e-ans-${t}`, author: 'Me', content: { role: 'model', parts: [{ text: `answer ${t}` }] } }, events.length));
  }
  return events;
}

test('a big tool result outside the tail is a stub; the small one beside it and the stored event stay as they are', () => {
  const events = conversation();
  const before = structuredClone(events);
  const masked: string[] = [];
  const contents = projectHistory(events, { agentName: 'Me', onMasked: (ref) => masked.push(ref) });
  assert.deepEqual(events, before, 'the stored events are untouched');
  assert.deepEqual(masked, ['e-res-1']);
  const result = contents[2]!;
  const big = result.parts![0]!.functionResponse!.response;
  assert.ok(isMaskedResult(big));
  assert.deepEqual(big, { masked: true, tool: 'read', ref: 'e-res-1', chars: JSON.stringify({ text: BIG }).length, head: JSON.stringify({ text: BIG }).slice(0, MASK_HEAD_CHARS) });
  assert.deepEqual(result.parts![1]!.functionResponse!.response, { text: SMALL }, 'a small result is not worth a stub');
  assert.deepEqual(contents[1]!.parts!.map((p) => p.functionCall?.name), ['read', 'peek'], 'the calls stay as they are');
});

test('the tail stays verbatim: the same result inside the last keep events is sent in full', () => {
  // Eight events: the tail of six starts at the result, which stays whole.
  const contents = projectHistory(conversation().slice(0, 8), { agentName: 'Me' });
  assert.deepEqual(contents[2]!.parts![0]!.functionResponse!.response, { text: BIG });
  // One more turn pushes it out.
  const later = projectHistory(conversation().slice(0, 10), { agentName: 'Me' });
  assert.ok(isMaskedResult(later[2]!.parts![0]!.functionResponse!.response));
});

test('mask: false, or mask_over_chars 0, sends every result in full; a larger keep widens the tail', () => {
  const events = conversation();
  for (const mask of [false as const, { overChars: 0, keep: DEFAULT_MASK.keep }, { overChars: DEFAULT_MASK.overChars, keep: 100 }]) {
    const contents = projectHistory(events, { agentName: 'Me', mask });
    assert.deepEqual(contents[2]!.parts![0]!.functionResponse!.response, { text: BIG }, JSON.stringify(mask));
  }
});

test("another agent's masked result is retold as the stub", () => {
  const contents = projectHistory(conversation(), { agentName: 'Other' });
  const retold = contents[2]!.parts!.map((p) => p.text ?? '');
  assert.equal(retold[0], 'For context:');
  assert.match(retold[1]!, /^\[Me\] tool `read` returned result: \{"masked":true,"tool":"read","ref":"e-res-1"/);
  assert.equal(retold[2], `[Me] tool \`peek\` returned result: {"text":"${SMALL}"}`);
});

test('storedToolResult and recall_tool_result read a ref back within the agent’s scope only', async () => {
  const events = conversation();
  assert.deepEqual(storedToolResult(events, 'e-res-1', { agentName: 'Me' }), { tool: 'read', response: { text: BIG } });
  assert.equal(storedToolResult(events, 'e-ans-1', { agentName: 'Me' }), undefined, 'not a tool result');
  assert.equal(storedToolResult(events, 'nope', { agentName: 'Me' }), undefined);
  assert.equal(storedToolResult(conversation('scope-b'), 'e-res-1', { agentName: 'Me', isolationScope: 'scope-a' }), undefined, 'another isolation scope');

  const tool = recallToolResultTool(events, { agentName: 'Me' });
  assert.equal(tool.name, RECALL_TOOL);
  const ctx = createToolContext({ agentName: 'Me' });
  assert.deepEqual(await tool.execute({ ref: 'e-res-1' }, ctx), { tool: 'read', result: { text: BIG } });
  assert.deepEqual(await tool.execute({ ref: 'nope' }, ctx), { error: NO_SUCH_RESULT });
});

// ── Through the loop ─────────────────────────────────────────────────────────

registerTool(
  'big_lookup',
  defineTool({
    name: 'big_lookup',
    description: 'Return a long record.',
    schema: z.object({ key: z.string() }),
    execute: async ({ key }) => `${key}: ${BIG}`,
  }),
);

const CONFIG = {
  syndicate_name: 'Desk',
  memory_system: 'session-only',
  orchestrator: { name: 'Desk', model: 'scripted/desk', instruction: 'Look things up.', tools: ['big_lookup'] },
  subagents: [],
} as unknown as SyndicateYamlConfig;

test('the loop lists recall_tool_result and says so only once something is masked, and the model reads the result back', async () => {
  let recalled: ToolResultPart | undefined;
  const desk = new ScriptedModel('scripted/desk', (request, n) => {
    if (n === 1) return toolCall('big_lookup', { key: 'alpha' });
    // On a request that carries a stub and the recall tool, call it; after the recall, answer from it.
    const stub = request.messages.flatMap((m) => (m.role === 'tool' ? m.parts : [])).find((p) => isMaskedResult(p.result));
    const last = request.messages.at(-1);
    if (last?.role === 'tool' && last.parts[0]?.name === RECALL_TOOL) {
      recalled = last.parts[0];
      return answer('recalled');
    }
    if (stub && request.tools?.some((t) => t.name === RECALL_TOOL)) return toolCall(RECALL_TOOL, { ref: (stub.result as { ref: string }).ref });
    return answer(`turn ${n}`);
  });
  const sessionService = new InProcessSessionService();
  const turn = (message: string) =>
    runSyndicateTurn({
      config: CONFIG,
      parts: [{ text: message }],
      appName: 'desk.a1',
      userId: 'scope-a',
      sessionId: 's1',
      sessionService,
      compile: { resolveModel: () => desk },
      trace: false,
    });
  assert.equal((await turn('look alpha up')).status, 'completed');
  // Before anything is masked: no recall tool, no note.
  for (const request of desk.requests) {
    assert.ok(!request.tools?.some((t) => t.name === RECALL_TOOL), 'no recall tool before masking');
    assert.ok(!request.system?.includes(RECALL_NOTE));
  }
  assert.equal((await turn('and?')).status, 'completed');
  assert.equal((await turn('and?')).status, 'completed');
  const before = desk.requests.length;
  // The fourth turn's history has ten events; the result (the third) is outside the tail of six.
  const fourth = await turn('what did alpha say?');
  assert.equal(fourth.status, 'completed');
  assert.equal(fourth.text, 'recalled');
  const masking = desk.requests[before]!;
  const stub = masking.messages.flatMap((m) => (m.role === 'tool' ? m.parts : [])).find((p) => isMaskedResult(p.result));
  assert.ok(stub, 'the old result went as a stub');
  assert.ok(masking.tools?.some((t) => t.name === RECALL_TOOL), 'the recall tool is listed');
  assert.ok(masking.system?.includes(RECALL_NOTE), 'and the system prompt says so');
  assert.ok(recalled, 'the model called it');
  // The stored shape: a string result is stored as { result } (the genai mapping's spelling).
  assert.deepEqual(recalled!.result, { tool: 'big_lookup', result: { result: `alpha: ${BIG}` } });
  // The earlier requests of the same session, replayed now, would read the same: the stored events still hold the result.
  const session = await sessionService.get({ appName: 'desk.a1', userId: 'scope-a', sessionId: 's1' });
  const stored = session!.events.flatMap((e) => e.content?.parts ?? []).find((p) => p.functionResponse?.name === 'big_lookup');
  assert.deepEqual(stored!.functionResponse!.response, { result: `alpha: ${BIG}` });
});
