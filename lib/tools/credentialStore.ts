/**
 * lib/tools/credentialStore.ts — the tool credential store over any row
 * backend (ADR 0072).
 *
 * WHY this file exists:
 *   Sealing, refreshing, revoking and auditing are written once, here. A
 *   backend only keeps rows of ciphertext (`CredentialRows`): Postgres
 *   (lib/storage/postgres/credentialStore.ts) for a deployment, the
 *   in-memory one below for tests and a single process. Neither ever sees
 *   a plaintext token.
 *
 * WHAT IT GUARANTEES:
 *   - Every token is sealed by the cipher before the backend sees it, bound
 *     to its app, user, provider and field (lib/tools/credentialCipher.ts).
 *   - `get` refreshes an expired token through the provider's `refresh`, at
 *     most once at a time per key in this process, and writes the result
 *     only over the version it read: when another instance refreshed first,
 *     its token is used.
 *   - A row this server's key cannot open fails closed (`unreadable`) and is
 *     never refreshed or overwritten by a read.
 *   - Put, refresh, revoke and erase each write an audit row (ADR 0042): the
 *     provider and the app, the user as a scope hash, never a token.
 *   - No token reaches a log line, a span, an error message or an audit
 *     row: a provider's own error is reported by kind, not by message,
 *     since a provider may echo the token it refused.
 */

