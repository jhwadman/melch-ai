/**
 * tests/helpers/fakeSupabase.ts — an in-memory stand-in for the supabase-js
 * calls the Supabase session service makes, so a test can read the rows it
 * writes without a network.
 *
 * It keeps PostgREST's meanings where the service depends on them:
 *   - values cross a wire: every row is stored and returned as JSON;
 *   - `eq` compares text, so `eq('user_id', undefined)` asks for the user
 *     named "undefined", as `user_id=eq.undefined` does;
 *   - an upsert merges the columns given into an existing row, or with
 *     `ignoreDuplicates` leaves it alone and returns nothing for it;
 *   - `created_at` is set once, on insert;
 *   - `single()` on anything but one row is error PGRST116;
 *   - `count: 'exact'` counts every match, before `range`.
 */

type Row = Record<string, unknown>;

interface Result {
  data: unknown;
  error: { code?: string; message: string } | null;
  count?: number | null;
}

export interface FakeSupabase {
  /** The client to hand the service. */
  client: any;
  /** Every table's rows, by primary key `id`, in insertion order. */
  tables: Map<string, Map<string, Row>>;
  /** The rows of one table, as stored. */
  rows(table: string): Row[];
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}

export function fakeSupabase(): FakeSupabase {
  const tables = new Map<string, Map<string, Row>>();
  let clock = 0;
  const table = (name: string) => {
    let t = tables.get(name);
    if (!t) tables.set(name, (t = new Map()));
    return t;
  };

  const from = (name: string) => {
    let mode: 'select' | 'upsert' | 'delete' = 'select';
    let columns: string | undefined;
    let count = false;
    let single = false;
    let range: [number, number] | undefined;
    let values: Row | undefined;
    let ignoreDuplicates = false;
    const filters: Array<[string, unknown]> = [];
    const order: Array<{ column: string; ascending: boolean }> = [];

    const project = (row: Row): Row => {
      if (!columns || columns === '*') return JSON.parse(JSON.stringify(row));
      const out: Row = {};
      for (const c of columns.split(',').map((s) => s.trim())) out[c] = row[c];
      return JSON.parse(JSON.stringify(out));
    };
    const matches = (row: Row) => filters.every(([c, v]) => String(row[c]) === String(v));

    const run = (): Result => {
      const t = table(name);
      if (mode === 'delete') {
        for (const [id, row] of [...t]) if (matches(row)) t.delete(id);
        return { data: null, error: null };
      }
      if (mode === 'upsert') {
        const incoming = JSON.parse(JSON.stringify(values)) as Row;
        const id = String(incoming.id);
        const existing = t.get(id);
        let written: Row | undefined;
        if (existing) {
          if (!ignoreDuplicates) written = Object.assign(existing, incoming, { updated_at: ++clock });
        } else {
          written = { created_at: ++clock, updated_at: clock, ...incoming };
          t.set(id, written);
        }
        return { data: columns === undefined ? null : written ? [project(written)] : [], error: null };
      }
      let rows = [...t.values()].filter(matches);
      const total = rows.length;
      if (order.length) {
        rows.sort((a, b) => {
          for (const { column, ascending } of order) {
            const d = compare(a[column], b[column]);
            if (d) return ascending ? d : -d;
          }
          return 0;
        });
      }
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (single) {
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
        return { data: project(rows[0]!), error: null };
      }
      return { data: rows.map(project), error: null, count: count ? total : null };
    };

    const builder: any = {
      select(cols = '*', opts?: { count?: string }) {
        columns = cols;
        count = opts?.count === 'exact';
        return builder;
      },
      upsert(row: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        mode = 'upsert';
        values = row;
        ignoreDuplicates = opts?.ignoreDuplicates ?? false;
        return builder;
      },
      delete() {
        mode = 'delete';
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      order(column: string, opts: { ascending?: boolean } = {}) {
        order.push({ column, ascending: opts.ascending ?? true });
        return builder;
      },
      range(start: number, end: number) {
        range = [start, end];
        return builder;
      },
      single() {
        single = true;
        return builder;
      },
      then(resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) {
        try {
          return Promise.resolve(resolve(run()));
        } catch (err) {
          return reject ? Promise.resolve(reject(err)) : Promise.reject(err);
        }
      },
    };
    return builder;
  };

  return {
    client: { from },
    tables,
    rows: (name: string) => [...table(name).values()].map((r) => JSON.parse(JSON.stringify(r)) as Row),
  };
}
