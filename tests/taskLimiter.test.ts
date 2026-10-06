/**
 * tests/taskLimiter.test.ts — the A2A server's concurrency caps: global,
 * per scope (one end user; default 4) and per caller (off by default),
 * each refusal naming the cap that was hit (ADR 0039).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TaskLimiter } from '../lib/a2a/executor.ts';
import { DEFAULT_MAX_CONCURRENT_PER_SCOPE } from '../lib/a2a/app.ts';

test('one scope cannot hold more than its cap; other scopes are unaffected; release frees the slot', () => {
  const l = new TaskLimiter(0, { perScope: 2 });
  assert.ok(l.acquire('t1', { scopeKey: 'alice' }));
  assert.ok(l.acquire('t2', { scopeKey: 'alice' }));
  assert.equal(l.acquire('t3', { scopeKey: 'alice' }), undefined);
  assert.match(l.refusal({ scopeKey: 'alice' })!, /This user already has 2 tasks running/);
  assert.ok(l.acquire('t4', { scopeKey: 'bob' }), 'another user still gets a slot');
  l.release('t1');
  assert.ok(l.acquire('t5', { scopeKey: 'alice' }), 'a finished task frees its scope slot');
});

test('a caller cap counts across every scope that caller serves', () => {
  const l = new TaskLimiter(0, { perCaller: 2 });
  assert.ok(l.acquire('a', { caller: 'backend', scopeKey: 'backend/u1' }));
  assert.ok(l.acquire('b', { caller: 'backend', scopeKey: 'backend/u2' }));
  assert.match(l.refusal({ caller: 'backend', scopeKey: 'backend/u3' })!, /This caller already has 2 tasks running/);
  assert.ok(l.acquire('c', { caller: 'other', scopeKey: 'other/u1' }));
});

test('the global cap and draining still win, and the defaults are 4 per scope, no caller cap', () => {
  const l = new TaskLimiter(1);
  assert.ok(l.acquire('x', { scopeKey: 's' }));
  assert.match(l.refusal({ scopeKey: 't' })!, /limit of 1 concurrent tasks/);
  assert.equal(DEFAULT_MAX_CONCURRENT_PER_SCOPE, 4);
  const d = new TaskLimiter(0, { perScope: DEFAULT_MAX_CONCURRENT_PER_SCOPE });
  assert.equal(d.perCaller, Infinity);
  void d.drain(0);
  assert.match(d.refusal({ scopeKey: 's' })!, /shutting down/);
});
