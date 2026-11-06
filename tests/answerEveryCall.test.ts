/**
 * tests/answerEveryCall.test.ts — the request builder answers every call
 * the history leaves unanswered (lib/runtime/native/request.ts
 * answerEveryCall): Anthropic and OpenAI refuse a request that does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNANSWERED_CALL, answerEveryCall } from '../lib/runtime/native/request.ts';
import type { Message } from '../lib/models/contract.ts';

const calls = (...ids: string[]): Message => ({ role: 'assistant', parts: ids.map((id) => ({ type: 'toolCall', id, name: `t_${id}`, args: {} })) }) as Message;
const results = (...ids: string[]): Message => ({ role: 'tool', parts: ids.map((id) => ({ type: 'toolResult', id, name: `t_${id}`, result: `r_${id}` })) });
const user = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] });

test('a history whose calls are all answered passes through unchanged', () => {
  const messages = [user('hi'), calls('a', 'b'), results('a', 'b'), user('next')];
  assert.deepEqual(answerEveryCall(messages), messages);
});

test('a partly answered step keeps its results and adds the missing ones after them', () => {
  const out = answerEveryCall([user('hi'), calls('a', 'b', 'c'), results('c'), user('why?')]);
  assert.equal(out.length, 4);
  const tool = out[2] as Extract<Message, { role: 'tool' }>;
  assert.deepEqual(tool.parts.map((p) => p.id), ['c', 'a', 'b']);
  assert.equal(tool.parts[0]!.result, 'r_c');
  assert.deepEqual(tool.parts.slice(1).map((p) => [p.result, p.isError, p.name]), [[UNANSWERED_CALL, true, 't_a'], [UNANSWERED_CALL, true, 't_b']]);
});

test('a step followed by the person\'s text gets a result message before it', () => {
  const out = answerEveryCall([calls('a'), user('never mind')]);
  assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'user']);
});

test('a step at the end of the history is answered too', () => {
  const out = answerEveryCall([user('hi'), calls('a')]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool']);
});
