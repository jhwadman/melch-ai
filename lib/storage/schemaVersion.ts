/**
 * lib/storage/schemaVersion.ts — the database schema this package expects
 * (ADR 0021 item 3).
 *
 * Every numbered migration in db/migrations/ records itself in
 * `melchizedek_schema_version`. The highest number shipped with the package
 * is the schema this code is written against; a database below it is missing
 * tables or functions the server will call, so the server refuses to start on
 * it and names the fix. A database ABOVE it is a newer migration applied
 * before this server was upgraded (a rolling deploy): migrations are additive,
 * so that only warns.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** db/ of this package, from the source tree or from dist/. */
export function packageDbDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'db', 'migrations'))) return join(dir, 'db');
    dir = dirname(dir);
  }
  throw new Error('db/migrations/ not found next to this package');
}

/** The highest migration number in db/migrations/ (NNNN_name.sql). */
export function shippedSchemaVersion(migrationsDir: string = join(packageDbDir(), 'migrations')): number {
  let max = 0;
  for (const f of readdirSync(migrationsDir)) {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export interface SchemaCheck {
  /** Version recorded in the database; null when it has none. */
  db: number | null;
  shipped: number;
  state: 'match' | 'behind' | 'ahead';
}

export function compareSchema(db: number | null, shipped: number): SchemaCheck {
  const v = db ?? 0;
  return { db, shipped, state: v === shipped ? 'match' : v < shipped ? 'behind' : 'ahead' };
}

/** The message for a database behind the code: what is missing and the fix. */
export function schemaBehindMessage(check: SchemaCheck): string {
  const have = check.db === null ? 'no recorded schema version' : `schema version ${check.db}`;
  return (
    `The database has ${have}; this server needs version ${check.shipped}. ` +
    'Run `npx melchizedek-db apply` (or `npm run db -- apply`) against it, ' +
    'or set ALLOW_SCHEMA_MISMATCH=true to start anyway.'
  );
}
