#!/usr/bin/env node
/**
 * scripts/context_report.ts — how much context each conversation resends.
 *
 *   npm run context:report                       the last 30 days of llm.request rows from the ledger (service-role client from .env)
 *   npm run context:report -- --days 7
 *   npm run context:report -- --rows rows.json   the same report over rows exported from any ledger (the app's PGlite one included)
 *
 * The question the report answers: per session, how fast does the prompt
 * grow step by step, and how much of it does the provider's prompt cache
 * carry? The curve is the baseline for plans/context-management.md; each
 * phase there should bend it.
 *
 * Per session it prints the steps, the input tokens of the first, the
 * median and the last step, the growth per step (a least-squares slope),
 * the total input over the session (tokens per task, the number that
 * matters), and the share of input read from the cache from the second
 * step on (the first step of a session can hit nothing). The totals line
 * weights every session by its steps.
 *
 * `--rows` takes a JSON array of objects with `session_id`, `ts`,
 * `input_tokens` and `cache_read_tokens` (adk_telemetry's columns; other
 * columns are ignored), so a ledger this script cannot reach is exported
 * once and read here. The app's: in its profile folder's database,
 * `SELECT session_id, ts, input_tokens, cache_read_tokens FROM adk_telemetry
 * WHERE span_name = 'llm.request'`.
 *
 * Reads only. Prints no credential and no prompt text.
 */

import { readFileSync } from 'node:fs';

import { loadEnv } from '../lib/loadEnv.ts';
import { hasSupabaseCredentials } from '../lib/persistence/supabaseProvider.ts';

/** One llm.request row, as the ledger stores it (lib/observability/supabaseSpanExporter.ts). */
export interface StepRow {
  session_id: string | null;
  ts: string;
  input_tokens: number | null;
  cache_read_tokens: number | null;
}

export interface SessionReport {
  session: string;
  steps: number;
  first: number;
  median: number;
  last: number;
  /** Input tokens added per step, by least squares over the session's steps. */
  perStep: number;
  /** Input tokens over every step: what the session cost in context. */
  total: number;
  /** Cache-read tokens over input tokens from the second step on; undefined with one step or no input. */
  cacheShare: number | undefined;
}

export interface ContextReport {
  sessions: SessionReport[];
  /** Every session's steps together. */
  totals: { sessions: number; steps: number; input: number; cacheShare: number | undefined; perStep: number | undefined };
}

const num = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** The least-squares slope of `values` over their indexes; 0 with fewer than two. */
function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  values.forEach((y, x) => {
    cov += (x - meanX) * (y - meanY);
    varX += (x - meanX) ** 2;
  });
  return varX === 0 ? 0 : cov / varX;
}

/** The report over `rows`, in any order; rows without a session are left out. */
export function contextReport(rows: readonly StepRow[]): ContextReport {
  const bySession = new Map<string, StepRow[]>();
  for (const row of rows) {
    if (!row.session_id) continue;
    const list = bySession.get(row.session_id) ?? [];
    list.push(row);
    bySession.set(row.session_id, list);
  }
  const sessions: SessionReport[] = [];
  let steps = 0;
  let input = 0;
  let cachedInput = 0;
  let cachedRead = 0;
  const slopes: number[] = [];
  for (const [session, list] of bySession) {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    const inputs = list.map((r) => num(r.input_tokens));
    const total = inputs.reduce((a, b) => a + b, 0);
    const later = list.slice(1);
    const laterInput = later.reduce((a, r) => a + num(r.input_tokens), 0);
    const laterRead = later.reduce((a, r) => a + num(r.cache_read_tokens), 0);
    const perStep = Math.round(slope(inputs));
    sessions.push({
      session,
      steps: list.length,
      first: inputs[0]!,
      median: median(inputs),
      last: inputs[inputs.length - 1]!,
      perStep,
      total,
      cacheShare: laterInput > 0 ? laterRead / laterInput : undefined,
    });
    steps += list.length;
    input += total;
    cachedInput += laterInput;
    cachedRead += laterRead;
    if (list.length >= 2) slopes.push(perStep);
  }
  sessions.sort((a, b) => b.total - a.total);
  return {
    sessions,
    totals: {
      sessions: sessions.length,
      steps,
      input,
      cacheShare: cachedInput > 0 ? cachedRead / cachedInput : undefined,
      perStep: slopes.length > 0 ? Math.round(slopes.reduce((a, b) => a + b, 0) / slopes.length) : undefined,
    },
  };
}

const pct = (share: number | undefined): string => (share === undefined ? '-' : `${Math.round(share * 100)}%`);
const n = (v: number): string => v.toLocaleString('en-US');

/** The report as the terminal shows it. */
export function formatReport(report: ContextReport, limit = 25): string {
  const lines: string[] = [];
  lines.push(`${'session'.padEnd(26)} ${'steps'.padStart(5)} ${'first'.padStart(8)} ${'median'.padStart(8)} ${'last'.padStart(8)} ${'per step'.padStart(9)} ${'total'.padStart(10)} ${'cached'.padStart(6)}`);
  for (const s of report.sessions.slice(0, limit)) {
    lines.push(
      `${s.session.slice(0, 26).padEnd(26)} ${String(s.steps).padStart(5)} ${n(s.first).padStart(8)} ${n(s.median).padStart(8)} ${n(s.last).padStart(8)} ${n(s.perStep).padStart(9)} ${n(s.total).padStart(10)} ${pct(s.cacheShare).padStart(6)}`,
    );
  }
  if (report.sessions.length > limit) lines.push(`… ${report.sessions.length - limit} more sessions`);
  const t = report.totals;
  lines.push('');
  lines.push(`${t.sessions} sessions, ${n(t.steps)} steps, ${n(t.input)} input tokens; ${t.perStep === undefined ? '-' : n(t.perStep)} added per step on average; ${pct(t.cacheShare)} of input after the first step read from the cache.`);
  return lines.join('\n');
}

async function rowsFromLedger(days: number): Promise<StepRow[]> {
  if (!hasSupabaseCredentials()) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set; pass --rows <file.json> to read an export instead.');
    process.exit(1);
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows: StepRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('adk_telemetry')
      .select('session_id, ts, input_tokens, cache_read_tokens')
      .eq('span_name', 'llm.request')
      .gte('ts', since)
      .order('ts', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(`adk_telemetry: ${error.message}`);
    rows.push(...((data ?? []) as StepRow[]));
    if (!data || data.length < page) break;
  }
  return rows;
}

async function main(): Promise<void> {
  loadEnv(import.meta.url);
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const file = flag('--rows');
  const days = Number(flag('--days') ?? 30);
  const rows = file ? (JSON.parse(readFileSync(file, 'utf8')) as StepRow[]) : await rowsFromLedger(days);
  console.log(file ? `${rows.length} llm.request rows from ${file}` : `${rows.length} llm.request rows in the last ${days} days`);
  console.log('');
  console.log(formatReport(contextReport(rows)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
