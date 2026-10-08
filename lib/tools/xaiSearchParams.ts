/**
 * lib/tools/xaiSearchParams.ts — the deployment settings for xAI's
 * server-side search tools, read from the environment at request-build time.
 *
 * WHY its own module: GrokAdapter (lib/models/grokAdapter.ts) reads these
 * on the engine's own contract, and the tool modules that also export them
 * (webSearchTool.ts, xSearchTool.ts, collectionsSearchTool.ts) extend ADK's
 * BaseTool. Here they import nothing, so the `melchizedek-agents/model`
 * entry reaches no @google/adk. The tool modules re-export each reader under
 * its old name.
 *
 * THE DOCTRINE (unchanged): constraints are deployment configuration, never
 * YAML, so the YAML stays shareable. Misconfiguration degrades with a
 * warning, never fatally.
 *   - web_search (docs.x.ai/developers/tools/web-search, 2026-08-08):
 *     allowed_domains / excluded_domains, at most 5 each and mutually
 *     exclusive, nested under `filters`. No date bounds. xAI only: OpenAI's
 *     web_search takes no such params.
 *   - x_search (docs.x.ai/developers/tools/x-search, 2026-08-02):
 *     from_date / to_date (YYYY-MM-DD) and allowed_x_handles /
 *     excluded_x_handles, at most 20 each and mutually exclusive.
 *   - collections_search: XAI_COLLECTION_IDS (comma-separated) and an
 *     optional XAI_COLLECTIONS_MAX_RESULTS cap.
 * When both lists of a pair are set, the allowlist wins. Oversize lists
 * truncate. Malformed dates are dropped.
 */

/** xAI's documented ceiling on allowed_domains / excluded_domains. */
const XAI_WEB_SEARCH_MAX_DOMAINS = 5;

/** xAI's documented ceiling on allowed_x_handles / excluded_x_handles. */
const X_SEARCH_MAX_HANDLES = 20;

/** Comma-separated domains from an env var; trimmed, capped at xAI's limit. */
function domainsFromEnv(name: string): string[] {
  const domains = (process.env[name] ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length > XAI_WEB_SEARCH_MAX_DOMAINS) {
    console.warn(
      `[web_search] ${name} lists ${domains.length} domains — xAI caps the ` +
        `list at ${XAI_WEB_SEARCH_MAX_DOMAINS}; keeping the first ${XAI_WEB_SEARCH_MAX_DOMAINS}.`,
    );
    return domains.slice(0, XAI_WEB_SEARCH_MAX_DOMAINS);
  }
  return domains;
}

/**
 * Optional server-side domain filters for xAI's web_search tool. With
 * nothing configured this returns {} and the tool ships bare. xAI only:
 * apply on the xAI path, never on OpenAI's web_search.
 */
export function xaiWebSearchParamsFromEnv(): Record<string, unknown> {
  const allowed = domainsFromEnv('XAI_WEB_SEARCH_ALLOWED_DOMAINS');
  const excluded = domainsFromEnv('XAI_WEB_SEARCH_EXCLUDED_DOMAINS');
  if (allowed.length > 0 && excluded.length > 0) {
    console.warn(
      '[web_search] XAI_WEB_SEARCH_ALLOWED_DOMAINS and _EXCLUDED_DOMAINS are ' +
        'mutually exclusive (xAI rejects both together) — keeping the ' +
        'allowlist, dropping the exclusions.',
    );
  }
  if (allowed.length > 0) return { filters: { allowed_domains: allowed } };
  if (excluded.length > 0) return { filters: { excluded_domains: excluded } };
  return {};
}

/** ISO date (YYYY-MM-DD) from an env var; malformed values warn and drop. */
function isoDateFromEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    console.warn(`[x_search] ${name}="${raw}" is not YYYY-MM-DD — ignored.`);
    return undefined;
  }
  return raw;
}

/** Comma-separated handles from an env var; trimmed, @-stripped, capped. */
function handlesFromEnv(name: string): string[] {
  const handles = (process.env[name] ?? '')
    .split(',')
    .map((h) => h.trim().replace(/^@/, ''))
    .filter(Boolean);
  if (handles.length > X_SEARCH_MAX_HANDLES) {
    console.warn(
      `[x_search] ${name} lists ${handles.length} handles — xAI caps the ` +
        `list at ${X_SEARCH_MAX_HANDLES}; keeping the first ${X_SEARCH_MAX_HANDLES}.`,
    );
    return handles.slice(0, X_SEARCH_MAX_HANDLES);
  }
  return handles;
}

/**
 * Optional server-side constraints for the x_search tool. With nothing
 * configured this returns {} and the tool ships bare.
 */
export function xSearchParamsFromEnv(): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const from = isoDateFromEnv('XAI_X_SEARCH_FROM_DATE');
  const to = isoDateFromEnv('XAI_X_SEARCH_TO_DATE');
  if (from) params.from_date = from;
  if (to) params.to_date = to;
  const allowed = handlesFromEnv('XAI_X_SEARCH_ALLOWED_HANDLES');
  const excluded = handlesFromEnv('XAI_X_SEARCH_EXCLUDED_HANDLES');
  if (allowed.length > 0 && excluded.length > 0) {
    console.warn(
      '[x_search] XAI_X_SEARCH_ALLOWED_HANDLES and _EXCLUDED_HANDLES are ' +
        'mutually exclusive (xAI rejects both together) — keeping the ' +
        'allowlist, dropping the exclusions.',
    );
  }
  if (allowed.length > 0) params.allowed_x_handles = allowed;
  else if (excluded.length > 0) params.excluded_x_handles = excluded;
  return params;
}

/** Collection ids from XAI_COLLECTION_IDS (comma-separated, trimmed). */
export function collectionIdsFromEnv(): string[] {
  return (process.env.XAI_COLLECTION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Optional retrieval cap from XAI_COLLECTIONS_MAX_RESULTS (positive int). */
export function collectionsMaxResultsFromEnv(): number | undefined {
  const raw = process.env.XAI_COLLECTIONS_MAX_RESULTS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
