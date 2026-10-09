/**
 * lib/chatgpt/store.ts — writing the Sign in with ChatGPT credential file and
 * serializing its refreshes (ADR 0126).
 *
 * The file is the person's own: mode 600 in a mode-700 directory, outside any
 * git work tree, replaced atomically (a new mode-600 file renamed over the
 * old one). OpenAI's refresh tokens rotate, so two processes must not refresh
 * the same session at once (developers.openai.com/siwc/token-sharing-open-source/
 * profiles-and-sessions): a lock file beside the credential serializes them.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { insideGitWorkTree, readStoredSignIn } from './state.ts';
import type { StoredSignIn } from './state.ts';

/** Write the credential file: mode 600, atomically, never inside a git work tree. */
export function writeStoredSignIn(file: string, value: StoredSignIn): void {
  const repo = insideGitWorkTree(file);
  if (repo) {
    throw new Error(`refusing to store a ChatGPT sign-in inside the git work tree ${repo}; set MELCHIZEDEK_CHATGPT_SIGNIN_FILE to a path outside it.`);
  }
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

/** Remove the tokens from the file, keeping the registration. */
export function clearTokens(file: string): void {
  const s = readStoredSignIn(file);
  if (s) writeStoredSignIn(file, withoutTokens(s));
}

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 20_000;

/**
 * Run `fn` holding the credential's lock file (created exclusively). A lock
 * older than a minute is a crashed holder's and is taken over.
 */
export async function withSignInLock<T>(file: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  const lock = `${file}.lock`;
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`another process holds ${lock}; try again, or delete it if no melchizedek process is running.`);
      await delay(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
