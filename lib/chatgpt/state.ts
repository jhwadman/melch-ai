/**
 * lib/chatgpt/state.ts — where a Sign in with ChatGPT credential lives, whether
 * it is the OpenAI path, and the served-surface refusal (ADR 0126).
 *
 * WHY a leaf (node:fs, node:os, node:path only):
 *   The gateway's transport rule (lib/models/gateway.ts), the doctor, the
 *   resolver and every served bin ask the same two questions — is a sign-in
 *   stored, and does it carry OpenAI ids here — so the answer lives in one
 *   module with no adapter or SDK in its import graph.
 *
 * LOCAL ONLY:
 *   OpenAI's plan-usage flow is for open-source apps that run on the user's
 *   own machine (developers.openai.com/siwc/token-sharing-open-source). The
 *   A2A server, the worker and any other served surface call
 *   `refuseChatGptSignInOnServedSurface` at startup and stop while the
 *   sign-in would carry OpenAI ids; `markServedSurface` also makes the
 *   adapter refuse at call time, so a surface that skipped the startup check
 *   still never spends a person's ChatGPT plan on someone else's request.
 *
 * WHAT IT NEVER DOES: return or print a token. The status carries presence,
 * times and the file's path.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Where the credential file lives, when not the default (a path; never a value). */
export const CHATGPT_SIGNIN_FILE_ENV = 'MELCHIZEDEK_CHATGPT_SIGNIN_FILE';
/** `off` ignores a stored sign-in (a served process on a machine that also signed in). */
export const CHATGPT_SIGNIN_ENV = 'MELCHIZEDEK_CHATGPT_SIGNIN';

/** The scope that lets the token use the person's ChatGPT plan. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

/** What the credential file holds (version 1). Tokens are present only while signed in. */
export interface StoredSignIn {
  version: 1;
  /** The authorization server the registration belongs to. */
  issuer: string;
  /** This installation's opaque host id (`urn:uuid:…`), kept across sign-outs. */
  hostId: string;
  /** The client id OpenAI issued at the first sign-in, kept across sign-outs. */
  clientId?: string;
  /** The verified account subject of the last sign-in. */
  subject?: string;
  scopes?: string[];
  accessToken?: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  /** Epoch milliseconds before which a refresh is not attempted while the token is valid. */
  earliestRefreshAt?: number;
  savedAt?: string;
}

/** The sign-in as the doctor and the bins see it: presence and times, never a token. */
export interface ChatGptSignInStatus {
  /** False when MELCHIZEDEK_CHATGPT_SIGNIN=off. */
  enabled: boolean;
  file: string;
  /** A credential file exists at `file`. */
  present: boolean;
  /** It holds a refresh token and the plan scope. */
  signedIn: boolean;
  /** Epoch milliseconds the access token expires, when signed in. */
  expiresAt?: number;
  /** Why a present file cannot be used (permissions, shape). */
  problem?: string;
}

/** The credential file: MELCHIZEDEK_CHATGPT_SIGNIN_FILE, else ~/.melchizedek/chatgpt-signin.json. */
export function signInFile(env: NodeJS.ProcessEnv = process.env): string {
  const set = env[CHATGPT_SIGNIN_FILE_ENV]?.trim();
  return set ? resolve(set) : join(homedir(), '.melchizedek', 'chatgpt-signin.json');
}

/** The git work tree a path sits inside, if any (an ancestor holding `.git`). */
export function insideGitWorkTree(file: string): string | undefined {
  let dir = dirname(resolve(file));
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Whether a parsed value has the stored shape. */
export function isStoredSignIn(v: unknown): v is StoredSignIn {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.version === 1 && typeof o.issuer === 'string' && typeof o.hostId === 'string';
}

/**
 * Read the credential file: undefined when absent; throws, naming the file
 * and never its content, when it is readable by others or malformed.
 */
export function readStoredSignIn(file: string): StoredSignIn | undefined {
  if (!existsSync(file)) return undefined;
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${file} is readable by other users; run \`chmod 600 ${file}\` (or sign in again).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    throw new Error(`${file} is not a Sign in with ChatGPT credential file; delete it and sign in again.`);
  }
  if (!isStoredSignIn(parsed)) throw new Error(`${file} is not a Sign in with ChatGPT credential file; delete it and sign in again.`);
  return parsed;
}

/** Signed in: a refresh token, and the plan scope granted. */
export function isSignedIn(s: StoredSignIn | undefined): boolean {
  return !!s?.refreshToken && !!s.accessToken && (s.scopes ?? []).includes(PLAN_SCOPE);
}

/** The stored sign-in's status under this environment. */
export function chatGptSignInStatus(env: NodeJS.ProcessEnv = process.env): ChatGptSignInStatus {
  const file = signInFile(env);
  const enabled = env[CHATGPT_SIGNIN_ENV]?.trim().toLowerCase() !== 'off';
  const present = existsSync(file);
  if (!present) return { enabled, file, present, signedIn: false };
  try {
    const s = readStoredSignIn(file);
    const signedIn = isSignedIn(s);
    return { enabled, file, present, signedIn, ...(signedIn && s?.expiresAt ? { expiresAt: s.expiresAt } : {}) };
  } catch (err) {
    return { enabled, file, present, signedIn: false, problem: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether OpenAI ids would run on the sign-in here: it is enabled and signed
 * in, no OPENAI_API_KEY is set, and OpenAI is on its own API (no
 * OPENAI_PLATFORM other than direct, no OPENAI_BASE_URL proxy, which must
 * never receive the token).
 */
export function chatGptSignInRoutesOpenAi(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OPENAI_API_KEY?.trim()) return false;
  const platform = env.OPENAI_PLATFORM?.trim().toLowerCase();
  if (platform && platform !== 'direct') return false;
  if (env.OPENAI_BASE_URL?.trim()) return false;
  const status = chatGptSignInStatus(env);
  return status.enabled && status.signedIn;
}

// ── Local only ───────────────────────────────────────────────────────────────

let served: string | undefined;

/** Mark this process a served surface: the sign-in adapter refuses every call from here on. */
export function markServedSurface(surface: string): void {
  served ??= surface;
}

/** The served surface this process was marked as, if any. */
export function servedSurface(): string | undefined {
  return served;
}

/** Test seam: forget the mark. */
export function resetServedSurfaceForTests(): void {
  served = undefined;
}

/** The message a served surface stops with. */
export function servedSurfaceMessage(surface: string, env: NodeJS.ProcessEnv = process.env): string {
  return (
    `${surface} will not start: Sign in with ChatGPT is local only, and it is the OpenAI path here ` +
    `(a sign-in is stored at ${signInFile(env)} and OPENAI_API_KEY is not set). ` +
    `A served surface answers other people, and a ChatGPT plan pays only for its owner's own use on their own machine. ` +
    `Set OPENAI_API_KEY (or Azure OpenAI), or set ${CHATGPT_SIGNIN_ENV}=off for this process, ` +
    `or sign out with \`melchizedek-setup --chatgpt-signout\`.`
  );
}

/**
 * Called by every served surface at startup: marks the process served, and
 * throws when the sign-in would carry OpenAI ids here. The A2A app, the A2A
 * server bin and the worker call it; a new served surface calls it too.
 */
export function refuseChatGptSignInOnServedSurface(surface: string, env: NodeJS.ProcessEnv = process.env): void {
  markServedSurface(surface);
  if (chatGptSignInRoutesOpenAi(env)) throw new Error(servedSurfaceMessage(surface, env));
}
