/**
 * lib/runtime/approvals.ts — reading and answering approval requests in a
 * session (ADR 0028).
 *
 * A tool listed in an agent's `require_approval` does not run when called:
 * ADK records an `adk_request_confirmation` call that pins the original call
 * and its arguments, and the turn stops there. Answering that call — a user
 * message carrying a function response with `{ confirmed }` — runs or
 * refuses the pinned call. These helpers find the open request in a
 * session's events and build the answer; ADK checks that the answer binds to
 * the pinned call.
 */
import type { Event } from '@google/adk';

/** ADK's name for the confirmation request (REQUEST_CONFIRMATION_FUNCTION_CALL_NAME). */
export const APPROVAL_REQUEST = 'adk_request_confirmation';

/** A gated call waiting for a person. */
export interface PendingApproval {
  /** The request's id: what an answer names. */
  id: string;
  /** The agent that made the call (the orchestrator, or a dispatch route). */
  agent: string;
  /** The gated tool and the arguments the model chose. */
  tool: string;
  args: Record<string, unknown>;
  /** The original call's id. */
  callId?: string;
}

const partsOf = (e: Event) => (e.content?.parts ?? []) as Array<Record<string, any>>;

function hasUserText(e: Event): boolean {
  return e.author === 'user' && partsOf(e).some((p) => typeof p.text === 'string' && p.text.trim() && !p.thought);
}

/**
 * The approval request still waiting for an answer, or undefined. A request
 * the user moved on from (a new text message after it) is not pending: its
 * call never runs.
 */
export function pendingApproval(events: readonly Event[]): PendingApproval | undefined {
  const answered = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (hasUserText(e)) return undefined;
    for (const p of partsOf(e)) {
      if (p.functionResponse?.name === APPROVAL_REQUEST && p.functionResponse.id) answered.add(p.functionResponse.id);
    }
    for (const p of partsOf(e)) {
      const call = p.functionCall;
      if (call?.name !== APPROVAL_REQUEST || !call.id || answered.has(call.id)) continue;
      const original = call.args?.originalFunctionCall ?? {};
      return {
        id: call.id,
        agent: e.author ?? '',
        tool: String(original.name ?? ''),
        args: (original.args ?? {}) as Record<string, unknown>,
        ...(original.id ? { callId: String(original.id) } : {}),
      };
    }
  }
  return undefined;
}

/** Index of the user message that started the turn holding request `id` (its events are replayed raw on resume). */
export function interruptedTurnStart(events: readonly Event[], id: string): number {
  let requestAt = -1;
  for (let i = events.length - 1; i >= 0 && requestAt === -1; i--) {
    if (partsOf(events[i]!).some((p) => p.functionCall?.name === APPROVAL_REQUEST && p.functionCall.id === id)) requestAt = i;
  }
  for (let i = requestAt; i >= 0; i--) if (hasUserText(events[i]!)) return i;
  return Math.max(0, requestAt);
}

/** The message part that answers request `id`. */
export function approvalResponsePart(id: string, approved: boolean): Record<string, unknown> {
  return { functionResponse: { id, name: APPROVAL_REQUEST, response: { confirmed: approved } } };
}

/** The answer carried by a message's parts, if any. */
export function approvalDecisionIn(parts: readonly unknown[]): { id: string; approved: boolean } | undefined {
  for (const p of parts as Array<Record<string, any>>) {
    const r = p?.functionResponse;
    if (r?.name === APPROVAL_REQUEST && typeof r.id === 'string') return { id: r.id, approved: r.response?.confirmed === true };
  }
  return undefined;
}

/** One line a person can read: what they are approving. */
export function describeApproval(a: PendingApproval): string {
  const args = JSON.stringify(a.args);
  return `${a.agent} wants to run ${a.tool}(${args.length > 600 ? `${args.slice(0, 600)}…` : args})`;
}
