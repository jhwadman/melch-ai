/**
 * lib/runtime/native/checkpoint.ts — durable long runs: the run's sessions
 * snapshotted at every step boundary, and a run restored from the last
 * snapshot taking the next step (ADR 0113, ADR 0015).
 *
 * WHY this file exists:
 *   A background job (ADR 0015) runs as one turn on an in-process session
 *   store. A worker that stopped mid-job lost everything the job had done,
 *   and the next claim started again from the first model call. The turn
 *   runner's signature is pinned by every surface and the boundary suite
 *   (ADR 0024), so durability lives at the one seam the runner already
 *   takes: the SessionService. checkpointingSessions wraps the in-process
 *   store a run writes, hands a snapshot of every session to a sink at each
 *   step boundary, and restores a snapshot into a fresh store so that the
 *   runner, unchanged, continues where the snapshot stood. runDurableTurn
 *   is runSyndicateTurn with that store and a sink.
 *
 * A STEP BOUNDARY is an append that carries function responses after which
 * every function call any session of the run holds has its response (calls
 * listed in their event's longRunningToolIds, which wait on a person, aside).
 * So a parent waiting on a delegated subagent is never at a boundary, the
 * subagent's own steps are not either, and a final answer never is: a
 * resumed run redoes the step that was in flight, and the last one.
 *
 * WHAT IT GUARANTEES:
 *   - A resumed run's stored events equal an uninterrupted run's, ids and
 *     times of the steps run after the resume aside: restored events keep
 *     their ids, times and invocation ids, and their state deltas are
 *     applied again in order (InProcessSessionService.append, applyEvent).
 *   - The opening message is stored once. A session whose first event is
 *     the run's own message (the run's session, a workflow route's child)
 *     is held back on restore: it does not exist until the runner creates
 *     it, so `resumedSession` reads as on a fresh run, and the runner's
 *     append of the message is answered with the stored events, the
 *     opening one returned in its place, onto the caller's own session
 *     object. Every other session (a delegated subagent's) is restored at
 *     once, before the runner starts.
 *   - A checkpoint is used only by the run that wrote it, for the message
 *     it was written for: its runId and the sha256 of the message's parts
 *     must match, and its events must parse (parseTurnEvents). Otherwise
 *     the run starts fresh.
 *   - The sink's save resolving false means the run no longer holds its
 *     claim (the job was cancelled or leased elsewhere): runDurableTurn
 *     aborts the run and reports lostClaim. A save that throws is reported
 *     to onSaveError and the run goes on; a later attempt resumes from the
 *     older checkpoint.
 *
 * LIMITS:
 *   - A dispatch syndicate's route classifier runs in a throwaway store, so
 *     its model call is not checkpointed and runs again on resume.
 *   - A dispatch route that is an agent answers through the transcript
 *     projection (ProjectedSessionService, lib/session/transcript.ts), which
 *     copies the session when the route opens it. The held opening session
 *     is empty at that open, so the copy is too; the route's append of the
 *     message is answered with the stored events, and the projection takes
 *     every event the real session gained, unprojected (the current turn),
 *     so the route resumes like a single agent. A workflow route writes its
 *     own child session and resumes. Checkpoints saved before this, which
 *     1.1.0 set aside, restore the same way.
 *   - A task backend stores a checkpoint only up to its cap
 *     (TaskBackendOptions.checkpointMaxBytes, lib/tools/taskTools.ts,
 *     default 5 MiB of JSON); a save above it keeps the previous checkpoint
 *     and still answers whether the claim holds, so a huge run resumes from
 *     an older boundary.
 *   - Each resumed attempt has its own step budget (max_steps, the loop's
 *     call ceiling); attempts are bounded by the queue's MAX_ATTEMPTS.
 *   - `temp:` state lasts one invocation and is never stored, so it does not
 *     survive a resume.
 *   - A workflow walk resumes through its own rules (ADR 0094); its
 *     checkpoint is the sessions it walks.
 *   - A checkpoint holds the run's sessions, so it carries the user's text,
 *     model output and tool results: it lives only where the run's record
 *     lives, under the same owner, and is deleted with it. This module never
 *     clears one; the caller does when the run finishes.
 */

import { createHash, randomUUID } from 'node:crypto';

import { getFunctionCalls, getFunctionResponses, parseTurnEvents } from '../events.ts';
import type { TurnEvent } from '../events.ts';
import { InProcessSessionService } from '../sessions.ts';
import type {
  CreateSessionRequest,
  GetSessionOptions,
  ListSessionsRequest,
  ListSessionsResult,
  Session,
  SessionKey,
  SessionService,
} from '../sessions.ts';
import { runSyndicateTurn } from '../syndicateTurn.ts';
import type { MessagePart, SyndicateTurnOptions, SyndicateTurnResult } from '../syndicateTurn.ts';

