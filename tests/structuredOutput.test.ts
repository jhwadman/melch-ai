/**
 * Structured-output schema invariants — fully offline.
 *
 * A judge rubric is only usable if the model returns the fields under the
 * names the harness declared. OpenAI-style "strict" structured output
 * enforces that at the API, but only for a schema where every object
 * forbids extra properties and requires all of its own. This pins the
 * transform that produces it.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { toLowercaseJsonSchema, toStrictJsonSchema } from '../lib/models/schemaNormalize.ts';
import { runAgentLoop } from '../lib/runtime/native/agentLoop.ts';
import { InProcessSessionService } from '../lib/runtime/sessions.ts';
import { ScriptedModel, answer } from './helpers/scriptedModel.ts';

const RUBRIC = {
  type: 'OBJECT',
  properties: {
    correctness: { type: 'INTEGER', description: 'x' },
    ok: { type: 'BOOLEAN' },
    grade: { type: 'STRING', enum: ['a', 'b'] },
    issues: { type: 'ARRAY', items: { type: 'STRING' } },
    nested: { type: 'OBJECT', properties: { why: { type: 'STRING' } } },
  },
  required: ['correctness', 'rationale'],
};

test('strict schema forbids extras and requires every property at every level', () => {
  const strict = toStrictJsonSchema(RUBRIC) as any;
  assert.strictEqual(strict.type, 'object');
  assert.strictEqual(strict.additionalProperties, false);
  assert.deepStrictEqual(strict.required, ['correctness', 'ok', 'grade', 'issues', 'nested']);
  assert.strictEqual(strict.properties.issues.items.type, 'string');
  assert.strictEqual(strict.properties.nested.additionalProperties, false);
  assert.deepStrictEqual(strict.properties.nested.required, ['why']);
  assert.deepStrictEqual(strict.properties.grade.enum, ['a', 'b'], 'enum values keep their casing');
});

test('the lowercase transform is untouched by the strict one', () => {
  const lower = toLowercaseJsonSchema(RUBRIC) as any;
  assert.deepStrictEqual(lower.required, ['correctness', 'rationale']);
  assert.strictEqual(lower.additionalProperties, undefined);
  // The input is never mutated.
  assert.strictEqual(RUBRIC.type, 'OBJECT');
  assert.strictEqual((RUBRIC.properties.nested as any).additionalProperties, undefined);
});

// ── The native loop's half (lib/runtime/native/agentLoop.ts, WS2-5b) ────────
// An agent with an output schema and no tools: the schema reaches the
// adapter as the request's outputSchema (in the contract's lowercase
// dialect), and the answer is saved under outputKey parsed, as ADK saves it.

test('native loop: the output schema reaches the adapter, and the answer is saved parsed under outputKey', async () => {
  const model = new ScriptedModel('scripted/judge', () => answer('{"correctness":4,"ok":true}'));
  const sessions = new InProcessSessionService();
  const session = await sessions.create({ appName: 'judge', userId: 'u', sessionId: 's' });
  await sessions.append(session, { id: 'u0000001', invocationId: 'e-1', author: 'user', content: { role: 'user', parts: [{ text: 'grade it' }] }, actions: {}, timestamp: 1 });

  const loop = runAgentLoop(
    { name: 'Judge', model: 'scripted/judge', instruction: 'Grade.', outputSchema: RUBRIC, outputKey: 'rubric' },
    { session, sessions, invocationId: 'e-1', adapterFor: () => model },
  );
  let next = await loop.next();
  while (!next.done) next = await loop.next();
  assert.strictEqual(next.value.reason, 'final');
  assert.deepStrictEqual(model.requests[0]?.outputSchema, toLowercaseJsonSchema(RUBRIC));
  assert.deepStrictEqual(session.state.rubric, { correctness: 4, ok: true });
});
