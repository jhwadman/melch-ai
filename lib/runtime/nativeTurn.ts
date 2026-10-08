/**
 * lib/runtime/nativeTurn.ts — which runtime runs a turn, and one agent's
 * run on the native runtime (ADR 0045, ADR 0073).
 *
 * The flag itself is lib/runtime/runtimeFlag.ts.
 *
 * WHY this file exists:
 *   runSyndicateTurn (lib/runtime/syndicateTurn.ts) runs every turn on ADK
 *   by default. MELCHIZEDEK_RUNTIME=native, or the turn's `runtime: 'native'`
 *   option, runs it on the engine's own agent loop instead
 *   (lib/runtime/native/agentLoop.ts), with the agents lib/compileNative.ts
 *   builds from the same AgentSpec. The turn runner keeps its own logic —
 *   routing, guards, the relay fallback, approvals and questions read from
 *   the stored events — and swaps only what runs one agent: ADK's Runner,
 *   or runNativeAgent here. Both store the same events (ADR 0071), and the
 *   turn runner drains both with drainAgentStream.
 *
 * WHAT NATIVE REFUSES, before any model call, with a message naming the
 * feature and the runtime (UnsupportedOnRuntimeError): a workflow syndicate
 * (where `mode: task` nodes live), a caller's ADK agent transform, and a
 * message that answers a question (WS2-7b). An answer to an approval
 * resumes on native (lib/runtime/native/interrupts.ts), `context:` compacts
 * on native (lib/runtime/native/compaction.ts), and `mode: task` runs on
 * native (lib/runtime/native/taskMode.ts).
 * Later tickets lift each.
 */

import { randomUUID } from 'node:crypto';

import type { BaseMemoryService, BaseSessionService } from '@google/adk';

import type { SyndicateYamlConfig } from '../loadSyndicate.ts';
import type { ModelAdapter } from '../models/contract.ts';
import { asSessionService } from './adkSessionBridge.ts';
import { createTurnEvent } from './events.ts';
import type { TurnContent, TurnEvent } from './events.ts';
import type { MemorySearchRequest, MemorySearchResult, MemoryService } from './memoryService.ts';
import { runAgentLoop } from './native/agentLoop.ts';
import type { AgentLoopEnd } from './native/agentLoop.ts';
import type { NativeAgent } from './native/request.ts';
import type { SelfCorrection } from './native/selfCorrection.ts';
import type { SessionService } from './sessions.ts';
import { unsupportedOnNative } from './runtimeFlag.ts';

// ── What native refuses before a turn starts ─────────────────────────────────

/**
 * Throws UnsupportedOnRuntimeError for a syndicate or a call the native
 * runtime does not run yet.
 */
export function refuseOnNative(
  config: SyndicateYamlConfig,
  call: { isWorkflow: boolean; transformAgent?: unknown },
): void {
  const where = config.syndicate_name || config.orchestrator?.name || 'syndicate';
  if (call.isWorkflow) throw unsupportedOnNative('a workflow syndicate (workflow:)', where);
  if (call.transformAgent) throw unsupportedOnNative('transformAgent (it transforms ADK agents)', where);
}

// ── Memory ───────────────────────────────────────────────────────────────────

/**
 * The search the native loop's memory tools call: the engine's MemoryService
 * as it is, or an ADK-only service's searchMemory, which takes and returns
 * the same JSON. The caller has already pinned the namespace.
 */
export function nativeMemory(service: BaseMemoryService | MemoryService | undefined): Pick<MemoryService, 'search'> | undefined {
  if (!service) return undefined;
  const engine = service as Partial<MemoryService>;
  if (typeof engine.search === 'function') return { search: (request: MemorySearchRequest) => engine.search!(request) };
  const adk = service as Partial<BaseMemoryService>;
  if (typeof adk.searchMemory !== 'function') return undefined;
  return {
    search: async (request: MemorySearchRequest) => (await adk.searchMemory!(request)) as unknown as MemorySearchResult,
  };
}

// ── One agent's run ──────────────────────────────────────────────────────────

export interface NativeRunParams {
  agent: NativeAgent;
  /** The leaf adapter for a model id (lib/compileNative.ts nativeAdapterFor). */
  adapterFor: (model: string) => ModelAdapter;
  /** The store, either face (lib/runtime/adkSessionBridge.ts). */
  sessions: SessionService | BaseSessionService;
  appName: string;
  userId: string;
  sessionId: string;
  /** The message's parts. */
  userParts: unknown[];
  /** The turn's signal. */
  signal?: AbortSignal;
  /** Stream text as partial events. */
  stream?: boolean;
  memory?: Pick<MemoryService, 'search'>;
  log?: (message: string) => void;
  /** The turn's self-correction (ADR 0075), built once per turn from `retries:`. Default: retries at their defaults. */
  selfCorrection?: SelfCorrection;
}

/**
 * Runs `agent` for one message, as ADK's Runner runs an agent: read the
 * session (it must exist), store the message as the user's event under a
 * new `e-` invocation id, then run the agent loop on it, yielding every
 * event the loop yields. A run whose signal aborted before the message was
 * stored stores nothing, as on ADK. Returns how the loop ended, or
 * undefined when it never started.
 */
export async function* runNativeAgent(params: NativeRunParams): AsyncGenerator<TurnEvent, AgentLoopEnd | undefined> {
  const sessions = asSessionService(params.sessions);
  const { appName, userId, sessionId } = params;
  const session = await sessions.get({ appName, userId, sessionId });
  if (!session) throw new Error(`Session not found: ${sessionId} (appName=${appName}, userId=${userId})`);
  if (params.signal?.aborted) return undefined;
  if (params.userParts.length === 0) throw new Error('No parts in the newMessage.');

  const invocationId = `e-${randomUUID()}`;
  const userContent = { role: 'user', parts: params.userParts } as TurnContent;
  await sessions.append(session, createTurnEvent({ invocationId, author: 'user', content: userContent }));
  if (params.signal?.aborted) return undefined;

  return yield* runAgentLoop(params.agent, {
    session,
    sessions,
    invocationId,
    userContent,
    stream: params.stream ?? false,
    adapterFor: params.adapterFor,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.memory ? { memory: params.memory } : {}),
    ...(params.log ? { log: params.log } : {}),
    ...(params.selfCorrection ? { selfCorrection: params.selfCorrection } : {}),
  });
}
