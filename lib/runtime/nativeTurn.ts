/**
 * lib/runtime/nativeTurn.ts — one agent's run on the engine's runtime, and
 * what the runtime refuses before a turn starts (ADR 0045, ADR 0073,
 * ADR 0107).
 *
 * The flag itself is lib/runtime/runtimeFlag.ts.
 *
 * WHY this file exists:
 *   runSyndicateTurn (lib/runtime/syndicateTurn.ts) runs every agent of a
 *   turn on the engine's own agent loop (lib/runtime/native/agentLoop.ts),
 *   with the agents lib/compileNative.ts builds from the AgentSpec. The turn
 *   runner keeps its own logic — routing, guards, the relay fallback,
 *   approvals and questions read from the stored events — and calls
 *   runNativeAgent here for each agent, draining its events with
 *   drainAgentStream.
 *
 * WHAT IT REFUSES, before any model call, with a message naming the
 * feature (UnsupportedOnRuntimeError): a caller's `transformAgent` (it
 * transformed ADK agents, and ADK left in 1.0.0), and an `ask_user` tool on
 * a workflow's agent (the schema refuses it; a config that skipped
 * validation is refused here, ADR 0095). A workflow syndicate runs on the
 * engine's scheduler (lib/workflow/turn.ts, ADR 0095). An answer to an
 * approval resumes the call (lib/runtime/native/interrupts.ts), an answer
 * to a question resumes the agent that asked (lib/runtime/questions.ts, ADR
 * 0079), `context:` compacts (lib/runtime/native/compaction.ts), and
 * `mode: task` runs (lib/runtime/native/taskMode.ts).
 */

import { randomUUID } from 'node:crypto';

import type { SyndicateYamlConfig } from '../loadSyndicate.ts';
import type { ModelAdapter } from '../models/contract.ts';
import { createTurnEvent } from './events.ts';
import type { TurnContent, TurnEvent } from './events.ts';
import type { MemorySearchRequest, MemoryService } from './memoryService.ts';
import { runAgentLoop } from './native/agentLoop.ts';
import type { AgentLoopEnd } from './native/agentLoop.ts';
import type { NativeAgent } from './native/request.ts';
import type { SelfCorrection } from './native/selfCorrection.ts';
import type { SessionService } from './sessions.ts';
import type { CredentialStore } from '../tools/auth.ts';
import type { OAuthConsent } from '../tools/oauthConsent.ts';
import { ASK_USER } from './questions.ts';
import { unsupportedOnNative } from './runtimeFlag.ts';

// ── What native refuses before a turn starts ─────────────────────────────────

/**
 * Throws UnsupportedOnRuntimeError for a syndicate or a call the runtime
 * does not run.
 */
export function refuseOnNative(
  config: SyndicateYamlConfig,
  call: { isWorkflow: boolean; transformAgent?: unknown },
): void {
  const where = config.syndicate_name || config.orchestrator?.name || 'syndicate';
  if (call.transformAgent) throw unsupportedOnNative('transformAgent (it transformed ADK agents; the ADK runtime was removed in 1.0.0)', where);
  if (call.isWorkflow) {
    // A pause inside an agent node cannot be resumed by the native walk (lib/workflow/resume.ts).
    const asking = [config.orchestrator, ...(config.subagents ?? [])].find((agent) => (agent?.tools ?? []).includes(ASK_USER));
    if (asking) throw unsupportedOnNative(`an ${ASK_USER} tool on a workflow node (${asking.name}; use an ask_user node)`, where);
  }
}

// ── Memory ───────────────────────────────────────────────────────────────────

/**
 * The search the loop's memory tools call: the engine's MemoryService. The
 * caller has already pinned the namespace.
 */
export function nativeMemory(service: MemoryService | undefined): Pick<MemoryService, 'search'> | undefined {
  if (!service || typeof service.search !== 'function') return undefined;
  return { search: (request: MemorySearchRequest) => service.search(request) };
}

// ── One agent's run ──────────────────────────────────────────────────────────

export interface NativeRunParams {
  agent: NativeAgent;
  /** The leaf adapter for a model id (lib/compileNative.ts nativeAdapterFor). */
  adapterFor: (model: string) => ModelAdapter;
  /** The store. */
  sessions: SessionService;
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
  /** The run's tool credentials, pinned to its app (ADR 0072). */
  credentials?: Pick<CredentialStore, 'get'>;
  /** The consent step (ADR 0085). */
  consent?: Pick<OAuthConsent, 'has' | 'begin'>;
}

/**
 * Runs `agent` for one message: read the
 * session (it must exist), store the message as the user's event under a
 * new `e-` invocation id, then run the agent loop on it, yielding every
 * event the loop yields. A run whose signal aborted before the message was
 * stored stores nothing. Returns how the loop ended, or
 * undefined when it never started.
 */
export async function* runNativeAgent(params: NativeRunParams): AsyncGenerator<TurnEvent, AgentLoopEnd | undefined> {
  const sessions = params.sessions;
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
    ...(params.credentials ? { credentials: params.credentials } : {}),
    ...(params.consent ? { consent: params.consent } : {}),
  });
}
