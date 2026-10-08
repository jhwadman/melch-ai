/**
 * tests/toolCredentials.test.ts — third-party tokens held for tools
 * (ADR 0072), offline: the AES-256-GCM cipher, the store over in-memory
 * rows (put, read back, refresh on expiry, revoke, erase), the ToolContext
 * member bound to the run's own user, and the rule that no token value
 * reaches a log line, a span, an error message or an audit row. The same
 * store on Postgres is in tests/postgresStorage.test.ts.
 *
 * Every token and key here is an obvious fake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { trace } from '@opentelemetry/api';
import sdkBase from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';

import {
  CREDENTIAL_KEY_ENV,
  CredentialKeyError,
  aesGcmCipher,
  credentialCipherFromEnv,
  parseCredentialKey,
} from '../lib/tools/credentialCipher.ts';
import { credentialContext, credentialStore, memoryCredentialRows } from '../lib/tools/credentialStore.ts';
import { ToolCredentialError, pinnedCredentialStore, toolAccessToken } from '../lib/tools/auth.ts';
import type { CredentialKey, OAuthProvider, TokenSet } from '../lib/tools/auth.ts';
import { createToolContext } from '../lib/tools/tool.ts';
import { defineTool } from '../lib/tools/toolContract.ts';
import { scopeHashOf } from '../lib/observability/audit.ts';
import type { AuditEvent } from '../lib/observability/audit.ts';

const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = sdkBase as any;

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const ACCESS = 'fake-access-token-ALPHA-0001';
const REFRESH = 'fake-refresh-token-ALPHA-0001';
const ACCESS_2 = 'fake-access-token-BRAVO-0002';
const REFRESH_2 = 'fake-refresh-token-BRAVO-0002';
const SECRETS = [ACCESS, REFRESH, ACCESS_2, REFRESH_2];

const key = (over: Partial<CredentialKey> = {}): CredentialKey => ({ appName: 'desk.k3f9', userId: 'alice', provider: 'github', ...over });

function harness(opts: { providers?: Record<string, OAuthProvider>; cipher?: ReturnType<typeof aesGcmCipher>; rows?: ReturnType<typeof memoryCredentialRows> } = {}) {
  let clock = Date.parse('2026-10-08T12:00:00Z');
  const events: AuditEvent[] = [];
  const rows = opts.rows ?? memoryCredentialRows();
  const store = credentialStore({
    rows,
    cipher: opts.cipher ?? aesGcmCipher(KEY_A),
    providers: opts.providers,
    audit: (e) => events.push(e),
    now: () => clock,
  });
  return { store, rows, events, advance: (ms: number) => (clock += ms), at: () => clock };
}

// ── The cipher ───────────────────────────────────────────────────────────────

test('cipher: a token round-trips, and the envelope holds no plaintext', async () => {
  const c = aesGcmCipher(KEY_A);
  const ctx = credentialContext(key(), 'access');
  const sealed = await c.encrypt(ACCESS, ctx);
  assert.match(sealed, /^mzc1\./);
  assert.ok(!sealed.includes(ACCESS));
  assert.equal(sealed.split('.')[1], c.keyId);
  assert.notEqual(await c.encrypt(ACCESS, ctx), sealed, 'a fresh IV each time');
  assert.equal(await c.decrypt(sealed, ctx), ACCESS);
});

test('cipher: a wrong key, an altered row and a row moved to another user all fail closed', async () => {
  const a = aesGcmCipher(KEY_A);
  const sealed = await a.encrypt(ACCESS, credentialContext(key(), 'access'));
  await assert.rejects(aesGcmCipher(KEY_B).decrypt(sealed, credentialContext(key(), 'access')), (e: unknown) => e instanceof CredentialKeyError && e.reason === 'wrong_key');
  const parts = sealed.split('.');
  const flipped = parts[4][0] === 'A' ? `B${parts[4].slice(1)}` : `A${parts[4].slice(1)}`;
  await assert.rejects(a.decrypt([...parts.slice(0, 4), flipped].join('.'), credentialContext(key(), 'access')), (e: unknown) => e instanceof CredentialKeyError && e.reason === 'tampered');
  await assert.rejects(a.decrypt(sealed, credentialContext(key({ userId: 'mallory' }), 'access')), /integrity check/);
  await assert.rejects(a.decrypt(sealed, credentialContext(key(), 'refresh')), /integrity check/, 'fields are not interchangeable');
  await assert.rejects(a.decrypt('plaintext-token', credentialContext(key(), 'access')), (e: unknown) => e instanceof CredentialKeyError && e.reason === 'malformed');
});

test('cipher: the key is 32 bytes as hex or base64; a bad one fails without echoing it, an unset one means no store', () => {
  assert.deepEqual(parseCredentialKey(KEY_A.toString('hex')), KEY_A);
  assert.deepEqual(parseCredentialKey(KEY_A.toString('base64')), KEY_A);
  assert.deepEqual(parseCredentialKey(KEY_A.toString('base64url')), KEY_A);
  assert.equal(aesGcmCipher(KEY_A.toString('base64')).keyId, aesGcmCipher(KEY_A).keyId);
  const bad = 'not-a-key-but-a-fake-value-0123';
  assert.throws(() => parseCredentialKey(bad), (e: Error) => e.message.includes(CREDENTIAL_KEY_ENV) && !e.message.includes(bad));
  assert.throws(() => parseCredentialKey(randomBytes(16).toString('hex')), /32 random bytes/);
  assert.equal(credentialCipherFromEnv({}), undefined);
  assert.equal(credentialCipherFromEnv({ [CREDENTIAL_KEY_ENV]: '  ' }), undefined);
  assert.equal(credentialCipherFromEnv({ [CREDENTIAL_KEY_ENV]: KEY_A.toString('base64') })!.keyId, aesGcmCipher(KEY_A).keyId);
  assert.throws(() => credentialCipherFromEnv({ [CREDENTIAL_KEY_ENV]: bad }), /32 random bytes/);
});

// ── The store ────────────────────────────────────────────────────────────────

test('store: a token is stored sealed, read back, and kept per app, user and provider', async () => {
  const h = harness();
  await h.store.put(key(), { accessToken: ACCESS, refreshToken: REFRESH, scopes: ['repo'], expiresAt: new Date(h.at() + 3_600_000) });
  const [row] = h.rows.all();
  assert.ok(row.accessTokenEnc.startsWith('mzc1.') && row.refreshTokenEnc!.startsWith('mzc1.'));
  assert.ok(!JSON.stringify(h.rows.all()).includes('fake-'), 'no plaintext in the stored rows');
  const grant = await h.store.get(key());
  assert.equal(grant?.accessToken, ACCESS);
  assert.deepEqual(grant?.scopes, ['repo']);
  assert.equal(await h.store.get(key({ userId: 'bob' })), undefined);
  assert.equal(await h.store.get(key({ appName: 'other.ns' })), undefined);
  assert.equal(await h.store.get(key({ provider: 'gitlab' })), undefined);
  await assert.rejects(h.store.get(key({ provider: 'Bad Provider' })), (e: unknown) => e instanceof ToolCredentialError && e.code === 'invalid');
  await assert.rejects(h.store.put(key(), { accessToken: '' } as TokenSet), (e: unknown) => e instanceof ToolCredentialError && e.code === 'invalid');
});

test('store: an expired token is refreshed once, stored sealed, and the new token returned', async () => {
  const calls: Array<{ refreshToken: string; scopes: string[] }> = [];
  const h = harness({
    providers: {
      github: {
        refresh: async (refreshToken, { scopes }) => {
          calls.push({ refreshToken, scopes });
          await new Promise((r) => setTimeout(r, 10));
          return { accessToken: ACCESS_2, refreshToken: REFRESH_2, expiresAt: new Date(h.at() + 3_600_000) };
        },
      },
    },
  });
  await h.store.put(key(), { accessToken: ACCESS, refreshToken: REFRESH, scopes: ['repo'], expiresAt: new Date(h.at() + 600_000) });
  assert.equal((await h.store.get(key()))?.accessToken, ACCESS, 'still valid');
  h.advance(600_000 - 30_000); // inside the 60 s skew
  const [a, b] = await Promise.all([h.store.get(key()), h.store.get(key())]);
  assert.equal(a?.accessToken, ACCESS_2);
  assert.equal(b?.accessToken, ACCESS_2);
  assert.deepEqual(calls, [{ refreshToken: REFRESH, scopes: ['repo'] }], 'one refresh for two concurrent reads');
  const [row] = h.rows.all();
  assert.equal(row.version, 2);
  assert.deepEqual(row.scopes, ['repo'], 'scopes kept when the provider does not restate them');
  assert.equal((await h.store.get(key()))?.accessToken, ACCESS_2, 'read back after the refresh');
  assert.deepEqual(
    h.events.map((e) => [e.event, e.outcome]),
    [['credential.put', 'ok'], ['credential.refresh', 'ok']],
  );
});

test('store: a provider that keeps its refresh token keeps it stored; another instance refreshing first wins', async () => {
  const rows = memoryCredentialRows();
  const h = harness({
    rows,
    providers: { github: { refresh: async () => ({ accessToken: ACCESS_2, expiresAt: new Date(Date.parse('2026-10-08T14:00:00Z')) }) } },
  });
  await h.store.put(key(), { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: new Date(h.at() - 1) });
  await h.store.get(key());
  h.advance(3 * 3_600_000);
  // The provider still accepts the old refresh token, which the row kept.
  const again = harness({ rows, providers: { github: { refresh: async (rt) => { assert.equal(rt, REFRESH); return { accessToken: ACCESS, expiresAt: new Date(Date.parse('2026-10-09T00:00:00Z')) }; } } } });
  again.advance(3 * 3_600_000);
  assert.equal((await again.store.get(key()))?.accessToken, ACCESS);

  // A lost race: the row moved on between this instance's read and its write.
  const raced = memoryCredentialRows();
  const other = harness({ rows: raced });
  await other.store.put(key(), { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: new Date(other.at() - 1) });
  const slow = harness({
    rows: raced,
    providers: {
      github: {
        refresh: async () => {
          // Meanwhile another instance stored a fresh token.
          await other.store.put(key(), { accessToken: ACCESS_2, refreshToken: REFRESH_2, expiresAt: new Date(other.at() + 3_600_000) });
          return { accessToken: 'fake-access-token-LOSER-0003', expiresAt: new Date(other.at() + 3_600_000) };
        },
      },
    },
  });
  assert.equal((await slow.store.get(key()))?.accessToken, ACCESS_2, 'the stored winner, not the lost write');
});

test('store: an expired token that cannot be renewed, and a refused refresh, say so without a value', async () => {
  const h = harness({ providers: { github: { refresh: async () => { throw new Error(`invalid_grant for ${REFRESH}`); } } } });
  await h.store.put(key(), { accessToken: ACCESS, expiresAt: new Date(h.at() - 1) });
  await assert.rejects(h.store.get(key()), (e: unknown) => e instanceof ToolCredentialError && e.code === 'expired');
  await h.store.put(key({ provider: 'slack' }), { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: new Date(h.at() - 1) });
  await assert.rejects(h.store.get(key({ provider: 'slack' })), (e: unknown) => e instanceof ToolCredentialError && e.code === 'expired', 'no refresh function for slack');
  await h.store.put(key(), { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: new Date(h.at() - 1) });
  await assert.rejects(h.store.get(key()), (e: unknown) => {
    assert.ok(e instanceof ToolCredentialError && e.code === 'refresh_failed');
    assert.ok(!SECRETS.some((s) => (e as Error).message.includes(s)) && !(e as Error).message.includes('invalid_grant'));
    return true;
  });
  assert.equal(h.rows.all().find((r) => r.provider === 'github')!.version, 2, 'a refused refresh writes nothing');
});

test('store: a wrong key fails closed: no token, no refresh, no overwrite', async () => {
  const rows = memoryCredentialRows();
  const a = harness({ rows });
  await a.store.put(key(), { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: new Date(a.at() - 1) });
  let refreshed = false;
  const b = harness({ rows, cipher: aesGcmCipher(KEY_B), providers: { github: { refresh: async () => { refreshed = true; return { accessToken: ACCESS_2 }; } } } });
  await assert.rejects(b.store.get(key()), (e: unknown) => e instanceof ToolCredentialError && e.code === 'unreadable' && !SECRETS.some((s) => (e as Error).message.includes(s)));
  assert.equal(refreshed, false);
  assert.equal(rows.all()[0].version, 1);
  // A row whose key id matches but whose ciphertext was moved from another user.
  await a.store.put(key({ userId: 'bob' }), { accessToken: ACCESS_2 });
  const all = rows.all();
  const bob = all.find((r) => r.userId === 'bob')!;
  await rows.upsert({ ...all.find((r) => r.userId === 'alice')!, accessTokenEnc: bob.accessTokenEnc, expiresAt: null });
  await assert.rejects(a.store.get(key()), (e: unknown) => e instanceof ToolCredentialError && e.code === 'unreadable');
});

test('store: revoke deletes the row and withdraws the grant; erase removes a user per app, everywhere, or nested', async () => {
  const revoked: unknown[] = [];
  const h = harness({ providers: { github: { revoke: async (t) => { revoked.push(t); } } } });
  await h.store.put(key(), { accessToken: ACCESS, refreshToken: REFRESH });
  assert.equal(await h.store.revoke(key()), true);
  assert.deepEqual(revoked, [{ accessToken: ACCESS, refreshToken: REFRESH }]);
  assert.equal(await h.store.get(key()), undefined);
  assert.equal(await h.store.revoke(key()), false);

  for (const k of [key(), key({ provider: 'slack' }), key({ appName: 'other.ns' }), key({ userId: 'alice/end-1' }), key({ userId: 'alice_x' }), key({ userId: 'bob' })]) {
    await h.store.put(k, { accessToken: ACCESS });
  }
  assert.equal(await h.store.eraseUser('alice', { appName: 'desk.k3f9' }), 2);
  assert.equal(await h.store.eraseUser('alice', { includeNested: true }), 2, 'other.ns and alice/end-1, not alice_x');
  assert.deepEqual(h.rows.all().map((r) => r.userId).sort(), ['alice_x', 'bob']);
  await assert.rejects(h.store.eraseUser('  '), (e: unknown) => e instanceof ToolCredentialError && e.code === 'no_user');
  const erase = h.events.filter((e) => e.event === 'credential.erase');
  assert.deepEqual(erase.map((e) => [e.scopeHash, e.detail?.deleted]), [[scopeHashOf('alice'), 2], [scopeHashOf('alice'), 2]]);
});

// ── The ToolContext member ───────────────────────────────────────────────────

test('ToolContext.accessToken: the run\'s own user only, the provider chosen by the tool', async () => {
  const h = harness();
  await h.store.put(key(), { accessToken: ACCESS });
  await h.store.put(key({ userId: 'bob' }), { accessToken: ACCESS_2 });

  const ctx = createToolContext({ appName: 'desk.k3f9', userId: 'alice', credentials: h.store });
  assert.equal(await ctx.accessToken!('github'), ACCESS);
  await assert.rejects(ctx.accessToken!('gitlab'), (e: unknown) => e instanceof ToolCredentialError && e.code === 'not_connected' && /connect it/.test((e as Error).message));
  assert.equal(createToolContext({ appName: 'desk.k3f9', userId: 'alice' }).accessToken, undefined, 'no store, no member');
  await assert.rejects(createToolContext({ userId: 'alice', credentials: h.store }).accessToken!('github'), (e: unknown) => (e as ToolCredentialError).code === 'no_user');

  // A delegated subagent runs under its own app name; the pinned store reads the root's.
  const sub = createToolContext({ appName: 'Scout', userId: 'alice', credentials: pinnedCredentialStore(h.store, 'desk.k3f9') });
  assert.equal(await sub.accessToken!('github'), ACCESS);

  // A tool's arguments cannot reach another user's token: the member takes a provider only.
  const tool = defineTool({
    name: 'whoami_on_github',
    description: 'test tool',
    schema: z.object({ userId: z.string().optional() }),
    execute: async (_args, c) => {
      const token = await c.accessToken!('github');
      return token === ACCESS ? 'alice' : token === ACCESS_2 ? 'bob' : 'unknown';
    },
  });
  assert.equal(await tool.execute({ userId: 'bob' }, ctx), 'alice');
  assert.equal(await toolAccessToken(h.store, 'desk.k3f9', 'bob')('github'), ACCESS_2);
});

// ── No value leaks ───────────────────────────────────────────────────────────

test('no token value reaches a log line, a span, an error message or an audit row', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);

  const printed: string[] = [];
  const consoleNames = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const savedConsole = consoleNames.map((n) => console[n]);
  const savedOut = process.stdout.write.bind(process.stdout);
  const savedErr = process.stderr.write.bind(process.stderr);
  for (const n of consoleNames) (console as any)[n] = (...args: unknown[]) => printed.push(args.map(String).join(' '));
  (process.stdout as any).write = (chunk: unknown, ...rest: unknown[]) => (printed.push(String(chunk)), true);
  (process.stderr as any).write = (chunk: unknown, ...rest: unknown[]) => (printed.push(String(chunk)), true);

  const errors: string[] = [];
  const capture = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      errors.push(`${(e as Error).name}: ${(e as Error).message} ${(e as Error).stack ?? ''}`);
    }
  };

  let h!: ReturnType<typeof harness>;
  let refuse = false;
  try {
    h = harness({
      providers: {
        github: {
          refresh: async (rt) => {
            // A provider that echoes the token it was given, in its error and its log.
            console.warn(`provider debug: refreshing ${rt.length} chars`);
            if (refuse) throw new Error(`invalid_grant: ${rt} rejected`);
            return { accessToken: ACCESS_2, refreshToken: REFRESH_2, expiresAt: new Date(h.at() + 3_600_000) };
          },
          revoke: async (t) => {
            throw new Error(`revoke failed for ${t.accessToken}`);
          },
        },
      },
    });
    await h.store.put(key(), { accessToken: ACCESS, refreshToken: REFRESH, scopes: ['repo'], expiresAt: new Date(h.at() - 1) });
    await capture(h.store.get(key())); // refresh ok
    h.advance(2 * 3_600_000);
    refuse = true;
    await capture(h.store.get(key())); // refresh refused
    await capture(harness({ rows: h.rows, cipher: aesGcmCipher(KEY_B) }).store.get(key())); // wrong key
    await capture(createToolContext({ appName: 'desk.k3f9', userId: 'alice', credentials: h.store }).accessToken!('gitlab'));
    await capture(h.store.revoke(key())); // remote revoke throws
    await h.store.put(key(), { accessToken: ACCESS });
    await capture(h.store.eraseUser('alice'));
  } finally {
    consoleNames.forEach((n, i) => ((console as any)[n] = savedConsole[i]));
    (process.stdout as any).write = savedOut;
    (process.stderr as any).write = savedErr;
  }
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  trace.disable();

  assert.ok(errors.length >= 3, 'the failing paths ran');
  assert.ok(spans.length >= 2, 'the refreshes were traced');
  assert.deepEqual(
    h.events.map((e) => `${e.event}:${e.outcome}`),
    ['credential.put:ok', 'credential.refresh:ok', 'credential.refresh:failed', 'credential.revoke:ok', 'credential.put:ok', 'credential.erase:ok'],
  );
  assert.equal(h.events.find((e) => e.event === 'credential.revoke')!.detail!.remote, 'failed');
  const haystacks = {
    logs: printed.join('\n'),
    errors: errors.join('\n'),
    spans: JSON.stringify(spans.map((s: any) => ({ name: s.name, attributes: s.attributes, status: s.status, events: s.events }))),
    audit: JSON.stringify(h.events),
    rows: JSON.stringify(h.rows.all()),
  };
  for (const [where, text] of Object.entries(haystacks)) {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${where} must not hold a token`);
    assert.ok(!text.includes('"alice"') && !text.includes(':alice'), `${where} names the user only as a hash`);
  }
});
