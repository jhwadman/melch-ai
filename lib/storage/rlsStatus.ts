/**
 * lib/storage/rlsStatus.ts — is db/hardening.sql in force? One set of rules
 * for both storage paths.
 *
 * WHY: a Supabase project exposes the tables in `public` through its REST
 * API, readable and writable with the published anon key wherever row-level
 * security is off. The server refuses to start on a public deployment
 * without the hardening (ADR 0021). The supabase-js path asked
 * melchizedek_rls_status(); the DATABASE_URL path asked nothing, so a
 * deployment that followed the recommended setup never had the check.
 *
 * Both paths now read the same rows and judge them here:
 *   - adk_memory_facts and adk_sessions must have RLS on;
 *   - adk_agent_registry, where it exists, must too (anon write access there
 *     is agent takeover);
 *   - adk_telemetry without RLS is reported but does not fail the check.
 */

export interface RlsHardeningStatus {
  /** true when db/hardening.sql is in force, or when nothing exposes the tables. */
  applied: boolean;
  /** Human-readable explanation for logs. */
  detail: string;
}

export interface RlsRow {
  table_name: string;
  rls_enabled: boolean;
}

/** Judge the RLS flags of the shipped tables. */
export function evaluateRlsRows(rows: RlsRow[]): RlsHardeningStatus {
  const unprotected = ['adk_memory_facts', 'adk_sessions'].filter(
    (t) => !rows.some((r) => r.table_name === t && r.rls_enabled),
  );
  if (unprotected.length > 0) {
    return { applied: false, detail: `RLS is disabled on: ${unprotected.join(', ')}` };
  }
  const registryRow = rows.find((r) => r.table_name === 'adk_agent_registry');
  if (registryRow && !registryRow.rls_enabled) {
    return {
      applied: false,
      detail:
        'RLS is disabled on: adk_agent_registry (agent definitions are '
        + 'writable with the anon key) — re-run db/hardening.sql',
    };
  }
  const telemetryRow = rows.find((r) => r.table_name === 'adk_telemetry');
  if (telemetryRow && !telemetryRow.rls_enabled) {
    return {
      applied: true,
      detail: 'RLS enabled on adk_memory_facts and adk_sessions — but NOT on adk_telemetry; re-run db/hardening.sql',
    };
  }
  return { applied: true, detail: 'RLS enabled on adk_memory_facts and adk_sessions' };
}

/** What a direct Postgres connection sees: the API roles, the schema, and the flags. */
export interface PostgresRlsFacts {
  /** True when the Supabase API roles (anon, authenticated) exist. */
  apiRoles: boolean;
  /** The schema the tables live in (first on the search_path). */
  schema: string;
  rows: RlsRow[];
}

/**
 * The DATABASE_URL path's judgment. Without the API roles nothing serves the
 * tables over HTTP; in a schema other than `public` the Supabase REST API
 * does not expose them unless someone adds that schema to it.
 */
export function evaluatePostgresRls(facts: PostgresRlsFacts): RlsHardeningStatus {
  if (!facts.apiRoles) {
    return { applied: true, detail: 'no anon or authenticated role in this database, so no API exposes the tables' };
  }
  if (facts.schema !== 'public') {
    return {
      applied: true,
      detail: `tables live in schema "${facts.schema}", which the Supabase API does not expose unless it is added to the exposed schemas`,
    };
  }
  return evaluateRlsRows(facts.rows);
}

/** The query evaluatePostgresRls reads. */
export const POSTGRES_RLS_QUERY = `
  SELECT
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) AS api_roles,
    current_schema() AS schema,
    coalesce(
      (SELECT json_agg(json_build_object('table_name', c.relname, 'rls_enabled', c.relrowsecurity))
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND c.relname IN ('adk_memory_facts', 'adk_sessions', 'adk_agent_registry', 'adk_telemetry')),
      '[]'::json
    ) AS rows`;
