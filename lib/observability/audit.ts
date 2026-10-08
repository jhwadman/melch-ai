/**
 * lib/observability/audit.ts — the audit trail: who did what, when, from
 * where (ADR 0042).
 *
 * The ledger (adk_turns) records what a turn said. An auditor asks a
 * different question: which caller, authenticated how, from which address,
 * did what, and was it allowed. Those events are written to
 * melchizedek_audit (db/migrations/0012), which a trigger keeps
 * append-only. An event never carries conversation content or a scope
 * key: a scope is a SHA-256 prefix, as in the task log.
 *
 * The sink is fire-and-forget: an audit write never delays or fails a
 * request. A failed write is logged once per outage, and the event is
 * written to stderr as one JSON line instead, so it is not lost silently.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export type AuditEventName =
  | 'auth.failure'
  | 'task.end'
  | 'memory.erase'
  /** A tool credential stored, refreshed, revoked or erased (ADR 0072): provider and app, never a token. */
  | 'credential.put'
  | 'credential.refresh'
  | 'credential.revoke'
  | 'credential.erase'
  /** An OAuth consent callback completed or refused (ADR 0085): provider, app and reason, never a code, state or token. */
  | 'consent.callback';

export interface AuditEvent {
  event: AuditEventName;
  /** denied | ok | the task's final status. */
  outcome: string;
  /** The authenticated caller's name ('shared-secret', a caller token's name, 'jwt'). */
  caller?: string;
  /** SHA-256 prefix of the scope key, never the key. */
  scopeHash?: string;
  sourceIp?: string;
  agentId?: string;
  taskId?: string;
  /** Small, content-free facts: a reason code, counts, a path. */
  detail?: Record<string, unknown>;
}

export type AuditSink = (event: AuditEvent) => void;

/** The scope's SHA-256 prefix, as the task log writes it. */
export function scopeHashOf(scopeKey: string | undefined): string | undefined {
  return scopeKey ? createHash('sha256').update(scopeKey).digest('hex').slice(0, 12) : undefined;
}

/** Appends events to melchizedek_audit through the storage pool. */
export function postgresAuditSink(pool: Pick<Pool, 'query'>, warn: (m: string) => void = (m) => console.warn(m)): AuditSink {
  let failing = false;
  return (e) => {
    pool
      .query(
        'INSERT INTO melchizedek_audit (event, outcome, caller, scope_hash, source_ip, agent_id, task_id, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [e.event, e.outcome, e.caller ?? null, e.scopeHash ?? null, e.sourceIp ?? null, e.agentId ?? null, e.taskId ?? null, JSON.stringify(e.detail ?? {})],
      )
      .then(() => {
        if (failing) warn('[audit] writes to melchizedek_audit succeed again.');
        failing = false;
      })
      .catch((err: unknown) => {
        if (!failing) warn(`[audit] could not write to melchizedek_audit (${err instanceof Error ? err.message : String(err)}); events go to stderr until it recovers.`);
        failing = true;
        console.error(JSON.stringify({ audit: { ...e, at: new Date().toISOString() } }));
      });
  };
}
