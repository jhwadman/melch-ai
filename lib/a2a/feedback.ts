/**
 * lib/a2a/feedback.ts — end-user feedback on a served turn (ADR 0140):
 * `POST /feedback` and `POST /<agentId>/feedback`.
 *
 *   POST /feedback
 *   { "traceId": "4bf9…", "score": "down", "comment": "Wrong refund policy", "userId": "u-123" }
 *
 * The body names the turn by exactly one of `taskId` (the A2A task) or
 * `traceId` (the ledger's), a `score` of 'up' | 'down' or an integer 1–5,
 * and optionally a `comment` (≤ 4,000 characters) and the product's own
 * `userId`. It lands in the ledger as one `adk_labels` row:
 *
 *   ref = trace_id = the turn's trace id, labeler = 'end-user',
 *   fields = { score, userId }   (userId null when none was sent),
 *   note = the comment through the telemetry redactor (null when none)
 *
 * The route sits behind the same bearer check, authenticator, failed-auth
 * limiter and task rate limit as the A2A routes, with its own body limit
 * (32 KB). A caller rates only turns it could have run: the turn's
 * `user_id` must be the caller's scope (or one beneath a scope that owns
 * nested ones), unless the caller holds an operator credential; anything
 * else answers the same 404 as a turn that does not exist. One label per
 * (turn, userId) per minute, per process; without a userId the caller's
 * scope stands in. Answers never repeat what was sent.
 */

import { createHash } from 'node:crypto';

import express from 'express';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { z } from 'zod';

import { REDACTION_PATTERNS, telemetryRedactor } from '../observability/redact.ts';
import type { Redactor } from '../observability/redact.ts';
import type { A2AContext } from './executor.ts';

/** The labeler every end-user feedback row carries. */
export const END_USER_LABELER = 'end-user';
/** The route's own JSON body limit. */
export const FEEDBACK_BODY_LIMIT = '32kb';
/** The longest comment accepted, in characters. */
export const FEEDBACK_COMMENT_MAX = 4_000;
/** One label per (turn, user) in this window. */
export const FEEDBACK_WINDOW_MS = 60_000;

export type FeedbackScore = 'up' | 'down' | 1 | 2 | 3 | 4 | 5;

/** The adk_labels row a feedback request writes (the columns it names; the rest keep their defaults). */
export interface FeedbackRow {
  ref: string;
  trace_id: string;
  labeler: typeof END_USER_LABELER;
  fields: { score: FeedbackScore; userId: string | null };
  note: string | null;
}

/** The turn a feedback request names, as the ledger holds it. */
export interface FeedbackTurn {
  traceId: string;
  /** adk_turns.user_id: the scope key the turn ran under. */
  userId: string | null;
}

/** Where feedback is read from and written to: the telemetry ledger. */
export interface FeedbackStore {
  /** The turn by its A2A task id or its trace id; null when the ledger has no such turn. */
  turn(ref: { taskId: string } | { traceId: string }): Promise<FeedbackTurn | null>;
  /** Appends one label. */
  add(row: FeedbackRow): Promise<void>;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const USER_ID = /^[A-Za-z0-9._@:+/-]{1,128}$/;

const bodySchema = z.strictObject({
  taskId: z.string().regex(ID).optional(),
  traceId: z.string().regex(ID).optional(),
  score: z.union([z.enum(['up', 'down']), z.number().int().min(1).max(5)]),
  comment: z.string().max(FEEDBACK_COMMENT_MAX).optional(),
  userId: z.string().regex(USER_ID).optional(),
});

export interface ParsedFeedback {
  ref: { taskId: string } | { traceId: string };
  score: FeedbackScore;
  comment: string | null;
  userId: string | null;
}

/** Field-level messages that name the field and the rule, never the value sent. */
const MESSAGES: Record<string, string> = {
  taskId: 'taskId must be 1–128 characters of [A-Za-z0-9._:-].',
  traceId: 'traceId must be 1–128 characters of [A-Za-z0-9._:-].',
  score: "score must be 'up', 'down' or an integer from 1 to 5.",
  comment: `comment must be a string of at most ${FEEDBACK_COMMENT_MAX.toLocaleString('en-US')} characters.`,
  userId: 'userId must be 1–128 characters of [A-Za-z0-9._@:+/-].',
};

/** Validates a feedback body. The error names the rule broken, never the value. */
export function parseFeedback(body: unknown): { ok: true; value: ParsedFeedback } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send a JSON object body (Content-Type: application/json).' };
  const r = bodySchema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    if (issue.code === 'unrecognized_keys') return { ok: false, error: 'Unknown field; the body takes taskId or traceId, score, comment and userId.' };
    const field = String(issue.path[0] ?? '');
    return { ok: false, error: MESSAGES[field] ?? 'Invalid feedback body.' };
  }
  const { taskId, traceId, score, comment, userId } = r.data;
  if ((taskId === undefined) === (traceId === undefined)) return { ok: false, error: 'Name the turn with exactly one of taskId or traceId.' };
  if (userId && new RegExp(REDACTION_PATTERNS.secret.source).test(userId)) return { ok: false, error: 'userId looks like a credential; send the product’s own user id.' };
  return {
    ok: true,
    value: {
      ref: taskId !== undefined ? { taskId } : { traceId: traceId! },
      score: score as FeedbackScore,
      comment: comment && comment.trim() ? comment : null,
      userId: userId ?? null,
    },
  };
}