// ── Shapes ───────────────────────────────────────────────────────────────────

export const CHECKPOINT_VERSION = 1;

/** One session of a run, as it stood at a step boundary. */
export interface CheckpointSession {
  appName: string;
  userId: string;
  id: string;
  /** The state given to create(), before any event. */
  createdState: Record<string, unknown>;
  events: TurnEvent[];
  /** The first event is the run's own opening user message: restore holds the session back until the runner stores that message. */
  opening: boolean;
}

/** A run's sessions at its latest step boundary. */
export interface RunCheckpoint {
  version: 1;
  runId: string;
  /** The run's own session id: a resumed run uses it again. */
  sessionId: string;
  /** sha256 hex of JSON.stringify(parts) of the run's message (strings as `{ text }`). */
  openingHash: string;
  /** Step boundaries recorded so far, across every attempt. */
  steps: number;
  /** ISO time of the save. */
  savedAt: string;
  sessions: CheckpointSession[];
}

/** Where a run's checkpoints go. save resolves false when the run no longer holds its claim (cancelled, or re-leased): the run must stop. */
export interface CheckpointSink {
  load(): Promise<RunCheckpoint | null>;
  save(checkpoint: RunCheckpoint): Promise<boolean>;
}

export interface CheckpointingOptions {
  runId: string;
  /** The run's own session id (the one runSyndicateTurn is given). */
  sessionId: string;
  /** The run's message. */
  parts: MessagePart[];
  /** The checkpoint to restore; ignored unless its runId and openingHash match and it parses. */
  from?: RunCheckpoint | null;
  save: (checkpoint: RunCheckpoint) => Promise<boolean>;
  /** Called once, when a save resolves false. */
  onLost?: () => void;
  onSaveError?: (err: unknown) => void;
  /** The store wrapped. Default a fresh InProcessSessionService. */
  inner?: InProcessSessionService;
}

