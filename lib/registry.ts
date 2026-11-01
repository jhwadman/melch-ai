/**
 * lib/registry.ts — publish, roll back and inspect agents in the registry
 * (ADR 0018 items 4, 6 and 7, migration 0005_agent_registry.sql).
 *
 * `adk_agent_registry` holds one ACTIVE definition per id and is what the
 * server reads (`registry:<id>`, or a bare id listed in A2A_REGISTRY_AGENTS).
 * `adk_agent_registry_versions` holds every definition an id has ever had.
 * The database records a version on every write to the active table, so
 * history does not depend on using this module; what this module adds is
 * validation before anything is written, an author and a note on each
 * version, and rollback by version number.
 *
 * Every function takes either a client with supabase-js's `rpc` and `from`
 * (the service-role client) or a direct Postgres connection: anything with
 * pg's `query` (a `pg.Pool`, postgresStorage's `pool`, PGlite). Both run the
 * same SQL functions from the migration, so a version is recorded the same
 * way. `postgresRegistryReader` is what the server loads rows through on
 * DATABASE_URL. Nothing here prints a credential.
 */

import { bundleReferences } from './loadSyndicate.ts';
import type { RegistryReader } from './loadSyndicate.ts';
import { validateSyndicateConfig } from './syndicateSchema.ts';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The part of a supabase-js client this module uses. */
export interface RegistryClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  from(table: string): any;
}

