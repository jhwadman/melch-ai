/**
 * lib/persistence/supabaseProvider.ts — Supabase initialization factory.
 *
 * WHY this file exists:
 *   This module encapsulates ALL Supabase-specific concerns:
 *     - Credential detection (reads env vars)
 *     - App initialization
 *     - Service construction (SupabaseSessionService, SupabaseVectorMemoryService)
 */

import type { SessionService } from '../runtime/sessions.ts';
import type { MemoryService } from '../runtime/memoryService.ts';
import { isPlaceholderValue } from '../loadEnv.ts';
import type { Embedder, MemoryExtractor } from '../memory/providers.ts';

import { evaluateRlsRows } from '../storage/rlsStatus.ts';
import type { RlsHardeningStatus, RlsRow } from '../storage/rlsStatus.ts';

export type { RlsHardeningStatus } from '../storage/rlsStatus.ts';

export interface PersistenceServices {
  sessionService: SessionService;
  memoryService: MemoryService | undefined;
  /**
   * Checks whether the database hardening in db/hardening.sql has been
   * applied (RLS enabled on adk_memory_facts, adk_sessions and — where it
   * exists — adk_agent_registry). Never
   * throws — callers use this to warn operators at boot, not to gate.
   */
  checkRlsHardening: () => Promise<RlsHardeningStatus>;
  /** RPC access for operations that span stores (lib/memory/erase.ts). */
  rpcClient: { rpc: (fn: string, args?: Record<string, unknown>) => any };
  /** The highest migration recorded in melchizedek_schema_version; null if none. */
  schemaVersion: () => Promise<number | null>;
}

export interface SupabaseProviderOptions {
  /** The Gemini API key passed to SupabaseVectorMemoryService for embeddings. */
  apiKey: string;
  /** Whether to construct the SupabaseVectorMemoryService (long-term memory). */
  withMemory: boolean;
  /** Fact extractor and embedder for memory (lib/memory/providers.ts).
   *  Default: from the environment (MEMORY_* variables), Gemini when unset. */
  extractor?: MemoryExtractor;
  embedder?: Embedder;
}

/**
 * Returns true if all required Supabase credentials are present in the
 * environment. Does NOT throw — callers use this to decide whether to
 * fall back to in-memory services.
 */
export function hasSupabaseCredentials(): boolean {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key || isPlaceholderValue(url) || isPlaceholderValue(key)) return false;
  // A value that is not an http(s) URL is a misconfiguration, not credentials:
  // treating it as present crashed supabase-js before the first prompt.
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Initializes the Supabase client and constructs the
 * SupabaseSessionService and optionally the SupabaseVectorMemoryService.
 */
export async function createSupabaseServices(
  options: SupabaseProviderOptions,
): Promise<PersistenceServices> {
  const { createClient } = await import('@supabase/supabase-js');

  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // ── Session service ────────────────────────────────────────────────────────
  const { SupabaseSessionService } = await import(
    '../session/supabaseSessionService.ts'
  );
  const sessionService = new SupabaseSessionService(supabase);

  // ── Memory service (optional) ──────────────────────────────────────────────
  let memoryService: MemoryService | undefined;
  if (options.withMemory) {
    const { SupabaseVectorMemoryService } = await import(
      '../memory/supabaseMemoryService.ts'
    );
    memoryService = new SupabaseVectorMemoryService(
      { apiKey: options.apiKey, extractor: options.extractor, embedder: options.embedder },
      supabase,
    );
  }

  // ── Hardening probe ─────────────────────────────────────────────────────────
  // Calls the melchizedek_rls_status() function created by db/hardening.sql.
  // If the function is missing, hardening was never run — that is itself the
  // answer, not an error.
  const checkRlsHardening = async (): Promise<RlsHardeningStatus> => {
    try {
      const { data, error } = await supabase.rpc('melchizedek_rls_status');
      if (error) {
        return {
          applied: false,
          detail: 'db/hardening.sql has not been applied (status function missing)',
        };
      }
      return evaluateRlsRows((data ?? []) as RlsRow[]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { applied: false, detail: `hardening check failed: ${msg}` };
    }
  };

  const schemaVersion = async (): Promise<number | null> => {
    const { data, error } = await supabase
      .from('melchizedek_schema_version')
      .select('version')
      .order('version', { ascending: false })
      .limit(1);
    if (error) {
      // No version table: the migrations were never applied.
      if (/does not exist|PGRST205|42P01/i.test(`${error.message} ${(error as { code?: string }).code ?? ''}`)) return null;
      throw new Error(`Reading melchizedek_schema_version: ${error.message}`);
    }
    return data?.[0]?.version == null ? null : Number(data[0].version);
  };

  return { sessionService, memoryService, checkRlsHardening, rpcClient: supabase, schemaVersion };
}
