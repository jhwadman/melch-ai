/**
 * lib/runtime/adkMemoryBridge.ts — one memory service, either runtime
 * (ADR 0059, ADR 0080).
 *
 * WHY this file exists:
 *   Until ADK leaves at 1.0, the ADK runtime and ingestTurnMemory call ADK's
 *   BaseMemoryService methods (searchMemory, addSessionToMemory), and the
 *   native runtime the engine's MemoryService (lib/runtime/memoryService.ts:
 *   search, ingest). The engine's service implements both (ADR 0059 item 1),
 *   so it passes through here unchanged, and so does a consumer's ADK
 *   service. A service that implements only the engine's interface gets
 *   ADK's face from MemoryServiceForAdk: ADK's two methods hand their
 *   arguments to the engine's, as the engine's own service does.
 *
 *   The bridge is applied at the seam, where a surface hands its service to
 *   the turn runner; the A2A server keeps the service it was given for its
 *   by-name checks (verifyEmbeddingDimensions, pruneExpired,
 *   deleteUserMemory), and the bridge forwards those too.
 *
 * This module imports ADK's types only, and loads nothing at run time.
 */

import type {
  BaseMemoryService,
  SearchMemoryRequest,
  SearchMemoryResponse,
  Session as AdkSession,
} from '@google/adk';

import type { MemoryService } from './memoryService.ts';
import type { Session } from './sessions.ts';

/** ADK's memory service, named here so a surface never imports ADK for the type. */
export type AdkMemoryService = BaseMemoryService;

/** A memory service with either face: what a surface takes from its caller. */
export type EitherMemoryService = MemoryService | BaseMemoryService;

/** The engine's two methods. */
export function isMemoryService(value: unknown): value is MemoryService {
  const v = value as Partial<Record<keyof MemoryService, unknown>> | null;
  return typeof v === 'object' && v !== null && typeof v.ingest === 'function' && typeof v.search === 'function';
}

/** ADK's two methods. A duck check, so a service built against another copy of ADK still counts. */
export function isAdkMemoryService(value: unknown): value is BaseMemoryService {
  const v = value as Partial<Record<keyof BaseMemoryService, unknown>> | null;
  return (
    typeof v === 'object' && v !== null &&
    typeof v.addSessionToMemory === 'function' && typeof v.searchMemory === 'function'
  );
}

/** ADK's BaseMemoryService over an engine MemoryService. */
export class MemoryServiceForAdk implements BaseMemoryService {
  readonly service: MemoryService;
  readonly deleteUserMemory?: (userKey: string) => Promise<number>;
  readonly pruneExpired?: (namespace: string, days: number) => Promise<number | null>;
  readonly verifyEmbeddingDimensions?: () => Promise<void>;

  constructor(service: MemoryService) {
    this.service = service;
    // The optional extras, only when the service has them: the A2A server
    // checks for each by name.
    if (service.deleteUserMemory) this.deleteUserMemory = (userKey) => service.deleteUserMemory!(userKey);
    if (service.pruneExpired) this.pruneExpired = (namespace, days) => service.pruneExpired!(namespace, days);
    if (service.verifyEmbeddingDimensions) this.verifyEmbeddingDimensions = () => service.verifyEmbeddingDimensions!();
  }

  /** The extraction rules and model ingestTurnMemory passes, as the engine's service takes them. */
  async addSessionToMemory(session: AdkSession, extractionRules?: string, options?: { extractionModel?: string }): Promise<void> {
    await this.service.ingest(session as unknown as Session, {
      ...(extractionRules !== undefined ? { extractionRules } : {}),
      ...(options?.extractionModel !== undefined ? { extractionModel: options.extractionModel } : {}),
    });
  }

  async searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse> {
    return (await this.service.search({ appName: request.appName, userId: request.userId, query: request.query })) as unknown as SearchMemoryResponse;
  }
}

/** The service as the ADK runtime takes it: itself when it already has ADK's face. */
export function asAdkMemoryService(service: EitherMemoryService): BaseMemoryService {
  if (isAdkMemoryService(service)) return service;
  if (isMemoryService(service)) return new MemoryServiceForAdk(service);
  throw new TypeError('Not a memory service: it implements neither MemoryService nor ADK\'s BaseMemoryService.');
}