/** The part of a direct Postgres connection this module uses: pg's `query` (a `pg.Pool`, PGlite). */
export interface RegistryPool {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** Where the registry is: the Supabase API, or a direct connection. */
export type RegistryStore = RegistryClient | RegistryPool;

const isPool = (c: RegistryStore): c is RegistryPool => typeof (c as RegistryClient).from !== 'function' && typeof (c as RegistryPool).query === 'function';

/** One statement on a direct connection; a database error goes through `fail` like the API's. */
async function sql(pool: RegistryPool, action: string, text: string, values: unknown[]): Promise<any[]> {
  try {
    return (await pool.query(text, values)).rows;
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string };
    fail(action, { message: e.message ?? String(err), ...(e.code ? { code: e.code } : {}) });
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
/** jsonb comes back parsed from pg and PGlite; a driver that returns text is parsed here. */
const json = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

/** The registry's active and stored definitions over a direct connection, for `loadSyndicateFromRegistry`. */
export function postgresRegistryReader(pool: RegistryPool): RegistryReader {
  return {
    async definition(id, version) {
      const rows = version === undefined
        ? await sql(pool, `Reading ${id}`, 'SELECT yaml_content FROM adk_agent_registry WHERE id = $1', [id])
        : await sql(pool, `Reading ${id}@${version}`, 'SELECT yaml_content FROM adk_agent_registry_versions WHERE id = $1 AND version = $2', [id, version]);
      return rows[0] ? json(rows[0].yaml_content) : undefined;
    },
  };
}

export interface RegistryVersion {
  id: string;
  version: number;
  configHash: string;
  publishedBy: string;
  publishedAt: string;
  note: string | null;
  /** true for the version the server currently loads */
  active: boolean;
}

export interface RegistryEntry {
  id: string;
  version: number | null;
  configHash: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
}

export interface PublishOptions {
  /** who published; recorded on the version (default: the database role) */
  author?: string;
  /** why; recorded on the version */
  note?: string;
}

export interface PublishAgentOptions extends PublishOptions {
  /**
   * Store every nested `yaml_reference` the definition reaches with it, read
   * from the agents root, so the version is one unit (ADR 0018 item 6).
   * Default true; a definition that already carries `bundled_references` is
   * stored as given. false stores the references bare, to load from files.
   */
  bundle?: boolean;
  /** Where nested references are read from (default: as `loadSyndicate`). */
  agentsDir?: string;
}

/** Registry ids the database accepts (the same rule as melchizedek_registry_publish). */
export const REGISTRY_ID = /^[A-Za-z0-9_.-]{1,120}$/;

/** `<id>@<version>` names one stored version; a bare id names the active one. */
export function parseRegistryRef(ref: string): { id: string; version?: number } {
  const m = /^(.+)@(\d+)$/.exec(ref);
  return m ? { id: m[1]!, version: Number(m[2]) } : { id: ref };
}

function assertId(id: string): void {
  if (!REGISTRY_ID.test(id)) throw new Error(`Invalid registry id '${id}': use letters, digits, '_', '-' or '.'.`);
}

/** A database error, with the one remedy that applies when the schema is old. */
function fail(action: string, error: { message: string; code?: string }): never {
  const missing = /melchizedek_registry_|adk_agent_registry_versions|does not exist|PGRST202|PGRST205|42883|42P01/i.test(
    `${error.message} ${error.code ?? ''}`,
  );
  throw new Error(
    missing
      ? `${action}: the versioned registry is not installed in this database. Run \`npm run db -- apply\` (db/migrations/0005_agent_registry.sql).`
      : `${action}: ${error.message}`,
  );
}

/**
 * Validate a definition and make it the active version of `id`. Returns the
 * version now active: a new number, or an existing one when the same
 * definition was published before (publishing it again re-activates it).
 */
export async function publishAgent(
  client: RegistryStore,
  id: string,
  config: unknown,
  options: PublishAgentOptions = {},
): Promise<number> {
  assertId(id);
  if (options.bundle !== false && isObject(config) && !('bundled_references' in config)) {
    const bundled = bundleReferences(config, { agentsDir: options.agentsDir });
    if (bundled) config = { ...config, bundled_references: bundled };
  }
  // The server validates every registry row at load (ADR 0018): an invalid
  // definition would publish fine and fail on its first request.
  validateSyndicateConfig(structuredClone(config), `registry:${id}`);
  if (isPool(client)) {
    const rows = await sql(client, `Publishing ${id}`, 'SELECT melchizedek_registry_publish($1, $2::jsonb, $3, $4) AS version', [id, JSON.stringify(config), options.author ?? null, options.note ?? null]);
    return Number(rows[0]?.version);
  }
  const { data, error } = await client.rpc('melchizedek_registry_publish', {
    p_id: id,
    p_config: config,
    p_author: options.author ?? null,
    p_note: options.note ?? null,
  });
  if (error) fail(`Publishing ${id}`, error);
  return Number(data);
}

/** Make a stored version active again (a rollback, or a roll forward). */
export async function activateVersion(
  client: RegistryStore,
  id: string,
  version: number,
  options: PublishOptions = {},
): Promise<number> {
  assertId(id);
  if (!Number.isInteger(version) || version < 1) throw new Error(`Invalid version ${version}.`);
  // A stored version passed validation when it was published, but the schema
  // may have moved since; refuse to activate what the server would refuse.
  validateSyndicateConfig(structuredClone(await getVersion(client, id, version)), `registry:${id}@${version}`);
  if (isPool(client)) {
    const rows = await sql(client, `Activating ${id}@${version}`, 'SELECT melchizedek_registry_activate($1, $2, $3, $4) AS version', [id, version, options.author ?? null, options.note ?? null]);
    return Number(rows[0]?.version);
  }
  const { data, error } = await client.rpc('melchizedek_registry_activate', {
    p_id: id,
    p_version: version,
    p_author: options.author ?? null,
    p_note: options.note ?? null,
  });
  if (error) fail(`Activating ${id}@${version}`, error);
  return Number(data);
}

/** One stored version's definition. */
export async function getVersion(client: RegistryStore, id: string, version: number): Promise<unknown> {
  if (isPool(client)) {
    const definition = await postgresRegistryReader(client).definition(id, version);
    if (definition === undefined) throw new Error(`Registry id ${id} has no version ${version}.`);
    return definition;
  }
  const { data, error } = await client
    .from('adk_agent_registry_versions')
    .select('yaml_content')
    .eq('id', id)
    .eq('version', version)
    .maybeSingle();
  if (error) fail(`Reading ${id}@${version}`, error);
  if (!data) throw new Error(`Registry id ${id} has no version ${version}.`);
  return data.yaml_content;
}

/** Every version of `id`, newest first, with the active one marked. */
export async function listVersions(client: RegistryStore, id: string): Promise<RegistryVersion[]> {
  if (isPool(client)) {
    const rows = await sql(
      client,
      `Listing versions of ${id}`,
      `SELECT v.id, v.version, v.config_hash, v.published_by, v.published_at, v.note, (a.version = v.version) AS active
         FROM adk_agent_registry_versions v LEFT JOIN adk_agent_registry a ON a.id = v.id
        WHERE v.id = $1 ORDER BY v.version DESC`,
      [id],
    );
    return rows.map((r) => ({ id: r.id, version: Number(r.version), configHash: r.config_hash, publishedBy: r.published_by, publishedAt: iso(r.published_at), note: r.note, active: r.active === true }));
  }
  const [versions, active] = await Promise.all([
    client
      .from('adk_agent_registry_versions')
      .select('id, version, config_hash, published_by, published_at, note')
      .eq('id', id)
      .order('version', { ascending: false }),
    client.from('adk_agent_registry').select('version').eq('id', id).maybeSingle(),
  ]);
  if (versions.error) fail(`Listing versions of ${id}`, versions.error);
  if (active.error) fail(`Reading the active version of ${id}`, active.error);
  const current = active.data?.version ?? null;
  return (versions.data ?? []).map((r: any) => ({
    id: r.id,
    version: r.version,
    configHash: r.config_hash,
    publishedBy: r.published_by,
    publishedAt: r.published_at,
    note: r.note,
    active: r.version === current,
  }));
}

/** The active entry of every published id. */
export async function listAgents(client: RegistryStore): Promise<RegistryEntry[]> {
  if (isPool(client)) {
    const rows = await sql(client, 'Listing the registry', 'SELECT id, version, config_hash, published_by, published_at FROM adk_agent_registry ORDER BY id', []);
    return rows.map((r) => ({ id: r.id, version: r.version ?? null, configHash: r.config_hash ?? null, publishedBy: r.published_by ?? null, publishedAt: r.published_at ? iso(r.published_at) : null }));
  }
  const { data, error } = await client
    .from('adk_agent_registry')
    .select('id, version, config_hash, published_by, published_at')
    .order('id');
  if (error) fail('Listing the registry', error);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    version: r.version ?? null,
    configHash: r.config_hash ?? null,
    publishedBy: r.published_by ?? null,
    publishedAt: r.published_at ?? null,
  }));
}

/**
 * Stop serving `id`: its active row goes, its versions stay. Publishing or
 * activating it again brings it back. Returns false when it was not active.
 */
export async function retireAgent(client: RegistryStore, id: string): Promise<boolean> {
  assertId(id);
  if (isPool(client)) return (await sql(client, `Retiring ${id}`, 'DELETE FROM adk_agent_registry WHERE id = $1 RETURNING id', [id])).length > 0;
  const { data, error } = await client.from('adk_agent_registry').delete().eq('id', id).select('id');
  if (error) fail(`Retiring ${id}`, error);
  return (data ?? []).length > 0;
}
