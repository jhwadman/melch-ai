/**
 * lib/tools/credentialCipher.ts — how a tool credential is sealed at rest
 * (ADR 0072).
 *
 * WHY this file exists:
 *   The credential store (lib/tools/credentialStore.ts) holds third-party
 *   OAuth tokens per end user. A database dump, a backup or a read replica
 *   must not hand those tokens to whoever holds it, so every token is
 *   encrypted before it leaves the process and the key never reaches the
 *   database. The cipher is a plug point: a deployment with a KMS or a
 *   secret manager implements `CredentialCipher` over it; the built-in one
 *   is AES-256-GCM with a key from MELCHIZEDEK_CREDENTIAL_KEY.
 *
 * THE ENVELOPE: `mzc1.<key id>.<iv>.<tag>.<ciphertext>`, base64url parts.
 *   - The key id is a SHA-256 prefix of the key, so a row sealed with
 *     another key is refused by name, before any decryption is tried.
 *   - The context (app, user, provider and field) is GCM's additional
 *     authenticated data: a ciphertext copied onto another user's row, or
 *     from the refresh field to the access field, does not decrypt.
 *   - A wrong key, a tampered row and a moved row all fail closed with a
 *     CredentialKeyError whose message names no value.
 *
 * Nothing here logs. An error never carries the key, the plaintext or the
 * ciphertext.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** The environment variable the built-in cipher reads its key from. */
export const CREDENTIAL_KEY_ENV = 'MELCHIZEDEK_CREDENTIAL_KEY';

/** The envelope's version prefix; the migration's CHECK refuses anything else. */
export const ENVELOPE_PREFIX = 'mzc1';

/** Seals and opens one token. Implement it over a KMS to keep the key out of the process. */
export interface CredentialCipher {
  /** Names the key that seals new values; stored with each row. */
  readonly keyId: string;
  /** The envelope for `plaintext`, bound to `context`. */
  encrypt(plaintext: string, context: string): Promise<string>;
  /** The plaintext, or a CredentialKeyError when the key or the context does not match. */
  decrypt(envelope: string, context: string): Promise<string>;
}

/** A sealed value that this cipher cannot open: wrong key, tampered or moved. Never carries a value. */
export class CredentialKeyError extends Error {
  readonly reason: 'wrong_key' | 'tampered' | 'malformed';
  constructor(reason: 'wrong_key' | 'tampered' | 'malformed') {
    super(
      reason === 'wrong_key'
        ? `A stored credential was sealed with a different key than ${CREDENTIAL_KEY_ENV}; it stays unreadable.`
        : reason === 'tampered'
          ? 'A stored credential failed its integrity check (altered, or moved to another user or provider); it stays unreadable.'
          : 'A stored credential is not in the expected envelope; it stays unreadable.',
    );
    this.name = 'CredentialKeyError';
    this.reason = reason;
  }
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const B64_KEY = /^[A-Za-z0-9+/_-]{43}=?$/;

/**
 * The 32-byte key from its text form: 64 hex characters, or base64 (or
 * base64url) of 32 bytes. Throws without echoing the value.
 */
export function parseCredentialKey(text: string): Buffer {
  const t = text.trim();
  let key: Buffer | undefined;
  if (HEX_KEY.test(t)) key = Buffer.from(t, 'hex');
  else if (B64_KEY.test(t)) key = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!key || key.length !== 32) {
    throw new Error(
      `${CREDENTIAL_KEY_ENV} must be 32 random bytes as 64 hex characters or base64 (generate one with: openssl rand -base64 32).`,
    );
  }
  return key;
}

/** The key's id: a SHA-256 prefix under a fixed label, safe to store and to log. */
export function credentialKeyId(key: Buffer): string {
  return createHash('sha256').update('melchizedek-credential-key\0').update(key).digest('hex').slice(0, 12);
}

/** AES-256-GCM over a 32-byte key (a Buffer, or its hex or base64 text). */
export function aesGcmCipher(keyInput: Buffer | string): CredentialCipher {
  const key = typeof keyInput === 'string' ? parseCredentialKey(keyInput) : Buffer.from(keyInput);
  if (key.length !== 32) throw new Error('aesGcmCipher needs a 32-byte key.');
  const keyId = credentialKeyId(key);
  return {
    keyId,
    async encrypt(plaintext, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [ENVELOPE_PREFIX, keyId, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
    },
    async decrypt(envelope, context) {
      const parts = typeof envelope === 'string' ? envelope.split('.') : [];
      if (parts.length !== 5 || parts[0] !== ENVELOPE_PREFIX || !parts.slice(2).every((p) => B64URL.test(p))) {
        throw new CredentialKeyError('malformed');
      }
      if (parts[1] !== keyId) throw new CredentialKeyError('wrong_key');
      const iv = Buffer.from(parts[2], 'base64url');
      const tag = Buffer.from(parts[3], 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw new CredentialKeyError('malformed');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
      } catch {
        throw new CredentialKeyError('tampered');
      }
    },
  };
}

/**
 * The built-in cipher from MELCHIZEDEK_CREDENTIAL_KEY, or undefined when it
 * is unset (no credential store then). A malformed key throws, so a
 * deployment that meant to set one fails at boot, not at the first token.
 */
export function credentialCipherFromEnv(env: NodeJS.ProcessEnv = process.env): CredentialCipher | undefined {
  const raw = env[CREDENTIAL_KEY_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  return aesGcmCipher(raw);
}
