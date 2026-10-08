/**
 * lib/runtime/memoryService.ts — the engine's own long-term memory interface
 * (ADR 0045, ADR 0052).
 *
 * WHY this file exists:
 *   Long-term memory (lib/memory/supabaseMemoryService.ts) implements ADK's
 *   BaseMemoryService, which the ADK runtime calls through its load_memory
 *   and preload_memory tools. The native runtime calls this interface
 *   instead; the service moves onto it, with those tools as the engine's
 *   own, in WS2-3. The shapes match what the service does today, extras
 *   included: per-syndicate extraction rules and model, erasure, retention
 *   and the boot-time dimension check, which the A2A server reaches by
 *   name (lib/a2a/app.ts).
 *
 * SILOS: every fact is filed under `<appName>/<userId>`, and a search reads
 * that key alone. `appName` is the memory namespace, not the agent that
 * asks: the runtime pins it to the root syndicate's `memory_namespace`
 * (lib/memory/namespace.ts, ADR 0020), so a subagent finds what its
 * orchestrator's conversations stored.
 *
 * Types only, and every import is a type: nothing in this module's import
 * graph names @google/* (tests/events.test.ts asserts it).
 */

import type { TurnContent } from './events.ts';
import type { Session } from './sessions.ts';

export interface MemorySearchRequest {
  /** The memory namespace. */
  appName: string;
  userId: string;
  /** What the person asked, as written. A service strips harness blocks before embedding it. */
  query: string;
}

/** One recalled memory: the same JSON as ADK's `MemoryEntry`, so a recall reads the same on either runtime. */
export interface MemoryEntry {
  /** The fact as text, in one part. A superseded fact says so in its text. */
  content: TurnContent;
  /** Who it is attributed to; the engine's service writes `memory_service`. */
  author?: string;
  /** When it was stored, ISO 8601. */
  timestamp?: string;
  id?: string;
  customMetadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  /** Best first. Empty when nothing matched or the store could not be read; a failed embedding throws instead. */
  memories: MemoryEntry[];
}

export interface MemoryIngestOptions {
  /** The syndicate's `memory_extraction_rules`, appended to the extraction prompt for it alone. */
  extractionRules?: string;
  /** The syndicate's `memory_extraction_model`, in place of the deployment's. */
  extractionModel?: string;
}

export interface MemoryService {
  /**
   * Distils the session's events not yet ingested into facts, filed under
   * `<session.appName>/<session.userId>`. The runtime calls it after the
   * answer is delivered, so it never delays one. Throws when a step fails,
   * leaving those events pending for the next ingestion: a failure never
   * marks an event done.
   */
  ingest(session: Session, options?: MemoryIngestOptions): Promise<void>;
  /** The facts most relevant to the query, from that user's silo only. */
  search(request: MemorySearchRequest): Promise<MemorySearchResult>;
  /** Deletes every fact of one `<appName>/<userId>` key; returns how many. Throws rather than do nothing. */
  deleteUserMemory?(userKey: string): Promise<number>;
  /** Deletes facts in `namespace` older than `days`; null when the store cannot prune. */
  pruneExpired?(namespace: string, days: number): Promise<number | null>;
  /** Throws when the embedder's vectors would not fit the stored column; the server calls it at boot. */
  verifyEmbeddingDimensions?(): Promise<void>;
}
