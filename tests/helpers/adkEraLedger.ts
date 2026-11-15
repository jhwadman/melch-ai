/**
 * tests/helpers/adkEraLedger.ts — what the parity suites set aside when they
 * compare the ledger against ADK's recorded rows: what the engine records
 * beyond them (ADR 0139, and the run key of ADR 0159). ADK's recording has none
 * of it; tests/spanTree.test.ts, tests/nativeLedger.test.ts,
 * tests/postgresLedger.test.ts and tests/runKey.test.ts check its values.
 */

/** The span tree's columns, the cache counts and the run key. */
export const SPAN_TREE_COLUMNS = ['parent_span_id', 'kind', 'error', 'cache_read_tokens', 'cache_write_tokens', 'run_id', 'run_step_span_id'];

/** The cache counts, the finish reason and the recorded ledger parent. */
export const SPAN_TREE_ATTRIBUTES = [
  'syndicate.tokens.cache_read',
  'syndicate.tokens.cache_write',
  'llm.finish_reason',
  'llm.tokens.cache_read',
  'llm.tokens.cache_write',
  'ledger.parent_span_id',
];

/** The spans ADK's ledger kept a row for: the root and each llm.request. The rest of the tree is the engine's own. */
export const adkEraRow = (row: { span_name: string }): boolean =>
  row.span_name === 'llm.request' || row.span_name.startsWith('Syndicate Execution: ');

/** `row` without the engine's additions, its attributes (and its span's) too. */
export function withoutSpanTree<T extends Record<string, any>>(row: T): T {
  const out: Record<string, any> = { ...row };
  for (const key of SPAN_TREE_COLUMNS) delete out[key];
  const strip = (attrs: Record<string, unknown> | undefined) => {
    if (!attrs) return attrs;
    const copy = { ...attrs };
    for (const key of SPAN_TREE_ATTRIBUTES) delete copy[key];
    return copy;
  };
  if (out.attributes) out.attributes = strip(out.attributes);
  if (out.span?.attributes) out.span = { ...out.span, attributes: strip(out.span.attributes) };
  return out as T;
}