import { INVALID_SPAN_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { turnUntraced } from '../runtime/turnControl.ts';

import { scopeHashOf } from '../observability/audit.ts';
import type { AuditSink } from '../observability/audit.ts';
import { PROVIDER_NAME, ToolCredentialError } from './auth.ts';
import type { AccessGrant, CredentialKey, CredentialStore, EraseCredentialsOptions, OAuthProvider, TokenSet } from './auth.ts';
import type { CredentialCipher } from './credentialCipher.ts';

/** One stored row: ciphertext and metadata, never a plaintext token. */
export interface CredentialRow {
  appName: string;
  userId: string;
  provider: string;
  scopes: string[];
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  keyId: string;
  expiresAt: Date | null;
  /** Bumped by every write. */
  version: number;
  createdAt?: Date;
  updatedAt?: Date;
  refreshedAt?: Date | null;
}

/** Where rows live. Implementations hold and move ciphertext only. */
export interface CredentialRows {
  read(key: CredentialKey): Promise<CredentialRow | undefined>;
  /** Insert, or replace whatever is stored for the key (the version moves on). */
  upsert(row: Omit<CredentialRow, 'version'>): Promise<void>;
  /** Replace the row only if it still has `expectedVersion`; true when it did. */
  replace(row: Omit<CredentialRow, 'version'>, expectedVersion: number): Promise<boolean>;
  delete(key: CredentialKey): Promise<boolean>;
  deleteUser(userId: string, options?: EraseCredentialsOptions): Promise<number>;
}

export interface CredentialStoreOptions {
  rows: CredentialRows;
  cipher: CredentialCipher;
  /** Each provider's refresh and revoke, by provider name. A provider without `refresh` cannot renew. */
  providers?: Record<string, OAuthProvider> | ((provider: string) => OAuthProvider | undefined);
  /** The audit trail (postgresStorage().audit, or any sink). */
  audit?: AuditSink;
  /** A token this close to its expiry is refreshed first. Default 60 s. */
  refreshSkewMs?: number;
  /** The clock, for tests. */
  now?: () => number;
}

const tracer = () => trace.getTracer('melchizedek.credentials');

/** `credential.refresh` as an active span; in a turn that opted out of tracing, a non-recording one. */
function withRefreshSpan<T>(provider: string, fn: (span: Span) => Promise<T>): Promise<T> {
  if (turnUntraced()) return fn(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
  return tracer().startActiveSpan('credential.refresh', { attributes: { 'credential.provider': provider } }, fn);
}

/** The AAD a field is sealed under: its app, user, provider and field, NUL-separated. */
export function credentialContext(key: CredentialKey, field: 'access' | 'refresh'): string {
  return `${key.appName}\0${key.userId}\0${key.provider}\0${field}`;
}

function checkKey(key: CredentialKey): void {
  const ok =
    key &&
    typeof key.appName === 'string' &&
    typeof key.userId === 'string' &&
    key.appName.trim() !== '' &&
    key.userId.trim() !== '' &&
    !key.appName.includes('\0') &&
    !key.userId.includes('\0') &&
    typeof key.provider === 'string' &&
    PROVIDER_NAME.test(key.provider);
  if (!ok) throw new ToolCredentialError('invalid', typeof key?.provider === 'string' && PROVIDER_NAME.test(key.provider) ? key.provider : undefined);
}

function checkTokens(tokens: TokenSet | undefined, provider: string): asserts tokens is TokenSet {
  const ok =
    tokens &&
    typeof tokens.accessToken === 'string' &&
    tokens.accessToken !== '' &&
    (tokens.refreshToken === undefined || (typeof tokens.refreshToken === 'string' && tokens.refreshToken !== '')) &&
    (tokens.expiresAt === undefined || (tokens.expiresAt instanceof Date && !Number.isNaN(tokens.expiresAt.getTime()))) &&
    (tokens.scopes === undefined || (Array.isArray(tokens.scopes) && tokens.scopes.every((s) => typeof s === 'string')));
  if (!ok) throw new ToolCredentialError('invalid', provider);
}

export function credentialStore(options: CredentialStoreOptions): CredentialStore {
  const { rows, cipher, audit } = options;
  const skew = options.refreshSkewMs ?? 60_000;
  const now = options.now ?? Date.now;
  const providerOf = (name: string): OAuthProvider | undefined =>
    typeof options.providers === 'function'
      ? options.providers(name)
      : options.providers && Object.hasOwn(options.providers, name)
        ? options.providers[name]
        : undefined;
  const inflight = new Map<string, Promise<AccessGrant>>();

  const record = (event: 'credential.put' | 'credential.refresh' | 'credential.revoke' | 'credential.erase', outcome: string, userId: string, detail: Record<string, unknown>) => {
    try {
      audit?.({ event, outcome, scopeHash: scopeHashOf(userId), detail });
    } catch {
      // The audit sink never fails the operation (ADR 0042).
    }
  };

  const open = async (envelope: string, key: CredentialKey, field: 'access' | 'refresh'): Promise<string> => {
    try {
      return await cipher.decrypt(envelope, credentialContext(key, field));
    } catch {
      // A CredentialKeyError (wrong key, altered or moved row) or a KMS
      // failure: either way the row stays closed, and no value is reported.
      throw new ToolCredentialError('unreadable', key.provider);
    }
  };

  const seal = async (key: CredentialKey, tokens: TokenSet, keepScopes: string[] = []): Promise<Omit<CredentialRow, 'version'>> => ({
    appName: key.appName,
    userId: key.userId,
    provider: key.provider,
    scopes: tokens.scopes ?? keepScopes,
    accessTokenEnc: await cipher.encrypt(tokens.accessToken, credentialContext(key, 'access')),
    refreshTokenEnc: tokens.refreshToken ? await cipher.encrypt(tokens.refreshToken, credentialContext(key, 'refresh')) : null,
    keyId: cipher.keyId,
    expiresAt: tokens.expiresAt ?? null,
  });

  const fresh = (row: CredentialRow) => !row.expiresAt || row.expiresAt.getTime() - skew > now();

  const grantOf = async (row: CredentialRow, key: CredentialKey): Promise<AccessGrant> => ({
    accessToken: await open(row.accessTokenEnc, key, 'access'),
    scopes: [...row.scopes],
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
  });

  const refresh = async (row: CredentialRow, key: CredentialKey, signal?: AbortSignal): Promise<AccessGrant> => {
    const detail = { provider: key.provider, appName: key.appName };
    const provider = providerOf(key.provider);
    if (!row.refreshTokenEnc || !provider?.refresh) {
      record('credential.refresh', 'expired', key.userId, { ...detail, reason: !row.refreshTokenEnc ? 'no_refresh_token' : 'no_refresh_function' });
      throw new ToolCredentialError('expired', key.provider);
    }
    const refreshToken = await open(row.refreshTokenEnc, key, 'refresh');
    return withRefreshSpan(key.provider, async (span) => {
      try {
        let issued: TokenSet;
        try {
          issued = await provider.refresh!(refreshToken, { scopes: [...row.scopes], signal });
          checkTokens(issued, key.provider);
        } catch {
          // The provider's message is not reported: it may echo the token.
          span.setAttribute('credential.outcome', 'failed');
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'refresh refused' });
          record('credential.refresh', 'failed', key.userId, detail);
          throw new ToolCredentialError('refresh_failed', key.provider);
        }
        // Keep the refresh token when the provider did not rotate it.
        const next = await seal(key, { ...issued, refreshToken: issued.refreshToken ?? refreshToken }, row.scopes);
        if (await rows.replace(next, row.version)) {
          span.setAttribute('credential.outcome', 'ok');
          record('credential.refresh', 'ok', key.userId, detail);
          return { accessToken: issued.accessToken, scopes: [...next.scopes], ...(next.expiresAt ? { expiresAt: next.expiresAt } : {}) };
        }
        // Another instance refreshed (or the user reconnected) first: use theirs.
        span.setAttribute('credential.outcome', 'superseded');
        const current = await rows.read(key);
        if (current && fresh(current)) return grantOf(current, key);
        record('credential.refresh', 'failed', key.userId, { ...detail, reason: 'superseded' });
        throw new ToolCredentialError('refresh_failed', key.provider);
      } finally {
        span.end();
      }
    });
  };

  return {
    async put(key, tokens) {
      checkKey(key);
      checkTokens(tokens, key.provider);
      await rows.upsert(await seal(key, tokens));
      record('credential.put', 'ok', key.userId, { provider: key.provider, appName: key.appName, scopes: tokens.scopes?.length ?? 0, refreshable: Boolean(tokens.refreshToken) });
    },

    async get(key, opts = {}) {
      checkKey(key);
      const row = await rows.read(key);
      if (!row) return undefined;
      if (row.keyId !== cipher.keyId) throw new ToolCredentialError('unreadable', key.provider);
      if (fresh(row)) return grantOf(row, key);
      const id = credentialContext(key, 'access');
      let pending = inflight.get(id);
      if (!pending) {
        pending = refresh(row, key, opts.signal).finally(() => inflight.delete(id));
        inflight.set(id, pending);
      }
      return pending;
    },

    async revoke(key) {
      checkKey(key);
      const row = await rows.read(key);
      if (!row) return false;
      const deleted = await rows.delete(key);
      let remote: 'none' | 'ok' | 'failed' | 'unreadable' = 'none';
      const provider = providerOf(key.provider);
      if (provider?.revoke) {
        try {
          const accessToken = await open(row.accessTokenEnc, key, 'access');
          const refreshToken = row.refreshTokenEnc ? await open(row.refreshTokenEnc, key, 'refresh') : undefined;
          try {
            await provider.revoke({ accessToken, ...(refreshToken ? { refreshToken } : {}) });
            remote = 'ok';
          } catch {
            remote = 'failed';
          }
        } catch {
          remote = 'unreadable';
        }
      }
      record('credential.revoke', 'ok', key.userId, { provider: key.provider, appName: key.appName, remote });
      return deleted;
    },

    async eraseUser(userId, opts = {}) {
      if (typeof userId !== 'string' || !userId.trim()) throw new ToolCredentialError('no_user');
      const n = await rows.deleteUser(userId, opts);
      record('credential.erase', 'ok', userId, { ...(opts.appName ? { appName: opts.appName } : {}), includeNested: Boolean(opts.includeNested), deleted: n });
      return n;
    },
  };
}

