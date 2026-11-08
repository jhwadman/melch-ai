/**
 * lib/chatgpt/store.ts — writing the Sign in with ChatGPT credential file and
 * deciding which writes may land (ADR 0126).
 *
 * The file is the person's own: mode 600 in a mode-700 directory, outside any
 * git work tree, replaced atomically (a new mode-600 file renamed over the
 * old one). OpenAI's refresh tokens rotate, so two processes must not refresh
 * the same session at once (developers.openai.com/siwc/token-sharing-open-source/
 * profiles-and-sessions): a lease file beside the credential serializes them.
 * A separate short lock guards each read-compare-write of the file.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { credentialEpoch, insideGitWorkTree, readStoredSignIn } from './state.ts';
import type { StoredSignIn } from './state.ts';

function refuseInsideGitWorkTree(file: string): void {
  const repo = insideGitWorkTree(file);
  if (repo) {
    throw new Error(`refusing to store a ChatGPT sign-in inside the git work tree ${repo}; set MELCHIZEDEK_CHATGPT_SIGNIN_FILE to a path outside it.`);
  }
}

/** Write the credential file: mode 600, atomically, never inside a git work tree. */
export function writeStoredSignIn(file: string, value: StoredSignIn): void {
  refuseInsideGitWorkTree(file);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The stored sign-in with its tokens removed; the host id and the issued client id stay (OpenAI asks apps to reuse them). */
export function withoutTokens(s: StoredSignIn): StoredSignIn {
  const { accessToken: _a, refreshToken: _r, expiresAt: _e, earliestRefreshAt: _n, scopes: _s, ...kept } = s;
  return { ...kept, savedAt: new Date().toISOString() };
}

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 100;

/** Create the lock with this owner's identity in it; false when it already exists. */
function createLock(lock: string, identity: string): boolean {
  let fd: number;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, identity);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readLock(lock: string): string | undefined {
  try {
    return readFileSync(lock, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Whether the process named in a lock is known to be gone. A lock with no readable owner (an older engine's is empty) names nobody. */
function ownerIsGone(raw: string): boolean {
  let o: { pid?: unknown; host?: unknown };
  try {
    o = JSON.parse(raw);
  } catch {
    return false;
  }
  if (o?.host !== hostname() || typeof o.pid !== 'number') return false;
  try {
    process.kill(o.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** A crashed holder's lock: its process is gone, or it is more than a minute old. */
function isAbandoned(lock: string, raw: string): boolean {
  if (ownerIsGone(raw)) return true;
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Remove the lock only if it reads as expected. It is moved aside before the
 * final check, so the check and the removal are one step to everyone else, and
 * a lock that changed hands in between goes straight back.
 */
function removeLockIfStill(lock: string, expected: string): boolean {
  if (readLock(lock) !== expected) return false;
  const aside = `${lock}.${randomUUID()}.aside`;
  try {
    renameSync(lock, aside);
  } catch {
    return false;
  }
  try {
    if (readFileSync(aside, 'utf-8') === expected) return true;
    try {
      linkSync(aside, lock);
    } catch {
      // A new owner already holds the name.
    }
    return false;
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Run `fn` holding a lock file created exclusively and carrying this holder's
 * identity. An abandoned lock is taken over; release removes the lock only if
 * it is still this holder's, so a holder that was taken over cannot delete
 * the new owner's. Waiting is bounded.
 */
async function withLockFile<T>(lock: string, fn: () => Promise<T>, opts: { waitMs?: number }): Promise<T> {
  refuseInsideGitWorkTree(lock);
  const dir = dirname(lock);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const identity = JSON.stringify({ owner: randomUUID(), pid: process.pid, host: hostname() });
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  while (!createLock(lock, identity)) {
    const raw = readLock(lock);
    if (raw !== undefined && isAbandoned(lock, raw) && removeLockIfStill(lock, raw)) continue;
    if (Date.now() > deadline) throw new Error(`another process holds ${lock}; try again, or delete it if no melchizedek process is running.`);
    if (raw !== undefined) await delay(LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    removeLockIfStill(lock, identity);
  }
}

/**
 * The credential's short commit lock. It guards one read-compare-write of the
 * file and is never held across a browser wait or a network call: a sign-out
 * waits on it, and a sign-out must not wait on the network.
 */
export function withSignInLock<T>(file: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  return withLockFile(`${file}.lock`, fn, opts);
}

/**
 * One refresher at a time, across processes: OpenAI's refresh tokens rotate,
 * so a second refresh of the same token would be a reuse. Held across the
 * refresh's network calls, so it is a separate file from the commit lock and
 * a sign-out never takes it.
 */
export function withRefreshLease<T>(file: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  return withLockFile(`${file}.refresh.lock`, fn, opts);
}

/**
 * The way a result reaches the file: under the commit lock, re-read it, and
 * write what `build` makes of it only if the file is still at `expected`.
 * `build` may decline with undefined. Returns what was written, or undefined
 * when the result lost (an advanced epoch, no file, or a decline) and the file
 * was left alone.
 */
export function commitAtEpoch(file: string, expected: number, build: (current: StoredSignIn) => StoredSignIn | undefined): Promise<StoredSignIn | undefined> {
  return withSignInLock(file, async () => {
    const current = readStoredSignIn(file);
    if (!current || credentialEpoch(current) !== expected) return undefined;
    const next = build(current);
    if (next) writeStoredSignIn(file, next);
    return next;
  });
}
