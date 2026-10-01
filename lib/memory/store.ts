/**
 * lib/memory/store.ts — where memory facts live (ADR 0021).
 *
 * The memory service (lib/memory/supabaseMemoryService.ts) owns the logic:
 * extraction, dedup, supersession, re-ranked recall. This interface is the
 * five things that logic asks of a database, so the same logic runs over the
 * Supabase REST client or a direct Postgres connection
 * (lib/storage/postgres/memoryStore.ts). Both use the same table and the same
 * `match_memory_facts` function (db/migrations/0001_base.sql).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** One row as `match_memory_facts` returns it. */
export interface FactRow {
  id: string;
  user_key: string;
  fact: string;
  tag: string | null;
  fact_date: string | null;
  source: string | null;
  status: string | null;
  keys: string[] | null;
  created_at: string;
  similarity: number;
}

export interface NewFact {
  user_key: string;
  fact: string;
  embedding: number[];
  tag: string;
  fact_date: string | null;
  source: string | null;
  status: string;
  keys: string[];
}

export interface MemoryStore {
  /** Which of `facts` are already stored, byte for byte, under `userKey`. */
  existingFacts(userKey: string, facts: string[]): Promise<Set<string>>;
  /** Nearest facts of one user key by cosine similarity. Throws on failure. */
  match(userKey: string, embedding: number[], count: number): Promise<FactRow[]>;
  /** Inserts the rows; returns each new row's id with its fact. Throws on failure. */
  insert(rows: NewFact[]): Promise<Array<{ id: string; fact: string }>>;
  /** Marks one row superseded by another. Throws on failure. */
  retire(userKey: string, id: string, supersededBy: string): Promise<void>;
  /** Deletes every fact of a user key; returns how many. Throws on failure. */
  deleteUser(userKey: string): Promise<number>;

  // ── Optional: the atomic commit (migration 0007, ADR 0020) ─────────────────
  // A store with these gets durable ingestion: facts, their supersessions and
  // the session's processed marker commit together. A store without them
  // falls back to insert + retire and an in-process marker.

  /** Inserts `rows`, retires each `retire[i].id` superseded by the new row
   *  whose fact is `byFact`, and advances the session's marker to `events`,
   *  in one transaction. Returns the inserted rows. Throws on failure. */
  commit?(
    userKey: string,
    marker: { sessionId: string; events: number } | null,
    rows: NewFact[],
    retire: Array<{ id: string; byFact: string }>,
  ): Promise<Array<{ id: string; fact: string }>>;
  /** Events of this session already distilled (the durable marker); 0 if none. */
  ingestedEvents?(userKey: string, sessionId: string): Promise<number>;
  /** The embedding column's vector size; null when it cannot be read. */
  embeddingDimensions?(): Promise<number | null>;
}

/** The JSON shape melchizedek_memory_commit takes for its rows. */
export function commitRows(rows: NewFact[]): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    fact: r.fact,
    embedding: r.embedding,
    tag: r.tag,
    fact_date: r.fact_date,
    source: r.source,
    status: r.status,
    keys: r.keys,
  }));
}

/** The Supabase REST implementation (what the memory service used inline). */
export function supabaseMemoryStore(supabase: SupabaseClient): MemoryStore {
  return {
    async existingFacts(userKey, facts) {
      const { data } = await supabase
        .from('adk_memory_facts')
        .select('fact')
        .eq('user_key', userKey)
        .in('fact', facts);
      return new Set((data ?? []).map((row: { fact: string }) => row.fact));
    },
    async match(userKey, embedding, count) {
      const { data, error } = await supabase.rpc('match_memory_facts', {
        query_embedding: embedding,
        match_count: count,
        filter_user_key: userKey,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as FactRow[];
    },
    async insert(rows) {
      const { data, error } = await supabase.from('adk_memory_facts').insert(rows).select('id, fact');
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ id: string; fact: string }>;
    },
    async retire(userKey, id, supersededBy) {
      const { error } = await supabase
        .from('adk_memory_facts')
        .update({ status: 'superseded', superseded_by: supersededBy })
        .eq('id', id)
        .eq('user_key', userKey);
      if (error) throw new Error(error.message);
    },
    async deleteUser(userKey) {
      const { count, error } = await supabase
        .from('adk_memory_facts')
        .delete({ count: 'exact' })
        .eq('user_key', userKey);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    async commit(userKey, marker, rows, retire) {
      const { data, error } = await supabase.rpc('melchizedek_memory_commit', {
        p_user_key: userKey,
        p_session_id: marker?.sessionId ?? null,
        p_events: marker?.events ?? null,
        p_rows: commitRows(rows),
        p_retire: retire.map((r) => ({ id: r.id, by_fact: r.byFact })),
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{ new_id: string; new_fact: string }>).map((r) => ({ id: String(r.new_id), fact: r.new_fact }));
    },
    async ingestedEvents(userKey, sessionId) {
      const { data, error } = await supabase
        .from('melchizedek_memory_ingest')
        .select('events_ingested')
        .eq('user_key', userKey)
        .eq('session_id', sessionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.events_ingested ?? 0;
    },
    async embeddingDimensions() {
      const { data, error } = await supabase.rpc('melchizedek_memory_dimensions');
      if (error) throw new Error(error.message);
      return data == null ? null : Number(data);
    },
  };
}

/** True for a Supabase client (as opposed to a MemoryStore). */
export function isSupabaseClient(x: unknown): x is SupabaseClient {
  return !!x && typeof (x as SupabaseClient).from === 'function' && typeof (x as SupabaseClient).rpc === 'function';
}
