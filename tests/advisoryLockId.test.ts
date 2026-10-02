/** tests/advisoryLockId.test.ts — turn-lock keys become stable signed 64-bit advisory-lock ids. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisoryLockId } from '../lib/storage/postgres/index.ts';
import { turnLockKey } from '../lib/a2a/turnLock.ts';

test('a NUL-separated key maps to a stable signed 64-bit id', () => {
  const key = turnLockKey('ns', 'caller/user', 'ctx');
  assert.ok(key.includes('\u0000'));
  const id = advisoryLockId(key);
  assert.equal(id, advisoryLockId(key), 'deterministic');
  const n = BigInt(id);
  assert.ok(n >= -(2n ** 63n) && n < 2n ** 63n);
  assert.notEqual(id, advisoryLockId(turnLockKey('ns', 'caller/user', 'ctx2')));
});
