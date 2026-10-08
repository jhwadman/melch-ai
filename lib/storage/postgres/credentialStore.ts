/**
 * lib/storage/postgres/credentialStore.ts — tool credentials on a direct
 * Postgres connection (ADR 0072).
 *
 * The rows of melchizedek_tool_credentials (db/migrations/0013): ciphertext
 * and metadata only. Sealing, refresh, revoke and audit live in
 * lib/tools/credentialStore.ts; `postgresCredentialStore` puts the two
 * together, and `postgresStorage({ credentials })` builds it on the storage
 * pool with the storage's audit sink.
 *
 * A refresh writes only over the version it read (`replace`), so two
 * instances that refresh the same token at once keep one result and the
 * other reads it back.
 */

import type { Pool } from 'pg';

import { credentialStore } from '../../tools/credentialStore.ts';
import type { CredentialRow, CredentialRows, CredentialStoreOptions } from '../../tools/credentialStore.ts';
import type { CredentialStore } from '../../tools/auth.ts';

const COLUMNS = 'app_name, user_id, provider, scopes, access_token_enc, refresh_token_enc, key_id, expires_at, version, created_at, updated_at, refreshed_at';

function rowOf(r: Record<string, unknown>): CredentialRow {
  return {
    appName: r.app_name as string,
    userId: r.user_id as string,
    provider: r.provider as string,
    scopes: (r.scopes as string[] | null) ?? [],
    accessTokenEnc: r.access_token_enc as string,
    refreshTokenEnc: (r.refresh_token_enc as string | null) ?? null,
    keyId: r.key_id as string,
    expiresAt: (r.expires_at as Date | null) ?? null,
    version: Number(r.version),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    refreshedAt: (r.refreshed_at as Date | null) ?? null,
  };
}

/** A LIKE pattern for users nested beneath `userId`, its own wildcards escaped. */
function nestedLike(userId: string): string {
  return `${userId.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
}

export function postgresCredentialRows(pool: Pick<Pool, 'query'>): CredentialRows {
  return {
    async read(key) {
      const r = await pool.query(
        `SELECT ${COLUMNS} FROM melchizedek_tool_credentials WHERE app_name = $1 AND user_id = $2 AND provider = $3`,
        [key.appName, key.userId, key.provider],
      );
      return r.rows[0] ? rowOf(r.rows[0]) : undefined;
    },

    async upsert(row) {
      await pool.query(
        `INSERT INTO melchizedek_tool_credentials
           (app_name, user_id, provider, scopes, access_token_enc, refresh_token_enc, key_id, expires_at)
         VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8)
         ON CONFLICT (app_name, user_id, provider) DO UPDATE SET
           scopes = EXCLUDED.scopes,
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = EXCLUDED.refresh_token_enc,
           key_id = EXCLUDED.key_id,
           expires_at = EXCLUDED.expires_at,
           version = melchizedek_tool_credentials.version + 1,
           updated_at = now(),
           refreshed_at = NULL`,
        [row.appName, row.userId, row.provider, row.scopes, row.accessTokenEnc, row.refreshTokenEnc, row.keyId, row.expiresAt],
      );
    },

    async replace(row, expectedVersion) {
      const r = await pool.query(
        `UPDATE melchizedek_tool_credentials SET
           scopes = $4::text[], access_token_enc = $5, refresh_token_enc = $6, key_id = $7, expires_at = $8,
           version = version + 1, updated_at = now(), refreshed_at = now()
         WHERE app_name = $1 AND user_id = $2 AND provider = $3 AND version = $9`,
        [row.appName, row.userId, row.provider, row.scopes, row.accessTokenEnc, row.refreshTokenEnc, row.keyId, row.expiresAt, expectedVersion],
      );
      return r.rowCount === 1;
    },

    async delete(key) {
      const r = await pool.query('DELETE FROM melchizedek_tool_credentials WHERE app_name = $1 AND user_id = $2 AND provider = $3', [
        key.appName,
        key.userId,
        key.provider,
      ]);
      return (r.rowCount ?? 0) > 0;
    },

    async deleteUser(userId, options = {}) {
      const r = await pool.query(
        `DELETE FROM melchizedek_tool_credentials
         WHERE ($1::text IS NULL OR app_name = $1) AND (user_id = $2 OR ($3 AND user_id LIKE $4))`,
        [options.appName ?? null, userId, options.includeNested === true, nestedLike(userId)],
      );
      return r.rowCount ?? 0;
    },
  };
}

/** The credential store on Postgres: sealed rows, refresh, revoke and audit. */
export function postgresCredentialStore(pool: Pick<Pool, 'query'>, options: Omit<CredentialStoreOptions, 'rows'>): CredentialStore {
  return credentialStore({ ...options, rows: postgresCredentialRows(pool) });
}
