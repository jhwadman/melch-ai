/**
 * tests/dbSchema.test.ts — installing into a private schema (ADR 0021
 * item 2). The rewrite must reach every place db/ names `public`; this test
 * fails if a new migration adds one the rewrite does not know.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { dbSchema, searchPathOption, sqlForSchema } from '../lib/storage/schema.ts';

const FILES = [
  ...readdirSync('db/migrations').filter((f) => /^\d{4}_.+\.sql$/.test(f)).map((f) => `db/migrations/${f}`),
  'db/hardening.sql',
  'db/telemetry.sql',
];

test('public is the default and leaves the SQL untouched', () => {
  assert.equal(dbSchema({}), 'public');
  for (const f of FILES) {
    const sql = readFileSync(f, 'utf-8');
    assert.equal(sqlForSchema(sql, 'public'), sql);
  }
  assert.equal(searchPathOption('public'), undefined);
});

test('a private schema rewrites every reference to public, and only those', () => {
  for (const f of FILES) {
    const out = sqlForSchema(readFileSync(f, 'utf-8'), 'zz_private');
    assert.ok(out.startsWith('CREATE SCHEMA IF NOT EXISTS zz_private;\nSET search_path = zz_private, public;'), f);
    const stray = out
      .split('\n')
      .map((line) => line.replace(/--.*$/, '')) // comments may say "public"
      .filter((line) => /\bpublic\b/.test(line))
      .filter((line) => !/search_path = zz_private, public/.test(line))
      .filter((line) => !/\bPUBLIC\b/.test(line.replace(/\bpublic\b/g, ''))); // the PUBLIC role keyword is upper-case
    assert.deepEqual(stray, [], `${f} still names public in: ${stray.join(' | ')}`);
    assert.doesNotMatch(out, /'SELECT melchizedek_/, `${f}: a pg_cron job must call its function qualified`);
  }
});

test('schema names are lower-case identifiers only', () => {
  assert.equal(dbSchema({ MELCHIZEDEK_DB_SCHEMA: 'melchizedek' }), 'melchizedek');
  for (const bad of ['Melch', 'a-b', 'x;drop', '1abc', 'a b']) {
    assert.throws(() => dbSchema({ MELCHIZEDEK_DB_SCHEMA: bad }));
    assert.throws(() => sqlForSchema('select 1', bad));
  }
  assert.equal(searchPathOption('melchizedek'), '-c search_path=melchizedek,public');
});
