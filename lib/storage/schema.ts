/**
 * lib/storage/schema.ts — the database schema the tables live in
 * (ADR 0021 item 2).
 *
 * The default is `public`, where every existing deployment's tables are.
 * A deployment on its own Postgres can keep them in a private schema
 * instead (MELCHIZEDEK_DB_SCHEMA, e.g. `melchizedek`): a REST layer such as
 * Supabase's exposes `public` by default, so a private schema has no anon
 * REST path at all. It is reached over DATABASE_URL (postgresStorage), which
 * sets the connection's search_path; supabase-js storage cannot use it.
 *
 * The SQL in db/ names `public` in three places, which `sqlForSchema`
 * rewrites, and nowhere else (pinned by tests):
 *   - `SET search_path = public` on function definitions;
 *   - `'public.<table>'` in to_regclass lookups;
 *   - `= 'public'` in catalog filters;
 * plus the pg_cron jobs, which run outside any search_path and so call
 * their function by its qualified name. `public` stays on the path after
 * the schema, for the pgvector type and functions.
 */

export const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The configured schema: MELCHIZEDEK_DB_SCHEMA, else `public`. */
export function dbSchema(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.MELCHIZEDEK_DB_SCHEMA?.trim() || 'public';
  if (!SCHEMA_NAME.test(s)) {
    throw new Error(`MELCHIZEDEK_DB_SCHEMA must be a lower-case identifier (letters, digits, _), got "${s}"`);
  }
  return s;
}

/** A db/ file's SQL for `schema` (unchanged for `public`). */
export function sqlForSchema(sql: string, schema: string): string {
  if (schema === 'public') return sql;
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid schema name "${schema}"`);
  const body = sql
    .replaceAll('SET search_path = public', `SET search_path = ${schema}, public`)
    .replaceAll("'public.", `'${schema}.`)
    .replaceAll("= 'public'", `= '${schema}'`)
    .replace(/'SELECT (melchizedek_[a-z_]+\(\))'/g, `'SELECT ${schema}.$1'`);
  return `CREATE SCHEMA IF NOT EXISTS ${schema};\nSET search_path = ${schema}, public;\n${body}`;
}

/** The pg connection option that puts `schema` first on the search_path. */
export function searchPathOption(schema: string): string | undefined {
  if (schema === 'public') return undefined;
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid schema name "${schema}"`);
  return `-c search_path=${schema},public`;
}
