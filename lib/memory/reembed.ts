/**
 * lib/memory/reembed.ts — re-embed every stored fact with the current
 * embedder, then record it as the store's (ADR 0148).
 *
 * WHY this file exists:
 *   A memory store's vectors come from one model (migration 0023, ADR 0147):
 *   the service refuses an embedder whose model differs, which is correct
 *   and left the operator with no tool to carry a switch out. This is that
 *   tool, behind `npm run memory -- reembed` (scripts/memory_admin.ts): it
 *   walks the facts in pages, embeds each page with the new embedder, writes
 *   the vectors back, and only then overwrites the record, so a store that
 *   is interrupted half-way still says its old model and the service still
 *   refuses the new one until the run completes.
 *
 * WHAT IT REFUSES:
 *   - a dimension that does not fit the column (the column is fixed at
 *     creation; changing its size is a migration, never a re-embed);
 *   - a store whose backend cannot list or update facts (an older store).
 *   A dry run (the default in the script) counts and names, writes nothing.
 *
 * WHAT IT NEVER PRINTS: a fact. The log carries counts, models and sizes.
 */

import type { Embedder } from './providers.ts';
import type { EmbedderRecord, MemoryStore } from './store.ts';

export interface ReembedOptions {
  /** Facts per embedding call and per update (default 32). */
  batch?: number;
  /** Count and plan; write nothing (default false). */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface ReembedReport {
  /** The record before the run, when the store had one. */
  before: EmbedderRecord | null;
  /** The embedder the facts now carry (or would, on a dry run). */
  after: EmbedderRecord;
  facts: number;
  /** Rows re-embedded and written; 0 on a dry run. */
  written: number;
  dryRun: boolean;
}

/** The store methods a re-embed needs; an older store lacking them is refused by name. */
function need(store: MemoryStore): asserts store is MemoryStore & Required<Pick<MemoryStore, 'listFacts' | 'updateEmbeddings' | 'setEmbedder'>> {
  const missing = (['listFacts', 'updateEmbeddings', 'setEmbedder'] as const).filter((m) => !store[m]);
  if (missing.length) throw new Error(`This memory store cannot be re-embedded: it lacks ${missing.join(', ')} (an older backend; apply the current migrations and use the package's store).`);
}

/**
 * Re-embeds every fact with `embedder` and records it as the store's. The
 * column's size must equal the embedder's; the run is in id order, one page
 * at a time, and the record is written last.
 */
export async function reembedMemory(store: MemoryStore, embedder: Embedder, opts: ReembedOptions = {}): Promise<ReembedReport> {
  const batch = Math.max(1, Math.min(256, Math.floor(opts.batch ?? 32)));
  const log = opts.log ?? (() => {});
  need(store);
  const after: EmbedderRecord = { provider: embedder.provider, model: embedder.model, dimensions: embedder.dimensions };
  const before = store.embedderRecord ? await store.embedderRecord() : null;
  const column = store.embeddingDimensions ? await store.embeddingDimensions() : null;
  if (column != null && column !== embedder.dimensions) {
    throw new Error(
      `The memory table's embedding column holds ${column}-dimension vectors and ${embedder.provider}/${embedder.model} produces ${embedder.dimensions}; ` +
        'a re-embed cannot change the column. Set MEMORY_EMBEDDING_DIMENSIONS to a size the model and the column share, or migrate the column first.',
    );
  }
  log(`store: ${before ? `${before.provider}/${before.model} (${before.dimensions}d)` : 'no embedder recorded'} → ${after.provider}/${after.model} (${after.dimensions}d)`);

  let facts = 0;
  let written = 0;
  let cursor: string | null = null;
  for (;;) {
    const page = await store.listFacts(cursor, batch);
    if (page.length === 0) break;
    facts += page.length;
    cursor = page[page.length - 1]!.id;
    if (opts.dryRun) continue;
    const vectors = await embedder.embed(page.map((r) => r.fact));
    if (vectors.length !== page.length) throw new Error(`the embedder returned ${vectors.length} vectors for ${page.length} facts`);
    await store.updateEmbeddings(page.map((r, i) => ({ id: r.id, embedding: vectors[i]! })));
    written += page.length;
    log(`re-embedded ${written} of at least ${facts}…`);
  }
  if (opts.dryRun) {
    log(`dry run: ${facts} fact${facts === 1 ? '' : 's'} would be re-embedded with ${after.model}; nothing written`);
    return { before, after, facts, written: 0, dryRun: true };
  }
  await store.setEmbedder(after);
  log(`done: ${written} fact${written === 1 ? '' : 's'} re-embedded; the store now records ${after.provider}/${after.model} (${after.dimensions}d)`);
  return { before, after, facts, written, dryRun: false };
}