/** The row a parsed request writes for a turn, the comment through `redactor` (none: kept as sent). */
export function feedbackRow(traceId: string, f: Pick<ParsedFeedback, 'score' | 'comment' | 'userId'>, redactor: Redactor | undefined): FeedbackRow {
  return {
    ref: traceId,
    trace_id: traceId,
    labeler: END_USER_LABELER,
    fields: { score: f.score, userId: f.userId },
    note: f.comment === null ? null : redactor ? redactor(f.comment) : f.comment,
  };
}

/** May this caller rate a turn that ran under `turnUserId`? */
export function mayRate(ctx: Pick<A2AContext, 'scopeKey' | 'ownsNested' | 'operator'>, turnUserId: string | null): boolean {
  if (ctx.operator) return true;
  if (!turnUserId) return false;
  return turnUserId === ctx.scopeKey || (!!ctx.ownsNested && turnUserId.startsWith(`${ctx.scopeKey}/`));
}

/** One label per key per window, in this process. Keys are hashes; the map is swept as it grows. */
export function feedbackLimiter(windowMs = FEEDBACK_WINDOW_MS, now: () => number = Date.now) {
  const until = new Map<string, number>();
  const sweep = () => {
    const t = now();
    for (const [k, v] of until) if (v <= t) until.delete(k);
  };
  return {
    /** Reserves the key; the ms to wait when it is taken. */
    take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
      const t = now();
      const held = until.get(key);
      if (held !== undefined && held > t) return { ok: false, retryAfterMs: held - t };
      if (until.size >= 10_000) sweep();
      until.set(key, t + windowMs);
      return { ok: true };
    },
    /** Gives a reservation back (the write failed). */
    release(key: string) {
      until.delete(key);
    },
  };
}

/** The JSON parser for the feedback routes: 32 KB, and its errors answered as JSON without the body. */
export function feedbackBodyParser(): RequestHandler {
  const parse = express.json({ limit: FEEDBACK_BODY_LIMIT });
  return (req: Request, res: Response, next: NextFunction) => {
    parse(req, res, (err?: unknown) => {
      if (!err) return next();
      const e = err as { type?: string; status?: number };
      if (e.type === 'entity.too.large' || e.status === 413) {
        res.status(413).json({ error: `The feedback body is over ${FEEDBACK_BODY_LIMIT.toUpperCase()}.` });
        return;
      }
      res.status(400).json({ error: 'The body is not valid JSON.' });
    });
  };
}

export interface FeedbackHandlerOptions {
  store: FeedbackStore | undefined;
  /** The caller context the identity middleware set. */
  context: () => A2AContext | undefined;
  /** Validates `:agentId` on the per-agent route; false answers 404. */
  agentServed?: (agentId: string) => boolean;
  limiter?: ReturnType<typeof feedbackLimiter>;
  log?: (m: string) => void;
  warn?: (m: string) => void;
}