/**
 * Rows in process memory: for tests and a single process. Like the
 * Postgres backend it holds what the store hands it, which is ciphertext.
 */
export function memoryCredentialRows(): CredentialRows & { all(): CredentialRow[] } {
  const rows = new Map<string, CredentialRow>();
  const id = (k: CredentialKey) => `${k.appName}\0${k.userId}\0${k.provider}`;
  const copy = (r: CredentialRow): CredentialRow => ({ ...r, scopes: [...r.scopes] });
  return {
    async read(key) {
      const r = rows.get(id(key));
      return r ? copy(r) : undefined;
    },
    async upsert(row) {
      const prev = rows.get(id(row));
      const at = new Date();
      rows.set(id(row), { ...row, scopes: [...row.scopes], version: (prev?.version ?? 0) + 1, createdAt: prev?.createdAt ?? at, updatedAt: at, refreshedAt: null });
    },
    async replace(row, expectedVersion) {
      const prev = rows.get(id(row));
      if (!prev || prev.version !== expectedVersion) return false;
      const at = new Date();
      rows.set(id(row), { ...row, scopes: [...row.scopes], version: prev.version + 1, createdAt: prev.createdAt, updatedAt: at, refreshedAt: at });
      return true;
    },
    async delete(key) {
      return rows.delete(id(key));
    },
    async deleteUser(userId, opts = {}) {
      let n = 0;
      for (const [k, r] of rows) {
        const mine = r.userId === userId || (opts.includeNested === true && r.userId.startsWith(`${userId}/`));
        if (mine && (!opts.appName || r.appName === opts.appName)) {
          rows.delete(k);
          n++;
        }
      }
      return n;
    },
    all: () => [...rows.values()].map(copy),
  };
}