export type CheckpointingSessionService = SessionService & {
  /** The checkpoint given was restored. */
  readonly restored: boolean;
  /** Step boundaries recorded, the restored checkpoint's included. */
  readonly steps: number;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The parts as runSyndicateTurn stores them: a bare string becomes `{ text }`. */
function normalizedParts(parts: readonly MessagePart[]): unknown[] {
  return parts.map((p) => (typeof p === 'string' ? { text: p } : p));
}

/** sha256 hex of the message's parts, as a checkpoint names its run's message. */
export function openingHashOf(parts: readonly MessagePart[]): string {
  return createHash('sha256').update(JSON.stringify(normalizedParts(parts))).digest('hex');
}

const keyOf = (appName: string, userId: string, id: string): string => JSON.stringify([appName, userId, id]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The checkpoint, checked, when it belongs to this run and this message;
 * null otherwise. A stored checkpoint is data read back from a table or a
 * file, so every field the restore reads is checked before it is trusted.
 */
export function usableCheckpoint(cp: unknown, runId: string, parts: readonly MessagePart[]): RunCheckpoint | null {
  if (!isRecord(cp) || cp.version !== CHECKPOINT_VERSION) return null;
  if (cp.runId !== runId || cp.openingHash !== openingHashOf(parts)) return null;
  if (typeof cp.sessionId !== 'string' || !cp.sessionId) return null;
  if (typeof cp.steps !== 'number' || !Number.isInteger(cp.steps) || cp.steps < 0) return null;
  if (!Array.isArray(cp.sessions)) return null;
  try {
    for (const [i, s] of cp.sessions.entries()) {
      if (!isRecord(s)) return null;
      if (typeof s.appName !== 'string' || typeof s.userId !== 'string' || typeof s.id !== 'string') return null;
      if (!isRecord(s.createdState) || typeof s.opening !== 'boolean') return null;
      parseTurnEvents(s.events, `sessions[${i}].events`);
      if (s.opening && (s.events as TurnEvent[]).length === 0) return null;
    }
  } catch {
    return null;
  }
  return cp as unknown as RunCheckpoint;
}

/** Content compared as stored JSON. */
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── The store ────────────────────────────────────────────────────────────────

interface Tracked {
  appName: string;
  userId: string;
  id: string;
  createdState: Record<string, unknown>;
  /** From the restored checkpoint; computed from the first event otherwise. */
  opening?: boolean;
  /** The order of the session's first event among every event the run appended. */
  firstSeq?: number;
  /** A held opening session: its stored events, restored on the runner's first append. */
  held?: TurnEvent[];
}

class CheckpointingStore implements SessionService {
  private readonly inner: InProcessSessionService;
  private readonly opts: CheckpointingOptions;
  private readonly openingParts: string;
  private readonly tracked = new Map<string, Tracked>();
  /** Call ids with no response yet, across every session. */
  private readonly openCalls = new Set<string>();
  private seq = 0;
  /** The order of the first event an agent wrote; -1 when a restored run already had one. */
  private firstAgentSeq: number | undefined;
  private savesLost = false;
  private saving: Promise<void> = Promise.resolve();
  private stepCount = 0;
  /** The eager restore; every method waits on it first. */
  private ready: Promise<void> = Promise.resolve();
  private readonly runSessionId: string;
  readonly restored: boolean;

  constructor(opts: CheckpointingOptions) {
    this.opts = opts;
    this.inner = opts.inner ?? new InProcessSessionService();
    this.openingParts = JSON.stringify(normalizedParts(opts.parts));
    this.runSessionId = opts.sessionId;
    const from = opts.from ? usableCheckpoint(opts.from, opts.runId, opts.parts) : null;
    this.restored = !!from && from.sessionId === opts.sessionId;
    if (this.restored && from) this.load(from);
  }

  get steps(): number {
    return this.stepCount;
  }

  /** Records the checkpoint: subagent sessions restored now, opening sessions held for the runner. */
  private load(from: RunCheckpoint): void {
    this.stepCount = from.steps;
    const copy = structuredClone(from.sessions);
    if (copy.some((s) => s.events.some((e) => e.author !== 'user'))) this.firstAgentSeq = -1;
    const eager: CheckpointSession[] = [];
    for (const s of copy) {
      const t: Tracked = { appName: s.appName, userId: s.userId, id: s.id, createdState: s.createdState, opening: s.opening };
      if (s.opening) t.held = s.events;
      else eager.push(s);
      this.tracked.set(keyOf(s.appName, s.userId, s.id), t);
      for (const e of s.events) this.track(e);
    }
    this.ready = (async () => {
      for (const s of eager) {
        const session = await this.inner.create({ appName: s.appName, userId: s.userId, sessionId: s.id, state: s.createdState });
        for (const e of s.events) await this.inner.append(session, e);
      }
    })();
  }

  /** Keeps the set of unanswered calls up to date with one stored event. */
  private track(event: TurnEvent): void {
    const waiting = new Set(event.longRunningToolIds ?? []);
    for (const call of getFunctionCalls(event)) if (call.id && !waiting.has(call.id)) this.openCalls.add(call.id);
    for (const response of getFunctionResponses(event)) if (response.id) this.openCalls.delete(response.id);
  }

  async create(request: CreateSessionRequest): Promise<Session> {
    await this.ready;
    const session = await this.inner.create(request);
    const key = keyOf(session.appName, session.userId, session.id);
    const known = this.tracked.get(key);
    if (!known) {
      this.tracked.set(key, { appName: session.appName, userId: session.userId, id: session.id, createdState: structuredClone(session.state) });
    } else if (known.held && session.events.length === 0) {
      known.createdState = structuredClone(session.state);
    }
    return session;
  }

  async get(key: SessionKey, options?: GetSessionOptions): Promise<Session | undefined> {
    await this.ready;
    return this.inner.get(key, options);
  }

  async list(request: ListSessionsRequest): Promise<ListSessionsResult> {
    await this.ready;
    return this.inner.list(request);
  }

  async delete(key: SessionKey): Promise<void> {
    await this.ready;
    this.tracked.delete(keyOf(key.appName, key.userId, key.sessionId));
    return this.inner.delete(key);
  }

  async append(session: Session, event: TurnEvent): Promise<TurnEvent> {
    await this.ready;
    if (event.partial) return this.inner.append(session, event);
    const key = keyOf(session.appName, session.userId, session.id);
    let t = this.tracked.get(key);
    if (!t) {
      // A session the store holds but this run did not create (not expected): tracked from here.
      t = { appName: session.appName, userId: session.userId, id: session.id, createdState: structuredClone(session.state) };
      this.tracked.set(key, t);
    }

    if (t.held) {
      const held = t.held;
      delete t.held;
      const opening = held[0];
      if (opening && event.author === 'user' && sameJson(event.content, opening.content)) {
        // The runner stores the message again: the stored events answer it, onto the caller's session.
        let first: TurnEvent | undefined;
        for (const e of held) {
          const stored = await this.inner.append(session, e);
          first ??= stored;
        }
        return first as TurnEvent;
      }
      // Some other first write: the hold is dropped and the session starts as the runner writes it.
      t.opening = undefined;
    }

    const stored = await this.inner.append(session, event);
    const order = this.seq++;
    t.firstSeq ??= order;
    if (stored.author !== 'user' && this.firstAgentSeq === undefined) this.firstAgentSeq = order;
    this.track(stored);
    if (getFunctionResponses(stored).length > 0 && this.openCalls.size === 0) await this.boundary();
    return stored;
  }

  /** A session is the run's opening one when its first event is the run's message, stored before any agent wrote. */
  private openingOf(t: Tracked, events: TurnEvent[]): boolean {
    if (t.opening !== undefined) return t.opening;
    const first = events[0];
    if (!first || first.author !== 'user') return false;
    if (JSON.stringify(first.content?.parts ?? null) !== this.openingParts) return false;
    if (this.firstAgentSeq === -1) return false;
    return this.firstAgentSeq === undefined || (t.firstSeq !== undefined && t.firstSeq < this.firstAgentSeq);
  }

  private async snapshot(): Promise<RunCheckpoint> {
    const sessions: CheckpointSession[] = [];
    for (const t of this.tracked.values()) {
      const events = t.held ?? (await this.inner.get({ appName: t.appName, userId: t.userId, sessionId: t.id }))?.events;
      if (!events) continue;
      sessions.push(
        structuredClone({ appName: t.appName, userId: t.userId, id: t.id, createdState: t.createdState, events, opening: this.openingOf(t, events) }),
      );
    }
    return {
      version: CHECKPOINT_VERSION,
      runId: this.opts.runId,
      sessionId: this.runSessionId,
      openingHash: openingHashOf(this.opts.parts),
      steps: this.stepCount,
      savedAt: new Date().toISOString(),
      sessions,
    };
  }

  /** One step boundary: counted, snapshotted, saved; saves run one after another. */
  private async boundary(): Promise<void> {
    if (this.savesLost) return;
    this.stepCount += 1;
    const checkpoint = await this.snapshot();
    const run = this.saving.then(async () => {
      if (this.savesLost) return;
      try {
        const kept = await this.opts.save(checkpoint);
        if (kept === false) {
          this.savesLost = true;
          this.opts.onLost?.();
        }
      } catch (err) {
        this.opts.onSaveError?.(err);
      }
    });
    this.saving = run;
    await run;
  }
}

/**
 * A session store that checkpoints a run: the in-process store `inner`,
 * restored from `from` when it is this run's checkpoint for this message,
 * saving a snapshot of every session at each step boundary (see the header).
 */
export function checkpointingSessions(opts: CheckpointingOptions): CheckpointingSessionService {
  return new CheckpointingStore(opts);
}

// ── The durable turn ─────────────────────────────────────────────────────────

export type DurableTurnOptions = Omit<SyndicateTurnOptions, 'sessionService' | 'sessionId'> & {
  /** Names the run: a checkpoint is restored only by the run that wrote it. */
  runId: string;
  checkpoints: CheckpointSink;
  /** Called once when a save resolves false; the run is then aborted. */
  onLost?: () => void;
  onSaveError?: (err: unknown) => void;
  /** The in-process store the run writes. Default a fresh one; a test passes its own to read the sessions afterwards. */
  sessions?: InProcessSessionService;
};

export type DurableTurnResult = SyndicateTurnResult & {
  /** The step boundaries the restored checkpoint had recorded; 0 on a fresh run. */
  resumedFromStep: number;
  /** A save resolved false: the run no longer held its claim and was aborted. */
  lostClaim: boolean;
  /** The run's own session id: the checkpoint's on a resume, a new UUID otherwise. */
  sessionId: string;
};

/**
 * runSyndicateTurn, durable: the run's sessions live in a fresh in-process
 * store, restored from the sink's checkpoint when it is this run's for this
 * message, and checkpointed at every step boundary. A save that resolves
 * false aborts the run (`lostClaim`). The caller clears the checkpoint when
 * the run finishes; this never does.
 */
export async function runDurableTurn(opts: DurableTurnOptions): Promise<DurableTurnResult> {
  const { runId, checkpoints, onLost, onSaveError, sessions: inner, signal, ...turn } = opts;
  const from = usableCheckpoint(await checkpoints.load(), runId, turn.parts);
  const sessionId = from ? from.sessionId : randomUUID();

  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });

  let lostClaim = false;
  const sessionService = checkpointingSessions({
    runId,
    sessionId,
    parts: turn.parts,
    from,
    save: (cp) => checkpoints.save(cp),
    onLost: () => {
      lostClaim = true;
      onLost?.();
      controller.abort(new Error('the run no longer holds its claim'));
    },
    ...(onSaveError ? { onSaveError } : {}),
    ...(inner ? { inner } : {}),
  });
  try {
    const result = await runSyndicateTurn({ ...turn, sessionId, sessionService, signal: controller.signal });
    return { ...result, resumedFromStep: sessionService.restored && from ? from.steps : 0, lostClaim, sessionId };
  } finally {
    signal?.removeEventListener('abort', forward);
  }
}