/** The route handler; mount it after authentication, with its body parsed by feedbackBodyParser(). */
export function feedbackHandler(opts: FeedbackHandlerOptions): RequestHandler {
  const limiter = opts.limiter ?? feedbackLimiter();
  return async (req: Request, res: Response) => {
    const agentId = typeof req.params?.agentId === 'string' ? req.params.agentId : undefined;
    if (agentId !== undefined && opts.agentServed && !opts.agentServed(agentId)) {
      res.status(404).json({ error: 'Unknown agent.' });
      return;
    }
    if (!opts.store) {
      res.status(501).json({ error: 'Feedback needs the telemetry ledger; this server has none configured.' });
      return;
    }
    const ctx = opts.context();
    if (!ctx) {
      res.status(401).json({ error: 'No authentication context.' });
      return;
    }
    const parsed = parseFeedback(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const f = parsed.value;
    let turn: FeedbackTurn | null;
    try {
      turn = await opts.store.turn(f.ref);
    } catch (err: unknown) {
      opts.warn?.(`Feedback: the ledger could not be read (${err instanceof Error ? err.message : String(err)}).`);
      res.status(503).json({ error: 'The ledger is unavailable; retry shortly.' });
      return;
    }
    // Not found and not yours answer alike: a caller cannot probe for other people's turns.
    if (!turn || !mayRate(ctx, turn.userId)) {
      res.status(404).json({ error: 'No turn with that id (a turn reaches the ledger a few seconds after it ends).' });
      return;
    }
    const who = f.userId !== null ? `user:${f.userId}` : `scope:${ctx.scopeKey}`;
    const key = createHash('sha256').update(`${turn.traceId}\u0000${who}`).digest('hex');
    const slot = limiter.take(key);
    if (!slot.ok) {
      res.setHeader('Retry-After', String(Math.ceil(slot.retryAfterMs / 1000)));
      res.status(429).json({ error: 'Feedback on this turn from this user was just recorded; one per minute.' });
      return;
    }
    try {
      await opts.store.add(feedbackRow(turn.traceId, f, telemetryRedactor()));
    } catch (err: unknown) {
      limiter.release(key);
      opts.warn?.(`Feedback: the label was not written (${err instanceof Error ? err.message : String(err)}).`);
      res.status(503).json({ error: 'The feedback could not be stored; retry shortly.' });
      return;
    }
    opts.log?.(`Feedback on trace ${turn.traceId.slice(0, 8)}: ${typeof f.score === 'number' ? `${f.score}/5` : f.score}${f.comment !== null ? ', with a comment' : ''}`);
    res.status(201).json({ ok: true, traceId: turn.traceId });
  };
}

/** Matches the feedback routes' paths, so the server-wide JSON parser leaves their bodies to feedbackBodyParser. */
export const isFeedbackPath = (path: string): boolean => path === '/feedback' || /^\/[^/]+\/feedback$/.test(path);

/** A FeedbackStore over a Postgres pool holding the ledger (db/telemetry.sql). */
export function postgresFeedbackStore(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }): FeedbackStore {
  return {
    async turn(ref) {
      const byTask = 'taskId' in ref;
      const { rows } = await pool.query(
        // A dispatch task has a classifier turn beside its answer: the answer is the one rated.
        `SELECT trace_id, user_id FROM adk_turns WHERE ${byTask ? "task_id = $1 AND stage IS DISTINCT FROM 'classify'" : 'trace_id = $1'} ORDER BY ts DESC LIMIT 1`,
        [byTask ? ref.taskId : ref.traceId],
      );
      const r = rows[0];
      return r ? { traceId: String(r.trace_id), userId: r.user_id == null ? null : String(r.user_id) } : null;
    },
    async add(row) {
      await pool.query(
        'INSERT INTO adk_labels (ref, trace_id, labeler, fields, note) VALUES ($1, $2, $3, $4::jsonb, $5)',
        [row.ref, row.trace_id, row.labeler, JSON.stringify(row.fields), row.note],
      );
    },
  };
}
